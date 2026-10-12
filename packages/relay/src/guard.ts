/**
 * Single-writer guard: an XMTP db may be open by one process at a time (a second installation would burn
 * one of the identity's ten). A mkdir lock holding our pid, plus an lsof check that nobody else has the
 * db open before we open it. Shared by the daemon (AGENT_HOME/netd.lock) and the relay (RELAY_HOME/relay.lock).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './http.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** PIDs (other than ours) that have the db open, via lsof. [] when lsof is missing. */
export function dbHolders(db: string, log: (line: string) => void): number[] {
  const files = [db, `${db}-wal`, `${db}-shm`].filter((f) => existsSync(f));
  if (!files.length) return [];
  const parse = (out: string) => [...new Set(out.split(/\s+/).filter(Boolean).map(Number))].filter((p) => p !== process.pid);
  try {
    return parse(execFileSync('lsof', ['-t', '--', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return []; // lsof: nothing found
    if (err.status === undefined) { log('lsof is not available; skipping the open-db check'); return []; }
    return parse(String(err.stdout ?? ''));
  }
}

/** Wait ≤60 s for nobody to hold the db; returns the holders still there (empty = free). */
export async function waitForDbFree(db: string, log: (line: string) => void): Promise<number[]> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const holders = dbHolders(db, log);
    if (!holders.length) return [];
    if (Date.now() > deadline) return holders;
    log(`waiting for pid ${holders.join(',')} to close ${db}`);
    await sleep(1000);
  }
}

export class Lock {
  constructor(private readonly dir: string, private readonly log: (line: string) => void) {}
  private get pidFile() { return join(this.dir, 'pid'); }

  /**
   * Take the lock (mkdir is atomic). A lock whose pid is dead is stale and is removed. `inherited` means the
   * client took it for us just before spawning us (NETD_LOCK_INHERITED=1): adopt it. Exits 3 when held.
   */
  acquire(inherited = false): void {
    if (inherited && existsSync(this.dir)) { writeFileSync(this.pidFile, String(process.pid)); return; }
    for (;;) {
      try {
        mkdirSync(this.dir);
        writeFileSync(this.pidFile, String(process.pid));
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let pid = NaN;
        try { pid = Number(readFileSync(this.pidFile, 'utf8').trim()); } catch { /* no pid yet */ }
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
          this.log(`another process (pid ${pid}) holds ${this.dir}; exiting`);
          process.exit(3);
        }
        const age = Date.now() - statSync(this.dir).mtimeMs;
        if (!Number.isFinite(pid) && age < 30_000) { this.log(`${this.dir} is being taken by someone else; exiting`); process.exit(3); }
        this.log(`removing stale lock ${this.dir} (pid ${Number.isFinite(pid) ? pid : 'none'})`);
        rmSync(this.dir, { recursive: true, force: true });
      }
    }
  }

  release(): void {
    try {
      const pid = Number(readFileSync(this.pidFile, 'utf8').trim());
      if (pid === process.pid) rmSync(this.dir, { recursive: true, force: true });
    } catch { /* not ours or already gone */ }
  }
}
