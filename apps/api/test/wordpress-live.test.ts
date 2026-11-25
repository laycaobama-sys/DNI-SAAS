import { describe, expect, it } from "vitest";
import { wpMarker } from "@dni/core";
import { createHarness } from "./helpers";

/**
 * End-to-end against a REAL WordPress (not a fake): runs only when WP_E2E_URL, WP_E2E_USER and
 * WP_E2E_PASS are set, e.g. with WordPress Playground (`npx @wp-playground/cli server`, see
 * docs/WORDPRESS.md). The local http address is reached through a public-looking https host so the
 * production SSRF guard and https rule stay in force for the code under test.
 */
const BASE = process.env.WP_E2E_URL;
const USER = process.env.WP_E2E_USER ?? "admin";
const PASS = process.env.WP_E2E_PASS;
const HOST = "https://wp-e2e.dnigrowth.com";

describe.skipIf(!BASE || !PASS)("WordPress real (Playground)", () => {
  it("connects, publishes, updates the same post and withdraws it to draft", async () => {
    const h = createHarness();
    Object.assign(h.env, { DATA_ENC_KEY: "0123456789abcdef".repeat(4) });
    const realFetch = h.deps.fetchImpl;
    h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(HOST)) return fetch(url.replace(HOST, BASE!.replace(/\/$/, "")), init);
      return realFetch(input, init);
    }) as typeof fetch;
    const owner = await h.signup("e2e@dnigrowth.com");
    const orgId = await h.createOrg(owner, "E2E WordPress", "starter");
    const O = `/api/v1/orgs/${orgId}`;

    const c = await owner.post(`${O}/cms/wordpress`, { siteUrl: HOST, username: USER, appPassword: PASS });
    expect(c.status, JSON.stringify(c.json)).toBe(201);

    const title = `Prueba E2E ${Date.now()}`;
    const created = await owner.post(`${O}/content/manual`, { kind: "blog_article", title });
    const id = created.json.id as string;
    const v = (await owner.get(`${O}/content/${id}`)).json.version;
    await owner.patch(`${O}/content/${id}`, { title, bodyMd: `# ${title}\n\nPrimer párrafo con **negrita**.\n\n## Sección\n\n- uno\n- dos`, expectedVersion: v });
    await owner.post(`${O}/content/${id}/submit`);
    expect((await owner.post(`${O}/content/${id}/approve`, { acknowledgeChecks: true })).status).toBe(200);

    const p1 = await owner.post(`${O}/content/${id}/wordpress`, { status: "publish" });
    expect(p1.status, JSON.stringify(p1.json)).toBe(200);
    const postId = p1.json.publication.postId as string;
    expect(p1.json.publication.state).toBe("published");

    const auth = `Basic ${btoa(`${USER}:${PASS!.replace(/\s+/g, "")}`)}`;
    const read = async () => (await fetch(`${BASE!.replace(/\/$/, "")}/wp-json/wp/v2/posts/${postId}?context=edit`, { headers: { authorization: auth } })).json() as Promise<any>;
    let wp = await read();
    expect(wp.status).toBe("publish");
    expect(wp.title.raw).toBe(title);
    expect(wp.content.raw).toContain("<h2>Sección</h2>");
    expect(wp.content.raw).toContain(wpMarker(id));

    const p2 = await owner.post(`${O}/content/${id}/wordpress`, { status: "publish" });
    expect(p2.json.publication.postId).toBe(postId);
    const sameSlug = (await (await fetch(`${BASE!.replace(/\/$/, "")}/wp-json/wp/v2/posts?slug=${wp.slug}&status=publish,draft&context=edit`, { headers: { authorization: auth } })).json()) as unknown[];
    expect(sameSlug.length).toBe(1);

    const off = await owner.post(`${O}/content/${id}/wordpress/unpublish`);
    expect(off.json.publication.state).toBe("unpublished");
    wp = await read();
    expect(wp.status).toBe("draft");
  }, 120_000);
});
