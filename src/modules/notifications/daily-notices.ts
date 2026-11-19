import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { isoDayOrNull } from '../../common/db/people-names';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  LICENCE_STATUS_LABEL,
  effectiveTargetDate,
  formatDate,
  istToday,
  licenceStatus,
  observationUrgency,
  type DailyNoticeRun,
} from '../../shared';
import { NotificationsService } from './notifications.service';

/** The system acts as Admin for scheduled work (it must see every plant). */
export const SYSTEM_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', isAdmin: true };

/** Stable short hash for dedupe keys built from free text. */
export const keyHash = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The daily IST job (NOTIF-J1): Licence Due / Expired → its remind list (event 4) and audit
 * observations past their target → the Plant Manager (event 5).
 *
 * Idempotent by construction: every notice carries a dedupe key that names the row and the
 * state it is in (`licence-due:<id>:<end date>`, `audit-overdue:<id>:<target>`), so running the
 * job twice — or on two servers — raises each notice once. A renewed licence (new end date) or
 * a revised target date is a new key, and so a new notice.
 */
@Injectable()
export class DailyNoticesJob {
  private readonly log = new Logger(DailyNoticesJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: NotificationsService,
  ) {}

  async run(today: string = istToday()): Promise<DailyNoticeRun> {
    const result: DailyNoticeRun = {
      date: today,
      licenceDue: 0,
      licenceExpired: 0,
      auditOverdue: 0,
      alreadyRaised: 0,
    };
    await this.prisma.runAs(SYSTEM_ACTOR, async (tx) => {
      await this.licences(tx, today, result);
      await this.observations(tx, today, result);
    });
    this.log.log(
      `Daily notices ${today}: licence due ${String(result.licenceDue)}, expired ${String(result.licenceExpired)}, audit overdue ${String(result.auditOverdue)}, already raised ${String(result.alreadyRaised)}`,
    );
    return result;
  }

  private async licences(tx: Tx, today: string, result: DailyNoticeRun): Promise<void> {
    const rows = await tx.licence.findMany({
      where: { plant: { deletedAt: null }, endDate: { not: null }, startDate: { not: null } },
      select: {
        id: true,
        plantId: true,
        docRef: true,
        startDate: true,
        endDate: true,
        frequency: true,
        remindBeforeDays: true,
        item: { select: { title: true } },
        plant: { select: { name: true } },
        remindUsers: { select: { userId: true } },
      },
    });
    for (const l of rows) {
      const endDate = isoDayOrNull(l.endDate);
      const status = licenceStatus(
        {
          frequency: l.frequency,
          startDate: isoDayOrNull(l.startDate),
          endDate,
          remindBeforeDays: l.remindBeforeDays,
        },
        today,
      );
      if (status !== 'DUE' && status !== 'EXPIRED') continue;
      const label = LICENCE_STATUS_LABEL[status];
      const ref = l.docRef ? ` (${l.docRef})` : '';
      const outcome = await this.notices.notify(tx, {
        category: 'SYSTEM',
        event: 'LICENCE_DUE',
        title: `Licence ${label} — ${l.item.title}, ${l.plant.name}`,
        body:
          status === 'DUE'
            ? `${l.item.title}${ref} ends on ${formatDate(endDate ?? today)}. Renewal window is open.`
            : `${l.item.title}${ref} expired on ${formatDate(endDate ?? today)}.`,
        plantId: l.plantId,
        link: { entity: 'licence', id: l.id },
        recipients: l.remindUsers.map((u) => u.userId),
        canAcknowledge: true,
        dedupeKey: `licence-${status.toLowerCase()}:${l.id}:${endDate ?? ''}`,
        sentTo: `Remind list (${String(l.remindUsers.length)})`,
      });
      if (outcome.state === 'DUPLICATE') result.alreadyRaised += 1;
      else if (outcome.state === 'SENT') {
        if (status === 'DUE') result.licenceDue += 1;
        else result.licenceExpired += 1;
      }
    }
  }

  private async observations(tx: Tx, today: string, result: DailyNoticeRun): Promise<void> {
    const rows = await tx.auditObservation.findMany({
      where: { status: 'PENDING', audit: { plant: { deletedAt: null } } },
      select: {
        id: true,
        plantId: true,
        auditId: true,
        observationCode: true,
        checklistRef: true,
        observation: true,
        status: true,
        targetDate: true,
        revisedTargetDate: true,
        audit: { select: { auditType: true, plant: { select: { name: true } } } },
      },
    });
    const managers = new Map<string, string[]>();
    for (const o of rows) {
      const dates = {
        targetDate: isoDayOrNull(o.targetDate),
        revisedTargetDate: isoDayOrNull(o.revisedTargetDate),
      };
      if (observationUrgency({ status: o.status, ...dates }, today) !== 'OVERDUE') continue;
      const target = effectiveTargetDate(dates) ?? today;
      let pm = managers.get(o.plantId);
      if (!pm) {
        pm = await this.notices.plantManagers(tx, o.plantId);
        managers.set(o.plantId, pm);
      }
      const outcome = await this.notices.notify(tx, {
        category: 'SYSTEM',
        event: 'AUDIT_OVERDUE',
        title: `Audit observation overdue — ${o.checklistRef ?? o.observationCode}, ${o.audit.plant.name}`,
        body: `${o.observationCode} ${o.observation ?? ''} — ${dates.revisedTargetDate ? 'revised target' : 'target'} ${formatDate(target)} has passed.`,
        plantId: o.plantId,
        link: { entity: 'audit', id: o.auditId },
        recipients: pm,
        canAcknowledge: true,
        dedupeKey: `audit-overdue:${o.id}:${target}`,
        sentTo: `Plant Manager, ${o.audit.plant.name}`,
      });
      if (outcome.state === 'DUPLICATE') result.alreadyRaised += 1;
      else if (outcome.state === 'SENT') result.auditOverdue += 1;
    }
  }
}
