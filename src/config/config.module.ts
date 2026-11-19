import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { type Env, parseEnv } from './env.schema';

/** Injection token for the parsed, typed environment. */
export const ENV = Symbol('ENV');

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // api/.env in development; on servers real environment variables are used (they always win).
      envFilePath: ['.env'],
      validate: parseEnv,
    }),
  ],
  providers: [
    {
      provide: ENV,
      // ConfigService is injected only to guarantee .env has been loaded into process.env first.
      inject: [ConfigService],
      useFactory: (_config: ConfigService): Env => parseEnv(process.env),
    },
  ],
  exports: [ENV],
})
export class AppConfigModule {}
