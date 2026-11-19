import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { EMAIL_PROVIDER, SMS_PROVIDER } from './messaging';
import { createEmailProvider, createSmsProvider } from './providers';

@Global()
@Module({
  providers: [
    { provide: EMAIL_PROVIDER, inject: [ENV], useFactory: (env: Env) => createEmailProvider(env) },
    { provide: SMS_PROVIDER, inject: [ENV], useFactory: (env: Env) => createSmsProvider(env) },
  ],
  exports: [EMAIL_PROVIDER, SMS_PROVIDER],
})
export class MessagingModule {}
