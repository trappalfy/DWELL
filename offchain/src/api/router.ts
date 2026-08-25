import type { IncomingMessage, ServerResponse } from "node:http";
import { clientIp } from "./clientIp.ts";
import { createReadStream } from "node:fs";
import { resolveStaticFile, readStaticFile, parseRange, type StaticHit } from "./static.ts";

export interface RouteContext {
  readonly body: unknown;
  readonly url: URL;
  readonly bearer: string | null;
  readonly ip: string;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export type Handler = (context: RouteContext) => Promise<RouteResult> | RouteResult;
export type Routes = Record<string, Handler>;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // The largest legitimate request is a signature; anything bigger is noise.
    if (size > 8_192) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface RouterOptions {
  /** Directory served for paths outside /v1. Omit to serve the API alone. */
  readonly staticRoot?: string;
  /**
   * How many reverse proxies this server actually runs behind.
   *
   * Deployment knowledge that cannot be inferred from a request: it decides
   * which X-Forwarded-For entry is the real client. Zero — the default —
   * means no proxy, so the header is ignored entirely and the socket peer is
   * used. See clientIp for why the count is taken from the right.
   */
  readonly trustedProxyHops?: number;
}

/**
 * Answers a media request, honouring a byte range when one is asked for.
 *
 * The body is piped rather than buffered: a backdrop video is orders of
 * magnitude larger than anything else here, and the page asks people to keep
 * the tab open for hours, so holding a copy per request is not an option.
 */
function sendMedia(request: IncomingMessage, response: ServerResponse, hit: StaticHit): void {
  const range = parseRange(request.headers.range, hit.size);

  if (range === "unsatisfiable") {
    response.writeHead(416, {
      "content-range": `bytes */${hit.size}`,
      "accept-ranges": "bytes",
      ...CORS_HEADERS
    });
    response.end();
    return;
  }

  const headers: Record<string, string> = {
    "content-type": hit.contentType,
    "accept-ranges": "bytes",
    // The backdrop never changes without its filename changing, and it is the
    // heaviest thing on the page; re-fetching it on every visit is waste.
    "cache-control": "public, max-age=604800",
    ...CORS_HEADERS
  };

  if (!range) {
    headers["content-length"] = String(hit.size);
    response.writeHead(200, headers);
    createReadStream(hit.absolutePath).pipe(response);
    return;
  }

  headers["content-length"] = String(range.end - range.start + 1);
  headers["content-range"] = `bytes ${range.start}-${range.end}/${hit.size}`;
  response.writeHead(206, headers);
  createReadStream(hit.absolutePath, { start: range.start, end: range.end }).pipe(response);
}

export function createRouter(routes: Routes, options: RouterOptions = {}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS).end();
      return;
    }

    const handler = routes[`${request.method} ${url.pathname}`];

    // The API owns /v1; everything else is the page. Checked only after the
    // route table misses, so a bug in static serving can never shadow an
    // endpoint.
    if (!handler && options.staticRoot && (request.method === "GET" || request.method === "HEAD")) {
      const file = resolveStaticFile(options.staticRoot, url.pathname);
      if (file) {
        if (file.seekable) {
          sendMedia(request, response, file);
          return;
        }
        response.writeHead(200, { "content-type": file.contentType, ...CORS_HEADERS });
        response.end(request.method === "HEAD" ? undefined : readStaticFile(file));
        return;
      }
    }

    if (!handler) {
      response.writeHead(404, { "content-type": "application/json", ...CORS_HEADERS });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const authorization = request.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;

    let result: RouteResult;
    try {
      const body = request.method === "POST" ? await readBody(request) : {};
      result = await handler({
        body,
        url,
        bearer,
        ip: clientIp(request, options.trustedProxyHops ?? 0)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad request";
      result = { status: 400, body: { error: message } };
    }

    response.writeHead(result.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS
    });
    response.end(JSON.stringify(result.body));
  };
}
