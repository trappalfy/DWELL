import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PX, Patterns, scene } from "../scripts/art/pixel.ts";
import { interior, GEOMETRY, W, H } from "../scripts/art/interior.ts";
import { exterior, GEOMETRY as OUTSIDE } from "../scripts/art/exterior.ts";
import { BANDS, BAND_W, BAND_H, band } from "../scripts/art/clouds.ts";
import { SLIDES, SLIDE_W, SLIDE_H, FUEL, fuel, slideGround } from "../scripts/art/motifs.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** Pulls every rect out of a scene, whichever way it was painted. */
function rects(markup: string): Box[] {
  const found: Box[] = [];
  const pattern =
    /<rect(?:\s+x="(-?[\d.]+)")?(?:\s+y="(-?[\d.]+)")?\s+width="([\d.]+)"\s+height="([\d.]+)"\s+(?:fill|class)="([^"]+)"/g;
  for (const m of markup.matchAll(pattern)) {
    found.push({ x: +(m[1] ?? 0), y: +(m[2] ?? 0), w: +m[3]!, h: +m[4]!, fill: m[5]! });
  }
  return found;
}

/** Everything the generator draws, rebuilt in process so tests never parse the page. */
function everyScene(): { name: string; markup: string; width: number; height: number }[] {
  const built: { name: string; markup: string; width: number; height: number }[] = [];

  for (const [name, draw] of [
    ["interior", interior],
    ["exterior", exterior]
  ] as const) {
    const patterns = new Patterns();
    const { body, defs } = draw(patterns);
    built.push({
      name,
      markup: scene({ width: W, height: H, label: "", patterns, body, defs }),
      width: W,
      height: H
    });
  }

  for (const spec of BANDS) {
    const patterns = new Patterns();
    const body = band(spec, patterns);
    built.push({
      name: spec.name,
      markup: scene({ width: BAND_W, height: BAND_H, label: "", patterns, body }),
      width: BAND_W,
      height: BAND_H
    });
  }

  for (const slide of SLIDES) {
    const patterns = new Patterns();
    const body = slideGround(patterns) + slide.draw(patterns);
    built.push({
      name: `mech-${slide.name}`,
      markup: scene({ width: SLIDE_W, height: SLIDE_H, label: "", patterns, body }),
      width: SLIDE_W,
      height: SLIDE_H
    });
  }

  for (const spec of FUEL) {
    const patterns = new Patterns();
    built.push({
      name: spec.name,
      markup: scene({ width: spec.size, height: spec.size, label: "", patterns, body: fuel(spec, patterns) }),
      width: spec.size,
      height: spec.size
    });
  }

  return built;
}

test("ни один пиксель не выходит за пределы своей сцены", () => {
  // Дым из трубы уже однажды ушёл в отрицательные координаты и просто не
  // отрисовался. Обрезанную художку на глаз не заметишь, поэтому её ловит тест.
  for (const { name, markup, width, height } of everyScene()) {
    for (const r of rects(markup)) {
      assert.ok(r.x >= 0, `${name}: левый край ${r.x} за пределами сцены`);
      assert.ok(r.y >= 0, `${name}: верхний край ${r.y} за пределами сцены`);
      assert.ok(r.x + r.w <= width * PX, `${name}: правый край ${r.x + r.w} за пределами сцены`);
      assert.ok(r.y + r.h <= height * PX, `${name}: нижний край ${r.y + r.h} за пределами сцены`);
    }
  }
});

test("каждая ссылка на паттерн разрешается внутри своего файла", () => {
  // Файлы отдаются по отдельности: ссылка на паттерн из другого файла не
  // ошибка разметки, а чёрный прямоугольник на месте картинки.
  for (const { name, markup } of everyScene()) {
    const declared = new Set([...markup.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...markup.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]));

    for (const id of used) {
      if (!id || id.endsWith("-glow")) continue; // градиенты объявлены отдельно
      assert.ok(declared.has(id), `${name}: паттерн ${id} используется, но не объявлен`);
    }
  }
});

test("всё стоит на сетке художественного пикселя", () => {
  // Сетка 4 px — единственное, что удерживает разные сцены в одном масштабе.
  for (const { name, markup } of everyScene()) {
    for (const r of rects(markup)) {
      for (const [label, value] of [["x", r.x], ["y", r.y], ["ширина", r.w], ["высота", r.h]] as const) {
        assert.equal(value % PX, 0, `${name}: ${label} = ${value} не кратно ${PX}`);
      }
    }
  }
});

