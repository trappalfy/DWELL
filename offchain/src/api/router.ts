import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveStaticFile } from "./static.ts";

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
    if (!handler && options.staticRoot && request.method === "GET") {
      const file = resolveStaticFile(options.staticRoot, url.pathname);
      if (file) {
        response.writeHead(200, { "content-type": file.contentType, ...CORS_HEADERS });
        response.end(file.body);
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
        ip: request.socket.remoteAddress ?? "unknown"
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
