import { describe, expect, it } from "vitest";
import { decliningPages } from "../src/declining";

const row = (key: string, clicks: number, impressions: number, position: number) => ({ key, clicks, impressions, position });

describe("decliningPages", () => {
  it("flags only real drops (enough clicks and share) and explains why", () => {
    const prev = [row("/a", 100, 2000, 3), row("/b", 100, 2000, 3), row("/c", 100, 2000, 3), row("/d", 20, 400, 5), row("/e", 100, 2000, 3)];
    const cur = [row("/a", 40, 1900, 6.5), row("/b", 50, 900, 3.2), row("/c", 60, 2000, 3.1), row("/d", 12, 380, 5), row("/e", 90, 2000, 3)];
    const r = decliningPages(cur, prev);
    expect(r.map((p) => [p.page, p.reason, p.lostClicks])).toEqual([
      ["/a", "position", 60],
      ["/b", "impressions", 50],
      ["/c", "ctr", 40],
    ]);
    expect(r[0]!.drop).toBeCloseTo(0.6);
  });

  it("only calls a page gone when the current list is complete", () => {
    const prev = [row("/x", 50, 800, 4)];
    expect(decliningPages([], prev)).toEqual([]);
    const r = decliningPages([], prev, { currentComplete: true });
    expect(r[0]).toMatchObject({ page: "/x", reason: "gone", clicksNow: 0, positionNow: null });
  });

  it("ignores growth and caps the list", () => {
    const prev = Array.from({ length: 30 }, (_, i) => row(`/p${i}`, 100 + i, 1000, 2));
    const cur = prev.map((p) => row(p.key, 10, 1000, 9));
    expect(decliningPages(cur, prev).length).toBe(10);
    expect(decliningPages([row("/g", 200, 1000, 2)], [row("/g", 100, 900, 3)])).toEqual([]);
  });
});
