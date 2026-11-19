/**
 * Phase 3 security suite, end to end against real PostgreSQL (and real Redis in CI).
 * Covers: login success / wrong / inactive / unmapped, cookies, /me, refresh rotation + reuse
 * detection, logout, token-version invalidation, CSRF, brute-force lockout, OTP (masking,
 * send limits, expiry, single use, supersede, attempt limit) and change password.
 */
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { hashPassword } from '../src/common/crypto/password';
import { AUTH_MESSAGES } from '../src/shared';
import { createE2EApp, type E2EApp } from './support/e2e-app';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com';
const RAVI = 'ravi.kumar@makeenenergy.com';
const ASHA = 'asha.nair@makeenenergy.com';
const MANOJ = 'manoj.singh@makeenenergy.com';
const SANJAY = 'sanjay.ghosh@makeenenergy.com';
const KIRAN = 'kiran.patel@makeenenergy.com';
const DEEPAK = 'deepak.sahu@makeenenergy.com';

let e: E2EApp;
let db: Client;
let ipCounter = 0;
const freshIp = (): string => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

type Agent = ReturnType<typeof request.agent>;

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}
function cookieValue(res: request.Response, name: string): string | undefined {
  const c = setCookies(res).find((x) => x.startsWith(`${name}=`));
  return c?.split(';')[0]?.slice(name.length + 1);
}

async function newAgent(): Promise<{ agent: Agent; csrf: string; ip: string }> {
  const agent = request.agent(e.app.getHttpServer());
  const ip = freshIp();
  const res = await agent.get('/api/auth/csrf').set('X-Forwarded-For', ip).expect(200);
  return { agent, csrf: String(res.body.csrfToken), ip };
}

async function post(
  a: { agent: Agent; csrf: string; ip: string },
  path: string,
  body: object,
): Promise<request.Response> {
  return a.agent.post(path).set('X-CSRF-Token', a.csrf).set('X-Forwarded-For', a.ip).send(body);
}

async function signIn(
  email: string,
  password = PASSWORD,
): Promise<{ agent: Agent; csrf: string; ip: string; res: request.Response }> {
  const a = await newAgent();
  const res = await post(a, '/api/auth/login', { email, password });
  // Login rotates the CSRF cookie.
  const rotated = cookieValue(res, 'mk_csrf');
  return { ...a, csrf: rotated ?? a.csrf, res };
}

