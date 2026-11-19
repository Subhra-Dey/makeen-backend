import { ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { ENV } from '../../config/config.module';
import { cookiesSecure, type Env } from '../../config/env.schema';
import { SignedIn } from '../../common/access/access.decorators';
import { CurrentActor, Public, type Actor } from '../../common/auth/actor';
import { randomToken } from '../../common/crypto/tokens';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import {
  clearSessionCookies,
  cookieNames,
  readCookie,
  setCsrfCookie,
  setSessionCookies,
} from '../../common/security/cookies';
import { requestContext } from '../../common/security/request-context';
import { changePasswordSchema, loginSchema, otpOptionsSchema, otpSendSchema } from '../../shared';
import { AuthService } from './auth.service';
import { OtpService, type OtpChannelOption, type OtpSent } from './otp.service';

class LoginDto extends createZodDto(loginSchema) {}
class OtpOptionsDto extends createZodDto(otpOptionsSchema) {}
class OtpSendDto extends createZodDto(otpSendSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

/** Per-IP limits on unauthenticated auth routes (SEC-6): 20 per hour per IP. */
const PER_IP_HOURLY = { default: { limit: 20, ttl: 3_600_000 } };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get secure(): boolean {
    return cookiesSecure(this.env);
  }

  /** Issue (or re-issue) the CSRF cookie; the web app calls this before its first POST. */
  @Public()
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const existing = readCookie(req, cookieNames(this.secure).csrf);
    const token = existing && existing.length >= 32 ? existing : randomToken();
    setCsrfCookie(res, this.secure, token);
    return { csrfToken: token };
  }

  @Public()
  @Throttle(PER_IP_HOURLY)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: { id: string; name: string; email: string } }> {
    const signedIn = await this.auth.login(body, requestContext(req));
    setSessionCookies(res, this.secure, {
      access: signedIn.accessToken,
      accessMaxAgeMs: signedIn.accessMaxAgeMs,
      refresh: signedIn.session.refreshToken,
      refreshMaxAgeMs: signedIn.session.refreshMaxAgeMs,
    });
    // Rotate the CSRF token at the privilege change (sign-in).
    setCsrfCookie(res, this.secure, signedIn.csrfToken);
    return { user: signedIn.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readCookie(req, cookieNames(this.secure).refresh);
    if (!token)
      throw new AppError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, 'Please sign in.');
    try {
      const r = await this.auth.refresh(token, requestContext(req));
      setSessionCookies(res, this.secure, {
        access: r.accessToken,
        accessMaxAgeMs: r.accessMaxAgeMs,
        refresh: r.session.refreshToken,
        refreshMaxAgeMs: r.session.refreshMaxAgeMs,
      });
    } catch (e: unknown) {
      clearSessionCookies(res, this.secure);
      throw e;
    }
  }

  @SignedIn()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(actor.userId, actor.sessionFamilyId, requestContext(req));
    clearSessionCookies(res, this.secure);
    setCsrfCookie(res, this.secure, randomToken());
  }

  /** Masked KEKA mobile / email the person can receive an OTP on (spec field 2). */
  @Public()
  @Throttle(PER_IP_HOURLY)
  @Post('password/options')
  @HttpCode(HttpStatus.OK)
  async options(@Body() body: OtpOptionsDto): Promise<{ channels: OtpChannelOption[] }> {
    return { channels: await this.otp.options(body.email) };
  }

  @Public()
  @Throttle(PER_IP_HOURLY)
  @Post('password/otp')
  @HttpCode(HttpStatus.OK)
  sendOtp(@Body() body: OtpSendDto, @Req() req: Request): Promise<OtpSent> {
    return this.otp.send(body, requestContext(req));
  }

  /** Update password (spec field 7). Ends every session; the person signs in again. */
  @Public()
  @Throttle(PER_IP_HOURLY)
  @Post('password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    await this.otp.changePassword(body, requestContext(req));
    clearSessionCookies(res, this.secure);
    return { message: 'Password updated. Sign in with your email and the new password.' };
  }
}
