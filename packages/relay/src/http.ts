/** The few HTTP helpers the daemon and the relay share. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Read a JSON object body; `{}` when empty. Rejects with 413 over `limit` bytes, 400 when not a JSON object. */
export const readBody = (req: IncomingMessage, limit = 4 * 1024 * 1024, tooLarge = 'body too large') =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new HttpError(413, tooLarge));
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};

/** A required non-empty string field, else 400 `<what> (string) required`. */
export const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${what} (string) required`);
  return v;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
