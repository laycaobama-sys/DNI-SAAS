// Runs the live audit of our own site (apps/api/test/live/own-site-audit.test.ts): must be 100/100.
import { spawnSync } from "node:child_process";
const r = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "api", "test/live/own-site-audit.test.ts"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, OWN_SITE_AUDIT: "1" },
});
process.exit(r.status ?? 1);
