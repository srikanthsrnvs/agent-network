/**
 * The device's one key. Generated on first boot (a secure element later), stored 0600
 * under AGENT_HOME. Everything derives from it: the Ethereum identity, the XMTP inbox,
 * and the local-db encryption key — so a restart recovers the whole agent.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keccak256, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface Keystore {
  home: string;
  privateKey: Hex;
  address: `0x${string}`;
  /** 32-byte key for the XMTP local database, derived from the device key. */
  dbEncryptionKey: Hex;
}

export function resolveHome(raw = process.env.AGENT_HOME ?? '~/.agent-network'): string {
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
}

export function loadOrCreateKeystore(home = resolveHome()): Keystore {
  mkdirSync(home, { recursive: true });
  const keyPath = join(home, 'key');
  let privateKey: Hex;
  if (existsSync(keyPath)) {
    privateKey = readFileSync(keyPath, 'utf8').trim() as Hex;
  } else {
    privateKey = generatePrivateKey();
    writeFileSync(keyPath, privateKey);
    chmodSync(keyPath, 0o600);
  }
  return {
    home,
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    dbEncryptionKey: keccak256(stringToHex(`agent-network/xmtp-db/${privateKey}`)),
  };
}
