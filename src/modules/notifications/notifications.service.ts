import { HttpStatus, Injectable } from '@nestjs/common';
import { namesOf, personRef } from '../../common/db/people-names';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  NOTIFICATION_MESSAGES,
  type InboxCards,
  type InboxPage,
  type InboxQuery,
  type NoticeView,
  type NotificationCategory,
  type NotificationEvent,
  type PersonOption,
  type UnreadCount,
} from '../../shared';
import { NoticeBus } from './notice-bus';

/** One notice to raise. Recipients are user ids; only active, working people receive it. */
export interface NoticeInput {
  category: NotificationCategory;
  /** System and person notices name their event (it can be switched off); custom notices don't. */
  event: NotificationEvent | null;
  customCategory?: string | null;
  title: string;
  body: string;
  senderId?: string | null;
  plantId?: string | null;
  link?: { entity: string; id: string } | null;
  recipients: readonly string[];
  canAcknowledge?: boolean;
  canReply?: boolean;
  /** Idempotency key: a second notice with the same key is never raised (NOTIF-J1). */
  dedupeKey?: string;
  /** “Sent to” text for the Last sends log, e.g. “Plant Manager, HPCL Yediyur”. */
  sentTo: string;
}

export type NoticeOutcome =
  | { state: 'SENT'; id: string; recipients: number }
  | { state: 'SKIPPED'; reason: 'EVENT_OFF' | 'NO_RECIPIENTS' }
  | { state: 'DUPLICATE' };

const notFound = (): AppError =>
  new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, NOTIFICATION_MESSAGES.notFound);
const conflict = (message: string): AppError =>
  new AppError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);

const noticeInclude = { notification: true } as const;

