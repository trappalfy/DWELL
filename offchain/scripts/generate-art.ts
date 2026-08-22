/**
 * Draws every pixel sprite the page uses — backdrops, motif slides, fuel
 * icons, the favicon — and writes each to web/art/*.svg.
 *
 * The hero house scenes (exterior/interior) used to live here too, generated
 * the same way. They are now hand-authored raster art in web/art/*.webp
 * instead: see web/art/hearth-outside.webp and hearth-inside.webp. Everything
 * that still is procedural stays that way because nothing here needs a
 * photographic look — this script draws it once, it never changes again.
 *
 * Run: node scripts/generate-art.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PALETTE, PX, Patterns, box, scene } from "./art/pixel.ts";
import { BANDS, BAND_W, BAND_H, band } from "./art/clouds.ts";
import { SLIDES, SLIDE_W, SLIDE_H, FUEL, fuel, slideGround } from "./art/motifs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const artDir = join(root, "art");

/**
 * Palette for standalone files. They are read through <img>, where the page's
 * custom properties do not reach, so the few class-driven inks they use have
 * to be spelled out inside the file itself.
 */
const STANDALONE_STYLE = Object.entries(PALETTE)
  .map(([name, hex]) => `.ink-${name}{fill:${hex}}`)
  .join("");

function write(name: string, markup: string): number {
  writeFileSync(join(artDir, `${name}.svg`), markup + "\n");
  return (markup.match(/<rect/g) ?? []).length;
}

mkdirSync(artDir, { recursive: true });

const counts: Record<string, number> = {};

/* ---- backdrops and sprites ---- */

for (const spec of BANDS) {
  const patterns = new Patterns();
  const body = band(spec, patterns);
  counts[spec.name] = write(
    spec.name,
    scene({
      width: BAND_W,
      height: BAND_H,
      label: "",
      patterns,
      body: `  ${body}`,
      inlineStyle: STANDALONE_STYLE
    })
  );
}

for (const slide of SLIDES) {
  const patterns = new Patterns();
  const body = slideGround(patterns) + slide.draw(patterns);
  counts[`mech-${slide.name}`] = write(
    `mech-${slide.name}`,
    scene({
      width: SLIDE_W,
      height: SLIDE_H,
      label: "",
      patterns,
      body: `  ${body}`,
      inlineStyle: STANDALONE_STYLE
    })
  );
}

// A flame alone, for the browser tab: at 16 pixels the room would be mud.
{
  const patterns = new Patterns();
  const outer = [8, 8, 7, 6, 5, 4, 3, 2, 1];
  const inner = [4, 4, 3, 3, 2, 1, 0, 0, 0];
  const body = outer
    .map((width, row) => {
      const core = inner[row]!;
      return (
        box(8 - Math.round(width / 2), 15 - row, width, 1, "ember") +
        (core > 0 ? box(8 - Math.round(core / 2), 15 - row, core, 1, "flame") : "")
      );
    })
    .join("");
  counts.favicon = write("favicon", scene({ width: 16, height: 16, label: "", patterns, body: `  ${body}` }));
}

for (const spec of FUEL) {
  const patterns = new Patterns();
  counts[spec.name] = write(
    spec.name,
    scene({
      width: spec.size,
      height: spec.size,
      label: "",
      patterns,
      body: `  ${fuel(spec, patterns)}`,
      inlineStyle: STANDALONE_STYLE
    })
  );
}

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
console.log(`art drawn at ${PX}px — ${total} rects across ${Object.keys(counts).length} scenes`);
for (const [name, count] of Object.entries(counts)) console.log(`  ${name.padEnd(14)} ${count}`);
