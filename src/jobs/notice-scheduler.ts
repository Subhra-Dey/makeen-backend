import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DailyNoticesJob } from '../modules/notifications/daily-notices';
import { EmailOutbox } from '../modules/notifications/email-outbox';
import { addDays, istToday } from '../shared';

const OUTBOX_EVERY_MS = 15_000;

/** Next instant of `hh:mm` India time after `now` (NOTIF-J1: 07:00 IST). */
export function nextIstRun(now: Date, hhmm: string): Date {
  const today = istToday(now);
  const at = (day: string): Date => new Date(`${day}T${hhmm}:00+05:30`);
  const first = at(today);
  return first.getTime() > now.getTime() ? first : at(addDays(today, 1));
}

/**
 * In-process scheduler (D-117): the daily notice job at 07:00 IST and the email outbox every
 * 15 s. No Redis is needed — every scheduled notice is idempotent (dedupe keys) and the outbox
 * claims rows with SKIP LOCKED, so several API servers can all run it safely. On boot it also
 * catches up today's run (harmless when it already ran). Off with JOBS_ENABLED=false.
 */
@Injectable()
export class NoticeScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(NoticeScheduler.name);
  private daily: NodeJS.Timeout | null = null;
  private outbox: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly job: DailyNoticesJob,
    private readonly mail: EmailOutbox,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.JOBS_ENABLED) return;
    void this.runDaily();
    this.scheduleDaily();
    this.outbox = setInterval(() => void this.flush(), OUTBOX_EVERY_MS);
    this.outbox.unref();
  }

  onApplicationShutdown(): void {
    if (this.daily) clearTimeout(this.daily);
    if (this.outbox) clearInterval(this.outbox);
  }

  private scheduleDaily(): void {
    const next = nextIstRun(new Date(), this.env.NOTICE_DAILY_AT);
    this.daily = setTimeout(() => {
      void this.runDaily().finally(() => {
        this.scheduleDaily();
      });
    }, next.getTime() - Date.now());
    this.daily.unref();
  }

  private async runDaily(): Promise<void> {
    try {
      await this.job.run();
    } catch (e: unknown) {
      this.log.error(`Daily notices failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while ((await this.mail.flush()) > 0) {
        /* keep sending while there is a backlog */
      }
    } catch (e: unknown) {
      this.log.error(`Email outbox failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.flushing = false;
    }
  }
}
