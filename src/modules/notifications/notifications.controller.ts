import { ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { from, interval, map, merge, of, switchMap, takeUntil, timer, type Observable } from 'rxjs';
import { z } from 'zod';
import {
  AdminOnly,
  CurrentAccess,
  RequireModule,
  SignedIn,
} from '../../common/access/access.decorators';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { IdParamDto } from '../../common/pipes/params';
import { requestContext } from '../../common/security/request-context';
import {
  NOTIFICATION_EVENTS,
  customNoticeSchema,
  eventConfigSchema,
  inboxQuerySchema,
  peopleSearchSchema,
  personNoteSchema,
  replySchema,
  sendLogQuerySchema,
  type CustomNoticePreview,
  type DailyNoticeRun,
  type EventConfigRow,
  type InboxPage,
  type NoticeView,
  type PersonOption,
  type SendLogPage,
  type UnreadCount,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { DailyNoticesJob } from './daily-notices';
import { NoticeBus } from './notice-bus';
import { NotificationControlService } from './notification-control.service';
import { NotificationsService, type NoticeOutcome } from './notifications.service';

class InboxDto extends createZodDto(inboxQuerySchema) {}
class ReplyDto extends createZodDto(replySchema) {}
class NoteDto extends createZodDto(personNoteSchema) {}
class PeopleDto extends createZodDto(peopleSearchSchema) {}
class EventParamDto extends createZodDto(z.object({ event: z.enum(NOTIFICATION_EVENTS) })) {}
class EventDto extends createZodDto(eventConfigSchema) {}
class LogDto extends createZodDto(sendLogQuerySchema) {}
class CustomDto extends createZodDto(customNoticeSchema) {}

/** Heartbeat so proxies keep the stream open; it also re-sends the count. */
const HEARTBEAT_MS = 25_000;
/** The access token lives 15 minutes; the browser reconnects with a fresh one. */
const STREAM_MAX_MS = 15 * 60_000;

/** The signed-in person's inbox (NOTIF-1…6, NOTIF-J2). Every route touches only their notices. */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notices: NotificationsService,
    private readonly bus: NoticeBus,
  ) {}

  @SignedIn()
  @Get()
  inbox(@CurrentActor() actor: Actor, @Query() q: InboxDto): Promise<InboxPage> {
    return this.notices.inbox(actor.userId, q);
  }

  @SignedIn()
  @Get('unread-count')
  unread(@CurrentActor() actor: Actor): Promise<UnreadCount> {
    return this.notices.unread(actor.userId);
  }

  /** Server-sent events: the unread count now, on every change and every 25 s (NOTIF-J2). */
  @SignedIn()
  @Sse('stream')
  stream(@CurrentActor() actor: Actor): Observable<MessageEvent> {
    const id = actor.userId;
    return merge(of(null), this.bus.forUser(id), interval(HEARTBEAT_MS)).pipe(
      switchMap(() => from(this.notices.unread(id))),
      map((count): MessageEvent => ({ type: 'unread', data: count })),
      takeUntil(timer(STREAM_MAX_MS)),
    );
  }

  @SignedIn()
  @Get('people')
  people(@CurrentActor() actor: Actor, @Query() q: PeopleDto): Promise<PersonOption[]> {
    return this.notices.people(actor.userId, q.q);
  }

  @SignedIn()
  @Post('notes')
  note(@CurrentActor() actor: Actor, @Body() body: NoteDto): Promise<NoticeOutcome> {
    return this.notices.sendNote(actor.userId, body.toUserId, body.message);
  }

  @SignedIn()
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  readAll(@CurrentActor() actor: Actor): Promise<UnreadCount> {
    return this.notices.markAllRead(actor.userId);
  }

  @SignedIn()
  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param() p: IdParamDto): Promise<NoticeView> {
    return this.notices.get(actor.userId, p.id);
  }

  @SignedIn()
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  read(@CurrentActor() actor: Actor, @Param() p: IdParamDto): Promise<NoticeView> {
    return this.notices.markRead(actor.userId, p.id);
  }

  @SignedIn()
  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  acknowledge(@CurrentActor() actor: Actor, @Param() p: IdParamDto): Promise<NoticeView> {
    return this.notices.acknowledge(actor.userId, p.id);
  }

  @SignedIn()
  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  reply(
    @CurrentActor() actor: Actor,
    @Param() p: IdParamDto,
    @Body() body: ReplyDto,
  ): Promise<NoticeView> {
    return this.notices.reply(actor.userId, p.id, body.text);
  }
}

/** Admin › Notification control (module NOTIFICATION_CONTROL). */
@ApiTags('Notification control')
@Controller('notification-control')
export class NotificationControlController {
  constructor(
    private readonly control: NotificationControlService,
    private readonly daily: DailyNoticesJob,
  ) {}

  @RequireModule('NOTIFICATION_CONTROL', 'VIEW')
  @Get('events')
  events(): Promise<EventConfigRow[]> {
    return this.control.events();
  }

  @RequireModule('NOTIFICATION_CONTROL', 'SUBMIT')
  @Put('events/:event')
  setEvent(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: EventParamDto,
    @Body() body: EventDto,
    @Req() req: Request,
  ): Promise<EventConfigRow[]> {
    return this.control.setEvent(access, p.event, body, requestContext(req));
  }

  @RequireModule('NOTIFICATION_CONTROL', 'VIEW')
  @Get('log')
  log(@Query() q: LogDto): Promise<SendLogPage> {
    return this.control.sendLog(q);
  }

  @RequireModule('NOTIFICATION_CONTROL', 'SUBMIT')
  @Post('custom/preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() body: CustomDto): Promise<CustomNoticePreview> {
    return this.control.preview(body);
  }

  @RequireModule('NOTIFICATION_CONTROL', 'SUBMIT')
  @Post('custom')
  send(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: CustomDto,
    @Req() req: Request,
  ): Promise<NoticeOutcome> {
    return this.control.sendCustom(access, body, requestContext(req));
  }

  /** Run today's Licence / Audit notices now (idempotent — safe to press twice). */
  @AdminOnly()
  @Post('run-daily')
  @HttpCode(HttpStatus.OK)
  runDaily(): Promise<DailyNoticeRun> {
    return this.daily.run();
  }
}
