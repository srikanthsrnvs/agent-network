/**
 * The three definition-of-done scenarios from the spec (§7), on the real XMTP dev
 * network with ephemeral in-memory agents — transport + keeper only, no LLM:
 *   1. Alice messages Bob while Bob's device is asleep; Bob wakes and has it.
 *   2. A third agent joins a room via the keeper; all three converse.
 *   3. Alice goes offline, misses messages, comes back and has everything in order.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex, type Hex } from 'viem';
import { Resolver, StaticBackend } from '@agent-network/resolver';
import { Transport, createTools, type Inbound, type Keystore } from '@agent-network/client';
import { Keeper } from '@agent-network/keeper';

const ENV = 'dev' as const;

function ephemeralKeystore(home: string): Keystore {
  const privateKey = generatePrivateKey();
  return {
    home,
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    dbEncryptionKey: keccak256(stringToHex(`test/${privateKey}`)),
  };
}

async function until<T>(probe: () => T | undefined | null | false, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting');
}

let tmp: string;
let keeper: Keeper;
const keeperKey: Hex = generatePrivateKey();
const alice = ephemeralKeystore('');
const bob = ephemeralKeystore('');
const carol = ephemeralKeystore('');
const names = new StaticBackend({});
const resolver = new Resolver({ backends: [names] });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-network-'));
  for (const k of [alice, bob, carol]) k.home = mkdtempSync(join(tmp, 'agent-'));
  names.set('alice.agent.eth', alice.address);
  names.set('bob.agent.eth', bob.address);
  names.set('carol.agent.eth', carol.address);
  keeper = await Keeper.start({ privateKey: keeperKey, env: ENV, home: mkdtempSync(join(tmp, 'keeper-')), dbPath: null });
  names.set('keeper.agent.eth', keeper.address as `0x${string}`);
});

afterAll(async () => {
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('definition of done', () => {
  it('1. Bob is asleep; Alice sends; Bob wakes and has the message', async () => {
    // Bob "unboxes" (creates his inbox) then sleeps: transport started, then stopped.
    const bobFirstBoot = await Transport.start({ keystore: bob, env: ENV, onInbound: () => undefined });
    await bobFirstBoot.stop();

    const aliceInbox: Inbound[] = [];
    const aliceT = await Transport.start({ keystore: alice, env: ENV, onInbound: (m) => void aliceInbox.push(m) });
    const aliceTools = createTools({ transport: aliceT, resolver, keeper: 'keeper.agent.eth' });
    const sent = await aliceTools.send.execute!(
      { target: 'bob.agent.eth', text: 'are you free thursday?' },
      { toolCallId: 't1', messages: [] },
    );
    expect(sent).toMatchObject({ ok: true, to: 'bob.agent.eth' });

    // Bob wakes: boot replays what he missed.
    const bobInbox: Inbound[] = [];
    const bobT = await Transport.start({ keystore: bob, env: ENV, onInbound: (m) => void bobInbox.push(m) });
    const got = await until(() => bobInbox.find((m) => m.text === 'are you free thursday?'));
    expect(got.from.toLowerCase()).toBe(alice.address.toLowerCase());
    expect(got.room).toBeNull();

    // and Bob replies the same way; Alice gets it live.
    const bobTools = createTools({ transport: bobT, resolver, keeper: 'keeper.agent.eth' });
    await bobTools.send.execute!({ target: 'alice.agent.eth', text: 'free after 2pm' }, { toolCallId: 't2', messages: [] });
    await until(() => aliceInbox.find((m) => m.text === 'free after 2pm'));

    await aliceT.stop();
    await bobT.stop();
  });

  it('2. a third agent joins a room via the keeper and all three converse', async () => {
    const inboxes = { alice: [] as Inbound[], bob: [] as Inbound[], carol: [] as Inbound[] };
    const joined = { alice: false, bob: false, carol: false };
    const start = (key: 'alice' | 'bob' | 'carol', ks: Keystore) =>
      Transport.start({
        keystore: ks,
        env: ENV,
        onInbound: (m) => void inboxes[key].push(m),
        onJoined: () => void (joined[key] = true),
      });
    const [aT, bT, cT] = await Promise.all([start('alice', alice), start('bob', bob), start('carol', carol)]);
    const tools = {
      alice: createTools({ transport: aT, resolver, keeper: 'keeper.agent.eth' }),
      bob: createTools({ transport: bT, resolver, keeper: 'keeper.agent.eth' }),
      carol: createTools({ transport: cT, resolver, keeper: 'keeper.agent.eth' }),
    };
    const ctx = { toolCallId: 'x', messages: [] };

    await tools.alice.join.execute!({ room: 'trip-planning' }, ctx);
    await until(() => joined.alice);
    await tools.bob.join.execute!({ room: 'trip-planning' }, ctx);
    await until(() => joined.bob);
    await tools.carol.join.execute!({ room: 'trip-planning' }, ctx);
    await until(() => joined.carol);

    const roster = (await tools.carol.members.execute!({ room: 'trip-planning' }, ctx)) as {
      ok: boolean;
      members: Array<{ name: string }>;
    };
    expect(roster.ok).toBe(true);
    const memberNames = roster.members.map((m) => m.name).sort();
    expect(memberNames).toEqual(expect.arrayContaining(['alice.agent.eth', 'bob.agent.eth', 'carol.agent.eth']));

    await tools.carol.send.execute!({ target: 'trip-planning', text: 'hi all, carol here — what dates?' }, ctx);
    await until(() => inboxes.alice.find((m) => m.room === 'trip-planning' && m.text.includes('carol here')));
    await until(() => inboxes.bob.find((m) => m.room === 'trip-planning' && m.text.includes('carol here')));

    await tools.bob.send.execute!({ target: 'trip-planning', text: 'the 14th works for me' }, ctx);
    await until(() => inboxes.carol.find((m) => m.text.includes('14th')));

    await Promise.all([aT.stop(), bT.stop(), cT.stop()]);
  });

  it('3. Alice is offline for a while, comes back, and has everything in order', async () => {
    const bobT = await Transport.start({ keystore: bob, env: ENV, onInbound: () => undefined });
    // Alice is offline: her transport is not running. Bob sends three messages.
    for (const text of ['first', 'second', 'third']) await bobT.sendDm(alice.address, `while you were away: ${text}`);

    const aliceInbox: Inbound[] = [];
    const aliceT = await Transport.start({ keystore: alice, env: ENV, onInbound: (m) => void aliceInbox.push(m) });
    await until(() => aliceInbox.filter((m) => m.text.startsWith('while you were away')).length >= 3);
    const missed = aliceInbox.filter((m) => m.text.startsWith('while you were away'));
    expect(missed.map((m) => m.text.split(': ')[1])).toEqual(['first', 'second', 'third']);
    expect(missed.every((m) => m.missed)).toBe(true);

    await Promise.all([aliceT.stop(), bobT.stop()]);
  });
});
