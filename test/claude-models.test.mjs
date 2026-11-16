import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeModels } from "../src/providers/claude-models.mjs";

test("初期化応答の正式IDとモデル別Effortを使い、defaultと重複を除く", () => {
  const row = (value, resolvedModel, levels) => ({
    value, resolvedModel, displayName: value, supportedEffortLevels: levels, supportsEffort: true,
  });
  const stdout = JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: "models", response: { models: [
      row("default", "current-model", ["small"]),
      row("family", "current-model", ["small", "larger"]),
      row("current-model", "current-model", ["small", "larger"]),
      row("other[1m]", "other", ["deep"]),
      { value: "fast", resolvedModel: "fast-current", supportsEffort: false },
    ] },
  } });
  const models = parseClaudeModels(stdout, "models");
  assert.deepEqual(models.map(m => m.id), ["current-model", "other[1m]", "fast-current"]);
  assert.deepEqual(models.map(m => m.efforts), [["small", "larger"], ["deep"], []]);
});

test("初期化失敗やモデル一覧欠落を古い別名で補わずエラーにする", () => {
  assert.throws(() => parseClaudeModels("{}", "models"), /初期化/);
  assert.throws(() => parseClaudeModels(JSON.stringify({
    type: "control_response", response: { request_id: "models", subtype: "error", error: "failed" },
  }), "models"), /failed/);
});
