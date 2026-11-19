import type {
  NotificationCategory,
  NotificationEvent,
  Prisma,
} from '../../src/generated/prisma/client';
import { NOTIFICATION_EVENTS, addDays, formatDate, type IsoDate } from '../../src/shared';
import type { Rng, SeedCalendar } from './context';
import { WORKING_PLANTS } from './data/plants';
import type { Foundation } from './foundation';

interface NoticeSeed {
  category: NotificationCategory;
  event: NotificationEvent | null;
  customCategory?: string;
  title: string;
  body: string;
  sender: string | null;
  at: Date;
  ack: boolean;
  reply: boolean;
  plantCode?: string;
  read: boolean;
}

export async function seedNotifications(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
): Promise<number> {
  const anita = f.adminId;
  const ravi = f.userId['MEI-00218'];
  if (!ravi) throw new Error('Ravi Kumar missing');
  const t = (authored: IsoDate, hhmm: string): Date => cal.atAuthored(authored, hhmm);
  const d15 = formatDate(cal.d('2026-10-15'));

  // The mockup inbox (newest first).
  const top: NoticeSeed[] = [
    {
      category: 'SYSTEM',
      event: 'REPORT_SUBMITTED',
      title: `Daily MIS submitted — HPCL Yediyur ${d15}`,
      body: `Daily MIS for HPCL Yediyur on ${d15} has been submitted for approval. Physical stock 368.430 MT · Stock loss −0.120 MT · Accuracy 62.40% (0 gms).`,
      sender: 'MEI-00733',
      at: t('2026-10-16', '09:12'),
      ack: true,
      reply: false,
      plantCode: 'HPY-011',
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'EXCEPTION_RAISED',
      title: 'Exception: Jockey pump no. 2 on manual — IOCL Gwalior',
      body: 'Daily Exception line 3: Jockey pump no. 2 on manual — auto controller fault reported.',
      sender: 'MEI-00901',
      at: t('2026-10-16', '08:41'),
      ack: true,
      reply: false,
      plantCode: 'IOW-025',
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'LICENCE_DUE',
      title: 'Licence Due — PESO storage licence, BPCL Bokaro',
      body: `PESO storage licence (PESO/ST/88) ends on ${formatDate(cal.d('2026-11-14'))}. Renewal window is open.`,
      sender: null,
      at: t('2026-10-16', '07:00'),
      ack: true,
      reply: false,
      plantCode: 'BPK-012',
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'AUDIT_OVERDUE',
      title: 'Audit observation overdue — OISD-144/4.2, HPCL Barhi',
      body: `OB-0142 Hydrant H-14 valve stuck — revised target ${formatDate(cal.d('2026-10-10'))} has passed.`,
      sender: null,
      at: t('2026-10-15', '07:00'),
      ack: true,
      reply: false,
      plantCode: 'HPB-017',
      read: false,
    },
    {
      category: 'CUSTOM',
      event: null,
      customCategory: 'Safety',
      title: 'Monsoon safety drill — all plants',
      body: 'All plants to complete the monsoon safety drill this week and record it in Daily MIS field 33.',
      sender: 'MEI-00412',
      at: t('2026-10-14', '18:20'),
      ack: true,
      reply: false,
      read: false,
    },
    {
      category: 'PERSON',
      event: 'PERSON_NOTE',
      title: 'Note from Ravi Kumar',
      body: 'Anita, can we get the Yediyur weighing scale vendor visit approved before Monday?',
      sender: 'MEI-00218',
      at: t('2026-10-14', '16:05'),
      ack: false,
      reply: true,
      plantCode: 'HPY-011',
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'REPORT_DECIDED',
      title: 'Monthly MIS Approved — IOCL Korba Aug 2026',
      body: 'Monthly MIS for IOCL Korba, August 2026 was approved.',
      sender: null,
      at: t('2026-10-12', '11:30'),
      ack: false,
      reply: false,
      plantCode: 'IOK-021',
      read: false,
    },
  ];
  // Remaining unread to reach 12 unread / 7 to acknowledge / 2 awaiting reply.
  const moreUnread: NoticeSeed[] = [
    {
      category: 'SYSTEM',
      event: 'EXCEPTION_RAISED',
      title: 'Exception: CCTV camera 7 not recording — HPCL Champaran',
      body: 'Daily Exception line 12: CCTV camera 7 (TLD bay) not recording since 06:40.',
      sender: null,
      at: t('2026-10-16', '07:55'),
      ack: true,
      reply: false,
      plantCode: 'HPM-019',
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'EXCEPTION_RAISED',
      title: 'Incident — IOCL Nagpur',
      body: 'Incident: minor LPG leak at carousel head 12 — isolated, no injury.',
      sender: null,
      at: t('2026-10-15', '14:22'),
      ack: true,
      reply: false,
      plantCode: 'ION-028',
      read: false,
    },
    {
      category: 'PERSON',
      event: 'PERSON_NOTE',
      title: 'Note from Meera Iyer',
      body: 'Please share the South zone lapse summary for October before the review call.',
      sender: 'MEI-00120',
      at: t('2026-10-15', '18:12'),
      ack: false,
      reply: true,
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'ACCESS_CHANGED',
      title: 'Access changed — Asha Nair assigned to HPCL Barhi',
      body: 'Asha Nair (Maintenance Officer) now has HPCL Barhi in addition to HPCL Yediyur.',
      sender: null,
      at: t('2026-10-13', '12:00'),
      ack: false,
      reply: false,
      plantCode: 'HPB-017',
      read: false,
    },
    {
      category: 'SYSTEM',
      event: 'REPORT_DECIDED',
      title: 'Daily MIS Returned — HPCL Barhi',
      body: `Daily MIS for HPCL Barhi on ${formatDate(cal.d('2026-10-14'))} was returned for correction.`,
      sender: null,
      at: t('2026-10-15', '10:02'),
      ack: false,
      reply: false,
      plantCode: 'HPB-017',
      read: false,
    },
  ];
  const older: NoticeSeed[] = Array.from(
    { length: 48 - top.length - moreUnread.length },
    (_, i) => {
      const plant = rng.pick(WORKING_PLANTS);
      const day = addDays(cal.rel(-3), -Math.floor(i / 2));
      return {
        category: 'SYSTEM',
        event: 'REPORT_SUBMITTED',
        title: `Daily MIS submitted — ${plant.name} ${formatDate(day)}`,
        body: `Daily MIS for ${plant.name} on ${formatDate(day)} has been submitted for approval.`,
        sender: null,
        at: cal.at(day, `${rng.int(20, 23)}:${String(rng.int(0, 59)).padStart(2, '0')}`),
        ack: true,
        reply: false,
        plantCode: plant.code,
        read: true,
      };
    },
  );

  let count = 0;
  for (const n of [...top, ...moreUnread, ...older]) {
    const senderId = n.sender ? (f.userId[n.sender] ?? null) : null;
    const plantId = n.plantCode ? (f.plantId[n.plantCode] ?? null) : null;
    await prisma.notification.create({
      data: {
        category: n.category,
        event: n.event,
        customCategory: n.customCategory ?? null,
        title: n.title,
        body: n.body,
        senderId,
        plantId,
        linkEntity: n.plantCode ? 'plant' : null,
        linkId: plantId,
        canAcknowledge: n.ack,
        canReply: n.reply,
        createdAt: n.at,
        recipients: {
          create: [
            {
              userId: anita,
              readAt: n.read ? new Date(n.at.getTime() + 3_600_000) : null,
              acknowledgedAt: n.read && n.ack ? new Date(n.at.getTime() + 3_700_000) : null,
            },
          ],
        },
      },
    });
    count += 1;
  }

  // Ravi (Yediyur PM) gets the Yediyur submissions waiting for him.
  for (const [day, hhmm] of [
    ['2026-10-15', '21:05'],
    ['2026-10-14', '21:48'],
  ] as const) {
    await prisma.notification.create({
      data: {
        category: 'SYSTEM',
        event: 'REPORT_SUBMITTED',
        title: `Daily MIS submitted — HPCL Yediyur ${formatDate(cal.d(day))}`,
        body: `Daily MIS for HPCL Yediyur on ${formatDate(cal.d(day))} is waiting for your approval.`,
        senderId: f.userId['MEI-00733'] ?? null,
        plantId: f.plantId['HPY-011'] ?? null,
        linkEntity: 'daily_mis',
        canAcknowledge: true,
        createdAt: t(day, hhmm),
        recipients: { create: [{ userId: ravi }] },
      },
    });
    count += 1;
  }

  // Event switches (NOTIF-C1/C2): all on; Email off except the password OTP.
  await prisma.notificationEventConfig.createMany({
    data: NOTIFICATION_EVENTS.map((event) => ({
      event,
      enabled: true,
      emailEnabled: event === 'PASSWORD_OTP',
      updatedById: anita,
    })),
  });

  // “Last sends” (mockup).
  await prisma.notificationSendLog.createMany({
    data: [
      {
        at: t('2026-10-16', '09:12'),
        category: 'SYSTEM',
        title: `Daily MIS submitted — HPCL Yediyur ${d15}`,
        sentTo: 'Ravi Kumar',
        recipientCount: 1,
        channel: 'IN_APP',
        state: 'SENT',
      },
      {
        at: t('2026-10-16', '08:41'),
        category: 'SYSTEM',
        title: 'Exception: Jockey pump no. 2 on manual — IOCL Gwalior',
        sentTo: 'Plant Manager, IOCL Gwalior',
        recipientCount: 1,
        channel: 'IN_APP',
        state: 'SENT',
      },
      {
        at: t('2026-10-16', '07:00'),
        category: 'SYSTEM',
        title: 'Licence Due — PESO storage licence, BPCL Bokaro',
        sentTo: 'Remind list (3)',
        recipientCount: 3,
        channel: 'IN_APP',
        state: 'SENT',
      },
      {
        at: t('2026-10-14', '18:20'),
        category: 'CUSTOM',
        title: 'Monsoon safety drill — all plants',
        sentTo: 'All roles · All plants',
        recipientCount: 56,
        channel: 'IN_APP',
        state: 'SENT',
      },
      {
        at: t('2026-10-14', '16:05'),
        category: 'PERSON',
        title: 'Note from Ravi Kumar',
        sentTo: 'Anita Sharma',
        recipientCount: 1,
        channel: 'IN_APP',
        state: 'SENT',
      },
      {
        at: t('2026-10-14', '11:02'),
        category: 'SYSTEM',
        title: 'Password OTP — Email an***@makeenenergy.com',
        sentTo: 'an***@makeenenergy.com',
        recipientCount: 1,
        channel: 'EMAIL',
        state: 'SENT',
      },
    ],
  });
  return count;
}

export async function seedSettings(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  f: Foundation,
  lapseStart: IsoDate,
  peopleCount: number,
): Promise<void> {
  await prisma.appSetting.createMany({
    data: [
      // Lapse counts Not-initiated days from go-live (D-21). The demo history starts here.
      { key: 'lapse.startDate', value: lapseStart, updatedById: f.adminId },
      // GR-4: production per man-hour formula switch, Off until hours per shift are given.
      {
        key: 'graphs.productionPerManHour',
        value: { enabled: false, hoursPerShift: null },
        updatedById: f.adminId,
      },
      // MR-12: Management Review download layout.
      { key: 'managementReview.downloadLayout', value: 'standard', updatedById: f.adminId },
    ],
  });
  await prisma.kekaImportBatch.create({
    data: {
      source: 'CSV',
      fileName: 'keka_employees_2026-10-16.csv',
      dryRun: false,
      startedById: f.adminId,
      startedAt: cal.atAuthored('2026-10-16', '06:00'),
      finishedAt: cal.atAuthored('2026-10-16', '06:01'),
      totalRows: peopleCount,
      created: peopleCount,
      updated: 0,
      unchanged: 0,
      failed: 0,
      report: { note: 'Demo seed — initial KEKA load' },
    },
  });
}
