/**
 * Cloud bands for the parallax layers.
 *
 * Each band tiles horizontally, so nothing is allowed to touch the left or
 * right edge — a shape crossing the seam would have to match pixel for pixel
 * on both sides, and leaving a gap is the version that stays correct when the
 * silhouettes are edited later.
 *
 * The near layer is the darkest. Distance in a night sky means less contrast,
 * not more, so the far band is the one that fades into the gradient.
 */
import { Patterns, box, scatter, type Ink } from "./pixel.ts";

export const BAND_W = 240;
export const BAND_H = 32;

/** Cloud silhouette as widths per row, bottom row first. */
const SHAPES: readonly (readonly number[])[] = [
  [22, 18, 12, 6],
  [30, 26, 20, 14, 8],
  [16, 12, 6],
  [26, 22, 16, 8, 4]
];

export interface Band {
  readonly name: string;
  readonly ink: Ink;
  readonly seed: number;
  readonly count: number;
  readonly baseline: number;
}

export const BANDS: readonly Band[] = [
  { name: "clouds-far", ink: "night-soft", seed: 0xfa2, count: 5, baseline: 26 },
  { name: "clouds-mid", ink: "dusk", seed: 0x31d7, count: 4, baseline: 30 },
  { name: "clouds-near", ink: "night-deep", seed: 0x9e42, count: 3, baseline: 31 }
];

export function band(spec: Band, patterns: Patterns): string {
  const random = scatter(spec.seed);
  const parts: string[] = [];
  // A soft underside: the row below each cloud is dithered, which stops the
  // silhouette from reading as a cut-out sticker.
  const soft = patterns.use("night-mid", spec.ink, 50);

  const margin = 24;
  const span = BAND_W - margin * 2;

  for (let i = 0; i < spec.count; i++) {
    const shape = SHAPES[Math.floor(random() * SHAPES.length)]!;
    const cx = margin + Math.floor((i + random() * 0.7) * (span / spec.count));
    const lift = Math.floor(random() * 6);

    shape.forEach((width, row) => {
      const x = cx - Math.round(width / 2);
      parts.push(box(x, spec.baseline - lift - row - 1, width, 1, spec.ink));
    });
    parts.push(box(cx - Math.round(shape[0]! / 2), spec.baseline - lift, shape[0]!, 1, soft));
  }

  return parts.join("\n  ");
}
