/**
 * One identity on the network as the daemon and the relay hold it: the key under `home`, one XMTP client
 * for the process's whole life (same db → same installation), a durable inbox, and the four verbs plus
 * inbox/whoami as plain methods. The daemon has exactly one of these (AGENT_HOME); the relay has one per
 * entry of tokens.json (RELAY_HOME/identities/<name>). Failures are HttpErrors with the texts the HTTP
 * routes have always returned, so the daemon, the relay and /v1/mcp all say the same thing.
 */
import { join } from 'node:path';
import type { XmtpEnv } from '@xmtp/node-sdk';
import { Transport, loadOrCreateKeystore, type Keystore } from '@agent-network/core';
import type { Resolver } from '@agent-network/resolver';
import { HttpError, sleep } from './http.js';
import { DurableQueue, type Taken } from './queue.js';

/** 64 KB: a message body larger than that is a file plus a pointer (SKILL §5.15), not a send. */
export const MAX_TEXT_BYTES = 64 * 1024;

export interface IdentityOptions {
  name: string;
  /** Directory holding key, xmtp-<env>.db3, xmtp-<env>.cursor and netd-queue.jsonl. Created if missing. */
  home: string;
  env: XmtpEnv;
  resolver: Resolver;
  /** The room-keeper's name or 0x address; join/leave are DMs to it. */
  keeperName: string;
  /** Where "keeper does not resolve" should tell the operator to add it. */
  namesPath: string;
  log: (line: string) => void;
}

export interface Message {
  ts: string;
  from: string;
  room: string | null;
  text: string;
  missed: boolean;
}

export interface Member {
  name: string;
  address: `0x${string}`;
  reachable: boolean;
  you: boolean;
}

export class Identity {
  readonly name: string;
  readonly home: string;
  readonly keystore: Keystore;
  readonly queue: DurableQueue;
  readonly since = new Date().toISOString();
  /** ISO time of the last inbox read, for the operator's identities list. */
  lastPoll: string | null = null;
  /** Long-polls in progress (the relay caps these per token). */
  polling = 0;
  private transport: Transport | undefined;
  private booting: Promise<void> | undefined;
  private restarting = false;
  private readonly env: XmtpEnv;
  private readonly resolver: Resolver;
  private readonly keeperName: string;
  private readonly namesPath: string;
  private readonly log: (line: string) => void;

  constructor(opts: IdentityOptions) {
    this.name = opts.name;
    this.env = opts.env;
    this.resolver = opts.resolver;
    this.keeperName = opts.keeperName;
    this.namesPath = opts.namesPath;
    this.log = (line) => opts.log(`${opts.name}: ${line}`);
    this.keystore = loadOrCreateKeystore(opts.home);
    this.home = this.keystore.home;
    this.queue = new DurableQueue(join(this.home, 'netd-queue.jsonl'), this.log);
  }

  get address(): `0x${string}` { return this.keystore.address; }
  get dbPath(): string { return join(this.home, `xmtp-${this.env}.db3`); }
  get online(): boolean { return Boolean(this.transport) && !this.restarting; }
  get inboxId(): string | undefined { return this.transport?.inboxId; }

  /** Boot the transport; resolves when online. Idempotent. Rejections propagate to the caller of the first start. */
  start(): Promise<void> {
    if (this.transport) return Promise.resolve();
    if (!this.booting) {
      this.booting = this.startTransport()
        .then((t) => {
          this.transport = t;
          this.log(`${this.address} online on xmtp:${this.env} (inbox ${t.inboxId}); ${this.queue.length} queued`);
        })
        .finally(() => { this.booting = undefined; });
    }
    return this.booting;
  }

