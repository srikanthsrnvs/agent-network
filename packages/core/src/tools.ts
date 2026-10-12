/**
 * The complete tool surface. Four primitives; nothing that encodes a protocol ships.
 * "reply", "ask", "delegate", "vote", "escrow" are sentences the agent writes.
 *
 * A tool is a plain object {name, description, inputSchema (zod), execute}: no harness SDK in the core.
 * The MCP adapter registers them as they are, the pi adapter wraps execute, an OpenAI Agents SDK program
 * builds FunctionTools from them.
 */
import { z } from 'zod';
import type { Address } from 'viem';
import type { Resolver } from '@agent-network/resolver';
import { Transport } from './xmtp.js';

export interface Tool<S extends z.ZodType = z.ZodType, Output = unknown> {
  name: string;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>) => Promise<Output>;
}

/** The tiny helper every tool is built with; keeps the input type tied to its schema. */
export function defineTool<S extends z.ZodType, Output>(
  name: string,
  description: string,
  inputSchema: S,
  execute: (input: z.infer<S>) => Promise<Output>,
): Tool<S, Output> {
  return { name, description, inputSchema, execute };
}

/** The tools as a list, for harnesses that take one. */
export function toolList(tools: Tools): Tool[] {
  return [tools.send, tools.join, tools.leave, tools.members] as unknown as Tool[];
}

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
  const room = z.object({ room: z.string().min(1) });

  return {
    send: defineTool(
      'send',
      'Deliver text to an agent (by name or address) or to a room you are in (by room name). ' +
        'Delivery is store-and-forward: offline recipients get it when they wake. ' +
        'Everything else — replying, asking, delegating, agreeing — is just what you write.',
      z.object({
        target: z.string().describe('agent name like alice.agent.eth, a 0x address, or a room name'),
        text: z.string().min(1),
      }),
      async ({ target, text }) => {
        const group = await transport.findRoom(target);
        if (group) {
          await transport.sendToGroup(group, text);
          return { ok: true as const, to: `room:${group.name}` };
        }
        const who = await resolver.resolve(target);
        if (!who) {
          return {
            ok: false as const,
            error: `"${target}" is neither a room you are in nor a known agent name; use the agent name your owner gave you or a 0x address`,
          };
        }
        if (!(await transport.canMessage(who.address))) {
          return { ok: false as const, error: `${who.name} has no agent inbox on the network` };
        }
        await transport.sendDm(who.address, text);
        return {
          ok: true as const,
          to: who.name,
          note: 'delivered. Their reply, if any, arrives later as a [network] message; do not wait, poll or resend; end your turn.',
        };
      },
    ),

    join: defineTool(
      'join',
      'Join a room by name (created if it does not exist). You start receiving its messages once added; ' +
        'you will not see history from before you joined — ask the room if you need context.',
      room,
      async ({ room }) => {
        if (await transport.findRoom(room)) return { ok: true as const, note: `already in ${room}` };
        await transport.sendDm(await keeperAddress(), `join ${room.trim()}`);
        return { ok: true as const, note: `asked the keeper to add you to ${room}; messages will start arriving shortly` };
      },
    ),

    leave: defineTool('leave', 'Leave a room you are in.', room, async ({ room }) => {
      if (!(await transport.findRoom(room))) return { ok: false as const, error: `you are not in ${room}` };
      await transport.sendDm(await keeperAddress(), `leave ${room.trim()}`);
      return { ok: true as const, note: `asked the keeper to remove you from ${room}` };
    }),

    members: defineTool(
      'members',
      'List who is in a room, with whether each member is reachable on the network.',
      room,
      async ({ room }) => {
        const group = await transport.findRoom(room);
        if (!group) return { ok: false as const, error: `you are not in ${room}` };
        const addresses = await transport.memberAddresses(group);
        const members = await Promise.all(
          addresses.map(async (address) => ({
            name: await resolver.label(address),
            address,
            reachable: await transport.canMessage(address),
            you: address.toLowerCase() === transport.address.toLowerCase(),
          })),
        );
        return { ok: true as const, room: group.name, members };
      },
    ),
  };
}

export type Tools = ReturnType<typeof createTools>;
