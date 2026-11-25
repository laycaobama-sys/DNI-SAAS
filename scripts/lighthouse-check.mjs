// Lighthouse (mobile) on the key public pages: SEO, accessibility and best practices must be ≥ 95.
// Performance is reported (and must stay ≥ LH_MIN_PERF, default 50) because it varies with the CI machine.
// Usage: node scripts/lighthouse-check.mjs [origin]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = (process.argv[2] ?? "https://dnigrowth.com").replace(/\/$/, "");
const PAGES = ["/", "/precios", "/herramientas"];
const MIN = 95;
const MIN_PERF = Number(process.env.LH_MIN_PERF ?? 50);
const dir = mkdtempSync(join(tmpdir(), "lh-"));
const failures = [];

for (const page of PAGES) {
  const out = join(dir, `${page.replace(/\W+/g, "_") || "home"}.json`);
  const r = spawnSync(
    "npx",
    ["-y", "lighthouse@12.8.2", origin + page, "--quiet", "--chrome-flags=--headless=new --no-sandbox", "--only-categories=performance,seo,accessibility,best-practices", "--output=json", `--output-path=${out}`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (r.status !== 0) {
    failures.push(`${page}: Lighthouse no terminó`);
    continue;
  }
  const cats = JSON.parse(readFileSync(out, "utf8")).categories;
  const s = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, Math.round(v.score * 100)]));
  console.log(page, JSON.stringify(s));
  for (const k of ["seo", "accessibility", "best-practices"]) if (s[k] < MIN) failures.push(`${page}: ${k} ${s[k]} < ${MIN}`);
  if (s.performance < MIN_PERF) failures.push(`${page}: performance ${s.performance} < ${MIN_PERF}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Lighthouse correcto.");
