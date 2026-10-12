/**
 * The relay: the daemon for N identities behind bearer tokens, for agents that cannot run Node or a daemon
 * of their own (a cloud harness, a Python program, Claude Code with one `claude mcp add`). Custodial by
 * construction: the relay holds each identity's key under RELAY_HOME/identities/<name>/ (exactly what
 * AGENT_HOME holds for the daemon: key, xmtp db, cursor, durable queue) and runs its one XMTP client.
 * Identities are created by the operator only — `anet relay add-identity <name>` — which is the invite policy.
 *
 *   RELAY_HOME/names.json          shared contacts (hot-reloaded); every relay identity and the keeper are added
 *   RELAY_HOME/tokens.json         {"<token>": "<name>"} plaintext, 0600, re-read when it changes; "_admin" may list identities
 *   RELAY_HOME/identities/<name>/  key, xmtp-<env>.db3, xmtp-<env>.cursor, netd-queue.jsonl
 *
 *   GET  /health                   open: {ok, env, identities, since, maxWait}
 *   /v1/*  needs  Authorization: Bearer <token>  (401 otherwise); the token selects the identity:
 *   GET  /v1/whoami · GET /v1/inbox?wait=S · POST /v1/send · POST /v1/join · POST /v1/leave · GET /v1/members?room=
 *   GET  /v1/rooms · GET /v1/names · GET /v1/keeper · GET /v1/identities (admin token) · POST|GET|DELETE /v1/mcp
 *
 * `wait` is capped at 600 s, or 80 s with RELAY_BEHIND_PROXY=1 (Cloudflare cuts a response at 100 s); at most 4
 * concurrent inbox polls per identity. One MCP session per identity on /v1/mcp (a new initialize replaces it),
 * reusing the identity's queue. One log line per request: method, path, identity, status, ms — never bodies or tokens.
 *
 *   node packages/relay/dist/relay.js [--home RELAY_HOME] [--listen host:port] [--socket path]
 *   env: RELAY_HOME (default ~/relay), XMTP_ENV (dev), KEEPER_ADDRESS (0x… or a name in names.json; default "keeper"),
 *        RELAY_BEHIND_PROXY=1
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { isAddress } from 'viem';
import { Resolver, StaticBackend } from '@agent-network/resolver';
import { Lock, dbHolders } from './guard.js';
import { HttpError, sendJson } from './http.js';
import { Identity } from './identity.js';
import { createMcpServer, type Verbs } from './mcp.js';
import { NamesFile } from './names.js';
import { clampWait, handleVerb, sendError } from './routes.js';
import { ADMIN, TokenFile } from './tokens.js';

export interface RelayOptions {
  home: string;
  /** TCP `host:port` (port 0 = any free port). */
  listen?: string;
  /** Unix socket path. */
  socket?: string;
  env?: XmtpEnv;
  /** The room-keeper: a 0x address or a name in names.json. Default "keeper". */
  keeperName?: string;
  behindProxy?: boolean;
  log?: (line: string) => void;
}

export interface Relay {
  readonly port: number | undefined;
  readonly socket: string | undefined;
  readonly identities: ReadonlyMap<string, Identity>;
  close(): Promise<void>;
}

