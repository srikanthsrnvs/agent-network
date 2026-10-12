/**
 * The network as an MCP server: the four tools — send, join, leave, members — plus `wait` and the resource
 * agent://self, over any implementation of `Verbs`. The relay serves it on /v1/mcp with the identity's own
 * queue behind it (no second Transport); adapters/mcp serves it on stdio as a thin HTTP client of the daemon
 * or the relay. Tool names, descriptions and return shapes are the ones createTools() in packages/core gives
 * every other harness; `wait` is the one concession: MCP cannot push a message into most hosts' context.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { z } from 'zod';
import { createTools, type Transport } from '@agent-network/core';
import { HttpError } from './http.js';
import type { Member, Message } from './identity.js';

export interface Verbs {
  send(target: string, text: string): Promise<{ ok: true; to: string }>;
  join(room: string): Promise<{ ok: boolean; note: string }>;
  leave(room: string): Promise<{ ok: true }>;
  members(room: string): Promise<Member[]>;
  /** Block up to `seconds` for inbound messages (oldest first); [] on timeout. Honour `signal`. */
  wait(seconds: number, signal?: AbortSignal): Promise<Message[]>;
  self(): Promise<{ name: string; address: string; inboxId?: string; env: string; names: Record<string, string> }>;
}

/** What `wait` returns per message: like the pi extension's [network] lines but structured. */
export interface McpMessage {
  /** Sender's name when the names map knows it, else the 0x address. */
  from: string;
  /** Room name, or null for a direct message. */
  room: string | null;
  text: string;
  sentAt: string;
  /** True when it arrived while this agent was offline and was replayed on boot. */
  missed?: true;
}

export const toMcpMessage = (m: Message): McpMessage => ({ from: m.from, room: m.room, text: m.text, sentAt: m.ts, ...(m.missed ? { missed: true as const } : {}) });

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (err: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }],
  isError: true,
});
/** A verb's own refusal (4xx: unknown name, not in that room) is an ordinary {ok:false} result; anything else is a tool error. */
const refusalOr = (err: unknown) => (err instanceof HttpError && err.status < 500 ? text({ ok: false, error: err.message }) : failure(err));

// The four primitives' text, straight from createTools() (no transport is ever used from this instance).
const primitives = createTools({ transport: undefined as unknown as Transport, resolver: undefined as never, keeper: 'keeper' });

export const WAIT_MAX = 600;

export function createMcpServer(verbs: Verbs, opts: { maxWait?: number } = {}): McpServer {
  const server = new McpServer({ name: 'agent-network', version: '0.1.0' });
  const maxWait = opts.maxWait ?? WAIT_MAX;
  const tool = (name: 'send' | 'join' | 'leave' | 'members') => ({ description: primitives[name].description, inputSchema: primitives[name].inputSchema as AnySchema });

  // `send`'s note tells a pushed agent to end its turn; in MCP mode the reply is collected with `wait`.
  server.registerTool('send', tool('send'), async (args: unknown) => {
    const { target, text: body } = args as { target: string; text: string };
    try {
      const r = await verbs.send(target, body);
      return text(r.to.startsWith('room:') ? r : { ...r, note: 'delivered. Their reply, if any, arrives as a network message: call wait to receive it. Do not resend.' });
    } catch (err) { return refusalOr(err); }
  });
  server.registerTool('join', tool('join'), async (args: unknown) => {
    try { return text(await verbs.join((args as { room: string }).room)); } catch (err) { return refusalOr(err); }
  });
  server.registerTool('leave', tool('leave'), async (args: unknown) => {
    const { room } = args as { room: string };
    try { return text({ ...(await verbs.leave(room)), note: `asked the keeper to remove you from ${room.trim()}` }); } catch (err) { return refusalOr(err); }
  });
  server.registerTool('members', tool('members'), async (args: unknown) => {
    const { room } = args as { room: string };
    try { return text({ ok: true, room: room.trim(), members: await verbs.members(room) }); } catch (err) { return refusalOr(err); }
  });

  server.registerTool(
    'wait',
    {
      description:
        'Block until the next network message arrives (or the timeout, default 120 s, max 600) and return it; ' +
        'call this after you send something and need the reply. Returns {messages: [{from, room, text, sentAt}]} — ' +
        'all messages buffered since the last wait, oldest first, or an empty list on timeout. `from` is the sender\'s ' +
        'agent name (or 0x address if unknown); `room` is the room name, or null for a direct message. A message can ' +
        'also arrive while another tool call is running: it is buffered and will be waiting for your next wait.',
      inputSchema: z.object({
        timeoutSeconds: z.number().int().min(1).max(WAIT_MAX).default(120).describe('how long to block before returning an empty list'),
      }),
    },
    async ({ timeoutSeconds }, { signal }) => {
      try {
        const messages = await verbs.wait(Math.min(timeoutSeconds, maxWait), signal);
        return text({ messages: messages.map(toMcpMessage) });
      } catch (err) { return failure(err); }
    },
  );

  server.registerResource(
    'self',
    'agent://self',
    { description: 'Who this agent is on the network: name, address, inbox, XMTP env, and the names it knows.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await verbs.self()) }] }),
  );
  return server;
}
