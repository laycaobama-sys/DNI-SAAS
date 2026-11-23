import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { mdBlocks, Preview } from "../src/app/pages/content";

const SRC = join(import.meta.dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
const sources = files(SRC).map((p) => ({ file: relative(SRC, p), text: readFileSync(p, "utf8") }));

afterEach(() => cleanup());

describe("source guards", () => {
  it("B1: no effect returns the value of an expression (React would call it as cleanup)", () => {
    // useEffect(() => something(), …) — an implicit return. Only braced bodies are allowed.
    const offenders = sources.flatMap(({ file, text }) => [...text.matchAll(/use(Layout)?Effect\(\s*\(\)\s*=>\s*(?=[^\s{])/g)].map((m) => `${file}:${text.slice(0, m.index).split("\n").length}`));
    expect(offenders).toEqual([]);
  });

  it("B3/B4: no internal phase or backlog codes reach the interface", () => {
    const offenders = sources.flatMap(({ file, text }) =>
      text
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        // Phase codes ("fase F3", "F2", "F3–F7", "F1+") and backlog ids ("T07", "B12") inside string literals.
        .filter(({ line }) => [...line.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g)].some((m) => /\bfase\s+F\d|^F\d([–-]F\d|\+)?$|\b(T|B)\d{2}\b(?!:)/.test(m[0].slice(1, -1))))
        .map(({ n }) => `${file}:${n}`),
    );
    expect(offenders).toEqual([]);
  });

  it("B2: every module page renders inside an error boundary keyed by route", () => {
    const shell = sources.find((s) => s.file.endsWith("shell.tsx"))!.text;
    expect(shell).toMatch(/<ErrorBoundary key=\{loc\.pathname\}[^>]*>\s*<Outlet\s*\/>/);
    const main = sources.find((s) => s.file.endsWith("main.tsx"))!.text;
    expect(main).toMatch(/<ErrorBoundary[^>]*scope="app"/);
  });

  it("never injects HTML from the API or the model", () => {
    // Only exception: the TOTP QR code, an SVG generated in the browser from our own otpauth URI.
    const ALLOWED = [/platform\.tsx$/];
    const offenders = sources.filter(({ file, text }) => /dangerouslySetInnerHTML/.test(text) && !ALLOWED.some((r) => r.test(file))).map((s) => s.file);
    expect(offenders).toEqual([]);
    const qr = sources.find((s) => /platform\.tsx$/.test(s.file))!.text;
    expect(qr.match(/dangerouslySetInnerHTML=\{\{ __html: (\w+) \}\}/g)).toEqual(["dangerouslySetInnerHTML={{ __html: svg }}"]);
    expect(qr).toMatch(/createSvgTag\(/);
  });
});

describe("draft preview", () => {
  const MD = [
    "# Corrección: imagen social",
    "",
    "> BORRADOR NO APROBADO",
    "",
    "- https://estudio-norte.es/",
    "  - Propuesto: [COMPLETAR: URL de la imagen]",
    "",
    "```html",
    '<meta property="og:image" content="https://estudio-norte.es/og.png">',
    "```",
    "",
    "## Evidencia (anexo)",
    "| URL | Tipo de página | Dato observado |",
    "|---|---|---|",
    "| https://estudio-norte.es/ | Página principal | formato: svg \\| sin tamaño |",
    "",
    "<script>alert(1)</script> [enlace](javascript:alert(1))",
  ].join("\n");

  it("splits tables, code, quotes and nested lists", () => {
    const blocks = mdBlocks(MD);
    expect(blocks.map((b) => b.t)).toEqual(["h", "quote", "ul", "code", "h", "table", "p"]);
    const table = blocks.find((b) => b.t === "table") as { rows: string[][] };
    expect(table.rows).toEqual([
      ["URL", "Tipo de página", "Dato observado"],
      ["https://estudio-norte.es/", "Página principal", "formato: svg | sin tamaño"],
    ]);
  });

  it("renders everything as text: no script element, no javascript: link", () => {
    const { container } = render(<Preview md={MD} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("mark")?.textContent).toContain("[COMPLETAR");
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
