/**
 * One large motif per mechanics slide, plus the fuel drawn on the pedestal.
 *
 * The reference fills this section with detailed illustrated environments.
 * A single big silhouette is the version that survives being generated: it
 * reads at any size, it never turns to mush behind the overlay, and it says
 * the one thing its slide is about instead of nine things at once.
 */
import { Patterns, box, scatter, type Ink } from "./pixel.ts";

export const SLIDE_W = 120;
export const SLIDE_H = 50;

/** Ground line and where the motif stands: right of centre, clear of the copy. */
const GROUND = 44;
const MOTIF_X = 86;

type Draw = (patterns: Patterns) => string;

/** Log ends: a square with a darker core, which is as much ring as four pixels allow. */
function logEnd(x: number, y: number, size: number, lit: boolean): string {
  return (
    box(x, y, size, size, lit ? "barklit" : "bark") +
    box(x + 1, y + 1, Math.max(1, size - 2), Math.max(1, size - 2), lit ? "bark" : "soot")
  );
}

/** HOLD — the stack you keep. Balance as fuel not yet burned. */
const woodpile: Draw = (patterns) => {
  const parts: string[] = [];
  const glow = patterns.use("bark", "ember", 25);
  const rows = [5, 5, 4, 3, 2];

  rows.forEach((count, row) => {
    const y = GROUND - (row + 1) * 4;
    const x0 = MOTIF_X - count * 2;
    for (let i = 0; i < count; i++) parts.push(logEnd(x0 + i * 4, y, 4, row === rows.length - 1));
  });

  parts.push(box(MOTIF_X - 12, GROUND, 24, 1, glow));
  return parts.join("");
};

/** TEND — the lit window. From outside, this is the whole signal. */
const window_: Draw = (patterns) => {
  const parts: string[] = [];
  const pane = patterns.use("flame", "ember", 50);
  const spill = patterns.use("night-soft", "flame", 25);

  parts.push(box(MOTIF_X - 13, 10, 26, 28, "soot"));
  parts.push(box(MOTIF_X - 11, 12, 22, 24, pane));
  // Mullions: without them a lit rectangle is a lightbox, not a window.
  parts.push(box(MOTIF_X - 1, 12, 2, 24, "soot"));
  parts.push(box(MOTIF_X - 11, 23, 22, 2, "soot"));
  parts.push(box(MOTIF_X - 15, 38, 30, 2, "bark"));

  // Light reaching the ground below the sill, narrowing as it falls.
  parts.push(box(MOTIF_X - 12, 40, 24, 2, spill));
  parts.push(box(MOTIF_X - 9, 42, 18, 2, spill));
  return parts.join("");
};

/** BURN — the reserve turning into rewards. The one slide that is only fire. */
const blaze: Draw = (patterns) => {
  const parts: string[] = [];
  const heat = patterns.use("ember", "flame", 50);
  const outer = [18, 18, 17, 16, 14, 13, 11, 10, 8, 7, 5, 4, 3, 2];
  const inner = [10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0];
  const base = GROUND - 4;

  outer.forEach((width, row) => {
    parts.push(box(MOTIF_X - Math.round(width / 2), base - row - 1, width, 1, "ember"));
    const core = inner[row]!;
    if (core > 0) {
      parts.push(box(MOTIF_X - Math.round(core / 2), base - row - 1, core, 1, row < 4 ? heat : "flame"));
    }
  });

  parts.push(box(MOTIF_X - 11, base, 22, 2, "bark"), box(MOTIF_X - 7, base + 2, 14, 2, "bark"));
  parts.push(box(MOTIF_X - 9, base, 18, 1, "ember"));

  // Sparks leaving the fire, thinning with height.
  const random = scatter(0x5a24);
  for (let i = 0; i < 9; i++) {
    const x = MOTIF_X - 10 + Math.floor(random() * 20);
    const y = base - 16 - Math.floor(random() * 12);
    parts.push(box(x, y, 1, 1, random() > 0.5 ? "flame" : "ember"));
  }
  return parts.join("");
};

/** CLAIM — what is waiting on the mantel until you come and take it. */
const ingot: Draw = (patterns) => {
  const parts: string[] = [];
  const halo = patterns.use("soot", "ember", 25);

  parts.push(box(MOTIF_X - 22, 22, 44, 6, halo));
  parts.push(box(MOTIF_X - 16, GROUND - 4, 32, 2, "stone"));

  // A short bar, wider at the base: an ingot rather than a brick.
  const rows = [16, 16, 14, 12];
  rows.forEach((width, row) => {
    const y = GROUND - 6 - row;
    parts.push(box(MOTIF_X - Math.round(width / 2), y, width, 1, row === rows.length - 1 ? "flame" : "ember"));
  });
  parts.push(box(MOTIF_X - 5, GROUND - 9, 10, 1, "linen"));
  return parts.join("");
};

export const SLIDES: readonly { readonly name: string; readonly draw: Draw }[] = [
  { name: "hold", draw: woodpile },
  { name: "tend", draw: window_ },
  { name: "burn", draw: blaze },
  { name: "claim", draw: ingot }
];

/** A slide's floor and the haze above it, drawn under whichever motif stands there. */
export function slideGround(patterns: Patterns): string {
  const far = patterns.use("night-mid", "night-soft", 25);
  return (
    box(0, GROUND, SLIDE_W, SLIDE_H - GROUND, "night-deep") +
    box(0, GROUND, SLIDE_W, 1, "night-soft") +
    box(0, GROUND - 6, SLIDE_W, 6, far)
  );
}

/* ---------- the fuel on the pedestal ---------- */

export interface Fuel {
  readonly name: string;
  readonly size: number;
  readonly hot: boolean;
}

export const FUEL: readonly Fuel[] = [
  { name: "log-large", size: 14, hot: true },
  { name: "log-small", size: 10, hot: false },
  { name: "kindling", size: 6, hot: false }
];

/**
 * A log seen end-on: an octagon with rings. The corners are cut by one pixel
 * per side, which at this scale is the whole difference between a log and a
 * crate.
 */
export function fuel(spec: Fuel, patterns: Patterns): string {
  const { size } = spec;
  const parts: string[] = [];
  const ring = patterns.use("bark", "barklit", 50);
  const cut = Math.max(1, Math.round(size / 5));

  for (let row = 0; row < size; row++) {
    const nearEdge = Math.min(row, size - 1 - row);
    const inset = nearEdge < cut ? cut - nearEdge : 0;
    parts.push(box(inset, row, size - inset * 2, 1, "bark"));
  }

  const pad = cut + 1;
  parts.push(box(pad, pad, size - pad * 2, size - pad * 2, ring));

  const core = Math.max(2, Math.round(size / 3));
  const at = Math.round((size - core) / 2);
  parts.push(box(at, at, core, core, spec.hot ? "ember" : "soot"));
  if (spec.hot) parts.push(box(at + 1, at + 1, core - 2, core - 2, "flame"));

  return parts.join("");
}
