import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { OBJECT_STORE, createObjectStore } from './object-store';

@Global()
@Module({
  providers: [
    { provide: OBJECT_STORE, inject: [ENV], useFactory: (env: Env) => createObjectStore(env) },
  ],
  exports: [OBJECT_STORE],
})
export class StorageModule {}
