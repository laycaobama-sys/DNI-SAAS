/**
 * AI provenance for generated images: embeds the IPTC "digital source type" in XMP metadata, the
 * machine-readable mark that platforms such as Meta and Google read to label AI images, and that the EU AI
 * Act (art. 50.2) asks for synthetic content. No signing keys involved (this is not a C2PA signature): it
 * says honestly "made by an AI model" and nothing else. Images we did not generate are never touched.
 */
export const IPTC_TRAINED_ALGORITHMIC_MEDIA = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BOM = String.fromCharCode(0xfeff);

export function aiProvenanceXmp(creatorTool: string): string {
  return (
    `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ` +
    `Iptc4xmpExt:DigitalSourceType="${IPTC_TRAINED_ALGORITHMIC_MEDIA}" xmp:CreatorTool="${xmlEscape(creatorTool)}"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="r"?>`
  );
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const enc = new TextEncoder();

function pngWithXmp(b: Uint8Array, xmp: string): Uint8Array {
  // Signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 crc) = 33 bytes; XMP goes right after IHDR.
  if (b.length < 33 || String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== "IHDR") return b;
  const data = concat(enc.encode("XML:com.adobe.xmp"), new Uint8Array([0, 0, 0, 0, 0]), enc.encode(xmp));
  const type = enc.encode("iTXt");
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat(type, data)));
  return concat(b.slice(0, 33), len, type, data, crc, b.slice(33));
}

function jpegWithXmp(b: Uint8Array, xmp: string): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const payload = concat(enc.encode("http://ns.adobe.com/xap/1.0/\0"), enc.encode(xmp));
  if (payload.length + 2 > 0xffff) return b;
  const seg = concat(new Uint8Array([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);
  // JFIF requires APP0 right after SOI: insert after it when present.
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0 && b.length > 6) at = 4 + ((b[4]! << 8) | b[5]!);
  return concat(b.slice(0, at), seg, b.slice(at));
}

/** Returns the image with the AI provenance mark (PNG or JPEG); other formats are returned unchanged. */
export function withAiProvenance(bytes: Uint8Array, contentType: string, creatorTool: string): Uint8Array {
  const xmp = aiProvenanceXmp(creatorTool);
  if (/png/i.test(contentType)) return pngWithXmp(bytes, xmp);
  if (/jpe?g/i.test(contentType)) return jpegWithXmp(bytes, xmp);
  return bytes;
}

/** True when the bytes carry our IPTC "trained algorithmic media" mark. */
export function hasAiProvenance(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.slice(0, 64_000)).includes(IPTC_TRAINED_ALGORITHMIC_MEDIA);
}
