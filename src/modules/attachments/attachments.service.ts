import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import type { Tx } from '../../prisma/prisma.service';
import { OBJECT_STORE, type ObjectStore } from '../../infra/storage/object-store';
import type { AttachmentOwner, AttachmentRef } from '../../shared';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { UPLOAD_MAX_BYTES, detectUploadType, safeFileName, type UploadMime } from './file-type';
import { VIRUS_SCANNER, type VirusScanner } from './virus-scanner';

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface StoredFile {
  body: Buffer;
  fileName: string;
  contentType: string;
}

const OWNER_PREFIX: Record<AttachmentOwner, string> = {
  DAILY_EXCEPTION: 'daily-exception',
  AUDIT: 'audit',
  LICENCE: 'licence',
  PLANT_CONTRACT: 'plant-contract',
  PLANT_ACTIVITY: 'plant-activity',
};

/**
 * Files that belong to a record (FILE-1). The caller checks access to the OWNER record first and
 * passes its transaction (row-level security applies to `attachments` by plant). Bytes go to the
 * private object store under a random key; the row and the audit entry commit together.
 */
@Injectable()
export class AttachmentsService {
  private readonly log = new Logger(AttachmentsService.name);

  constructor(
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly audit: AuditLogService,
  ) {}

  private badFile(message: string): AppError {
    return new AppError(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      message,
      [{ path: 'file', message }],
    );
  }

  async list(tx: Tx, owner: AttachmentOwner, ownerId: string): Promise<AttachmentRef[]> {
    return (await this.listMany(tx, owner, [ownerId])).get(ownerId) ?? [];
  }

  /** Files of many records at once (table rows), oldest first per record. */
  async listMany(
    tx: Tx,
    owner: AttachmentOwner,
    ownerIds: readonly string[],
  ): Promise<Map<string, AttachmentRef[]>> {
    const out = new Map<string, AttachmentRef[]>();
    if (ownerIds.length === 0) return out;
    const rows = await tx.attachment.findMany({
      where: { ownerType: owner, ownerId: { in: [...ownerIds] }, replacedAt: null },
      orderBy: { uploadedAt: 'asc' },
    });
    const ids = [...new Set(rows.map((r) => r.uploadedById))];
    const users = ids.length
      ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const name = new Map(users.map((u) => [u.id, u.name]));
    for (const r of rows) {
      const list = out.get(r.ownerId) ?? [];
      list.push({
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        uploadedAt: r.uploadedAt.toISOString(),
        uploadedBy: { id: r.uploadedById, name: name.get(r.uploadedById) ?? '—' },
      });
      out.set(r.ownerId, list);
    }
    return out;
  }

  /** Check, store and record one upload. `message` is the module's file-type text. */
  async add(
    tx: Tx,
    owner: { type: AttachmentOwner; id: string; plantId: string },
    file: IncomingFile,
    actorId: string,
    ctx: RequestContext,
    message: string,
    allowed?: readonly UploadMime[],
  ): Promise<string> {
    if (file.size === 0 || file.size > UPLOAD_MAX_BYTES || file.buffer.length !== file.size)
      throw this.badFile(message);
    const mime = detectUploadType(file.buffer);
    if (!mime || (allowed && !allowed.includes(mime))) throw this.badFile(message);
    const scan = await this.scanner.scan(file.buffer);
    if (scan === 'INFECTED') throw this.badFile('This file failed the virus check.');
    const id = randomUUID();
    const key = `${OWNER_PREFIX[owner.type]}/${id}`;
    const fileName = safeFileName(file.originalname, mime);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    await this.store.put(key, file.buffer, mime);
    try {
      await tx.attachment.create({
        data: {
          id,
          ownerType: owner.type,
          ownerId: owner.id,
          plantId: owner.plantId,
          storageKey: key,
          fileName,
          mimeType: mime,
          sizeBytes: file.size,
          sha256,
          scanStatus: scan,
          uploadedById: actorId,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.FILE_UPLOAD,
          entity: 'attachment',
          entityId: id,
          plantId: owner.plantId,
          actorId,
          after: { ownerType: owner.type, ownerId: owner.id, fileName, mimeType: mime, sha256 },
          ctx,
        },
        tx,
      );
    } catch (e: unknown) {
      await this.store.delete(key).catch((err: unknown) => {
        this.log.warn(`Orphan object ${key} not removed: ${String(err)}`);
      });
      throw e;
    }
    return id;
  }

  private async find(tx: Tx, owner: AttachmentOwner, ownerId: string, fileId: string) {
    const a = await tx.attachment.findFirst({
      where: { id: fileId, ownerType: owner, ownerId, replacedAt: null },
    });
    if (!a) throw new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'File not found.');
    return a;
  }

  /** Read one file for an authorised download; the download is audited. */
  async read(
    tx: Tx,
    owner: AttachmentOwner,
    ownerId: string,
    fileId: string,
    actorId: string,
    ctx: RequestContext,
  ): Promise<StoredFile> {
    const a = await this.find(tx, owner, ownerId, fileId);
    const body = await this.store.get(a.storageKey);
    await this.audit.record(
      {
        action: AuditAction.FILE_DOWNLOAD,
        entity: 'attachment',
        entityId: a.id,
        plantId: a.plantId,
        actorId,
        ctx,
      },
      tx,
    );
    return { body, fileName: a.fileName, contentType: a.mimeType };
  }

  /** Remove from the record: the row is kept (marked replaced) for the audit trail. */
  async remove(
    tx: Tx,
    owner: AttachmentOwner,
    ownerId: string,
    fileId: string,
    actorId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const a = await this.find(tx, owner, ownerId, fileId);
    await tx.attachment.update({
      where: { id: a.id },
      data: { replacedAt: new Date(), replacedById: actorId },
    });
    await this.audit.record(
      {
        action: AuditAction.DELETE,
        entity: 'attachment',
        entityId: a.id,
        plantId: a.plantId,
        actorId,
        before: { fileName: a.fileName },
        ctx,
      },
      tx,
    );
  }
}
