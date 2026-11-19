import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { loadJwtKeys, signAccessToken, type JwtKeys } from '../../common/crypto/jwt';
import { hashPassword, verifyPassword } from '../../common/crypto/password';
import { randomToken, sha256Hex } from '../../common/crypto/tokens';
import { RateLimiter } from '../../common/security/rate-limiter.service';
import type { RequestContext } from '../../common/security/request-context';
import { AUTH_MESSAGES, isAllowedEmail, type LoginInput } from '../../shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { AuthStateService } from './auth-state.service';
import { SessionService, type IssuedSession } from './session.service';

const MINUTE = 60_000;
/** Login brute-force limits (SEC-6): 5 failures per email + IP in 15 min, then a growing lock. */
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * MINUTE;
const LOCK_BASE_MS = 15 * MINUTE;
const LOCK_MAX_MS = 24 * 60 * MINUTE;

export const AuthErrorCode = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  LOGIN_INACTIVE: 'LOGIN_INACTIVE',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  LOGIN_LOCKED: 'LOGIN_LOCKED',
} as const;

export interface SignedIn {
  accessToken: string;
  accessMaxAgeMs: number;
  session: IssuedSession;
  csrfToken: string;
  user: { id: string; name: string; email: string };
}

@Injectable()
export class AuthService implements OnModuleInit {
  private keys!: JwtKeys;
  /** Hash of a random secret: unknown emails still pay the Argon2 cost (no timing oracle). */
  private dummyHash = '';

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditLogService,
    private readonly access: AccessService,
    private readonly authState: AuthStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.keys = loadJwtKeys(this.env.JWT_PRIVATE_KEY_B64, this.env.JWT_PUBLIC_KEY_B64);
    this.dummyHash = await hashPassword(randomToken(), this.env.PASSWORD_PEPPER);
  }

  get publicKey(): JwtKeys['publicKey'] {
    return this.keys.publicKey;
  }

  issueAccessToken(
    userId: string,
    familyId: string,
    tokenVersion: number,
  ): { token: string; maxAgeMs: number } {
    const token = signAccessToken(
      {
        sub: userId,
        sid: familyId,
        tv: tokenVersion,
        iss: this.env.JWT_ISSUER,
        aud: this.env.JWT_AUDIENCE,
      },
      this.env.ACCESS_TOKEN_TTL_SECONDS,
      this.keys.privateKey,
    );
    return { token, maxAgeMs: this.env.ACCESS_TOKEN_TTL_SECONDS * 1000 };
  }

  async login(input: LoginInput, ctx: RequestContext): Promise<SignedIn> {
    if (!isAllowedEmail(input.email, this.env.ALLOWED_EMAIL_DOMAINS)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Some fields are not valid.',
        [{ path: 'email', message: AUTH_MESSAGES.emailNotMakeen }],
      );
    }
    const subject = `${sha256Hex(input.email)}:${ctx.ip ?? 'unknown'}`;
    const lockKey = `login:lock:${subject}`;
    const lockedMs = await this.limiter.lockedFor(lockKey);
    if (lockedMs > 0) throw locked(lockedMs);

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        loginStatus: true,
        workingStatus: true,
        mustSetPassword: true,
        tokenVersion: true,
      },
    });
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? this.dummyHash,
      input.password,
      this.env.PASSWORD_PEPPER,
    );

    if (!user || !user.passwordHash || !passwordOk) {
      await this.registerFailure(subject, lockKey);
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entity: 'user',
        entityId: user?.id ?? null,
        actorId: user?.id ?? null,
        after: { email: input.email },
        reason: 'wrong credentials',
        ctx,
      });
      throw new AppError(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCode.INVALID_CREDENTIALS,
        AUTH_MESSAGES.wrongCredentials,
      );
    }

    // The password is right: only now say whether the login itself may be used.
    const { hasRole } = await this.access.resolve(user.id);
    if (user.loginStatus !== 'ACTIVE' || user.workingStatus !== 'WORKING' || !hasRole) {
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entity: 'user',
        entityId: user.id,
        actorId: user.id,
        reason: hasRole ? 'login inactive' : 'no role (unmapped designation)',
        ctx,
      });
      throw new AppError(
        HttpStatus.FORBIDDEN,
        AuthErrorCode.LOGIN_INACTIVE,
        AUTH_MESSAGES.inactive,
      );
    }
    if (user.mustSetPassword) {
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entity: 'user',
        entityId: user.id,
        actorId: user.id,
        reason: 'password change required',
        ctx,
      });
      throw new AppError(
        HttpStatus.FORBIDDEN,
        AuthErrorCode.PASSWORD_CHANGE_REQUIRED,
        AUTH_MESSAGES.passwordChangeRequired,
      );
    }

    await this.limiter.clear(`login:fail:${subject}`);
    const session = await this.prisma.$transaction(async (tx) => {
      const s = await this.sessions.create(user.id, user.tokenVersion, ctx, tx);
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await this.audit.record(
        {
          action: AuditAction.LOGIN_SUCCESS,
          entity: 'user',
          entityId: user.id,
          actorId: user.id,
          after: { sessionFamily: s.familyId },
          ctx,
        },
        tx,
      );
      return s;
    });
    const access = this.issueAccessToken(user.id, session.familyId, session.tokenVersion);
    return {
      accessToken: access.token,
      accessMaxAgeMs: access.maxAgeMs,
      session,
      csrfToken: randomToken(),
      user: { id: user.id, name: user.name, email: user.email },
    };
  }

  async refresh(
    refreshToken: string,
    ctx: RequestContext,
  ): Promise<{ accessToken: string; accessMaxAgeMs: number; session: IssuedSession }> {
    const session = await this.sessions.rotate(refreshToken, ctx);
    const access = this.issueAccessToken(session.userId, session.familyId, session.tokenVersion);
    return { accessToken: access.token, accessMaxAgeMs: access.maxAgeMs, session };
  }

  async logout(userId: string, familyId: string, ctx: RequestContext): Promise<void> {
    await this.sessions.revokeFamily(familyId, 'LOGOUT');
    await this.audit.record({
      action: AuditAction.LOGOUT,
      entity: 'session',
      entityId: familyId,
      actorId: userId,
      ctx,
    });
    await this.authState.invalidateUser(userId);
  }

  private async registerFailure(subject: string, lockKey: string): Promise<void> {
    const failKey = `login:fail:${subject}`;
    const hit = await this.limiter.hit(failKey, FAIL_LIMIT, FAIL_WINDOW_MS);
    if (hit.count < FAIL_LIMIT) return;
    // Progressive lock: 15 min, 30 min, 1 h, … capped at 24 h, counted over 24 h.
    const lockouts = await this.limiter.hit(
      `login:lockouts:${subject}`,
      Number.MAX_SAFE_INTEGER,
      LOCK_MAX_MS,
    );
    const ms = Math.min(LOCK_BASE_MS * 2 ** (lockouts.count - 1), LOCK_MAX_MS);
    await this.limiter.lock(lockKey, ms);
    await this.limiter.clear(failKey);
  }
}

function locked(ms: number): AppError {
  return new AppError(
    HttpStatus.TOO_MANY_REQUESTS,
    AuthErrorCode.LOGIN_LOCKED,
    AUTH_MESSAGES.tooManyAttempts,
    {
      retryAfterSeconds: Math.ceil(ms / 1000),
    },
  );
}
