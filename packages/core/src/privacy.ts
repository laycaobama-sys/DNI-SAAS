/**
 * Sensitive-data guard for AI routing.
 *
 * Free third-party AI providers (OpenRouter `:free` endpoints, Gemini free tier) may log prompts or use them
 * for training. Our condition: personal or secret data never leaves Cloudflare unless the organisation has
 * no alternative — so a prompt that contains any category below is processed only by Workers AI.
 *
 * Detection is deliberately conservative on the categories that matter (identity documents, bank data,
 * card numbers, credentials) and validated with check digits to avoid false positives on ordinary numbers.
 */
export type SensitiveCategory = "dni_nie" | "iban" | "tarjeta" | "credencial" | "email" | "telefono";

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

function validDni(num: string, letter: string): boolean {
  return DNI_LETTERS[Number(num) % 23] === letter.toUpperCase();
}

function validIban(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const DNI_RE = /\b(\d{8})[\s-]?([A-Za-z])\b/g;
const NIE_RE = /\b([XYZxyz])[\s-]?(\d{7})[\s-]?([A-Za-z])\b/g;
const IBAN_RE = /\b[A-Za-z]{2}\d{2}(?:[\s]?[A-Za-z0-9]{4}){2,7}(?:[\s]?[A-Za-z0-9]{1,4})?\b/g;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// International numbers with + prefix, or Spanish 9-digit numbers starting with 6, 7, 8 or 9 (optionally grouped).
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g;
const ES_PHONE_RE = /\b[6-9]\d{2}[\s.-]?\d{2,3}[\s.-]?\d{2,3}[\s.-]?\d{0,2}\b/g;
const CREDENTIAL_RE =
  /\b(?:sk|rk|whsec|ghp|gho|xox[abp])_[A-Za-z0-9_]{8,}|\bsk-(?:or|ant|proj)-[A-Za-z0-9_-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:contrase[ñn]a|password|passwd|pwd|clave(?: de acceso)?|pin)\s*[:=]\s*\S{4,}/i;

function hasValidPhone(text: string): boolean {
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, "");
    if (raw.startsWith("+") && digits.length >= 9 && digits.length <= 15) return true;
  }
  for (const m of text.matchAll(ES_PHONE_RE)) {
    if (m[0].replace(/\D/g, "").length === 9) return true;
  }
  return false;
}

/** Returns the categories of sensitive data found in `text` (empty array when none). */
export function detectSensitiveData(text: string): SensitiveCategory[] {
  const found = new Set<SensitiveCategory>();
  if (!text) return [];
  const t = text.normalize("NFKC");
  for (const m of t.matchAll(DNI_RE)) if (validDni(m[1]!, m[2]!)) found.add("dni_nie");
  for (const m of t.matchAll(NIE_RE)) {
    const prefix = { X: "0", Y: "1", Z: "2" }[m[1]!.toUpperCase() as "X" | "Y" | "Z"];
    if (validDni(prefix + m[2]!, m[3]!)) found.add("dni_nie");
  }
  for (const m of t.matchAll(IBAN_RE)) if (validIban(m[0])) found.add("iban");
  for (const m of t.matchAll(CARD_RE)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d)) found.add("tarjeta");
  }
  if (CREDENTIAL_RE.test(t)) found.add("credencial");
  if (EMAIL_RE.test(t)) found.add("email");
  if (hasValidPhone(t)) found.add("telefono");
  return [...found].sort();
}
