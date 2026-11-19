import type { Request } from 'express';
import { requestIdOf } from '../request-id';

/** Who/where a request came from — recorded on audit rows and sessions. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export function requestContext(req: Request): RequestContext {
  const ua = req.headers['user-agent'];
  return {
    // Express resolves X-Forwarded-For via `trust proxy` (the web server is the only proxy).
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null,
    requestId: requestIdOf(req),
  };
}
