import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { RequestContext } from '../../common/security/request-context';
import { PrismaService, type Tx } from '../../prisma/prisma.service';

/** Audit actions (SEC-20). Strings so later phases can add their own. */
export const AuditAction = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  SESSION_REUSE_DETECTED: 'SESSION_REUSE_DETECTED',
  OTP_SENT: 'OTP_SENT',
  OTP_FAILED: 'OTP_FAILED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  SUBMIT: 'SUBMIT',
  APPROVE: 'APPROVE',
  RETURN: 'RETURN',
  REOPEN: 'REOPEN',
  DELETE: 'DELETE',
  ROLE_CHANGE: 'ROLE_CHANGE',
  ROLE_CREATE: 'ROLE_CREATE',
  ROLE_RESET: 'ROLE_RESET',
  DESIGNATION_MAP_CHANGE: 'DESIGNATION_MAP_CHANGE',
  ASSIGNMENT_CHANGE: 'ASSIGNMENT_CHANGE',
  LOGIN_ACTIVATED: 'LOGIN_ACTIVATED',
  LOGIN_DEACTIVATED: 'LOGIN_DEACTIVATED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  KEKA_IMPORT: 'KEKA_IMPORT',
  KEKA_SYNC: 'KEKA_SYNC',
  FILE_UPLOAD: 'FILE_UPLOAD',
  FILE_DOWNLOAD: 'FILE_DOWNLOAD',
  EXPORT: 'EXPORT',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  plantId?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string | null;
  ctx?: RequestContext;
}

/**
 * Append-only audit trail. Pass the business transaction (`tx`) so the audit row commits or
 * rolls back together with the change it describes. The table rejects UPDATE/DELETE.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({ data: toRow(entry) });
  }

  /** Many rows in one statement (KEKA loads), in the same transaction as the change. */
  async recordMany(entries: readonly AuditEntry[], tx: Tx): Promise<void> {
    if (entries.length === 0) return;
    await tx.auditLog.createMany({ data: entries.map(toRow) });
  }
}

function toRow(entry: AuditEntry): Prisma.AuditLogCreateManyInput {
  return {
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    plantId: entry.plantId ?? null,
    actorId: entry.actorId ?? null,
    actorRole: entry.actorRole ?? null,
    ...(entry.before === undefined ? {} : { before: entry.before }),
    ...(entry.after === undefined ? {} : { after: entry.after }),
    reason: entry.reason ?? null,
    ip: entry.ctx?.ip ?? null,
    userAgent: entry.ctx?.userAgent ?? null,
    requestId: entry.ctx?.requestId ?? null,
  };
}
