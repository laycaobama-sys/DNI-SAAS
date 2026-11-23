/**
 * Reads the format and pixel size of an image from its first bytes (no decoding, no dependencies).
 * Used to check og:image: social networks and messaging apps ignore SVG and small images.
 */
export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "svg" | "unknown";

export interface ImageInfo {
  format: ImageFormat;
  width: number | null;
  height: number | null;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));

export function imageInfo(bytes: Uint8Array, contentType = ""): ImageInfo {
  const b = bytes;
  const none = (format: ImageFormat): ImageInfo => ({ format, width: null, height: null });
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { format: "png", width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 10 && ascii(b, 0, 3) === "GIF") return { format: "gif", width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") return { format: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === "VP8 ") return { format: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return none("webp");
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments until a start-of-frame marker (SOF0..SOF15, excluding DHT/JPG/DAC).
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = u16be(b, o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: u16be(b, o + 7), height: u16be(b, o + 5) };
      }
      o += 2 + len;
    }
    return none("jpeg");
  }
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart().toLowerCase();
  if (/image\/svg/.test(contentType) || head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return none("svg");
  return none("unknown");
}

export interface OgImageCheck {
  url: string;
  status: number | null;
  contentType: string;
  contentLength: number | null;
  info: ImageInfo | null;
  error?: string;
}

export const OG_IMAGE_MIN = { width: 1200, height: 630 } as const;
export const OG_IMAGE_MAX_BYTES = 5_000_000;

/** Problems that stop an og:image from being shown by social networks and messaging apps. Empty = fine. */
export function ogImageProblems(c: OgImageCheck): string[] {
  const out: string[] = [];
  if (c.error || c.status === null) return ["No se pudo descargar la imagen."];
  if (c.status >= 400) return [`La imagen responde con HTTP ${c.status}.`];
  const format = c.info?.format ?? "unknown";
  if (format === "svg") out.push("Es un SVG: redes sociales y apps de mensajería no lo muestran. Usa PNG, JPG o WebP.");
  else if (format === "unknown") out.push(`No es una imagen PNG, JPG o WebP reconocible (tipo «${c.contentType || "desconocido"}»).`);
  else if (format === "gif") out.push("Es un GIF: usa PNG, JPG o WebP para la vista previa.");
  if (c.info?.width && c.info.height && (c.info.width < OG_IMAGE_MIN.width || c.info.height < OG_IMAGE_MIN.height)) {
    out.push(`Mide ${c.info.width}×${c.info.height} px; lo recomendado es al menos ${OG_IMAGE_MIN.width}×${OG_IMAGE_MIN.height} px.`);
  }
  if (c.contentLength && c.contentLength > OG_IMAGE_MAX_BYTES) out.push(`Pesa ${(c.contentLength / 1e6).toFixed(1)} MB; algunas plataformas ignoran imágenes de más de 5 MB.`);
  return out;
}
