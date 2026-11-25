#!/usr/bin/env node
/**
 * Runs the «DNI Growth Connector» plugin in a real WordPress (WordPress Playground, PHP compiled to
 * WebAssembly; no PHP or MySQL needed) and executes scripts/wp-plugin-test/test.php: REST routes,
 * idempotent fixes, undo, <head> output (escaped JSON-LD), llms.txt, Yoast mirror, roles and uninstall.
 *
 *   pnpm wp:plugin-test            # PHP 8.3
 *   WP_PHP=7.4 pnpm wp:plugin-test # oldest PHP the plugin declares
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { WP_PLUGIN_FILES } = await import(pathToFileURL(resolve(here, "../apps/api/src/lib/wp-plugin-source.ts")).href);

const work = mkdtempSync(join(tmpdir(), "dni-wp-"));
const plugins = join(work, "plugins");
const out = join(work, "out");
mkdirSync(out);
for (const [name, body] of Object.entries(WP_PLUGIN_FILES)) {
  const f = join(plugins, name);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
}

const testDir = join(here, "wp-plugin-test");
const args = [
  "-y",
  "@wp-playground/cli@3.1.62",
  "run-blueprint",
  "--php",
  process.env.WP_PHP ?? "8.3",
  `--blueprint=${join(testDir, "blueprint.json")}`,
  "--mount-dir",
  join(plugins, "dni-growth-connector"),
  "/wordpress/wp-content/plugins/dni-growth-connector",
  "--mount-dir",
  testDir,
  "/wordpress/wptest",
  "--mount-dir",
  out,
  "/wordpress/wpout",
];
// On Windows npx is a .cmd (needs a shell), so paths with spaces must be quoted.
const win = process.platform === "win32";
const r = spawnSync(win ? "npx.cmd" : "npx", win ? args.map((x) => (x.includes(" ") ? `"${x}"` : x)) : args, { stdio: ["ignore", "ignore", "inherit"], shell: win });
let result = "";
try {
  result = readFileSync(join(out, "result.txt"), "utf8");
} catch {
  console.error(`No result from WordPress Playground (exit ${r.status}).`);
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log(result.trim());
process.exit(result.includes("ALL PASSED") ? 0 : 1);
