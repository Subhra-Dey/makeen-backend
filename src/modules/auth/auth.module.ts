import { Global, Module } from '@nestjs/common';
import { RateLimiter } from '../../common/security/rate-limiter.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthStateService } from './auth-state.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthStateService, SessionService, OtpService, RateLimiter],
  exports: [AuthService, AuthStateService, SessionService, RateLimiter],
})
export class AuthModule {}
