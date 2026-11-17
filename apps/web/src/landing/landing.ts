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

  safe("countUp", () => {
    const nums = Array.from(document.querySelectorAll<HTMLElement>("[data-count]"));
    const run = (el: HTMLElement) => {
      const target = Number(el.dataset.count ?? "0");
      const suffix = el.dataset.suffix ?? "";
      if (target === 0) return;
      const start = performance.now();
      const dur = 1400;
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / dur);
        el.textContent = `${Math.round(target * (1 - Math.pow(1 - p, 3)))}${suffix}`;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (run(e.target as HTMLElement), io.unobserve(e.target))), { threshold: 0.05 });
    nums.forEach((n) => io.observe(n));
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
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name=url]");
      const url = (input?.value ?? "").trim().slice(0, 2048);
      if (!url) return input?.focus();
      // The URL is only carried to the signup screen; validation happens server-side (SSRF policy).
      try {
        sessionStorage.setItem("dni.pendingUrl", url);
      } catch {
        /* storage may be blocked */
      }
      window.location.href = "/app/register";
    });
  });

  safe("year", () => {
    const y = document.querySelector("[data-year]");
    if (y) y.textContent = String(new Date().getFullYear());
  });
})();
