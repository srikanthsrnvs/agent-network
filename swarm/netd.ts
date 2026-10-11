/**
 * netd: the resident network process for agents that are not pi processes (Claude Code, Codex, a
 * human in a shell). One XMTP client for the identity under AGENT_HOME for the daemon's whole life
 * (same db → same installation), inbound messages kept in a durable queue, and the four verbs plus
 * inbox served over HTTP on a UNIX socket. swarm/netc.mjs is the client that talks to it (and starts
 * it); nobody runs this by hand. Run with: npx tsx swarm/netd.ts   (cwd = repo root)
 *
 *   GET  /health            {ok,name,address,inboxId,env,home,since,queued}  (503 {ok:false,booting:true} while booting)
 *   GET  /inbox?wait=S      long-poll: queued messages now, else the first to arrive within S s (≤600)
 *                           → {messages:[{ts,from,room,text,missed}]}; removed from the queue once the
 *                           response is fully written
 *   POST /send              {target,text}        same resolution and error texts as netcli
 *   POST /join              {room,wait?}         DM the keeper "join <room>", wait ≤wait s (default 8) for membership
 *   POST /leave             {room}
 *   GET  /members?room=     [{name,address,you}]
 *   GET  /rooms             [names]
 *   errors: {error} with a 4xx status
 *
 * Files under AGENT_HOME: netd.sock, netd.lock/ (mkdir lock, holds our pid), netd-queue.jsonl (durable
 * queue, reloaded on start), netd.log (our stderr, redirected by netc). Single-writer guarantee: the
 * lock plus an lsof check that nothing else has xmtp-<env>.db3 open before we open it (wait ≤60 s, else
 * exit 3). SIGTERM/SIGINT: stop the transport, remove socket and lock. Never exits on its own.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { Transport, loadOrCreateKeystore, type Inbound } from '@agent-network/client';
import { Resolver, StaticBackend, type NameBackend, type Resolved } from '@agent-network/resolver';

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

const name = process.env.AGENT_NAME;
if (!process.env.AGENT_HOME || !name) {
  log('netd: AGENT_HOME and AGENT_NAME must be set');
  process.exit(2);
}
const env = (process.env.XMTP_ENV ?? 'dev') as XmtpEnv;
const keeperName = process.env.KEEPER_ADDRESS ?? 'keeper';
const keystore = loadOrCreateKeystore();
const home = keystore.home;
/** A unix socket path may not exceed ~104 bytes (macOS); long homes get a short one in tmpdir, with a symlink for humans. */
const sockLink = join(home, 'netd.sock');
const sockPath = Buffer.byteLength(sockLink) <= 100 ? sockLink : join(tmpdir(), `netd-${createHash('sha1').update(home).digest('hex').slice(0, 16)}.sock`);
const paths = {
  sock: sockPath,
  lock: join(home, 'netd.lock'),
  queue: join(home, 'netd-queue.jsonl'),
  db: join(home, `xmtp-${env}.db3`),
};

/** $AGENT_HOME/names.json, re-read when it changes, so new agents need no restart (as in the pi extension). */
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
  resolve(n: string): Promise<Resolved | null> { return this.load().resolve(n); }
  reverse(address: `0x${string}`): Promise<string | null> { return this.load().reverse(address); }
}
const contacts = new NamesFile(join(home, 'names.json'), name, keystore.address);
const resolver = new Resolver({ backends: [contacts], ttlMs: 10_000 });

// --- single-writer guard ----------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** PIDs (other than ours) that have the identity db open, via lsof. */
function dbHolders(): number[] {
  const files = [paths.db, `${paths.db}-wal`, `${paths.db}-shm`].filter((f) => existsSync(f));
  if (!files.length) return [];
  try {
    const out = execFileSync('lsof', ['-t', '--', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))].filter((p) => p !== process.pid);
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return []; // lsof: nothing found
    if (err.status === undefined) { log('netd: lsof is not available; skipping the open-db check'); return []; }
    return [...new Set(String(err.stdout ?? '').split(/\s+/).filter(Boolean).map(Number))].filter((p) => p !== process.pid);
  }
}

