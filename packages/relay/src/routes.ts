/**
 * The verbs as HTTP routes, shared by the daemon (unprefixed, on the unix socket) and the relay (/v1/…,
 * one identity per bearer token). JSON in, JSON out; errors are {error} with a 4xx/5xx status.
 *
 *   GET  /whoami            {name,address,inboxId,env,home}
 *   GET  /inbox?wait=S      {messages:[{ts,from,room,text,missed}]}; removed from the durable queue once
 *                           the response is fully written, re-offered when the client goes away first
 *   POST /send              {target,text} → {ok,to}            (413 over 64 KB)
 *   POST /join              {room,wait?}  → {ok,note}
 *   POST /leave             {room}        → {ok}
 *   GET  /members?room=     [{name,address,reachable,you}]
 *   GET  /rooms             [names]
 *   GET  /names             the merged name→address map this identity resolves with
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readBody, sendJson, str } from './http.js';
import type { Identity } from './identity.js';

export interface RouteContext {
  identity: Identity;
  /** Upper bound on ?wait= (600 for the daemon; 80 behind a proxy that cuts responses at 100 s). */
  maxWait: number;
  names: () => Record<string, string>;
  setNames?: (names: unknown) => void;
}

export const clampWait = (raw: string | number | null | undefined, max: number): number =>
  Math.min(Math.max(Number(raw ?? '0') || 0, 0), max);

/** Handle `method path` for one identity; returns false when the path is not a verb route. */
export async function handleVerb(route: string, url: URL, req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const { identity } = ctx;
  switch (route) {
    case 'GET /whoami': {
      await identity.ready();
      sendJson(res, 200, identity.whoami());
      return true;
    }
    case 'GET /inbox': {
      const wait = clampWait(url.searchParams.get('wait'), ctx.maxWait);
      const ac = new AbortController();
      const onClose = () => ac.abort(); // client went away: stop waiting, promise nothing
      res.on('close', onClose);
      identity.polling++;
      let taken;
      try {
        taken = await identity.inbox(wait, ac.signal);
      } finally {
        identity.polling--;
        res.off('close', onClose);
      }
      if (res.destroyed) { taken.release(); return true; }
      res.on('finish', taken.ack);                                  // fully written → gone from the durable queue
      res.on('close', () => { if (!res.writableFinished) taken.release(); }); // not delivered → back on offer
      sendJson(res, 200, { messages: taken.messages });
      return true;
    }
    case 'POST /send': {
      const body = await readBody(req, 4 * 1024 * 1024);
      const target = str(body.target, 'target');
      const text = str(body.text, 'text');
      sendJson(res, 200, await identity.send(target, text));
      return true;
    }
    case 'POST /join': {
      const body = await readBody(req);
      const room = str(body.room, 'room');
      sendJson(res, 200, await identity.join(room, body.wait === undefined ? 8 : Number(body.wait)));
      return true;
    }
    case 'POST /leave': {
      const body = await readBody(req);
      sendJson(res, 200, await identity.leave(str(body.room, 'room')));
      return true;
    }
    case 'GET /members': {
      sendJson(res, 200, await identity.members(url.searchParams.get('room') ?? ''));
      return true;
    }
    case 'GET /rooms': {
      sendJson(res, 200, await identity.rooms());
      return true;
    }
    case 'GET /names': {
      sendJson(res, 200, ctx.names());
      return true;
    }
    case 'POST /names': {
      if (!ctx.setNames) throw new HttpError(405, 'contact updates are not available');
      const body = await readBody(req);
      try { ctx.setNames(body.names); } catch (err) { throw new HttpError(400, err instanceof Error ? err.message : String(err)); }
      sendJson(res, 200, { ok: true, names: ctx.names() });
      return true;
    }
    default:
      return false;
  }
}

/** Write an error the way every route does. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const status = err instanceof HttpError ? err.status : 500;
  sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
}
