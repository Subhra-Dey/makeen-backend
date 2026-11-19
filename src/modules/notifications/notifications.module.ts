import { Global, Module } from '@nestjs/common';
import { NoticeScheduler } from '../../jobs/notice-scheduler';
import { DailyNoticesJob } from './daily-notices';
import { EmailOutbox } from './email-outbox';
import { NoticeBus } from './notice-bus';
import { NotificationControlService } from './notification-control.service';
import { NotificationControlController, NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Notifications engine, inbox, Notification control and the scheduled work (Phase 10). Global,
 * so every module that raises a notice (Daily / Monthly MIS, Exceptions, People) injects
 * NotificationsService without importing this module.
 */
@Global()
@Module({
  controllers: [NotificationsController, NotificationControlController],
  providers: [
    NoticeBus,
    NotificationsService,
    NotificationControlService,
    DailyNoticesJob,
    EmailOutbox,
    NoticeScheduler,
  ],
  exports: [NotificationsService, DailyNoticesJob, EmailOutbox],
})
export class NotificationsModule {}