export const MAX_POLLS_PER_IDENTITY = 4;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} relay: ${line}\n`));
  const home = resolve(opts.home.startsWith('~') ? join(homedir(), opts.home.slice(1)) : opts.home);
  const env = opts.env ?? 'dev';
  const keeperName = opts.keeperName ?? 'keeper';
  const maxWait = opts.behindProxy ? 80 : 600;
  const since = new Date().toISOString();
  if (!opts.listen && !opts.socket) throw new Error('relay: give --listen host:port and/or --socket path');
  mkdirSync(join(home, 'identities'), { recursive: true, mode: 0o700 });

  const lock = new Lock(join(home, 'relay.lock'), log);
  lock.acquire();

  // --- names: identities first (so an identity's address labels as its name), then the shared file ------
  const namesPath = join(home, 'names.json');
  const contacts = new NamesFile(namesPath);
  const own = new StaticBackend({});
  if (isAddress(keeperName)) contacts.set('keeper', keeperName);
  const scopes = new Map<string, { contacts: NamesFile; resolver: Resolver }>();
  const names = (id: Identity) => ({ ...contacts.entries(), ...own.entries(), ...scopes.get(id.name)!.contacts.entries() });
  const effectiveKeeper = isAddress(keeperName) ? 'keeper' : keeperName;
  const keeperInfo = async (id: Identity) => {
    const r = scopes.get(id.name)!.resolver;
    const k = await r.resolve(effectiveKeeper);
    if (!k) throw new HttpError(400, `keeper "${keeperName}" does not resolve; add it to ${namesPath} or set KEEPER_ADDRESS`);
    return { name: effectiveKeeper, address: k.address };
  };

  // --- identities: one per name in tokens.json, booted at start and lazily on first use -----------------
  const tokens = new TokenFile(join(home, 'tokens.json'));
  const identities = new Map<string, Identity>();
  function identity(name: string): Identity {
    let id = identities.get(name);
    if (id) return id;
    if (!NAME_RE.test(name)) throw new HttpError(500, `identity name "${name}" in tokens.json is not a valid name`);
    const identityHome = join(home, 'identities', name);
    const scoped = new NamesFile(join(identityHome, 'names.json'));
    const resolver = new Resolver({ backends: [scoped, own, contacts], ttlMs: 10_000 });
    id = new Identity({ name, home: identityHome, env, resolver, keeperName: effectiveKeeper, namesPath, log });
    scoped.set(name, id.address);
    scopes.set(name, { contacts: scoped, resolver });
    const holders = dbHolders(id.dbPath, log);
    if (holders.length) throw new HttpError(503, `identity ${name}: its db is open by pid ${holders.join(',')}; refusing to open it twice`);
    identities.set(name, id);
    own.set(name, id.address);
    id.start().catch((err) => {
      log(`${name}: transport failed to start: ${err instanceof Error ? err.message : String(err)}`);
      identities.delete(name); // let the next request try again
    });
    return id;
  }
  const boots = tokens.names().map(async (n) => { try { await identity(n).start(); } catch (err) { log(`${n}: ${err instanceof Error ? err.message : String(err)}`); } });
  void Promise.allSettled(boots).then(() => log(`${identities.size} identit${identities.size === 1 ? 'y' : 'ies'} booted (${[...identities.keys()].length ? [...identities.keys()].join(', ') : 'none'})`));

  // --- /v1/mcp: one session per identity, the identity's own queue behind `wait` ------------------------
  type Session = { server: McpServer; transport: StreamableHTTPServerTransport };
  const sessions = new Map<string, Session>();
  const verbsFor = (id: Identity): Verbs => ({
    send: (target, text) => id.send(target, text),
    join: (room) => id.join(room, 8),
    leave: (room) => id.leave(room),
    members: (room) => id.members(room),
    wait: async (seconds, signal) => {
      if (id.polling >= MAX_POLLS_PER_IDENTITY) throw new HttpError(429, `too many concurrent inbox polls for ${id.name} (max ${MAX_POLLS_PER_IDENTITY})`);
      id.polling++;
      try {
        const taken = await id.inbox(Math.min(seconds, maxWait), signal);
        taken.ack();
        return taken.messages;
      } finally { id.polling--; }
    },
    self: async () => { await id.ready(); const w = id.whoami(); return { name: w.name, address: w.address, inboxId: w.inboxId, env: w.env, names: names(id) }; },
  });
  async function newSession(id: Identity): Promise<Session> {
    const old = sessions.get(id.name);
    if (old) { sessions.delete(id.name); await old.server.close().catch(() => undefined); }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const server = createMcpServer(verbsFor(id), { maxWait });
    await server.connect(transport);
    const s = { server, transport };
    sessions.set(id.name, s);
    return s;
  }
  const readRaw = (req: IncomingMessage, limit = 4 * 1024 * 1024) =>
    new Promise<string>((resolveRaw, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > limit) reject(new HttpError(413, 'body too large')); else chunks.push(c); });
      req.on('end', () => resolveRaw(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  async function mcp(req: IncomingMessage, res: ServerResponse, id: Identity): Promise<void> {
    let parsed: unknown;
    if (req.method === 'POST') {
      const raw = await readRaw(req);
      try { parsed = raw.trim() ? JSON.parse(raw) : undefined; } catch { throw new HttpError(400, 'body must be JSON-RPC'); }
    }
    const initializing = req.method === 'POST' && (Array.isArray(parsed) ? parsed.some(isInitializeRequest) : isInitializeRequest(parsed));
    const session = initializing ? await newSession(id) : sessions.get(id.name) ?? (await newSession(id));
    await session.transport.handleRequest(req, res, parsed);
  }

  // --- the server ----------------------------------------------------------------------------------------
  const bearer = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    if (!h) return null;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    return m ? m[1] : null;
  };

  async function handle(req: IncomingMessage, res: ServerResponse, who: { name: string }): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, env, identities: identities.size, since, maxWait });
    if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
    const token = bearer(req);
    const name = token ? tokens.lookup(token) : null;
    if (!name) { res.setHeader('www-authenticate', 'Bearer realm="agent-network relay"'); throw new HttpError(401, 'unauthorized: Authorization: Bearer <token> required'); }
    who.name = name;
    const route = `${req.method} ${url.pathname.slice(3)}`;
    if (route === 'GET /identities') {
      if (name !== ADMIN) throw new HttpError(403, 'the identities list needs the admin token');
      return sendJson(res, 200, [...identities.values()].map((id) => ({ name: id.name, address: id.address, online: id.online, queued: id.queue.length, lastPoll: id.lastPoll })));
    }
    if (name === ADMIN) throw new HttpError(403, 'the admin token is not an identity');
    const id = identity(name);
    if (route === 'GET /keeper') return sendJson(res, 200, await keeperInfo(id));
    if (url.pathname === '/v1/mcp') return mcp(req, res, id);
    if (route === 'GET /inbox') {
      if (id.polling >= MAX_POLLS_PER_IDENTITY) throw new HttpError(429, `too many concurrent inbox polls for ${name} (max ${MAX_POLLS_PER_IDENTITY})`);
      clampWait(url.searchParams.get('wait'), maxWait);
    }
    if (!(await handleVerb(route, url, req, res, { identity: id, maxWait, names: () => names(id),
      setNames: (value) => { const scope = scopes.get(id.name)!; scope.contacts.replace(value); scope.resolver.clearCache(); },
    }))) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const t0 = Date.now();
    const who = { name: '-' };
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/health') res.on('finish', () => log(`${req.method} ${path} ${who.name} ${res.statusCode} ${Date.now() - t0}ms`));
    handle(req, res, who).catch((err) => sendError(res, err));
  };
  const servers: Server[] = [];
  const make = () => {
    const s = createServer(listener);
    s.requestTimeout = 0;
    s.headersTimeout = 60_000;
    servers.push(s);
    return s;
  };
  const listen = (s: Server, portOrPath: number | string, host?: string) =>
    new Promise<void>((ok, fail) => {
      s.once('error', fail);
      const done = () => { s.off('error', fail); ok(); };
      if (typeof portOrPath === 'number') s.listen(portOrPath, host, done); else s.listen(portOrPath, done);
    });

  let port: number | undefined;
  if (opts.listen) {
    const i = opts.listen.lastIndexOf(':');
    const host = i >= 0 ? opts.listen.slice(0, i) || '127.0.0.1' : '127.0.0.1';
    const p = Number(i >= 0 ? opts.listen.slice(i + 1) : opts.listen);
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`relay: bad --listen ${opts.listen}`);
    const s = make();
    await listen(s, p, host);
    port = (s.address() as { port: number }).port;
    log(`listening on http://${host}:${port}${opts.behindProxy ? ' (behind a proxy; wait ≤ 80 s)' : ''}`);
  }
  if (opts.socket) {
    if (existsSync(opts.socket)) {
      if (!statSync(opts.socket).isSocket()) throw new Error(`relay: ${opts.socket} exists and is not a socket`);
      unlinkSync(opts.socket); // our lock means no relay is alive; a leftover
    }
    const s = make();
    await listen(s, opts.socket);
    log(`listening on ${opts.socket}`);
  }

  let closed = false;
  return {
    port,
    socket: opts.socket,
    identities,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of servers) { s.closeIdleConnections?.(); s.close(); }
      await Promise.allSettled([...sessions.values()].map((s) => s.server.close()));
      await Promise.allSettled([...identities.values()].map((id) => id.stop()));
      for (const s of servers) s.closeAllConnections?.();
      if (opts.socket) { try { unlinkSync(opts.socket); } catch { /* gone */ } }
      lock.release();
    },
  };
}

// --- main ----------------------------------------------------------------------------------------------------
const isMain = (() => { try { return import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} relay: ${line}\n`);
  const relay = await startRelay({
    home: flag('--home') ?? process.env.RELAY_HOME ?? '~/relay',
    listen: flag('--listen'),
    socket: flag('--socket'),
    env: (process.env.XMTP_ENV ?? 'dev') as XmtpEnv,
    keeperName: process.env.KEEPER_ADDRESS,
    behindProxy: process.env.RELAY_BEHIND_PROXY === '1',
    log,
  }).catch((err) => { log(err instanceof Error ? err.message : String(err)); process.exit(2); });
  let stopping = false;
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log(`going offline (${reason})`);
    await Promise.race([relay.close(), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => { /* keep running */ });
  process.on('uncaughtException', (err) => { log(`uncaught ${err instanceof Error ? err.stack ?? err.message : String(err)}`); void shutdown('uncaught exception', 1); });
  process.on('unhandledRejection', (err) => log(`unhandled rejection ${err instanceof Error ? err.message : String(err)}`));
}
