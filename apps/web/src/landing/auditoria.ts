/**
 * /auditoria/{id}: the Worker renders the whole result (it works without JS). This script only enhances it:
 * waits for a running audit and reloads when it finishes, shows the native share and copy buttons, sends the
 * competitor form and records one cookieless «audit_teaser_viewed» event. Each init is isolated with safe().
 */
(() => {
  const safe = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[auditoria] ${name} failed`, e);
    }
  };
  const ready = (fn: () => void) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());

  ready(() => {
    const root = document.querySelector<HTMLElement>("[data-audit-state]");
    if (!root) return;
    const id = root.dataset.auditId ?? "";
    const state = root.dataset.auditState ?? "";
    const vsId = root.dataset.vsId ?? "";

    safe("poll", () => {
      const waitingFor = state === "queued" || state === "running" ? id : vsId;
      if (!waitingFor || !/^[0-9a-f-]{36}$/.test(waitingFor)) return;
      const started = Date.now();
      const status = document.querySelector<HTMLElement>("[data-audit-progress]");
      const tick = async () => {
        try {
          const res = await fetch(`/api/v1/public/audits/${waitingFor}`, { headers: { accept: "application/json" } });
          const body = (await res.json()) as { status?: string };
          if (body.status === "completed" || body.status === "failed") return location.reload();
        } catch {
          /* keep waiting */
        }
        const elapsed = Date.now() - started;
        if (status && elapsed > 45_000) status.textContent = "Está tardando más de lo normal (algunas webs responden despacio). Seguimos revisando…";
        if (elapsed < 6 * 60_000) window.setTimeout(tick, elapsed < 30_000 ? 2500 : 5000);
        else if (status) status.textContent = "La revisión no ha terminado. Vuelve a cargar la página en unos minutos.";
      };
      window.setTimeout(tick, 2000);
    });

    safe("share", () => {
      const share = document.querySelector<HTMLButtonElement>("[data-share]");
      const copy = document.querySelector<HTMLButtonElement>("[data-copy]");
      const out = document.querySelector<HTMLElement>("[data-copy-status]");
      if (share && typeof navigator.share === "function") {
        share.hidden = false;
        share.addEventListener("click", () => {
          void navigator.share({ title: document.title, text: share.dataset.shareText ?? "", url: share.dataset.shareUrl ?? location.href }).catch(() => undefined);
        });
      }
      if (copy && navigator.clipboard) {
        copy.hidden = false;
        copy.addEventListener("click", () => {
          void navigator.clipboard.writeText(copy.dataset.copy ?? location.href).then(
            () => out && (out.textContent = "Enlace copiado."),
            () => out && (out.textContent = "No se pudo copiar. Copia la dirección de la barra del navegador."),
          );
        });
      }
    });

    safe("compare", () => {
      const section = document.querySelector<HTMLElement>("[data-compare]");
      const form = document.querySelector<HTMLFormElement>("[data-compare-form]");
      const out = document.querySelector<HTMLElement>("[data-compare-status]");
      if (!section || !form || !out) return;
      section.hidden = false;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = form.querySelector<HTMLInputElement>("input[name=url]");
        const url = (input?.value ?? "").trim();
        if (!url) return input?.focus();
        const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
        if (btn) btn.disabled = true;
        out.textContent = "Empezando la revisión del competidor…";
        try {
          const res = await fetch(`/api/v1/public/audits/${form.dataset.auditId}/compare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
          const body = (await res.json().catch(() => ({}))) as { page?: string; title?: string };
          if (res.ok && body.page && body.page.startsWith("/auditoria/")) {
            location.href = body.page;
            return;
          }
          out.textContent = body.title ?? "No se pudo empezar la comparación. Inténtalo de nuevo.";
        } catch {
          out.textContent = "No hay conexión. Inténtalo de nuevo.";
        }
        if (btn) btn.disabled = false;
      });
    });

    safe("track", () => {
      if (state !== "completed") return;
      const body = JSON.stringify({ event: "audit_teaser_viewed", path: "/auditoria", props: { vs: vsId ? "1" : "0" } });
      const blob = new Blob([body], { type: "application/json" });
      if (!(navigator.sendBeacon && navigator.sendBeacon("/api/v1/public/events", blob))) {
        void fetch("/api/v1/public/events", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
      }
    });
  });
})();
