/**
 * The room: a hearth seen from inside the dwelling.
 *
 * Everything the firelight touches is drawn twice — once unlit into the base,
 * once warm into a `firelight` group stacked on top. The page then states the
 * protocol by fading that one group, so a cold hearth and a burning one are
 * the same drawing at two exposures rather than two drawings to keep in sync.
 */
import { PX, Patterns, box, styled, scatter } from "./pixel.ts";

/** Art-pixel dimensions. Chunky enough to read as pixels at hero size. */
export const W = 80;
export const H = 50;

const FLOOR_Y = 40;
const CENTER = 40;

/** Firebox opening, in art pixels. */
const OPENING = { x: 30, y: 20, w: 20, h: 20 };
const FIRE_BASE = 37;

/** Flame width per row, bottom first: a teardrop with a bright core. */
const OUTER = [12, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1];
const INNER = [6, 6, 5, 5, 4, 4, 3, 2, 2, 1, 0, 0, 0, 0];

/** Horizontal lean per frame. Three frames read as movement; two read as a blink. */
const LEAN = [0, -1, 1];

/**
 * One flame frame. The base stays planted on the logs; only the top leans.
 * Drawn with classes rather than fills so the page owns the fire's colour.
 */
function flame(lean: number): string {
  const shift = (row: number) => (row < 4 ? 0 : Math.round((lean * (row - 3)) / 3));
  const rows: string[] = [];

  for (const [widths, cls] of [
    [OUTER, "fl-outer"],
    [INNER, "fl-inner"]
  ] as const) {
    widths.forEach((width, row) => {
      if (width <= 0) return;
      const x = Math.round(CENTER - width / 2) + shift(row);
      rows.push(styled(x, FIRE_BASE - row - 1, width, 1, cls));
    });
  }
  return rows.join("");
}

