import { test } from "node:test";
import assert from "node:assert/strict";

test("ジョブを非同期開始し、会話履歴を次ターンへ渡し、同時ターンを拒否する", async () => {
  const { AgentManager } = await import("../src/agent-manager.mjs");
  let release, received;
  const runner = {
    run: async (req, { onProgress }) => {
      received = req;
      onProgress?.({ stage: "running" });
      await new Promise(resolve => { release = resolve; });
      return { runId: "engine-run", status: "succeeded", output: "previous-answer" };
    },
  };
  const manager = new AgentManager(runner);
  const req = { provider: "test", model: "m", effort: "deep", permission: "read-only", task: "first" };
  const first = manager.start(req);
  assert.equal(manager.get(first.jobId).status, "running");
  assert.throws(() => manager.start({ ...req, conversation_id: first.conversationId }), /実行中/);
  release();
  const result = await manager.wait(first.jobId);
  assert.equal(result.status, "succeeded");
  const second = manager.start({ ...req, task: "second", conversation_id: first.conversationId });
  assert.match(received.context, /first/);
  assert.match(received.context, /previous-answer/);
  assert.equal(received.task, "second");
  assert.ok(manager.get(second.jobId).events.some(e => e.stage === "running"));
  release();
  await manager.wait(second.jobId);
  assert.deepEqual(manager.list().map(j => j.status), ["succeeded", "succeeded"]);
  manager.close(first.conversationId);
  assert.throws(() => manager.start({ ...req, conversation_id: first.conversationId }), /会話/);
});

test("取消をsignalへ渡し、メモリ内の結果を返す", async () => {
  const { AgentManager } = await import("../src/agent-manager.mjs");
  const manager = new AgentManager({
    run: async (_req, { signal }) => {
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      return { status: "cancelled", output: "" };
    },
  });
  const job = manager.start({ task: "wait" });
  assert.equal(manager.cancel(job.jobId).requested, true);
  assert.equal((await manager.wait(job.jobId)).status, "cancelled");
  assert.equal(manager.cancel(job.jobId).requested, false);
});

test("履歴上限を超えた会話を無履歴で暗黙継続しない", async () => {
  const { AgentManager } = await import("../src/agent-manager.mjs");
  const manager = new AgentManager({
    run: async () => ({ status: "succeeded", output: "x".repeat(100) }),
  }, { maxContextChars: 50 });
  const first = manager.start({ task: "first" });
  await manager.wait(first.jobId);
  assert.throws(() => manager.start({ task: "second", conversation_id: first.conversationId }), /上限/);
});

test("追加入力へ初回の役割・コンテキストも引き継ぐ", async () => {
  const { AgentManager } = await import("../src/agent-manager.mjs");
  let received;
  const manager = new AgentManager({ run: async req => {
    received = req;
    return { status: "succeeded", output: "ok" };
  } });
  const first = manager.start({ task: "first", role: "ROLE_MARKER", context: "CONTEXT_MARKER" });
  await manager.wait(first.jobId);
  const second = manager.start({ task: "second", conversation_id: first.conversationId });
  await manager.wait(second.jobId);
  assert.match(received.context, /ROLE_MARKER/);
  assert.match(received.context, /CONTEXT_MARKER/);
});

test("実行器が組み立てた添付ファイル込みのプロンプトを会話へ保持する", async () => {
  const { AgentManager } = await import("../src/agent-manager.mjs");
  let received;
  const manager = new AgentManager({ run: async (req, { onPrepared }) => {
    received = req;
    onPrepared?.("ACTUAL_FILE_SNAPSHOT");
    return { status: "succeeded", output: "ok" };
  } });
  const first = manager.start({ task: "first" });
  await manager.wait(first.jobId);
  const second = manager.start({ task: "second", conversation_id: first.conversationId });
  await manager.wait(second.jobId);
  assert.match(received.context, /ACTUAL_FILE_SNAPSHOT/);
});

test("brokered会話の継続で隔離指定を落として通常CLIへ緩和しない", async () => {
  const { AgentManager } = await import("../src/agent-manager.mjs");
  const manager = new AgentManager({ run: async () => ({ status: "succeeded", output: "ok" }) });
  const first = manager.start({ task: "first", isolation: "brokered" });
  await manager.wait(first.jobId);
  assert.throws(() => manager.start({ task: "second", conversation_id: first.conversationId }), /隔離方式/);
});
