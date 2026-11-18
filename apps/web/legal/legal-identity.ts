import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Single source of truth for the identity shown on the legal pages (Aviso legal, Privacidad,
 * Condiciones). The real values live in `legal-identity.local.json`, which is git-ignored because
 * the repository is public: they are only published on dnigrowth.com, never committed.
 * See `legal-identity.example.json` for the shape.
 *
 * These values are rendered ONLY into the static legal pages. Never put them in JSON-LD, llms.txt,
 * API responses, logs or AI prompts.
 */
export interface LegalIdentity {
  commercialName: string;
  siteUrl: string;
  legalName: string;
  /** Kind of identity shown (a natural person). Not a statement about any tax registration. */
  entityType: "individual";
  taxId: string;
  taxIdLabel: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  province: string;
  country: string;
  email: string;
  phone: string;
}

const FILE = resolve(import.meta.dirname, "legal-identity.local.json");
const REQUIRED: (keyof LegalIdentity)[] = ["commercialName", "siteUrl", "legalName", "entityType", "taxId", "taxIdLabel", "streetAddress", "postalCode", "city", "province", "country", "email", "phone"];

export function loadLegalIdentity(): LegalIdentity | null {
  if (!existsSync(FILE)) return null;
  const raw = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
  const missing = REQUIRED.filter((k) => typeof raw[k] !== "string" || !(raw[k] as string).trim());
  if (missing.length) throw new Error(`legal-identity.local.json: faltan campos ${missing.join(", ")}`);
  const id = raw as unknown as LegalIdentity;
  if (id.entityType !== "individual") throw new Error("legal-identity.local.json: entityType debe ser «individual»");
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(id.email)) throw new Error("legal-identity.local.json: email no válido");
  if (!/^\+\d[\d ]{6,18}$/.test(id.phone)) throw new Error("legal-identity.local.json: teléfono en formato +34 600 000 000");
  return { ...id, email: id.email.trim().toLowerCase() };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const fullAddress = (i: LegalIdentity) => `${i.streetAddress}, ${i.postalCode} ${i.city}, ${i.province}, ${i.country}`;
const emailLink = (i: LegalIdentity) => `<a href="mailto:${esc(i.email)}">${esc(i.email)}</a>`;
const phoneLink = (i: LegalIdentity) => `<a href="tel:${esc(i.phone.replace(/\s+/g, ""))}">${esc(i.phone)}</a>`;

/** HTML fragments for the `<!--LEGAL:...-->` / `__LEGAL_...__` tokens used in apps/web/legal/*.html. */
export function legalTokens(i: LegalIdentity | null): Record<string, string> {
  if (!i) {
    const na = `<span class="draft-inline">[datos del titular no configurados en esta compilación]</span>`;
    return { "<!--LEGAL:TITULAR-->": `<p>${na}</p>`, "<!--LEGAL:RESPONSABLE-->": `<p>${na}</p>`, __LEGAL_HOLDER__: na, __LEGAL_EMAIL_LINK__: na };
  }
  return {
    "<!--LEGAL:TITULAR-->": `<dl class="idbox">
        <dt>Titular y prestador del servicio</dt><dd>${esc(i.legalName)} (persona física)</dd>
        <dt>Nombre comercial</dt><dd>${esc(i.commercialName)}</dd>
        <dt>${esc(i.taxIdLabel)}</dt><dd>${esc(i.taxId)}</dd>
        <dt>Domicilio</dt><dd>${esc(fullAddress(i))}</dd>
        <dt>Sitio web</dt><dd><a href="${esc(i.siteUrl)}">${esc(i.siteUrl.replace(/^https?:\/\//, ""))}</a></dd>
        <dt>Correo de contacto</dt><dd>${emailLink(i)}</dd>
        <dt>Teléfono de contacto</dt><dd>${phoneLink(i)}</dd>
      </dl>`,
    "<!--LEGAL:RESPONSABLE-->": `<dl class="idbox">
        <dt>Responsable del tratamiento</dt><dd>${esc(i.legalName)}, titular de ${esc(i.commercialName)} (persona física)</dd>
        <dt>${esc(i.taxIdLabel)}</dt><dd>${esc(i.taxId)}</dd>
        <dt>Dirección de contacto</dt><dd>${esc(fullAddress(i))}</dd>
        <dt>Correo de privacidad y ejercicio de derechos</dt><dd>${emailLink(i)}</dd>
        <dt>Teléfono de contacto</dt><dd>${phoneLink(i)}</dd>
      </dl>`,
    __LEGAL_HOLDER__: esc(i.legalName),
    __LEGAL_EMAIL_LINK__: emailLink(i),
  };
}
