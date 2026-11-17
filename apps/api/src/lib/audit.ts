import { redact } from "@dni/core";
import { uuid } from "./util";

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
  requestId?: string | null;
  approvedBy?: string | null;
}

/** Returns a prepared statement so audit rows can be written in the same atomic batch as the change. */
export function auditStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs (id, organization_id, actor_user_id, action, entity_type, entity_id, before_redacted, after_redacted, ip_hash, request_id, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid(),
      e.organizationId,
      e.actorUserId,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(redact(e.before)),
      e.after === undefined ? null : JSON.stringify(redact(e.after)),
      e.ipHash ?? null,
      e.requestId ?? null,
      e.approvedBy ?? null,
    );
}