/**
 * Take netd.lock (mkdir is atomic). The lock holds the owner's pid; a lock whose pid is dead is stale.
 * NETD_LOCK_INHERITED=1 means netc took the lock for us just before spawning us: adopt it.
 */
function acquireLock(): void {
  const pidFile = join(paths.lock, 'pid');
  if (process.env.NETD_LOCK_INHERITED === '1' && existsSync(paths.lock)) {
    writeFileSync(pidFile, String(process.pid));
    return;
  }
  for (;;) {
    try {
      mkdirSync(paths.lock);
      writeFileSync(pidFile, String(process.pid));
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = Number(readFileSync(pidFile, 'utf8').trim()); } catch { /* no pid yet */ }
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        log(`netd: another netd (pid ${pid}) holds ${paths.lock}; exiting`);
        process.exit(3);
      }
      const age = Date.now() - statSync(paths.lock).mtimeMs;
      if (!Number.isFinite(pid) && age < 30_000) { log(`netd: ${paths.lock} is being taken by someone else; exiting`); process.exit(3); }
      log(`netd: removing stale lock ${paths.lock} (pid ${Number.isFinite(pid) ? pid : 'none'})`);
      rmSync(paths.lock, { recursive: true, force: true });
    }
  }
}

function releaseLock(): void {
  try {
    const pid = Number(readFileSync(join(paths.lock, 'pid'), 'utf8').trim());
    if (pid === process.pid) rmSync(paths.lock, { recursive: true, force: true });
  } catch { /* not ours or already gone */ }
}

async function waitForDbFree(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const holders = dbHolders();
    if (!holders.length) return;
    if (Date.now() > deadline) {
      log(`netd: ${paths.db} is still open by pid ${holders.join(',')} after 60 s; refusing to open it twice`);
      releaseLock();
      process.exit(3);
    }
    log(`netd: waiting for pid ${holders.join(',')} to close ${paths.db}`);
    await sleep(1000);
  }
}

// --- durable queue -----------------------------------------------------------------------------
interface Queued {
  id: string;
  ts: string;
  /** sender address; labelled with names.json at delivery time so later-added names apply */
  from: string;
  room: string | null;
  text: string;
  missed: boolean;
}
const queue: Queued[] = [];
const inflight = new Set<string>();
const recentlyDelivered: string[] = [];

