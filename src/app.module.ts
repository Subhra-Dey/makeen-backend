import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AccessMetadataCheck } from './common/access/access-metadata.check';
import { AccessGuard } from './common/access/access.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CsrfGuard } from './common/guards/csrf.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { LoggingModule } from './common/logging/logging.module';
import { AppZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { RedisThrottlerStorage } from './common/security/redis-throttler.storage';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './infra/database.module';
import { MessagingModule } from './infra/messaging/messaging.module';
import { REDIS, RedisModule } from './infra/redis.module';
import { AccessModule } from './modules/access/access.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { AuthModule } from './modules/auth/auth.module';
import { DailyMisModule } from './modules/daily-mis/daily-mis.module';
import { StorageModule } from './infra/storage/storage.module';
import { HealthModule } from './modules/health/health.module';
import { InsightsModule } from './modules/insights/insights.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    DiscoveryModule,
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    PrismaModule,
    RedisModule,
    MessagingModule,
    StorageModule,
    // SEC-6: shared Redis storage; generic per-IP limit (auth routes set stricter limits).
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    AuditLogModule,
    NotificationsModule,
    AccessModule,
    AuthModule,
    DailyMisModule,
    InsightsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: AppZodValidationPipe },
    // Order matters: throttle → authenticate → CSRF → role access (all global; @Public() skips
    // authentication and access, never CSRF). Validation (Zod pipe) runs after the guards.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    AccessMetadataCheck,
  ],
})
export class AppModule {}