export function interior(patterns: Patterns): { body: string; defs: string } {
  const warm = (density: 25 | 50 | 75, base: Parameters<Patterns["use"]>[0]) =>
    patterns.use(base, "ember", density);
  const cool = patterns.use("soot", "night-mid", 25);

  const parts: string[] = [];

  /* ---- the shell: wall, floor, and the cold corners that give it depth ---- */

  parts.push(box(0, 0, W, FLOOR_Y, "soot"));
  parts.push(box(0, 0, 14, 12, cool), box(W - 14, 0, 14, 12, cool));

  parts.push(box(0, FLOOR_Y, W, H - FLOOR_Y, "bark"));
  // Plank seams. Three lines are enough to say "floor" without becoming texture.
  for (const y of [FLOOR_Y + 2, FLOOR_Y + 5, FLOOR_Y + 8]) parts.push(box(0, y, W, 1, "soot"));

  /* ---- masonry ---- */

  // Chimney breast, mantel shelf, surround. The shelf overhangs on both sides:
  // that overhang is the whole reason the mass above reads as a chimney.
  parts.push(box(25, 0, 30, 14, "stone"));
  parts.push(box(20, 14, 40, 2, "stone"));
  parts.push(box(20, 16, 40, 1, "soot"));
  parts.push(box(25, 17, 30, FLOOR_Y - 17, "stone"));

  // Coursing: horizontal joints in the surround, so it reads as stacked stone.
  for (const y of [21, 26, 31, 36]) parts.push(box(25, y, 30, 1, "soot"));

  parts.push(box(OPENING.x, OPENING.y, OPENING.w, OPENING.h, "night-deep"));
  // A lintel over the opening carries the mass above it.
  parts.push(box(OPENING.x - 1, OPENING.y - 1, OPENING.w + 2, 1, "bark"));

  // Hearth apron: the stone the fire sits on, spilling onto the floor.
  parts.push(box(26, FLOOR_Y, 28, 3, "stone"));

  /* ---- what furnishes the room ---- */

  // Woodpile, left. Log ends are squares with a darker core: a ring in four
  // pixels is not available, so the core does the work of saying "cut end".
  for (let row = 0; row < 3; row++) {
    const y = 40 - (row + 1) * 3;
    const count = row === 2 ? 3 : 4;
    for (let i = 0; i < count; i++) {
      const x = 3 + i * 4 + (row === 2 ? 2 : 0);
      parts.push(box(x, y, 3, 3, "bark"), box(x + 1, y + 1, 1, 1, "soot"));
    }
  }

  // Window, right: night seen from inside, with a sill and a mullion cross.
  parts.push(box(62, 7, 15, 18, "bark"));
  parts.push(box(63, 8, 13, 16, "glass"));
  parts.push(box(69, 8, 1, 16, "bark"), box(63, 15, 13, 1, "bark"));
  parts.push(box(61, 25, 17, 2, "bark"));

  // Stars behind the glass, seeded so every build places them identically.
  const random = scatter(0xd7e11);
  for (let i = 0; i < 7; i++) {
    const x = 63 + Math.floor(random() * 13);
    const y = 8 + Math.floor(random() * 16);
    // Never on a mullion, where a star would read as a smudge on the frame.
    if (x === 69 || y === 15) continue;
    parts.push(box(x, y, 1, 1, "haze"));
  }

  // A stool facing the fire. The page's closing line invites you to sit down;
  // there should be something to sit on.
  parts.push(box(63, 33, 11, 2, "bark"));
  parts.push(box(64, 35, 2, 5, "bark"), box(71, 35, 2, 5, "bark"));

  // Rug, running from the apron toward the reader.
  parts.push(box(20, 44, 40, 4, "bark"));
  parts.push(box(20, 44, 40, 1, "barklit"));

  /* ---- the logs the fire stands on ---- */

  parts.push(box(33, 37, 14, 2, "bark"), box(36, 39, 8, 1, "bark"));

  /* ---- firelight: the same surfaces again, warm ---- */

  const lit: string[] = [];

  // Inside the firebox, lit from within.
  lit.push(box(OPENING.x, OPENING.y + 12, OPENING.w, 8, warm(50, "night-deep")));
  lit.push(box(OPENING.x, OPENING.y + 6, OPENING.w, 6, warm(25, "night-deep")));

  // Stone around the mouth catches the most light; the coursing above less.
  lit.push(box(25, 34, 5, 6, warm(50, "stone")), box(50, 34, 5, 6, warm(50, "stone")));
  lit.push(box(25, 26, 5, 8, warm(25, "stone")), box(50, 26, 5, 8, warm(25, "stone")));
  lit.push(box(26, FLOOR_Y, 28, 3, warm(50, "stone")));
  lit.push(box(20, 14, 40, 2, warm(25, "stone")));

  // The pool of light on the floor, widening as it leaves the hearth.
  lit.push(box(22, 43, 36, 1, warm(50, "bark")));
  lit.push(box(20, 44, 40, 2, warm(50, "bark")));
  lit.push(box(18, 46, 44, 2, warm(25, "bark")));
  lit.push(box(24, 48, 32, 2, warm(25, "bark")));

  // The wall above the mantel, and the logs waiting their turn.
  lit.push(box(25, 0, 30, 6, warm(25, "stone")));
  for (let i = 0; i < 4; i++) lit.push(box(3 + i * 4, 31, 3, 1, warm(50, "bark")));

  lit.push(box(33, 37, 14, 1, warm(75, "bark")));

  parts.push(`  <g class="firelight">\n    ${lit.join("\n    ")}\n  </g>`);

  /* ---- the fire itself, and the light it throws into the room ---- */

  // An ember bed under the logs. It outlives the flame: a hearth nobody tends
  // still has coals, which is exactly what the cold states have to show.
  parts.push(`  <g class="embers">${styled(34, 39, 12, 1, "em-hot")}${styled(36, 38, 8, 1, "em-hot")}</g>`);

  parts.push(
    `  <g class="fire">\n` +
      LEAN.map((lean, i) => `    <g class="frame f${i + 1}">${flame(lean)}</g>`).join("\n") +
      `\n  </g>`
  );

  parts.push(
    `  <rect x="0" y="0" width="${W * PX}" height="${H * PX}" fill="url(#firelight-glow)" ` +
      `class="glow" shape-rendering="auto"/>`
  );

  const defs =
    `<radialGradient id="firelight-glow" cx="${(CENTER / W) * 100}%" cy="${(FIRE_BASE / H) * 100}%" r="60%">` +
    `<stop offset="0%" class="glow-hot"/><stop offset="100%" class="glow-out"/></radialGradient>`;

  return { body: parts.map((part) => (part.startsWith("  <g") ? part : `  ${part}`)).join("\n"), defs };
}

/** Exposed so a test can assert the fire stays inside the firebox. */
export const GEOMETRY = { OPENING, FIRE_BASE, OUTER, INNER, LEAN, CENTER, FLOOR_Y };
