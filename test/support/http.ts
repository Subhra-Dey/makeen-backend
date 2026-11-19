import request from 'supertest';
import type { E2EApp } from './e2e-app';

export type Agent = ReturnType<typeof request.agent>;

/** A browser-like client: cookie jar, CSRF token, and its own IP (auth limits are per IP). */
export interface Browser {
  agent: Agent;
  csrf: string;
  ip: string;
}

let ipCounter = 0;
/** Distinct client IPs per suite so per-IP auth limits never couple tests. */
export function ipFactory(prefix: number): () => string {
  return () => {
    ipCounter += 1;
    return `10.${prefix}.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
  };
}

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

export function cookieValue(res: request.Response, name: string): string | undefined {
  const c = setCookies(res).find((x) => x.startsWith(`${name}=`));
  return c?.split(';')[0]?.slice(name.length + 1);
}

export async function browser(e: E2EApp, ip: string): Promise<Browser> {
  const agent = request.agent(e.app.getHttpServer());
  const res = await agent.get('/api/auth/csrf').set('X-Forwarded-For', ip).expect(200);
  return { agent, csrf: String(res.body.csrfToken), ip };
}

export async function signIn(
  e: E2EApp,
  ip: string,
  email: string,
  password: string,
): Promise<Browser & { res: request.Response }> {
  const b = await browser(e, ip);
  const res = await b.agent
    .post('/api/auth/login')
    .set('X-CSRF-Token', b.csrf)
    .set('X-Forwarded-For', ip)
    .send({ email, password });
  return { ...b, csrf: cookieValue(res, 'mk_csrf') ?? b.csrf, res };
}

type Method = 'get' | 'post' | 'put' | 'delete';

/** A request from the browser, with its CSRF header and IP. */
export function call(b: Browser, method: Method, path: string): request.Test {
  return b.agent[method](path).set('X-CSRF-Token', b.csrf).set('X-Forwarded-For', b.ip);
}
