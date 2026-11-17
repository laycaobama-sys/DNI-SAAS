import { describe, expect, it } from "vitest";
import { isPrivateAddress, safeFetch, UrlBlockedError, validatePublicUrl, type Resolver } from "../src/ssrf";

const publicResolver: Resolver = async () => ["93.184.216.34"];

describe("validatePublicUrl", () => {
  const blocked: Array<[string, string]> = [
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["gopher://evil.com/_", "scheme_not_allowed"],
    ["ftp://example.org/x", "scheme_not_allowed"],
    ["data:text/html;base64,PHNjcmlwdD4=", "scheme_not_allowed"],
    ["javascript:alert(1)", "scheme_not_allowed"],
    ["http://localhost/", "hostname_blocked"],
    ["http://LOCALHOST./admin", "hostname_blocked"],
    ["http://api.localhost/", "hostname_blocked"],
    ["http://127.0.0.1/", "ip_literal_blocked"],
    ["http://2130706433/", "ip_literal_blocked"],
    ["http://0x7f000001/", "ip_literal_blocked"],
    ["http://0177.0.0.1/", "ip_literal_blocked"],
    ["http://127.1/", "ip_literal_blocked"],
    ["http://169.254.169.254/latest/meta-data/", "ip_literal_blocked"],
    ["http://[::1]/", "ip_literal_blocked"],
    ["http://[::ffff:127.0.0.1]/", "ip_literal_blocked"],
    ["http://metadata.google.internal/computeMetadata/v1/", "hostname_blocked"],
    ["http://service.internal/", "hostname_blocked"],
    ["http://printer.local/", "hostname_blocked"],
    ["http://intranet/", "hostname_blocked"],
    ["http://user:pass@example.com/", "userinfo_not_allowed"],
    ["http://example.com:22/", "port_not_allowed"],
    ["http://example.com:6379/", "port_not_allowed"],
    ["https://example.com:8443/", "port_not_allowed"],
    ["http://exa mple.com/", "invalid_url"],
    ["http://example.com\\@evil.com/", "invalid_url"],
  ];
  it.each(blocked)("blocks %s", (url, reason) => {
    try {
      validatePublicUrl(url);
      expect.fail(`expected ${url} to be blocked`);
    } catch (e) {
      expect(e).toBeInstanceOf(UrlBlockedError);
      expect((e as UrlBlockedError).reason).toBe(reason);
    }
  });

  it("accepts and normalises a public URL without scheme", () => {
    expect(validatePublicUrl("www.mi-negocio.es/servicios#x").toString()).toBe("https://www.mi-negocio.es/servicios");
  });
  it("rejects very long URLs", () => {
    expect(() => validatePublicUrl(`https://a.com/${"x".repeat(3000)}`)).toThrow(UrlBlockedError);
  });
});

describe("isPrivateAddress", () => {
  it.each(["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "151.101.1.69"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("safeFetch", () => {
  it("blocks DNS that resolves to a private address (rebinding-style)", async () => {
    const resolve: Resolver = async () => ["10.0.0.5"];
    await expect(safeFetch("https://evil-rebind.com/", { resolve, fetchImpl: async () => new Response("x") })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("blocks when ANY resolved address is private", async () => {
    const resolve: Resolver = async () => ["93.184.216.34", "127.0.0.1"];
    await expect(safeFetch("https://mixed.com/", { resolve, fetchImpl: async () => new Response("x") })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("re-validates redirects and blocks redirect to metadata endpoint", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })) as unknown as typeof fetch;
    await expect(safeFetch("https://redirector.com/", { resolve: publicResolver, fetchImpl })).rejects.toMatchObject({ reason: "ip_literal_blocked" });
  });

  it("re-resolves DNS on redirect hops", async () => {
    const resolve: Resolver = async (h) => (h === "good.com" ? ["93.184.216.34"] : ["192.168.0.10"]);
    const fetchImpl = (async () => new Response(null, { status: 301, headers: { location: "https://internal-looking.com/" } })) as unknown as typeof fetch;
    await expect(safeFetch("https://good.com/", { resolve, fetchImpl })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("enforces max redirects", async () => {
    let n = 0;
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: `https://loop.com/${++n}` } })) as unknown as typeof fetch;
    await expect(safeFetch("https://loop.com/", { resolve: publicResolver, fetchImpl, maxRedirects: 3 })).rejects.toMatchObject({ reason: "too_many_redirects" });
  });

  it("truncates bodies over maxBytes", async () => {
    const fetchImpl = (async () => new Response("a".repeat(5000), { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await safeFetch("https://big.com/", { resolve: publicResolver, fetchImpl, maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(1000);
  });

  it("fetches a benign page and records the final URL", async () => {
    const fetchImpl = (async (u: string) =>
      u === "https://ok.com/"
        ? new Response(null, { status: 301, headers: { location: "/home" } })
        : new Response("<html></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await safeFetch("https://ok.com/", { resolve: publicResolver, fetchImpl });
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe("https://ok.com/home");
    expect(r.redirects).toEqual(["https://ok.com/home"]);
  });
});