beforeAll(async () => {
  expect(PASSWORD.length).toBeGreaterThan(7);
  e = await createE2EApp();
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  // Manoj (inactive, resigned) and Sanjay (unmapped designation) get a real password so the
  // tests can prove the "inactive" answer comes only AFTER the password is right.
  const pepper = process.env['PASSWORD_PEPPER'] ?? '';
  const hash = await hashPassword(PASSWORD, pepper);
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false WHERE email IN ($2, $3)`,
    [hash, MANOJ, SANJAY],
  );
  await db.query(`UPDATE users SET login_status = 'ACTIVE' WHERE email = $1`, [SANJAY]);
});

afterAll(async () => {
  await db.end();
  await e.close();
});

beforeEach(async () => {
  await e.flushRedis();
});

describe('login (UXV-1…4, SEC-1, SEC-3)', () => {
  it('rejects a POST without the CSRF token', async () => {
    const res = await request(e.app.getHttpServer() as App)
      .post('/api/auth/login')
      .send({ email: ANITA, password: PASSWORD })
      .expect(403);
    expect(res.body.code).toBe('CSRF_FAILED');
  });

  it('says exactly “Email or password is wrong.” for a wrong password and for an unknown email', async () => {
    const a = await newAgent();
    const wrong = await post(a, '/api/auth/login', {
      email: ANITA,
      password: 'Not-The-Password-1',
    }).then((r) => r);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: AUTH_MESSAGES.wrongCredentials,
    });
    const unknown = await post(a, '/api/auth/login', {
      email: 'nobody@makeenenergy.com',
      password: 'whatever-1',
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(AUTH_MESSAGES.wrongCredentials);
  });

  it('accepts only the MAKEEN email domain', async () => {
    const a = await newAgent();
    const res = await post(a, '/api/auth/login', { email: 'anita@gmail.com', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: 'email', message: AUTH_MESSAGES.emailNotMakeen }]);
  });

  it('says “Login is inactive.” only after the password is right', async () => {
    const a = await newAgent();
    const wrong = await post(a, '/api/auth/login', { email: MANOJ, password: 'Wrong-password-9' });
    expect(wrong.status).toBe(401);
    const right = await post(a, '/api/auth/login', { email: MANOJ, password: PASSWORD });
    expect(right.status).toBe(403);
    expect(right.body).toMatchObject({ code: 'LOGIN_INACTIVE', message: AUTH_MESSAGES.inactive });
  });

  it('refuses an unmapped designation (no role) even when the login is active (PPL-4)', async () => {
    const a = await newAgent();
    const res = await post(a, '/api/auth/login', { email: SANJAY, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(AUTH_MESSAGES.inactive);
  });

  it('signs in, sets HttpOnly SameSite=Strict cookies and scopes the refresh cookie', async () => {
    const { res } = await signIn(ANITA);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: ANITA, name: 'Anita Sharma' });
    const cookies = setCookies(res);
    const access = cookies.find((c) => c.startsWith('mk_at='));
    const refresh = cookies.find((c) => c.startsWith('mk_rt='));
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Strict/);
    expect(refresh).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/Path=\/api\/auth\/refresh/);
    // No token in the JSON body (nothing for scripts to store).
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/);
    const audit = await db.query(
      `SELECT count(*)::int n FROM audit_log a JOIN users u ON u.id = a.actor_id
        WHERE u.email = $1 AND a.action = 'LOGIN_SUCCESS'`,
      [ANITA],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('locks email + IP after 5 wrong passwords — even the right password is refused (SEC-6)', async () => {
    const a = await newAgent();
    for (let i = 0; i < 5; i++) {
      const r = await post(a, '/api/auth/login', {
        email: KIRAN,
        password: `Wrong-${String(i)}-pass`,
      });
      expect(r.status).toBe(401);
    }
    const locked = await post(a, '/api/auth/login', { email: KIRAN, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('LOGIN_LOCKED');
    expect(locked.body.details.retryAfterSeconds).toBeGreaterThan(800);
    // A different IP is not locked.
    const other = await signIn(KIRAN);
    expect(other.res.status).toBe(200);
  });
});

describe('instants are stored in UTC whatever the server time zone (TIME-1, D-61)', () => {
  it('Prisma-written timestamps agree with the database clock', async () => {
    await signIn(DEEPAK);
    const r = await db.query<{ drift: number; idle_days: number }>(
      `SELECT abs(extract(epoch FROM (u.last_login_at - now())))::int AS drift,
              round(extract(epoch FROM (s.idle_expires_at - s.created_at)) / 86400)::int AS idle_days
         FROM users u JOIN sessions s ON s.user_id = u.id
        WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [DEEPAK],
    );
    expect(r.rows[0]?.drift).toBeLessThan(60); // was 19 800 s (5 h 30 min) before D-61
    expect(r.rows[0]?.idle_days).toBe(7);
  });
});

describe('/api/me (SEC-11, SEC-12)', () => {
  it('returns the profile masked, the permission matrix and assigned plants (Admin)', async () => {
    const s = await signIn(ANITA);
    const me = await s.agent.get('/api/me').expect(200);
    expect(me.body.user).toMatchObject({
      email: ANITA,
      employeeCode: 'MEI-00412',
      phone: '98XXXXXX21',
      aadhaar: 'XXXX-XXXX-4821',
      designation: 'Manager — Facility Systems',
    });
    expect(me.body.isAdmin).toBe(true);
    expect(me.body.plants).toHaveLength(22);
    expect(me.body.access.modules.PEOPLE).toEqual(['VIEW', 'SUBMIT', 'DOWNLOAD', 'APPROVE']);
    expect(me.body.access.actions).toContain('REOPEN_APPROVED');
    expect(JSON.stringify(me.body)).not.toMatch(/9812345621|123456784821/);
  });

  it('gives the Yediyur Plant Manager their plant and bundle settings (D-10, D-11)', async () => {
    const s = await signIn(RAVI);
    const me = await s.agent.get('/api/me').expect(200);
    expect(me.body.isAdmin).toBe(false);
    expect((me.body.plants as { code: string }[]).map((p) => p.code)).toEqual(['HPY-011']);
    expect(me.body.plants[0].role.name).toBe('Plant Manager');
    expect(me.body.access.modules.DAILY_MIS).toEqual(['VIEW', 'DOWNLOAD', 'APPROVE']);
    expect(me.body.access.modules.MANAGEMENT_REVIEW).toEqual([]);
    expect(me.body.access.modules.PEOPLE).toEqual([]);
    expect(me.body.access.actions).toEqual(['RETURN']);
  });
});

