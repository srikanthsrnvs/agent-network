/**
 * The durable inbox: inbound messages appended to a JSONL file, reloaded on start, removed only when a
 * reader has acknowledged them (for HTTP: when the response finished). While a batch is being delivered its
 * ids are "in flight" and not offered to a second reader; a reader that disappears releases them.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Inbound } from '@agent-network/core';

export interface Queued {
  id: string;
  ts: string;
  /** sender address; labelled with the names map at delivery time so later-added names apply */
  from: `0x${string}`;
  room: string | null;
  text: string;
  missed: boolean;
}

export interface Taken {
  items: Queued[];
  /** Delivered: drop them from the durable queue. */
  ack(): void;
  /** Not delivered after all: offer them to the next reader. */
  release(): void;
}

export class DurableQueue {
  private readonly queue: Queued[] = [];
  private readonly inflight = new Set<string>();
  private readonly recentlyDelivered: string[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly path: string, private readonly log: (line: string) => void = () => undefined) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { this.queue.push(JSON.parse(line) as Queued); } catch { log('skipping a corrupt queue line'); }
    }
    if (this.queue.length) log(`reloaded ${this.queue.length} queued message(s) from ${path}`);
  }

  get length(): number { return this.queue.length; }

  /** Idempotent on (conversation, sentAt, sender): the catch-up after a crash re-offers what was already delivered. */
  push(m: Inbound): void {
    const id = `${m.conversationId}:${m.sentAt.getTime()}:${m.from.toLowerCase()}`;
    if (this.queue.some((q) => q.id === id) || this.recentlyDelivered.includes(id)) return;
    const item: Queued = { id, ts: m.sentAt.toISOString(), from: m.from, room: m.room, text: m.text, missed: m.missed };
    appendFileSync(this.path, JSON.stringify(item) + '\n');
    this.queue.push(item);
    const wake = this.waiters.shift();
    if (wake) wake();
  }

  /** Messages not already promised to another in-progress delivery. */
  private available(): Queued[] { return this.queue.filter((m) => !this.inflight.has(m.id)); }

  /**
   * Wait up to `waitMs` for something to be available (resolving at once when the queue has items, when
   * `signal` aborts, or when the queue is closed) and take it. An empty `items` means nothing arrived.
   */
  async take(waitMs: number, signal?: AbortSignal): Promise<Taken> {
    let batch = this.available();
    if (!batch.length && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = () => {
          clearTimeout(timer);
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        timer = setTimeout(done, waitMs);
        this.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
      batch = signal?.aborted ? [] : this.available();
    }
    const ids = batch.map((m) => m.id);
    for (const id of ids) this.inflight.add(id);
    let settled = false;
    return {
      items: batch,
      ack: () => { if (settled) return; settled = true; this.markDelivered(ids); },
      release: () => { if (settled) return; settled = true; for (const id of ids) this.inflight.delete(id); },
    };
  }

  private markDelivered(ids: string[]): void {
    for (const id of ids) {
      this.inflight.delete(id);
      const i = this.queue.findIndex((m) => m.id === id);
      if (i >= 0) this.queue.splice(i, 1);
      this.recentlyDelivered.push(id);
    }
    while (this.recentlyDelivered.length > 1000) this.recentlyDelivered.shift();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.queue.map((m) => JSON.stringify(m)).join('\n') + (this.queue.length ? '\n' : ''));
    renameSync(tmp, this.path);
  }

  /** Wake every waiter (shutdown). */
  close(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
}
