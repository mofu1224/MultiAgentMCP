import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedEntry } from "../src/allowlist.mjs";

test("Objectの継承プロパティを許可済みモデルとみなさない", () => {
  const a = { providers: { sample: { models: {} } } };
  assert.equal(allowedEntry(a, "sample", "toString").allowed, false);
  assert.equal(allowedEntry(a, "sample", "constructor").allowed, false);
});

test("壊れた許可エントリーを全Effort許可へ読み替えない", () => {
  for (const entry of [true, "yes", {}, { efforts: null }, { efforts: [42] }])
    assert.equal(allowedEntry({ providers: { sample: { models: { model: entry } } } }, "sample", "model").allowed, false);
});
