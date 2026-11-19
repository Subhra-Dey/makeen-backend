import { Module } from '@nestjs/common';
import { DailyMisController } from './daily-mis.controller';
import { DailyMisExport } from './daily-mis.export';
import { DailyMisService } from './daily-mis.service';

/** Daily MIS: table, form, workflow, approval queue and downloads (Phase 6). */
@Module({
  controllers: [DailyMisController],
  providers: [DailyMisService, DailyMisExport],
  exports: [DailyMisService],
})
export class DailyMisModule {}
