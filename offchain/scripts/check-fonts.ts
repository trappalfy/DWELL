/**
 * Reports what is actually inside the self-hosted font files.
 *
 * The sites that offer these fonts also offer other people's commercial
 * typefaces, so their licence claims are not evidence. A font's own `name`
 * table carries the copyright, the licence text and the licence URL that the
 * designer put there, which is the thing worth reading before shipping it.
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

function readNameTable(file: Buffer): Map<number, string> {
  const found = new Map<number, string>();

  const tag = file.readUInt32BE(0);
  // 0x00010000 is TrueType outlines; 'OTTO' is the same container with CFF.
  if (tag !== 0x00010000 && tag !== 0x4f54544f) {
    throw new Error(`not a TrueType or OpenType file (starts with 0x${tag.toString(16)})`);
  }

  const tableCount = file.readUInt16BE(4);
  let nameOffset = 0;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    if (file.toString("ascii", record, record + 4) === "name") {
      nameOffset = file.readUInt32BE(record + 8);
      break;
    }
  }
  if (nameOffset === 0) throw new Error("no name table");

  const count = file.readUInt16BE(nameOffset + 2);
  const storage = nameOffset + file.readUInt16BE(nameOffset + 4);

  for (let i = 0; i < count; i++) {
    const record = nameOffset + 6 + i * 12;
    const platform = file.readUInt16BE(record);
    const nameId = file.readUInt16BE(record + 6);
    const length = file.readUInt16BE(record + 8);
    const offset = storage + file.readUInt16BE(record + 10);

    if (!(nameId in NAMES) || found.has(nameId)) continue;

    // Platform 3 is Windows and stores UTF-16BE; platform 1 is Mac and is
    // close enough to Latin-1 for the fields read here.
    const slice = file.subarray(offset, offset + length);
    found.set(nameId, (platform === 3 ? slice.swap16().toString("utf16le") : slice.toString("latin1")).trim());
  }

  return found;
}

let files: string[];
try {
  files = readdirSync(dir).filter((f) => [".ttf", ".otf"].includes(extname(f).toLowerCase()));
} catch {
  console.error(`No font directory at ${dir}`);
  process.exit(1);
}

if (files.length === 0) {
  console.log(`No .ttf or .otf files in web/fonts yet.\nThe page falls back to Pixelify Sans and Silkscreen until they are there.`);
  process.exit(0);
}

let problems = 0;

for (const name of files) {
  const path = join(dir, name);
  const size = statSync(path).size;
  console.log(`\n${name}  —  ${(size / 1024).toFixed(1)} KB`);

  try {
    const table = readNameTable(readFileSync(path));
    for (const [id, label] of Object.entries(NAMES)) {
      const value = table.get(Number(id));
      if (!value) continue;
      // Licence text runs long; the rest fits on one line.
      const shown = value.length > 300 ? value.slice(0, 300) + "…" : value;
      console.log(`  ${label.padEnd(12)} ${shown.replace(/\s+/g, " ")}`);
    }

    const licence = `${table.get(13) ?? ""} ${table.get(14) ?? ""} ${table.get(0) ?? ""}`.toLowerCase();
    if (!licence.includes("open font") && !licence.includes("ofl") && !licence.includes("gpl")) {
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
    ? `\nBoth files name a free licence. Keep the licence file next to them.`
    : `\n${problems} file(s) need a look before shipping.`
);
