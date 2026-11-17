#!/usr/bin/env node
// Lightweight secret scanner for tracked/untracked source files and the built assets.
// Fails (exit 1) if anything that looks like a live credential is found. Never prints the secret itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "coverage", ".claude"]);
const SKIP_FILES = [/\.dev\.vars$/, /pnpm-lock\.yaml$/, /\.(png|jpe?g|webp|gif|ico|woff2?|zip|pdf)$/i];
const PATTERNS = [
  ["Stripe live secret", /\b(sk|rk)_live_[0-9a-zA-Z]{16,}/],
  ["Stripe webhook secret", /\bwhsec_[0-9a-zA-Z]{20,}/],
  ["Resend API key", /\bre_[0-9a-zA-Z]{8,}_[0-9a-zA-Z]{16,}/],
  ["Cloudflare API token", /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["OpenAI/Anthropic key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

const findings = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 2_000_000 && !SKIP_FILES.some((r) => r.test(p))) {
      const text = readFileSync(p, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const [label, re] of PATTERNS) if (re.test(line)) findings.push(`${relative(ROOT, p)}:${i + 1} — ${label}`);
      });
    }
  }
}
walk(ROOT);
if (findings.length) {
  console.error(`✖ Posibles secretos encontrados (${findings.length}):\n  ${findings.join("\n  ")}`);
  process.exit(1);
}
console.log("✔ Secret scan: sin credenciales detectadas.");
