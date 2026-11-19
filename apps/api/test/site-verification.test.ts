import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

describe("search engine ownership files", () => {
  it("serves the Google and Bing verification files", async () => {
    const h = createHarness({});
    const g = await h.app.request("/google07bca8a276fd14a6.html", {}, h.env, h.ctx);
    expect(g.status).toBe(200);
    expect(await g.text()).toBe("google-site-verification: google07bca8a276fd14a6.html");
    const b = await h.app.request("/BingSiteAuth.xml", {}, h.env, h.ctx);
    expect(b.status).toBe(200);
    expect(b.headers.get("content-type")).toContain("application/xml");
    expect(await b.text()).toContain("<user>5CF73C5654422132BD89BBBD0FBE51A1</user>");
    const k = await h.app.request("/c2d713b310de907a6ead8590e603ff8c.txt", {}, h.env, h.ctx);
    expect(k.status).toBe(200);
    expect(await k.text()).toBe("c2d713b310de907a6ead8590e603ff8c");
  });
});
