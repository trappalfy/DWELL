import { readFileSync, statSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

/**
 * Extensions this server will hand out. An allowlist rather than a blocklist:
 * the process holds the keeper private key in its environment and writes a
 * SQLite file, so anything not explicitly a web asset must stay unreachable.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  // Pixel faces ship as TrueType and weigh single-digit kilobytes, so the
  // conversion to woff2 would buy nothing and cost a build step.
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

/**
 * Types a browser fetches by byte range rather than in one piece.
 *
 * This is not an optimisation. Safari refuses to play a <video> whose server
 * does not answer range requests, so on iOS the backdrop would simply be a
 * black rectangle. Reading a video into a Buffer per request would also put
 * the whole file in memory for every visitor at once.
 */
const SEEKABLE = new Set([".mp4", ".webm"]);

export interface StaticHit {
  readonly absolutePath: string;
  readonly contentType: string;
  readonly size: number;
  readonly seekable: boolean;
}

/**
 * Maps a URL path to a file inside `root`, or null when it must not be served.
 *
 * Containment is checked on the RESOLVED absolute path rather than by
 * inspecting the request for "..", because encodings and clever nesting
 * ("....//") defeat string matching while resolution cannot be fooled.
 */
export function resolveStaticFile(root: string, urlPath: string): StaticHit | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // Malformed percent-encoding is never a legitimate asset request.
    return null;
  }

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const rootAbsolute = resolve(root);
  const target = resolve(rootAbsolute, normalize(relative));

  if (target !== rootAbsolute && !target.startsWith(rootAbsolute + sep)) return null;

  const extension = target.slice(target.lastIndexOf("."));
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) return null;

  try {
    const stats = statSync(target);
    if (!stats.isFile()) return null;
    return {
      absolutePath: target,
      contentType,
      size: stats.size,
      seekable: SEEKABLE.has(extension)
    };
  } catch {
    return null;
  }
}

/** Reads a whole asset. Only used for the small files; media is streamed. */
export function readStaticFile(hit: StaticHit): Buffer {
  return readFileSync(hit.absolutePath);
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parses one byte range against a known size.
 *
 * Returns null when the header is absent or unparseable — the caller then
 * answers with the whole file, which is what the spec asks for — and
 * "unsatisfiable" when the range is syntactically fine but outside the file,
 * which has to become a 416 rather than a silent full response.
 */
export function parseRange(
  header: string | undefined,
  size: number
): ByteRange | null | "unsatisfiable" {
  if (!header) return null;

  // Only `bytes` is defined, and only a single range is worth supporting: no
  // browser asks for multipart ranges on a video backdrop.
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;

  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const wanted = Number(rawEnd);
    if (wanted === 0) return "unsatisfiable";
    start = Math.max(0, size - wanted);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start < 0) return "unsatisfiable";
  // An end past the last byte is clamped, not rejected: the spec says so, and
  // players routinely ask for more than is there on the final chunk.
  if (end >= size) end = size - 1;
  if (end < start) return "unsatisfiable";

  return { start, end };
}
