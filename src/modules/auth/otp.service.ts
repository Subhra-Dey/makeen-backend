import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { hashPassword } from '../../common/crypto/password';
import { hmacHex, safeEqual, sixDigitCode } from '../../common/crypto/tokens';
import { RateLimiter } from '../../common/security/rate-limiter.service';
import type { RequestContext } from '../../common/security/request-context';
import {
  AUTH_MESSAGES,
  formatDateTimeIst,
  isAllowedEmail,
  maskEmail,
  maskPhone,
  passwordProblem,
  type ChangePasswordInput,
  type OtpChannel,
  type OtpSendInput,
} from '../../shared';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from '../../infra/messaging/messaging';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { AuthStateService } from './auth-state.service';
import { SessionService } from './session.service';
import type { OtpChannelOption, OtpSent } from '../../shared';
export type { OtpChannelOption, OtpSent };

const MAX_VERIFY_ATTEMPTS = 5;

type Eligible = { id: string; email: string; phone: string | null; name: string };

/**
 * Change password with OTP (spec “Change password”, SEC-7, BEV-4): first password, change and
 * recovery after an Admin reset all use this one flow.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('Otp');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditLogService,
    private readonly access: AccessService,
    private readonly sessions: SessionService,
    private readonly authState: AuthStateService,
  ) {}

  /** Which channels this person can receive an OTP on (both come from KEKA; never typed). */
  async options(emailAddress: string): Promise<OtpChannelOption[]> {
    const user = await this.eligible(emailAddress);
    return this.channelsFor(user);
  }

  async send(input: OtpSendInput, ctx: RequestContext): Promise<OtpSent> {
    const user = await this.eligible(input.email);
    const option = (await this.channelsFor(user)).find((c) => c.channel === input.channel);
    if (!option) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Some fields are not valid.',
        [{ path: 'channel', message: AUTH_MESSAGES.channelRequired }],
      );
    }
    // SEC-6: 1 per 60 s and 5 per hour per person.
    const perMinute = await this.limiter.hit(`otp:send:min:${user.id}`, 1, 60_000);
    if (!perMinute.allowed) throw tooMany(AUTH_MESSAGES.otpWait, perMinute.retryAfterMs);
    const perHour = await this.limiter.hit(`otp:send:hour:${user.id}`, 5, 3_600_000);
    if (!perHour.allowed) throw tooMany(AUTH_MESSAGES.otpHourly, perHour.retryAfterMs);

    const code = sixDigitCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.env.OTP_TTL_MINUTES * 60_000);
    const challenge = await this.prisma.$transaction(async (tx) => {
      // A new Send/Resend cancels every earlier OTP of this person (spec field 4).
      await tx.otpChallenge.updateMany({
        where: { userId: user.id, usedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      const created = await tx.otpChallenge.create({
        data: {
          userId: user.id,
          channel: input.channel,
          codeHash: '0'.repeat(64),
          sentTo: option.destination,
          expiresAt,
        },
      });
      // Bind the hash to this challenge id, so a hash can never be replayed for another OTP.
      return tx.otpChallenge.update({
        where: { id: created.id },
        data: { codeHash: hmacHex(this.env.OTP_PEPPER, `${created.id}:${code}`) },
      });
    });

    try {
      if (input.channel === 'SMS') {
        await this.sms.sendOtp({
          to: user.phone ?? '',
          code,
          ttlMinutes: this.env.OTP_TTL_MINUTES,
        });
      } else {
        await this.email.send({
          to: user.email,
          subject: 'MAKEEN FM Portal — your password OTP',
          text: `Your OTP is ${code}. It is valid until ${formatDateTimeIst(expiresAt)} and can be used once.\nIf you did not ask for it, ignore this message.`,
        });
      }
    } catch (err: unknown) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { supersededAt: new Date() },
      });
      await this.logSend(
        input.channel,
        option.destination,
        'FAILED',
        err instanceof Error ? err.message.slice(0, 200) : 'send failed',
      );
      this.logger.warn(`OTP delivery failed (${input.channel})`);
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'The OTP could not be sent. Try the other method.',
      );
    }
    await this.logSend(input.channel, option.destination, 'SENT');
    await this.audit.record({
      action: AuditAction.OTP_SENT,
      entity: 'user',
      entityId: user.id,
      actorId: user.id,
      after: { channel: input.channel, sentTo: option.destination },
      ctx,
    });
    return {
      channel: input.channel,
      sentTo: option.destination,
      expiresAt: expiresAt.toISOString(),
      expiresAtIst: formatDateTimeIst(expiresAt),
    };
  }

  async changePassword(input: ChangePasswordInput, ctx: RequestContext): Promise<void> {
    const user = await this.eligible(input.email);
    const problem = passwordProblem(input.newPassword, input.email);
    if (problem) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Some fields are not valid.',
        [{ path: 'newPassword', message: problem }],
      );
    }
    const passwordHash = await hashPassword(input.newPassword, this.env.PASSWORD_PEPPER);

    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM otp_challenges
         WHERE user_id = ${user.id}::uuid AND used_at IS NULL AND superseded_at IS NULL
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      const id = rows[0]?.id;
      if (!id) return { ok: false as const, families: [] };
      const challenge = await tx.otpChallenge.findUniqueOrThrow({ where: { id } });
      const now = new Date();
      if (challenge.expiresAt <= now || challenge.attempts >= MAX_VERIFY_ATTEMPTS) {
        await tx.otpChallenge.update({ where: { id }, data: { supersededAt: now } });
        return { ok: false as const, families: [] };
      }
      if (!safeEqual(challenge.codeHash, hmacHex(this.env.OTP_PEPPER, `${id}:${input.otp}`))) {
        const attempts = challenge.attempts + 1;
        await tx.otpChallenge.update({
          where: { id },
          data: { attempts, ...(attempts >= MAX_VERIFY_ATTEMPTS ? { supersededAt: now } : {}) },
        });
        await this.audit.record(
          {
            action: AuditAction.OTP_FAILED,
            entity: 'user',
            entityId: user.id,
            actorId: user.id,
            after: { attempts },
            ctx,
          },
          tx,
        );
        return { ok: false as const, families: [] };
      }
      await tx.otpChallenge.update({
        where: { id },
        data: { usedAt: now, attempts: challenge.attempts + 1 },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, mustSetPassword: false, tokenVersion: { increment: 1 } },
      });
      const families = await this.sessions.revokeAllForUser(tx, user.id, 'PASSWORD_CHANGED');
      await this.audit.record(
        {
          action: AuditAction.PASSWORD_CHANGED,
          entity: 'user',
          entityId: user.id,
          actorId: user.id,
          after: { via: challenge.channel },
          ctx,
        },
        tx,
      );
      return { ok: true as const, families };
    });

    if (!result.ok) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Some fields are not valid.',
        [{ path: 'otp', message: AUTH_MESSAGES.otpInvalid }],
      );
    }
    await this.authState.invalidateUser(user.id);
    for (const f of result.families) await this.authState.markFamilyRevoked(f);
  }

  /** Active, working person with a role. Same answer shape whether or not the email exists. */
  private async eligible(emailAddress: string): Promise<Eligible> {
    if (!isAllowedEmail(emailAddress, this.env.ALLOWED_EMAIL_DOMAINS)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Some fields are not valid.',
        [{ path: 'email', message: AUTH_MESSAGES.emailNotMakeen }],
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { email: emailAddress },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        loginStatus: true,
        workingStatus: true,
      },
    });
    if (!user) throw noActiveLogin();
    const { hasRole } = await this.access.resolve(user.id);
    if (user.loginStatus !== 'ACTIVE' || user.workingStatus !== 'WORKING' || !hasRole) {
      throw new AppError(HttpStatus.FORBIDDEN, 'LOGIN_INACTIVE', AUTH_MESSAGES.inactive);
    }
    return user;
  }

  private async channelsFor(user: Eligible): Promise<OtpChannelOption[]> {
    const config = await this.prisma.notificationEventConfig.findUnique({
      where: { event: 'PASSWORD_OTP' },
    });
    // Notification control: Off means nothing is sent; the Email switch governs the email channel.
    if (config && !config.enabled) return [];
    const out: OtpChannelOption[] = [];
    if (user.phone && user.phone.replace(/\D/g, '').length >= 10)
      out.push({ channel: 'SMS', destination: maskPhone(user.phone) });
    if (config === null || config.emailEnabled)
      out.push({ channel: 'EMAIL', destination: maskEmail(user.email) });
    return out;
  }

  private async logSend(
    channel: OtpChannel,
    sentTo: string,
    state: 'SENT' | 'FAILED',
    error?: string,
  ): Promise<void> {
    await this.prisma.notificationSendLog.create({
      data: {
        category: 'SYSTEM',
        title: `Password OTP — ${channel === 'SMS' ? 'Mobile' : 'Email'} ${sentTo}`,
        sentTo,
        recipientCount: 1,
        channel: channel === 'SMS' ? 'SMS' : 'EMAIL',
        state,
        error: error ?? null,
      },
    });
  }
}

function noActiveLogin(): AppError {
  return new AppError(
    HttpStatus.NOT_FOUND,
    'NO_ACTIVE_LOGIN',
    'No active login was found for this email.',
  );
}

function tooMany(message: string, retryAfterMs: number): AppError {
  return new AppError(HttpStatus.TOO_MANY_REQUESTS, 'OTP_RATE_LIMITED', message, {
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  });
}
