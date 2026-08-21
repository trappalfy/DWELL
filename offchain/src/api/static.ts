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
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

export interface StaticHit {
  readonly body: Buffer;
  readonly contentType: string;
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
    if (!statSync(target).isFile()) return null;
    return { body: readFileSync(target), contentType };
  } catch {
    return null;
  }
}
