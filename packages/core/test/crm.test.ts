import { describe, expect, it } from "vitest";
import { AllowedOrigins, LeadSubmission, pageUrlWithoutQuery, referrerHost, spamSignals } from "../src/crm";

describe("LeadSubmission", () => {
  it("cleans control/bidi characters, normalises email and reads HTML checkboxes", () => {
    const r = LeadSubmission.parse({ name: " Ana‮ Pérez ", email: " ANA@Example.COM", consent: "on", marketing: "", extra: "ignored" });
    expect(r).toMatchObject({ name: "Ana Pérez", email: "ana@example.com", consent: true, marketing: false });
    expect("extra" in r).toBe(false);
  });
  it("keeps line breaks in the message but limits them", () => {
    expect(LeadSubmission.parse({ name: "Ana", email: "a@b.es", message: "Hola\r\n\r\n\r\n\r\nAdiós" }).message).toBe("Hola\n\nAdiós");
  });
});

describe("spamSignals", () => {
  const now = 1_000_000;
  it("flags honeypot, speed, link floods and links in the name; a normal person passes", () => {
    expect(spamSignals({ name: "Ana", website: "", _t: now - 9000, message: "Hola, ver https://mi.es" }, now)).toEqual([]);
    expect(spamSignals({ name: "Ana", website: "x" }, now)).toEqual(["honeypot"]);
    expect(spamSignals({ name: "Ana", _t: String(now - 500) }, now)).toEqual(["too_fast"]);
    expect(spamSignals({ name: "Ana", message: "http://a http://b www.c.ru" }, now)).toEqual(["too_many_links"]);
    expect(spamSignals({ name: "visit www.x.ru" }, now)).toEqual(["link_in_name"]);
  });
});

describe("attribution helpers keep no personal data from URLs", () => {
  it("referrer → host only, own site ignored; page → without query", () => {
    expect(referrerHost("https://www.google.com/search?q=ana+perez")).toBe("www.google.com");
    expect(referrerHost("https://mi.es/x", "https://mi.es")).toBeNull();
    expect(referrerHost("javascript:alert(1)")).toBeNull();
    expect(pageUrlWithoutQuery("https://mi.es/contacto?email=a@b.es#f")).toBe("https://mi.es/contacto");
  });
});

describe("AllowedOrigins", () => {
  it("accepts https origins (http only for localhost) and deduplicates", () => {
    expect(AllowedOrigins.parse(["https://a.es/x", "https://a.es", "http://localhost:3000"])).toEqual(["https://a.es", "http://localhost:3000"]);
    expect(AllowedOrigins.safeParse(["http://a.es"]).success).toBe(false);
    expect(AllowedOrigins.safeParse(["nota"]).success).toBe(false);
  });
});
