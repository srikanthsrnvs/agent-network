// The agent-network client inside pi: inbound messages become `[network]` custom messages that
// start a run; the four tools wrap createTools() unchanged. Loaded by pi's jiti; not in `tsc -b`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { XmtpEnv } from "@xmtp/node-sdk";
import { Transport, createTools, loadOrCreateKeystore, type Inbound, type Tools } from "@agent-network/client";
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

  const network = (content: string, options?: { triggerTurn: true; deliverAs?: "followUp" }) =>
    pi.sendMessage({ customType: "network", content, display: true }, options);

  // A queued follow-up lives only in pi's queue until message_end persists it; Esc clears that
  // queue after the Transport cursor has already moved on. Re-push such a message once.
  const inflight = new Map<string, { repushed: boolean }>();

  const push = async (m: Inbound) => {
    const who = await resolver.label(m.from);
    const where = m.room ? `room "${m.room}"` : "a direct message";
    const when = m.missed ? ` (arrived ${m.sentAt.toISOString()} while you were away)` : "";
    const content = `[network] ${who} in ${where}${when}: ${m.text}`;
    inflight.set(content, { repushed: false });
    network(content, { triggerTurn: true, deliverAs: "followUp" });
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

  // Local models were seen calling send three times with the same target in one turn.
  const sentThisRun = new Set<string>();
  pi.on("agent_start", () => sentThisRun.clear());

  const register = (toolName: ToolName, description: string) =>
    pi.registerTool({
      name: toolName,
      label: toolName,
      description,
      parameters: schemas[toolName],
      async execute(toolCallId, params, signal) {
        if (!tools) throw new Error("agent-network: not connected");
        if (toolName === "send") {
          const target = String((params as { target: string }).target).trim().toLowerCase();
          if (sentThisRun.has(target)) {
            const result = { ok: false, error: `you already sent to ${target} in this turn — one message per recipient per turn; end your turn and wait for the reply` };
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
          }
          sentThisRun.add(target);
        }
        const abortSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
        const result = await tools[toolName].execute!(params as never, { toolCallId, messages: [], abortSignal });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
      },
    });

  pi.on("session_start", async () => {
    transport ??= await Transport.start({
      keystore,
      env,
      onInbound: push,
      onJoined: (g) => network(`[network] you are now in room "${g.name}"`),
    });
    if (!tools) {
      tools = createTools({ transport, resolver, keeper: process.env.KEEPER_ADDRESS ?? "keeper" });
      for (const toolName of Object.keys(schemas) as ToolName[]) register(toolName, tools[toolName].description!);
    }
    process.stderr.write(`[agent-network] ${name} ${keystore.address} online on xmtp:${env}\n`);
  });

  pi.on("session_shutdown", async () => {
    const t = transport;
    transport = tools = undefined;
    if (!t) return;
    await t.stop();
    process.stderr.write(`[agent-network] ${name} offline\n`);
  });
}
