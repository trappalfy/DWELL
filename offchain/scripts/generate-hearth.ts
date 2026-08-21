/**
 * Draws the hearth scene into web/index.html between the hearth markers.
 *
 * The art is generated from width profiles rather than hand-placed rects:
 * a flame is a stack of horizontal runs, so describing it as widths-per-row
 * is both readable and reviewable, while hand-writing eighty <rect> elements
 * is neither. Output is plain static SVG — the page needs no script to draw
 * the fire.
 *
 * Run: node scripts/generate-hearth.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** One art pixel in SVG units. Chunky on purpose. */
const PX = 2;
const W = 160;
const H = 120;

/** Flame width in pixels, bottom row first. A teardrop with a bright core. */
const OUTER = [10, 10, 9, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1];
const INNER = [4, 5, 5, 4, 4, 3, 3, 2, 2, 1, 0, 0, 0];

/** Horizontal lean per frame, applied to rows above the base. */
const LEAN = [0, -1, 1];

const FLOOR_Y = 96;
const FIRE_BASE_Y = 88;
const CENTER_X = 80;

const rect = (x: number, y: number, w: number, h: number, cls: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}"/>`;

/** One flame frame: rows of horizontal runs, widest at the bottom. */
function flame(lean: number): string {
  const parts: string[] = [];
  for (let row = 0; row < OUTER.length; row++) {
    const y = FIRE_BASE_Y - (row + 1) * PX;
    // Lean grows with height so the base stays planted on the logs.
    const shift = row < 4 ? 0 : Math.round((lean * (row - 3)) / 3) * PX;

    const outerW = OUTER[row]! * PX;
    parts.push(rect(CENTER_X - outerW / 2 + shift, y, outerW, PX, "fl-outer"));

    const innerW = INNER[row]! * PX;
    if (innerW > 0) parts.push(rect(CENTER_X - innerW / 2 + shift, y, innerW, PX, "fl-inner"));
  }
  return parts.join("");
}

const scene = `
<svg class="hearth" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="A hearth in a dark room" shape-rendering="crispEdges"
     xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="firelight" cx="50%" cy="${(FIRE_BASE_Y / H) * 100}%" r="55%">
      <stop offset="0%" class="glow-hot"/>
      <stop offset="100%" class="glow-out"/>
    </radialGradient>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" class="wall"/>
  <rect x="0" y="${FLOOR_Y}" width="${W}" height="${H - FLOOR_Y}" class="floor"/>
  <rect x="0" y="${FLOOR_Y}" width="${W}" height="1" class="edge"/>

  <rect x="36" y="48" width="88" height="6" class="stone"/>
  <rect x="44" y="54" width="72" height="42" class="stone-dark"/>
  <rect x="52" y="60" width="56" height="36" class="opening"/>

  <rect x="62" y="86" width="36" height="4" class="log"/>
  <rect x="68" y="90" width="24" height="4" class="log"/>

  <g class="fire">
${LEAN.map((lean, i) => `    <g class="frame f${i + 1}">${flame(lean)}</g>`).join("\n")}
  </g>

  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#firelight)" class="light"
        shape-rendering="auto"/>
</svg>`.trim();

// Resolved from this file, not the working directory, so the script runs
// correctly from anywhere.
const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "index.html");
const html = readFileSync(page, "utf8");
const begin = "<!-- hearth:begin -->";
const end = "<!-- hearth:end -->";
const from = html.indexOf(begin);
const to = html.indexOf(end);
if (from < 0 || to < 0) throw new Error("hearth markers not found in web/index.html");

writeFileSync(
  page,
  html.slice(0, from + begin.length) + "\n" + scene + "\n        " + html.slice(to)
);
console.log(`hearth drawn: ${LEAN.length} frames, ${OUTER.length} rows each`);
