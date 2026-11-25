/**
 * «En casa del herrero»: the free audit of our own site, with exactly the crawler and rules customers get
 * (jobs/crawl.ts + runSeoRules + buildPublicAuditResult), must score 100/100. It reads the live site, so it
 * only runs when OWN_SITE_AUDIT=1 (after every deploy: `pnpm audit:own`, and in CI on main).
 */
import { promises as dns } from "node:dns";
import { describe, expect, it } from "vitest";
import { buildPublicAuditResult, PUBLIC_AUDIT_PAGES, runSeoRules } from "@dni/core";
import { crawlSite } from "../../src/jobs/crawl";

const SITE = process.env.OWN_SITE_URL ?? "https://dnigrowth.com/";
const run = process.env.OWN_SITE_AUDIT === "1" ? describe : describe.skip;

run("own site audit (live)", () => {
  it(`${SITE} scores 100/100 in our own free audit`, async () => {
    const resolve = async (h: string) => [...(await dns.resolve4(h).catch(() => [] as string[])), ...(await dns.resolve6(h).catch(() => [] as string[]))];
    const noop = async () => {};
    const { site } = await crawlSite({ fetchImpl: fetch, resolve, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, SITE, PUBLIC_AUDIT_PAGES, { event: noop, progress: noop, checkpoint: noop }, { timeoutMs: 15_000 });
    const result = buildPublicAuditResult(runSeoRules(site), { origin: site.origin, pagesAnalyzed: site.pages.length, observedAt: new Date().toISOString() });
    const summary = result.findings.map((f) => `${f.ruleKey} (${f.urls.join(", ")}): ${f.evidence}`).join("\n");
    expect(result.pagesAnalyzed).toBeGreaterThan(0);
    expect(result.findings, summary).toEqual([]);
    expect(result.scores).toEqual({ global: 100, technical: 100, seo: 100, geo: 100 });
  }, 120_000);
});
