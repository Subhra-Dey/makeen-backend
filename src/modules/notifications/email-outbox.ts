import { Inject, Injectable, Logger } from '@nestjs/common';
import { EMAIL_PROVIDER, type EmailProvider } from '../../infra/messaging/messaging';
import { PrismaService } from '../../prisma/prisma.service';
import { SYSTEM_ACTOR } from './daily-notices';

const BATCH = 20;

/**
 * Email outbox (NOTIF-C2, D-118). A notice whose event has Email On is logged QUEUED in the same
 * transaction as the notice; this dispatcher sends it after commit. Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so several API servers never send the same email twice.
 */
@Injectable()
export class EmailOutbox {
  private readonly log = new Logger(EmailOutbox.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Send up to one batch of queued emails; returns how many log rows were handled. */
  async flush(): Promise<number> {
    return this.prisma.runAs(SYSTEM_ACTOR, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; notification_id: string | null }[]>`
        SELECT id, notification_id FROM notification_send_log
         WHERE state = 'QUEUED' AND channel = 'EMAIL'
         ORDER BY at
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        const n = row.notification_id
          ? await tx.notification.findUnique({
              where: { id: row.notification_id },
              include: { recipients: { include: { user: { select: { email: true } } } } },
            })
          : null;
        if (!n) {
          await tx.notificationSendLog.update({
            where: { id: row.id },
            data: { state: 'SKIPPED', error: 'Notice no longer exists' },
          });
          continue;
        }
        let failed = 0;
        let lastError = '';
        for (const r of n.recipients) {
          try {
            await this.email.send({
              to: r.user.email,
              subject: n.title,
              text: `${n.body}\n\nOpen the MAKEEN FM Portal to see it.`,
            });
          } catch (e: unknown) {
            failed += 1;
            lastError = e instanceof Error ? e.message : String(e);
          }
        }
        await tx.notificationSendLog.update({
          where: { id: row.id },
          data:
            failed === 0
              ? { state: 'SENT', at: new Date() }
              : {
                  state: 'FAILED',
                  at: new Date(),
                  error:
                    `${String(failed)} of ${String(n.recipients.length)} failed: ${lastError}`.slice(
                      0,
                      500,
                    ),
                },
        });
        if (failed > 0) this.log.warn(`Email for notice ${n.id}: ${String(failed)} failed`);
      }
      return rows.length;
    });
  }
}
