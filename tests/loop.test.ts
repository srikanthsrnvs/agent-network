/**
 * The whole thing end to end with a real model: two agents, each with its own context
 * and the four tools. Alice's owner asks her to check with Bob; the message is pushed
 * into Bob's context and his agent answers on its own; Alice reports back.
 * Skipped without OPENROUTER_API_KEY (costs a few cents).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex } from 'viem';
import { Resolver, StaticBackend } from '@agent-network/resolver';
import { AgentLoop, Transport, createTools, type Inbound, type Keystore } from '@agent-network/client';
import { Keeper } from '@agent-network/keeper';

const apiKey = process.env.OPENROUTER_API_KEY;
const modelId = process.env.AGENT_MODEL ?? 'anthropic/claude-sonnet-4.6';
const ENV = 'dev' as const;

function ephemeralKeystore(home: string): Keystore {
  const privateKey = generatePrivateKey();
  return { home, privateKey, address: privateKeyToAccount(privateKey).address, dbEncryptionKey: keccak256(stringToHex(privateKey)) };
}

async function until<T>(probe: () => T | undefined | null | false, ms = 150_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting');
}

interface Side {
  transport: Transport;
  loop: AgentLoop;
  inbound: Inbound[];
  toolCalls: string[];
  said: string[];
}

describe.skipIf(!apiKey)('model loop end to end', () => {
  let tmp: string;
  let keeper: Keeper;
  const names = new StaticBackend({});
  const resolver = new Resolver({ backends: [names] });
  const sides: Side[] = [];

  async function boot(name: string, keystore: Keystore, instructions: string): Promise<Side> {
    const side = { inbound: [], toolCalls: [], said: [] } as unknown as Side;
    side.transport = await Transport.start({
      keystore,
      env: ENV,
      onInbound: (m) => {
        side.inbound.push(m);
        return side.loop.fromNetwork(m);
      },
    });
    const openrouter = createOpenRouter({ apiKey });
    side.loop = new AgentLoop({
      model: openrouter(modelId),
      tools: createTools({ transport: side.transport, resolver, keeper: 'keeper.agent.eth' }),
      resolver,
      systemPrompt:
        `You are ${name}, a personal agent. Your address is ${keystore.address}. Messages tagged [network] come from other ` +
        `agents; reply to them with the send tool. Messages tagged [owner] come from your owner; answer them directly. ${instructions}`,
      onSay: (t) => side.said.push(t),
      log: (line) => {
        if (line.startsWith('  tool ')) side.toolCalls.push(line.trim());
      },
    });
    sides.push(side);
    return side;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-network-loop-'));
    keeper = await Keeper.start({ privateKey: generatePrivateKey(), env: ENV, home: mkdtempSync(join(tmp, 'keeper-')), dbPath: null });
    names.set('keeper.agent.eth', keeper.address as `0x${string}`);
  });

  afterAll(async () => {
    await Promise.all(sides.map((s) => s.transport.stop()));
    await keeper?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('alice asks bob a question through the network and reports his answer to her owner', async () => {
    const aliceKs = ephemeralKeystore(mkdtempSync(join(tmp, 'alice-')));
    const bobKs = ephemeralKeystore(mkdtempSync(join(tmp, 'bob-')));
    names.set('alice.agent.eth', aliceKs.address);
    names.set('bob.agent.eth', bobKs.address);

    const bob = await boot('bob.agent.eth', bobKs, 'Standing instruction from your owner: they are free on Thursday after 2pm; answer scheduling questions directly, in one short sentence.');
    const alice = await boot('alice.agent.eth', aliceKs, '');

    const reply = await alice.loop.fromOwner('Ask bob.agent.eth whether he is free on Thursday afternoon. When he answers, tell me what he said.');
    expect(alice.toolCalls.some((c) => c.startsWith('tool send(') && c.includes('bob.agent.eth'))).toBe(true);
    expect(reply.length).toBeGreaterThan(0);
    const saidBeforeAnswer = alice.said.length;

    // Bob's agent gets the question pushed into its context and answers by itself.
    await until(() => bob.inbound.find((m) => m.from.toLowerCase() === aliceKs.address.toLowerCase()));
    await until(() => bob.toolCalls.find((c) => c.startsWith('tool send(') && c.includes('alice.agent.eth')));

    // Alice receives the answer (pushed into her context) and relays it to her owner.
    const answer = await until(() => alice.inbound.find((m) => m.from.toLowerCase() === bobKs.address.toLowerCase()));
    expect(answer.text).toMatch(/free|2\s?pm/i);
    const relayed = await until(() => alice.said.slice(saidBeforeAnswer).find((t) => /free|2\s?pm/i.test(t)));
    expect(relayed).toBeTruthy();
  });
});
