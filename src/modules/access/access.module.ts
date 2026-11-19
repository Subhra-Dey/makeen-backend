import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { MeController } from './me.controller';

@Global()
@Module({
  controllers: [MeController],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
