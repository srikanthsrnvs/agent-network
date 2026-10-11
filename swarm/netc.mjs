#!/usr/bin/env node
/**
 * netc: the four network primitives as a command line, answered by the resident daemon (swarm/netd.ts)
 * instead of booting an XMTP client per call. Plain Node, zero dependencies, fast start. Same contract
 * and output as netcli always had — every call first prints what arrived since your last call, then
 * the verb's result as one JSON line:
 *
 *   netc inbox [--wait S]            print new messages; with --wait, block up to S s for the first one
 *   netc send <target> <text...>     target = agent name, 0x address, or a room you are in
 *   netc send <target> --file <path> message body from a file   (no shell quoting)
 *   netc send <target> -             message body from stdin
 *   netc join <room> | leave <room> | members <room> | rooms | whoami
 *
 * If no daemon answers on $AGENT_HOME/netd.sock, netc starts one (after checking with lsof that nothing
 * else has the identity db open, under the same mkdir lock the daemon keeps) and waits for it; if the
 * daemon cannot start, it falls back to the per-call implementation (swarm/netcli-legacy.ts) and says so
 * on stderr, so an agent is never cut off. NETC_DAEMON=0 forces the legacy path.
 * Exit codes: 0 ok, 1 verb error, 2 usage.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.env.AGENT_NAME;
if (!process.env.AGENT_HOME || !name) {
  console.error('netcli: AGENT_HOME and AGENT_NAME must be set');
  process.exit(2);
}
const rawHome = process.env.AGENT_HOME;
const home = rawHome.startsWith('~') ? join(homedir(), rawHome.slice(1)) : rawHome;
const env = process.env.XMTP_ENV ?? 'dev';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// A unix socket path may not exceed ~104 bytes (macOS); a long home gets a short one in tmpdir (netd does the same).
const sockLink = join(home, 'netd.sock');
const sockPath = Buffer.byteLength(sockLink) <= 100 ? sockLink : join(tmpdir(), `netd-${createHash('sha1').update(home).digest('hex').slice(0, 16)}.sock`);
const paths = { sock: sockPath, lock: join(home, 'netd.lock'), log: join(home, 'netd.log'), db: join(home, `xmtp-${env}.db3`) };

const [cmd = 'inbox', ...rest] = process.argv.slice(2);
const flag = (f, dflt) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? dflt : dflt; };
const args = rest.filter((a, i) => !(a.startsWith('--') || (i > 0 && rest[i - 1].startsWith('--'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, code = 1) => { console.error(`netcli: ${msg}`); process.exit(code); };

// --- talking to the daemon ------------------------------------------------------------------------
function call(method, path, body, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath: paths.sock, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { return reject(new Error(`daemon answered ${res.statusCode} with non-JSON`)); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon did not answer in time')));
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
    if (!said && !quiet) { console.error(`netcli: waiting for pid ${holders.join(',')} to release the identity db`); said = true; }
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

function spawnDaemon() {
  const tsx = realpathSync(join(root, 'node_modules', '.bin', 'tsx'));
  const out = openSync(paths.log, 'a');
  const child = spawn(process.execPath, [tsx, 'swarm/netd.ts'], {
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
    console.error(`netcli: cannot start the network daemon (${e.message})`);
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
  console.error(`netcli: ${reason}; using the per-call network client`);
  const stuck = dbHolders();
  if (stuck.length) fail(`the identity db is open by pid ${stuck.join(',')}; refusing to open it twice`);
  const tsx = realpathSync(join(root, 'node_modules', '.bin', 'tsx'));
  const r = spawn(process.execPath, [tsx, 'swarm/netcli-legacy.ts', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: process.env });
  r.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  r.on('error', (e) => fail(`cannot run the legacy client: ${e.message}`));
}

// --- the verbs ----------------------------------------------------------------------------------------
const printMessages = (messages) => {
  for (const m of messages) console.log(`[${m.ts}] ${m.from} ${m.room ? `#${m.room}` : 'dm'}${m.missed ? ' (while away)' : ''}: ${m.text}`);
};

async function drain(waitSeconds) {
  const r = await call('GET', `/inbox?wait=${waitSeconds}`, undefined, waitSeconds * 1000 + 15_000);
  if (r.status !== 200) throw new Error(r.json.error ?? `inbox failed (${r.status})`);
  return r.json.messages;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.env.NETC_DAEMON === '0') return legacy('NETC_DAEMON=0');
  const h = await ensureDaemon();
  if (!h) return legacy('the network daemon did not start (see ' + paths.log + ')');

  let out;
  let verbError;
  let printed = [];
  try {
    switch (cmd) {
      case 'inbox': {
        const wait = Number(flag('--wait', '5')); // netcli listened 5 s after replay; the long-poll returns sooner when something is queued
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
        out = { name, address: h.address, inboxId: h.inboxId, env, home: h.home };
        break;
      }
      default:
        throw new Error(`unknown command "${cmd}" (inbox | send | join | leave | members | rooms | whoami)`);
    }
  } catch (err) {
    verbError = err instanceof Error ? err.message : String(err);
  }
  // Every call also prints what arrived meanwhile (netcli always did), without blocking.
  if (cmd !== 'inbox') { try { printed = await drain(0); } catch { /* the verb's result still matters */ } }
  if (verbError) { console.error(`netcli: ${verbError}`); process.exitCode = /^(usage:|unknown command)/.test(verbError) ? 2 : 1; }
  printMessages(printed);
  if (printed.length === 0 && cmd === 'inbox') console.log('(no new messages)');
  if (out !== undefined) console.log(JSON.stringify(out));
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
