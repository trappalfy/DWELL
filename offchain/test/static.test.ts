import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticFile } from "../src/api/static.ts";

const root = mkdtempSync(join(tmpdir(), "dwell-web-"));
writeFileSync(join(root, "index.html"), "<h1>hearth</h1>");
writeFileSync(join(root, "styles.css"), "body{}");
mkdirSync(join(root, "lib"), { recursive: true });
writeFileSync(join(root, "lib", "abi.js"), "export const x = 1;");
writeFileSync(join(root, "secret.env"), "KEEPER_PRIVATE_KEY=0xdead");

test("корень отдаёт index.html", () => {
  const hit = resolveStaticFile(root, "/");
  assert.ok(hit);
  assert.equal(hit.contentType, "text/html; charset=utf-8");
  assert.equal(hit.body.toString(), "<h1>hearth</h1>");
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
  writeFileSync(join(dir, "pb-pixel.ttf"), Buffer.from([0x00, 0x01, 0x00, 0x00]));

  const hit = resolveStaticFile(dir, "/pb-pixel.ttf");
  assert.ok(hit, "шрифт не отдан");
  assert.equal(hit.contentType, "font/ttf");

  rmSync(dir, { recursive: true, force: true });
});
