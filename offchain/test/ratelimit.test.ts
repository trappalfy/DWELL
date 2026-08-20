import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/api/ratelimit.ts";

const T0 = 1_787_000_000_000;

test("пропускает в пределах ёмкости", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerMs: 1 / 1_000 });
  assert.equal(limiter.check("a", T0), true);
  assert.equal(limiter.check("a", T0), true);
  assert.equal(limiter.check("a", T0), true);
});

test("отсекает при исчерпании", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1 / 1_000 });
  limiter.check("a", T0);
  limiter.check("a", T0);
  assert.equal(limiter.check("a", T0), false);
});

test("ведро наполняется со временем", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1 / 1_000 });
  limiter.check("a", T0);
  limiter.check("a", T0);
  assert.equal(limiter.check("a", T0 + 999), false);
  assert.equal(limiter.check("a", T0 + 1_000), true);
});

test("ключи независимы", () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerMs: 1 / 1_000 });
  assert.equal(limiter.check("a", T0), true);
  assert.equal(limiter.check("b", T0), true);
  assert.equal(limiter.check("a", T0), false);
});

test("ведро не переполняется сверх ёмкости", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1 / 1_000 });
  limiter.check("a", T0);
  // Долгая пауза не должна накопить больше, чем вмещает ведро
  assert.equal(limiter.check("a", T0 + 1_000_000), true);
  assert.equal(limiter.check("a", T0 + 1_000_000), true);
  assert.equal(limiter.check("a", T0 + 1_000_000), false);
});
