import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PX, Patterns, scene } from "../scripts/art/pixel.ts";
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

test("отдельные файлы художки самодостаточны", () => {
  // Их читают через <img>, куда стили страницы не дотягиваются: любой class
  // вместо fill остался бы там без цвета.
  for (const name of ["clouds-far", "mech-hold", "mech-burn", "log-large", "favicon"]) {
    const svg = readFileSync(join(web, "art", `${name}.svg`), "utf8");
    assert.ok(svg.startsWith("<svg"), `${name}: не svg`);
    assert.ok(!/<rect[^>]*\sclass="/.test(svg), `${name}: класс вместо заливки в отдельном файле`);
  }
});
