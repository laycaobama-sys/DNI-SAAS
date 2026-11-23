/**
 * SSRF-safe URL validation and fetching.
 *
 * Defence layers:
 *  1. Syntactic: only http/https, no userinfo, only ports 80/443, max length, no IP-literal tricks.
 *  2. Hostname policy: block localhost, *.local, *.internal, metadata hostnames, single-label hosts.
 *  3. DNS: resolve A/AAAA (DoH) and reject if ANY address is private/loopback/link-local/reserved.
 *  4. Redirects: followed manually, every hop re-validated (scheme, host, DNS), max hop count.
 *  5. Resource limits: timeout per request, max body bytes (streamed), content-type allow-list.
 *
 * Residual risk (documented in docs/SECURITY.md): DNS rebinding between our DoH check and the
 * runtime's own resolution. On Cloudflare Workers, outbound fetch originates from Cloudflare's edge,
 * which cannot reach the customer's private networks, and IP-literal/blocked hosts never reach fetch.
 */

export type BlockReason =
  | "invalid_url"
  | "scheme_not_allowed"
  | "userinfo_not_allowed"
  | "port_not_allowed"
  | "hostname_blocked"
  | "ip_literal_blocked"
  | "private_address"
  | "dns_resolution_failed"
  | "too_many_redirects"
  | "url_too_long";

export class UrlBlockedError extends Error {
  constructor(
    public readonly reason: BlockReason,
    public readonly detail: string,
  ) {
    super(`URL blocked: ${reason} (${detail})`);
    this.name = "UrlBlockedError";
  }
}

const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".private",
  ".arpa",
  ".onion",
  ".test",
  ".invalid",
  ".example",
];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

/** Parses an IPv4 dotted quad strictly (no octal/hex/short forms — those are rejected earlier). */
function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

export function isPrivateIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return true; // unparseable => treat as unsafe
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expands an IPv6 address into 8 hextets; returns null when invalid. */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // embedded IPv4 tail
  const v4match = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4match) {
    const v4 = parseIPv4(v4match[1]!);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    addr = addr.slice(0, -v4match[1]!.length) + `${hi}:${lo}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out.length === 8 ? out : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const h = expandIPv6(ip);
  if (!h) return true;
  const allZeroPrefix = h.slice(0, 5).every((x) => x === 0);
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroPrefix && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
    return isPrivateIPv4(v4);
  }
  // NAT64 64:ff9b::/96 -> check embedded v4
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    const v4 = `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
    return isPrivateIPv4(v4);
  }
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // link-local
  if ((first & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (first === 0x2002) {
    // 6to4 embeds IPv4
    const v4 = `${h[1]! >> 8}.${h[1]! & 255}.${h[2]! >> 8}.${h[2]! & 255}`;
    return isPrivateIPv4(v4);
  }
  if (first === 0x2001 && h[1] === 0) return true; // Teredo — tunnels arbitrary v4
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/** True when the hostname is (or could be interpreted by some resolver as) an IP literal. */
function looksLikeIpLiteral(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return true;
  if (/^\d+$/.test(host)) return true; // decimal integer form 2130706433
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  // Any label made only of digits/hex-prefixed parts with dots (127.1, 0177.0.0.1, 0x7f.1)
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}\.?$/i.test(host)) return true;
  return false;
}

