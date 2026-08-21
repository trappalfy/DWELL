import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BackdropSource {
  readonly src: string;
  readonly type: string;
}

export interface Backdrop {
  /** In the order the browser should try them; empty when there is no video. */
  readonly sources: readonly BackdropSource[];
  /** Shown before the first frame decodes, and instead of it under reduced motion. */
  readonly poster: string | null;
}

/**
 * Both encodings are offered rather than one.
 *
 * WebM compresses a dark, slow loop better, but Safari's support for it is
 * patchy and on iOS it is unreliable, so an MP4 alongside is what makes the
 * backdrop appear on every browser rather than most of them. The page lists
 * both as <source> elements and lets the browser choose.
 */
const ENCODINGS: readonly BackdropSource[] = [
  { src: "/media/backdrop.webm", type: "video/webm" },
  { src: "/media/backdrop.mp4", type: "video/mp4" }
];

const POSTERS = ["/media/backdrop-poster.webp", "/media/backdrop-poster.png"];

/**
 * Looks for the backdrop on disk once, at boot.
 *
 * Deliberately not re-checked per request: the answer is handed to every
 * visitor through /v1/config, and a page whose background silently appears
 * mid-session is harder to reason about than one that needs a restart.
 */
export function findBackdrop(webRoot: string): Backdrop {
  const local = (url: string) => join(webRoot, url.replace(/^\//, ""));

  return {
    sources: ENCODINGS.filter((source) => existsSync(local(source.src))),
    poster: POSTERS.find((url) => existsSync(local(url))) ?? null
  };
}
