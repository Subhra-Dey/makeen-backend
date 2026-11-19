import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ENV } from '../../config/config.module';
import { cookiesSecure, type Env } from '../../config/env.schema';
import { AuthService } from '../../modules/auth/auth.service';
import { AuthStateService } from '../../modules/auth/auth-state.service';
import { IS_PUBLIC, type AuthedRequest } from '../auth/actor';
import { JwtError, verifyAccessToken } from '../crypto/jwt';
import { AppError, ErrorCode } from '../errors/app-error';
import { cookieNames, readCookie } from '../security/cookies';

/**
 * Authentication on every route unless @Public() (BEV-1, SEC-4). Accepts the access token only
 * from its HttpOnly cookie (never from JS-readable storage), then checks — against Redis with a
 * ≤ 60 s cache, falling back to the database — that the token version still matches, the login is
 * still usable, and the session family has not been revoked.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly state: AuthStateService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(req, cookieNames(cookiesSecure(this.env)).access);
    if (!token) throw unauthenticated();
    let claims;
    try {
      claims = verifyAccessToken(token, this.auth.publicKey, {
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
      });
    } catch (e: unknown) {
      if (e instanceof JwtError) throw unauthenticated();
      throw e;
    }
    const [user, family] = await Promise.all([
      this.state.userState(claims.sub),
      this.state.familyState(claims.sid),
    ]);
    if (!user || !user.usable || user.tokenVersion !== claims.tv || family !== 'ok')
      throw unauthenticated();
    req.actor = { userId: claims.sub, sessionFamilyId: claims.sid, tokenVersion: claims.tv };
    return true;
  }
}

function unauthenticated(): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, 'Please sign in.');
}
