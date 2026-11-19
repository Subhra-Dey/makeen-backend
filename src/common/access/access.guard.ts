import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Action } from '../../shared';
import { AccessService } from '../../modules/access/access.service';
import { IS_PUBLIC } from '../auth/actor';
import { AppError, ErrorCode } from '../errors/app-error';
import {
  ADMIN_ONLY,
  REQUIRE_ACTION,
  REQUIRE_MODULE,
  SIGNED_IN,
  type AccessRequest,
  type ModuleRule,
} from './access.decorators';

export const NO_ACCESS_MESSAGE = 'You do not have access to this.';

export function forbidden(message = NO_ACCESS_MESSAGE): AppError {
  return new AppError(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
}

/**
 * Role check on every guarded route (BEV-1, ROLE-9, SEC-9). Runs after authentication and CSRF,
 * before validation. A module rule passes when ANY of the person's roles grants the capability —
 * the plant-level check (the role on THAT plant) is the service's job via `assertPlant`.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  private meta(key: string, context: ExecutionContext): unknown {
    return this.reflector.getAllAndOverride<unknown>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (this.meta(IS_PUBLIC, context) === true) return true;

    const moduleRule = this.meta(REQUIRE_MODULE, context) as ModuleRule | undefined;
    const action = this.meta(REQUIRE_ACTION, context) as Action | undefined;
    const adminOnly = this.meta(ADMIN_ONLY, context) === true;
    if (!moduleRule && !action && !adminOnly) {
      // AccessMetadataCheck makes this unreachable for real routes; fail closed regardless.
      if (this.meta(SIGNED_IN, context) === true) return true;
      throw forbidden();
    }

    const req = context.switchToHttp().getRequest<AccessRequest>();
    if (!req.actor) throw forbidden();
    const access = await this.access.resolve(req.actor.userId);
    req.access = access;

    if (adminOnly && !access.isAdmin) throw forbidden();
    if (moduleRule && !access.modules[moduleRule.module].includes(moduleRule.capability))
      throw forbidden();
    if (action && !access.actions.includes(action)) throw forbidden();
    return true;
  }
}
