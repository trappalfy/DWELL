import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { startServer } from "../src/server.ts";
import type { Address } from "../src/types.ts";

/** A body with distinct bytes, so a wrong slice is visible rather than plausible. */
const SIZE = 4096;
const VIDEO = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "dwell-media-"));
  mkdirSync(join(root, "media"), { recursive: true });
  writeFileSync(join(root, "media", "backdrop.webm"), VIDEO);
  writeFileSync(join(root, "index.html"), "<h1>hearth</h1>");

  const db = openDatabase(":memory:");
  const server = startServer(
    {
      heartbeats: new HeartbeatStore(db),
      entitlements: new EntitlementStore(db),
      reader: {
        currentBlock: async () => 1n,
        balancesAt: async (accounts: readonly Address[]) => new Map(accounts.map((a) => [a, 0n])),
        claimed: async () => 0n,
        vaultState: async () => ({ balance: 0n, totalAllocated: 0n, totalClaimed: 0n })
      },
      backdrop: { sources: [], poster: null },
      roots: { lastPublished: () => null },
      epochs: { countSettledAfter: () => 0 },
      minBalance: 1n,
      vaultAddress: "0xeeee000000000000000000000000000000000003" as Address,
      projectToken: "0xdddd000000000000000000000000000000000004" as Address,
      dryRun: false,
      now: () => Date.now()
    },
    0,
    { staticRoot: root }
  );

  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/media/backdrop.webm`,
    cleanup: () => {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("видео без заголовка Range отдаётся целиком и объявляет поддержку диапазонов", async (t) => {
  const { url, cleanup } = await boot();
  t.after(cleanup);

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/webm");
  // Без этого заголовка Safari даже не станет просить диапазон.
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), String(SIZE));

  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, SIZE);
  assert.ok(body.equals(VIDEO), "тело не совпало с файлом");
});

test("запрошенный диапазон отдаётся как 206 с ровно теми байтами", async (t) => {
  const { url, cleanup } = await boot();
  t.after(cleanup);

  const response = await fetch(url, { headers: { range: "bytes=100-199" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 100-199/${SIZE}`);
  assert.equal(response.headers.get("content-length"), "100");

  const body = Buffer.from(await response.arrayBuffer());
  assert.ok(body.equals(VIDEO.subarray(100, 200)), "отдан не тот кусок");
});

test("хвостовой диапазон добирает конец файла", async (t) => {
  // Так плеер читает метаданные, которые в контейнере лежат в конце.
  const { url, cleanup } = await boot();
  t.after(cleanup);

  const response = await fetch(url, { headers: { range: "bytes=-64" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes ${SIZE - 64}-${SIZE - 1}/${SIZE}`);

  const body = Buffer.from(await response.arrayBuffer());
  assert.ok(body.equals(VIDEO.subarray(SIZE - 64)), "хвост не совпал");
});

test("диапазон за пределами файла даёт 416, а не тихую отдачу целиком", async (t) => {
  const { url, cleanup } = await boot();
  t.after(cleanup);

  const response = await fetch(url, { headers: { range: `bytes=${SIZE}-${SIZE + 99}` } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), `bytes */${SIZE}`);
});

test("HEAD отвечает размером без тела", async (t) => {
  // Плееры начинают с HEAD, чтобы узнать длину до первой порции данных.
  const { url, cleanup } = await boot();
  t.after(cleanup);

  const response = await fetch(url, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(SIZE));
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test("обход каталога через путь к медиа не работает", async (t) => {
  const { url, cleanup } = await boot();
  t.after(cleanup);

  const base = url.slice(0, url.indexOf("/media"));
  for (const attack of ["/media/../../etc/passwd", "/media/%2e%2e%2f%2e%2e%2f.env"]) {
    assert.equal((await fetch(base + attack)).status, 404, `пропущено: ${attack}`);
  }
});
