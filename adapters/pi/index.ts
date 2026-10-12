// The agent-network core inside pi: inbound messages become `[network]` custom messages that
// start a run; the four tools wrap createTools() unchanged. Loaded by pi's jiti from this TypeScript
// source (it resolves @agent-network/core through the workspace's node_modules); not in `tsc -b`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { XmtpEnv } from "@xmtp/node-sdk";
import { Transport, createTools, loadOrCreateKeystore, type Inbound, type Tools } from "@agent-network/core";
import { Resolver, StaticBackend, type NameBackend, type Resolved } from "@agent-network/resolver";

const room = Type.Object({ room: Type.String({ minLength: 1 }) });
const schemas = {
  send: Type.Object({
    target: Type.String({ description: "agent name like alice.agent.eth, a 0x address, or a room name" }),
    text: Type.String({ minLength: 1 }),
  }),
  join: room,
  leave: room,
  members: room,
};
type ToolName = keyof typeof schemas;

/** $AGENT_HOME/names.json, re-read when it changes, so new agents need no restart. */
class NamesFile implements NameBackend {
  private inner = new StaticBackend({});
  private mtime = -1;
  constructor(private readonly path: string, private readonly self: string, private readonly selfAddress: `0x${string}`) {}
  private load(): StaticBackend {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime !== this.mtime) {
      this.inner = new StaticBackend(mtime ? JSON.parse(readFileSync(this.path, "utf8")) : {});
      this.inner.set(this.self, this.selfAddress);
      this.mtime = mtime;
    }
    return this.inner;
  }
  resolve(name: string): Promise<Resolved | null> { return this.load().resolve(name); }
  reverse(address: `0x${string}`): Promise<string | null> { return this.load().reverse(address); }
}

