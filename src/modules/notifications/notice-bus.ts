import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type pg from 'pg';
import { Observable, Subject } from 'rxjs';
import { DB_POOL } from '../../infra/database.module';
import type { Tx } from '../../prisma/prisma.service';

/** Postgres channel that carries “these people have new notices”. */
export const NOTICE_CHANNEL = 'makeen_notices';
/** pg_notify payloads must stay under 8000 bytes; beyond that everyone refreshes. */
const MAX_PAYLOAD = 7000;

/**
 * Tells open bell streams (SSE) that a person's unread count changed (NOTIF-J2). The signal is a
 * Postgres NOTIFY sent inside the notice's transaction: Postgres delivers it only after COMMIT,
 * so a rolled-back change never rings a bell, and every API instance hears it.
 */
@Injectable()
export class NoticeBus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NoticeBus.name);
  private readonly changes = new Subject<'*' | ReadonlySet<string>>();
  private client: pg.PoolClient | null = null;
  private stopped = false;

  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleInit(): Promise<void> {
    await this.listen();
  }

  private async listen(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== NOTICE_CHANNEL) return;
        const payload = msg.payload ?? '*';
        this.changes.next(payload === '*' ? '*' : new Set(payload.split(',')));
      });
      client.on('error', (err) => {
        this.log.warn(`Notice listener lost: ${err.message}`);
        this.client = null;
        client.release(true);
        this.retry(5_000);
      });
      await client.query(`LISTEN ${NOTICE_CHANNEL}`);
      this.client = client;
    } catch (e: unknown) {
      // The bell still refreshes by polling every 30 s (NOTIF-J2 fallback).
      this.log.warn(`Notice listener unavailable: ${e instanceof Error ? e.message : String(e)}`);
      this.retry(15_000);
    }
  }

  /** Try again later; the timer never keeps the process alive on its own. */
  private retry(ms: number): void {
    if (this.stopped) return;
    setTimeout(() => {
      if (!this.stopped) void this.listen();
    }, ms).unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      await this.client.query(`UNLISTEN ${NOTICE_CHANNEL}`).catch(() => undefined);
      this.client.release();
      this.client = null;
    }
    this.changes.complete();
  }

  /** Signal, inside the transaction, that these people's notices changed. */
  async signal(tx: Tx, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    const joined = [...new Set(userIds)].join(',');
    const payload = joined.length > MAX_PAYLOAD ? '*' : joined;
    await tx.$executeRaw`SELECT pg_notify(${NOTICE_CHANNEL}, ${payload})`;
  }

  /** Emits each time this person's notices may have changed. */
  forUser(userId: string): Observable<void> {
    return new Observable<void>((sub) => {
      const s = this.changes.subscribe((who) => {
        if (who === '*' || who.has(userId)) sub.next();
      });
      return () => {
        s.unsubscribe();
      };
    });
  }
}
