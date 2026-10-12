#!/usr/bin/env node
/**
 * anet: the four network primitives as a command line, answered by the resident daemon
 * (packages/relay/dist/daemon.js) instead of booting an XMTP client per call. Plain Node, zero runtime
 * dependencies, fast start. Every call first prints what arrived since your last call, then the verb's
 * result as one JSON line:
 *
 *   anet init <name>                 create AGENT_HOME (default ~/.agent-network), the key and an empty names.json; print the address
 *   anet inbox [--wait S]            print new messages; with --wait, block up to S s for the first one
 *   anet send <target> <text...>     target = agent name, 0x address, or a room you are in
 *   anet send <target> --file <path> message body from a file   (no shell quoting)
 *   anet send <target> -             message body from stdin
 *   anet join <room> | leave <room> | members <room> | rooms | whoami
 *   anet daemon [stop]               make sure the daemon runs (prints its health) / stop it
 *   anet relay [--home H] [--listen host:port] [--socket path]   serve a relay (N identities behind bearer tokens)
 *   anet relay add-identity <name> [--home H]                   create RELAY_HOME/identities/<name> and its token
 *   anet relay list [--home H]                                  the relay's identities (name, address)
 *
 * Identity: AGENT_HOME (key, names.json, XMTP db, daemon files) and AGENT_NAME (falls back to the name
 * `anet init` wrote in $AGENT_HOME/name). If no daemon answers on $AGENT_HOME/netd.sock, anet starts one
 * (after checking with lsof that nothing else has the identity db open, under the same mkdir lock the
 * daemon keeps) and waits for it; if the daemon cannot start, it falls back to the per-call implementation
 * (packages/relay/dist/direct.js) and says so on stderr, so an agent is never cut off. ANET_DAEMON=0
 * forces that path. Needs `npm run build` once (the daemon is compiled TypeScript).
 *
 * Relay mode: with AGENTNET_URL and AGENTNET_TOKEN set (or ANET_URL/ANET_TOKEN), every verb is the same
 * request to $AGENTNET_URL/v1/<verb> with `Authorization: Bearer <token>` — no daemon, no identity on this
 * machine; the relay holds it (see docs/relay.md). `init` and `relay` are the two verbs that ignore it.
 * Exit codes: 0 ok, 1 verb error, 2 usage.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fail = (msg, code = 1) => { console.error(`anet: ${msg}`); process.exit(code); };
const [cmd = 'inbox', ...rest] = process.argv.slice(2);
const rawHome = process.env.AGENT_HOME ?? '~/.agent-network';
const home = rawHome.startsWith('~') ? join(homedir(), rawHome.slice(1)) : rawHome;

// --- init: the one verb that needs no daemon and no name in the environment ----------------------------
if (cmd === 'init') {
  const initName = rest[0];
  if (!initName || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(initName)) fail('usage: init <name>   (AGENT_HOME selects where; default ~/.agent-network)', 2);
  const keystoreModule = join(root, 'packages', 'core', 'dist', 'keystore.js');
  if (!existsSync(keystoreModule)) fail(`${keystoreModule} is missing; run \`npm run build\` first`);
  const { loadOrCreateKeystore } = await import(pathToFileURL(keystoreModule).href);
  const ks = loadOrCreateKeystore(home);
  const namesPath = join(home, 'names.json');
  if (!existsSync(namesPath)) writeFileSync(namesPath, '{}\n');
  writeFileSync(join(home, 'name'), `${initName}\n`);
  console.log(JSON.stringify({ name: initName, address: ks.address, home }));
  process.exit(0);
}

const VERSION = (() => { try { return JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')).version ?? '0'; } catch { return '0'; } })();
const flag = (f, dflt) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? dflt : dflt; };
const args = rest.filter((a, i) => !(a.startsWith('--') || (i > 0 && rest[i - 1].startsWith('--'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- relay: serve, add-identity, list (operator side; see docs/relay.md) -------------------------------------
if (cmd === 'relay') {
  const rawRelayHome = flag('--home', process.env.RELAY_HOME ?? '~/relay');
  const relayHome = rawRelayHome.startsWith('~') ? join(homedir(), rawRelayHome.slice(1)) : resolve(rawRelayHome);
  const tokensPath = join(relayHome, 'tokens.json');
  const readTokens = () => { try { return JSON.parse(readFileSync(tokensPath, 'utf8')); } catch { return {}; } };
  const keystoreModule = join(root, 'packages', 'core', 'dist', 'keystore.js');
  if (!existsSync(keystoreModule)) fail(`${keystoreModule} is missing; run \`npm run build\` first`);
  const sub = args[0];
  if (sub === 'add-identity') {
    const idName = args[1];
    if (!idName || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(idName) || idName === '_admin') fail('usage: relay add-identity <name> [--home RELAY_HOME]', 2);
    const { loadOrCreateKeystore } = await import(pathToFileURL(keystoreModule).href);
    mkdirSync(join(relayHome, 'tokens'), { recursive: true, mode: 0o700 });
    const ks = loadOrCreateKeystore(join(relayHome, 'identities', idName));
    for (const d of [join(relayHome, 'tokens'), join(relayHome, 'identities'), ks.home]) { try { chmodSync(d, 0o700); } catch { /* not ours to tighten */ } }
    const tokens = readTokens();
    const tokenFile = join(relayHome, 'tokens', `${idName}.token`);
    let token = Object.keys(tokens).find((t) => tokens[t] === idName);
    if (!token) {
      token = randomBytes(24).toString('hex');
      tokens[token] = idName;
      writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
      chmodSync(tokensPath, 0o600);
    }
    writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    if (!existsSync(join(relayHome, 'names.json'))) writeFileSync(join(relayHome, 'names.json'), '{}\n');
    console.log(JSON.stringify({ name: idName, address: ks.address, tokenFile }));
    process.exit(0);
  }
  if (sub === 'list') {
    const { loadOrCreateKeystore } = await import(pathToFileURL(keystoreModule).href);
    const dir = join(relayHome, 'identities');
    const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
    const byName = new Set(Object.values(readTokens()));
    console.log(JSON.stringify(names.map((n) => ({ name: n, address: loadOrCreateKeystore(join(dir, n)).address, token: byName.has(n) }))));
    process.exit(0);
  }
  if (sub !== undefined) fail('usage: relay [--home H] [--listen host:port] [--socket path] | relay add-identity <name> | relay list', 2);
  const RELAY = join(root, 'packages', 'relay', 'dist', 'relay.js');
  if (!existsSync(RELAY)) fail(`${RELAY} is missing; run \`npm run build\` first`);
  if (!rest.includes('--listen') && !rest.includes('--socket')) rest.push('--socket', join(relayHome, 'relay.sock'));
  // relay.js reads --home/--listen/--socket from argv; it runs in the foreground as our child (same stdio, same signals).
  const child = spawn(process.execPath, [RELAY, ...rest], { cwd: root, stdio: 'inherit', env: { ...process.env, RELAY_HOME: relayHome } });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (e) => fail(`cannot start the relay: ${e.message}`));
  await new Promise(() => undefined); // the child owns the process from here; its exit ends ours
}

