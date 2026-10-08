/**
 * The room-keeper: admin of every room. XMTP groups are admin-managed, so "anyone can
 * join" is this tiny agent adding whoever DMs it. A few dozen lines, by design.
 *
 *   DM "join <room>"   → added to the group (created if new)
 *   DM "leave <room>"  → removed
 *   DM "rooms"         → the list
 */
import { Agent, createSigner, createUser, type MessageContext } from '@xmtp/agent-sdk';
import type { Group, XmtpEnv } from '@xmtp/node-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';

export interface KeeperOptions {
  privateKey: Hex;
  env?: XmtpEnv;
  home: string;
  /** null = in-memory (tests). */
  dbPath?: string | null;
  /** Max join requests per sender per hour. */
  joinsPerHour?: number;
  log?: (line: string) => void;
}

const ethIdentifier = (address: string) => ({ identifier: address.toLowerCase(), identifierKind: 0 });

export class Keeper {
  private agent!: Agent;
  private rooms = new Map<string, string>(); // room name → group id
  private joins = new Map<string, number[]>(); // sender → recent join timestamps
  private readonly roomsPath: string;

  private constructor(private readonly opts: KeeperOptions) {
    this.roomsPath = join(opts.home, 'rooms.json');
  }

  static async start(opts: KeeperOptions): Promise<Keeper> {
    const k = new Keeper(opts);
    await k.boot();
    return k;
  }

  get address(): string {
    return createUser(this.opts.privateKey).account.address;
  }

  private async boot(): Promise<void> {
    mkdirSync(this.opts.home, { recursive: true });
    if (existsSync(this.roomsPath)) {
      this.rooms = new Map(Object.entries(JSON.parse(readFileSync(this.roomsPath, 'utf8')) as Record<string, string>));
    }
    const env = this.opts.env ?? 'dev';
    this.agent = await Agent.create(createSigner(createUser(this.opts.privateKey)), {
      env,
      dbPath: this.opts.dbPath === undefined ? join(this.opts.home, `keeper-${env}.db3`) : this.opts.dbPath,
    });
    this.agent.on('text', (ctx) => void this.handle(ctx).catch((err) => this.opts.log?.(`error: ${err}`)));
    await this.agent.start();
    await this.agent.client.conversations.syncAll();
  }

  private async handle(ctx: MessageContext<string>): Promise<void> {
    if (!ctx.isDm()) return; // commands are DMs only; the keeper never speaks in rooms
    const sender = (await ctx.getSenderAddress()) as `0x${string}` | undefined;
    if (!sender) return;
    const [verb, ...rest] = ctx.message.content.trim().split(/\s+/);
    const room = rest.join(' ').trim().toLowerCase();

    if (verb === 'rooms') {
      await ctx.conversation.sendText([...this.rooms.keys()].sort().join(', ') || '(no rooms yet)');
      this.opts.log?.(`${sender} asked for rooms`);
      return;
    }
    if (verb !== 'join' && verb !== 'leave') {
      await ctx.conversation.sendText(`I only understand: join <room>, leave <room>, rooms. Rooms: ${[...this.rooms.keys()].sort().join(', ') || '(none yet)'}`);
      this.opts.log?.(`${sender} sent an unknown command: ${ctx.message.content.slice(0, 60)}`);
      return;
    }
    if (!room) return;

    if (verb === 'join') {
      if (!this.allowJoin(sender)) {
        await ctx.conversation.sendText('slow down — too many join requests; try again later');
        return;
      }
      const group = await this.ensureRoom(room, sender);
      if (group.created) {
        await ctx.conversation.sendText(`created ${room} and added you`);
      } else {
        await group.group.addMembersByIdentifiers([ethIdentifier(sender)]);
        await ctx.conversation.sendText(`added you to ${room}`);
      }
      this.opts.log?.(`${sender} joined ${room}`);
    } else if (verb === 'leave') {
      const id = this.rooms.get(room);
      const group = id ? await this.agent.client.conversations.getConversationById(id) : undefined;
      if (!group) {
        await ctx.conversation.sendText(`no room named ${room}`);
        return;
      }
      await (group as Group).removeMembersByIdentifiers([ethIdentifier(sender)]);
      await ctx.conversation.sendText(`removed you from ${room}`);
      this.opts.log?.(`${sender} left ${room}`);
    }
  }

  private async ensureRoom(room: string, firstMember: `0x${string}`): Promise<{ group: Group; created: boolean }> {
    const id = this.rooms.get(room);
    if (id) {
      const existing = await this.agent.client.conversations.getConversationById(id);
      if (existing) return { group: existing as Group, created: false };
    }
    const group = await this.agent.createGroupWithAddresses([firstMember], { groupName: room });
    this.rooms.set(room, group.id);
    writeFileSync(this.roomsPath, JSON.stringify(Object.fromEntries(this.rooms), null, 2));
    return { group, created: true };
  }

  private allowJoin(sender: string): boolean {
    const limit = this.opts.joinsPerHour ?? 30;
    const now = Date.now();
    const recent = (this.joins.get(sender) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= limit) return false;
    recent.push(now);
    this.joins.set(sender, recent);
    return true;
  }

  roomNames(): string[] {
    return [...this.rooms.keys()];
  }

  async stop(): Promise<void> {
    await this.agent.stop();
  }
}
