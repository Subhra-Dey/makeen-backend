import { Controller, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentAccess, RequireModule } from '../../src/common/access/access.decorators';
import { assertPlant } from '../../src/common/access/plant-scope';
import type { ResolvedAccess } from '../../src/modules/access/access.service';

class PlantParam extends createZodDto(z.object({ plantId: z.uuid() })) {}

/**
 * Test-only stand-in for a plant-scoped module (Daily MIS arrives in Phase 6). One route per
 * capability, wired exactly like real endpoints: module rule on the route, `assertPlant` in the
 * handler. Proves Hidden → 403 for Search / Submit / Download / Approve and plant isolation.
 */
@Controller('probe/plants/:plantId/daily-mis')
class ProbeController {
  @RequireModule('DAILY_MIS', 'VIEW')
  @Get()
  search(@CurrentAccess() a: ResolvedAccess, @Param() p: PlantParam): { ok: true } {
    assertPlant(a, p.plantId, { module: 'DAILY_MIS', capability: 'VIEW' });
    return { ok: true };
  }

  @RequireModule('DAILY_MIS', 'SUBMIT')
  @Post()
  @HttpCode(200)
  submit(@CurrentAccess() a: ResolvedAccess, @Param() p: PlantParam): { ok: true } {
    assertPlant(a, p.plantId, { module: 'DAILY_MIS', capability: 'SUBMIT' });
    return { ok: true };
  }

  @RequireModule('DAILY_MIS', 'DOWNLOAD')
  @Get('export')
  download(@CurrentAccess() a: ResolvedAccess, @Param() p: PlantParam): { ok: true } {
    assertPlant(a, p.plantId, { module: 'DAILY_MIS', capability: 'DOWNLOAD' });
    return { ok: true };
  }

  @RequireModule('DAILY_MIS', 'APPROVE')
  @Post('approve')
  @HttpCode(200)
  approve(@CurrentAccess() a: ResolvedAccess, @Param() p: PlantParam): { ok: true } {
    assertPlant(a, p.plantId, { module: 'DAILY_MIS', capability: 'APPROVE' });
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
