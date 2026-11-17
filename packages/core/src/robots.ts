/**
 * Minimal, standards-oriented robots.txt parser (RFC 9309):
 * - groups by user-agent, most specific matching group wins, falls back to "*"
 * - longest-match wins between Allow/Disallow; ties resolved in favour of Allow
 * - supports "*" wildcards and "$" end anchors
 */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}
export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // empty disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a !== "*" && ua.includes(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  if (best) return best;
  return robots.groups.find((g) => g.agents.includes("*")) ?? null;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function isAllowed(robots: RobotsTxt, userAgent: string, pathWithQuery: string): boolean {
  const group = selectGroup(robots, userAgent);
  if (!group) return true;
  let verdict: RobotsRule | null = null;
  let verdictLen = -1;
  for (const r of group.rules) {
    if (!r.pattern) continue;
    if (patternToRegex(r.pattern).test(pathWithQuery)) {
      const len = r.pattern.length;
      if (len > verdictLen || (len === verdictLen && r.allow)) {
        verdict = r;
        verdictLen = len;
      }
    }
  }
  return verdict ? verdict.allow : true;
}

export function crawlDelayFor(robots: RobotsTxt, userAgent: string): number | undefined {
  return selectGroup(robots, userAgent)?.crawlDelay;
}
