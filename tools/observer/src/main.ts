#!/usr/bin/env node
/**
 * Observer: the operator's window onto a room. It is an ordinary participant with its own
 * identity (key under AGENT_HOME), joins ROOM through the keeper like any agent, follows the
 * keeper's room list, and shows the traffic in a browser as it arrives: agents in a sidebar,
 * a filterable/searchable timeline with markdown rendering, an "asks for the owner" panel
 * (anything addressed to @owner / "owner:" or sent as a DM to this identity), and a box to
 * speak into any room it is in.
 *
 * Env: AGENT_HOME (default ~/.agent-network-observer), AGENT_NAME (default observer),
 * KEEPER_ADDRESS (default keeper), ROOM (required), PORT (default 8787), HOST (default
 * 127.0.0.1; 0.0.0.0 binds the LAN), XMTP_ENV (default dev), KEEPER_ROOMS_FILE.
 * No web framework: node:http, one inline dependency-free page, server-sent events.
 *
 * HTTP: GET / page · GET /events SSE (ring replay, then live; one JSON line per event:
 * {ts, from, room, kind: room|dm|system, text, missed}) · GET /members[?room=] · GET /rooms ·
 * GET /api/agents (per known name: address, lastSeen, count) · POST /send {text, room?}.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAddress } from 'viem';
import { Transport, loadOrCreateKeystore, resolveHome, type Inbound } from '@agent-network/core';
import { Resolver, StaticBackend, type NameBackend, type Resolved } from '@agent-network/resolver';

const log = (...args: unknown[]) => process.stderr.write(`[observer] ${args.map(String).join(' ')}\n`);

/** $AGENT_HOME/names.json, re-read when it changes, so new agents need no restart. */
class NamesFile implements NameBackend {
  private inner = new StaticBackend({});
  private mtime = -1;
  constructor(private readonly path: string, private readonly self: string, private readonly selfAddress: `0x${string}`) {}
  private load(): StaticBackend {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime !== this.mtime) {
      try {
        this.inner = new StaticBackend(mtime ? JSON.parse(readFileSync(this.path, 'utf8')) : {});
      } catch (err) {
        log(`names.json unreadable (${err instanceof Error ? err.message : String(err)}); keeping the previous roster`);
      }
      this.inner.set(this.self, this.selfAddress);
      this.mtime = mtime;
    }
    return this.inner;
  }
  resolve(name: string): Promise<Resolved | null> { return this.load().resolve(name); }
  reverse(address: `0x${string}`): Promise<string | null> { return this.load().reverse(address); }
  /** Every name in the file (plus this identity), name → address. */
  entries(): Record<string, string> { return this.load().entries(); }
}

const fail = (msg: string): never => { log(msg); process.exit(1); };
const ROOM: string = process.env.ROOM?.trim().toLowerCase() || fail('ROOM must be set (e.g. ROOM=lab-20261007)');
const name = process.env.AGENT_NAME ?? 'observer';
const keeper = process.env.KEEPER_ADDRESS ?? 'keeper';
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST?.trim() || '127.0.0.1';
const OWNER_TOKEN = process.env.OBSERVER_TOKEN?.trim() || '';
// OBSERVER_BASIC_AUTH=user:pass protects every route (the UI is reachable from the internet through a tunnel).
const BASIC_AUTH = process.env.OBSERVER_BASIC_AUTH?.trim() || '';
const basicOk = (header: string | undefined): boolean => {
  if (!BASIC_AUTH) return true;
  const want = Buffer.from('Basic ' + Buffer.from(BASIC_AUTH).toString('base64'));
  const got = Buffer.from(header ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
};
if (!OWNER_TOKEN && host !== '127.0.0.1') log('WARNING: OBSERVER_TOKEN is not set; anyone who can reach this port can post as the owner');
const env = (process.env.XMTP_ENV ?? 'dev') as 'dev' | 'production' | 'local';
const keystore = loadOrCreateKeystore(resolveHome(process.env.AGENT_HOME ?? '~/.agent-network-observer'));
const contacts = new NamesFile(join(keystore.home, 'names.json'), name, keystore.address);
// When the keeper is given as an address, let the roster call it "keeper" even without names.json.
const known = new StaticBackend(isAddress(keeper) ? { keeper } : {});
const resolver = new Resolver({ backends: [contacts, known], ttlMs: 10_000 });

// --- the ring and its subscribers -----------------------------------------------------------
interface Line { ts: string; from: string; room: string | null; kind: 'room' | 'dm' | 'system'; text: string; missed: boolean }
const ring: Line[] = [];
const clients = new Set<ServerResponse>();
function push(line: Line): void {
  ring.push(line);
  if (ring.length > 500) ring.shift();
  const frame = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of clients) res.write(frame);
}
const system = (text: string, room: string = ROOM) => push({ ts: new Date().toISOString(), from: 'system', room, kind: 'system', text, missed: false });

