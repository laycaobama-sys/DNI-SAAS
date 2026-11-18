import type { LandingBlock, LandingContent } from "@dni/core";

/**
 * Server-side renderer of a landing page. Every value is escaped (content is plain text), the page
 * loads nothing from third parties, uses no cookies and runs one tiny inline script with a nonce
 * (form timing/attribution + inline submit). Works without JavaScript.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const paras = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export interface RenderForm {
  id: string;
  consentText: string;
  marketingText: string | null;
  privacyUrl: string | null;
  askPhone: boolean;
  askCompany: boolean;
}

export interface RenderInput {
  content: LandingContent;
  orgName: string;
  canonicalUrl: string;
  noindex: boolean;
  form: RenderForm | null;
  landingId: string;
  variant: "A" | "B";
  nonce: string;
  preview?: boolean;
}

function cta(label: string, href: string) {
  if (!label) return "";
  const ext = href !== "#formulario";
  return `<a class="btn" href="${esc(href)}"${ext ? ' rel="noopener"' : ""}>${esc(label)}</a>`;
}

function block(b: LandingBlock, i: RenderInput): string {
  switch (b.type) {
    case "hero":
      return `<header class="hero"><div class="wrap"><h1>${esc(b.heading)}</h1>${b.subheading ? `<p class="lead">${esc(b.subheading)}</p>` : ""}${cta(b.ctaLabel, b.ctaHref)}</div>${b.imageUrl ? `<img class="hero-img" src="${esc(b.imageUrl)}" alt="${esc(b.imageAlt)}" loading="eager" referrerpolicy="no-referrer">` : ""}</header>`;
    case "features":
      return `<section class="wrap">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}<ul class="grid">${b.items.map((x) => `<li class="card"><h3>${esc(x.title)}</h3>${x.text ? `<p>${esc(x.text)}</p>` : ""}</li>`).join("")}</ul></section>`;
    case "text":
      return `<section class="wrap prose">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}${paras(b.body)}</section>`;
    case "faq":
      return `<section class="wrap">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}${b.items.map((x) => `<details><summary>${esc(x.q)}</summary>${paras(x.a)}</details>`).join("")}</section>`;
    case "cta":
      return `<section class="wrap band"><h2>${esc(b.heading)}</h2>${b.text ? `<p>${esc(b.text)}</p>` : ""}${cta(b.ctaLabel, b.ctaHref)}</section>`;
    case "form": {
      const f = i.form;
      if (!f) return i.preview ? `<section class="wrap" id="formulario"><p class="warn">Vista previa: elige un formulario del CRM para esta landing; sin él, este bloque no se publica.</p></section>` : "";
      const fid = (n: string) => `lf-${n}`;
      return `<section class="wrap" id="formulario">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}${b.text ? `<p>${esc(b.text)}</p>` : ""}
<form class="form" method="post" action="/api/v1/public/forms/${esc(f.id)}/submit" data-lf>
<label for="${fid("name")}">Nombre</label><input id="${fid("name")}" name="name" required maxlength="120" autocomplete="name">
<label for="${fid("email")}">Email</label><input id="${fid("email")}" name="email" type="email" required maxlength="254" autocomplete="email">
${f.askPhone ? `<label for="${fid("phone")}">Teléfono <small>(opcional)</small></label><input id="${fid("phone")}" name="phone" type="tel" maxlength="40" autocomplete="tel">` : ""}
${f.askCompany ? `<label for="${fid("company")}">Empresa <small>(opcional)</small></label><input id="${fid("company")}" name="company" maxlength="160" autocomplete="organization">` : ""}
<label for="${fid("message")}">Mensaje</label><textarea id="${fid("message")}" name="message" rows="4" maxlength="3000"></textarea>
<div class="hp" aria-hidden="true"><label>No rellenar<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label class="check"><input type="checkbox" name="consent" required> <span>${esc(f.consentText)}${f.privacyUrl ? ` <a href="${esc(f.privacyUrl)}" target="_blank" rel="noopener">Política de privacidad</a>` : ""}</span></label>
${f.marketingText ? `<label class="check"><input type="checkbox" name="marketing"> <span>${esc(f.marketingText)}</span></label>` : ""}
<input type="hidden" name="_t"><input type="hidden" name="page_url"><input type="hidden" name="referrer">
<input type="hidden" name="_lp" value="${esc(i.landingId)}"><input type="hidden" name="_v" value="${i.variant}">
<button class="btn" type="submit">${esc(b.buttonLabel || "Enviar")}</button>
<p class="status" role="status" aria-live="polite"></p>
</form></section>`;
    }
  }
}

export function renderLanding(i: RenderInput): string {
  const { content: c } = i;
  const dark = c.theme.mode === "dark";
  const accent = c.theme.accent;
  const onAccent = luminance(accent) > 0.4 ? "#0b0b0c" : "#ffffff";
  const css = `:root{--bg:${dark ? "#0b0b0c" : "#ffffff"};--bg2:${dark ? "#161618" : "#f4f4f5"};--ink:${dark ? "#f5f5f4" : "#111113"};--mute:${dark ? "#a1a1aa" : "#52525b"};--line:${dark ? "#2a2a2e" : "#e4e4e7"};--accent:${accent};--on:${onAccent}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:56px 16px}h1{font-size:clamp(34px,6vw,60px);line-height:1.05;margin:0 0 16px;letter-spacing:-.02em}h2{font-size:clamp(26px,4vw,38px);line-height:1.15;margin:0 0 20px}h3{margin:0 0 6px;font-size:19px}
.hero{background:var(--bg2)}.hero .wrap{padding:80px 16px}.lead{font-size:20px;color:var(--mute);max-width:46ch;margin:0 0 28px}.hero-img{display:block;width:100%;max-height:520px;object-fit:cover}
.btn{display:inline-flex;align-items:center;min-height:48px;padding:0 24px;border-radius:999px;background:var(--accent);color:var(--on);font-weight:600;text-decoration:none;border:0;font-size:16px;cursor:pointer}.btn:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.grid{list-style:none;padding:0;margin:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.card{border:1px solid var(--line);border-radius:16px;padding:20px}.card p{margin:0;color:var(--mute)}
.prose{max-width:720px}details{border-bottom:1px solid var(--line);padding:14px 0}summary{cursor:pointer;font-weight:600}.band{text-align:center}.band p{color:var(--mute)}
.form{display:grid;gap:8px;max-width:560px}.form input:not([type=checkbox]),.form textarea{width:100%;min-height:46px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);font:inherit;font-size:16px}
.check{display:flex;gap:10px;align-items:flex-start;color:var(--mute);font-size:15px;margin-top:6px}.check input{margin-top:5px;width:18px;height:18px;flex:none;accent-color:var(--accent)}.check a{color:var(--ink)}
.form .btn{justify-self:start;margin-top:8px}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.status{min-height:1.6em;margin:0}.warn{padding:12px;border:1px dashed var(--line);border-radius:12px;color:var(--mute)}
footer{border-top:1px solid var(--line);color:var(--mute);font-size:14px}footer .wrap{padding:24px 16px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}footer a{color:inherit}
@media (max-width:640px){.form .btn,.hero .btn{width:100%;justify-content:center}}`;
  const script = `(function(){var f=document.querySelector("[data-lf]");if(!f)return;var q=new URLSearchParams(location.search);f._t.value=Date.now();f.page_url.value=location.href;f.referrer.value=document.referrer;["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(function(k){var v=q.get(k);if(v){var i=document.createElement("input");i.type="hidden";i.name=k;i.value=v.slice(0,200);f.appendChild(i)}});var s=f.querySelector(".status");f.addEventListener("submit",function(e){e.preventDefault();if(!f.checkValidity()){f.reportValidity();return}var d={};new FormData(f).forEach(function(v,k){d[k]=v});d.consent=f.consent.checked;if(f.marketing)d.marketing=f.marketing.checked;var b=f.querySelector("button");b.disabled=true;s.textContent="Enviando…";fetch(f.action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){s.textContent=x.ok?(x.j.message||"Enviado. Gracias."):(x.j.title||"No se pudo enviar.");if(x.ok){f.reset();f._t.value=Date.now()}}).catch(function(){s.textContent="No hay conexión. Inténtalo de nuevo."}).finally(function(){b.disabled=false})})})();`;
  const robots = i.noindex || i.preview ? "noindex,nofollow" : "index,follow";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.seo.title)}</title>${c.seo.description ? `<meta name="description" content="${esc(c.seo.description)}">` : ""}<meta name="robots" content="${robots}">
${i.preview ? "" : `<link rel="canonical" href="${esc(i.canonicalUrl)}">`}<meta property="og:title" content="${esc(c.seo.title)}">${c.seo.description ? `<meta property="og:description" content="${esc(c.seo.description)}">` : ""}
<style>${css}</style></head><body>
${i.preview ? `<div style="background:#fef3c7;color:#713f12;padding:8px 16px;font-size:14px">Vista previa · no publicada · las métricas no cuentan</div>` : ""}
<main>${c.blocks.map((b) => block(b, i)).join("\n")}</main>
<footer><div class="wrap"><span>© ${new Date().getFullYear()} ${esc(i.orgName)}</span>${i.form?.privacyUrl ? `<a href="${esc(i.form.privacyUrl)}" rel="noopener">Privacidad</a>` : ""}<span>Sin cookies de seguimiento</span></div></footer>
<script nonce="${i.nonce}">${script}</script></body></html>`;
}

export const landingCsp = (nonce: string, framable: boolean) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${framable ? "'self'" : "'none'"}`;
