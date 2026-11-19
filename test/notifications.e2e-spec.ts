/**
 * Phase 10 notifications suite, end to end against real PostgreSQL.
 * Exit criterion: the daily IST job is idempotent — a second run raises nothing new.
 * Everything this suite creates (notices, send log rows, the July 2026 Daily MIS) is removed in
 * afterAll, and the event switches are restored, so later suites still see the seeded inbox.
 */
import { Client } from 'pg';
import { hashPassword } from '../src/common/crypto/password';
import { DailyNoticesJob } from '../src/modules/notifications/daily-notices';
import { EmailOutbox } from '../src/modules/notifications/email-outbox';
import {
  NOTIFICATION_MESSAGES,
  istToday,
  licenceStatus,
  observationUrgency,
  type CustomNoticePreview,
  type DailyMisDetail,
  type DailyNoticeRun,
  type EventConfigRow,
  type InboxPage,
  type NoticeView,
  type SendLogPage,
  type UnreadCount,
} from '../src/shared';
import { createE2EApp, type E2EApp } from './support/e2e-app';
import { call, ipFactory, signIn, type Browser } from './support/http';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com'; // Admin
const RAVI = 'ravi.kumar@makeenenergy.com'; // Plant Manager, Yediyur
const ASHA = 'asha.nair@makeenenergy.com'; // Maintenance Officer, Yediyur + Barhi
const GOPAL = 'gopal.das@makeenenergy.com'; // Staff, Barhi

let e: E2EApp;
let db: Client;
const ip = ipFactory(61);
const ids: Record<string, string> = {};
let yediyur = '';
let started = '';

async function as(email: string): Promise<Browser> {
  const s = await signIn(e, ip(), email, PASSWORD);
  expect(s.res.status).toBe(200);
  return s;
}

async function inbox(b: Browser, query = ''): Promise<InboxPage> {
  return (await call(b, 'get', `/api/notifications${query}`).expect(200)).body as InboxPage;
}

beforeAll(async () => {
  e = await createE2EApp();
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  started = (await db.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0]?.t ?? '';
  const hash = await hashPassword(PASSWORD, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false, login_status = 'ACTIVE'
      WHERE email = ANY($2)`,
    [hash, [ANITA, RAVI, ASHA, GOPAL]],
  );
  const u = await db.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = ANY($1)`,
    [[ANITA, RAVI, ASHA, GOPAL]],
  );
  for (const r of u.rows) ids[r.email] = r.id;
  yediyur =
    (await db.query<{ id: string }>(`SELECT id FROM plants WHERE code = 'HPY-011'`)).rows[0]?.id ??
    '';
  await e.flushRedis();
});

afterAll(async () => {
  await db.query(`DELETE FROM notification_send_log WHERE at >= $1::timestamptz`, [started]);
  await db.query(`DELETE FROM notifications WHERE created_at >= $1::timestamptz`, [started]);
  await db.query(
    `UPDATE notification_recipients SET read_at = NULL, acknowledged_at = NULL
      WHERE read_at >= $1::timestamptz`,
    [started],
  );
  await db.query(
    `UPDATE notification_recipients SET reply = NULL, replied_at = NULL
      WHERE replied_at >= $1::timestamptz`,
    [started],
  );
  await db.query(
    `UPDATE notification_event_config SET enabled = true, email_enabled = (event = 'PASSWORD_OTP')`,
  );
  await db.query(`DELETE FROM daily_mis WHERE report_date BETWEEN '2026-07-01' AND '2026-07-31'`);
  await db.end();
  await e.close();
});

