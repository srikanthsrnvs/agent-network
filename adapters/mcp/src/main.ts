#!/usr/bin/env node
/**
 * The agent-network core as an MCP server (stdio), so any MCP-capable harness — Claude Code,
 * Hermes, Cursor, Codex — can put an agent on the network. The four tools are the same objects
 * createTools() gives the pi adapter; nothing here encodes a protocol. (A thin HTTP client of the
 * daemon/relay, and the relay's own /v1/mcp endpoint, come with PR2.)
 *
 * One concession the pi extension does not need: MCP cannot push a message into most hosts'
 * context, so inbound messages are buffered and a fifth tool, `wait`, hands them over.
 *
 * Config (env, same as the pi extension): AGENT_HOME, AGENT_NAME, optional KEEPER_ADDRESS
 * (default "keeper"), XMTP_ENV (default dev). stdout is the protocol; all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { z } from 'zod';
import { Transport, createTools, loadOrCreateKeystore, type Inbound, type Tools } from '@agent-network/core';
import { Resolver, StaticBackend, type NameBackend, type Resolved } from '@agent-network/resolver';

// stdout carries JSON-RPC; anything a dependency prints with console.log would corrupt it.
const log = (...args: unknown[]) => process.stderr.write(`[agent-network-mcp] ${args.map(String).join(' ')}\n`);
console.log = console.info = console.debug = (...args: unknown[]) => void process.stderr.write(args.map(String).join(' ') + '\n');

/** $AGENT_HOME/names.json, re-read when it changes, so new agents need no restart. */
class NamesFile implements NameBackend {
  private inner = new StaticBackend({});
  private mtime = -1;
  constructor(private readonly path: string, private readonly self: string, private readonly selfAddress: `0x${string}`) {}
  private load(): StaticBackend {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime !== this.mtime) {
      this.inner = new StaticBackend(mtime ? JSON.parse(readFileSync(this.path, 'utf8')) : {});
      this.inner.set(this.self, this.selfAddress);
      this.mtime = mtime;
    }
    return this.inner;
  }
  resolve(name: string): Promise<Resolved | null> { return this.load().resolve(name); }
  reverse(address: `0x${string}`): Promise<string | null> { return this.load().reverse(address); }
  entries(): Record<string, string> { return this.load().entries(); }
}

/** What `wait` returns: an inbound message, attributed like the pi extension's [network] lines but structured. */
interface Message {
  /** Sender's name when names.json knows it, else the 0x address. */
  from: string;
  /** Room name, or null for a direct message. */
  room: string | null;
  text: string;
  sentAt: string;
  /** True when it arrived while this agent was offline and was replayed on boot. */
  missed?: true;
}

const name = process.env.AGENT_NAME;
if (!process.env.AGENT_HOME || !name) {
  log('AGENT_HOME and AGENT_NAME must be set');
  process.exit(1);
}
const keystore = loadOrCreateKeystore();
const contacts = new NamesFile(join(keystore.home, 'names.json'), name, keystore.address);
const resolver = new Resolver({ backends: [contacts], ttlMs: 10_000 });
const env = (process.env.XMTP_ENV ?? 'dev') as XmtpEnv;
const keeper = process.env.KEEPER_ADDRESS ?? 'keeper';

// --- inbound queue: Transport.onInbound fills it, `wait` drains it ---------------------------
const queue: Message[] = [];
const waiters: Array<(messages: Message[]) => void> = [];

function deliver(message: Message): void {
  queue.push(message);
  const waiter = waiters.shift();
  if (waiter) waiter(queue.splice(0));
}

async function push(m: Inbound): Promise<void> {
  deliver({
    from: await resolver.label(m.from),
    room: m.room,
    text: m.text,
    sentAt: m.sentAt.toISOString(),
    ...(m.missed ? { missed: true as const } : {}),
  });
}

function waitForMessages(timeoutMs: number, signal?: AbortSignal): Promise<Message[]> {
  if (queue.length) return Promise.resolve(queue.splice(0));
  return new Promise((resolve) => {
    const done = (messages: Message[]) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      resolve(messages);
    };
    const onAbort = () => done(queue.splice(0));
    const timer = setTimeout(() => done([]), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(done);
  });
}

// --- transport: boots right after the server is connected, so early messages are buffered ----
let transport: Transport | undefined;
let tools: Tools | undefined;
let ready!: Promise<void>;

async function boot(): Promise<void> {
  transport = await Transport.start({
    keystore,
    env,
    onInbound: push,
    onJoined: (g) =>
      deliver({ from: keeper, room: g.name ?? null, text: `you are now in room "${g.name}"`, sentAt: new Date().toISOString() }),
  });
  tools = createTools({ transport, resolver, keeper });
  log(`${name} ${keystore.address} online on xmtp:${env}`);
}

// --- MCP server -------------------------------------------------------------------------------
const server = new McpServer({ name: 'agent-network', version: '0.1.0' });

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (err: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }],
  isError: true,
});

// The four primitives, straight from createTools(). `send`'s note tells a pushed agent to end its
// turn; in MCP mode the reply is collected with `wait`, so the note is rewritten to say so.
const primitives = createTools({ transport: undefined as unknown as Transport, resolver, keeper });
for (const toolName of ['send', 'join', 'leave', 'members'] as const) {
  const definition = primitives[toolName];
  server.registerTool(
    toolName,
    { description: definition.description, inputSchema: definition.inputSchema as AnySchema },
    async (args: unknown, { signal }: { signal?: AbortSignal }) => {
      try {
        await ready;
        signal?.throwIfAborted();
        const result = (await tools![toolName].execute(args as never)) as Record<string, unknown>;
        if (toolName === 'send' && result.ok && result.note) {
          result.note = 'delivered. Their reply, if any, arrives as a network message: call wait to receive it. Do not resend.';
        }
        return text(result);
      } catch (err) {
        return failure(err);
      }
    },
  );
}

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
      timeoutSeconds: z.number().int().min(1).max(600).default(120).describe('how long to block before returning an empty list'),
    }),
  },
  async ({ timeoutSeconds }, { signal }) => {
    try {
      await ready;
      return text({ messages: await waitForMessages(timeoutSeconds * 1000, signal) });
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerResource(
  'self',
  'agent://self',
  { description: 'Who this agent is on the network: name, address, inbox, XMTP env, and the names it knows.', mimeType: 'application/json' },
  async (uri) => {
    await ready;
    const self = { name, address: keystore.address, inboxId: transport!.inboxId, env, names: contacts.entries() };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(self) }] };
  },
);

// --- lifecycle --------------------------------------------------------------------------------
let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${name} going offline (${reason})`);
  for (const waiter of waiters.splice(0)) waiter(queue.splice(0));
  try {
    await ready?.catch(() => undefined); // undefined only if stdin closed before connect() returned
    await transport?.stop();
  } finally {
    process.exit(0);
  }
}
process.stdin.on('end', () => void shutdown('stdin closed'));
process.stdin.on('close', () => void shutdown('stdin closed'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Respond to initialize first; the Transport comes up behind it and tool calls await it.
await server.connect(new StdioServerTransport());
ready = boot();
ready.catch((err) => log('transport failed to start:', err instanceof Error ? err.message : String(err)));