function loadQueue(): void {
  if (!existsSync(paths.queue)) return;
  for (const line of readFileSync(paths.queue, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { queue.push(JSON.parse(line) as Queued); } catch { log('netd: skipping a corrupt queue line'); }
  }
  if (queue.length) log(`netd: reloaded ${queue.length} queued message(s) from ${paths.queue}`);
}

function rewriteQueue(): void {
  const tmp = `${paths.queue}.tmp`;
  writeFileSync(tmp, queue.map((m) => JSON.stringify(m)).join('\n') + (queue.length ? '\n' : ''));
  renameSync(tmp, paths.queue);
}

const waiters: Array<() => void> = [];
function enqueue(m: Inbound): void {
  const id = `${m.conversationId}:${m.sentAt.getTime()}:${m.from.toLowerCase()}`;
  if (queue.some((q) => q.id === id) || recentlyDelivered.includes(id)) return; // catch-up after a crash
  const item: Queued = { id, ts: m.sentAt.toISOString(), from: m.from, room: m.room, text: m.text, missed: m.missed };
  appendFileSync(paths.queue, JSON.stringify(item) + '\n');
  queue.push(item);
  const wake = waiters.shift();
  if (wake) wake();
}

/** Messages not already promised to another in-progress response. */
const available = () => queue.filter((m) => !inflight.has(m.id));

function markDelivered(ids: string[]): void {
  for (const id of ids) {
    inflight.delete(id);
    const i = queue.findIndex((m) => m.id === id);
    if (i >= 0) queue.splice(i, 1);
    recentlyDelivered.push(id);
  }
  while (recentlyDelivered.length > 1000) recentlyDelivered.shift();
  rewriteQueue();
}

// --- transport -----------------------------------------------------------------------------------
let transport: Transport | undefined;
let booting: Promise<void> | undefined;
let restarting = false;

const startTransport = () =>
  Transport.start({
    keystore,
    env,
    onInbound: (m) => enqueue(m),
    onStreamError: async () => {
      if (restarting) return;
      restarting = true;
      log('netd: stream died; restarting transport');
      try {
        await transport?.stop().catch(() => undefined);
        transport = await startTransport();
        log('netd: transport restarted');
      } catch (err) {
        log(`netd: transport restart failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        restarting = false;
      }
    },
  });

async function ready(): Promise<Transport> {
  if (booting) await booting;
  if (!transport || restarting) throw new HttpError(503, 'network transport is restarting; retry in a moment');
  return transport;
}

const keeper = async () => {
  const k = await resolver.resolve(keeperName);
  if (!k) throw new HttpError(400, `keeper "${keeperName}" does not resolve; add it to ${join(home, 'names.json')} or set KEEPER_ADDRESS`);
  return k.address;
};

// --- HTTP over the unix socket -----------------------------------------------------------------
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const readBody = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 4 * 1024 * 1024) reject(new HttpError(413, 'body too large')); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { const v = JSON.parse(raw); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(new HttpError(400, 'body must be a JSON object')); }
    });
    req.on('error', reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};

const since = new Date().toISOString();
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${what} (string) required`);
  return v;
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://netd');
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /health': {
      if (!transport) return sendJson(res, 503, { ok: false, booting: true, name, address: keystore.address, since, queued: queue.length });
      return sendJson(res, 200, { ok: true, name, address: keystore.address, inboxId: transport.inboxId, env, home, since, queued: queue.length });
    }
    case 'GET /inbox': {
      await ready();
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? '0') || 0, 0), 600);
      let batch = available();
      if (!batch.length && wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait * 1000);
          function done() { clearTimeout(timer); const i = waiters.indexOf(done); if (i >= 0) waiters.splice(i, 1); res.off('close', done); resolve(); }
          waiters.push(done);
          res.on('close', done); // client went away: stop waiting, promise nothing
        });
        if (res.destroyed) return;
        batch = available();
      }
      const ids = batch.map((m) => m.id);
      for (const id of ids) inflight.add(id);
      const messages = await Promise.all(batch.map(async (m) => ({ ts: m.ts, from: await resolver.label(m.from as `0x${string}`), room: m.room, text: m.text, missed: m.missed })));
      res.on('finish', () => markDelivered(ids));           // fully written → gone from the durable queue
      res.on('close', () => { if (!res.writableFinished) for (const id of ids) inflight.delete(id); }); // not delivered → back on offer
      return sendJson(res, 200, { messages });
    }
    case 'POST /send': {
      const t = await ready();
      const body = await readBody(req);
      const target = str(body.target, 'target');
      const text = str(body.text, 'text').trim();
      if (!text) throw new HttpError(400, 'text (string) required');
      const room = await t.findRoom(target);
      if (room) { await t.sendToGroup(room, text); return sendJson(res, 200, { ok: true, to: `room:${room.name}` }); }
      const who = await resolver.resolve(target);
      if (!who) throw new HttpError(404, `"${target}" is neither a room you are in nor a known agent name`);
      if (!(await t.canMessage(who.address))) throw new HttpError(404, `${who.name} has no inbox on the network`);
      await t.sendDm(who.address, text);
      return sendJson(res, 200, { ok: true, to: who.name });
    }
    case 'POST /join': {
      const t = await ready();
      const body = await readBody(req);
      const room = str(body.room, 'room').trim();
      const wait = Math.min(Math.max(Number(body.wait ?? 8) || 0, 0), 120);
      if (await t.findRoom(room)) return sendJson(res, 200, { ok: true, note: `already in ${room}` });
      await t.sendDm(await keeper(), `join ${room}`);
      const deadline = Date.now() + wait * 1000;
      let joined = false;
      while (!joined && Date.now() < deadline) { await sleep(1000); joined = Boolean(await t.findRoom(room)); }
      if (!joined && wait === 0) joined = Boolean(await t.findRoom(room));
      return sendJson(res, 200, { ok: joined, note: `asked the keeper to add you to ${room}` });
    }
    case 'POST /leave': {
      const t = await ready();
      const body = await readBody(req);
      const room = str(body.room, 'room').trim();
      if (!(await t.findRoom(room))) throw new HttpError(404, `you are not in ${room}`);
      await t.sendDm(await keeper(), `leave ${room}`);
      await sleep(3000);
      return sendJson(res, 200, { ok: true });
    }
    case 'GET /members': {
      const t = await ready();
      const room = url.searchParams.get('room') ?? '';
      if (!room) throw new HttpError(400, 'room required');
      const group = await t.findRoom(room);
      if (!group) throw new HttpError(404, `you are not in ${room}`);
      const addresses = await t.memberAddresses(group);
      return sendJson(res, 200, await Promise.all(addresses.map(async (address) => ({ name: await resolver.label(address), address, you: address.toLowerCase() === keystore.address.toLowerCase() }))));
    }
    case 'GET /rooms': {
      const t = await ready();
      return sendJson(res, 200, (await t.groups()).map((g) => g.name ?? '(unnamed)'));
    }
    default:
      throw new HttpError(404, `no route ${route}`);
  }
}

