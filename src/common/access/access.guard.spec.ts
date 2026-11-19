import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { MODULES, type Capability, type Module } from '../../shared';
import type { AccessService, ResolvedAccess } from '../../modules/access/access.service';
import { Public } from '../auth/actor';
import { AppError } from '../errors/app-error';
import { routesWithoutRule } from './access-metadata.check';
import { AdminOnly, RequireAction, RequireModule, SignedIn } from './access.decorators';
import { AccessGuard } from './access.guard';

class Probe {
  @Public() open(): void {}
  @SignedIn() profile(): void {}
  @RequireModule('PEOPLE', 'VIEW') people(): void {}
  @RequireModule('DAILY_MIS', 'APPROVE') approve(): void {}
  @RequireAction('DELETE_PLANT') deletePlant(): void {}
  @AdminOnly() roles(): void {}
  naked(): void {}
}

function accessWith(
  modules: Partial<Record<Module, Capability[]>>,
  opts: { isAdmin?: boolean; actions?: ResolvedAccess['actions'] } = {},
): ResolvedAccess {
  return {
    userId: 'u1',
    isAdmin: opts.isAdmin ?? false,
    baseRole: null,
    plantRoles: new Map(),
    modules: Object.fromEntries(MODULES.map((m) => [m, modules[m] ?? []])) as Record<
      Module,
      Capability[]
    >,
    actions: opts.actions ?? [],
    hasRole: true,
  };
}

function ctxFor(handler: keyof Probe, actor = true): ExecutionContext {
  const req: Record<string, unknown> = actor ? { actor: { userId: 'u1' } } : {};
  return {
    getType: () => 'http',
    getHandler: () => Probe.prototype[handler],
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function guardWith(access: ResolvedAccess): AccessGuard {
  const svc = { resolve: () => Promise.resolve(access) } as unknown as AccessService;
  return new AccessGuard(new Reflector(), svc);
}

async function denied(p: Promise<boolean>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(AppError);
}

describe('AccessGuard (ROLE-9, SEC-9)', () => {
  const staff = accessWith({ DAILY_MIS: ['VIEW'], DASHBOARD: ['VIEW'] });

  it('lets public and signed-in routes through without a module rule', async () => {
    await expect(guardWith(staff).canActivate(ctxFor('open', false))).resolves.toBe(true);
    await expect(guardWith(staff).canActivate(ctxFor('profile'))).resolves.toBe(true);
  });

  it('refuses a Hidden module for every capability', async () => {
    await denied(guardWith(staff).canActivate(ctxFor('people')));
  });

  it('refuses a capability the setting bundle does not include', async () => {
    await denied(guardWith(staff).canActivate(ctxFor('approve')));
    const pm = accessWith({ DAILY_MIS: ['VIEW', 'DOWNLOAD', 'APPROVE'] });
    await expect(guardWith(pm).canActivate(ctxFor('approve'))).resolves.toBe(true);
  });

  it('checks action switches and Admin-only routes', async () => {
    await denied(guardWith(staff).canActivate(ctxFor('deletePlant')));
    const withSwitch = accessWith({}, { actions: ['DELETE_PLANT'] });
    await expect(guardWith(withSwitch).canActivate(ctxFor('deletePlant'))).resolves.toBe(true);
    await denied(
      guardWith(accessWith({ PEOPLE: ['VIEW', 'SUBMIT'] })).canActivate(ctxFor('roles')),
    );
    const admin = accessWith({}, { isAdmin: true });
    await expect(guardWith(admin).canActivate(ctxFor('roles'))).resolves.toBe(true);
  });

  it('fails closed on a route with no rule and on a missing actor', async () => {
    await denied(guardWith(staff).canActivate(ctxFor('naked')));
    await denied(guardWith(staff).canActivate(ctxFor('people', false)));
  });
});

@Controller('probe')
class NakedController {
  @Public() @Get('a') ok(): void {}
  @Get('b') forgotten(): void {}
}

describe('AccessMetadataCheck', () => {
  it('finds routes that carry no access rule', async () => {
    const mod = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [NakedController],
    }).compile();
    const missing = routesWithoutRule(
      mod.get(DiscoveryService),
      mod.get(MetadataScanner),
      mod.get(Reflector),
    );
    expect(missing).toEqual(['NakedController.forgotten']);
  });
});
