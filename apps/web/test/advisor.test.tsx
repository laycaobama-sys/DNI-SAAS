import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { AdvisorPage } from "../src/app/pages/ai";
import { ErrorBoundary } from "../src/app/errorboundary";

/**
 * B1 — opening a conversation in the advisor blanked the whole app in Chrome: Element.scrollIntoView
 * returns a Promise there, an implicit-return arrow handed it to React as the effect "cleanup", and
 * React crashed calling it. The page must survive re-renders, conversation switches and unmount.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CONVS = {
  c1: [
    { id: "m1", role: "user", content: "¿Qué arreglo primero?" },
    { id: "m2", role: "assistant", content: "Empieza por la imagen social de la home.", check: { ok: false, warnings: ["No cita ninguna URL de la auditoría como evidencia."], citedUrls: [] } },
  ],
  c2: [{ id: "m3", role: "assistant", content: "Segunda conversación.", check: { ok: true, warnings: [], citedUrls: [] } }],
};

function fakeApi(url: string) {
  if (url.endsWith("/ai/status")) return json({ available: true, images: false });
  if (url.endsWith("/advisor/conversations")) return json({ items: [{ id: "c1", title: "Prioridades", updated_at: new Date().toISOString() }, { id: "c2", title: "Otra", updated_at: new Date().toISOString() }] });
  if (url.endsWith("/brands")) return json({ items: [] });
  const m = /\/advisor\/conversations\/(c\d)$/.exec(url);
  if (m) return json({ messages: CONVS[m[1] as keyof typeof CONVS] });
  return json({ code: "not_found", title: "No encontrado" }, 404);
}

let goTo: (to: string) => void = () => {};
function NavProbe() {
  const nav = useNavigate();
  goTo = nav;
  return null;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => fakeApi(String(input))));
  // Chrome's behaviour: scrollIntoView returns a Promise.
  Element.prototype.scrollIntoView = function () {
    return Promise.resolve() as unknown as void;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Asesor IA (B1)", () => {
  it("opens a conversation, switches to another and unmounts without crashing", async () => {
    const onError = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(
      <MemoryRouter initialEntries={["/o/org-1/advisor?c=c1"]}>
        <NavProbe />
        <ErrorBoundary>
          <Routes>
            <Route path="/o/:orgId/advisor" element={<AdvisorPage />} />
          </Routes>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Empieza por la imagen social de la home.")).toBeTruthy();
    // The deterministic grounding check is shown next to the answer (B9).
    expect(screen.getByText(/No cita ninguna URL de la auditoría/)).toBeTruthy();

    await act(async () => goTo("/o/org-1/advisor?c=c2"));
    expect(await screen.findByText("Segunda conversación.")).toBeTruthy();
    await act(async () => goTo("/o/org-1/advisor"));
    await waitFor(() => expect(screen.queryByText("Segunda conversación.")).toBeNull());

    expect(screen.queryByText("Esta sección no se ha podido mostrar")).toBeNull();
    expect(() => view.unmount()).not.toThrow();
    expect(onError.mock.calls.flat().join(" ")).not.toMatch(/is not a function/);
    onError.mockRestore();
  });
});

describe("ErrorBoundary (B2)", () => {
  it("contains a module crash, offers retry and a way home, and never shows the stack", async () => {
    const onError = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    function Fragile() {
      if (fail) throw new Error("render roto con dato@privado.es");
      return <p>Módulo recuperado</p>;
    }
    render(
      <ErrorBoundary homeHref="/app/o/org-1">
        <Fragile />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Esta sección no se ha podido mostrar");
    expect(alert.textContent).not.toContain("dato@privado.es");
    expect(screen.getByRole("link", { name: /Command Center/ }).getAttribute("href")).toBe("/app/o/org-1");
    fail = false;
    await act(async () => screen.getByRole("button", { name: /Reintentar/ }).click());
    expect(screen.getByText("Módulo recuperado")).toBeTruthy();
    onError.mockRestore();
  });
});
