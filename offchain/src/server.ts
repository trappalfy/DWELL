import { createServer, type Server } from "node:http";
import { createRouter, type RouterOptions } from "./api/router.ts";
import { createHandlers, type HandlerDeps } from "./api/handlers.ts";

/** Port 0 asks the OS for a free port; tests rely on that. */
export function startServer(
  deps: HandlerDeps,
  port: number,
  options: RouterOptions = {}
): Server {
  const server = createServer(createRouter(createHandlers(deps), options));
  server.listen(port);
  return server;
}
