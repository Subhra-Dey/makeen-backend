import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Action, Capability, Module } from '../../shared';
import type { ResolvedAccess } from '../../modules/access/access.service';
import type { AuthedRequest } from '../auth/actor';

/**
 * Route access rules (SEC-9). Every non-public route must carry one of:
 *   @RequireModule(module, capability)  — the person's roles must grant it (Hidden → 403, ROLE-9)
 *   @RequireAction(action)              — a sensitive action switch (ACT-1)
 *   @AdminOnly()                        — only the Admin role (Role screen, designation map)
 *   @SignedIn()                         — any signed-in person (profile, inbox, logout)
 * The app refuses to start if a route has none (AccessMetadataCheck), so a forgotten decorator
 * can never mean "open to everyone".
 */
export const REQUIRE_MODULE = 'access:module';
export const REQUIRE_ACTION = 'access:action';
export const ADMIN_ONLY = 'access:adminOnly';
export const SIGNED_IN = 'access:signedIn';

export interface ModuleRule {
  module: Module;
  capability: Capability;
}

export const RequireModule = (
  module: Module,
  capability: Capability,
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_MODULE, { module, capability } satisfies ModuleRule);

export const RequireAction = (action: Action): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_ACTION, action);

export const AdminOnly = (): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_ONLY, true);

export const SignedIn = (): MethodDecorator & ClassDecorator => SetMetadata(SIGNED_IN, true);

export type AccessRequest = AuthedRequest & { access?: ResolvedAccess };

/** The access resolved by AccessGuard for this request (only on module/action/admin routes). */
export const CurrentAccess = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ResolvedAccess => {
    const req = ctx.switchToHttp().getRequest<AccessRequest>();
    if (!req.access) throw new Error('CurrentAccess used on a route without an access rule');
    return req.access;
  },
);
