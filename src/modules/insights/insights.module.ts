import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './insights.controller';
import { InsightsExport } from './insights.export';

/** Dashboard only. This demo package does not serve Review, Graphs, or search. */
@Module({
  controllers: [DashboardController],
  providers: [DashboardService, InsightsExport],
})
export class InsightsModule {}
