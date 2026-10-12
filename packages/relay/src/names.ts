/**
 * names.json as a resolver backend, re-read when its mtime changes, so new agents need no restart
 * (the pi extension does the same). The daemon reads $AGENT_HOME/names.json; the relay reads the shared
 * RELAY_HOME/names.json. `extra` entries (self, the relay's own identities, the keeper) win over the file.
 */
import { existsSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { isAddress } from 'viem';
import { StaticBackend, type NameBackend, type Resolved } from '@agent-network/resolver';

export class NamesFile implements NameBackend {
  private inner = new StaticBackend({});
  private mtime = -1;
  private readonly extra = new Map<string, `0x${string}`>();
  constructor(private readonly path: string) {}

  /** A name that is always known, whatever the file says (re-applied on every reload). */
  set(name: string, address: `0x${string}`): void {
    this.extra.set(name.toLowerCase(), address);
    this.mtime = -1;
  }

  private load(): StaticBackend {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime !== this.mtime) {
      let entries: Record<string, string> = {};
      if (mtime) {
        try {
          const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
          if (parsed && typeof parsed === 'object') entries = parsed as Record<string, string>;
        } catch {
          /* a half-written file: keep the previous map until it parses again */
          return this.inner;
        }
      }
      const next = new StaticBackend({});
      for (const [n, a] of Object.entries(entries)) {
        try { next.set(n, a as `0x${string}`); } catch { /* skip a malformed address */ }
      }
      for (const [n, a] of this.extra) next.set(n, a);
      this.inner = next;
      this.mtime = mtime;
    }
    return this.inner;
  }

  resolve(n: string): Promise<Resolved | null> { return this.load().resolve(n); }
  reverse(address: `0x${string}`): Promise<string | null> { return this.load().reverse(address); }
  /** The merged map (file + extras), for /names and agent://self. */
  entries(): Record<string, string> { return this.load().entries(); }

  /** Replace only this identity's contacts; never the relay's shared address book. */
  replace(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('names must be a name-to-address object');
    const entries = Object.entries(value);
    const normalized: Record<string, string> = Object.create(null);
    if (entries.length > 1000) throw new Error('at most 1000 contacts');
    for (const [name, address] of entries) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) || typeof address !== 'string' || !isAddress(address)) {
        throw new Error('each contact needs a valid name and Ethereum address');
      }
      const key = name.toLowerCase();
      if (normalized[key] && normalized[key].toLowerCase() !== address.toLowerCase()) throw new Error('conflicting case-insensitive contact names');
      normalized[key] = address;
      const own = this.extra.get(key);
      if (own && own.toLowerCase() !== address.toLowerCase()) throw new Error('cannot replace this identity\'s own address');
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    this.mtime = -1;
  }
}
