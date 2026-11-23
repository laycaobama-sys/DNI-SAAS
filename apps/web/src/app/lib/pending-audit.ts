import { ApiError, post } from "./api";

/**
 * Free audit started on the public site before signing up (/auditoria/{id} → «Ver el informe completo»).
 * Kept in localStorage so it survives the email-verification link opening in another tab; claimed for the
 * first organisation the user creates or opens, then forgotten.
 */
const KEY = "dni.pendingAudit";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rememberPendingAudit(id: string | null): void {
  if (!id || !UUID_RE.test(id)) return;
  try {
    localStorage.setItem(KEY, id.toLowerCase());
  } catch {
    /* storage unavailable */
  }
}

export function pendingAudit(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && UUID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function clearPendingAudit(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Links the pending audit to `orgId`. Returns the audited URL (to prefill the full analysis) or null. */
export async function claimPendingAudit(orgId: string): Promise<string | null> {
  const id = pendingAudit();
  if (!id) return null;
  try {
    const r = await post<{ analyzeUrl: string }>(`/orgs/${orgId}/public-audits/${id}/claim`);
    clearPendingAudit();
    try {
      if (r.analyzeUrl && !sessionStorage.getItem("dni.pendingUrl")) sessionStorage.setItem("dni.pendingUrl", r.analyzeUrl);
    } catch {
      /* ignore */
    }
    return r.analyzeUrl ?? null;
  } catch (e) {
    // Gone (expired after 30 days) or not allowed: forget it; a network error keeps it for the next try.
    if (e instanceof ApiError && e.status !== 0) clearPendingAudit();
    return null;
  }
}