// --- relay client mode: AGENTNET_URL + AGENTNET_TOKEN ---------------------------------------------------------
const relayUrl = (process.env.AGENTNET_URL ?? process.env.ANET_URL ?? '').replace(/\/+$/, '');
const relayToken = process.env.AGENTNET_TOKEN ?? process.env.ANET_TOKEN;
if (relayUrl && !relayToken) fail('AGENTNET_TOKEN must be set with AGENTNET_URL', 2);

let name = process.env.AGENT_NAME;
if (!name && !relayUrl) { try { name = readFileSync(join(home, 'name'), 'utf8').trim() || undefined; } catch { /* no init here */ } }
if (!name && !relayUrl) fail('AGENT_NAME must be set (or run `anet init <name>` in this AGENT_HOME first)', 2);
process.env.AGENT_HOME = home;
if (name) process.env.AGENT_NAME = name; // the daemon and the direct client inherit both
const env = process.env.XMTP_ENV ?? 'dev';
// A unix socket path may not exceed ~104 bytes (macOS); a long home gets a short one in tmpdir (netd does the same).
const sockLink = join(home, 'netd.sock');
const sockPath = Buffer.byteLength(sockLink) <= 100 ? sockLink : join(tmpdir(), `netd-${createHash('sha1').update(home).digest('hex').slice(0, 16)}.sock`);
const paths = { sock: sockPath, lock: join(home, 'netd.lock'), log: join(home, 'netd.log'), db: join(home, `xmtp-${env}.db3`) };

