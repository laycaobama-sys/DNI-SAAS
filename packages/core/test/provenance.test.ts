import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { hasAiProvenance, imageInfo, withAiProvenance } from "../src";

function crc32(b: Uint8Array) {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(new Uint8Array(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}
/** A real 2×2 PNG. */
function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}
function chunks(b: Uint8Array) {
  const out: Array<{ type: string; ok: boolean }> = [];
  let o = 8;
  while (o < b.length) {
    const len = Buffer.from(b).readUInt32BE(o);
    const type = Buffer.from(b.subarray(o + 4, o + 8)).toString("latin1");
    const crc = Buffer.from(b).readUInt32BE(o + 8 + len);
    out.push({ type, ok: crc === crc32(b.subarray(o + 4, o + 8 + len)) });
    o += 12 + len;
  }
  return out;
}

describe("AI provenance mark (IPTC digital source type)", () => {
  it("adds a valid iTXt XMP chunk to a PNG without breaking it", () => {
    const src = png();
    expect(hasAiProvenance(src)).toBe(false);
    const out = withAiProvenance(src, "image/png", "DNI Growth · FLUX.1 schnell");
    expect(hasAiProvenance(out)).toBe(true);
    expect(chunks(out)).toEqual([
      { type: "IHDR", ok: true },
      { type: "iTXt", ok: true },
      { type: "IDAT", ok: true },
      { type: "IEND", ok: true },
    ]);
    expect(imageInfo(out)).toMatchObject({ format: "png", width: 2, height: 2 });
  });

  it("adds an APP1 XMP segment after JFIF APP0 in a JPEG", () => {
    const jfif = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const src = new Uint8Array([0xff, 0xd8, ...jfif, 0xff, 0xd9]);
    const out = withAiProvenance(src, "image/jpeg", "DNI Growth");
    expect(hasAiProvenance(out)).toBe(true);
    expect([...out.slice(0, 2 + jfif.length)]).toEqual([0xff, 0xd8, ...jfif]);
    expect([out[20], out[21]]).toEqual([0xff, 0xe1]);
    const len = (out[22]! << 8) | out[23]!;
    expect([out[20 + 2 + len], out[20 + 3 + len]]).toEqual([0xff, 0xd9]);
  });

  it("escapes the tool name and leaves other formats alone", () => {
    expect(new TextDecoder().decode(withAiProvenance(png(), "image/png", 'a"<b>'))).toContain("a&quot;&lt;b&gt;");
    const webp = new Uint8Array([1, 2, 3]);
    expect(withAiProvenance(webp, "image/webp", "x")).toBe(webp);
  });
});
