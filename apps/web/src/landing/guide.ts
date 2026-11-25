/** /guia-como-aparecer-en-chatgpt: email form for the guide (double opt-in, see apps/api/src/routes/guide.ts). */
(() => {
  try {
    const form = document.querySelector<HTMLFormElement>("[data-guide-form]");
    const out = document.querySelector<HTMLElement>("[data-guide-out]");
    if (!form || !out) return;
    const say = (text: string, cls: "ok" | "bad") => {
      const p = document.createElement("p");
      p.className = cls;
      p.textContent = text;
      out.replaceChildren(p);
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
      const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say("Escribe un email válido.", "bad");
      if (button) button.disabled = true;
      try {
        const res = await fetch("/api/v1/public/guide", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            email,
            newsletter: (form.elements.namedItem("newsletter") as HTMLInputElement).checked,
            website: (form.elements.namedItem("website") as HTMLInputElement).value,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { message?: string; title?: string };
        if (res.ok) {
          form.reset();
          say(body.message ?? "Revisa tu correo para confirmar.", "ok");
        } else say(body.title ?? "No se pudo enviar. Inténtalo de nuevo en unos minutos.", "bad");
      } catch {
        say("No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.", "bad");
      } finally {
        if (button) button.disabled = false;
      }
    });
  } catch (e) {
    console.warn("[guía] init failed", e);
  }
})();