// --- talking to the daemon (unix socket) or the relay ($AGENTNET_URL/v1, bearer token) -----------------
function call(method, path, body, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'user-agent': `anet/${VERSION}`, accept: 'application/json' };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    let target;
    if (relayUrl) {
      const u = new URL(`${relayUrl}/v1${path}`);
      headers.authorization = `Bearer ${relayToken}`;
      target = { method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers };
    } else {
      target = { socketPath: paths.sock, method, path, headers };
    }
    const req = (relayUrl && relayUrl.startsWith('https:') ? httpsRequest : request)(target, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { return reject(new Error(`${relayUrl ? 'relay' : 'daemon'} answered ${res.statusCode} with non-JSON`)); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${relayUrl ? 'relay' : 'daemon'} did not answer in time`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** {ok:true} when a daemon answers, {booting:true} while it boots, null when nothing listens. */
async function health() {
  if (!existsSync(paths.sock)) return null;
  try {
    const r = await call('GET', '/health', undefined, 3000);
    if (r.status === 200 && r.json.ok) return r.json;
    if (r.status === 503 && r.json.booting) return { booting: true };
    return null;
  } catch {
    return null;
  }
}

// --- single-writer guard and daemon start -----------------------------------------------------------
function dbHolders() {
  const files = [paths.db, `${paths.db}-wal`, `${paths.db}-shm`].filter((f) => existsSync(f));
  if (!files.length) return [];
  try {
    const out = execFileSync('lsof', ['-t', '--', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch (e) {
    if (e.status === 1) return [];
    if (e.status === undefined) return []; // no lsof here: nothing we can check
    return [...new Set(String(e.stdout ?? '').split(/\s+/).filter(Boolean).map(Number))];
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Wait up to 60 s for nobody to have the identity db open. Returns the holders still there after that. */
async function waitForDbFree(quiet = false) {
  const deadline = Date.now() + 60_000;
  let said = false;
  for (;;) {
    const holders = dbHolders();
    if (!holders.length) return [];
    if (Date.now() > deadline) return holders;
    if (!said && !quiet) { console.error(`anet: waiting for pid ${holders.join(',')} to release the identity db`); said = true; }
    await sleep(1000);
  }
}

/** mkdir lock shared with the daemon: true when we took it (and must spawn), false when someone holds it. */
function takeLock() {
  const pidFile = join(paths.lock, 'pid');
  for (;;) {
    try {
      mkdirSync(paths.lock);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = Number(readFileSync(pidFile, 'utf8').trim()); } catch { /* no pid yet */ }
      if (Number.isFinite(pid) && pid > 0 && alive(pid)) return false;
      let age = 0;
      try { age = Date.now() - statSync(paths.lock).mtimeMs; } catch { continue; }
      if (!Number.isFinite(pid) && age < 30_000) return false; // someone is spawning right now
      rmSync(paths.lock, { recursive: true, force: true });   // stale: dead pid or abandoned
    }
  }
}

async function waitForHealth(ms, child) {
  let deadline = Date.now() + ms;
  let extended = false;
  for (;;) {
    const h = await health();
    if (h?.ok) return h;
    if (h?.booting && !extended) { extended = true; deadline = Date.now() + 90_000; } // it is alive and opening XMTP; give it longer
    if (child && child.exitCode !== null) return null; // the daemon we started has already died
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

const DAEMON = join(root, 'packages', 'relay', 'dist', 'daemon.js');
const DIRECT = join(root, 'packages', 'relay', 'dist', 'direct.js');

function spawnDaemon() {
  if (!existsSync(DAEMON)) throw new Error(`${DAEMON} is missing; run \`npm run build\` first`);
  const out = openSync(paths.log, 'a');
  const child = spawn(process.execPath, [DAEMON], {
    cwd: root,
    detached: true,                      // setsid(): survives this process, its shell and docker exec
    stdio: ['ignore', out, out],
    env: { ...process.env, NETD_LOCK_INHERITED: '1' },
  });
  child.unref();
  closeSync(out);
  try { writeFileSync(join(paths.lock, 'pid'), String(child.pid)); } catch { /* the daemon writes it too */ }
  return child;
}