export default function agentNetwork(pi: ExtensionAPI) {
  const name = process.env.AGENT_NAME;
  if (!process.env.AGENT_HOME || !name) throw new Error("agent-network: AGENT_HOME and AGENT_NAME must be set");
  const keystore = loadOrCreateKeystore();
  const contacts = new NamesFile(join(keystore.home, "names.json"), name, keystore.address);
  const resolver = new Resolver({ backends: [contacts], ttlMs: 10_000 });
  const env = (process.env.XMTP_ENV ?? "dev") as XmtpEnv;

  let transport: Transport | undefined;
  let tools: Tools | undefined;

  const network = (content: string, options?: { triggerTurn: true; deliverAs?: "followUp" | "steer" }) =>
    pi.sendMessage({ customType: "network", content, display: true }, options);

  // A queued follow-up lives only in pi's queue until message_end persists it; Esc clears that
  // queue after the Transport cursor has already moved on. Re-push such a message once.
  const inflight = new Map<string, { repushed: boolean }>();

  const push = async (m: Inbound) => {
    const who = await resolver.label(m.from);
    const where = m.room ? `room "${m.room}"` : "a direct message";
    const when = m.missed ? ` (arrived ${m.sentAt.toISOString()} while you were away)` : "";
    const content = `[network] ${who} in ${where}${when}: ${m.text}`;
    lastNetwork = Date.now();
    inflight.set(content, { repushed: false });
    // "steer": delivered after the current tool call even mid-run. "followUp" waited for the run
    // to end, and local-model runs went on for an hour — 90% of room traffic was never seen.
    network(content, { triggerTurn: true, deliverAs: "steer" });
  };

  pi.on("message_end", ({ message }) => {
    if (message.role === "custom" && message.customType === "network" && typeof message.content === "string") {
      inflight.delete(message.content);
    }
  });

  pi.on("agent_settled", () => {
    for (const [content, state] of inflight) {
      if (state.repushed) continue;
      state.repushed = true;
      network(content, { triggerTurn: true });
    }
  });

  // Local models sometimes answer a direct [network] message in plain text. On an unattended
  // machine that reaches nobody, so when such a run ends with a long answer and no send, say so
  // once. (An attended agent relays answers to its owner in plain text on purpose, hence the gate.)
  const nudged = new Set<string>();
  if (process.env.AGENT_UNATTENDED === "1") pi.on("agent_end", ({ messages }) => {
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== "user" && messages[i].role !== "custom") i--;
    const trigger = i >= 0 ? messages[i] : undefined;
    if (!trigger || trigger.role !== "custom" || trigger.customType !== "network" || typeof trigger.content !== "string") return;
    if (nudged.has(trigger.content)) return;
    // Only direct messages are certainly addressed to us; in a room most messages are for someone else.
    const who = /^\[network\] (\S+) in a direct message/.exec(trigger.content)?.[1];
    if (!who || who.toLowerCase() === "keeper" || who.toLowerCase() === (process.env.KEEPER_ADDRESS ?? "keeper").toLowerCase()) return;
    let sent = false;
    let answer = "";
    for (const m of messages.slice(i + 1)) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === "toolCall" && block.name === "send") sent = true;
        if (block.type === "text") answer = block.text;
      }
    }
    if (sent || answer.trim().length < 80) return;
    nudged.add(trigger.content);
    pi.sendMessage(
      {
        customType: "network-nudge",
        content: `[network] delivery check: your last message was plain text, so ${who} did not receive it. If ${who} asked you something and that text was the answer, call send now with it. If ${who} did not ask you anything, do nothing — do not acknowledge.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  // Local models were seen sending the same message to the same target three times in a row.
  // Refuse an identical message to the same target within two minutes; different text passes
  // (an acknowledgement followed by results in one long turn is legitimate and was once lost).
  const recentSends: Array<{ key: string; at: number }> = [];
  const duplicate = (target: string, text: string): boolean => {
    const now = Date.now();
    while (recentSends.length && now - recentSends[0].at > 120_000) recentSends.shift();
    const key = `${target}\u0000${text.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (recentSends.some((r) => r.key === key)) return true;
    recentSends.push({ key, at: now });
    return false;
  };

  const register = (toolName: ToolName, description: string) =>
    pi.registerTool({
      name: toolName,
      label: toolName,
      description,
      parameters: schemas[toolName],
      async execute(toolCallId, params, signal) {
        if (!tools) throw new Error("agent-network: not connected");
        if (toolName === "send") {
          const { target, text: body } = params as { target: string; text: string };
          if (duplicate(target.trim().toLowerCase(), body)) {
            const result = { ok: false, error: `you already sent this exact message to ${target.trim()} less than two minutes ago; it was delivered — do not resend` };
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
          }
        }
        signal?.throwIfAborted();
        const result = await tools[toolName].execute(params as never);
        if (toolName === "send" && (result as { ok?: boolean }).ok) lastNetwork = Date.now();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
      },
    });

  // Multi-day runs: an event-driven group with every agent idle never wakes up by itself. When
  // AGENT_HEARTBEAT_MINUTES is set, an idle agent that has seen no network traffic for that long
  // gets a [heartbeat] message so it can check its jobs or pick the next piece of work.
  const heartbeatMs = Number(process.env.AGENT_HEARTBEAT_MINUTES ?? 0) * 60_000;
  let lastNetwork = Date.now();
  let running = false;
  pi.on("agent_start", () => { running = true; });
  pi.on("agent_end", () => { running = false; });
  pi.on("agent_settled", () => { running = false; });
  pi.on("session_compact", () => { running = false; });
  let heartbeat: NodeJS.Timeout | undefined;

  // Long-term memory (OptMem): `memo wake` prints the agent's memory — recent lines verbatim,
  // older ones as tree summaries. Pushed into context at session start and again after every
  // compaction, so what was decided and tried outlives pi's own context window. The agent writes
  // memories itself with `memo note` (see its system prompt); AGENT_MEMO points at the tool.
  const memo = process.env.AGENT_MEMO ?? join(homedir(), ".optmem", "memo");
  const wake = (): string | null => {
    if (!existsSync(memo)) return null;
    const parts: string[] = [];
    try {
      let part = 1;
      let total: string | undefined;
      for (;;) {
        const out = execFileSync(memo, total ? ["wake", String(part), total] : ["wake"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
        parts.push(out.trimEnd());
        const next = /Run: \S+ wake (\d+) (\d+)/.exec(out);
        if (!next || out.includes("You are awake.")) break;
        part = Number(next[1]);
        total = next[2];
        if (part > 50) break;
      }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      parts.push((e.stdout ?? "") + (e.stderr ?? e.message ?? ""));
    }
    return parts.join("\n").trim();
  };
  const pushMemory = (why: string, options?: { deliverAs?: "steer" | "followUp" }) => {
    const text = wake();
    if (text === null) return;
    process.stderr.write(`[agent-network] memory: ${why} (${text.length} chars from ${memo})\n`);
    pi.sendMessage(
      { customType: "memory", content: `[memory] ${why} — output of \`${memo} wake\`:\n${text}`, display: true },
      options as never,
    );
  };
  pi.on("session_compact", ({ reason }) => pushMemory(`context was just compacted (${reason}); your long-term memory, re-read`, { deliverAs: "steer" }));

  // If the inbound stream dies, rebuild the transport in-process; catch-up replays what was missed.
  let restarting = false;
  const startTransport = () =>
    Transport.start({
      keystore,
      env,
      onInbound: push,
      onJoined: (g) => network(`[network] you are now in room "${g.name}"`),
      onStreamError: async () => {
        if (restarting) return;
        restarting = true;
        process.stderr.write("[agent-network] stream died; restarting transport\n");
        try {
          await transport?.stop().catch(() => undefined);
          transport = await startTransport();
          if (tools) tools = createTools({ transport, resolver, keeper: process.env.KEEPER_ADDRESS ?? "keeper" });
          process.stderr.write("[agent-network] transport restarted\n");
        } finally {
          restarting = false;
        }
      },
    });

  pi.on("session_start", async () => {
    pushMemory("session start; your long-term memory");
    if (heartbeatMs > 0 && !heartbeat) {
      heartbeat = setInterval(() => {
        if (running || Date.now() - lastNetwork < heartbeatMs) return;
        lastNetwork = Date.now();
        const quiet = Math.round(heartbeatMs / 60_000);
        process.stderr.write(`[agent-network] heartbeat after ${quiet} quiet minutes\n`);
        pi.sendMessage(
          { customType: "heartbeat", content: `[heartbeat] ${quiet} minutes with no network activity while you were idle. Check any job you have running on the training machine, chase anything you are waiting on, or start the next most useful experiment. Results, not small talk.`, display: true },
          { triggerTurn: true },
        );
      }, 60_000);
    }
    transport ??= await startTransport();
    if (!tools) {
      tools = createTools({ transport, resolver, keeper: process.env.KEEPER_ADDRESS ?? "keeper" });
      for (const toolName of Object.keys(schemas) as ToolName[]) register(toolName, tools[toolName].description);
    }
    process.stderr.write(`[agent-network] ${name} ${keystore.address} online on xmtp:${env}\n`);
  });

  pi.on("session_shutdown", async () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
    const t = transport;
    transport = tools = undefined;
    if (!t) return;
    await t.stop();
    process.stderr.write(`[agent-network] ${name} offline\n`);
  });
}
