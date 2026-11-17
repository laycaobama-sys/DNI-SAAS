import { fromHex, toHex } from "./crypto";

/**
 * AES-256-GCM envelope for small payloads stored at rest (e.g. queued emails that contain
 * single-use links). Format: "v1.<iv hex>.<ciphertext hex>". The key is a 64-hex-char secret.
 */
async function importKey(keyHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error("invalid_encryption_key");
  return crypto.subtle.importKey("raw", fromHex(keyHex.toLowerCase()), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(keyHex: string, value: unknown, aad = ""): Promise<string> {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data);
  return `v1.${toHex(iv)}.${toHex(ct)}`;
}

export async function decryptJson<T>(keyHex: string, envelope: string, aad = ""): Promise<T> {
  const [v, ivHex, ctHex] = envelope.split(".");
  if (v !== "v1" || !ivHex || !ctHex) throw new Error("invalid_envelope");
  const key = await importKey(keyHex);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(ivHex), additionalData: new TextEncoder().encode(aad) }, key, fromHex(ctHex));
  return JSON.parse(new TextDecoder("utf-8").decode(pt)) as T;
}