/** Make sure a daemon answers; returns its health, or null when the daemon path is unusable. */
async function ensureDaemon() {
  let h = await health();
  if (h?.ok) return h;
  if (h?.booting) return waitForHealth(90_000);
  const holders = await waitForDbFree();
  if (holders.length) fail(`the identity db ${paths.db} is still open by pid ${holders.join(',')} after 60 s; not opening it twice (kill that pid if it is stuck)`);
  let child;
  try {
    if (takeLock()) child = spawnDaemon();
  } catch (e) {
    console.error(`anet: cannot start the network daemon (${e.message})`);
    return null;
  }
  h = await waitForHealth(45_000, child);
  if (h?.ok) return h;
  if (child) {
    if (child.exitCode === null && alive(child.pid)) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
    await sleep(500);
    try { if (Number(readFileSync(join(paths.lock, 'pid'), 'utf8').trim()) === child.pid) rmSync(paths.lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return null;
}

function legacy(reason) {
  console.error(`anet: ${reason}; using the per-call network client`);
  const stuck = dbHolders();
  if (stuck.length) fail(`the identity db is open by pid ${stuck.join(',')}; refusing to open it twice`);
  if (!existsSync(DIRECT)) fail(`${DIRECT} is missing; run \`npm run build\` first`);
  const r = spawn(process.execPath, [DIRECT, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: process.env });
  r.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  r.on('error', (e) => fail(`cannot run the legacy client: ${e.message}`));
}

// --- the verbs ----------------------------------------------------------------------------------------
const printMessages = (messages) => {
  for (const m of messages) console.log(`[${m.ts}] ${m.from} ${m.room ? `#${m.room}` : 'dm'}${m.missed ? ' (while away)' : ''}: ${m.text}`);
};

async function drain(waitSeconds) {
  // A relay behind a proxy answers early (it caps one poll at 80 s); keep asking until our own deadline.
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const wait = Math.max(Math.min(remaining, 600), 0);
    const t0 = Date.now();
    const r = await call('GET', `/inbox?wait=${wait}`, undefined, wait * 1000 + 15_000);
    if (r.status !== 200) throw new Error(r.json.error ?? `inbox failed (${r.status})`);
    if (r.json.messages.length || wait === 0 || Date.now() - t0 < 1000 || Date.now() >= deadline) return r.json.messages;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (relayUrl && cmd === 'daemon') fail('`anet daemon` runs the local daemon; unset AGENTNET_URL to use it', 2);
  if (cmd === 'daemon') {
    if (rest[0] === 'stop') {
      let pid = NaN;
      try { pid = Number(readFileSync(join(paths.lock, 'pid'), 'utf8').trim()); } catch { /* no lock */ }
      if (!Number.isFinite(pid) || pid <= 0 || !alive(pid)) { console.log(JSON.stringify({ ok: true, note: 'no daemon running' })); process.exit(0); }
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
      console.log(JSON.stringify({ ok: !alive(pid), stopped: pid }));
      process.exit(alive(pid) ? 1 : 0);
    }
    const h = await ensureDaemon();
    if (!h) fail('the network daemon did not start (see ' + paths.log + ')');
    console.log(JSON.stringify(h));
    process.exit(0);
  }
  let h;
  if (relayUrl) {
    const r = await call('GET', '/whoami', undefined, 120_000).catch((e) => { throw new Error(`cannot reach the relay at ${relayUrl}: ${e.message}`); });
    if (r.status !== 200) fail(r.json.error ?? `the relay answered ${r.status}`);
    h = r.json;
    name = h.name;
  } else {
    if (process.env.ANET_DAEMON === '0' || process.env.NETC_DAEMON === '0') return legacy('ANET_DAEMON=0');
    h = await ensureDaemon();
    if (!h) return legacy('the network daemon did not start (see ' + paths.log + ')');
  }

  let out;
  let verbError;
  let printed = [];
  try {
    switch (cmd) {
      case 'inbox': {
        const wait = Number(flag('--wait', '5')); // the direct client listened 5 s after replay; the long-poll returns sooner when something is queued
        if (!Number.isFinite(wait) || wait < 0) throw new Error('--wait takes a number of seconds');
        printed = await drain(Math.min(wait, 600));
        break;
      }
      case 'send': {
        const [target, ...words] = args;
        const file = flag('--file', undefined);
        let text;
        if (file !== undefined) text = readFileSync(file, 'utf8').trim();
        else if (words.length === 1 && words[0] === '-') text = (await readStdin()).trim();
        else text = words.join(' ').trim();
        if (!target || !text) throw new Error('usage: send <target> <text...> | send <target> --file <path> | send <target> -');
        const r = await call('POST', '/send', { target, text }, 60_000);
        if (r.status !== 200) throw new Error(r.json.error ?? `send failed (${r.status})`);
        out = r.json;
        break;
      }
      case 'join': {
        const room = args[0]; if (!room) throw new Error('usage: join <room>');
        const wait = Number(flag('--wait', '8'));
        const r = await call('POST', '/join', { room, wait }, wait * 1000 + 30_000);
        if (r.status !== 200) throw new Error(r.json.error ?? `join failed (${r.status})`);
        out = r.json;
        break;
      }
      case 'leave': {
        const room = args[0]; if (!room) throw new Error('usage: leave <room>');
        const r = await call('POST', '/leave', { room }, 60_000);
        if (r.status !== 200) throw new Error(r.json.error ?? `leave failed (${r.status})`);
        out = r.json;
        break;
      }
      case 'members': {
        const room = args[0]; if (!room) throw new Error('usage: members <room>');
        const r = await call('GET', `/members?room=${encodeURIComponent(room)}`, undefined, 60_000);
        if (r.status !== 200) throw new Error(r.json.error ?? `members failed (${r.status})`);
        out = r.json;
        break;
      }
      case 'rooms': {
        const r = await call('GET', '/rooms', undefined, 60_000);
        if (r.status !== 200) throw new Error(r.json.error ?? `rooms failed (${r.status})`);
        out = r.json;
        break;
      }
      case 'whoami': {
        out = relayUrl ? { name, address: h.address, inboxId: h.inboxId, env: h.env, relay: relayUrl } : { name, address: h.address, inboxId: h.inboxId, env, home: h.home };
        break;
      }
      default:
        throw new Error(`unknown command "${cmd}" (init | inbox | send | join | leave | members | rooms | whoami | daemon | relay)`);
    }
  } catch (err) {
    verbError = err instanceof Error ? err.message : String(err);
  }
  // Every call also prints what arrived meanwhile (the CLI always did), without blocking.
  if (cmd !== 'inbox') { try { printed = await drain(0); } catch { /* the verb's result still matters */ } }
  if (verbError) { console.error(`anet: ${verbError}`); process.exitCode = /^(usage:|unknown command)/.test(verbError) ? 2 : 1; }
  printMessages(printed);
  if (printed.length === 0 && cmd === 'inbox') console.log('(no new messages)');
  if (out !== undefined) console.log(JSON.stringify(out));
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
