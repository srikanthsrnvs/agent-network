/**
 * The HTTP client side of the verbs, for programs in this repo that talk to a daemon or a relay (the stdio
 * MCP adapter). Two targets: the local daemon on its unix socket (routes unprefixed), or a relay at a URL
 * with a bearer token (routes under /v1). Every request carries an explicit User-Agent: Cloudflare rejects
 * the bare defaults of some HTTP libraries.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from './http.js';
import type { Member, Message } from './identity.js';
import type { Verbs } from './mcp.js';

export interface SocketTarget { socketPath: string }
export interface RelayTarget { url: string; token: string }
export type Target = SocketTarget | RelayTarget;

/** The daemon's socket path for an AGENT_HOME (a unix socket path may not exceed ~104 bytes; long homes get one in tmpdir). */
export function daemonSocket(home: string): string {
  const link = join(home, 'netd.sock');
  return Buffer.byteLength(link) <= 100 ? link : join(tmpdir(), `netd-${createHash('sha1').update(home).digest('hex').slice(0, 16)}.sock`);
}

export class NetClient {
  constructor(private readonly target: Target, private readonly userAgent = 'agent-network/0.1.0') {}

  get relay(): boolean { return 'url' in this.target; }

  /** One JSON request; non-2xx answers become HttpErrors carrying the server's {error} text. */
  call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: 'application/json' };
      if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(data)); }
      let req;
      if ('url' in this.target) {
        const u = new URL(`${this.target.url.replace(/\/+$/, '')}/v1${path}`);
        headers.authorization = `Bearer ${this.target.token}`;
        req = (u.protocol === 'https:' ? httpsRequest : httpRequest)({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers, signal }, onResponse);
      } else {
        req = httpRequest({ socketPath: this.target.socketPath, method, path, headers, signal }, onResponse);
      }
      function onResponse(res: import('node:http').IncomingMessage) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try { json = JSON.parse(raw); } catch { return reject(new HttpError(res.statusCode ?? 502, `server answered ${res.statusCode} with non-JSON`)); }
          if ((res.statusCode ?? 500) >= 300) {
            const err = (json as { error?: unknown })?.error;
            return reject(new HttpError(res.statusCode ?? 500, typeof err === 'string' ? err : `request failed (${res.statusCode})`));
          }
          resolve(json as T);
        });
      }
      req.setTimeout(timeoutMs, () => req.destroy(new Error('the server did not answer in time')));
      req.on('error', (e) => reject(signal?.aborted ? new HttpError(499, 'cancelled') : e));
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Long-poll until a message arrives or `seconds` have passed. A relay behind a proxy answers early
   * (RELAY_BEHIND_PROXY caps a poll at 80 s); we keep asking until our own deadline.
   */
  async inbox(seconds: number, signal?: AbortSignal): Promise<Message[]> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0 || signal?.aborted) return [];
      const wait = Math.min(remaining, 600);
      const t0 = Date.now();
      const r = await this.call<{ messages: Message[] }>('GET', `/inbox?wait=${wait}`, undefined, wait * 1000 + 15_000, signal);
      if (r.messages.length || Date.now() - t0 < 1000) return r.messages; // got something, or the server does not wait at all
    }
  }

  /** The verbs for createMcpServer(). `env` labels agent://self when the server does not say. */
  verbs(): Verbs {
    return {
      send: (target, text) => this.call('POST', '/send', { target, text }, 60_000),
      join: (room) => this.call('POST', '/join', { room, wait: 8 }, 60_000),
      leave: (room) => this.call('POST', '/leave', { room }, 60_000),
      members: (room) => this.call<Member[]>('GET', `/members?room=${encodeURIComponent(room)}`, undefined, 60_000),
      wait: (seconds, signal) => this.inbox(seconds, signal),
      self: async () => {
        const [who, names] = await Promise.all([
          this.call<{ name: string; address: string; inboxId?: string; env: string }>('GET', '/whoami', undefined, 120_000),
          this.call<Record<string, string>>('GET', '/names', undefined, 30_000),
        ]);
        return { name: who.name, address: who.address, inboxId: who.inboxId, env: who.env, names };
      },
    };
  }
}
