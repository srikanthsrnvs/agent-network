/**
 * Transport: XMTP. We run no relays and write no crypto — the network does
 * store-and-forward, MLS encryption, DMs, and groups. This module is the thin glue:
 * boot an XMTP inbox from the device key, catch up on everything missed while asleep,
 * then stream live messages. Both paths feed the same `onInbound` callback so the
 * agent loop never distinguishes "missed" from "live".
 */
import { Agent, createSigner, createUser, type MessageContext } from '@xmtp/agent-sdk';
import type { Conversation, Group, XmtpEnv } from '@xmtp/node-sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import type { Keystore } from './keystore.js';

export interface Inbound {
  /** Sender's Ethereum address (XMTP identity == Ethereum address). */
  from: Address;
  text: string;
  /** DM, or the room (group) name. */
  room: string | null;
  conversationId: string;
  sentAt: Date;
  /** True when replayed from the network after being offline. */
  missed: boolean;
}

export interface TransportOptions {
  keystore: Keystore;
  env?: XmtpEnv;
  /** null = in-memory (tests); default = persisted under AGENT_HOME. */
  dbPath?: string | null;
  onInbound: (msg: Inbound) => void | Promise<void>;
  /** Called when we've been added to a group (e.g. the keeper let us into a room). */
  onJoined?: (group: Group) => void | Promise<void>;
}

type Identifier = { identifier: string; identifierKind: number };
/** XMTP identifiers are (address, kind); kind 0 = Ethereum. */
export const ethIdentifier = (address: string): Identifier => ({ identifier: address.toLowerCase(), identifierKind: 0 });

export class Transport {
  private agent!: Agent;
  private readonly cursorPath: string;

  private constructor(private readonly opts: TransportOptions) {
    this.cursorPath = join(opts.keystore.home, `xmtp-${opts.env ?? 'dev'}.cursor`);
  }

  static async start(opts: TransportOptions): Promise<Transport> {
    const t = new Transport(opts);
    await t.boot();
    return t;
  }

  get address(): Address {
    return this.opts.keystore.address;
  }

  get inboxId(): string {
    return this.agent.client.inboxId;
  }

  get client() {
    return this.agent.client;
  }

  private async boot(): Promise<void> {
    const env = this.opts.env ?? 'dev';
    const user = createUser(this.opts.keystore.privateKey);
    this.agent = await Agent.create(createSigner(user), {
      env,
      dbPath: this.opts.dbPath === undefined ? join(this.opts.keystore.home, `xmtp-${env}.db3`) : this.opts.dbPath,
      dbEncryptionKey: this.opts.keystore.dbEncryptionKey,
    });

    this.agent.on('text', (ctx) => void this.handleLive(ctx));
    this.agent.on('group', (ctx) => void this.opts.onJoined?.(ctx.conversation as Group));
    this.agent.on('unhandledError', (err) => {
      console.error('[xmtp] error:', err);
      // A dead stream is not recoverable from here: the SDK's own retry does not always
      // bring it back, and the process would keep running while receiving nothing. Let the
      // supervisor restart us; catch-up replays everything missed since the cursor.
      if (process.env.AGENT_EXIT_ON_STREAM_ERROR === '1' && String(err).includes('AgentStreamingError')) {
        console.error('[xmtp] stream died; exiting for restart');
        process.exit(2);
      }
    });

    await this.agent.start();
    await this.catchUp();
  }

  /** Replay everything that arrived while we were asleep, oldest first, then move the cursor. */
  private async catchUp(): Promise<void> {
    const since = existsSync(this.cursorPath) ? BigInt(readFileSync(this.cursorPath, 'utf8').trim() || '0') : 0n;
    await this.client.conversations.syncAll();
    const conversations = await this.client.conversations.list();
    const missed: Array<{ msg: Inbound; ns: bigint }> = [];
    for (const conversation of conversations) {
      const messages = await conversation.messages({ sentAfterNs: since });
      for (const m of messages) {
        if (m.senderInboxId === this.inboxId || typeof m.content !== 'string') continue;
        const from = await this.senderAddress(conversation, m.senderInboxId);
        if (!from) continue;
        missed.push({
          ns: m.sentAtNs,
          msg: {
            from,
            text: m.content,
            room: roomName(conversation),
            conversationId: conversation.id,
            sentAt: m.sentAt,
            missed: true,
          },
        });
      }
    }
    missed.sort((a, b) => (a.ns < b.ns ? -1 : 1));
    for (const { msg } of missed) await this.opts.onInbound(msg);
    this.advanceCursor(missed.at(-1)?.ns);
  }

  private async handleLive(ctx: MessageContext<string>): Promise<void> {
    if (ctx.message.senderInboxId === this.inboxId) return;
    const from = (await ctx.getSenderAddress()) as Address | undefined;
    if (!from) return;
    await this.opts.onInbound({
      from,
      text: ctx.message.content,
      room: roomName(ctx.conversation),
      conversationId: ctx.conversation.id,
      sentAt: ctx.message.sentAt,
      missed: false,
    });
    this.advanceCursor(ctx.message.sentAtNs);
  }

  private advanceCursor(ns?: bigint): void {
    if (ns === undefined) return;
    if (this.opts.dbPath === null) return; // ephemeral agents keep no cursor
    writeFileSync(this.cursorPath, ns.toString());
  }

  private async senderAddress(conversation: Conversation, inboxId: string): Promise<Address | null> {
    const members = await conversation.members();
    const member = members.find((m) => m.inboxId === inboxId);
    const id = member?.accountIdentifiers.find((i) => i.identifierKind === 0)?.identifier;
    return (id as Address | undefined) ?? null;
  }

  // --- the primitives the tools are built on ---------------------------------------

  async sendDm(address: Address, text: string): Promise<void> {
    const dm = await this.agent.createDmWithAddress(address);
    await dm.sendText(text);
  }

  async sendToGroup(group: Group, text: string): Promise<void> {
    await group.sendText(text);
  }

  async canMessage(address: Address): Promise<boolean> {
    const result = await this.client.canMessage([ethIdentifier(address)]);
    return result.get(address.toLowerCase()) ?? false;
  }

  async groups(): Promise<Group[]> {
    await this.client.conversations.syncAll();
    return this.client.conversations.listGroups();
  }

  async findRoom(name: string): Promise<Group | null> {
    const wanted = name.trim().toLowerCase();
    return (await this.groups()).find((g) => (g.name ?? '').toLowerCase() === wanted) ?? null;
  }

  async memberAddresses(group: Group): Promise<Address[]> {
    const members = await group.members();
    return members
      .map((m) => m.accountIdentifiers.find((i) => i.identifierKind === 0)?.identifier)
      .filter((a): a is string => Boolean(a))
      .map((a) => a as Address);
  }

  async stop(): Promise<void> {
    await this.agent.stop();
  }
}

function roomName(conversation: Conversation): string | null {
  const name = (conversation as Group).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}
