/**
 * The dwelling from outside, at night.
 *
 * The sky is left unpainted on purpose: the page's own gradient and the
 * drifting stars behind the canvas show through, so the house sits in the
 * night the rest of the page is made of rather than in a rectangle of its own.
 *
 * Dimensions match the interior scene so the two can cross-fade in place.
 */
import { Patterns, box, styled, scatter } from "./pixel.ts";

export const W = 80;
export const H = 50;

const GROUND_Y = 46;
const APEX_X = 40;
const ROOF_TOP = 14;
const EAVE_Y = 24;
const EAVE_HALF = 23;

const CHIMNEY_X = 45;
const CHIMNEY_TOP = 10;

/**
 * Smoke width per row above the chimney, and how far each row drifts.
 * It thins, widens and leans as it rises — smoke that goes straight up in a
 * constant width reads as a pipe.
 */
const SMOKE = [2, 2, 3, 3, 4, 4, 5, 4];
const DRIFT = [0, 0, 1, 1, 2, 3, 3, 4];

export function exterior(patterns: Patterns): { body: string; defs: string } {
  const parts: string[] = [];
  const spill = patterns.use("night-soft", "flame", 25);

  /* ---- stars, first, so everything solid is painted over them ---- */

  const random = scatter(0x51a25);
  for (let i = 0; i < 34; i++) {
    const x = Math.floor(random() * W);
    const y = Math.floor(random() * (GROUND_Y - 8));
    parts.push(box(x, y, 1, 1, random() > 0.65 ? "haze" : "dusk"));
  }

  /* ---- ground ---- */

  parts.push(box(0, GROUND_Y, W, H - GROUND_Y, "night-deep"));
  // A horizon band: the ground nearest the house catches what little light
  // there is, which is what separates it from the sky above.
  parts.push(box(0, GROUND_Y, W, 1, "night-soft"));

  /* ---- roof ---- */

  // A stepped gable. The steps are the point: a rotated rectangle would read
  // as vector art, and this whole page is built on admitting the grid.
  const rows = EAVE_Y - ROOF_TOP;
  for (let row = 0; row < rows; row++) {
    const half = Math.round(((row + 1) / rows) * EAVE_HALF);
    const y = ROOF_TOP + row;
    parts.push(box(APEX_X - half, y, half, 1, "stone"));
    // The far slope stays darker, so the ridge reads as an edge, not a seam.
    parts.push(box(APEX_X, y, half, 1, "bark"));
  }

  /* ---- walls, door, window ---- */

  parts.push(box(22, EAVE_Y, 36, GROUND_Y - EAVE_Y, "bark"));
  // Board joins, vertical: they tell you the wall is timber, not masonry.
  for (const x of [28, 34, 40, 46, 52]) parts.push(box(x, EAVE_Y, 1, GROUND_Y - EAVE_Y, "soot"));

  parts.push(box(42, 34, 9, 12, "soot"));
  parts.push(box(43, 35, 7, 11, "night-deep"));
  parts.push(box(48, 40, 1, 1, "dusk"));

  // The window that matters: dark until a wallet is connected.
  parts.push(box(27, 27, 11, 11, "soot"));
  parts.push(styled(28, 28, 9, 9, "pane"));
  parts.push(box(32, 28, 1, 9, "soot"), box(28, 32, 9, 1, "soot"));

  /* ---- chimney, drawn over the roof it passes through ---- */

  parts.push(box(CHIMNEY_X, CHIMNEY_TOP, 6, EAVE_Y - CHIMNEY_TOP - 1, "stone"));
  parts.push(box(CHIMNEY_X - 1, CHIMNEY_TOP - 1, 8, 2, "stone"));
  parts.push(box(CHIMNEY_X + 1, CHIMNEY_TOP + 1, 4, 1, "night-deep"));

  /* ---- trees, so the house stands somewhere rather than nowhere ---- */

  for (const [baseX, height] of [
    [9, 16],
    [70, 13],
    [64, 9]
  ] as const) {
    // Row 0 is the bottom row, so the taper has to run the other way: a cone
    // that narrows downward is an ice cream, not a conifer.
    for (let row = 0; row < height; row++) {
      const half = Math.max(1, Math.round(((height - row) / height) * (height / 2.8)));
      parts.push(box(baseX - half, GROUND_Y - row - 1, half * 2, 1, "night-deep"));
    }
    parts.push(box(baseX - 1, GROUND_Y - 1, 2, 2, "soot"));
  }

  /* ---- the light escaping the window ---- */

  const lit: string[] = [];
  lit.push(styled(28, 28, 9, 9, "pane-hot"));
  // Light falls out of the window onto the wall and the ground below it.
  lit.push(box(25, 38, 15, 4, spill));
  lit.push(box(23, GROUND_Y, 19, 3, spill));
  lit.push(box(CHIMNEY_X - 1, CHIMNEY_TOP - 1, 8, 2, spill));

  parts.push(`  <g class="firelight">\n    ${lit.join("\n    ")}\n  </g>`);

  /* ---- smoke, the sign from outside that someone is tending it ---- */

  const smokeBase = CHIMNEY_TOP - 2;
  const smoke = SMOKE.map((width, row) =>
    box(CHIMNEY_X + 3 - Math.round(width / 2) + DRIFT[row]!, smokeBase - row, width, 1, "night-soft")
  ).join("");
  parts.push(`  <g class="smoke">${smoke}</g>`);

  return {
    body: parts.map((part) => (part.startsWith("  <g") ? part : `  ${part}`)).join("\n"),
    defs: ""
  };
}

export const GEOMETRY = {
  GROUND_Y,
  APEX_X,
  ROOF_TOP,
  EAVE_Y,
  EAVE_HALF,
  CHIMNEY_X,
  CHIMNEY_TOP,
  SMOKE,
  DRIFT
};
