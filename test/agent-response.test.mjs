import { test } from "node:test";
import assert from "node:assert/strict";
import { agentResult, agentState } from "../src/agent-response.mjs";

test("最終結果は状態・本文・エラー・警告を保持し、内部メタデータを既定で返さない", () => {
  for (const status of ["succeeded", "failed", "cancelled", "timeout", "rejected"]) {
    const full = { runId: "r", jobId: "j", conversationId: "c", status, output: "x".repeat(20000),
      error: "検証失敗", warnings: ["未確認"], usage: { tokens: 300 }, brokerSteps: ["途中試行"],
      effective: { permission: "full-access" }, unknownFutureField: "internal" };
    const compact = agentResult(full);
    assert.deepEqual(compact, { runId: "r", jobId: "j", conversationId: "c", status,
      output: full.output, error: "検証失敗", warnings: ["未確認"] });
    assert.deepEqual(agentResult(full, { include_details: true }), full);
    assert.equal(full.usage.tokens, 300);
  }
});

test("成功した構造化結果は二重掲載せず、失敗時の生出力は診断証拠として保持する", () => {
  const full = { status: "succeeded", output: '{"ok":true}', structured: { ok: true } };
  assert.deepEqual(agentResult(full), { status: "succeeded", structured: { ok: true } });
  assert.deepEqual(agentResult({ ...full, status: "failed", error: "schema" }),
    { ...full, status: "failed", error: "schema" });
  assert.equal(agentResult({ status: "succeeded", structured: null, output: "null" }).output, undefined);
  assert.equal(full.output, '{"ok":true}', "内部結果を改変しない");
});

test("実行中はID・状態だけを返し、詳細とイベントの指定は互いに独立する", () => {
  const state = { jobId: "j", conversationId: "c", status: "running", mode: "native",
    agentStatus: "running", events: [{ sequence: 1, stage: "running" }], lastSequence: 1 };
  assert.deepEqual(agentState(state), { jobId: "j", conversationId: "c", status: "running" });
  assert.deepEqual(agentState(state, { include_details: true }), {
    jobId: "j", conversationId: "c", status: "running", mode: "native", agentStatus: "running",
  });
  const events = agentState(state, { include_events: true });
  assert.deepEqual(events.events, state.events);
  assert.equal(events.lastSequence, 1);
  assert.equal(events.mode, undefined);
});

test("大量の途中イベントを保持しても既定応答は増えず、詳細は要求時に取得できる", t => {
  const state = { jobId: "j", conversationId: "c", status: "succeeded", mode: "native", agentStatus: "completed",
    lastSequence: 300, events: Array.from({ length: 300 }, (_, i) =>
      ({ sequence: i + 1, at: "2026-11-15T00:00:00.000Z", stage: "adapter:item_completed", item: "commandExecution" })),
    result: { status: "succeeded", output: "結論と検証結果", usage: { tokens: 1000 } } };
  const compact = JSON.stringify(agentState(state));
  assert.equal(compact, JSON.stringify(agentState({ ...state, events: [], lastSequence: 0 })));
  const detailed = JSON.stringify(agentState(state, { include_details: true, include_events: true }));
  assert.ok(detailed.length > compact.length * 10);
  assert.equal(state.events.length, 300);
  t.diagnostic(`UTF-8応答サイズ: 既定${Buffer.byteLength(compact)}B / 詳細+イベント${Buffer.byteLength(detailed)}B（トークン数ではない）`);
});
