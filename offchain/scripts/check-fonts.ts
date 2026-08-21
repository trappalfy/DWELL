/**
 * Reports what is actually inside the self-hosted font files.
 *
 * Two things are worth reading out of a font before shipping it.
 *
 * The licence, because the sites that offer these faces also offer other
 * people's commercial typefaces, so their licence claims are not evidence.
 * A font's own `name` table carries the copyright, the licence text and the
 * licence URL that the designer put there, which is the thing to trust.
 *
 * And the grid. A pixel face is drawn at one size and is crisp only at whole
 * multiples of it; every font size on the page has to be a multiple of the
 * number printed below. That number is a property of the file, not a taste
 * decision, so it is derived here rather than written down and trusted.
 *
 * Run: node scripts/check-fonts.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "fonts");

/** The name records worth reporting, by their id in the OpenType spec. */
const NAMES: Record<number, string> = {
  0: "Copyright",
  1: "Family",
  2: "Style",
  5: "Version",
  9: "Designer",
  13: "Licence",
  14: "Licence URL"
};

function readTables(file: Buffer): Map<string, number> {
  const tag = file.readUInt32BE(0);
  // 0x00010000 is TrueType outlines; 'OTTO' is the same container with CFF.
  if (tag !== 0x00010000 && tag !== 0x4f54544f) {
    throw new Error(`not a TrueType or OpenType file (starts with 0x${tag.toString(16)})`);
  }

  const tables = new Map<string, number>();
  for (let i = 0, n = file.readUInt16BE(4); i < n; i++) {
    const record = 12 + i * 16;
    tables.set(file.toString("ascii", record, record + 4), file.readUInt32BE(record + 8));
  }
  return tables;
}

