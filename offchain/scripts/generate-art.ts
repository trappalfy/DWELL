/**
 * Draws every pixel scene the page uses.
 *
 * Two kinds of output, for one reason: an SVG loaded through <img> is sealed
 * off from the page's stylesheet, so anything whose colour or frame the page
 * needs to change has to be inlined instead.
 *
 *   inlined into web/index.html — the two hearth scenes, whose state the
 *                                 protocol drives
 *   written to web/art/*.svg   — backdrops and sprites that never change
 *
 * Run: node scripts/generate-art.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PALETTE, PX, Patterns, box, scene } from "./art/pixel.ts";
import { interior, W as ROOM_W, H as ROOM_H } from "./art/interior.ts";
import { exterior } from "./art/exterior.ts";
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

/*
 * The wordmark's flame, drawn tight to its own edges.
 *
 * The favicon cannot stand in for this: it is a flame sitting at the bottom
 * of a square, and seven blank rows of padding is not something a logo lockup
 * can align against. Sixteen rows tall so it scales to 48px at a whole 3x.
 */
{
  const patterns = new Patterns();
  const outer = [10, 10, 10, 9, 9, 8, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1];
  const inner = [5, 6, 6, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0, 0, 0, 0];
  const body = outer
    .map((width, row) => {
      const core = inner[row]!;
      const y = outer.length - 1 - row;
      return (
        box(6 - Math.round(width / 2), y, width, 1, "ember") +
        (core > 0 ? box(6 - Math.round(core / 2), y, core, 1, "flame") : "")
      );
    })
    .join("");
  counts.mark = write("mark", scene({ width: 12, height: 16, label: "", patterns, body: `  ${body}` }));
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

/* ---- the two scenes the page animates ---- */

const scenes: Record<string, string> = {};

for (const [name, draw, label] of [
  ["interior", interior, "A hearth burning in a dark room"],
  ["exterior", exterior, "A small house at night with one window"]
] as const) {
  const patterns = new Patterns();
  const { body, defs } = draw(patterns);
  scenes[name] = scene({
    width: ROOM_W,
    height: ROOM_H,
    label,
    patterns,
    body,
    defs,
    className: `scene scene-${name}`
  });
  counts[name] = (scenes[name].match(/<rect/g) ?? []).length;
}

const page = join(root, "index.html");
let html = readFileSync(page, "utf8");

for (const [name, markup] of Object.entries(scenes)) {
  const begin = `<!-- art:${name} -->`;
  const end = `<!-- /art:${name} -->`;
  const from = html.indexOf(begin);
  const to = html.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`markers for "${name}" not found in web/index.html`);
  html = html.slice(0, from + begin.length) + "\n" + markup + "\n        " + html.slice(to);
}

writeFileSync(page, html);

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
console.log(`art drawn at ${PX}px — ${total} rects across ${Object.keys(counts).length} scenes`);
for (const [name, count] of Object.entries(counts)) console.log(`  ${name.padEnd(14)} ${count}`);