/**
 * The notifications engine and the inbox (spec “Notifications”).
 *
 * `notify` is called INSIDE the caller's transaction, so a notice exists exactly when the change
 * that raised it commits. It honours the event switch (Off = nothing sent, logged as Skipped),
 * writes the Last sends log, queues an email when the event's Email switch is On (sent by the
 * outbox after commit), and signals open bells. Inbox reads and actions only ever touch the
 * signed-in person's own recipient rows.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: NoticeBus,
  ) {}

  // ───────────────────────────────────────────── engine

  async notify(tx: Tx, n: NoticeInput): Promise<NoticeOutcome> {
    const config = n.event
      ? await tx.notificationEventConfig.findUnique({ where: { event: n.event } })
      : null;
    if (n.event && config && !config.enabled) {
      await this.log(tx, null, n, 0, 'IN_APP', 'SKIPPED', 'Event switched off');
      return { state: 'SKIPPED', reason: 'EVENT_OFF' };
    }
    const people = await tx.user.findMany({
      where: {
        id: { in: [...new Set(n.recipients)] },
        loginStatus: 'ACTIVE',
        workingStatus: 'WORKING',
      },
      select: { id: true },
    });
    if (people.length === 0) {
      await this.log(tx, null, n, 0, 'IN_APP', 'SKIPPED', 'No active recipient');
      return { state: 'SKIPPED', reason: 'NO_RECIPIENTS' };
    }
    // ON CONFLICT keeps the transaction healthy when a scheduled notice was raised before.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO notifications (id, category, event, custom_category, title, body, sender_id,
                                 link_entity, link_id, plant_id, can_acknowledge, can_reply,
                                 dedupe_key, created_at)
      VALUES (gen_random_uuid(), ${n.category}::"NotificationCategory",
              ${n.event}::"NotificationEvent", ${n.customCategory ?? null}, ${n.title}, ${n.body},
              ${n.senderId ?? null}::uuid, ${n.link?.entity ?? null}, ${n.link?.id ?? null}::uuid,
              ${n.plantId ?? null}::uuid, ${n.canAcknowledge ?? false}, ${n.canReply ?? false},
              ${n.dedupeKey ?? null}, now())
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`;
    const id = inserted[0]?.id;
    if (!id) return { state: 'DUPLICATE' };
    const userIds = people.map((p) => p.id);
    await tx.notificationRecipient.createMany({
      data: userIds.map((userId) => ({ notificationId: id, userId })),
    });
    await this.log(tx, id, n, userIds.length, 'IN_APP', 'SENT', null);
    if (config?.emailEnabled) await this.log(tx, id, n, userIds.length, 'EMAIL', 'QUEUED', null);
    await this.bus.signal(tx, userIds);
    return { state: 'SENT', id, recipients: userIds.length };
  }

  private async log(
    tx: Tx,
    notificationId: string | null,
    n: NoticeInput,
    recipientCount: number,
    channel: 'IN_APP' | 'EMAIL',
    state: 'SENT' | 'SKIPPED' | 'QUEUED',
    error: string | null,
  ): Promise<void> {
    await tx.notificationSendLog.create({
      data: {
        notificationId,
        category: n.category,
        title: n.title.slice(0, 200),
        sentTo: n.sentTo.slice(0, 300),
        recipientCount,
        channel,
        state,
        error,
      },
    });
  }

  /** The Plant Manager(s) of a plant: its manager and anyone holding Plant Manager on it. */
  async plantManagers(tx: Tx, plantId: string): Promise<string[]> {
    const plant = await tx.plant.findUnique({
      where: { id: plantId },
      select: { managerId: true },
    });
    const assigned = await tx.plantAssignment.findMany({
      where: { plantId, role: { name: 'Plant Manager' } },
      select: { userId: true },
    });
    return [...new Set([...(plant ? [plant.managerId] : []), ...assigned.map((a) => a.userId)])];
  }

  // ───────────────────────────────────────────── report events (1, 3)

  /** Event 1: a Daily MIS / Monthly MIS / Daily Exception was submitted → the Plant Manager. */
  async reportSubmitted(
    tx: Tx,
    r: {
      what: 'Daily MIS' | 'Monthly MIS' | 'Daily Exception';
      entity: 'daily_mis' | 'monthly_mis' | 'daily_exception';
      id: string;
      plantId: string;
      period: string;
      senderId: string;
      detail?: string;
      dedupeKey?: string;
    },
  ): Promise<NoticeOutcome> {
    const plant = await tx.plant.findUnique({ where: { id: r.plantId }, select: { name: true } });
    const name = plant?.name ?? 'the plant';
    return this.notify(tx, {
      category: 'SYSTEM',
      event: 'REPORT_SUBMITTED',
      title: `${r.what} submitted — ${name} ${r.period}`,
      body: `${r.what} for ${name}, ${r.period} has been submitted${r.what === 'Daily Exception' ? '' : ' for approval'}.${r.detail ? ` ${r.detail}` : ''}`,
      senderId: r.senderId,
      plantId: r.plantId,
      link: { entity: r.entity, id: r.id },
      recipients: await this.plantManagers(tx, r.plantId),
      canAcknowledge: true,
      ...(r.dedupeKey ? { dedupeKey: r.dedupeKey } : {}),
      sentTo: `Plant Manager, ${name}`,
    });
  }

  /** Event 3: a day or month was Approved or Returned → the person who entered it. */
  async reportDecided(
    tx: Tx,
    r: {
      what: 'Daily MIS' | 'Monthly MIS';
      entity: 'daily_mis' | 'monthly_mis';
      id: string;
      plantId: string;
      period: string;
      enteredById: string;
      deciderId: string;
      decision: 'Approved' | 'Returned';
      reason?: string;
    },
  ): Promise<NoticeOutcome> {
    const [plant, who] = await Promise.all([
      tx.plant.findUnique({ where: { id: r.plantId }, select: { name: true } }),
      tx.user.findUnique({ where: { id: r.enteredById }, select: { name: true } }),
    ]);
    const name = plant?.name ?? 'the plant';
    return this.notify(tx, {
      category: 'SYSTEM',
      event: 'REPORT_DECIDED',
      title: `${r.what} ${r.decision} — ${name} ${r.period}`,
      body:
        r.decision === 'Approved'
          ? `${r.what} for ${name}, ${r.period} was approved and is now locked.`
          : `${r.what} for ${name}, ${r.period} was returned for correction. Reason: ${r.reason ?? '—'}`,
      senderId: r.deciderId,
      plantId: r.plantId,
      link: { entity: r.entity, id: r.id },
      recipients: [r.enteredById],
      sentTo: who?.name ?? 'Entered by',
    });
  }

  /**
   * Event 6: plant or access assigned or turned off → that person and the Plant Manager(s) of the
   * plants concerned (PPL-1). `changes` are plain sentences, e.g. “Added to HPCL Barhi”.
   */
  async accessChanged(
    tx: Tx,
    a: { userId: string; actorId: string; changes: readonly string[]; plantIds: readonly string[] },
  ): Promise<void> {
    if (a.changes.length === 0) return;
    const person = await tx.user.findUnique({ where: { id: a.userId }, select: { name: true } });
    const name = person?.name ?? 'A person';
    const body = a.changes.join('\n');
    await this.notify(tx, {
      category: 'SYSTEM',
      event: 'ACCESS_CHANGED',
      title: 'Your access changed',
      body,
      senderId: a.actorId,
      recipients: [a.userId],
      sentTo: name,
    });
    const managers = new Set<string>();
    for (const plantId of new Set(a.plantIds))
      for (const m of await this.plantManagers(tx, plantId)) if (m !== a.userId) managers.add(m);
    if (managers.size > 0)
      await this.notify(tx, {
        category: 'SYSTEM',
        event: 'ACCESS_CHANGED',
        title: `Access changed — ${name}`,
        body,
        senderId: a.actorId,
        ...(a.plantIds.length === 1 ? { plantId: a.plantIds[0] ?? null } : {}),
        recipients: [...managers],
        sentTo: 'Plant Manager',
      });
  }

  // ───────────────────────────────────────────── inbox

  private toView(
    r: Prisma.NotificationRecipientGetPayload<{ include: typeof noticeInclude }>,
    names: Map<string, string>,
    plants: Map<string, { id: string; name: string; code: string }>,
  ): NoticeView {
    const n = r.notification;
    return {
      id: n.id,
      category: n.category,
      event: n.event,
      customCategory: n.customCategory,
      title: n.title,
      body: n.body,
      sender: personRef(names, n.senderId),
      plant: n.plantId ? (plants.get(n.plantId) ?? null) : null,
      link: n.linkEntity && n.linkId ? { entity: n.linkEntity, id: n.linkId } : null,
      createdAt: n.createdAt.toISOString(),
      readAt: r.readAt?.toISOString() ?? null,
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      canAcknowledge: n.canAcknowledge,
      canReply: n.canReply,
      reply: r.reply,
      repliedAt: r.repliedAt?.toISOString() ?? null,
      isReply: n.linkEntity === 'notification',
    };
  }

  private async views(
    tx: Tx,
    rows: Prisma.NotificationRecipientGetPayload<{ include: typeof noticeInclude }>[],
  ): Promise<NoticeView[]> {
    const names = await namesOf(
      tx,
      rows.map((r) => r.notification.senderId),
    );
    const plantIds = [
      ...new Set(rows.map((r) => r.notification.plantId).filter((p): p is string => !!p)),
    ];
    // Plant names are labels on the user's own notices, read as the system (no plant data).
    const plants = plantIds.length
      ? await tx.plant.findMany({
          where: { id: { in: plantIds } },
          select: { id: true, name: true, code: true },
        })
      : [];
    const byId = new Map(plants.map((p) => [p.id, p]));
    return rows.map((r) => this.toView(r, names, byId));
  }

  /** Read as the system: notices are the person's own rows; plant names are only labels. */
  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: '00000000-0000-0000-0000-000000000000', isAdmin: true }, fn);
  }

  async inbox(userId: string, q: InboxQuery): Promise<InboxPage> {
    return this.system(async (tx) => {
      const base: Prisma.NotificationRecipientWhereInput = { userId };
      const where: Prisma.NotificationRecipientWhereInput = {
        ...base,
        ...(q.filter === 'UNREAD' ? { readAt: null } : {}),
        ...(q.filter === 'TO_ACKNOWLEDGE'
          ? { acknowledgedAt: null, notification: { canAcknowledge: true } }
          : {}),
        ...(q.filter === 'REPLIES' ? { notification: { linkEntity: 'notification' } } : {}),
        ...(q.filter === 'CUSTOM' ? { notification: { category: 'CUSTOM' } } : {}),
        ...(q.q
          ? {
              AND: [
                {
                  notification: {
                    OR: [
                      { title: { contains: q.q, mode: 'insensitive' } },
                      { body: { contains: q.q, mode: 'insensitive' } },
                    ],
                  },
                },
              ],
            }
          : {}),
      };
      const [rows, total, cards] = await Promise.all([
        tx.notificationRecipient.findMany({
          where,
          include: noticeInclude,
          orderBy: [{ notification: { createdAt: 'desc' } }, { notificationId: 'desc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        tx.notificationRecipient.count({ where }),
        this.cards(tx, userId),
      ]);
      return {
        rows: await this.views(tx, rows),
        total,
        page: q.page,
        pageSize: q.pageSize,
        cards,
      };
    });
  }

  private async cards(tx: Tx, userId: string): Promise<InboxCards> {
    const [all, unread, toAcknowledge, awaitingReply] = await Promise.all([
      tx.notificationRecipient.count({ where: { userId } }),
      tx.notificationRecipient.count({ where: { userId, readAt: null } }),
      tx.notificationRecipient.count({
        where: { userId, acknowledgedAt: null, notification: { canAcknowledge: true } },
      }),
      tx.notificationRecipient.count({
        where: { userId, repliedAt: null, notification: { canReply: true } },
      }),
    ]);
    return { all, unread, toAcknowledge, awaitingReply };
  }

  async unread(userId: string): Promise<UnreadCount> {
    const unread = await this.system((tx) =>
      tx.notificationRecipient.count({ where: { userId, readAt: null } }),
    );
    return { unread };
  }

  async get(userId: string, id: string): Promise<NoticeView> {
    return this.system(async (tx) => {
      const r = await tx.notificationRecipient.findUnique({
        where: { notificationId_userId: { notificationId: id, userId } },
        include: noticeInclude,
      });
      if (!r) throw notFound();
      const [view] = await this.views(tx, [r]);
      if (!view) throw notFound();
      return view;
    });
  }

  /** Read (NOTIF-2): set only by an explicit open, never assumed (NOTIF-4). */
  async markRead(userId: string, id: string): Promise<NoticeView> {
    await this.system(async (tx) => {
      const n = await tx.notificationRecipient.updateMany({
        where: { notificationId: id, userId, readAt: null },
        data: { readAt: new Date() },
      });
      if (n.count === 0 && !(await this.own(tx, userId, id))) throw notFound();
      await this.bus.signal(tx, [userId]);
    });
    return this.get(userId, id);
  }

  async markAllRead(userId: string): Promise<UnreadCount> {
    await this.system(async (tx) => {
      await tx.notificationRecipient.updateMany({
        where: { userId, readAt: null },
        data: { readAt: new Date() },
      });
      await this.bus.signal(tx, [userId]);
    });
    return { unread: 0 };
  }

  private own(tx: Tx, userId: string, id: string) {
    return tx.notificationRecipient.findUnique({
      where: { notificationId_userId: { notificationId: id, userId } },
      include: { notification: true },
    });
  }

  /** Acknowledge (NOTIF-3): a separate click; it also counts as Read. */
  async acknowledge(userId: string, id: string): Promise<NoticeView> {
    await this.system(async (tx) => {
      const r = await this.own(tx, userId, id);
      if (!r) throw notFound();
      if (!r.notification.canAcknowledge) throw conflict(NOTIFICATION_MESSAGES.cannotAcknowledge);
      if (r.acknowledgedAt) return;
      const now = new Date();
      await tx.notificationRecipient.update({
        where: { notificationId_userId: { notificationId: id, userId } },
        data: { acknowledgedAt: now, readAt: r.readAt ?? now },
      });
      await this.bus.signal(tx, [userId]);
    });
    return this.get(userId, id);
  }

  /** Reply (NOTIF-3): only where Reply applies; the reply reaches the sender as a new note. */
  async reply(userId: string, id: string, text: string): Promise<NoticeView> {
    await this.system(async (tx) => {
      const r = await this.own(tx, userId, id);
      if (!r) throw notFound();
      if (!r.notification.canReply) throw conflict(NOTIFICATION_MESSAGES.cannotReply);
      const now = new Date();
      await tx.notificationRecipient.update({
        where: { notificationId_userId: { notificationId: id, userId } },
        data: { reply: text, repliedAt: now, readAt: r.readAt ?? now },
      });
      const senderId = r.notification.senderId;
      if (senderId && senderId !== userId) {
        const me = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
        const sender = await tx.user.findUnique({
          where: { id: senderId },
          select: { name: true },
        });
        await this.notify(tx, {
          category: 'PERSON',
          event: 'PERSON_NOTE',
          title: `Reply from ${me?.name ?? 'a colleague'}: ${r.notification.title}`.slice(0, 200),
          body: text,
          senderId: userId,
          plantId: r.notification.plantId,
          link: { entity: 'notification', id },
          recipients: [senderId],
          canReply: true,
          sentTo: sender?.name ?? 'Sender',
        });
      }
      await this.bus.signal(tx, [userId]);
    });
    return this.get(userId, id);
  }

  /** Event 8: a written note to a named person — Read, Reply. */
  async sendNote(userId: string, toUserId: string, message: string): Promise<NoticeOutcome> {
    if (toUserId === userId)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        NOTIFICATION_MESSAGES.selfNote,
        [{ path: 'toUserId', message: NOTIFICATION_MESSAGES.selfNote }],
      );
    return this.system(async (tx) => {
      const [me, to] = await Promise.all([
        tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
        tx.user.findFirst({
          where: { id: toUserId, loginStatus: 'ACTIVE', workingStatus: 'WORKING' },
          select: { name: true },
        }),
      ]);
      if (!to)
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_FAILED,
          NOTIFICATION_MESSAGES.personRequired,
          [{ path: 'toUserId', message: NOTIFICATION_MESSAGES.personRequired }],
        );
      return this.notify(tx, {
        category: 'PERSON',
        event: 'PERSON_NOTE',
        title: `Note from ${me?.name ?? 'a colleague'}`,
        body: message,
        senderId: userId,
        recipients: [toUserId],
        canReply: true,
        sentTo: to.name,
      });
    });
  }

  /** People a note can go to: active, working colleagues (name and designation only). */
  async people(userId: string, q: string): Promise<PersonOption[]> {
    return this.system(async (tx) => {
      const users = await tx.user.findMany({
        where: {
          id: { not: userId },
          loginStatus: 'ACTIVE',
          workingStatus: 'WORKING',
          ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
        },
        select: { id: true, name: true, designation: true },
        orderBy: { name: 'asc' },
        take: 20,
      });
      return users.map((u) => ({ id: u.id, name: u.name, designation: u.designation }));
    });
  }
}
