import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { csrfRequestInterceptor, describeAccess, docsConfig } from './common/docs/openapi';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { ENV } from './config/config.module';
import type { Env } from './config/env.schema';

export const API_PREFIX = 'api';
const DOCS_PATH = `${API_PREFIX}/docs`;

function trustProxyValue(raw: string): boolean | number | string {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * Applies every cross-cutting HTTP concern. Shared by `main.ts` and the tests,
 * so tests exercise exactly the production middleware stack.
 */
export function configureApp(app: NestExpressApplication): void {
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.set('trust proxy', trustProxyValue(env.TRUST_PROXY));
  app.disable('x-powered-by');
  app.setGlobalPrefix(API_PREFIX);
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '100kb', extended: false });

  // The API only serves JSON (and file streams), so its CSP is the strictest possible (SEC-16).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      noSniff: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: [env.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    maxAge: 600,
  });

  if (env.SWAGGER_ENABLED && env.NODE_ENV !== 'production') {
    // Swagger UI needs its own scripts/styles; relax CSP for the docs path only.
    app.use(
      `/${DOCS_PATH}`,
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            // Dev-only docs are served over plain http on localhost.
            upgradeInsecureRequests: null,
          },
        },
      }),
    );
    // cleanupOpenApiDoc turns nestjs-zod DTO metadata into proper OpenAPI schemas; describeAccess
    // prints each operation's access rule from the decorators AccessGuard enforces.
    SwaggerModule.setup(
      DOCS_PATH,
      app,
      () => describeAccess(app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, docsConfig()))),
      {
        customSiteTitle: 'MAKEEN FM Portal API',
        swaggerOptions: {
          requestInterceptor: csrfRequestInterceptor,
          withCredentials: true,
          persistAuthorization: false,
          docExpansion: 'list',
          displayRequestDuration: true,
          tryItOutEnabled: true,
        },
      },
    );
  }

  app.enableShutdownHooks();
}
