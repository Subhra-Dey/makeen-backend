import { HttpStatus, Injectable } from '@nestjs/common';
import { namesOf, personRef } from '../../common/db/people-names';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABEL,
  NOTIFICATION_EVENT_RECEIVERS,
  NOTIFICATION_MESSAGES,
  addDays,
  type CustomNoticeInput,
  type CustomNoticePreview,
  type EventConfigRow,
  type NotificationEvent,
  type SendLogPage,
  type SendLogQuery,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { SYSTEM_ACTOR } from './daily-notices';
import { NotificationsService, type NoticeOutcome } from './notifications.service';

const invalid = (path: string, message: string): AppError =>
  new AppError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, message, [{ path, message }]);

/** IST midnight of a business date as an instant. */
const istStart = (day: string): Date => new Date(`${day}T00:00:00+05:30`);

/**
 * Admin › Notification control (NOTIF-C1…C3, NOTIF-S1…S8): event switches, the Last sends log
 * and custom notices to a role, a plant and / or named people.
 */
@Injectable()
export class NotificationControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: NotificationsService,
    private readonly audit: AuditLogService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs(SYSTEM_ACTOR, fn);
  }

  async events(): Promise<EventConfigRow[]> {
    return this.system(async (tx) => {
      const rows = await tx.notificationEventConfig.findMany();
      const names = await namesOf(
        tx,
        rows.map((r) => r.updatedById),
      );
      return NOTIFICATION_EVENTS.map((event) => {
        const r = rows.find((x) => x.event === event);
        const otp = event === 'PASSWORD_OTP';
        const emailEnabled = r?.emailEnabled ?? otp;
        return {
          event,
          label: NOTIFICATION_EVENT_LABEL[event],
          enabled: otp ? true : (r?.enabled ?? true),
          emailEnabled,
          receives: NOTIFICATION_EVENT_RECEIVERS[event],
          channel: otp
            ? 'SMS or email, as the person chose'
            : `In-app${emailEnabled ? ' + email' : ''}`,
          locked: otp,
          updatedBy: personRef(names, r?.updatedById ?? null),
          updatedAt: r?.updatedAt.toISOString() ?? null,
        };
      });
    });
  }

  async setEvent(
    access: ResolvedAccess,
    event: NotificationEvent,
    input: { enabled: boolean; emailEnabled: boolean },
    ctx: RequestContext,
  ): Promise<EventConfigRow[]> {
    if (event === 'PASSWORD_OTP' && (!input.enabled || !input.emailEnabled))
      throw invalid('enabled', NOTIFICATION_MESSAGES.eventLocked);
    await this.system(async (tx) => {
      const before = await tx.notificationEventConfig.findUnique({ where: { event } });
      await tx.notificationEventConfig.upsert({
        where: { event },
        create: { event, ...input, updatedById: access.userId },
        update: { ...input, updatedById: access.userId },
      });
      await this.audit.record(
        {
          action: AuditAction.UPDATE,
          entity: 'notification_event',
          entityId: event,
          actorId: access.userId,
          ...(before
            ? { before: { enabled: before.enabled, emailEnabled: before.emailEnabled } }
            : {}),
          after: input,
          ctx,
        },
        tx,
      );
    });
    return this.events();
  }

  async sendLog(q: SendLogQuery): Promise<SendLogPage> {
    return this.system(async (tx) => {
      const where: Prisma.NotificationSendLogWhereInput = {
        ...(q.category ? { category: q.category } : {}),
        ...(q.from || q.to
          ? {
              at: {
                ...(q.from ? { gte: istStart(q.from) } : {}),
                ...(q.to ? { lt: istStart(addDays(q.to, 1)) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.notificationSendLog.findMany({
          where,
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        tx.notificationSendLog.count({ where }),
      ]);
      return {
        rows: rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          category: r.category,
          title: r.title,
          sentTo: r.sentTo,
          recipientCount: r.recipientCount,
          channel: r.channel,
          state: r.state,
          error: r.error,
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  /** Who a custom notice reaches (NOTIF-S2…S4): active, working people only. */
  private async recipients(
    tx: Tx,
    input: CustomNoticeInput,
  ): Promise<{ ids: string[]; names: string[]; label: string }> {
    const role = input.roleId ?? null;
    const plant = input.plantId ?? null;
    const specificRole = role && role !== 'ALL' ? role : null;
    const specificPlant = plant && plant !== 'ALL' ? plant : null;
    const groups: Prisma.UserWhereInput[] = [];
    if (role || plant) {
      if (specificRole && specificPlant)
        groups.push({ assignments: { some: { roleId: specificRole, plantId: specificPlant } } });
      else if (specificRole)
        groups.push({
          OR: [{ baseRoleId: specificRole }, { assignments: { some: { roleId: specificRole } } }],
        });
      else if (specificPlant) groups.push({ assignments: { some: { plantId: specificPlant } } });
      else groups.push({});
    }
    if (input.userIds.length > 0) groups.push({ id: { in: input.userIds } });
    const users = await tx.user.findMany({
      where: { loginStatus: 'ACTIVE', workingStatus: 'WORKING', OR: groups },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const roleName = specificRole
      ? (await tx.role.findUnique({ where: { id: specificRole }, select: { name: true } }))?.name
      : null;
    const plantName = specificPlant
      ? (await tx.plant.findUnique({ where: { id: specificPlant }, select: { name: true } }))?.name
      : null;
    const parts = [
      role ? (roleName ?? 'All roles') : null,
      plant ? (plantName ?? 'All plants') : null,
      input.userIds.length ? `${String(input.userIds.length)} named people` : null,
    ].filter(Boolean);
    return {
      ids: users.map((u) => u.id),
      names: users.map((u) => u.name),
      label: parts.join(' · '),
    };
  }

  async preview(input: CustomNoticeInput): Promise<CustomNoticePreview> {
    return this.system(async (tx) => {
      const r = await this.recipients(tx, input);
      return { recipientCount: r.ids.length, sample: r.names.slice(0, 5) };
    });
  }

  async sendCustom(
    access: ResolvedAccess,
    input: CustomNoticeInput,
    ctx: RequestContext,
  ): Promise<NoticeOutcome> {
    return this.system(async (tx) => {
      const r = await this.recipients(tx, input);
      if (r.ids.length === 0) throw invalid('roleId', NOTIFICATION_MESSAGES.noRecipients);
      const outcome = await this.notices.notify(tx, {
        category: 'CUSTOM',
        event: null,
        customCategory: input.customCategory,
        title: input.title,
        body: input.message,
        senderId: access.userId,
        plantId: input.plantId && input.plantId !== 'ALL' ? input.plantId : null,
        recipients: r.ids,
        canAcknowledge: input.canAcknowledge,
        canReply: input.canReply,
        sentTo: r.label,
      });
      await this.audit.record(
        {
          action: AuditAction.CREATE,
          entity: 'notification',
          entityId: outcome.state === 'SENT' ? outcome.id : 'skipped',
          actorId: access.userId,
          after: { title: input.title, recipients: r.ids.length, sentTo: r.label },
          ctx,
        },
        tx,
      );
      return outcome;
    });
  }
}
