#!/usr/bin/env node
/**
 * Creates a ONE-TIME code to bind a verified DNI Growth account to the platform owner role.
 *
 * Run it YOURSELF, from your own terminal, logged in to Cloudflare with your own account:
 *
 *   node scripts/platform-claim.mjs
 *
 * What it does:
 *  1. Generates a random code on your computer (never sent anywhere, never stored in Git).
 *  2. Stores ONLY its SHA-256 hash in D1 with `wrangler d1 execute --remote`, valid for 30 minutes.
 *     Your Cloudflare login is the external identity check: nobody without access to the account can
 *     create a code.
 *  3. Prints the code in THIS terminal. Then open https://dnigrowth.com/app/admin?tab=security signed in with the
 *     account that must become owner, paste the code and scan the QR with your authenticator app.
 *
 * Never paste the code in a chat, ticket or e-mail. If it leaks, run the script again: unused codes
 * expire after 30 minutes and a code works only once.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const raw = Array.from(randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
const code = raw.match(/.{1,5}/g).join("-");
const hash = createHash("sha256").update(code).digest("hex");
const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

const dir = mkdtempSync(join(tmpdir(), "dni-claim-"));
const file = join(dir, "claim.sql");
writeFileSync(file, `INSERT INTO platform_claim_codes (code_hash, role, expires_at) VALUES ('${hash}', 'platform_owner', '${expires}');\n`);
try {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, ["wrangler", "d1", "execute", "dni-growth-db", "--remote", `--file=${file}`], {
    cwd: new URL("../apps/api/", import.meta.url),
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nCódigo de vinculación de propietario (válido 30 minutos, un solo uso):\n");
console.log(`    ${code}\n`);
console.log("Ábrelo en https://dnigrowth.com/app/admin?tab=security (Control Center → Seguridad) con la cuenta que será propietaria.");
console.log("No lo compartas con nadie ni lo pegues en ningún chat.\n");
