/**
 * direct: the four network primitives as a command line WITHOUT the daemon — one XMTP client booted per
 * call (2–47 s). anet falls back to this when the daemon cannot start (formerly swarm/netcli-legacy.ts).
 * (a Claude agent working over ssh, a human, a cron job). Same identity model as everything else:
 * AGENT_HOME holds the key, names.json and the XMTP db; AGENT_NAME is who you are. Every command
 * first replays what arrived since the last call (the cursor lives in AGENT_HOME), so `inbox` is
 * just "connect, replay, listen a little, print". Run with: node packages/relay/dist/direct.js <cmd> ...
 *
 *   direct inbox [--wait S]          print new messages (default: listen 5 s after replay)
 *   direct send <target> <text...>   target = agent name, 0x address, or a room you are in
 *   direct join <room> | leave <room> | members <room> | rooms | whoami
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { Transport, loadOrCreateKeystore, type Inbound } from '@agent-network/core';
import { Resolver, StaticBackend } from '@agent-network/resolver';

const name = process.env.AGENT_NAME;
if (!process.env.AGENT_HOME || !name) {
  console.error('anet: AGENT_HOME and AGENT_NAME must be set');
  process.exit(2);
}
const [cmd = 'inbox', ...rest] = process.argv.slice(2);
const env = (process.env.XMTP_ENV ?? 'dev') as XmtpEnv;
const keystore = loadOrCreateKeystore();
const namesPath = join(keystore.home, 'names.json');
const names = new StaticBackend(existsSync(namesPath) ? JSON.parse(readFileSync(namesPath, 'utf8')) : {});
names.set(name, keystore.address);
const resolver = new Resolver({ backends: [names], ttlMs: 10_000 });
const keeperName = process.env.KEEPER_ADDRESS ?? 'keeper';

const inbound: Inbound[] = [];
const transport = await Transport.start({ keystore, env, onInbound: (m) => { inbound.push(m); } });

const flag = (f: string, dflt: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? dflt : dflt; };
const args = rest.filter((a, i) => !(a.startsWith('--') || (i > 0 && rest[i - 1].startsWith('--'))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keeper = async () => {
  const k = await resolver.resolve(keeperName);
  if (!k) throw new Error(`keeper "${keeperName}" does not resolve; add it to ${namesPath} or set KEEPER_ADDRESS`);
  return k.address;
};

let out: unknown = undefined;
try {
  switch (cmd) {
    case 'inbox': {
      await sleep(Number(flag('--wait', '5')) * 1000);
      break;
    }
    case 'send': {
      const [target, ...words] = args;
      const text = words.join(' ').trim();
      if (!target || !text) throw new Error('usage: send <target> <text...>');
      const room = await transport.findRoom(target);
      if (room) { await transport.sendToGroup(room, text); out = { ok: true, to: `room:${room.name}` }; break; }
      const who = await resolver.resolve(target);
      if (!who) throw new Error(`"${target}" is neither a room you are in nor a known agent name`);
      if (!(await transport.canMessage(who.address))) throw new Error(`${who.name} has no inbox on the network`);
      await transport.sendDm(who.address, text);
      out = { ok: true, to: who.name };
      await sleep(1500);
      break;
    }
    case 'join': {
      const room = args[0]; if (!room) throw new Error('usage: join <room>');
      if (await transport.findRoom(room)) { out = { ok: true, note: `already in ${room}` }; break; }
      await transport.sendDm(await keeper(), `join ${room.trim()}`);
      await sleep(Number(flag('--wait', '8')) * 1000);
      out = { ok: Boolean(await transport.findRoom(room)), note: `asked the keeper to add you to ${room}` };
      break;
    }
    case 'leave': {
      const room = args[0]; if (!room) throw new Error('usage: leave <room>');
      if (!(await transport.findRoom(room))) throw new Error(`you are not in ${room}`);
      await transport.sendDm(await keeper(), `leave ${room.trim()}`);
      await sleep(3000);
      out = { ok: true };
      break;
    }
    case 'members': {
      const room = args[0]; if (!room) throw new Error('usage: members <room>');
      const group = await transport.findRoom(room);
      if (!group) throw new Error(`you are not in ${room}`);
      const addresses = await transport.memberAddresses(group);
      out = await Promise.all(addresses.map(async (address) => ({ name: await resolver.label(address), address, you: address.toLowerCase() === keystore.address.toLowerCase() })));
      break;
    }
    case 'rooms': {
      out = (await transport.groups()).map((g) => g.name ?? '(unnamed)');
      break;
    }
    case 'whoami': {
      out = { name, address: keystore.address, inboxId: transport.inboxId, env, home: keystore.home };
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}" (inbox | send | join | leave | members | rooms | whoami)`);
  }
} catch (err) {
  console.error(`anet: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

for (const m of inbound) {
  const who = await resolver.label(m.from);
  const where = m.room ? `#${m.room}` : 'dm';
  console.log(`[${m.sentAt.toISOString()}] ${who} ${where}${m.missed ? ' (while away)' : ''}: ${m.text}`);
}
if (inbound.length === 0 && cmd === 'inbox') console.log('(no new messages)');
if (out !== undefined) console.log(JSON.stringify(out));
await transport.stop();
process.exit(process.exitCode ?? 0);
