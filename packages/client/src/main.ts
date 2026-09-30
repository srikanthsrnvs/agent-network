/**
 * The device client. Boot: key → XMTP inbox → catch up → stream. The owner talks to
 * their agent on stdin; the agent talks to the network with four tools.
 *
 *   OPENROUTER_API_KEY=… AGENT_NAME=alice KEEPER_ADDRESS=0x… npm run client
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { EnsBackend, Resolver, StaticBackend } from '@agent-network/resolver';
import { loadOrCreateKeystore } from './keystore.js';
import { Transport } from './xmtp.js';
import { createTools } from './tools.js';
import { AgentLoop } from './loop.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return v;
};

const keystore = loadOrCreateKeystore();
const name = process.env.AGENT_NAME ?? keystore.address;
const env = (process.env.XMTP_ENV ?? 'dev') as XmtpEnv;

// Names: a local contacts file now (name → address); ENS once we own the parent domain.
const contactsPath = join(keystore.home, 'names.json');
const contacts = new StaticBackend(existsSync(contactsPath) ? JSON.parse(readFileSync(contactsPath, 'utf8')) : {});
contacts.set(name, keystore.address);
const resolver = new Resolver({
  backends: process.env.ENS_RPC_URL ? [contacts, new EnsBackend(process.env.ENS_RPC_URL)] : [contacts],
});

const openrouter = createOpenRouter({ apiKey: need('OPENROUTER_API_KEY') });
const model = openrouter(process.env.AGENT_MODEL ?? 'anthropic/claude-sonnet-4.6');

let loop: AgentLoop;
const transport = await Transport.start({
  keystore,
  env,
  onInbound: (msg) => loop.fromNetwork(msg),
  onJoined: (group) => console.log(`[network] you are now in room "${group.name}"`),
});

const tools = createTools({ transport, resolver, keeper: need('KEEPER_ADDRESS') });
loop = new AgentLoop({
  model,
  tools,
  resolver,
  systemPrompt: [
    `You are ${name}, a personal agent running on your owner's device. Your address is ${keystore.address}.`,
    'You talk to other agents on the network with send/join/leave/members. Messages arrive in your',
    'context tagged [network] (from other agents) or [owner] (your owner at the keyboard).',
    'Reply to agents by sending to them; reply to your owner by just answering. Use judgment about',
    'strangers: you may ignore, ask your owner, or answer — nothing forces a reply.',
    process.env.AGENT_INSTRUCTIONS ? `Owner's standing instructions: ${process.env.AGENT_INSTRUCTIONS}` : '',
  ].join(' '),
  onSay: (text) => console.log(`\n${name}: ${text}\n`),
  log: (line) => process.env.AGENT_DEBUG && console.log(`  · ${line}`),
});

console.log(`${name} is online — ${keystore.address} on xmtp:${env}. Type to talk to your agent.`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
rl.prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (text) void loop.fromOwner(text).finally(() => rl.prompt());
  else rl.prompt();
});
rl.on('close', () => void transport.stop().then(() => process.exit(0)));
