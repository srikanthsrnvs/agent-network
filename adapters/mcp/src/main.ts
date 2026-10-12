#!/usr/bin/env node
/**
 * The agent-network verbs as an MCP server on stdio, so any MCP-capable harness — Claude Code, Hermes,
 * Cursor, Codex — can put an agent on the network. A THIN client: it boots no XMTP client of its own.
 *
 *   AGENTNET_URL + AGENTNET_TOKEN set (or ANET_URL/ANET_TOKEN):  every tool is a request to that relay's /v1 routes
 *   otherwise:  AGENT_HOME (+ AGENT_NAME) select the local daemon on $AGENT_HOME/netd.sock, started on demand
 *               exactly as `anet` starts it (we run `anet daemon`), with the usual single-writer checks.
 *
 * Tools: send, join, leave, members (the four primitives, text and shapes from packages/core) plus `wait`
 * (MCP cannot push a message into most hosts' context, so inbound messages wait in the daemon's/relay's durable
 * inbox and `wait` hands them over), and the resource agent://self. For Claude Code against the hosted relay
 * there is a shorter path with no process at all: `claude mcp add --transport http agentnet <relay>/v1/mcp
 * --header "Authorization: Bearer $AGENTNET_TOKEN"`. stdout is the protocol; all logging goes to stderr.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveHome } from '@agent-network/core/keystore';
import { NetClient, daemonSocket } from '@agent-network/relay/client';
import { createMcpServer, type Verbs } from '@agent-network/relay/mcp';

const log = (...args: unknown[]) => process.stderr.write(`[agent-network-mcp] ${args.map(String).join(' ')}\n`);
console.log = console.info = console.debug = (...args: unknown[]) => void process.stderr.write(args.map(String).join(' ') + '\n');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ANET = join(root, 'packages', 'cli', 'bin', 'anet.mjs');
const UA = 'agent-network-mcp/0.1.0';

const url = process.env.AGENTNET_URL ?? process.env.ANET_URL;
const token = process.env.AGENTNET_TOKEN ?? process.env.ANET_TOKEN;

let client: NetClient;
let ready: Promise<void>;
if (url) {
  if (!token) { log('AGENTNET_TOKEN must be set with AGENTNET_URL'); process.exit(1); }
  client = new NetClient({ url, token }, UA);
  ready = Promise.resolve();
  log(`relay mode: ${url}`);
} else {
  if (!process.env.AGENT_HOME) { log('set AGENTNET_URL + AGENTNET_TOKEN (relay) or AGENT_HOME + AGENT_NAME (local daemon)'); process.exit(1); }
  const home = resolveHome();
  client = new NetClient({ socketPath: daemonSocket(home) }, UA);
  // Make sure the daemon runs: `anet daemon` starts it under the mkdir lock + lsof check and waits for its health.
  ready = new Promise<void>((ok, fail) => {
    if (!existsSync(ANET)) return fail(new Error(`${ANET} is missing`));
    execFile(process.execPath, [ANET, 'daemon'], { cwd: root, env: { ...process.env, AGENT_HOME: home }, timeout: 180_000 }, (err, _stdout, stderr) => {
      if (err) return fail(new Error(`the network daemon did not start: ${String(stderr || err.message).trim()}`));
      ok();
    });
  });
  ready.then(() => log(`local daemon ready (${home})`), (err) => log(err instanceof Error ? err.message : String(err)));
}

// Every verb waits for the daemon; the relay needs no wait.
const base = client.verbs();
const gated = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { await ready; return f(...a); };
const verbs: Verbs = {
  send: gated(base.send),
  join: gated(base.join),
  leave: gated(base.leave),
  members: gated(base.members),
  wait: gated(base.wait),
  self: gated(base.self),
};

const server = createMcpServer(verbs);

let stopping = false;
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  log(`going offline (${reason})`);
  process.exit(0);
}
process.stdin.on('end', () => shutdown('stdin closed'));
process.stdin.on('close', () => shutdown('stdin closed'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await server.connect(new StdioServerTransport());
