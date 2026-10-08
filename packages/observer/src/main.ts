#!/usr/bin/env node
/**
 * Observer: an operator's window onto one room. It is an ordinary participant with its own
 * identity (key under AGENT_HOME), joins ROOM through the keeper like any agent, and shows
 * the room's traffic in a browser as it arrives — plus a one-line box to speak into the room.
 *
 * Env: AGENT_HOME (default ~/.agent-network-observer), AGENT_NAME (default observer),
 * KEEPER_ADDRESS (default keeper), ROOM (required), PORT (default 8787), XMTP_ENV (default dev).
 * No web framework: node:http, one inline page, server-sent events. Binds 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAddress } from 'viem';
import { Transport, loadOrCreateKeystore, resolveHome, type Inbound } from '@agent-network/client';
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
      this.inner = new StaticBackend(mtime ? JSON.parse(readFileSync(this.path, 'utf8')) : {});
      this.inner.set(this.self, this.selfAddress);
      this.mtime = mtime;
    }
    return this.inner;
  }
  resolve(name: string): Promise<Resolved | null> { return this.load().resolve(name); }
  reverse(address: `0x${string}`): Promise<string | null> { return this.load().reverse(address); }
}

const fail = (msg: string): never => { log(msg); process.exit(1); };
const ROOM: string = process.env.ROOM?.trim().toLowerCase() || fail('ROOM must be set (e.g. ROOM=lab-20261007)');
const name = process.env.AGENT_NAME ?? 'observer';
const keeper = process.env.KEEPER_ADDRESS ?? 'keeper';
const port = Number(process.env.PORT ?? 8787);
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
const system = (text: string) => push({ ts: new Date().toISOString(), from: 'system', room: ROOM, kind: 'system', text, missed: false });

// --- transport --------------------------------------------------------------------------------
const transport = await Transport.start({
  keystore,
  env,
  onInbound: async (m: Inbound) =>
    push({ ts: m.sentAt.toISOString(), from: await resolver.label(m.from), room: m.room, kind: m.room ? 'room' : 'dm', text: m.text, missed: m.missed }),
  onJoined: (g) => system(`joined room ${g.name ?? '(unnamed)'}`),
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE.replace('__CONFIG__', JSON.stringify({ room: ROOM, name, address: keystore.address })));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const line of ring) res.write(`data: ${JSON.stringify(line)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'GET' && url.pathname === '/members') {
    const group = await transport.findRoom(ROOM);
    if (!group) return json(res, 409, { error: `not yet in ${ROOM}` });
    const addresses = await transport.memberAddresses(group);
    json(res, 200, await Promise.all(addresses.map(async (address) => ({ name: await resolver.label(address), address }))));
  } else if (req.method === 'POST' && url.pathname === '/send') {
    const text = String((JSON.parse((await readBody(req)) || '{}') as { text?: unknown }).text ?? '').trim();
    if (!text) return json(res, 400, { error: 'text required' });
    const group = await transport.findRoom(ROOM);
    if (!group) return json(res, 409, { error: `not yet in ${ROOM}` });
    await transport.sendToGroup(group, text);
    push({ ts: new Date().toISOString(), from: name, room: ROOM, kind: 'room', text, missed: false });
    json(res, 200, { ok: true });
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
    console.error(`[observer] port ${PORT} is already in use — an observer is probably already running; open http://127.0.0.1:${PORT} or start this one with PORT=<other port>.`);
    process.exit(1);
  }
  throw err;
});
server.listen(port, '127.0.0.1', () => log(`${name} ${keystore.address} online; watching ${ROOM} at http://127.0.0.1:${port}`));

const shutdown = async () => { server.close(); for (const c of clients) c.end(); await transport.stop().catch(() => undefined); process.exit(0); };
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// --- the page ---------------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>observer</title>
<style>
  :root{color-scheme:dark;--bg:#0f1115;--panel:#171a21;--line:#262a33;--fg:#e6e6e6;--dim:#8b93a3;--accent:#6ea8fe}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  body{display:flex;flex-direction:column;height:100dvh}
  header{padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
  header h1{font-size:16px;margin:0}
  header .me{color:var(--dim);font-size:12px;word-break:break-all}
  #members{display:flex;flex-wrap:wrap;gap:6px;width:100%}
  .pill{background:#232833;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px}
  .pill span{color:var(--dim)}
  main{flex:1;overflow-y:auto;padding:8px 14px}
  .line{display:grid;grid-template-columns:auto auto auto 1fr;gap:0 10px;padding:4px 0;border-bottom:1px solid #161920;align-items:baseline}
  .t{color:var(--dim);font-size:12px}
  .badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:0 5px;border-radius:3px;border:1px solid var(--line);color:var(--dim)}
  .badge.dm{color:#f5c76b;border-color:#5a4a22}.badge.system{color:#8be28b;border-color:#2b5a2b}
  .who{font-weight:600;max-width:28ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .text{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  .missed{color:var(--dim);font-size:11px;margin-left:6px}
  .system .text{color:#8be28b}
  footer{display:flex;gap:8px;padding:10px 14px;background:var(--panel);border-top:1px solid var(--line)}
  input{flex:1;min-width:0;background:#0b0d11;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font:inherit}
  button{background:var(--accent);color:#0b0d11;border:0;border-radius:6px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
  button:disabled,input:disabled{opacity:.45;cursor:not-allowed}
  @media (max-width:640px){.line{grid-template-columns:auto auto 1fr}.who{grid-column:1/-1}}
</style></head>
<body>
<header>
  <h1 id="room"></h1>
  <div class="me" id="me"></div>
  <div id="members"><span class="pill"><span>loading members…</span></span></div>
</header>
<main id="log"></main>
<footer>
  <input id="text" placeholder="say something in the room… (Enter sends)" disabled autocomplete="off">
  <button id="send" disabled>Send</button>
</footer>
<script>
  const cfg = __CONFIG__;
  document.title = 'observer · ' + cfg.room;
  document.getElementById('room').textContent = '#' + cfg.room;
  document.getElementById('me').textContent = cfg.name + ' ' + cfg.address;
  const log = document.getElementById('log'), input = document.getElementById('text'), send = document.getElementById('send');
  const color = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 'hsl(' + (h % 360) + ' 70% 70%)'; };
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  function add(line) {
    const stick = atBottom();
    const row = el('div', 'line ' + line.kind);
    row.appendChild(el('span', 't', new Date(line.ts).toLocaleTimeString([], { hour12: false })));
    row.appendChild(el('span', 'badge ' + line.kind, line.kind === 'room' && line.room !== cfg.room ? line.room : line.kind));
    const who = el('span', 'who', line.from); who.style.color = line.kind === 'system' ? '#8be28b' : color(line.from); row.appendChild(who);
    const text = el('span', 'text', line.text);
    if (line.missed) text.appendChild(el('span', 'missed', '(replayed)'));
    row.appendChild(text);
    log.appendChild(row);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  const es = new EventSource('/events');
  es.onmessage = (e) => add(JSON.parse(e.data));
  es.onerror = () => add({ ts: new Date().toISOString(), from: 'system', room: cfg.room, kind: 'system', text: 'event stream disconnected; reconnecting…', missed: false });
  async function members() {
    try {
      const r = await fetch('/members');
      if (!r.ok) throw new Error(r.status);
      const list = await r.json();
      const box = document.getElementById('members'); box.replaceChildren();
      for (const m of list) {
        const p = el('span', 'pill', m.name);
        p.title = m.address; p.style.color = color(m.name);
        box.appendChild(p);
      }
      input.disabled = send.disabled = false;
    } catch { /* not in the room yet; keep the input disabled */ }
  }
  members(); setInterval(members, 20000);
  async function post() {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true;
    try {
      const r = await fetch('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      input.value = '';
    } catch (err) { alert('send failed: ' + err.message); }
    send.disabled = false; input.focus();
  }
  send.onclick = post;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); post(); } });
</script>
</body></html>`;
