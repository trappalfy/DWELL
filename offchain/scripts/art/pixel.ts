/**
 * Primitives for drawing pixel art as static SVG.
 *
 * The art is generated rather than hand-placed: a scene is a few dozen runs
 * of colour, and describing it as data is both readable and reviewable, while
 * hand-writing two hundred <rect> elements is neither. Nothing here runs in
 * the browser — the output is plain markup the page serves as-is.
 */

/** One art pixel in SVG units. Everything snaps to this; nothing is off-grid. */
export const PX = 4;

/**
 * The scene palette.
 *
 * Two environments meet here: the night outside is unsaturated blue-violet,
 * the fire inside is the only saturated thing in either. Intermediate values
 * come from dithering between these rather than from more hex codes, which is
 * what keeps the art reading as pixel art instead of as flat blocks.
 */
export const PALETTE = {
  "night-deep": "#0A0A14",
  "night-mid": "#16142A",
  "night-soft": "#23203D",
  dusk: "#4A4266",
  haze: "#9C94BA",
  soot: "#14131A",
  stone: "#3A3849",
  ember: "#FF7A34",
  flame: "#FFC24A",
  linen: "#E8E0D2",
  /** Unlit timber and furniture. */
  bark: "#2E2733",
  /** Timber with firelight on it — the only warm brown in the set. */
  barklit: "#6B4A38",
  /** Window glass with night behind it. */
  glass: "#1C1B33"
} as const;

export type Ink = keyof typeof PALETTE;

/**
 * Dither densities, as the share of the tile covered by the second colour.
 * Three steps are enough for a convincing falloff and keep the pattern
 * definitions countable.
 */
export const DITHERS = [25, 50, 75] as const;
export type Density = (typeof DITHERS)[number];

/** A dithered fill, e.g. `mix("stone", "ember", 25)`. */
export function mix(base: Ink, over: Ink, density: Density): string {
  return `url(#d${density}-${base}-${over})`;
}

/** Every pattern a scene asked for, collected so each is defined exactly once. */
export class Patterns {
  readonly #used = new Set<string>();

  use(base: Ink, over: Ink, density: Density): string {
    this.#used.add(`${density}|${base}|${over}`);
    return mix(base, over, density);
  }

  /**
   * Patterns are laid out in userSpaceOnUse at PX scale, so a dithered area
   * lines up with every other pixel in the scene instead of drifting.
   */
  defs(): string {
    return [...this.#used]
      .sort()
      .map((key) => {
        const [density, base, over] = key.split("|") as [string, Ink, Ink];
        const dots =
          density === "25"
            ? [[0, 0]]
            : density === "50"
              ? [
                  [0, 0],
                  [1, 1]
                ]
              : [
                  [0, 0],
                  [1, 1],
                  [1, 0]
                ];
        const cells = dots
          .map(
            ([x, y]) =>
              `<rect x="${x! * PX}" y="${y! * PX}" width="${PX}" height="${PX}" fill="${PALETTE[over]}"/>`
          )
          .join("");
        return (
          `<pattern id="d${density}-${base}-${over}" width="${PX * 2}" height="${PX * 2}" ` +
          `patternUnits="userSpaceOnUse">` +
          `<rect width="${PX * 2}" height="${PX * 2}" fill="${PALETTE[base]}"/>${cells}</pattern>`
        );
      })
      .join("\n    ");
  }
}

/** A filled block in art-pixel coordinates. `fill` takes an ink name or a pattern url. */
export function box(x: number, y: number, w: number, h: number, fill: Ink | string): string {
  const paint = fill in PALETTE ? PALETTE[fill as Ink] : fill;
  return `<rect x="${x * PX}" y="${y * PX}" width="${w * PX}" height="${h * PX}" fill="${paint}"/>`;
}

/** A block that the page styles by class, for scenes whose state changes. */
export function styled(x: number, y: number, w: number, h: number, cls: string): string {
  return `<rect x="${x * PX}" y="${y * PX}" width="${w * PX}" height="${h * PX}" class="${cls}"/>`;
}

/**
 * A shape given as widths per row, centred on `cx` and growing upward from
 * `baseY`. This is how flames, smoke and foliage are described: a silhouette
 * is far easier to read and correct as a list of widths than as coordinates.
 */
export function column(
  cx: number,
  baseY: number,
  widths: readonly number[],
  paint: (row: number) => string,
  shift: (row: number) => number = () => 0
): string {
  const parts: string[] = [];
  widths.forEach((width, row) => {
    if (width <= 0) return;
    const x = Math.round(cx - width / 2) + shift(row);
    parts.push(box(x, baseY - row - 1, width, 1, paint(row)));
  });
  return parts.join("");
}

/**
 * A stepped diagonal — the move that makes a roofline or a hillside read as
 * drawn rather than as a rotated rectangle. Each step is one pixel tall.
 */
export function slope(
  x: number,
  y: number,
  steps: number,
  run: number,
  direction: 1 | -1,
  height: number,
  fill: Ink | string
): string {
  const parts: string[] = [];
  for (let step = 0; step < steps; step++) {
    const left = direction === 1 ? x + step * run : x - (step + 1) * run;
    parts.push(box(left, y + step, run, height - step, fill));
  }
  return parts.join("");
}

export interface SceneOptions {
  /** Art-pixel dimensions; the viewBox is these times PX. */
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly patterns: Patterns;
  readonly body: string;
  /** Extra <defs> content, e.g. gradients the scene needs. */
  readonly defs?: string;
  /** Emitted for standalone files so class-driven colours survive in <img>. */
  readonly inlineStyle?: string;
  readonly className?: string;
}

export function scene(options: SceneOptions): string {
  const { width, height, label, patterns, body } = options;
  const defs = [patterns.defs(), options.defs ?? ""].filter(Boolean).join("\n    ");

  return [
    `<svg${options.className ? ` class="${options.className}"` : ""} viewBox="0 0 ${width * PX} ${height * PX}"`,
    `     role="img" aria-label="${label}" shape-rendering="crispEdges"`,
    `     xmlns="http://www.w3.org/2000/svg">`,
    options.inlineStyle ? `  <style>${options.inlineStyle}</style>` : "",
    defs ? `  <defs>\n    ${defs}\n  </defs>` : "",
    body,
    `</svg>`
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A deterministic scatter. Stars and embers must land in the same places on
 * every build, or a regenerated scene would produce a meaningless diff.
 */
export function scatter(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
