import type { Tx } from '@rental/db';
import { auditLog } from '@rental/db';
import type { AuthCtx } from '../auth/context.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  risk?: 'normal' | 'risky';
}

/** เขียนประวัติในธุรกรรมเดียวกับการเปลี่ยนแปลง · ถ้าเขียนประวัติไม่ได้ การเปลี่ยนแปลงทั้งหมดถูกยกเลิก */
export async function audit(tx: Tx, auth: Pick<AuthCtx, 'orgId' | 'userId' | 'deviceId' | 'ip'>, e: AuditEntry) {
  await tx.insert(auditLog).values({
    orgId: auth.orgId,
    actorUserId: auth.userId,
    deviceId: auth.deviceId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason ?? null,
    risk: e.risk ?? 'normal',
    ip: auth.ip,
  });
}
