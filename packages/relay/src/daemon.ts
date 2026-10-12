/**
 * The resident network daemon (formerly swarm/netd.ts) for agents that are not pi processes (Claude Code,
 * Codex, a human in a shell, an OpenAI Agents SDK program). One XMTP client for the identity under AGENT_HOME
 * for the daemon's whole life (same db → same installation), inbound messages kept in a durable queue, and
 * the four verbs plus inbox served over HTTP on a UNIX socket. packages/cli/bin/anet.mjs is the client that
 * talks to it (and starts it); nobody runs this by hand. Run with: node packages/relay/dist/daemon.js.
 * The hosted/multi-identity form of the same thing is relay.ts (bearer tokens, TCP, /v1/…, /v1/mcp); the
 * verbs themselves live in identity.ts + routes.ts and are shared.
 *
 *   GET  /health            {ok,name,address,inboxId,env,home,since,queued}  (503 {ok:false,booting:true} while booting)
 *   GET  /whoami · GET /inbox?wait=S (≤600) · POST /send · POST /join · POST /leave · GET /members?room= ·
 *   GET  /rooms · GET /names           — see routes.ts; errors: {error} with a 4xx status
 *
 * Files under AGENT_HOME: netd.sock, netd.lock/ (mkdir lock, holds our pid), netd-queue.jsonl (durable
 * queue, reloaded on start), netd.log (our stderr, redirected by anet). Single-writer guarantee: the
 * lock plus an lsof check that nothing else has xmtp-<env>.db3 open before we open it (wait ≤60 s, else
 * exit 3). SIGTERM/SIGINT: stop the transport, remove socket and lock. Never exits on its own.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { resolveHome } from '@agent-network/core';
import { Resolver } from '@agent-network/resolver';
import { Lock, waitForDbFree } from './guard.js';
import { HttpError, sendJson } from './http.js';
import { Identity } from './identity.js';
import { NamesFile } from './names.js';
import { handleVerb, sendError } from './routes.js';

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} netd: ${line}\n`);

const name = process.env.AGENT_NAME;
if (!process.env.AGENT_HOME || !name) {
  log('AGENT_HOME and AGENT_NAME must be set');
  process.exit(2);
}
const env = (process.env.XMTP_ENV ?? 'dev') as XmtpEnv;
const home = resolveHome();
/** A unix socket path may not exceed ~104 bytes (macOS); long homes get a short one in tmpdir, with a symlink for humans. */
const sockLink = join(home, 'netd.sock');
const sockPath = Buffer.byteLength(sockLink) <= 100 ? sockLink : join(tmpdir(), `netd-${createHash('sha1').update(home).digest('hex').slice(0, 16)}.sock`);

const namesPath = join(home, 'names.json');
const contacts = new NamesFile(namesPath);
const resolver = new Resolver({ backends: [contacts], ttlMs: 10_000 });
const identity = new Identity({ name, home, env, resolver, keeperName: process.env.KEEPER_ADDRESS ?? 'keeper', namesPath, log });
contacts.set(name, identity.address);
const lock = new Lock(join(home, 'netd.lock'), log);
const since = new Date().toISOString();

const server = createServer((req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url ?? '/', 'http://netd');
  const route = `${req.method} ${url.pathname}`;
  if (url.pathname !== '/health') res.on('finish', () => log(`${route} → ${res.statusCode} ${Date.now() - t0}ms`));
  (async () => {
    if (route === 'GET /health') {
      if (!identity.online) return sendJson(res, 503, { ok: false, booting: true, name, address: identity.address, since, queued: identity.queue.length });
      return sendJson(res, 200, { ok: true, name, address: identity.address, inboxId: identity.inboxId, env, home, since, queued: identity.queue.length });
    }
    if (!(await handleVerb(route, url, req, res, { identity, maxWait: 600, names: () => contacts.entries() }))) throw new HttpError(404, `no route ${route}`);
  })().catch((err) => sendError(res, err));
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 0;

// --- lifecycle -------------------------------------------------------------------------------------
let stopping = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${name} going offline (${reason})`);
  try { server.close(); } catch { /* ignore */ }
  try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
  try { if (sockPath !== sockLink && lstatSync(sockLink).isSymbolicLink()) unlinkSync(sockLink); } catch { /* ignore */ }
  await identity.stop();
  lock.release();
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGHUP', () => { /* the terminal that started us may vanish; keep running */ });
process.on('uncaughtException', (err) => { log(`uncaught ${err instanceof Error ? err.stack ?? err.message : String(err)}`); void shutdown('uncaught exception', 1); });
process.on('unhandledRejection', (err) => log(`unhandled rejection ${err instanceof Error ? err.message : String(err)}`));

lock.acquire(process.env.NETD_LOCK_INHERITED === '1');
{
  const holders = await waitForDbFree(identity.dbPath, log);
  if (holders.length) {
    log(`${identity.dbPath} is still open by pid ${holders.join(',')} after 60 s; refusing to open it twice`);
    lock.release();
    process.exit(3);
  }
}
if (existsSync(sockPath)) {
  // Our lock plus the free db mean no daemon is alive; the socket file is a leftover.
  if (!statSync(sockPath).isSocket()) { log(`${sockPath} exists and is not a socket; exiting`); lock.release(); process.exit(1); }
  unlinkSync(sockPath);
}
server.on('error', (err) => { log(`server error ${err.message}`); void shutdown('server error', 1); });
server.listen(sockPath, () => {
  log(`listening on ${sockPath}`);
  if (sockPath !== sockLink) {
    try { if (lstatSync(sockLink).isSymbolicLink()) unlinkSync(sockLink); } catch { /* none */ }
    try { symlinkSync(sockPath, sockLink); } catch (e) { log(`cannot symlink ${sockLink}: ${(e as Error).message}`); }
  }
});
identity.start().catch((err) => { log(`transport failed to start: ${err instanceof Error ? err.message : String(err)}`); void shutdown('boot failed', 1); });
