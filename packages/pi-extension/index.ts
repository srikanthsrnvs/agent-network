// The agent-network client inside pi: inbound messages become `[network]` custom messages that
// start a run; the four tools wrap createTools() unchanged. Loaded by pi's jiti; not in `tsc -b`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { XmtpEnv } from "@xmtp/node-sdk";
import { Transport, createTools, loadOrCreateKeystore, type Inbound, type Tools } from "@agent-network/client";
import { Resolver, StaticBackend } from "@agent-network/resolver";

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

export default function agentNetwork(pi: ExtensionAPI) {
  const name = process.env.AGENT_NAME;
  if (!process.env.AGENT_HOME || !name) throw new Error("agent-network: AGENT_HOME and AGENT_NAME must be set");
  const keystore = loadOrCreateKeystore();
  const contactsPath = join(keystore.home, "names.json");
  const contacts = new StaticBackend(existsSync(contactsPath) ? JSON.parse(readFileSync(contactsPath, "utf8")) : {});
  contacts.set(name, keystore.address);
  const resolver = new Resolver({ backends: [contacts] });
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

  // Local models sometimes answer a [network] message in plain text. On an unattended machine
  // that reaches nobody, so when such a run ends with a long answer and no send, say so once.
  // (An attended agent relays answers to its owner in plain text on purpose, hence the gate.)
  const nudged = new Set<string>();
  if (process.env.AGENT_UNATTENDED === "1") pi.on("agent_end", ({ messages }) => {
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== "user" && messages[i].role !== "custom") i--;
    const trigger = i >= 0 ? messages[i] : undefined;
    if (!trigger || trigger.role !== "custom" || trigger.customType !== "network" || typeof trigger.content !== "string") return;
    if (nudged.has(trigger.content)) return;
    const who = /^\[network\] (\S+) in /.exec(trigger.content)?.[1];
    if (!who) return;
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
        content: `[network] delivery check: ${who} did not receive your last answer because it was plain text, not a send. If it was meant for ${who}, call send now with that answer. If no reply is needed, do nothing.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  const register = (toolName: ToolName, description: string) =>
    pi.registerTool({
      name: toolName,
      label: toolName,
      description,
      parameters: schemas[toolName],
      async execute(toolCallId, params, signal) {
        if (!tools) throw new Error("agent-network: not connected");
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
