import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { genRequestId } from '../request-id';

/**
 * Paths pino must never print (SEC-17). Covers headers, request/response bodies and nested objects.
 * `*.x` matches one level deep inside any logged object.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  ...[
    'password',
    'newPassword',
    'confirmPassword',
    'otp',
    'otpCode',
    'csrfToken',
    'token',
    'refreshToken',
    'accessToken',
    'cookie',
    'authorization',
    'aadhaar',
    'aadhaarNo',
    'phone',
    'mobile',
  ].flatMap((k) => [k, `*.${k}`, `req.body.${k}`]),
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          genReqId: genRequestId,
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          // Health probes are noisy; keep them out of request logs.
          autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/ready' },
          customProps: () => ({ service: 'makeen-api' }),
          serializers: {
            req: (req: { id: unknown; method: unknown; url: unknown }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
          },
          ...(env.NODE_ENV === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