describe('sessions (SEC-2, SEC-4, D-07)', () => {
  it('rotates the refresh token and detects reuse — replay revokes the whole family', async () => {
    const s = await signIn(ASHA);
    const firstRefresh = cookieValue(s.res, 'mk_rt');
    expect(firstRefresh).toBeDefined();
    const rotated = await s.agent.post('/api/auth/refresh').set('X-CSRF-Token', s.csrf).expect(204);
    const secondRefresh = cookieValue(rotated, 'mk_rt');
    expect(secondRefresh).toBeDefined();
    expect(secondRefresh).not.toBe(firstRefresh);
    await s.agent.get('/api/me').expect(200);

    // An attacker replays the first (already used) refresh token…
    await request(e.app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', [`mk_rt=${firstRefresh ?? ''}`, `mk_csrf=${s.csrf}`])
      .set('X-CSRF-Token', s.csrf)
      .expect(401);
    const reuse = await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action = 'SESSION_REUSE_DETECTED'`,
    );
    expect(reuse.rows[0].n).toBeGreaterThan(0);
    // …so the legitimate session dies too: its refresh and its access token are refused.
    await request(e.app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', [`mk_rt=${secondRefresh ?? ''}`, `mk_csrf=${s.csrf}`])
      .set('X-CSRF-Token', s.csrf)
      .expect(401);
    await s.agent.get('/api/me').expect(401);
  });

  it('logout revokes the session server-side: the old access token stops working', async () => {
    const s = await signIn(RAVI);
    const access = cookieValue(s.res, 'mk_at') ?? '';
    await s.agent.post('/api/auth/logout').set('X-CSRF-Token', s.csrf).expect(204);
    await request(e.app.getHttpServer())
      .get('/api/me')
      .set('Cookie', [`mk_at=${access}`])
      .expect(401);
  });

  it('a token-version bump (e.g. Admin deactivation) invalidates access tokens at once', async () => {
    const s = await signIn(KIRAN);
    await s.agent.get('/api/me').expect(200);
    await db.query(`UPDATE users SET token_version = token_version + 1 WHERE email = $1`, [KIRAN]);
    await e.flushRedis(); // the ≤ 60 s cache would otherwise delay this by up to a minute
    await s.agent.get('/api/me').expect(401);
    const refresh = await s.agent.post('/api/auth/refresh').set('X-CSRF-Token', s.csrf);
    expect(refresh.status).toBe(401);
  });

  it('rejects a forged / tampered access token', async () => {
    const s = await signIn(ANITA);
    const access = cookieValue(s.res, 'mk_at') ?? '';
    const [h, , sig] = access.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'x',
        sid: 'y',
        tv: 0,
        iat: 1,
        exp: 9999999999,
        iss: 'makeen-fm-api',
        aud: 'makeen-fm-web',
      }),
    ).toString('base64url');
    await request(e.app.getHttpServer())
      .get('/api/me')
      .set('Cookie', [`mk_at=${h ?? ''}.${forged}.${sig ?? ''}`])
      .expect(401);
  });
});

describe('change password with OTP (UXV-5, SEC-7, BEV-4)', () => {
  const NEW = 'Tumakuru-Carousel-7';

  it('lists only the masked KEKA mobile and email', async () => {
    const a = await newAgent();
    const res = await post(a, '/api/auth/password/options', { email: ASHA });
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([
      { channel: 'SMS', destination: '98XXXXXX45' },
      { channel: 'EMAIL', destination: 'as***@makeenenergy.com' },
    ]);
  });

  it('sends one OTP to the chosen channel only, limits resends, and stores only a hash', async () => {
    const a = await newAgent();
    const before = e.email.sent.length;
    const sent = await post(a, '/api/auth/password/otp', { email: ASHA, channel: 'SMS' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ channel: 'SMS', sentTo: '98XXXXXX45' });
    expect(sent.body.expiresAtIst).toMatch(/^\d{2}-\d{2}-\d{4}, \d{2}:\d{2} IST$/);
    expect(e.email.sent.length).toBe(before); // nothing went to email
    const code = e.sms.lastCode();
    const row = await db.query(
      `SELECT code_hash FROM otp_challenges o JOIN users u ON u.id = o.user_id WHERE u.email = $1 ORDER BY o.created_at DESC LIMIT 1`,
      [ASHA],
    );
    expect(row.rows[0].code_hash).toHaveLength(64);
    expect(row.rows[0].code_hash).not.toContain(code);
    const again = await post(a, '/api/auth/password/otp', { email: ASHA, channel: 'SMS' });
    expect(again.status).toBe(429);
    expect(again.body.message).toBe(AUTH_MESSAGES.otpWait);
  });

  it('a new OTP cancels the earlier one; an expired OTP fails; five wrong tries kill the OTP', async () => {
    const a = await newAgent();
    await post(a, '/api/auth/password/otp', { email: RAVI, channel: 'EMAIL' }).then((r) => {
      expect(r.status).toBe(200);
    });
    const first = e.email.lastCode();
    await e.flushRedis(); // skip the 60 s resend wait
    await post(a, '/api/auth/password/otp', { email: RAVI, channel: 'EMAIL' }).then((r) => {
      expect(r.status).toBe(200);
    });
    const second = e.email.lastCode();
    const body = (otp: string) => ({ email: RAVI, otp, newPassword: NEW, confirmPassword: NEW });

    // Superseded OTP is refused (unless the CSPRNG repeated the code).
    if (first !== second) {
      const stale = await post(a, '/api/auth/password', body(first));
      expect(stale.status).toBe(400);
      expect(stale.body.details[0]).toEqual({ path: 'otp', message: AUTH_MESSAGES.otpInvalid });
    }
    // Five wrong attempts invalidate the current OTP — after that even the right code fails.
    const wrong = second === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++)
      expect((await post(a, '/api/auth/password', body(wrong))).status).toBe(400);
    expect((await post(a, '/api/auth/password', body(second))).status).toBe(400);

    // Expiry: a fresh OTP pushed past its 10 minutes is refused.
    await e.flushRedis();
    await post(a, '/api/auth/password/otp', { email: RAVI, channel: 'EMAIL' });
    const third = e.email.lastCode();
    await db.query(
      `UPDATE otp_challenges SET expires_at = now() - interval '1 second'
        WHERE user_id = (SELECT id FROM users WHERE email = $1) AND used_at IS NULL AND superseded_at IS NULL`,
      [RAVI],
    );
    expect((await post(a, '/api/auth/password', body(third))).status).toBe(400);
  });

  it('rejects weak passwords and a mismatched confirmation', async () => {
    const a = await newAgent();
    const common = await post(a, '/api/auth/password', {
      email: ASHA,
      otp: '123456',
      newPassword: 'Password123!',
      confirmPassword: 'Password123!',
    });
    expect(common.status).toBe(400);
    expect(common.body.details).toEqual(
      expect.arrayContaining([{ path: 'newPassword', message: AUTH_MESSAGES.passwordCommon }]),
    );
    const mismatch = await post(a, '/api/auth/password', {
      email: ASHA,
      otp: '123456',
      newPassword: NEW,
      confirmPassword: `${NEW}x`,
    });
    expect(mismatch.body.details).toEqual(
      expect.arrayContaining([{ path: 'confirmPassword', message: AUTH_MESSAGES.confirmMismatch }]),
    );
  });

  it('updates the password once, ends every session, and the OTP cannot be reused', async () => {
    const old = await signIn(ASHA);
    await old.agent.get('/api/me').expect(200);
    const a = await newAgent();
    await post(a, '/api/auth/password/otp', { email: ASHA, channel: 'EMAIL' }).then((r) => {
      expect(r.status).toBe(200);
    });
    const code = e.email.lastCode();
    const ok = await post(a, '/api/auth/password', {
      email: ASHA,
      otp: code,
      newPassword: NEW,
      confirmPassword: NEW,
    });
    expect(ok.status).toBe(200);
    // Single use.
    const reuse = await post(a, '/api/auth/password', {
      email: ASHA,
      otp: code,
      newPassword: `${NEW}!`,
      confirmPassword: `${NEW}!`,
    });
    expect(reuse.status).toBe(400);
    // Earlier sessions are gone; the old password no longer works; the new one does.
    await e.flushRedis();
    await old.agent.get('/api/me').expect(401);
    expect((await signIn(ASHA)).res.status).toBe(401);
    expect((await signIn(ASHA, NEW)).res.status).toBe(200);
    const changed = await db.query(
      `SELECT count(*)::int n FROM audit_log a JOIN users u ON u.id = a.entity_id::uuid WHERE u.email = $1 AND a.action = 'PASSWORD_CHANGED'`,
      [ASHA],
    );
    expect(changed.rows[0].n).toBe(1);
    // Neither the OTP nor any password ever reaches the audit trail.
    const leak = await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE after::text LIKE $1 OR after::text LIKE $2`,
      [`%${code}%`, `%${NEW}%`],
    );
    expect(leak.rows[0].n).toBe(0);
  });

  it('forces the OTP flow after an Admin reset (mustSetPassword)', async () => {
    await db.query(`UPDATE users SET must_set_password = true WHERE email = $1`, [KIRAN]);
    await e.flushRedis();
    const s = await signIn(KIRAN);
    expect(s.res.status).toBe(403);
    expect(s.res.body).toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: AUTH_MESSAGES.passwordChangeRequired,
    });
  });
});