/** Per-agent activity as the ring remembers it: names.json roster + anyone who has spoken. */
function agents(): { name: string; address: string | null; lastSeen: string | null; count: number }[] {
  const roster: Record<string, string> = { ...contacts.entries(), ...known.entries() };
  const stats = new Map<string, { lastSeen: string; count: number }>();
  for (const line of ring) {
    if (line.kind === 'system') continue;
    const s = stats.get(line.from);
    if (!s) stats.set(line.from, { lastSeen: line.ts, count: 1 });
    else { s.count += 1; if (line.ts > s.lastSeen) s.lastSeen = line.ts; }
  }
  const names = new Set<string>([...Object.keys(roster), ...stats.keys()]);
  return [...names]
    .map((n) => ({ name: n, address: roster[n] ?? (isAddress(n) ? n : null), lastSeen: stats.get(n)?.lastSeen ?? null, count: stats.get(n)?.count ?? 0 }))
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || a.name.localeCompare(b.name));
}

// --- transport --------------------------------------------------------------------------------
const transport = await Transport.start({
  keystore,
  env,
  onInbound: async (m: Inbound) =>
    push({ ts: m.sentAt.toISOString(), from: await resolver.label(m.from), room: m.room, kind: m.room ? 'room' : 'dm', text: m.text, missed: m.missed }),
  onJoined: (g) => system(`joined room ${g.name ?? '(unnamed)'}`, g.name ?? ROOM),
});
if (await transport.findRoom(ROOM)) {
  system(`already in room ${ROOM}`);
} else {
  const k = await resolver.resolve(keeper);
  if (!k) {
    log(`keeper "${keeper}" does not resolve; add it to ${join(keystore.home, 'names.json')} or set KEEPER_ADDRESS=0x...`);
    system(`cannot join ${ROOM}: keeper "${keeper}" does not resolve`);
  } else {
    await transport.sendDm(k.address, `join ${ROOM}`);
    system(`asked the keeper to add me to ${ROOM}`);
  }
}

// --- http -------------------------------------------------------------------------------------
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 65_536) req.destroy(new Error('body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

async function roomNames(): Promise<string[]> {
  const names = (await transport.groups()).map((g) => g.name ?? '').filter((n) => n.length > 0);
  const unique = [...new Set(names)].sort();
  return unique.includes(ROOM) ? [ROOM, ...unique.filter((n) => n !== ROOM)] : unique;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!basicOk(req.headers.authorization)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="agent-network"', 'content-type': 'text/plain' });
    return void res.end('login required');
  }
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE.replace('__CONFIG__', JSON.stringify({ room: ROOM, name, address: keystore.address, env })));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const line of ring) res.write(`data: ${JSON.stringify(line)}\n\n`);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25_000);
    res.on('close', () => clearInterval(ping));
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'GET' && url.pathname === '/members') {
    const room = (url.searchParams.get('room') ?? ROOM).trim().toLowerCase();
    const group = await transport.findRoom(room);
    if (!group) return json(res, 409, { error: `not yet in ${room}` });
    const addresses = await transport.memberAddresses(group);
    json(res, 200, await Promise.all(addresses.map(async (address) => ({ name: await resolver.label(address), address }))));
  } else if (req.method === 'GET' && url.pathname === '/rooms') {
    json(res, 200, await roomNames());
  } else if (req.method === 'GET' && url.pathname === '/api/agents') {
    json(res, 200, agents());
  } else if (req.method === 'POST' && url.pathname === '/send') {
    // Anyone who can reach this port may read; only the owner (OBSERVER_TOKEN) may speak as the owner.
    if (OWNER_TOKEN && req.headers['x-owner-token'] !== OWNER_TOKEN) return json(res, 401, { error: 'owner token required (x-owner-token header)' });
    const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown; room?: unknown; to?: unknown };
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'text required' });
    if (typeof body.to === 'string' && body.to.trim()) {
      // a direct message (the owner answering one agent) instead of a room post
      const who = await resolver.resolve(body.to.trim());
      if (!who) return json(res, 404, { error: `"${body.to}" is not a known agent name` });
      if (!(await transport.canMessage(who.address))) return json(res, 409, { error: `${who.name} has no inbox on the network` });
      await transport.sendDm(who.address, text);
      push({ ts: new Date().toISOString(), from: name, room: null, kind: 'dm', text: `→ ${who.name}: ${text}`, missed: false });
      return json(res, 200, { ok: true, to: who.name });
    }
    const room = (typeof body.room === 'string' && body.room.trim() ? body.room : ROOM).trim().toLowerCase();
    const group = await transport.findRoom(room);
    if (!group) return json(res, 409, { error: `not yet in ${room}` });
    await transport.sendToGroup(group, text);
    push({ ts: new Date().toISOString(), from: name, room, kind: 'room', text, missed: false });
    json(res, 200, { ok: true, room });
  } else {
    json(res, 404, { error: 'not found' });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('request failed:', err instanceof Error ? err.message : String(err));
    if (!res.headersSent) json(res, 500, { error: String(err instanceof Error ? err.message : err) });
    else res.end();
  });
});
setInterval(() => { for (const res of clients) res.write(': hb\n\n'); }, 25_000).unref();
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[observer] port ${port} is already in use — an observer is probably already running; open http://${host}:${port} or start this one with PORT=<other port>.`);
    process.exit(1);
  }
  throw err;
});
// Follow the keeper's room list (same machine), joining any room the agents create.
const keeperRooms = process.env.KEEPER_ROOMS_FILE ?? join(homedir(), '.agent-network-keeper', 'rooms.json');
const joinedOrAsked = new Set<string>([ROOM]);
async function followRooms(): Promise<void> {
  if (!existsSync(keeperRooms)) return;
  let rooms: Record<string, string>;
  try { rooms = JSON.parse(readFileSync(keeperRooms, 'utf8')); } catch { return; }
  for (const name of Object.keys(rooms)) {
    if (joinedOrAsked.has(name) || name.startsWith('observer-selftest')) continue;
    if (await transport.findRoom(name)) { joinedOrAsked.add(name); continue; }
    const k = await resolver.resolve(process.env.KEEPER_ADDRESS ?? 'keeper');
    if (!k) return;
    joinedOrAsked.add(name);
    await transport.sendDm(k.address, `join ${name}`);
    push({ ts: new Date().toISOString(), from: 'system', room: name, kind: 'system', text: `asked the keeper to add me to ${name} (new room seen in the keeper's list)`, missed: false });
  }
}
setInterval(() => void followRooms().catch((e) => log('followRooms:', String(e))), 30_000);
server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? '<this machine>' : host;
  log(`${name} ${keystore.address} online; watching ${ROOM} at http://${shown}:${port}${shown.startsWith('<') ? ' (bound to every interface)' : ''}`);
});

