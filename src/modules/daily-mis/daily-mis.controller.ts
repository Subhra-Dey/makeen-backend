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
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentAccess, RequireAction, RequireModule } from '../../common/access/access.decorators';
import { IdParamDto } from '../../common/pipes/params';
import { requestContext } from '../../common/security/request-context';
import {
  approvalQueueQuerySchema,
  approveSchema,
  dailyMisExportSchema,
  dailyMisQuerySchema,
  dailyMisSaveSchema,
  reopenSchema,
  returnSchema,
  type ApprovalQueueItem,
  type DailyMisDetail,
  type DailyMisPage,
  type DailyMisRevision,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { sendFile } from '../../common/export/report-file';
import { DailyMisExport } from './daily-mis.export';
import { DailyMisService } from './daily-mis.service';

class QueryDto extends createZodDto(dailyMisQuerySchema) {}
class ExportDto extends createZodDto(dailyMisExportSchema) {}
class QueueDto extends createZodDto(approvalQueueQuerySchema) {}
class SaveDto extends createZodDto(dailyMisSaveSchema) {}
class ApproveDto extends createZodDto(approveSchema) {}
class ReturnDto extends createZodDto(returnSchema) {}
class ReopenDto extends createZodDto(reopenSchema) {}
class RevisionParamDto extends createZodDto(
  z.object({ id: z.uuid(), version: z.coerce.number().int().min(1).max(100_000) }),
) {}

/** Daily MIS (module DAILY_MIS). Static paths come before `:id` (Express matches in order). */
@ApiTags('Daily MIS')
@Controller('daily-mis')
export class DailyMisController {
  constructor(
    private readonly daily: DailyMisService,
    private readonly exports: DailyMisExport,
  ) {}

  @RequireModule('DAILY_MIS', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<DailyMisPage> {
    return this.daily.list(access, q);
  }

  @RequireModule('DAILY_MIS', 'APPROVE')
  @Get('queue')
  queue(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: QueueDto,
  ): Promise<ApprovalQueueItem[]> {
    return this.daily.queue(access, q.plantId);
  }

  @RequireModule('DAILY_MIS', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: ExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = q;
    sendFile(res, await this.exports.table(access, filter, format, requestContext(req)));
  }

  @RequireModule('DAILY_MIS', 'SUBMIT')
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<DailyMisDetail> {
    return this.daily.create(access, body, requestContext(req));
  }

  @RequireModule('DAILY_MIS', 'VIEW')
  @Get(':id')
  get(@CurrentAccess() access: ResolvedAccess, @Param() p: IdParamDto): Promise<DailyMisDetail> {
    return this.daily.get(access, p.id);
  }

  @RequireModule('DAILY_MIS', 'VIEW')
  @Get(':id/revisions/:version')
  revision(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: RevisionParamDto,
  ): Promise<DailyMisRevision> {
    return this.daily.revision(access, p.id, p.version);
  }

  @RequireModule('DAILY_MIS', 'DOWNLOAD')
  @Get(':id/pdf')
  async pdf(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.exports.record(access, p.id, requestContext(req)));
  }

  @RequireModule('DAILY_MIS', 'SUBMIT')
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<DailyMisDetail> {
    return this.daily.update(access, p.id, body, requestContext(req));
  }

  @RequireModule('DAILY_MIS', 'APPROVE')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ApproveDto,
    @Req() req: Request,
  ): Promise<DailyMisDetail> {
    return this.daily.approve(access, p.id, body.version, requestContext(req));
  }

  @RequireModule('DAILY_MIS', 'APPROVE')
  @RequireAction('RETURN')
  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  returnRow(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ReturnDto,
    @Req() req: Request,
  ): Promise<DailyMisDetail> {
    return this.daily.returnRow(access, p.id, body.version, body.reason, requestContext(req));
  }

  @RequireModule('DAILY_MIS', 'VIEW')
  @RequireAction('REOPEN_APPROVED')
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ReopenDto,
    @Req() req: Request,
  ): Promise<DailyMisDetail> {
    return this.daily.reopen(access, p.id, body.version, body.reason, requestContext(req));
  }
}
