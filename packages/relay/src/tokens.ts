/**
 * RELAY_HOME/tokens.json: {"<token>": "<identity name>"} in plaintext (owner's decision; the file is 0600 and
 * the operator is the only one who writes it, with `anet relay add-identity`). Re-read when its mtime changes;
 * the bearer token is compared in constant time against every entry (sha256 of both sides, timingSafeEqual).
 * The name `_admin` is not an identity: its token may read GET /v1/identities.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const ADMIN = '_admin';
const digest = (s: string) => createHash('sha256').update(s).digest();

export class TokenFile {
  private entries: Array<{ hash: Buffer; name: string }> = [];
  private mtime = -1;
  constructor(readonly path: string) {}

  private load(): void {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime === this.mtime) return;
    let parsed: Record<string, unknown> = {};
    if (mtime) {
      try {
        const v = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      } catch {
        return; // half-written: keep the previous set until it parses again
      }
    }
    this.entries = Object.entries(parsed)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0 && e[0].length > 0)
      .map(([token, name]) => ({ hash: digest(token), name: name.trim() }));
    this.mtime = mtime;
  }

  /** The identity (or `_admin`) a bearer token names, else null. Constant time over the whole file. */
  lookup(token: string): string | null {
    this.load();
    const h = digest(token);
    let found: string | null = null;
    for (const e of this.entries) if (timingSafeEqual(h, e.hash) && found === null) found = e.name;
    return found;
  }

  /** Every identity name the file mentions (no `_admin`), deduplicated. */
  names(): string[] {
    this.load();
    return [...new Set(this.entries.map((e) => e.name))].filter((n) => n !== ADMIN);
  }
}
