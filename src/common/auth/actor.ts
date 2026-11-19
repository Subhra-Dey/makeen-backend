import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

/** The authenticated caller, attached to the request by JwtAuthGuard. */
export interface Actor {
  userId: string;
  /** Session family id (`sid` claim) — logout revokes this family. */
  sessionFamilyId: string;
  tokenVersion: number;
}

export type AuthedRequest = Request & { actor?: Actor };

/** Marks a route as reachable without a session (CSRF still applies to state-changing calls). */
export const IS_PUBLIC = 'auth:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Injects the authenticated actor. Only valid on non-public routes. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.actor) throw new Error('CurrentActor used on a route without authentication');
  return req.actor;
});
