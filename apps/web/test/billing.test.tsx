import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearWantedPlan, PlanPicker, rememberWantedPlan, SubscriptionPanel, wantedPlan } from "../src/app/pages/billing";
import { CANCEL_REASONS, RETENTION_DISCOUNT } from "@dni/core/pricing";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/billing/checkout")) return json({ url: "https://example.invalid/not-stripe", trialDays: 7 });
      if (url.endsWith("/billing/cancel")) return json({ ok: true, accessUntil: "2026-12-23T00:00:00.000Z", pausedUntil: "2027-01-23T00:00:00.000Z" });
      return json({ ok: true });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plan = (code: string, name: string, month: number, year: number, trial = 0) => ({ code, name, price_eur_month: month, price_eur_year: year, trial_days: trial, purchasable: month > 0, purchasable_year: year > 0, limits_json: "{}" });
const DATA = {
  plan: { code: "free", name: "Free" },
  trialAvailable: true,
  stripe: { configured: true, canCheckout: true },
  plans: [plan("free", "Free", 0, 0), plan("starter", "Starter", 49, 492), plan("growth", "Growth", 129, 1296, 7)],
};

describe("plan picker", () => {
  it("does not start a checkout until the terms are accepted, then sends the chosen interval", async () => {
    render(<PlanPicker data={DATA} orgId="org1" canPay stripeSub={false} planExtras={() => null} />);
    const trialBtn = screen.getByRole("button", { name: "Empezar prueba de 7 días" });
    expect(trialBtn).toHaveProperty("disabled", true);
    expect(screen.getByText(/129 €/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Anual/ }));
    expect(screen.getByText(/108 €/)).toBeTruthy();
    expect(screen.getByText(/1296 € al año|1\.296 € al año/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(trialBtn).toHaveProperty("disabled", false);
    fireEvent.click(trialBtn);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/billing/checkout"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/billing/checkout"))!.body).toEqual({ planCode: "growth", interval: "year", acceptTerms: true });
  });

  it("hides the trial once the organisation has used it", () => {
    render(<PlanPicker data={{ ...DATA, trialAvailable: false }} orgId="org1" canPay stripeSub={false} planExtras={() => null} />);
    expect(screen.queryByText(/Prueba gratis de 7 días/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Contratar este plan" })).toHaveLength(2);
  });
});

describe("subscription panel", () => {
  const sub = { status: "active", billing_interval: "month", cancel_at_period_end: 0, paused_until: null, current_period_end: "2026-12-23T00:00:00.000Z", trial_end: null, grace_until: null };
  const data = { plan: { code: "growth", name: "Growth" }, subscription: sub, stripe: { canCheckout: true }, cancelReasons: CANCEL_REASONS, retentionDiscount: RETENTION_DISCOUNT, retentionOfferAvailable: true };

  it("offers the discount only for the price reason and cancelling stays one click away", async () => {
    const reload = vi.fn();
    render(<SubscriptionPanel data={data} orgId="org1" reload={reload} openPortal={() => {}} portalBusy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Pausar o cancelar" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "too_expensive" } });
    expect(screen.getByText(/30 % de descuento durante 2 meses/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "switched_service" } });
    expect(screen.queryByText(/de descuento/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar la suscripción" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.at(-1)!.body).toEqual({ reason: "switched_service", offer: "none" });
    expect(await screen.findByText(/Cancelación programada\. Mantienes el acceso/)).toBeTruthy();
  });

  it("shows the paused, failed-payment and scheduled-cancel states with their way back", () => {
    const { rerender } = render(<SubscriptionPanel data={{ ...data, subscription: { ...sub, paused_until: "2027-01-23T00:00:00.000Z" } }} orgId="org1" reload={() => {}} openPortal={() => {}} portalBusy={false} />);
    expect(screen.getByText("Suscripción en pausa")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reanudar ahora" })).toBeTruthy();
    rerender(<SubscriptionPanel data={{ ...data, subscription: { ...sub, status: "past_due", grace_until: "2026-11-30T00:00:00.000Z" } }} orgId="org1" reload={() => {}} openPortal={() => {}} portalBusy={false} />);
    expect(screen.getByText("No hemos podido cobrar tu suscripción")).toBeTruthy();
    rerender(<SubscriptionPanel data={{ ...data, subscription: { ...sub, cancel_at_period_end: 1 } }} orgId="org1" reload={() => {}} openPortal={() => {}} portalBusy={false} />);
    expect(screen.getByRole("button", { name: "Seguir suscrito" })).toBeTruthy();
  });
});

describe("plan chosen on the public prices", () => {
  it("is remembered across signup only for paid catalogue plans and cleared on the billing page", () => {
    clearWantedPlan();
    rememberWantedPlan("free");
    rememberWantedPlan("<script>");
    expect(wantedPlan()).toBeNull();
    rememberWantedPlan("growth");
    expect(wantedPlan()).toEqual({ code: "growth", name: "Growth" });
    clearWantedPlan();
    expect(wantedPlan()).toBeNull();
  });
});
