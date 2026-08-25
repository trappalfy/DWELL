/** The parts of an incoming request this needs; kept narrow so it stays testable. */
export interface AddressableRequest {
  // An index signature rather than the single header: node's IncomingHttpHeaders
  // is one, and a narrower shape would have no properties in common with it.
  readonly headers: { readonly [name: string]: string | string[] | undefined };
  readonly socket: { readonly remoteAddress?: string | undefined };
}

/**
 * The address a rate limit should be counted against.
 *
 * Behind a proxy every request arrives from the proxy's own address, so
 * counting the socket peer would put the whole world in one bucket — five
 * sign-ins a minute for everybody together. The client address has to come
 * from X-Forwarded-For instead.
 *
 * Which entry is the real one is the whole question. Each proxy APPENDS the
 * address it received the request from, so the list reads
 * `client, proxy1, proxy2` and grows to the right. Anything a client sends
 * itself lands on the left, ahead of what the proxies wrote — which is why
 * the leftmost entry is worthless: a client that sends
 * `X-Forwarded-For: evil` produces `evil, <its real address>` and would
 * otherwise be free to invent a new identity per request and walk past the
 * limit.
 *
 * So the entry to trust is counted from the RIGHT, one hop per proxy we
 * actually run behind. That number is deployment knowledge and cannot be
 * guessed from the request: one proxy in front of us means the last entry,
 * two means the second from the end.
 *
 * Everything unexpected falls back to the socket address. That direction is
 * safe: it over-counts distinct clients into one bucket, which throttles too
 * much rather than letting the limit be bypassed.
 */
export function clientIp(request: AddressableRequest, trustedProxyHops: number): string {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (trustedProxyHops <= 0) return socketAddress;

  const raw = request.headers["x-forwarded-for"];
  if (raw === undefined) return socketAddress;

  const entries = (Array.isArray(raw) ? raw.join(",") : raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const index = entries.length - trustedProxyHops;
  if (index < 0) return socketAddress;

  return entries[index] ?? socketAddress;
}