test("пламя не вылезает за пределы топки", () => {
  const patterns = new Patterns();
  const flame = rects(interior(patterns).body).filter((r) => r.fill.startsWith("fl-"));
  assert.ok(flame.length > 0, "пламя нарисовано");

  const { OPENING } = GEOMETRY;
  for (const r of flame) {
    assert.ok(r.x >= OPENING.x * PX, `левый край ${r.x} вылез из топки`);
    assert.ok(r.x + r.w <= (OPENING.x + OPENING.w) * PX, "правый край вылез из топки");
    assert.ok(r.y >= OPENING.y * PX, `верх пламени ${r.y} вылез из топки`);
    assert.ok(r.y + r.h <= (OPENING.y + OPENING.h) * PX, "низ пламени вылез из топки");
  }
});

test("пламя стоит на дровах, а не висит в воздухе", () => {
  const patterns = new Patterns();
  const flame = rects(interior(patterns).body).filter((r) => r.fill === "fl-outer");
  const lowest = Math.max(...flame.map((r) => r.y + r.h));
  assert.equal(lowest, GEOMETRY.FIRE_BASE * PX, "низ пламени не совпал с верхом поленьев");
});

test("кадров ровно три и они разной формы", () => {
  const patterns = new Patterns();
  const { body } = interior(patterns);

  const frames = [...body.matchAll(/class="frame f(\d)"/g)].map((m) => m[1]);
  assert.deepEqual(frames, ["1", "2", "3"]);

  // Одинаковые кадры дали бы неподвижный огонь при работающей анимации.
  const shapes = [1, 2, 3].map((n) => {
    const start = body.indexOf(`class="frame f${n}"`);
    return body.slice(start, body.indexOf("</g>", start));
  });
  assert.notEqual(shapes[0], shapes[1], "кадры 1 и 2 совпали");
  assert.notEqual(shapes[1], shapes[2], "кадры 2 и 3 совпали");
});

test("ёлки шире у земли, чем у верхушки", () => {
  // Профиль однажды был перевёрнут, и деревья росли вниз конусом. Силуэт
  // читается только по общей форме, поэтому проверяется именно она.
  const patterns = new Patterns();
  const dark = rects(exterior(patterns).body).filter(
    (r) => r.fill === "#0A0A14" && r.h === PX && r.y < OUTSIDE.GROUND_Y * PX && r.y >= (OUTSIDE.GROUND_Y - 18) * PX
  );

  const nearGround = dark.filter((r) => r.y >= (OUTSIDE.GROUND_Y - 3) * PX);
  const highUp = dark.filter((r) => r.y <= (OUTSIDE.GROUND_Y - 14) * PX);
  assert.ok(nearGround.length > 0 && highUp.length > 0, "силуэты деревьев найдены");

  const widest = (boxes: Box[]) => Math.max(...boxes.map((r) => r.w));
  assert.ok(
    widest(nearGround) > widest(highUp),
    `у земли ${widest(nearGround)}, у верхушки ${widest(highUp)} — конус перевёрнут`
  );
});

test("облачные полосы не касаются шва замощения", () => {
  // Полосы повторяются по X: фигура, пересекающая край, обязана совпасть
  // пиксель в пиксель с другой стороной, а зазор остаётся верным всегда.
  for (const spec of BANDS) {
    const patterns = new Patterns();
    for (const r of rects(band(spec, patterns))) {
      assert.ok(r.x > 0, `${spec.name}: облако касается левого шва`);
      assert.ok(r.x + r.w < BAND_W * PX, `${spec.name}: облако касается правого шва`);
    }
  }
});

test("обе сцены вклеены в страницу", () => {
  const html = readFileSync(join(web, "index.html"), "utf8");
  for (const name of ["interior", "exterior"]) {
    assert.ok(html.includes(`<!-- art:${name} -->`), `маркер ${name} на месте`);
    assert.ok(html.includes(`class="scene scene-${name}"`), `сцена ${name} вклеена`);
  }
  assert.ok(rects(html).length > 200, "сцены не пустые");
});

test("отдельные файлы художки самодостаточны", () => {
  // Их читают через <img>, куда стили страницы не дотягиваются: любой class
  // вместо fill остался бы там без цвета.
  for (const name of ["clouds-far", "mech-hold", "mech-burn", "log-large", "favicon"]) {
    const svg = readFileSync(join(web, "art", `${name}.svg`), "utf8");
    assert.ok(svg.startsWith("<svg"), `${name}: не svg`);
    assert.ok(!/<rect[^>]*\sclass="/.test(svg), `${name}: класс вместо заливки в отдельном файле`);
  }
});
