/**
 * MCP mode: two `agent-network-mcp` server processes (fresh identities, a shared names.json,
 * no keeper) driven by the SDK's Client over stdio, on the real XMTP dev network.
 *   A lists the five tools, reads agent://self, sends to "b"; B's wait returns it from "a";
 *   B replies; A's wait returns it from "b".
 * Needs `npm run build` first (spawns node on packages/mcp/dist/main.js).
 */
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = resolve(import.meta.dirname, '../packages/mcp/dist/main.js');
// Generous until-timeouts: the dev network is usually ~1 s but is a real shared network.
const CALL = { timeout: 120_000 };
const WAIT = 90;

type Message = { from: string; room: string | null; text: string; sentAt: string };
const parse = <T>(result: { content?: unknown }): T => {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first.text) as T;
};

let tmp: string;
const agents: Record<'a' | 'b', { home: string; address: `0x${string}`; client: Client }> = {} as never;

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error(`${SERVER} missing — run \`npm run build\` first`);
  tmp = mkdtempSync(join(tmpdir(), 'agent-network-mcp-'));
  // Two fresh identities, written where loadOrCreateKeystore() looks, so both names are known up front.
  const keys = { a: generatePrivateKey(), b: generatePrivateKey() };
  const names: Record<string, string> = {};
  for (const name of ['a', 'b'] as const) {
    const home = join(tmp, name);
    mkdirSync(home);
    writeFileSync(join(home, 'key'), keys[name]);
    chmodSync(join(home, 'key'), 0o600);
    names[name] = privateKeyToAccount(keys[name]).address;
  }
  for (const name of ['a', 'b'] as const) {
    const home = join(tmp, name);
    writeFileSync(join(home, 'names.json'), JSON.stringify(names));
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const client = new Client({ name: `test-${name}`, version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...env, AGENT_HOME: home, AGENT_NAME: name, XMTP_ENV: 'dev' },
        stderr: 'pipe',
      }),
    );
    agents[name] = { home, address: names[name] as `0x${string}`, client };
  }
});

afterAll(async () => {
  await Promise.all(Object.values(agents).map((a) => a.client.close()));
  rmSync(tmp, { recursive: true, force: true });
});

describe('mcp mode', () => {
  it('exposes the four primitives plus wait, and knows who it is', async () => {
    const { tools } = await agents.a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['join', 'leave', 'members', 'send', 'wait']);

    // agent://self awaits the Transport, so reading it on both also means both inboxes exist.
    for (const name of ['a', 'b'] as const) {
      const { contents } = await agents[name].client.readResource({ uri: 'agent://self' }, CALL);
      const self = JSON.parse((contents[0] as { text: string }).text) as Record<string, unknown>;
      expect(self).toMatchObject({ name, address: agents[name].address, env: 'dev' });
      expect(self.inboxId).toMatch(/^[0-9a-f]{64}$/);
      expect(self.names).toEqual({ a: agents.a.address, b: agents.b.address });
    }
  });

  it('A sends to b; B waits and gets it from a; B replies; A waits and gets it from b', async () => {
    const sent = parse<{ ok: boolean; to: string; note: string }>(
      await agents.a.client.callTool({ name: 'send', arguments: { target: 'b', text: 'are you free thursday?' } }, undefined, CALL),
    );
    expect(sent).toMatchObject({ ok: true, to: 'b' });
    expect(sent.note).toContain('wait');

    const got = parse<{ messages: Message[] }>(
      await agents.b.client.callTool({ name: 'wait', arguments: { timeoutSeconds: WAIT } }, undefined, CALL),
    );
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]).toMatchObject({ from: 'a', room: null, text: 'are you free thursday?' });
    expect(new Date(got.messages[0].sentAt).getTime()).toBeGreaterThan(0);

    parse<{ ok: boolean }>(
      await agents.b.client.callTool({ name: 'send', arguments: { target: 'a', text: 'free after 2pm' } }, undefined, CALL),
    );
    const reply = parse<{ messages: Message[] }>(
      await agents.a.client.callTool({ name: 'wait', arguments: { timeoutSeconds: WAIT } }, undefined, CALL),
    );
    expect(reply.messages.map((m) => [m.from, m.text])).toEqual([['b', 'free after 2pm']]);

    // Nothing else queued: a short wait times out with an empty list.
    const empty = parse<{ messages: Message[] }>(
      await agents.a.client.callTool({ name: 'wait', arguments: { timeoutSeconds: 1 } }, undefined, CALL),
    );
    expect(empty.messages).toEqual([]);

    // An unknown target is a readable error, not a crash.
    const bad = await agents.a.client.callTool({ name: 'send', arguments: { target: 'nobody', text: 'hi' } }, undefined, CALL);
    expect(parse<{ ok: boolean }>(bad).ok).toBe(false);
  }, 300_000);
});