describe('daily IST job (NOTIF-J1 — Phase 10 exit criterion: idempotent)', () => {
  let first: DailyNoticeRun;

  it('raises Licence Due / Expired and Audit overdue notices from the shared rules', async () => {
    const job = e.app.get(DailyNoticesJob);
    const today = istToday();
    first = await job.run(today);
    const lic = await db.query<{
      frequency: 'YEARLY' | 'NA';
      start_date: string | null;
      end_date: string | null;
      remind_before_days: number;
      n: number;
    }>(`SELECT l.frequency, l.start_date::text, l.end_date::text, l.remind_before_days,
               (SELECT count(*)::int FROM licence_remind_users r JOIN users u ON u.id = r.user_id
                 WHERE r.licence_id = l.id AND u.login_status = 'ACTIVE' AND u.working_status = 'WORKING') AS n
          FROM licences l JOIN plants p ON p.id = l.plant_id WHERE p.deleted_at IS NULL`);
    const status = lic.rows
      .filter((l) => l.n > 0)
      .map((l) =>
        licenceStatus(
          {
            frequency: l.frequency,
            startDate: l.start_date,
            endDate: l.end_date,
            remindBeforeDays: l.remind_before_days,
          },
          today,
        ),
      );
    expect(first.licenceDue).toBe(status.filter((s) => s === 'DUE').length);
    expect(first.licenceExpired).toBe(status.filter((s) => s === 'EXPIRED').length);
    const obs = await db.query<{
      status: 'PENDING' | 'COMPLIED';
      target_date: string | null;
      revised_target_date: string | null;
    }>(`SELECT o.status, o.target_date::text, o.revised_target_date::text FROM audit_observations o
          JOIN audits a ON a.id = o.audit_id JOIN plants p ON p.id = a.plant_id
         WHERE p.deleted_at IS NULL`);
    const overdue = obs.rows.filter(
      (o) =>
        observationUrgency(
          { status: o.status, targetDate: o.target_date, revisedTargetDate: o.revised_target_date },
          today,
        ) === 'OVERDUE',
    ).length;
    expect(first.auditOverdue).toBe(overdue);
    expect(first.licenceDue + first.licenceExpired + first.auditOverdue).toBeGreaterThan(0);
  });

  it('a second run — or a second server — raises nothing new', async () => {
    const job = e.app.get(DailyNoticesJob);
    const before = await db.query<{ n: number }>(`SELECT count(*)::int n FROM notifications`);
    const [a, b] = await Promise.all([job.run(), job.run()]);
    const after = await db.query<{ n: number }>(`SELECT count(*)::int n FROM notifications`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    for (const r of [a, b]) {
      expect(r).toMatchObject({ licenceDue: 0, licenceExpired: 0, auditOverdue: 0 });
      expect(r.alreadyRaised).toBe(first.licenceDue + first.licenceExpired + first.auditOverdue);
    }
    const admin = await as(ANITA);
    const viaApi = (await call(admin, 'post', '/api/notification-control/run-daily').expect(200))
      .body as DailyNoticeRun;
    expect(viaApi.licenceDue + viaApi.licenceExpired + viaApi.auditOverdue).toBe(0);
    const ravi = await as(RAVI);
    await call(ravi, 'post', '/api/notification-control/run-daily').expect(403);
  });

  it('licence notices reach the remind list with a link to the exact licence', async () => {
    const ravi = await as(RAVI);
    const page = await inbox(ravi, '?q=Licence&pageSize=100');
    const n = page.rows.find((r) => r.event === 'LICENCE_DUE');
    expect(n).toMatchObject({ canAcknowledge: true, canReply: false, link: { entity: 'licence' } });
  });
});

describe('report events (NOTIF-E1, E3)', () => {
  let rowId = '';

  it('Submit notifies the Plant Manager; a Draft notifies nobody', async () => {
    const asha = await as(ASHA);
    const ravi = await as(RAVI);
    const before = (
      (await call(ravi, 'get', '/api/notifications/unread-count').expect(200)).body as UnreadCount
    ).unread;
    const draft = (
      await call(asha, 'post', '/api/daily-mis')
        .send({ action: 'draft', plantId: yediyur, reportDate: '2026-07-05', values: {} })
        .expect(201)
    ).body as DailyMisDetail;
    expect(
      ((await call(ravi, 'get', '/api/notifications/unread-count').expect(200)).body as UnreadCount)
        .unread,
    ).toBe(before);
    const sub = (
      await call(asha, 'put', `/api/daily-mis/${draft.id}`)
        .send({
          action: 'submit',
          version: draft.version,
          plantId: yediyur,
          reportDate: '2026-07-05',
          values: {},
        })
        .expect(200)
    ).body as DailyMisDetail;
    rowId = sub.id;
    const page = await inbox(ravi, '?filter=UNREAD');
    expect(page.cards.unread).toBe(before + 1);
    expect(page.rows[0]).toMatchObject({
      event: 'REPORT_SUBMITTED',
      title: 'Daily MIS submitted — HPCL Yediyur 05-07-2026',
      sender: { name: 'Asha Nair' },
      link: { entity: 'daily_mis', id: rowId },
      canAcknowledge: true,
      readAt: null,
    });
  });

  it('Return notifies the person who entered it, with the reason', async () => {
    const ravi = await as(RAVI);
    const row = (await call(ravi, 'get', `/api/daily-mis/${rowId}`).expect(200))
      .body as DailyMisDetail;
    await call(ravi, 'post', `/api/daily-mis/${rowId}/return`)
      .send({ version: row.version, reason: 'Physical stock missing' })
      .expect(200);
    const asha = await as(ASHA);
    const page = await inbox(asha);
    expect(page.rows[0]).toMatchObject({
      event: 'REPORT_DECIDED',
      title: 'Daily MIS Returned — HPCL Yediyur 05-07-2026',
      canAcknowledge: false,
      canReply: false,
      link: { entity: 'daily_mis', id: rowId },
    });
    expect(page.rows[0]?.body).toContain('Physical stock missing');
  });
});

describe('inbox actions (NOTIF-1…6)', () => {
  it('Read only on open; Acknowledge is a separate click; Mark all as Read', async () => {
    const ravi = await as(RAVI);
    const page = await inbox(ravi, '?filter=TO_ACKNOWLEDGE');
    const target = page.rows[0] as NoticeView;
    expect(target.acknowledgedAt).toBeNull();
    const read = (await call(ravi, 'post', `/api/notifications/${target.id}/read`).expect(200))
      .body as NoticeView;
    expect(read.readAt).not.toBeNull();
    expect(read.acknowledgedAt).toBeNull();
    const ack = (
      await call(ravi, 'post', `/api/notifications/${target.id}/acknowledge`).expect(200)
    ).body as NoticeView;
    expect(ack.acknowledgedAt).not.toBeNull();
    const after = await inbox(ravi);
    expect(after.cards.toAcknowledge).toBe(page.cards.toAcknowledge - 1);
    await call(ravi, 'post', '/api/notifications/read-all').expect(200);
    expect(
      ((await call(ravi, 'get', '/api/notifications/unread-count').expect(200)).body as UnreadCount)
        .unread,
    ).toBe(0);
  });

  it("nobody can open or act on someone else's notice", async () => {
    const ravi = await as(RAVI);
    const mine = (await inbox(ravi)).rows[0] as NoticeView;
    const gopal = await as(GOPAL);
    await call(gopal, 'get', `/api/notifications/${mine.id}`).expect(404);
    await call(gopal, 'post', `/api/notifications/${mine.id}/read`).expect(404);
    await call(gopal, 'post', `/api/notifications/${mine.id}/acknowledge`).expect(404);
  });

  it('a notice without Acknowledge or Reply refuses them', async () => {
    const asha = await as(ASHA);
    const decided = (await inbox(asha)).rows.find((r) => r.event === 'REPORT_DECIDED');
    const ack = await call(
      asha,
      'post',
      `/api/notifications/${decided?.id ?? ''}/acknowledge`,
    ).expect(409);
    expect(ack.body.message).toBe(NOTIFICATION_MESSAGES.cannotAcknowledge);
    await call(asha, 'post', `/api/notifications/${decided?.id ?? ''}/reply`)
      .send({ text: 'ok' })
      .expect(409);
  });
});

describe('notes and replies (NOTIF-E8)', () => {
  it('a note can be replied to; the reply reaches the sender under Replies', async () => {
    const asha = await as(ASHA);
    const self = await call(asha, 'post', '/api/notifications/notes')
      .send({ toUserId: ids[ASHA], message: 'x' })
      .expect(400);
    expect(self.body.details[0].message).toBe(NOTIFICATION_MESSAGES.selfNote);
    await call(asha, 'post', '/api/notifications/notes')
      .send({ toUserId: ids[RAVI], message: 'Please check the July 5 report.' })
      .expect(201);
    const ravi = await as(RAVI);
    const page = await inbox(ravi);
    const note = page.rows[0] as NoticeView;
    expect(note).toMatchObject({
      category: 'PERSON',
      title: 'Note from Asha Nair',
      canReply: true,
      canAcknowledge: false,
    });
    expect(page.cards.awaitingReply).toBeGreaterThan(0);
    const replied = (
      await call(ravi, 'post', `/api/notifications/${note.id}/reply`)
        .send({ text: 'Checked — please add the stock.' })
        .expect(200)
    ).body as NoticeView;
    expect(replied).toMatchObject({ reply: 'Checked — please add the stock.' });
    expect(replied.readAt).not.toBeNull();
    expect((await inbox(ravi)).cards.awaitingReply).toBe(page.cards.awaitingReply - 1);
    const replies = await inbox(asha, '?filter=REPLIES');
    expect(replies.rows[0]).toMatchObject({
      isReply: true,
      body: 'Checked — please add the stock.',
      sender: { name: 'Ravi Kumar' },
      link: { entity: 'notification', id: note.id },
    });
  });
});

describe('Notification control (NOTIF-C1…C3, NOTIF-S1…S8)', () => {
  it('Off means nothing is sent (logged as Skipped); the OTP cannot be switched off', async () => {
    const admin = await as(ANITA);
    const rows = (await call(admin, 'get', '/api/notification-control/events').expect(200))
      .body as EventConfigRow[];
    expect(rows.map((r) => r.event)).toHaveLength(8);
    expect(rows.find((r) => r.event === 'PASSWORD_OTP')).toMatchObject({
      locked: true,
      emailEnabled: true,
    });
    const otp = await call(admin, 'put', '/api/notification-control/events/PASSWORD_OTP')
      .send({ enabled: false, emailEnabled: true })
      .expect(400);
    expect(otp.body.message).toBe(NOTIFICATION_MESSAGES.eventLocked);
    await call(admin, 'put', '/api/notification-control/events/PERSON_NOTE')
      .send({ enabled: false, emailEnabled: false })
      .expect(200);
    const asha = await as(ASHA);
    const res = await call(asha, 'post', '/api/notifications/notes')
      .send({ toUserId: ids[RAVI], message: 'This one is never delivered.' })
      .expect(201);
    expect(res.body).toEqual({ state: 'SKIPPED', reason: 'EVENT_OFF' });
    const log = (
      await call(admin, 'get', '/api/notification-control/log?category=PERSON').expect(200)
    ).body as SendLogPage;
    expect(log.rows[0]).toMatchObject({ state: 'SKIPPED', error: 'Event switched off' });
    await call(admin, 'put', '/api/notification-control/events/PERSON_NOTE')
      .send({ enabled: true, emailEnabled: false })
      .expect(200);
    const ravi = await as(RAVI);
    await call(ravi, 'get', '/api/notification-control/events').expect(403);
  });

  it('Email On queues an email that the outbox sends after commit', async () => {
    const admin = await as(ANITA);
    await call(admin, 'put', '/api/notification-control/events/PERSON_NOTE')
      .send({ enabled: true, emailEnabled: true })
      .expect(200);
    const asha = await as(ASHA);
    await call(asha, 'post', '/api/notifications/notes')
      .send({ toUserId: ids[RAVI], message: 'Email copy please.' })
      .expect(201);
    const queued = await db.query<{ state: string }>(
      `SELECT state FROM notification_send_log WHERE channel = 'EMAIL' AND at >= $1::timestamptz`,
      [started],
    );
    expect(queued.rows.map((r) => r.state)).toEqual(['QUEUED']);
    e.email.sent.length = 0;
    expect(await e.app.get(EmailOutbox).flush()).toBe(1);
    expect(e.email.sent).toEqual([
      expect.objectContaining({ to: RAVI, subject: 'Note from Asha Nair' }),
    ]);
    const sent = await db.query<{ state: string }>(
      `SELECT state FROM notification_send_log WHERE channel = 'EMAIL' AND at >= $1::timestamptz`,
      [started],
    );
    expect(sent.rows.map((r) => r.state)).toEqual(['SENT']);
    expect(await e.app.get(EmailOutbox).flush()).toBe(0);
    await call(admin, 'put', '/api/notification-control/events/PERSON_NOTE')
      .send({ enabled: true, emailEnabled: false })
      .expect(200);
  });

  it('custom notice: preview counts the audience, Send reaches exactly them', async () => {
    const admin = await as(ANITA);
    const missing = await call(admin, 'post', '/api/notification-control/custom/preview')
      .send({ customCategory: 'Safety', title: 'Drill', message: 'Now' })
      .expect(400);
    expect(missing.body.details[0].message).toBe(NOTIFICATION_MESSAGES.targetRequired);
    const body = {
      customCategory: 'Safety',
      roleId: 'ALL',
      plantId: yediyur,
      userIds: [ids[GOPAL]],
      title: 'Monsoon drill — Yediyur',
      message: 'Complete the drill this week.',
      canAcknowledge: true,
    };
    const sql = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM users u WHERE u.login_status = 'ACTIVE' AND u.working_status = 'WORKING'
          AND (u.id = $2 OR EXISTS (SELECT 1 FROM plant_assignments a WHERE a.user_id = u.id AND a.plant_id = $1))`,
      [yediyur, ids[GOPAL]],
    );
    const preview = (
      await call(admin, 'post', '/api/notification-control/custom/preview').send(body).expect(200)
    ).body as CustomNoticePreview;
    expect(preview.recipientCount).toBe(sql.rows[0]?.n);
    await call(admin, 'post', '/api/notification-control/custom').send(body).expect(201);
    const gopal = await as(GOPAL);
    const custom = await inbox(gopal, '?filter=CUSTOM');
    expect(custom.rows[0]).toMatchObject({
      category: 'CUSTOM',
      customCategory: 'Safety',
      title: 'Monsoon drill — Yediyur',
      canAcknowledge: true,
      sender: { name: 'Anita Sharma' },
    });
    const log = (
      await call(admin, 'get', '/api/notification-control/log?category=CUSTOM').expect(200)
    ).body as SendLogPage;
    expect(log.rows[0]).toMatchObject({
      title: 'Monsoon drill — Yediyur',
      recipientCount: preview.recipientCount,
      sentTo: 'All roles · HPCL Yediyur · 1 named people',
      state: 'SENT',
    });
    const asha = await as(ASHA);
    await call(asha, 'post', '/api/notification-control/custom').send(body).expect(403);
  });
});

describe('bell stream (NOTIF-J2)', () => {
  it('sends the unread count as a server-sent event', async () => {
    const ravi = await as(RAVI);
    const text = await new Promise<string>((resolve, reject) => {
      const req = call(ravi, 'get', '/api/notifications/stream')
        .buffer(false)
        .parse((res, cb) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (/data: .*\n/.test(data)) {
              resolve(data);
              (res as unknown as { destroy: () => void }).destroy();
            }
          });
          res.on('error', () => {
            cb(null, data);
          });
        });
      req.end((err) => {
        if (err && !String(err).includes('aborted'))
          reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    // e.g. "event: unread\nid: 1\ndata: {"unread":2}\n\n"
    expect(text).toMatch(/event: unread\nid: \d+\ndata: \{"unread":\d+\}\n/);
  });
});