function readNameTable(file: Buffer, tables: Map<string, number>): Map<number, string> {
  const found = new Map<number, string>();
  const nameOffset = tables.get("name");
  if (nameOffset === undefined) throw new Error("no name table");

  const count = file.readUInt16BE(nameOffset + 2);
  const storage = nameOffset + file.readUInt16BE(nameOffset + 4);

  for (let i = 0; i < count; i++) {
    const record = nameOffset + 6 + i * 12;
    const platform = file.readUInt16BE(record);
    const nameId = file.readUInt16BE(record + 6);
    const length = file.readUInt16BE(record + 8);
    const offset = storage + file.readUInt16BE(record + 10);

    if (!(nameId in NAMES) || found.has(nameId)) continue;

    // Platforms 0 (Unicode) and 3 (Windows) both store UTF-16BE; only
    // platform 1 (Mac) is byte-oriented. Reading a platform-0 record as
    // bytes yields the string with a null between every letter, which then
    // matches no licence keyword and reports a free font as unlicensed.
    // swap16 rewrites its buffer in place, so it gets a copy, never a view
    // into the file that a later read would find mangled.
    const slice = file.subarray(offset, offset + length);
    const text =
      platform === 1 ? slice.toString("latin1") : Buffer.from(slice).swap16().toString("utf16le");

    found.set(nameId, text.trim());
  }

  return found;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

interface Metrics {
  readonly unitsPerEm: number;
  readonly capHeight: number | null;
  readonly xHeight: number | null;
  readonly advance: number;
  readonly monospaced: boolean;
  readonly glyphs: number;
  /** Size of one drawn pixel in font units, or null if the face is not on a grid. */
  readonly designPixel: number | null;
}

function readMetrics(file: Buffer, tables: Map<string, number>): Metrics {
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const maxp = tables.get("maxp");
  if (head === undefined || hhea === undefined || hmtx === undefined || maxp === undefined) {
    throw new Error("missing one of head/hhea/hmtx/maxp");
  }

  const unitsPerEm = file.readUInt16BE(head + 18);
  const glyphs = file.readUInt16BE(maxp + 4);
  const numH = file.readUInt16BE(hhea + 34);

  const seen = new Map<number, number>();
  for (let i = 0; i < numH; i++) {
    const width = file.readUInt16BE(hmtx + i * 4);
    if (width > 0) seen.set(width, (seen.get(width) ?? 0) + 1);
  }
  const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  const advance = ranked[0]?.[0] ?? 0;

  let capHeight: number | null = null;
  let xHeight: number | null = null;
  const os2 = tables.get("OS/2");
  if (os2 !== undefined && file.readUInt16BE(os2) >= 2) {
    xHeight = file.readInt16BE(os2 + 86);
    capHeight = file.readInt16BE(os2 + 88);
  }

  // A face drawn on a grid has every metric on it. Their common divisor is
  // the pixel — unless it comes out at 1 or 2, which just means the metrics
  // happen to share a factor and the face was never on a grid at all.
  let pixel = unitsPerEm;
  for (const value of [advance, capHeight ?? 0, xHeight ?? 0]) {
    if (value > 0) pixel = gcd(pixel, value);
  }
  const steps = pixel > 0 ? unitsPerEm / pixel : 0;
  const onGrid = pixel > 2 && Number.isInteger(steps) && steps <= 64;

  return {
    unitsPerEm,
    capHeight,
    xHeight,
    advance,
    monospaced: seen.size === 1,
    glyphs,
    designPixel: onGrid ? pixel : null
  };
}

let files: string[];
try {
  files = readdirSync(dir).filter((f) => [".ttf", ".otf", ".woff2"].includes(extname(f).toLowerCase()));
} catch {
  console.error(`No font directory at ${dir}`);
  process.exit(1);
}

if (files.length === 0) {
  console.log(
    `No font files in web/fonts yet.\n` +
      `The page falls back to the system monospace until one is there.`
  );
  process.exit(0);
}

let problems = 0;

for (const name of files) {
  const path = join(dir, name);
  const size = statSync(path).size;
  console.log(`\n${name}  —  ${(size / 1024).toFixed(1)} KB`);

  try {
    const file = readFileSync(path);
    const tables = readTables(file);

    const table = readNameTable(file, tables);
    for (const [id, label] of Object.entries(NAMES)) {
      const value = table.get(Number(id));
      if (!value) continue;
      // Licence text runs long; the rest fits on one line.
      const shown = value.length > 300 ? value.slice(0, 300) + "…" : value;
      console.log(`  ${label.padEnd(12)} ${shown.replace(/\s+/g, " ")}`);
    }

    const m = readMetrics(file, tables);
    console.log(`  ${"Glyphs".padEnd(12)} ${m.glyphs}${m.monospaced ? ", monospaced" : ", proportional"}`);
    console.log(
      `  ${"Metrics".padEnd(12)} em ${m.unitsPerEm}` +
        (m.capHeight ? `, cap ${m.capHeight} (${(m.capHeight / m.unitsPerEm).toFixed(4)} em)` : "") +
        (m.advance ? `, advance ${m.advance} (${(m.advance / m.unitsPerEm).toFixed(4)} em)` : "")
    );

    if (m.designPixel !== null) {
      const steps = m.unitsPerEm / m.designPixel;
      const scale = [2, 3, 4, 5, 6, 9, 12].map((n) => n * steps).join(" / ");
      console.log(`  ${"Grid".padEnd(12)} one drawn pixel is ${m.designPixel} units = 1/${steps} em`);
      console.log(`  ${"".padEnd(12)} => crisp only at font sizes that are multiples of ${steps}px`);
      console.log(`  ${"".padEnd(12)} => the scale on the page: ${scale}`);
      if (m.advance > 0) {
        const gap = (m.advance - m.unitsPerEm) / m.unitsPerEm;
        if (gap > 0) {
          console.log(
            `  ${"".padEnd(12)} => each cell trails ${gap.toFixed(6)}em of gap; centred lines` +
              ` need half of it cancelled`
          );
        }
      }
    } else {
      console.log(`  ${"Grid".padEnd(12)} not a pixel face — no size restriction`);
    }

    const licence = `${table.get(13) ?? ""} ${table.get(14) ?? ""} ${table.get(0) ?? ""}`.toLowerCase();
    if (!licence.includes("open font") && !licence.includes("ofl") && !licence.includes("gpl") && !licence.includes("public domain")) {
      console.log(`  ⚠  no recognisable free licence named in the file itself`);
      problems++;
    }
  } catch (error) {
    console.log(`  ⚠  ${error instanceof Error ? error.message : String(error)}`);
    problems++;
  }
}

console.log(
  problems === 0
    ? `\nEvery file names a free licence. Keep the licence text next to them.`
    : `\n${problems} file(s) need a look before shipping.`
);
