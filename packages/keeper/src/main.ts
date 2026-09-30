/** Run the room-keeper:  KEEPER_KEY=0x… XMTP_ENV=dev npm run keeper */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { Keeper } from './keeper.js';

const home = process.env.KEEPER_HOME ?? join(homedir(), '.agent-network-keeper');
mkdirSync(home, { recursive: true });
const keyPath = join(home, 'key');
let privateKey = process.env.KEEPER_KEY as Hex | undefined;
if (!privateKey) {
  if (existsSync(keyPath)) privateKey = readFileSync(keyPath, 'utf8').trim() as Hex;
  else {
    privateKey = generatePrivateKey();
    writeFileSync(keyPath, privateKey);
    chmodSync(keyPath, 0o600);
  }
}

const keeper = await Keeper.start({
  privateKey,
  home,
  env: (process.env.XMTP_ENV ?? 'dev') as XmtpEnv,
  log: (line) => console.log(`[keeper] ${line}`),
});
console.log(`room-keeper online at ${keeper.address} (xmtp:${process.env.XMTP_ENV ?? 'dev'}); rooms: ${keeper.roomNames().join(', ') || 'none yet'}`);
console.log(`agents set KEEPER_ADDRESS=${keeper.address}`);
process.on('SIGINT', () => void keeper.stop().then(() => process.exit(0)));
