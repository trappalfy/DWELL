import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EPOCH_SECONDS,
  BUCKET_SECONDS,
  BUCKETS_PER_EPOCH,
  epochOf,
  bucketOf,
  epochOfBucket,
  epochBucketRange,
  epochStart,
  epochEnd
} from "../src/epoch.ts";

test("константы соответствуют спецификации", () => {
  assert.equal(EPOCH_SECONDS, 300);
  assert.equal(BUCKET_SECONDS, 10);
  assert.equal(BUCKETS_PER_EPOCH, 30);
});

test("epochOf делит время на пятиминутки", () => {
  assert.equal(epochOf(0), 0);
  assert.equal(epochOf(299), 0);
  assert.equal(epochOf(300), 1);
  // Эпоха старта майнинга прототипа: 5955209 * 300 = 1786562700
  assert.equal(epochOf(1786562700), 5955209);
});

test("bucketOf делит время на десятисекундки", () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(9), 0);
  assert.equal(bucketOf(10), 1);
  assert.equal(bucketOf(1786562700), 178656270);
});

test("epochOfBucket согласован с epochOf", () => {
  for (const ts of [0, 7, 299, 300, 1786562700, 1787232900]) {
    assert.equal(epochOfBucket(bucketOf(ts)), epochOf(ts));
  }
});

test("epochBucketRange покрывает ровно 30 бакетов", () => {
  const { first, last } = epochBucketRange(5955209);
  assert.equal(last - first + 1, BUCKETS_PER_EPOCH);
  assert.equal(epochOfBucket(first), 5955209);
  assert.equal(epochOfBucket(last), 5955209);
  assert.equal(epochOfBucket(first - 1), 5955208);
  assert.equal(epochOfBucket(last + 1), 5955210);
});

test("границы эпохи полуоткрыты", () => {
  assert.equal(epochStart(1), 300);
  assert.equal(epochEnd(1), 600);
  assert.equal(epochOf(epochStart(1)), 1);
  assert.equal(epochOf(epochEnd(1) - 1), 1);
  assert.equal(epochOf(epochEnd(1)), 2);
});

test("отрицательное и дробное время отвергается", () => {
  assert.throws(() => epochOf(-1), /non-negative integer/);
  assert.throws(() => bucketOf(1.5), /non-negative integer/);
});
