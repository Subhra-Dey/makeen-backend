import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import { MODULE_LABELS, ACTION_LABELS, type Action } from '../../shared';
import { IS_PUBLIC } from '../auth/actor';
import {
  ADMIN_ONLY,
  REQUIRE_ACTION,
  REQUIRE_MODULE,
  SIGNED_IN,
  type ModuleRule,
} from '../access/access.decorators';

/** Sections of the docs, in the order a reader meets them. */
export const DOC_TAGS: readonly { name: string; description: string }[] = [
  { name: 'Auth', description: 'CSRF token, sign-in, refresh, logout, change password with OTP' },
  { name: 'Me', description: 'The signed-in person, their plants and permission matrix' },
  { name: 'People', description: 'Admin panel › People and User logins' },
  {
    name: 'KEKA import',
    description: 'Load people from a KEKA CSV / Excel export or the KEKA API',
  },
  { name: 'Roles', description: 'Admin panel › Role access and Create new role' },
  { name: 'Designations', description: 'Admin panel › Designation map' },
  { name: 'Daily MIS', description: 'Daily plant report: table, form, workflow, queue, downloads' },
  {
    name: 'Monthly MIS',
    description:
      'Monthly plant report: cumulative summary, Block B, cylinders, workflow, downloads',
  },
  {
    name: 'Daily Exceptions',
    description: '13-point safety check: table with Lapse, form, SQC uploads, downloads',
  },
  { name: 'Plant master', description: 'Plant contract, details, activities and contract files' },
  { name: 'Audit', description: 'ISA / OISD / MEIPL audits and their observations' },
  {
    name: 'Licences',
    description: 'Statutory and Mandatory / Internal testing — status set by the system',
  },
  { name: 'Review Check', description: 'Read-only per-plant summary' },
  {
    name: 'Notifications',
    description: 'The inbox: notices, Read / Acknowledge / Reply, notes, bell stream',
  },
  {
    name: 'Notification control',
    description: 'Admin panel › Notification: event switches, last sends, custom notices',
  },
  { name: 'Health', description: 'Liveness and readiness' },
];

const HOW_TO = `
Internal API of the MAKEEN Energy India Facility Management Portal. **Development docs only** — the
API refuses to start with Swagger on in production.

**How to try a call here**
1. \`GET /api/auth/csrf\` → sets the \`mk_csrf\` cookie. This page copies it into the
   \`X-CSRF-Token\` header of every POST / PUT for you.
2. \`POST /api/auth/login\` with a demo email and \`SEED_DEFAULT_PASSWORD\` from \`api/.env\`.
   The session cookies are HttpOnly; the browser sends them with every call from this page.
   Sign-in needs Redis running (sign-in limits fail closed without it).
3. Call anything else. Each operation states its **Access** rule — the same rule the API enforces
   (module + capability, action switch, Admin only), plus the plant scope inside the service.

Errors always use \`{ code, message, details?, requestId }\`. Instants are UTC ISO strings;
business dates are \`yyyy-MM-dd\` (India calendar).`;

export function docsConfig(): Omit<OpenAPIObject, 'paths'> {
  const b = new DocumentBuilder()
    .setTitle('MAKEEN FM Portal API')
    .setDescription(HOW_TO.trim())
    .setVersion('0.1.0')
    .addCookieAuth('mk_at', { type: 'apiKey', in: 'cookie', name: 'mk_at' }, 'session')
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-CSRF-Token',
        description: 'Filled automatically from the mk_csrf cookie on this page.',
      },
      'csrf',
    );
  for (const t of DOC_TAGS) b.addTag(t.name, t.description);
  return b.build();
}

function ruleText(
  reflector: Reflector,
  handler: object,
  ctor: object,
): { text: string; secured: boolean } {
  const get = (key: string): unknown =>
    reflector.getAllAndOverride<unknown>(key, [handler as never, ctor as never]);
  if (get(IS_PUBLIC) === true)
    return { text: 'Public (no session; CSRF still applies to POST / PUT)', secured: false };
  const parts: string[] = [];
  const mod = get(REQUIRE_MODULE) as ModuleRule | undefined;
  if (mod) parts.push(`${MODULE_LABELS[mod.module]} · ${mod.capability}`);
  const action = get(REQUIRE_ACTION) as Action | undefined;
  if (action) parts.push(`action switch “${ACTION_LABELS[action]}”`);
  if (get(ADMIN_ONLY) === true) parts.push('Admin only');
  if (parts.length === 0 && get(SIGNED_IN) === true) parts.push('any signed-in person');
  return { text: parts.join(' + '), secured: true };
}

/**
 * Adds each operation's access rule (read from the same decorators AccessGuard enforces) to its
 * description, and marks secured operations with the session + CSRF schemes.
 */
export function describeAccess(app: INestApplication, doc: OpenAPIObject): OpenAPIObject {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const rules = new Map<string, { text: string; secured: boolean }>();
  for (const w of discovery.getControllers()) {
    const instance: unknown = w.instance;
    const ctor = w.metatype;
    if (!instance || typeof ctor !== 'function') continue;
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler: unknown = Reflect.get(proto, name);
      if (typeof handler === 'function') {
        rules.set(`${ctor.name}_${name}`, ruleText(reflector, handler, ctor));
      }
    }
  }
  for (const item of Object.values(doc.paths)) {
    for (const op of [item.get, item.post, item.put, item.patch, item.delete]) {
      if (!op?.operationId) continue;
      const rule = rules.get(op.operationId);
      if (!rule) continue;
      op.description = `**Access:** ${rule.text}${op.description ? `\n\n${op.description}` : ''}`;
      op.security = rule.secured ? [{ session: [], csrf: [] }] : [{ csrf: [] }];
    }
  }
  return doc;
}

/**
 * Runs inside Swagger UI (serialised into its init script): copies the readable mk_csrf cookie
 * into the X-CSRF-Token header and sends cookies, so “Try it out” works like the web app.
 */
export function csrfRequestInterceptor(req: {
  headers: Record<string, string>;
  credentials?: string;
}) {
  // Self-contained on purpose: this function's source text runs in the browser.
  const cookie = (globalThis as unknown as { document: { cookie: string } }).document.cookie;
  const m = /(?:^|;\s*)(?:__Host-)?mk_csrf=([^;]+)/.exec(cookie);
  if (m?.[1]) req.headers['X-CSRF-Token'] = decodeURIComponent(m[1]);
  req.credentials = 'same-origin';
  return req;
}
