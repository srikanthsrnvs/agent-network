/**
 * The complete tool surface. Four primitives; nothing that encodes a protocol ships.
 * "reply", "ask", "delegate", "vote", "escrow" are sentences the agent writes.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { Address } from 'viem';
import type { Resolver } from '@agent-network/resolver';
import { Transport } from './xmtp.js';

export interface ToolDeps {
  transport: Transport;
  resolver: Resolver;
  /** The room-keeper's address (or name). join/leave are DMs to it. */
  keeper: string;
}

export function createTools({ transport, resolver, keeper }: ToolDeps) {
  const keeperAddress = async (): Promise<Address> => {
    const k = await resolver.resolve(keeper);
    if (!k) throw new Error(`room-keeper "${keeper}" does not resolve`);
    return k.address;
  };

  return {
    send: tool({
      description:
        'Deliver text to an agent (by name or address) or to a room you are in (by room name). ' +
        'Delivery is store-and-forward: offline recipients get it when they wake. ' +
        'Everything else — replying, asking, delegating, agreeing — is just what you write.',
      inputSchema: z.object({
        target: z.string().describe('agent name like alice.agent.eth, a 0x address, or a room name'),
        text: z.string().min(1),
      }),
      execute: async ({ target, text }) => {
        const room = await transport.findRoom(target);
        if (room) {
          await transport.sendToGroup(room, text);
          return { ok: true, to: `room:${room.name}` };
        }
        const who = await resolver.resolve(target);
        if (!who) {
          return {
            ok: false,
            error: `"${target}" is neither a room you are in nor a known agent name; use the agent name your owner gave you (mac/vast) or a 0x address`,
          };
        }
        if (!(await transport.canMessage(who.address))) {
          return { ok: false, error: `${who.name} has no agent inbox on the network` };
        }
        await transport.sendDm(who.address, text);
        return {
          ok: true,
          to: who.name,
          note: 'delivered. Their reply, if any, arrives later as a [network] message; do not wait, poll or resend; end your turn.',
        };
      },
    }),

    join: tool({
      description:
        'Join a room by name (created if it does not exist). You start receiving its messages once added; ' +
        'you will not see history from before you joined — ask the room if you need context.',
      inputSchema: z.object({ room: z.string().min(1) }),
      execute: async ({ room }) => {
        if (await transport.findRoom(room)) return { ok: true, note: `already in ${room}` };
        await transport.sendDm(await keeperAddress(), `join ${room.trim()}`);
        return { ok: true, note: `asked the keeper to add you to ${room}; messages will start arriving shortly` };
      },
    }),

    leave: tool({
      description: 'Leave a room you are in.',
      inputSchema: z.object({ room: z.string().min(1) }),
      execute: async ({ room }) => {
        if (!(await transport.findRoom(room))) return { ok: false, error: `you are not in ${room}` };
        await transport.sendDm(await keeperAddress(), `leave ${room.trim()}`);
        return { ok: true, note: `asked the keeper to remove you from ${room}` };
      },
    }),

    members: tool({
      description: 'List who is in a room, with whether each member is reachable on the network.',
      inputSchema: z.object({ room: z.string().min(1) }),
      execute: async ({ room }) => {
        const group = await transport.findRoom(room);
        if (!group) return { ok: false, error: `you are not in ${room}` };
        const addresses = await transport.memberAddresses(group);
        const members = await Promise.all(
          addresses.map(async (address) => ({
            name: await resolver.label(address),
            address,
            reachable: await transport.canMessage(address),
            you: address.toLowerCase() === transport.address.toLowerCase(),
          })),
        );
        return { ok: true, room: group.name, members };
      },
    }),
  };
}

export type Tools = ReturnType<typeof createTools>;
