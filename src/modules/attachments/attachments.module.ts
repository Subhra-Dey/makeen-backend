import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { NoVirusScanner, VIRUS_SCANNER } from './virus-scanner';

/** Record-owned files (FILE-1): Daily Exception now; Audit, Licence and Plant files in Phase 9. */
@Module({
  providers: [AttachmentsService, { provide: VIRUS_SCANNER, useClass: NoVirusScanner }],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
