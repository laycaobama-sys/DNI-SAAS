/**
 * Landing enhancements. Content is hard-coded in HTML; this script only enriches it.
 * Every init is isolated with safe() so one failure never breaks the page.
 */
(() => {
  const safe = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[landing] ${name} failed`, e);
    }
  };
  document.documentElement.classList.add("js");

  /**
   * Own product analytics: no cookies, no storage, no third parties. The server keeps the event name, the
   * path without query string and a daily-rotating visitor hash (never the IP). Fire-and-forget.
   */
  const trackEvent = (event: string, props: Record<string, string> = {}) => {
    try {
      const body = JSON.stringify({ event, path: location.pathname, props });
      const blob = new Blob([body], { type: "application/json" });
      if (!(navigator.sendBeacon && navigator.sendBeacon("/api/v1/public/events", blob))) {
        void fetch("/api/v1/public/events", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
      }
    } catch {
      /* analytics must never break the page */
    }
  };

  safe("mouseGradient", () => {
    const el = document.querySelector<HTMLElement>("[data-mouse-gradient]");
    if (!el) return;
    let raf = 0;
    let x = 50;
    let y = 40;
    const apply = () => {
      raf = 0;
      document.documentElement.style.setProperty("--mx", `${x}%`);
      document.documentElement.style.setProperty("--my", `${y}%`);
    };
    window.addEventListener(
      "pointermove",
      (e) => {
        x = (e.clientX / window.innerWidth) * 100;
        y = (e.clientY / window.innerHeight) * 100;
        if (!raf) raf = requestAnimationFrame(apply);
      },
      { passive: true },
    );
  });

  safe("navSolid", () => {
    const nav = document.querySelector<HTMLElement>("[data-nav]");
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("is-solid", window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  });

  // Module badges come from the same registry the app uses (/api/v1/public/features), so the site
  // never claims «Disponible» for something that is not built. The HTML keeps a safe default.
  safe("featureStatus", () => {
    const badges = Array.from(document.querySelectorAll<HTMLElement>("[data-feature]"));
    if (!badges.length || !("fetch" in window)) return;
    fetch("/api/v1/public/features")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: Array<{ key: string; status: string; statusLabel: string; limit?: string }> } | null) => {
        for (const f of d?.items ?? []) {
          const el = badges.find((b) => b.dataset.feature === f.key);
          if (!el) continue;
          el.textContent = f.statusLabel;
          el.classList.toggle("badge-live", f.status !== "building");
          if (f.limit) el.title = f.limit;
          else el.removeAttribute("title");
        }
      })
      .catch(() => undefined);
  });

  safe("reveal", () => {
    const items = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    const show = (el: Element) => el.classList.add("is-in");
    if (!("IntersectionObserver" in window)) return items.forEach(show);
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (show(e.target), io.unobserve(e.target))),
      { threshold: 0.02, rootMargin: "0px 0px -5% 0px" },
    );
    items.forEach((el) => io.observe(el));
    // Safety net: never leave content hidden.
    window.setTimeout(() => items.forEach(show), 6000);
  });

  // 90-second demo: the section stays hidden (nothing downloaded) until data-video-src points to a real
  // file in /demo/. The player keeps a 16:9 box (CSS aspect-ratio), so showing it causes no layout shift.
  safe("demoVideo", () => {
    const section = document.querySelector<HTMLElement>("[data-demo]");
    const frame = section?.querySelector<HTMLElement>("[data-demo-frame]");
    const src = section?.dataset.videoSrc?.trim() ?? "";
    if (!section || !frame || !/^\/demo\/[\w.-]+\.(mp4|webm)$/.test(src)) return;
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "none";
    video.playsInline = true;
    video.width = 1280;
    video.height = 720;
    video.src = src;
    video.setAttribute("aria-describedby", "demo-desc");
    const poster = section.dataset.videoPoster?.trim() ?? "";
    if (/^\/demo\/[\w.-]+\.(webp|jpg|png)$/.test(poster)) video.poster = poster;
    const captions = section.dataset.videoCaptions?.trim() ?? "";
    if (/^\/demo\/[\w.-]+\.vtt$/.test(captions)) {
      const track = document.createElement("track");
      Object.assign(track, { kind: "captions", src: captions, srclang: "es", label: "Español", default: true });
      video.appendChild(track);
    }
    frame.appendChild(video);
    section.hidden = false;
  });

  safe("accordion", () => {
    document.querySelectorAll<HTMLButtonElement>(".row-head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const body = document.getElementById(btn.getAttribute("aria-controls") ?? "");
        const open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!open));
        if (body) body.hidden = open;
      });
    });
  });

  safe("urlForm", () => {
    const form = document.querySelector<HTMLFormElement>("[data-url-form]");
    const status = document.querySelector<HTMLElement>("[data-url-status]");
    // Without the free audit (network error): carry the URL to the signup screen, as before.
    const toSignup = (url: string) => {
      try {
        sessionStorage.setItem("dni.pendingUrl", url);
      } catch {
        /* storage may be blocked */
      }
      trackEvent("audit_started", { from: "landing" });
      window.location.href = "/app/register";
    };
    // «Auditar mi web» buttons scroll to the form: put the cursor in the field too.
    const focusField = () => window.setTimeout(() => form?.querySelector<HTMLInputElement>("input[name=url]")?.focus({ preventScroll: true }), 350);
    document.querySelectorAll<HTMLAnchorElement>('a[href="#auditar"]').forEach((a) => a.addEventListener("click", focusField));
    if (location.hash === "#auditar") focusField();
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name=url]");
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      const url = (input?.value ?? "").trim().slice(0, 500);
      if (!url) return input?.focus();
      if (btn) btn.disabled = true;
      if (status) status.textContent = "Preparando tu auditoría…";
      try {
        // Free audit without an account: validated server-side (public URLs only), limited per visitor.
        const res = await fetch("/api/v1/public/audits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
        const body = (await res.json().catch(() => ({}))) as { page?: string; title?: string; code?: string };
        if (res.ok && body.page && body.page.startsWith("/auditoria/")) {
          window.location.href = body.page;
          return;
        }
        if (status) {
          status.textContent = body.title ?? "No se pudo empezar la auditoría. Revisa la dirección e inténtalo de nuevo.";
          if (res.status === 429) {
            const a = document.createElement("a");
            a.href = "/app/register";
            a.textContent = " Crear mi cuenta gratis";
            status.appendChild(a);
          }
        }
        input?.focus();
      } catch {
        toSignup(url);
        return;
      }
      if (btn) btn.disabled = false;
    });
  });

  // Contact form: works without JS (plain POST → thank-you page); with JS it sends JSON and answers inline.
  safe("contactForm", () => {
    const form = document.querySelector<HTMLFormElement>("[data-contact-form]");
    const status = document.querySelector<HTMLElement>("[data-contact-status]");
    if (!form || !status) return;
    const set = (name: string, v: string) => {
      const el = form.elements.namedItem(name) as HTMLInputElement | null;
      if (el) el.value = v;
    };
    set("_t", String(Date.now()));
    set("page_url", location.href);
    set("referrer", document.referrer);
    const q = new URLSearchParams(location.search);
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      const v = q.get(k);
      if (!v) continue;
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = k;
      i.value = v.slice(0, 200);
      form.appendChild(i);
    }
    const say = (msg: string, tone: "ok" | "error" | "") => {
      status.textContent = msg;
      status.dataset.tone = tone;
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (btn) btn.disabled = true;
      say("Enviando…", "");
      const data: Record<string, string | boolean> = {};
      new FormData(form).forEach((v, k) => {
        if (typeof v === "string") data[k] = v;
      });
      data.consent = (form.elements.namedItem("consent") as HTMLInputElement).checked;
      data.marketing = (form.elements.namedItem("marketing") as HTMLInputElement).checked;
      try {
        const res = await fetch(form.action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
        const body = (await res.json().catch(() => ({}))) as { message?: string; title?: string };
        if (res.ok) {
          form.reset();
          set("_t", String(Date.now()));
          say(body.message ?? "Mensaje enviado. Gracias.", "ok");
        } else {
          say(body.title ?? "No se pudo enviar. Inténtalo de nuevo o escribe a hola@dnigrowth.com.", "error");
        }
      } catch {
        say("No hay conexión. Inténtalo de nuevo o escribe a hola@dnigrowth.com.", "error");
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  });

  safe("year", () => {
    const y = document.querySelector("[data-year]");
    if (y) y.textContent = String(new Date().getFullYear());
  });
})();