  private startTransport(): Promise<Transport> {
    return Transport.start({
      keystore: this.keystore,
      env: this.env,
      onInbound: (m) => this.queue.push(m),
      onStreamError: async () => {
        if (this.restarting) return;
        this.restarting = true;
        this.log('stream died; restarting transport');
        try {
          await this.transport?.stop().catch(() => undefined);
          this.transport = await this.startTransport();
          this.log('transport restarted');
        } catch (err) {
          this.log(`transport restart failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.restarting = false;
        }
      },
    });
  }

  /** The transport, once booted; 503 while it is (re)starting. */
  async ready(): Promise<Transport> {
    if (this.booting) await this.booting;
    if (!this.transport || this.restarting) throw new HttpError(503, 'network transport is restarting; retry in a moment');
    return this.transport;
  }

  async stop(): Promise<void> {
    this.queue.close();
    try { await Promise.race([this.transport?.stop(), sleep(5000)]); } catch { /* ignore */ }
  }

  private async keeper(): Promise<`0x${string}`> {
    const k = await this.resolver.resolve(this.keeperName);
    if (!k) throw new HttpError(400, `keeper "${this.keeperName}" does not resolve; add it to ${this.namesPath} or set KEEPER_ADDRESS`);
    return k.address;
  }

  // --- the verbs ----------------------------------------------------------------------------------

  whoami() {
    return { name: this.name, address: this.address, inboxId: this.inboxId, env: this.env, home: this.home };
  }

  /**
   * Long-poll the inbox: what is queued now, else the first to arrive within `waitSeconds`. The caller
   * decides when the batch counts as delivered (`ack`) or must be re-offered (`release`).
   */
  async inbox(waitSeconds: number, signal?: AbortSignal): Promise<{ messages: Message[] } & Taken> {
    await this.ready();
    this.lastPoll = new Date().toISOString();
    const taken = await this.queue.take(waitSeconds * 1000, signal);
    const messages = await Promise.all(taken.items.map(async (m) => ({ ts: m.ts, from: await this.resolver.label(m.from), room: m.room, text: m.text, missed: m.missed })));
    return { messages, ...taken };
  }

  /** Room first (a room you are in), then a name, then a raw 0x address. */
  async send(target: string, text: string): Promise<{ ok: true; to: string }> {
    const t = await this.ready();
    const body = text.trim();
    if (!body) throw new HttpError(400, 'text (string) required');
    if (Buffer.byteLength(body) > MAX_TEXT_BYTES) throw new HttpError(413, `text is over 64 KB; put it in a file and send a pointer`);
    const room = await t.findRoom(target);
    if (room) { await t.sendToGroup(room, body); return { ok: true, to: `room:${room.name}` }; }
    const who = await this.resolver.resolve(target);
    if (!who) throw new HttpError(404, `"${target}" is neither a room you are in nor a known agent name`);
    if (!(await t.canMessage(who.address))) throw new HttpError(404, `${who.name} has no inbox on the network`);
    await t.sendDm(who.address, body);
    return { ok: true, to: who.name };
  }

  /** DM the keeper "join <room>" and wait up to `waitSeconds` (≤120) for the membership to appear. */
  async join(roomName: string, waitSeconds = 8): Promise<{ ok: boolean; note: string }> {
    const t = await this.ready();
    const room = roomName.trim();
    const wait = Math.min(Math.max(waitSeconds || 0, 0), 120);
    if (await t.findRoom(room)) return { ok: true, note: `already in ${room}` };
    await t.sendDm(await this.keeper(), `join ${room}`);
    const deadline = Date.now() + wait * 1000;
    let joined = false;
    while (!joined && Date.now() < deadline) { await sleep(1000); joined = Boolean(await t.findRoom(room)); }
    if (!joined && wait === 0) joined = Boolean(await t.findRoom(room));
    return { ok: joined, note: `asked the keeper to add you to ${room}` };
  }

  async leave(roomName: string): Promise<{ ok: true }> {
    const t = await this.ready();
    const room = roomName.trim();
    if (!(await t.findRoom(room))) throw new HttpError(404, `you are not in ${room}`);
    await t.sendDm(await this.keeper(), `leave ${room}`);
    await sleep(3000);
    return { ok: true };
  }

  async members(roomName: string): Promise<Member[]> {
    const t = await this.ready();
    if (!roomName) throw new HttpError(400, 'room required');
    const group = await t.findRoom(roomName);
    if (!group) throw new HttpError(404, `you are not in ${roomName}`);
    const addresses = await t.memberAddresses(group);
    return Promise.all(addresses.map(async (address) => ({
      name: await this.resolver.label(address),
      address,
      reachable: await t.canMessage(address),
      you: address.toLowerCase() === this.address.toLowerCase(),
    })));
  }

  async rooms(): Promise<string[]> {
    const t = await this.ready();
    return (await t.groups()).map((g) => g.name ?? '(unnamed)');
  }
}
