import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ENV } from './config/config.module';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: true,
  });
  configureApp(app);

  const env = app.get<Env>(ENV);

  // Graceful shutdown: stop accepting connections, let in-flight requests finish, close pools.
  const forceExit = (signal: string): void => {
    setTimeout(() => {
      console.error(`Forced exit after ${env.SHUTDOWN_TIMEOUT_MS} ms (${signal})`);
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.once('SIGTERM', () => {
    forceExit('SIGTERM');
  });
  process.once('SIGINT', () => {
    forceExit('SIGINT');
  });

  const port = Number(process.env.PORT) || env.API_PORT || 10000;
  await app.listen(port, '0.0.0.0');
  console.log(`[MAKEEN API] Server successfully started and listening on http://0.0.0.0:${port}`);
}

bootstrap().catch((err: unknown) => {
  // Env validation and wiring errors land here: fail fast with a readable message (SEC-18).
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
