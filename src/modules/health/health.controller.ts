import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/auth/actor';
import { HealthService, type ReadinessReport } from './health.service';

/** OPS-1: liveness and readiness probes. Unauthenticated by design; expose no internals. */
@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness — the process is up and serving HTTP. Never touches dependencies. */
  @Get('health')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness — database and Redis reachable. 503 when either is down. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.status(report.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