const shutdown = async () => { server.close(); for (const c of clients) c.end(); await transport.stop().catch(() => undefined); process.exit(0); };
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// --- the page ---------------------------------------------------------------------------------
// String.raw so the page's regexes keep their backslashes; the page must not contain a backtick
// (the markdown pass spells it '\x60') or "${".
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent network</title>
<style>
  :root{color-scheme:dark;--bg:#0e1014;--panel:#151821;--panel2:#1b1f2a;--line:#272c38;--fg:#e8eaf0;--dim:#8d94a6;--accent:#6ea8fe;--ok:#8be28b;--warn:#f5c76b;--danger:#ff7b7b;--code:#0a0c10}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  body{display:grid;height:100dvh;grid-template-rows:auto 1fr auto;grid-template-columns:230px minmax(0,1fr) 360px}
  body.no-owner{grid-template-columns:230px minmax(0,1fr) 0}
  body.no-owner #owner{display:none}
  code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  button{font:inherit;cursor:pointer}
  header{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--line)}
  header h1{font-size:16px;margin:0;white-space:nowrap}
  header .me{color:var(--dim);font-size:12px;white-space:nowrap}
  header .spacer{flex:1}
  #search{min-width:220px;flex:1 1 220px;max-width:420px;background:var(--code);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit}
  .toggles{display:flex;gap:4px}
  .tg{background:var(--panel2);color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .tg[aria-pressed="true"]{color:var(--fg);border-color:#3b4356;background:#242a38}
  .tg.dm[aria-pressed="true"]{color:var(--warn)}.tg.system[aria-pressed="true"]{color:var(--ok)}
  #ownerBtn{background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font-size:12px;display:flex;gap:6px;align-items:center}
  #ownerBtn .n{background:var(--warn);color:#1a1200;border-radius:999px;padding:0 7px;font-weight:700;font-size:11px}
  #ownerBtn .n.zero{background:var(--line);color:var(--dim)}
  .chip{background:#242a38;border:1px solid #3b4356;border-radius:999px;padding:1px 10px;font-size:12px;display:inline-flex;gap:6px;align-items:center}
  .chip b{cursor:pointer;color:var(--dim)}
  .chip b:hover{color:var(--fg)}
  #agents{grid-row:2;overflow-y:auto;background:var(--panel);border-right:1px solid var(--line);padding:8px 0}
  #agents h2,#owner h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:6px 14px;font-weight:600;display:flex;justify-content:space-between}
  .agent{display:grid;grid-template-columns:12px 1fr auto;gap:0 8px;align-items:center;padding:5px 14px;cursor:pointer;border-left:3px solid transparent}
  .agent:hover{background:var(--panel2)}
  .agent.active{background:#242a38;border-left-color:var(--accent)}
  .agent .dot{width:9px;height:9px;border-radius:50%;border:2px solid currentColor;background:transparent}
  .agent.member .dot{background:currentColor}
  .agent .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .agent .cnt{font-size:11px;color:var(--dim);background:var(--panel2);border-radius:999px;padding:0 7px}
  .agent .ls{grid-column:2/-1;font-size:11px;color:var(--dim)}
  .agent.quiet .nm{color:var(--dim);font-weight:500}
  main{grid-row:2;position:relative;min-width:0;display:flex;flex-direction:column}
  #timeline{flex:1;overflow-y:auto;padding:6px 18px 12px}
  .minute{position:sticky;top:0;z-index:1;background:linear-gradient(var(--bg) 70%,transparent);color:var(--dim);font-size:11px;letter-spacing:.04em;padding:10px 0 4px;text-transform:uppercase}
  .msg{display:grid;grid-template-columns:150px minmax(0,1fr);gap:0 12px;padding:4px 0 6px;border-bottom:1px solid #151820}
  .msg .meta{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}
  .who{font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:0 5px;border-radius:3px;border:1px solid var(--line);color:var(--dim);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge.dm{color:var(--warn);border-color:#5a4a22}.badge.system{color:var(--ok);border-color:#2b5a2b}.badge.other{color:var(--accent);border-color:#2b4370;text-transform:none}
  .t{color:var(--dim);font-size:11px}
  .missed{color:var(--dim);font-size:11px}
  .msg.system .text{color:var(--ok)}
  .msg.dm .text{border-left:2px solid #5a4a22;padding-left:10px}
  .msg.ask .who::after{content:" @owner";color:var(--warn);font-weight:500;font-size:11px}
  .textwrap{min-width:0;position:relative}
  .text{overflow-wrap:anywhere;min-width:0}
  .text.collapsed{max-height:252px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
  .more{display:block;background:none;border:0;color:var(--accent);padding:2px 0;font-size:12px}
  .text p{margin:0 0 6px}.text p:last-child{margin-bottom:0}
  .text h1,.text h2,.text h3,.text h4,.text h5,.text h6{margin:6px 0 4px;line-height:1.3}
  .text h1{font-size:18px}.text h2{font-size:16px}.text h3{font-size:15px}.text h4,.text h5,.text h6{font-size:14px}
  .text code{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:12.5px}
  .text pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:8px 10px;overflow-x:auto;margin:6px 0;font-size:12.5px;line-height:1.45}
  .text pre code{background:none;border:0;padding:0;font-size:inherit}
  .text ul,.text ol{margin:4px 0;padding-left:22px}
  .text li{margin:1px 0}
  .text blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--line);color:var(--dim)}
  .text table{border-collapse:collapse;margin:6px 0;font-size:13px;display:block;overflow-x:auto;max-width:100%}
  .text th,.text td{border:1px solid var(--line);padding:3px 8px;text-align:left;vertical-align:top}
  .text th{background:var(--panel2)}
  .text a{color:var(--accent)}
  .text hr{border:0;border-top:1px solid var(--line);margin:8px 0}
  .empty{color:var(--dim);padding:30px 0;text-align:center}
  #jump{position:absolute;right:18px;bottom:12px;background:var(--accent);color:#0b0d11;border:0;border-radius:999px;padding:6px 14px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.5);display:none}
  #owner{grid-row:2;overflow-y:auto;background:var(--panel);border-left:1px solid var(--line);padding:8px 0}
  .ask{margin:0 10px 8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
  .ask.done{opacity:.5}
  .ask .top{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;font-size:12px;margin-bottom:4px}
  .ask .top .who{flex:1 1 auto;min-width:0}
  .ask label{display:flex;gap:4px;align-items:center;color:var(--dim);cursor:pointer;white-space:nowrap}
  .ask .reply{background:none;border:0;color:var(--accent);padding:0;font-size:12px}
  .ask .text{font-size:13px}
  footer{grid-column:1/-1;display:flex;gap:8px;padding:10px 14px;background:var(--panel);border-top:1px solid var(--line)}
  #roomSel{background:var(--code);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 8px;font:inherit;max-width:220px}
  #text{flex:1;min-width:0;background:var(--code);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font:inherit}
  #send{background:var(--accent);color:#0b0d11;border:0;border-radius:6px;padding:8px 16px;font-weight:600}
  button:disabled,input:disabled,select:disabled{opacity:.45;cursor:not-allowed}
  @media (max-width:1100px){body{grid-template-columns:190px minmax(0,1fr) 300px}.msg{grid-template-columns:120px minmax(0,1fr)}}
  @media (max-width:820px){body{grid-template-columns:0 minmax(0,1fr) 0}#agents{display:none}#owner{position:fixed;right:0;top:0;bottom:0;width:min(360px,90vw);z-index:5;box-shadow:-8px 0 30px rgba(0,0,0,.6)}.msg{grid-template-columns:1fr}.msg .meta{flex-direction:row;align-items:baseline;gap:8px}}
</style></head>
<body>
<header>
  <h1 id="room"></h1>
  <div class="me" id="me"></div>
  <span class="chip" id="filterChip" style="display:none"><span id="filterName"></span><b title="clear filter">&times;</b></span>
  <span class="spacer"></span>
  <input id="search" type="search" placeholder="search messages… (text or sender)" autocomplete="off">
  <div class="toggles">
    <button class="tg room" data-kind="room" aria-pressed="true">room</button>
    <button class="tg dm" data-kind="dm" aria-pressed="true">dm</button>
    <button class="tg system" data-kind="system" aria-pressed="true">system</button>
  </div>
  <span class="t" id="count"></span>
  <button id="ownerBtn" title="messages addressed to the owner">Asks for the owner <span class="n zero" id="askCount">0</span></button>
</header>
<aside id="agents"><h2>agents <span id="memberCount"></span></h2><div id="agentList"></div></aside>
<main>
  <div id="timeline"></div>
  <button id="jump">new messages ↓</button>
</main>
<aside id="owner"><h2>asks for the owner <span id="askSub"></span></h2><div id="askList"></div></aside>
<footer>
  <select id="roomSel" title="room to post into"></select>
  <input id="text" placeholder="say something in the room… (Enter sends)" disabled autocomplete="off">
  <button id="send" disabled>Send</button>
  <button id="tokenBtn" title="owner token (needed to post: the OBSERVER_TOKEN the observer was started with)">🔑</button>
</footer>
<script>
(function () {
  'use strict';
  var cfg = __CONFIG__;
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  var color = function (s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return 'hsl(' + (h % 360) + ' 70% 70%)'; };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } }
  };

  document.title = 'agent network · #' + cfg.room;
  $('room').textContent = '#' + cfg.room;
  $('me').textContent = cfg.name + ' · ' + cfg.address.slice(0, 6) + '…' + cfg.address.slice(-4) + ' · xmtp:' + cfg.env;
  $('me').title = cfg.address;

  // ---- state ----------------------------------------------------------------------------
  var lines = [], seen = {}, stats = {}, roster = [], members = {}, rooms = [cfg.room];
  var filterFrom = null, search = '', kinds = { room: true, dm: true, system: true };
  var expanded = {}, answered = store.get('observer.answered.' + cfg.name, {});
  var unseen = 0, firstRender = true, renderQueued = false, disconnected = false;
  var timeline = $('timeline'), jump = $('jump'), input = $('text'), send = $('send'), roomSel = $('roomSel');

  var keyOf = function (l) { return l.ts + '|' + l.from + '|' + (l.room || '') + '|' + l.kind + '|' + l.text; };
  var lower = function (s) { return String(s || '').toLowerCase(); };
  var me = lower(cfg.name);
  var isAsk = function (l) {
    if (l.kind === 'system' || lower(l.from) === me || lower(l.from) === 'keeper') return false;
    if (l.kind === 'dm') return true;
    var t = lower(l.text);
    return t.indexOf('@owner') >= 0 || /^\s*owner\s*:/.test(t) || (me !== 'owner' && (t.indexOf('@' + me) >= 0 || new RegExp('^\\s*' + me.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&') + '\\s*:').test(t)));
  };

  // ---- time -----------------------------------------------------------------------------
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var hms = function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  var hm = function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var sameDay = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
  var dayLabel = function (d) { return d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  var rel = function (ts) {
    var s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
    return Math.floor(s / 86400) + 'd ago';
  };

  // ---- markdown: escape first, then a small block/inline pass; no HTML passes through ----------
  var BT = '\x60';
  var FENCE = new RegExp(BT + BT + BT + '([^\n]*)\n([\\s\\S]*?)\n?' + BT + BT + BT + '[ \t]*(?=\n|$)', 'g');
  var INLINE_CODE = new RegExp(BT + '([^' + BT + '\n]+)' + BT, 'g');
  var LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
  var HEAD = /^(#{1,6})\s+(.*)$/;
  var SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  var QUOTE = /^\s*&gt;\s?/;
  var SLOT = /\u0000(\d+)\u0000/g;
  var ONLY_SLOT = /^\s*\u0000\d+\u0000\s*$/;
  function inline(t) {
    return t
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function md(src) {
    var slots = [];
    var stash = function (html) { slots.push(html); return '\u0000' + (slots.length - 1) + '\u0000'; };
    var s = esc(String(src).replace(/\u0000/g, '').replace(/\r\n?/g, '\n'));
    s = s.replace(FENCE, function (m, lang, code) {
      var cls = lang.trim().replace(/[^\w-]/g, '');
      return stash('<pre><code' + (cls ? ' class="lang-' + cls + '"' : '') + '>' + code + '</code></pre>');
    });
    s = s.replace(INLINE_CODE, function (m, code) { return stash('<code>' + code + '</code>'); });
    var rows = s.split('\n'), out = [], i = 0, m;
    var cells = function (x) { return x.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return inline(c.trim()); }); };
    while (i < rows.length) {
      var r = rows[i];
      if (/^\s*$/.test(r)) { i++; continue; }
      if (ONLY_SLOT.test(r)) { out.push(r.trim()); i++; continue; }
      if ((m = HEAD.exec(r))) { out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
      if (r.indexOf('|') >= 0 && i + 1 < rows.length && SEP.test(rows[i + 1])) {
        var html = '<table><thead><tr>' + cells(r).map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < rows.length && rows[i].indexOf('|') >= 0 && !/^\s*$/.test(rows[i])) { html += '<tr>' + cells(rows[i]).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; i++; }
        out.push(html + '</tbody></table>'); continue;
      }
      if (LIST.test(r)) {
        var ordered = /^\s*\d+[.)]\s+/.test(r), lhtml = ordered ? '<ol>' : '<ul>';
        while (i < rows.length && LIST.test(rows[i])) { lhtml += '<li>' + inline(rows[i].replace(LIST, '')) + '</li>'; i++; }
        out.push(lhtml + (ordered ? '</ol>' : '</ul>')); continue;
      }
      if (QUOTE.test(r)) {
        var q = [];
        while (i < rows.length && QUOTE.test(rows[i])) { q.push(rows[i].replace(QUOTE, '')); i++; }
        out.push('<blockquote>' + inline(q.join('<br>')) + '</blockquote>'); continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(r)) { out.push('<hr>'); i++; continue; }
      var p = [];
      while (i < rows.length && !/^\s*$/.test(rows[i]) && !HEAD.test(rows[i]) && !LIST.test(rows[i]) && !QUOTE.test(rows[i]) && !ONLY_SLOT.test(rows[i]) &&
             !(rows[i].indexOf('|') >= 0 && i + 1 < rows.length && SEP.test(rows[i + 1]))) { p.push(rows[i]); i++; }
      if (!p.length) { p.push(rows[i]); i++; }
      out.push('<p>' + inline(p.join('<br>')) + '</p>');
    }
    return out.join('').replace(SLOT, function (m, n) { return slots[Number(n)]; });
  }

  // ---- rendering helpers ----------------------------------------------------------------
  function badgeFor(l) {
    if (l.kind === 'room') return l.room && l.room !== cfg.room ? ['badge other', '#' + l.room] : ['badge room', 'room'];
    if (l.kind === 'system') return ['badge system', l.room && l.room !== cfg.room ? 'system · ' + l.room : 'system'];
    return ['badge dm', 'dm'];
  }
  function textBlock(l, key) {
    var wrap = el('div', 'textwrap');
    var text = el('div', 'text md');
    text.innerHTML = md(l.text);
    if (l.missed) text.appendChild(el('div', 'missed', '(replayed)'));
    wrap.appendChild(text);
    wrap.measure = function () {
      if (expanded[key]) return;
      var lines = (l.text.match(/\n/g) || []).length;
      if (lines >= 12 || l.text.length > 1800 || text.scrollHeight > 400) {
        text.classList.add('collapsed');
        var more = el('button', 'more', 'show more ▾');
        more.onclick = function () { expanded[key] = true; text.classList.remove('collapsed'); more.remove(); };
        wrap.appendChild(more);
      }
    };
    return wrap;
  }
  function row(l) {
    var key = keyOf(l);
    var r = el('div', 'msg ' + l.kind + (isAsk(l) ? ' ask' : ''));
    var meta = el('div', 'meta');
    var who = el('span', 'who', l.from); who.style.color = l.kind === 'system' ? 'var(--ok)' : color(l.from); who.title = l.from;
    who.style.cursor = 'pointer'; who.onclick = function () { setFilter(l.from === filterFrom ? null : l.from); };
    meta.appendChild(who);
    var b = badgeFor(l); meta.appendChild(el('span', b[0], b[1]));
    var d = new Date(l.ts);
    meta.appendChild(el('span', 't', hms(d)));
    r.appendChild(meta);
    var tb = textBlock(l, key); r.appendChild(tb);
    r.addEventListener('mouseenter', function () { r.title = rel(l.ts) + ' · ' + d.toLocaleString(); });
    r.measure = tb.measure;
    return r;
  }
  var atBottom = function () { return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60; };
  function visible(l) {
    if (!kinds[l.kind]) return false;
    if (filterFrom && l.from !== filterFrom) return false;
    if (search && lower(l.text).indexOf(search) < 0 && lower(l.from).indexOf(search) < 0 && lower(l.room).indexOf(search) < 0) return false;
    return true;
  }
  function renderTimeline() {
    var stick = firstRender || atBottom();
    var list = lines.filter(visible).slice().sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
    timeline.replaceChildren();
    var lastMinute = null, now = new Date(), toMeasure = [];
    for (var i = 0; i < list.length; i++) {
      var l = list[i], d = new Date(l.ts), minute = l.ts.slice(0, 16);
      if (minute !== lastMinute) { timeline.appendChild(el('div', 'minute', (sameDay(d, now) ? '' : dayLabel(d) + ' · ') + hm(d))); lastMinute = minute; }
      var r = row(l); timeline.appendChild(r); toMeasure.push(r);
    }
    if (!list.length) timeline.appendChild(el('div', 'empty', lines.length ? 'nothing matches the current filter' : 'waiting for traffic…'));
    for (var j = 0; j < toMeasure.length; j++) toMeasure[j].measure();
    $('count').textContent = list.length === lines.length ? lines.length + ' msgs' : list.length + ' / ' + lines.length + ' msgs';
    if (stick) { timeline.scrollTop = timeline.scrollHeight; unseen = 0; jump.style.display = 'none'; }
    else if (unseen > 0) { jump.textContent = unseen + ' new ↓'; jump.style.display = 'block'; }
    firstRender = false;
  }
  function renderAgents() {
    var names = {};
    roster.forEach(function (a) { names[a.name] = true; });
    Object.keys(stats).forEach(function (n) { names[n] = true; });
    delete names.system;
    var listEl = $('agentList'); listEl.replaceChildren();
    var all = Object.keys(names).map(function (n) { var s = stats[n] || { count: 0, lastSeen: null }; return { name: n, count: s.count, lastSeen: s.lastSeen }; });
    all.sort(function (a, b) { return (b.lastSeen || '').localeCompare(a.lastSeen || '') || a.name.localeCompare(b.name); });
    var memberN = Object.keys(members).length;
    $('memberCount').textContent = memberN ? memberN + ' in room' : '';
    all.forEach(function (a) {
      var r = el('div', 'agent' + (members[a.name] ? ' member' : '') + (a.name === filterFrom ? ' active' : '') + (a.count ? '' : ' quiet'));
      var dot = el('span', 'dot'); dot.style.color = color(a.name); dot.title = members[a.name] ? 'in #' + roomSel.value : 'not in #' + roomSel.value;
      r.appendChild(dot);
      r.appendChild(el('span', 'nm', a.name));
      r.appendChild(el('span', 'cnt', String(a.count)));
      r.appendChild(el('span', 'ls', a.lastSeen ? 'seen ' + rel(a.lastSeen) : 'never seen'));
      r.title = (a.name === filterFrom ? 'click to clear the filter' : 'click to show only ' + a.name);
      r.onclick = function () { setFilter(a.name === filterFrom ? null : a.name); };
      listEl.appendChild(r);
    });
  }
  function renderAsks() {
    var asks = lines.filter(isAsk).slice().sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0; });
    var open = 0;
    var listEl = $('askList'); listEl.replaceChildren();
    asks.forEach(function (l) {
      var key = keyOf(l), done = !!answered[key];
      if (!done) open++;
      var card = el('div', 'ask' + (done ? ' done' : ''));
      var top = el('div', 'top');
      var who = el('span', 'who', l.from); who.style.color = color(l.from); top.appendChild(who);
      var b = badgeFor(l); top.appendChild(el('span', b[0], b[1]));
      var t = el('span', 't', rel(l.ts)); t.title = new Date(l.ts).toLocaleString(); top.appendChild(t);
      var reply = el('button', 'reply', 'reply');
      reply.onclick = function () { input.value = '@' + l.from + ' '; input.focus(); };
      top.appendChild(reply);
      var lab = el('label'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = done;
      cb.onchange = function () { if (cb.checked) answered[key] = Date.now(); else delete answered[key]; store.set('observer.answered.' + cfg.name, answered); renderAsks(); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode('answered')); top.appendChild(lab);
      card.appendChild(top);
      var tb = textBlock(l, 'ask:' + key); card.appendChild(tb);
      listEl.appendChild(card); tb.measure();
    });
    if (!asks.length) listEl.appendChild(el('div', 'empty', 'nothing addressed to the owner yet'));
    var n = $('askCount'); n.textContent = String(open); n.className = 'n' + (open ? '' : ' zero');
    $('askSub').textContent = asks.length ? open + ' open · ' + (asks.length - open) + ' answered' : '';
  }
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; renderTimeline(); renderAgents(); renderAsks(); }, 0); // not rAF: it stalls in background tabs
  }
  function setFilter(name) {
    filterFrom = name;
    $('filterChip').style.display = name ? '' : 'none';
    $('filterName').textContent = name ? 'only ' + name : '';
    firstRender = true; // re-stick to the bottom after a view change
    queueRender();
  }

  // ---- events -------------------------------------------------------------------------------
  function add(l) {
    var key = keyOf(l);
    if (seen[key]) return;
    seen[key] = true;
    lines.push(l);
    if (lines.length > 2000) { var gone = lines.shift(); delete seen[keyOf(gone)]; }
    if (l.kind !== 'system') {
      var s = stats[l.from] || (stats[l.from] = { count: 0, lastSeen: null });
      s.count++; if (!s.lastSeen || l.ts > s.lastSeen) s.lastSeen = l.ts;
    }
    if (!firstRender && !atBottom() && visible(l)) unseen++;
    queueRender();
  }
  var es = new EventSource('/events');
  es.onmessage = function (e) { disconnected = false; add(JSON.parse(e.data)); };
  es.onerror = function () {
    if (disconnected) return; disconnected = true;
    add({ ts: new Date().toISOString(), from: 'system', room: cfg.room, kind: 'system', text: 'event stream disconnected; reconnecting…', missed: false });
  };
  jump.onclick = function () { timeline.scrollTop = timeline.scrollHeight; unseen = 0; jump.style.display = 'none'; };
  timeline.addEventListener('scroll', function () { if (atBottom()) { unseen = 0; jump.style.display = 'none'; } });

  // ---- controls -------------------------------------------------------------------------------
  $('search').addEventListener('input', function (e) { search = lower(e.target.value.trim()); firstRender = true; queueRender(); });
  Array.prototype.forEach.call(document.querySelectorAll('.tg'), function (btn) {
    btn.onclick = function () { var k = btn.dataset.kind; kinds[k] = !kinds[k]; btn.setAttribute('aria-pressed', String(kinds[k])); firstRender = true; queueRender(); };
  });
  $('filterChip').querySelector('b').onclick = function () { setFilter(null); };
  var ownerOpen = store.get('observer.ownerPanel', true);
  var applyOwner = function () { document.body.classList.toggle('no-owner', !ownerOpen); };
  applyOwner();
  $('ownerBtn').onclick = function () { ownerOpen = !ownerOpen; store.set('observer.ownerPanel', ownerOpen); applyOwner(); };
  setInterval(function () { renderAgents(); renderAsks(); }, 30000);

  // ---- rooms, members, posting -----------------------------------------------------------
  function fillRooms(list) {
    rooms = list.length ? list : [cfg.room];
    var current = roomSel.value || cfg.room;
    roomSel.replaceChildren();
    rooms.forEach(function (r) { var o = document.createElement('option'); o.value = r; o.textContent = '#' + r; roomSel.appendChild(o); });
    roomSel.value = rooms.indexOf(current) >= 0 ? current : rooms[0];
    roomSel.disabled = rooms.length < 2;
  }
  fillRooms([cfg.room]);
  async function refreshRooms() {
    try { var r = await fetch('/rooms'); if (r.ok) fillRooms(await r.json()); } catch (e) { /* keep what we have */ }
  }
  async function refreshMembers() {
    try {
      var r = await fetch('/members?room=' + encodeURIComponent(roomSel.value || cfg.room));
      if (!r.ok) throw new Error(r.status);
      var list = await r.json(); members = {};
      list.forEach(function (m) { members[m.name] = m.address; });
      input.disabled = send.disabled = false;
      input.placeholder = 'say something in #' + roomSel.value + '… (Enter sends)';
    } catch (e) { input.disabled = send.disabled = true; input.placeholder = 'not yet in #' + (roomSel.value || cfg.room) + '…'; }
    renderAgents();
  }
  async function refreshAgents() {
    try { var r = await fetch('/api/agents'); if (r.ok) { roster = await r.json(); renderAgents(); } } catch (e) { /* offline */ }
  }
  roomSel.onchange = function () { refreshMembers(); };
  refreshRooms().then(refreshMembers); refreshAgents();
  setInterval(refreshRooms, 20000); setInterval(refreshMembers, 20000); setInterval(refreshAgents, 15000);
  function askToken() {
    var t = window.prompt('Owner token (the OBSERVER_TOKEN the observer was started with). Stored only in this browser.', store.get('observer.token', ''));
    if (t !== null) store.set('observer.token', t.trim());
  }
  $('tokenBtn').onclick = askToken;
  async function post() {
    var text = input.value.trim(); if (!text) return;
    send.disabled = true;
    try {
      var r = await fetch('/send', { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': store.get('observer.token', '') }, body: JSON.stringify({ text: text, room: roomSel.value || cfg.room }) });
      if (r.status === 401) { askToken(); send.disabled = false; return; }
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      input.value = '';
    } catch (err) { alert('send failed: ' + err.message); }
    send.disabled = false; input.focus();
  }
  send.onclick = post;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); post(); } });
})();
</script>
</body></html>`;
