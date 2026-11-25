import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip, crc32 } from "../src/zip";

describe("buildZip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("produces a valid archive that a real unzip tool reads back", () => {
    const files = { "plugin/plugin.php": "<?php\n// ñandú\n", "plugin/readme.txt": "hola" };
    const zip = buildZip(files);
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    const path = join(dir, "t.zip");
    writeFileSync(path, zip);
    // Python's zipfile validates the CRC of every member and the central directory.
    const out = execFileSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", "import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist()}))", path], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(files);
    expect(Buffer.from(buildZip(files)).equals(Buffer.from(readFileSync(path)))).toBe(true); // reproducible
  });
});
