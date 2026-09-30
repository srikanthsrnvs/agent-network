/**
 * The agent's model loop. One agent, one context: whatever arrives — from the owner at
 * the keyboard or from the network — is pushed into the same rolling history, tagged
 * with provenance, and the model gets a turn with the four tools. No inbox to poll,
 * no message types, no workflow: coordination is whatever the model writes.
 */
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import type { Resolver } from '@agent-network/resolver';
import type { Inbound } from './xmtp.js';
import type { Tools } from './tools.js';

export interface LoopOptions {
  model: LanguageModel;
  tools: Tools;
  resolver: Resolver;
  /** The owner's standing instructions and this agent's identity, in plain language. */
  systemPrompt: string;
  /** Keep the history bounded; oldest turns fall off. */
  maxHistory?: number;
  maxStepsPerTurn?: number;
  /** Where the model's own words go (the owner's terminal). */
  onSay?: (text: string) => void;
  log?: (line: string) => void;
}

export class AgentLoop {
  private history: ModelMessage[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LoopOptions) {}

  /** The owner typed something. Resolves to what the agent says back. */
  fromOwner(text: string): Promise<string> {
    return this.turn({ role: 'user', content: `[owner] ${text}` });
  }

  /** Something arrived over the network. */
  async fromNetwork(msg: Inbound): Promise<void> {
    const who = await this.opts.resolver.label(msg.from);
    const where = msg.room ? `room "${msg.room}"` : 'a direct message';
    const when = msg.missed ? ` (arrived ${msg.sentAt.toISOString()} while you were away)` : '';
    await this.turn({ role: 'user', content: `[network] ${who} in ${where}${when}: ${msg.text}` });
  }

  private turn(message: ModelMessage): Promise<string> {
    const run = this.queue.then(async () => {
      this.history.push(message);
      this.trim();
      this.opts.log?.(`> ${String(message.content).slice(0, 120)}`);
      const result = await generateText({
        model: this.opts.model,
        system: this.opts.systemPrompt,
        messages: this.history,
        tools: this.opts.tools,
        stopWhen: stepCountIs(this.opts.maxStepsPerTurn ?? 8),
      });
      this.history.push(...result.response.messages);
      this.trim();
      for (const step of result.steps) {
        for (const call of step.toolCalls) this.opts.log?.(`  tool ${call.toolName}(${JSON.stringify(call.input)})`);
      }
      if (result.text.trim()) this.opts.onSay?.(result.text);
      return result.text;
    });
    this.queue = run.then(
      () => undefined,
      (err) => this.opts.log?.(`turn failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    return run;
  }

  private trim(): void {
    const max = this.opts.maxHistory ?? 80;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  snapshot(): readonly ModelMessage[] {
    return this.history;
  }
}
