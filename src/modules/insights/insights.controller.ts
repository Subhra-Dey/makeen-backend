import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { sendFile } from '../../common/export/report-file';
import { requestContext } from '../../common/security/request-context';
import {
  dashboardExportSchema,
  dashboardQuerySchema,
  performanceQuerySchema,
  type DashboardView,
  type PlantPerformance,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { DashboardService } from './dashboard.service';
import { InsightsExport } from './insights.export';

class DashboardQueryDto extends createZodDto(dashboardQuerySchema) {}
class DashboardExportDto extends createZodDto(dashboardExportSchema) {}
class PerformanceDto extends createZodDto(performanceQuerySchema) {}

/** Dashboard (module DASHBOARD): counts, waiting tables, Plant Performance, download. */
@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly exports: InsightsExport,
  ) {}

  @RequireModule('DASHBOARD', 'VIEW')
  @Get()
  view(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: DashboardQueryDto,
  ): Promise<DashboardView> {
    return this.dashboard.view(access, q);
  }

  @RequireModule('DASHBOARD', 'VIEW')
  @Get('performance')
  performance(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: PerformanceDto,
  ): Promise<PlantPerformance> {
    return this.dashboard.performance(access, q.range, q.plantId);
  }

  @RequireModule('DASHBOARD', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: DashboardExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = q;
    sendFile(res, await this.exports.dashboardFile(access, filter, format, requestContext(req)));
  }
}