/** Synchronous policy checks. Returns the normalised URL or throws UrlBlockedError. */
export function validatePublicUrl(raw: string): URL {
  const input = raw.trim();
  if (input.length > MAX_URL_LENGTH) throw new UrlBlockedError("url_too_long", String(input.length));
  // Reject control chars / whitespace / backslashes that parsers normalise differently.
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  if (/[\u0000-\u001f\u007f\s\\]/.test(input)) throw new UrlBlockedError("invalid_url", "control_or_whitespace");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new UrlBlockedError("invalid_url", "unparseable");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlBlockedError("scheme_not_allowed", url.protocol);
  }
  if (url.username || url.password) throw new UrlBlockedError("userinfo_not_allowed", "userinfo");
  if (!ALLOWED_PORTS.has(url.port)) throw new UrlBlockedError("port_not_allowed", url.port);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UrlBlockedError("invalid_url", "empty_host");
  // WHATWG URL already canonicalises 0x7f.1 / 2130706433 to dotted quads; check both forms.
  if (looksLikeIpLiteral(host)) throw new UrlBlockedError("ip_literal_blocked", host);
  if (BLOCKED_HOSTS.has(host)) throw new UrlBlockedError("hostname_blocked", host);
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw new UrlBlockedError("hostname_blocked", host);
  if (!host.includes(".")) throw new UrlBlockedError("hostname_blocked", "single_label");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new UrlBlockedError("hostname_blocked", "non_ascii_or_invalid");
  url.hash = "";
  return url;
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** DNS-over-HTTPS resolver (Cloudflare 1.1.1.1). Returns A + AAAA answers. */
export function createDohResolver(fetchImpl: typeof fetch = fetch, endpoint = "https://cloudflare-dns.com/dns-query"): Resolver {
  return async (hostname: string) => {
    const ask = async (type: "A" | "AAAA") => {
      const res = await fetchImpl(`${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) throw new Error(`doh_${res.status}`);
      const body = (await res.json()) as { Status: number; Answer?: Array<{ type: number; data: string }> };
      const wanted = type === "A" ? 1 : 28;
      return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
    };
    const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA").catch(() => [] as string[])]);
    return [...a, ...aaaa];
  };
}

export async function assertResolvesPublic(url: URL, resolve: Resolver): Promise<string[]> {
  let addrs: string[];
  try {
    addrs = await resolve(url.hostname);
  } catch (e) {
    throw new UrlBlockedError("dns_resolution_failed", e instanceof Error ? e.message : "unknown");
  }
  if (addrs.length === 0) throw new UrlBlockedError("dns_resolution_failed", "no_records");
  const bad = addrs.find((a) => isPrivateAddress(a));
  if (bad) throw new UrlBlockedError("private_address", bad);
  return addrs;
}

export interface SafeFetchOptions {
  resolve: Resolver;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  accept?: string;
  method?: "GET" | "HEAD";
  /** For non-text responses (images): keep up to this many leading bytes in `bytes` (e.g. to read dimensions). */
  binaryPrefixBytes?: number;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  /** Leading bytes of a non-text body, only when `binaryPrefixBytes` was requested. */
  bytes?: Uint8Array;
  truncated: boolean;
  redirects: string[];
  durationMs: number;
}

export const CRAWLER_USER_AGENT = "DNIGrowthBot/0.1 (+https://dni-growth.example/bot)";

async function readBytes(res: Response, maxBytes: number): Promise<{ buf: Uint8Array; truncated: boolean }> {
  if (!res.body) return { buf: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { buf, truncated };
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const r = await readBytes(res, maxBytes);
  return { text: new TextDecoder("utf-8").decode(r.buf), truncated: r.truncated };
}

/** Fetches a public URL with manual, re-validated redirects and hard resource limits. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const started = Date.now();
  const redirects: string[] = [];
  let current = validatePublicUrl(rawUrl);

  for (let hop = 0; ; hop++) {
    await assertResolvesPublic(current, opts.resolve);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current.toString(), {
        method: opts.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": opts.userAgent ?? CRAWLER_USER_AGENT,
          accept: opts.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= maxRedirects) throw new UrlBlockedError("too_many_redirects", String(hop));
      const next = new URL(res.headers.get("location")!, current);
      redirects.push(next.toString());
      current = validatePublicUrl(next.toString());
      await res.body?.cancel();
      continue;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    let body = "";
    let bytes: Uint8Array | undefined;
    let truncated = false;
    const textual = /text\/|xml|json|xhtml/.test(contentType) || contentType === "";
    if (opts.method !== "HEAD" && textual) {
      const r = await readLimited(res, maxBytes);
      body = r.text;
      truncated = r.truncated;
    } else if (opts.method !== "HEAD" && opts.binaryPrefixBytes) {
      const r = await readBytes(res, Math.min(opts.binaryPrefixBytes, maxBytes));
      bytes = r.buf;
      truncated = r.truncated;
    } else {
      await res.body?.cancel();
    }
    return {
      requestedUrl: rawUrl,
      finalUrl: current.toString(),
      status: res.status,
      headers,
      contentType,
      body,
      ...(bytes ? { bytes } : {}),
      truncated,
      redirects,
      durationMs: Date.now() - started,
    };
  }
}
