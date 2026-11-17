/** Redaction for logs, audit trails and job events. Never log raw tokens, secrets or personal data. */
const SENSITIVE_KEYS = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|session|signature|card|iban|cvc|cvv|ssn/i;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_SECRET_RE = /\b(sk|pk|rk|whsec|re|ghp|gho|xox[abp])_[A-Za-z0-9_]{8,}\b/g;

export function maskEmail(email: string): string {
  return email.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

export function redactString(s: string): string {
  return s.replace(BEARER_RE, "$1 [REDACTED]").replace(LONG_SECRET_RE, "[REDACTED_SECRET]").replace(EMAIL_RE, (_m, f: string, d: string) => `${f}***@${d}`);
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[DEPTH_LIMIT]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
