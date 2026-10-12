import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NamesFile } from '../packages/relay/src/names.js';

describe('scoped contact persistence', () => {
  it('normalizes aliases, reloads scopes, protects self and leaves a rejected update intact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anet-contacts-'));
    const path = join(home, 'names.json');
    const self = `0x${'1'.repeat(40)}` as const;
    const other = `0x${'2'.repeat(40)}` as const;
    try {
      const contacts = new NamesFile(path); contacts.set('Demo.Alice', self);
      contacts.replace({ Owner: other, constructor: other });
      expect((await contacts.resolve('OWNER'))?.address).toBe(other);
      expect((await new NamesFile(path).resolve('owner'))?.address).toBe(other);
      expect((await contacts.resolve('constructor'))?.address).toBe(other);
      const saved = readFileSync(path, 'utf8');
      expect(() => contacts.replace({ 'DEMO.ALICE': other })).toThrow('own address');
      expect(() => contacts.replace({ Owner: self, owner: other })).toThrow('conflicting');
      expect(() => contacts.replace({ owner: 'bad' })).toThrow('valid name');
      expect(readFileSync(path, 'utf8')).toBe(saved);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
