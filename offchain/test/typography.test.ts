/**
 * Сторож типографской сетки.
 *
 * Пиксельная гарнитура нарисована в клетке 8x8, её кегельная площадка — семь
 * нарисованных пикселей, поэтому она чёткая только на кеглях, кратных семи.
 * Правило легко нарушить задним числом: поправить один размер «на глаз», и
 * вся страница поплывёт так же, как в прошлый раз. Числа ниже вынимаются из
 * самого файла гарнитуры, а не переписываются сюда руками.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const css = readFileSync(join(web, "styles.css"), "utf8");

/** Разбирает файл в плоский список правил: селектор плюс его объявления. */
interface Rule {
  readonly selector: string;
  readonly body: string;
}

function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf("{", at);
    if (open === -1) break;

    const head = text.slice(at, open).trim();
    const close = text.indexOf("}", open);
    if (close === -1) break;

    // Медиазапросы и @font-face содержат вложенные блоки: заходим внутрь.
    if (head.startsWith("@media") || head.startsWith("@supports")) {
      at = open + 1;
      continue;
    }

    const selector = head.slice(head.lastIndexOf("}") + 1).trim();
    if (selector.length > 0 && !selector.startsWith("@")) {
      rules.push({ selector, body: text.slice(open + 1, close) });
    }
    at = close + 1;
  }

  return rules;
}

const rules = parseRules(css);

/** Читает единственное объявление свойства из тела правила. */
function declaration(body: string, property: string): string | null {
  for (const line of body.split(";")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim() === property) return line.slice(colon + 1).trim();
  }
  return null;
}

/** Кегельная площадка гарнитуры, вынутая из файла: во сколько пикселей она делится. */
function stepsPerEm(): number {
  const file = readFileSync(join(web, "fonts", "akedopikuseru.otf"));
  const tables = new Map<string, number>();
  for (let i = 0, n = file.readUInt16BE(4); i < n; i++) {
    const record = 12 + i * 16;
    tables.set(file.toString("ascii", record, record + 4), file.readUInt32BE(record + 8));
  }

  const unitsPerEm = file.readUInt16BE(tables.get("head")! + 18);
  const advance = file.readUInt16BE(tables.get("hmtx")! );
  const os2 = tables.get("OS/2")!;
  const capHeight = file.readInt16BE(os2 + 88);
  const xHeight = file.readInt16BE(os2 + 86);

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let pixel = unitsPerEm;
  for (const value of [advance, capHeight, xHeight]) pixel = gcd(pixel, value);

  return unitsPerEm / pixel;
}

const STEP = stepsPerEm();

/** Селекторы, которые сами объявляют пиксельную гарнитуру. */
const pixelSelectors = new Set(
  rules.filter((r) => declaration(r.body, "font-family") === "var(--pixel)").map((r) => r.selector)
);

test("гарнитура нарисована на сетке в семь пикселей", () => {
  // Если гарнитуру подменят на другую, весь масштаб ниже станет неверным, и
  // об этом надо узнать здесь, а не по размытым буквам на странице.
  assert.equal(STEP, 7, "шаг сетки изменился — масштаб на странице надо пересчитать");
});

test("файл гарнитуры лежит там, куда указывает @font-face", () => {
  // Ровно эта рассинхронизация уже случалась: стиль ссылался на одно имя,
  // в каталоге лежало другое, и страница молча падала на запасную гарнитуру.
  const match = css.indexOf("src: url(\"");
  assert.notEqual(match, -1, "в стилях нет @font-face");

  const from = match + "src: url(\"".length;
  const url = css.slice(from, css.indexOf("\"", from));
  assert.ok(existsSync(join(web, url)), `@font-face ссылается на отсутствующий файл: ${url}`);
});

test("каждый кегль пиксельной гарнитуры кратен шагу сетки", () => {
  const offGrid: string[] = [];

  for (const rule of rules) {
    if (!pixelSelectors.has(rule.selector)) continue;
    const size = declaration(rule.body, "font-size");
    if (size === null) continue;

    const px = Number.parseInt(size, 10);
    assert.ok(size.endsWith("px"), `${rule.selector}: кегль не в пикселях — ${size}`);
    if (px % STEP !== 0) offGrid.push(`${rule.selector} = ${size}`);
  }

  assert.deepEqual(offGrid, [], `кегли вне сетки в ${STEP}px`);
});

test("переопределения кегля в брейкпоинтах тоже на сетке", () => {
  // Правило легче всего нарушить именно здесь: базовый размер выверен, а
  // мобильный дописан на глаз.
  const offGrid: string[] = [];

  for (const rule of rules) {
    const size = declaration(rule.body, "font-size");
    if (size === null) continue;

    // Селектор в брейкпоинте может перечислять несколько имён через запятую.
    const names = rule.selector.split(",").map((s) => s.trim());
    if (!names.some((name) => pixelSelectors.has(name))) continue;

    const px = Number.parseInt(size, 10);
    if (px % STEP !== 0) offGrid.push(`${rule.selector} = ${size}`);
  }

  assert.deepEqual(offGrid, [], `кегли вне сетки в ${STEP}px`);
});

test("кегль пиксельной гарнитуры никогда не текучий", () => {
  // clamp() почти на любой ширине окна попадает между шагами сетки — именно
  // это в прошлый раз и превратило крупный текст в кашу.
  for (const rule of rules) {
    if (!pixelSelectors.has(rule.selector)) continue;
    const size = declaration(rule.body, "font-size");
    if (size === null) continue;
    assert.ok(!size.includes("clamp("), `${rule.selector}: текучий кегль ${size}`);
    assert.ok(!size.includes("vw"), `${rule.selector}: кегль привязан к ширине окна — ${size}`);
  }
});

test("трекинг либо нулевой, либо кратен пикселю клетки", () => {
  // Клетка уже несёт свой пиксель промежутка. Произвольный трекинг сдвигает
  // каждую букву после первой с сетки.
  for (const rule of rules) {
    if (!pixelSelectors.has(rule.selector)) continue;
    const tracking = declaration(rule.body, "letter-spacing");
    if (tracking === null) continue;

    const allowed = tracking === "0" || tracking.includes("var(--px-gap)");
    assert.ok(allowed, `${rule.selector}: трекинг вне сетки — ${tracking}`);
  }
});

test("поддельная жирность не запрашивается ни у одной пиксельной гарнитуры", () => {
  // В файле одно начертание. Всё выше 400 браузер подделает размазыванием,
  // что на жёстких пиксельных краях читается как дефект отрисовки.
  for (const rule of rules) {
    if (!pixelSelectors.has(rule.selector)) continue;
    const weight = declaration(rule.body, "font-weight");
    if (weight === null) continue;
    assert.ok(Number.parseInt(weight, 10) <= 400, `${rule.selector}: font-weight ${weight}`);
  }
});

test("убранная гарнитура больше нигде не упоминается", () => {
  for (const gone of ["--display", "Koganejidainogemu", "PB Pixel", "Silkscreen", "Pixelify"]) {
    assert.ok(!css.includes(gone), `стили всё ещё ссылаются на ${gone}`);
    const html = readFileSync(join(web, "index.html"), "utf8");
    assert.ok(!html.includes(gone), `разметка всё ещё ссылается на ${gone}`);
  }
});
