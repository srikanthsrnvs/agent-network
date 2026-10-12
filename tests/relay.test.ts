/**
 * The relay on the real XMTP dev network: one relay in-process on a random localhost port, RELAY_HOME in a
 * temp dir, two identities (alice, bob) behind two tokens, a keeper of our own (as tests/dod does).
 *   - alice DMs bob over HTTP; bob's /v1/inbox?wait returns it, labelled "alice"
 *   - alice joins a room via /v1/join, bob joins, alice posts, bob receives it in the room
 *   - /v1/mcp: the SDK client over StreamableHTTPClientTransport with the bearer header lists the five tools,
 *     reads agent://self and receives a DM through `wait`
 *   - no token → 401; the admin token lists identities, an identity token may not
 * Needs `npm run build` first (the relay and its MCP server are compiled TypeScript).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Keeper } from '@agent-network/keeper';
import { startRelay, type Relay } from '@agent-network/relay';

const ENV = 'dev' as const;
const TOKENS = { alice: 'a'.repeat(48), bob: 'b'.repeat(48), admin: 'c'.repeat(48) };
type Message = { ts: string; from: string; room: string | null; text: string; missed: boolean };

let tmp: string;
let keeper: Keeper;
let relay: Relay;
let base: string;
const keeperKey: Hex = generatePrivateKey();

async function api<T = unknown>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'relay-test/0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as T };
}
const inbox = (token: string, wait: number) => api<{ messages: Message[] }>(token, 'GET', `/v1/inbox?wait=${wait}`);

/** Poll the inbox until a message matches (other traffic, e.g. the keeper's confirmations, is drained too). */
async function receive(token: string, match: (m: Message) => boolean, seconds = 90): Promise<Message> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = await inbox(token, Math.min(30, Math.ceil((deadline - Date.now()) / 1000)));
    expect(r.status).toBe(200);
    const hit = r.json.messages.find(match);
    if (hit) return hit;
  }
  throw new Error('timed out waiting for a message');
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-network-relay-'));
  keeper = await Keeper.start({ privateKey: keeperKey, env: ENV, home: mkdtempSync(join(tmp, 'keeper-')), dbPath: null });
  const home = join(tmp, 'relay-home');
  // The operator's two files: who may talk (tokens) and who everybody knows (names). Identities are created on boot.
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'tokens.json'), JSON.stringify({ [TOKENS.alice]: 'alice', [TOKENS.bob]: 'bob', [TOKENS.admin]: '_admin' }), { mode: 0o600 });
  writeFileSync(join(home, 'names.json'), JSON.stringify({ keeper: keeper.address }));
  relay = await startRelay({ home, listen: '127.0.0.1:0', env: ENV, keeperName: keeper.address, behindProxy: false, log: (l) => process.stderr.write(`  relay: ${l}\n`) });
  base = `http://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay?.close();
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('relay', () => {
  it('health is open; /v1 needs a bearer token; whoami names the identity behind the token', async () => {
    const h = await api<{ ok: boolean; env: string; identities: number; maxWait: number }>(null, 'GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ ok: true, env: 'dev', maxWait: 600 });
    expect(h.json.identities).toBe(2);

    expect((await api(null, 'GET', '/v1/whoami')).status).toBe(401);
    expect((await api('x'.repeat(48), 'GET', '/v1/whoami')).status).toBe(401);

    const alice = await api<{ name: string; address: string; inboxId: string; env: string }>(TOKENS.alice, 'GET', '/v1/whoami');
    expect(alice.status).toBe(200);
    expect(alice.json).toMatchObject({ name: 'alice', env: 'dev' });
    expect(alice.json.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(alice.json.inboxId).toMatch(/^[0-9a-f]{64}$/);
    const bob = await api<{ name: string }>(TOKENS.bob, 'GET', '/v1/whoami');
    expect(bob.json.name).toBe('bob');

    // the merged names: both identities and the keeper
    const names = await api<Record<string, string>>(TOKENS.alice, 'GET', '/v1/names');
    expect(Object.keys(names.json).sort()).toEqual(['alice', 'bob', 'keeper']);
    const k = await api<{ name: string; address: string }>(TOKENS.alice, 'GET', '/v1/keeper');
    expect(k.json).toEqual({ name: 'keeper', address: keeper.address });

    // identities: admin only
    expect((await api(TOKENS.alice, 'GET', '/v1/identities')).status).toBe(403);
    const ids = await api<Array<{ name: string; address: string; queued: number }>>(TOKENS.admin, 'GET', '/v1/identities');
    expect(ids.status).toBe(200);
    expect(ids.json.map((i) => i.name).sort()).toEqual(['alice', 'bob']);
    expect((await api(TOKENS.admin, 'GET', '/v1/whoami')).status).toBe(403);
  });

  it('alice DMs bob over HTTP; bob long-polls and gets it from "alice"', async () => {
    const sent = await api<{ ok: boolean; to: string }>(TOKENS.alice, 'POST', '/v1/send', { target: 'bob', text: 'are you free thursday?' });
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ ok: true, to: 'bob' });

    const got = await receive(TOKENS.bob, (m) => m.text === 'are you free thursday?');
    expect(got).toMatchObject({ from: 'alice', room: null });

    // unknown target: the daemon's error text, as a 404
    const bad = await api<{ error: string }>(TOKENS.alice, 'POST', '/v1/send', { target: 'nobody', text: 'hi' });
    expect(bad.status).toBe(404);
    expect(bad.json.error).toContain('neither a room you are in nor a known agent name');
    const empty = await api<{ error: string }>(TOKENS.alice, 'POST', '/v1/send', { target: 'bob' });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe('text (string) required');
  }, 180_000);

  it('alice and bob join a room through the keeper; alice posts; bob receives it in the room', async () => {
    const room = `relay-test-${Date.now().toString(36)}`;
    const a = await api<{ ok: boolean; note: string }>(TOKENS.alice, 'POST', '/v1/join', { room, wait: 60 });
    expect(a.status).toBe(200);
    expect(a.json.ok).toBe(true);
    const b = await api<{ ok: boolean }>(TOKENS.bob, 'POST', '/v1/join', { room, wait: 60 });
    expect(b.json.ok).toBe(true);

    const rooms = await api<string[]>(TOKENS.bob, 'GET', '/v1/rooms');
    expect(rooms.json).toContain(room);
    const members = await api<Array<{ name: string; you: boolean; reachable: boolean }>>(TOKENS.bob, 'GET', `/v1/members?room=${room}`);
    expect(members.status).toBe(200);
    expect(members.json.map((m) => m.name).sort()).toEqual(['alice', 'bob', 'keeper']);
    expect(members.json.find((m) => m.name === 'bob')?.you).toBe(true);

    const post = await api<{ ok: boolean; to: string }>(TOKENS.alice, 'POST', '/v1/send', { target: room, text: 'hi all, alice here' });
    expect(post.json).toEqual({ ok: true, to: `room:${room}` });
    const got = await receive(TOKENS.bob, (m) => m.room === room && m.text === 'hi all, alice here');
    expect(got.from).toBe('alice');

    const notIn = await api<{ error: string }>(TOKENS.alice, 'GET', '/v1/members?room=no-such-room');
    expect(notIn.status).toBe(404);
    expect(notIn.json.error).toBe('you are not in no-such-room');
  }, 240_000);

  it('/v1/mcp: the SDK client with a bearer header lists the five tools, reads agent://self and waits for a DM', async () => {
    const client = new Client({ name: 'relay-test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKENS.alice}`, 'user-agent': 'relay-test/0' } } });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['join', 'leave', 'members', 'send', 'wait']);

      const { contents } = await client.readResource({ uri: 'agent://self' });
      const self = JSON.parse((contents[0] as { text: string }).text) as Record<string, unknown>;
      expect(self).toMatchObject({ name: 'alice', env: 'dev' });
      expect(self.inboxId).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(self.names as object).sort()).toEqual(['alice', 'bob', 'keeper']);

      // bob DMs alice over plain HTTP; alice's MCP `wait` hands it over in the MCP shape
      await api(TOKENS.bob, 'POST', '/v1/send', { target: 'alice', text: 'free after 2pm' });
      const deadline = Date.now() + 90_000;
      let found: { from: string; room: string | null; text: string; sentAt: string } | undefined;
      while (!found && Date.now() < deadline) {
        const r = await client.callTool({ name: 'wait', arguments: { timeoutSeconds: 30 } }, undefined, { timeout: 60_000 });
        const { messages } = JSON.parse((r.content as Array<{ text: string }>)[0].text) as { messages: typeof found[] };
        found = messages.find((m) => m?.text === 'free after 2pm');
      }
      expect(found).toMatchObject({ from: 'bob', room: null, text: 'free after 2pm' });
      expect(new Date(found!.sentAt).getTime()).toBeGreaterThan(0);

      // a refusal is an ordinary {ok:false}
      const bad = await client.callTool({ name: 'send', arguments: { target: 'nobody', text: 'hi' } });
      expect(JSON.parse((bad.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: false });

      // no token → the MCP endpoint is closed too
      const closed = await fetch(`${base}/v1/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'relay-test/0' }, body: '{}' });
      expect(closed.status).toBe(401);
    } finally {
      await client.close();
    }
  }, 240_000);

  it('isolates swarm contacts, routes owner to the scoped address, and preserves other identities', async () => {
    const a = (await api<{ address: string }>(TOKENS.alice, 'GET', '/v1/whoami')).json.address;
    const b = (await api<{ address: string }>(TOKENS.bob, 'GET', '/v1/whoami')).json.address;
    const sharedFile = join(tmp, 'relay-home', 'names.json');
    const original = readFileSync(sharedFile, 'utf8');
    writeFileSync(sharedFile, JSON.stringify({ keeper: keeper.address, owner: a }));
    try {
      expect((await api(TOKENS.alice, 'POST', '/v1/names', { names: { owner: b, worker: b } })).status).toBe(200);
      expect((await api<Record<string, string>>(TOKENS.alice, 'GET', '/v1/names')).json.owner).toBe(b);
      expect((await api<Record<string, string>>(TOKENS.bob, 'GET', '/v1/names')).json.owner).toBe(a);
      expect(JSON.parse(readFileSync(sharedFile, 'utf8')).owner).toBe(a);
      expect((await api(TOKENS.alice, 'POST', '/v1/send', { target: 'owner', text: 'scoped owner request' })).status).toBe(200);
      expect(await receive(TOKENS.bob, m => m.text === 'scoped owner request')).toMatchObject({ from: 'alice', room: null });
      expect((await api(TOKENS.alice, 'POST', '/v1/names', { names: { alice: b } })).status).toBe(400);
      expect((await api(TOKENS.alice, 'POST', '/v1/names', { names: { owner: 'invalid' } })).status).toBe(400);
      expect((await api(null, 'POST', '/v1/names', { names: {} })).status).toBe(401);
    } finally {
      await api(TOKENS.alice, 'POST', '/v1/names', { names: {} });
      writeFileSync(sharedFile, original);
    }
  }, 180_000);

  it('uses an identity-specific keeper for a swarm on another network', async () => {
    const other = await Keeper.start({ privateKey: generatePrivateKey(), env: ENV, home: join(tmp, 'other-keeper'), dbPath: null });
    try {
      await api(TOKENS.bob, 'POST', '/v1/names', { names: { keeper: other.address } });
      expect((await api<{ address: string }>(TOKENS.bob, 'GET', '/v1/keeper')).json.address).toBe(other.address);
      const room = `scoped-${Date.now().toString(36)}`;
      expect((await api<{ ok: boolean }>(TOKENS.bob, 'POST', '/v1/join', { room, wait: 60 })).json.ok).toBe(true);
      expect(other.roomNames()).toContain(room);
      expect(keeper.roomNames()).not.toContain(room);
    } finally {
      await api(TOKENS.bob, 'POST', '/v1/names', { names: {} });
      await other.stop();
    }
  }, 180_000);
});
