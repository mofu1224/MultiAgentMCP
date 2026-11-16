import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunLog } from "../src/runlog.mjs";

test("実行ログには本文・エラー本文・作業パス・未知のフィールドを保存しない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-log-"));
  try {
    const log = new RunLog(dir);
    log.append({
      runId: "test", rootId: "root", phase: "end", provider: "sample",
      modelUsed: "dynamic-model", status: "failed", ok: false, durationMs: 10,
      usage: { input_tokens: 42, debug: "PRIVATE" },
      taskPreview: "PRIVATE", outputPreview: "PRIVATE", error: "PRIVATE",
      cwd: "PRIVATE", arbitrary: "PRIVATE",
    });
    assert.equal(readFileSync(log.file, "utf8").includes("PRIVATE"), false);
    assert.equal(log.summary()[0].usage.input_tokens, 42);
    assert.equal(log.read()[0].status, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("実行ログは上限を超えると新しい側だけを残し、無制限に増えない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-log-"));
  try {
    const log = new RunLog(dir, { maxBytes: 2000 });
    for (let i = 0; i < 100; i++) log.append({ runId: `r${i}`, phase: "end", provider: "p", ok: true });
    assert.ok(statSync(log.file).size <= 2000);
    const ids = log.read().map(r => r.runId);
    assert.equal(ids.at(-1), "r99");
    assert.ok(!ids.includes("r0"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
