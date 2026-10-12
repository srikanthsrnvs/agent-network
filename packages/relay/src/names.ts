/**
 * names.json as a resolver backend, re-read when its mtime changes, so new agents need no restart
 * (the pi extension does the same). The daemon reads $AGENT_HOME/names.json; the relay reads the shared
 * RELAY_HOME/names.json. `extra` entries (self, the relay's own identities, the keeper) win over the file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { StaticBackend, type NameBackend, type Resolved } from '@agent-network/resolver';

export class NamesFile implements NameBackend {
  private inner = new StaticBackend({});
  private mtime = -1;
  private readonly extra = new Map<string, `0x${string}`>();
  constructor(private readonly path: string) {}

  /** A name that is always known, whatever the file says (re-applied on every reload). */
  set(name: string, address: `0x${string}`): void {
    this.extra.set(name, address);
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
}
