import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept a caller-supplied id only if it is a short, safe token (e.g. from Nginx); otherwise mint one.
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** pino-http `genReqId`: reuse a safe inbound id or create a UUID, and echo it on the response. */
export function genRequestId(req: IncomingMessage, res: ServerResponse): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Request id assigned by pino-http (`req.id`), or 'unknown' if logging middleware did not run. */
export function requestIdOf(req: IncomingMessage & { id?: unknown }): string {
  return typeof req.id === 'string' ? req.id : 'unknown';
}
