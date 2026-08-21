import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticFile, readStaticFile, parseRange } from "../src/api/static.ts";

const root = mkdtempSync(join(tmpdir(), "dwell-web-"));
writeFileSync(join(root, "index.html"), "<h1>hearth</h1>");
writeFileSync(join(root, "styles.css"), "body{}");
mkdirSync(join(root, "lib"), { recursive: true });
writeFileSync(join(root, "lib", "abi.js"), "export const x = 1;");
writeFileSync(join(root, "secret.env"), "KEEPER_PRIVATE_KEY=0xdead");
mkdirSync(join(root, "media"), { recursive: true });
writeFileSync(join(root, "media", "backdrop.webm"), Buffer.alloc(1000, 7));

test("корень отдаёт index.html", () => {
  const hit = resolveStaticFile(root, "/");
  assert.ok(hit);
  assert.equal(hit.contentType, "text/html; charset=utf-8");
  assert.equal(readStaticFile(hit).toString(), "<h1>hearth</h1>");
});

test("вложенный файл отдаётся с верным типом", () => {
  const hit = resolveStaticFile(root, "/lib/abi.js");
  assert.ok(hit);
  assert.equal(hit.contentType, "text/javascript; charset=utf-8");
});

test("обход каталога не выпускает за корень", () => {
  // Самый важный тест в файле: у процесса есть приватный ключ кипера,
  // и вылезти за web/ означало бы отдавать его наружу по HTTP.
  for (const attack of [
    "/../../etc/passwd",
    "/../.env",
    "/lib/../../.env",
    "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/....//....//.env"
  ]) {
    assert.equal(resolveStaticFile(root, attack), null, `пропущено: ${attack}`);
  }
});

test("расширения вне белого списка не отдаются", () => {
  // Файл существует и лежит внутри корня, но отдавать .env нельзя.
  assert.equal(resolveStaticFile(root, "/secret.env"), null);
});

test("несуществующий файл даёт null, а не исключение", () => {
  assert.equal(resolveStaticFile(root, "/nope.html"), null);
});

test("каталог сам по себе не отдаётся", () => {
  assert.equal(resolveStaticFile(root, "/lib"), null);
});

test("шрифты отдаются с типом, который браузер примет", () => {
  // Гарнитуры лежат у нас, а не на чужом CDN. Неверный content-type для
  // шрифта — это молчаливый откат на запасную гарнитуру, а не ошибка.
  const dir = mkdtempSync(join(tmpdir(), "dwell-fonts-"));
  const expected = { "akedopikuseru.otf": "font/otf", "some-face.ttf": "font/ttf" };

  for (const [name, contentType] of Object.entries(expected)) {
    writeFileSync(join(dir, name), Buffer.from([0x4f, 0x54, 0x54, 0x4f]));
    const hit = resolveStaticFile(dir, "/" + name);
    assert.ok(hit, `шрифт не отдан: ${name}`);
    assert.equal(hit.contentType, contentType);
  }

  rmSync(dir, { recursive: true, force: true });
});

test("видео помечается как отдаваемое по диапазонам", () => {
  // Safari отказывается проигрывать <video>, если сервер не отвечает на
  // range-запросы: на iPhone фон оказался бы чёрным прямоугольником.
  const hit = resolveStaticFile(root, "/media/backdrop.webm");
  assert.ok(hit);
  assert.equal(hit.contentType, "video/webm");
  assert.equal(hit.seekable, true);
  assert.equal(hit.size, 1000);
});

test("обычные ассеты по диапазонам не отдаются", () => {
  const hit = resolveStaticFile(root, "/styles.css");
  assert.ok(hit);
  assert.equal(hit.seekable, false);
});

test("диапазон разбирается во всех формах, которые шлют плееры", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  // Хвост файла: так плеер добирает метаданные в конце контейнера.
  assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
  // Конец за последним байтом обрезается, а не отвергается: плееры
  // регулярно просят больше, чем есть, на последнем куске.
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
});

test("отсутствующий или мусорный заголовок означает файл целиком", () => {
  for (const header of [undefined, "", "items=0-9", "bytes=abc", "bytes=-", "bytes=0-9,20-29"]) {
    assert.equal(parseRange(header, 1000), null, `не распознано как «целиком»: ${header}`);
  }
});

test("диапазон вне файла обязан стать 416, а не тихой отдачей целиком", () => {
  assert.equal(parseRange("bytes=1000-1099", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=800-700", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
});