const server = createServer((req, res) => {
  const t0 = Date.now();
  const what = `${req.method} ${req.url}`;
  if (req.url !== '/health') res.on('finish', () => log(`${what} → ${res.statusCode} ${Date.now() - t0}ms`));
  handle(req, res).catch((err) => {
    if (res.headersSent || res.destroyed) return;
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  });
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 0;

// --- lifecycle -------------------------------------------------------------------------------------
let stopping = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`netd: ${name} going offline (${reason})`);
  for (const wake of waiters.splice(0)) wake();
  try { server.close(); } catch { /* ignore */ }
  try { if (existsSync(paths.sock)) unlinkSync(paths.sock); } catch { /* ignore */ }
  try { if (paths.sock !== sockLink && lstatSync(sockLink).isSymbolicLink()) unlinkSync(sockLink); } catch { /* ignore */ }
  try { await Promise.race([transport?.stop(), sleep(5000)]); } catch { /* ignore */ }
  releaseLock();
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGHUP', () => { /* the terminal that started us may vanish; keep running */ });
process.on('uncaughtException', (err) => { log(`netd: uncaught ${err instanceof Error ? err.stack ?? err.message : String(err)}`); void shutdown('uncaught exception', 1); });
process.on('unhandledRejection', (err) => log(`netd: unhandled rejection ${err instanceof Error ? err.message : String(err)}`));

acquireLock();
await waitForDbFree();
loadQueue();
if (existsSync(paths.sock)) {
  // Our lock plus the free db mean no daemon is alive; the socket file is a leftover.
  const s = statSync(paths.sock);
  if (!s.isSocket()) { log(`netd: ${paths.sock} exists and is not a socket; exiting`); releaseLock(); process.exit(1); }
  unlinkSync(paths.sock);
}
server.on('error', (err) => { log(`netd: server error ${err.message}`); void shutdown('server error', 1); });
server.listen(paths.sock, () => {
  log(`netd: listening on ${paths.sock}`);
  if (paths.sock !== sockLink) {
    try { if (lstatSync(sockLink).isSymbolicLink()) unlinkSync(sockLink); } catch { /* none */ }
    try { symlinkSync(paths.sock, sockLink); } catch (e) { log(`netd: cannot symlink ${sockLink}: ${(e as Error).message}`); }
  }
});
booting = startTransport().then((t) => { transport = t; log(`netd: ${name} ${keystore.address} online on xmtp:${env} (inbox ${t.inboxId}); ${queue.length} queued`); });
booting.catch((err) => { log(`netd: transport failed to start: ${err instanceof Error ? err.message : String(err)}`); void shutdown('boot failed', 1); });
booting.finally(() => { booting = undefined; });
