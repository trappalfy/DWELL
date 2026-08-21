import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "index.html"),
  "utf8"
);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: string;
}

function rects(): Box[] {
  const found: Box[] = [];
  const pattern =
    /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" class="([^"]+)"\/>/g;
  for (const m of html.matchAll(pattern)) {
    found.push({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, cls: m[5]! });
  }
  return found;
}

// Matches the opening drawn by scripts/generate-hearth.ts.
const OPENING = { x: 52, y: 60, w: 56, h: 36 };

test("сцена очага сгенерирована в страницу", () => {
  assert.ok(html.includes("<!-- hearth:begin -->"), "маркеры на месте");
  assert.ok(rects().length > 20, "сцена не пустая");
});

test("пламя не вылезает за пределы топки", () => {
  // Художка генерируется из профиля ширин: правка профиля не должна
  // приводить к огню, горящему на полу или сквозь каминную полку.
  const flame = rects().filter((r) => r.cls.startsWith("fl-"));
  assert.ok(flame.length > 0, "пламя нарисовано");

  for (const r of flame) {
    assert.ok(r.x >= OPENING.x, `левый край ${r.x} вылез из топки`);
    assert.ok(r.x + r.w <= OPENING.x + OPENING.w, `правый край вылез из топки`);
    assert.ok(r.y >= OPENING.y, `верх пламени ${r.y} вылез из топки`);
    assert.ok(r.y + r.h <= OPENING.y + OPENING.h, `низ пламени вылез из топки`);
  }
});

test("кадров ровно три и они разной формы", () => {
  const frames = [...html.matchAll(/class="frame f(\d)"/g)].map((m) => m[1]);
  assert.deepEqual(frames, ["1", "2", "3"]);

  // Одинаковые кадры дали бы неподвижный огонь при работающей анимации.
  const shapes = [1, 2, 3].map((n) => {
    const start = html.indexOf(`class="frame f${n}"`);
    const end = html.indexOf("</g>", start);
    return html.slice(start, end);
  });
  assert.notEqual(shapes[0], shapes[1], "кадры 1 и 2 совпали");
  assert.notEqual(shapes[1], shapes[2], "кадры 2 и 3 совпали");
});

test("пламя стоит на дровах, а не висит в воздухе", () => {
  const flame = rects().filter((r) => r.cls === "fl-outer");
  const lowest = Math.max(...flame.map((r) => r.y + r.h));
  const logs = rects().filter((r) => r.cls === "log");
  const logTop = Math.min(...logs.map((r) => r.y));
  assert.ok(Math.abs(lowest - (logTop + 2)) <= 4, `низ пламени ${lowest}, верх дров ${logTop}`);
});
