import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mamcp-child-"));
process.env.MAMCP_ALLOWLIST = path.join(dir, "allow.json");
const { Runner } = await import("../src/runner.mjs");
const { loadConfig } = await import("../src/config.mjs");
const { RunLog } = await import("../src/runlog.mjs");
const { ChildControl } = await import("../src/child-control/control.mjs");
const { AgentRegistry, AgentLimitReached } = await import("../src/child-control/registry.mjs");
const { statusFromEvent, isFinal } = await import("../src/child-control/status.mjs");
const { Mailboxes } = await import("../src/child-control/mailbox.mjs");
const { StatusChannel } = await import("../src/child-control/watch.mjs");
const { AgentRuntime } = await import("../src/child-control/runtime.mjs");
after(() => rmSync(dir, { recursive: true, force: true }));

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, label = "条件") {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`${label}を満たしません`);
}

// ---- 移植した部品の単体試験（原典の挙動） ----
test("registry: 上限で予約を拒否し、未確定予約の破棄と登録解除で件数を戻す", () => {
  const registry = new AgentRegistry();
  const a = registry.reserveSpawnSlot(2);
  const b = registry.reserveSpawnSlot(2);
  assert.throws(() => registry.reserveSpawnSlot(2), AgentLimitReached);
  b.abandon();
  b.abandon(); // 二重破棄で件数を壊さない
  assert.equal(registry.total, 1);
  a.commit({ agentId: "x" });
  a.abandon(); // 確定後の破棄は無効
  assert.equal(registry.total, 1);
  registry.releaseSpawnedThread("x");
  registry.releaseSpawnedThread("x");
  assert.equal(registry.total, 0);
});

test("status: イベントから状態を導き、Interruptedは非終端", () => {
  assert.equal(statusFromEvent({ type: "turn_started" }).status, "running");
  assert.equal(statusFromEvent({ type: "turn_completed", error: "x" }).status, "errored");
  assert.equal(statusFromEvent({ type: "turn_aborted", reason: "interrupted" }).status, "interrupted");
  assert.equal(statusFromEvent({ type: "turn_aborted", reason: "other" }).status, "errored");
  assert.equal(statusFromEvent({ type: "item_completed" }), null);
  assert.equal(isFinal("interrupted"), false);
  assert.equal(isFinal("completed"), true);
  assert.equal(isFinal("shutdown"), true);
});

test("mailbox: 受信待ちを起こし、閉鎖後の投入を拒否する", async () => {
  const boxes = new Mailboxes();
  const waiting = boxes.changed("p");
  boxes.enqueue("p", [{ id: 1 }, { id: 2 }]);
  assert.equal(await waiting, true);
  assert.deepEqual(boxes.take("p", m => m.id === 1), [{ id: 1 }]);
  assert.equal(boxes.hasMail("p"), true);
  boxes.close();
  assert.throws(() => boxes.enqueue("p", [{ id: 3 }]));
});

test("watch: 初期スナップショットの後は変化を合成して最新値だけ返す", async () => {
  const channel = new StatusChannel("a");
  const iterator = channel.subscribe();
  assert.equal((await iterator.next()).value, "a");
  channel.set("b"); channel.set("c");
  assert.equal((await iterator.next()).value, "c");
  channel.close();
  assert.equal((await iterator.next()).done, true);
});

test("runtime: 遮断後は開始を拒否し、後片付けの放棄を報告する", async () => {
  const runtime = new AgentRuntime();
  const member = runtime.admitStart();
  const guard = member.teardownGuard("stop_child", "id");
  runtime.requestShutdown();
  assert.throws(() => runtime.admitStart(), /終了中/);
  const waiting = runtime.wait();
  guard.finish(); // complete()せずに終了 → guard_abandoned
  const report = await waiting;
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].reason, "guard_abandoned");
});

// ---- 子制御と実行アダプター契約の試験（異なる2種の偽実行先） ----
function permit() {
  writeFileSync(process.env.MAMCP_ALLOWLIST, JSON.stringify({ providers: {
    alpha: { models: { m1: { efforts: ["low", "high"] }, m2: { efforts: ["low"] } } },
    beta: { models: { m1: { efforts: ["low"] }, m2: { efforts: ["low"] } } },
  } }));
}

/**
 * alpha: Codex型（ターンID付き通知、モデル/Effort切替可、interruptに従う）
 * beta : Claude型（モデル切替不可、hang=trueのターンはinterruptを無視して強制終了が必要）
 */
function fakeProvider(kind, log) {
  return {
    type: kind, capabilities: { tools: true, fileAccess: true, executionControl: "provider-native", jsonSchema: true,
      permissions: ["full-access", "read-only", "workspace-write"] },
    available: async () => ({ ok: true }),
    run: async ({ prompt, permission }) => { log.runs.push({ prompt, permission }); return { ok: true, text: `replay:${prompt.length}` }; },
    openSession: async ({ model, effort, permission, cwd }) => {
      const session = { id: ++log.opened, inputs: [], closed: false, turns: 0 };
      log.sessions.push(session);
      let active = null, previousTurnId = null;
      return {
        capabilities: { nativeContinuation: true, modelSwitch: kind === "alpha", effortSwitch: kind === "alpha",
          jsonSchema: "native", persistence: "none" },
        effective: { model, effort, permission, cwd },
        async turn({ turnId, prompt, model: m, signal, onEvent, interruptGraceMs }) {
          assert.equal(active, null, "アダプターへ同時ターンが渡された");
          session.inputs.push(prompt);
          session.turns++;
          if (prompt.includes("CLOSEFAIL")) session.failClose = 1; // 次のcloseを1回だけ失敗させる
          // 前ターンの遅延通知（新ターンを完了させてはいけない）
          if (previousTurnId) onEvent({ turnId: previousTurnId, type: "turn_completed", lastMessage: "LATE" });
          onEvent({ turnId, type: "turn_started" });
          const hang = prompt.includes("HANG"), block = prompt.includes("BLOCK");
          active = turnId;
          try {
            if (hang || block) {
              const stopped = await new Promise(resolve => {
                // blockはinterruptに従い、hangは無視するため猶予後に強制終了される（awaitTurnと同じ順序）
                const onAbort = () => hang ? setTimeout(() => resolve("timeout-kill"), interruptGraceMs) : resolve("interrupted");
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
              });
              if (stopped === "interrupted") {
                onEvent({ turnId, type: "turn_aborted", reason: "interrupted" });
                return { ok: false, aborted: true, error: "中断" };
              }
              session.killed = true;
              return { ok: false, aborted: true, broken: "停止せず強制終了", error: "強制終了" };
            }
            onEvent({ turnId, type: "turn_completed", lastMessage: "ok" });
            return { ok: true, text: `${kind}:${session.id}:${session.turns}:${m}`, usage: {}, modelUsed: m, effective: { model: m } };
          } finally { previousTurnId = turnId; active = null; }
        },
        async close() {
          if (session.failClose > 0) { session.failClose--; throw new Error("close failed"); }
          session.closed = true;
        },
      };
    },
  };
}

function setupControl({ maxLiveSessions = 2, maxConcurrent = 2, interruptGraceMs = 50 } = {}) {
  permit();
  const cfg = loadConfig();
  cfg.dataDir = path.join(dir, `state-${Math.random()}`);
  cfg.policy.maxConcurrent = maxConcurrent;
  const log = { runs: [], sessions: [], opened: 0 };
  const providers = { alpha: fakeProvider("alpha", log), beta: fakeProvider("beta", log) };
  const registry = {
    get: id => { if (!providers[id]) throw new Error("unknown"); return providers[id]; },
    findModel: async (_p, id) => ({ model: { id, efforts: ["low", "high"] }, error: null }),
  };
  const runner = new Runner(cfg, registry, new RunLog(path.join(dir, `logs-${Math.random()}`)));
  const control = new ChildControl(runner, { maxLiveSessions, interruptGraceMs,
    waitTimeouts: { minMs: 10, defaultMs: 1000, maxMs: 5000 } });
  const cwd = mkdtempSync(path.join(dir, "work-"));
  return { control, runner, log, cwd };
}
const base = (cwd, extra = {}) => ({ provider: "alpha", model: "m1", effort: "low", task: "T1", cwd, ...extra });

test("native継続: 同じ子へ新しい入力だけを送り、過去入力を再送しない（両実行先）", async () => {
  for (const provider of ["alpha", "beta"]) {
    const { control, log, runner, cwd } = setupControl();
    const first = control.start(base(cwd, { provider, task: "FIRST_INPUT" }));
    assert.equal(first.mode, "native");
    const r1 = await control.wait(first.jobId);
    assert.equal(r1.status, "succeeded", r1.error);
    assert.equal(r1.permission, "full-access");
    const second = control.start(base(cwd, { provider, task: "SECOND_INPUT", conversation_id: first.conversationId }));
    const r2 = await control.wait(second.jobId);
    assert.equal(r2.status, "succeeded", r2.error);
    assert.equal(r2.output, `${provider}:1:2:m1`); // 同じセッション1の2ターン目
    assert.equal(log.opened, 1);
    assert.doesNotMatch(log.sessions[0].inputs[1], /FIRST_INPUT/);
    assert.match(log.sessions[0].inputs[1], /SECOND_INPUT/);
    assert.equal(log.runs.length, 0, "単発CLI経路を使っていない");
    // 遅延通知は破棄され、状態は最新ターンの完了のまま
    const agent = control.agents.get(first.conversationId);
    assert.ok(agent.droppedLateEvents >= 1);
    assert.equal(control.get(second.jobId).agentStatus, "completed");
    assert.equal(runner.coordinator.status().occupied, 0);
    assert.equal(runner.coordinator.status().queued, 0);
    const closed = await control.close(first.conversationId);
    assert.equal(closed.session, "terminated");
    assert.equal(log.sessions[0].closed, true);
    assert.equal(control.registry.total, 0);
  }
});

test("同時ターン・provider/cwd/権限/隔離方式の変更を拒否し、未対応のモデル切替も拒否する", async () => {
  const { control, cwd } = setupControl();
  const first = control.start(base(cwd, { provider: "beta", task: "BLOCK" }));
  await until(() => control.get(first.jobId).agentStatus === "running", "実行中");
  assert.throws(() => control.start(base(cwd, { provider: "beta", conversation_id: first.conversationId })), /実行中/);
  control.cancel(first.jobId);
  await control.wait(first.jobId);
  const id = first.conversationId;
  const other = mkdtempSync(path.join(dir, "other-"));
  assert.throws(() => control.start(base(cwd, { conversation_id: id })), /provider\/cwd/);
  assert.throws(() => control.start(base(other, { provider: "beta", conversation_id: id })), /provider\/cwd/);
  assert.throws(() => control.start(base(cwd, { provider: "beta", permission: "read-only", conversation_id: id })), /権限/);
  assert.throws(() => control.start(base(cwd, { provider: "beta", isolation: "brokered", permission: "read-only", conversation_id: id })), /隔離方式/);
  assert.throws(() => control.start(base(cwd, { provider: "beta", model: "m2", conversation_id: id })), /モデル変更に未対応/);
  await control.close(id);
});

test("alphaは同じ会話でモデル/Effortを再検証のうえ切り替えられる", async () => {
  const { control, log, cwd } = setupControl();
  const first = control.start(base(cwd));
  await control.wait(first.jobId);
  const next = control.start(base(cwd, { model: "m2", conversation_id: first.conversationId }));
  const result = await control.wait(next.jobId);
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.output, "alpha:1:2:m2");
  const rejected = control.start(base(cwd, { model: "m2", effort: "high", conversation_id: first.conversationId }));
  assert.equal((await control.wait(rejected.jobId)).status, "rejected"); // m2/highは未許可
  assert.equal(log.sessions[0].turns, 2);
  await control.close(first.conversationId);
});

test("取消: 停止確認後に枠を返し会話は継続可能。停止しない子は強制終了して当該会話だけ継続不能にする", async () => {
  const { control, runner, log, cwd } = setupControl();
  const a = control.start(base(cwd, { task: "BLOCK" }));
  const b = control.start(base(cwd, { provider: "beta", task: "HANG" }));
  await until(() => control.get(a.jobId).agentStatus === "running" && control.get(b.jobId).agentStatus === "running", "両方実行中");
  const cancelA = control.cancel(a.jobId);
  assert.equal(cancelA.requested, true);
  assert.equal(control.get(a.jobId).status, "cancelling");
  assert.equal((await control.wait(a.jobId)).status, "cancelled");
  assert.equal(control.get(b.jobId).status, "running", "他の子へ波及しない");
  control.cancel(b.jobId);
  assert.equal(runner.coordinator.status().occupied, 1, "停止確認前に枠を返さない");
  const rb = await control.wait(b.jobId);
  assert.equal(rb.status, "cancelled");
  assert.equal(log.sessions[1].killed, true);
  assert.throws(() => control.start(base(cwd, { provider: "beta", conversation_id: b.conversationId })), /継続できません/);
  const again = control.start(base(cwd, { task: "after cancel", conversation_id: a.conversationId }));
  assert.equal((await control.wait(again.jobId)).status, "succeeded");
  assert.equal(control.cancel(again.jobId).requested, false); // 終了済みへの取消は何もしない
  assert.equal(runner.coordinator.status().occupied, 0);
  assert.equal(control.registry.total, 1, "壊れた会話のプロセスは停止済みで枠を返した");
});

test("timeoutはユーザー取消と区別し、待機時間込みの期限を延長しない", async () => {
  const { control, runner, cwd } = setupControl();
  const job = control.start(base(cwd, { task: "BLOCK", timeout_ms: 60 }));
  const result = await control.wait(job.jobId);
  assert.equal(result.status, "timeout");
  assert.equal(control.get(job.jobId).agentStatus, "interrupted");
  assert.equal(runner.coordinator.status().occupied, 0);
});

test("常駐上限では使われていない最古の会話の子プロセスを解放して受け付け、全て実行中なら拒否する", async () => {
  const { control, log, cwd } = setupControl({ maxLiveSessions: 1 });
  const first = control.start(base(cwd));
  await control.wait(first.jobId);
  // 閉じ忘れても止まらない: 待機中の最古の会話を解放して新しい会話を開始する
  const second = control.start(base(cwd, { task: "BLOCK" }));
  await until(() => control.get(second.jobId).agentStatus === "running", "実行中");
  assert.equal(log.sessions[0].closed, true, "解放した子プロセスは停止する");
  assert.equal(control.registry.total, 1, "常駐数は上限を超えない");
  assert.equal(control.status().evictions, 1);
  assert.throws(() => control.start(base(cwd, { conversation_id: first.conversationId })), /解放しました/);
  // 全て実行中なら空けずに拒否する
  const full = control.start(base(cwd));
  const fr = await control.wait(full.jobId);
  assert.equal(fr.status, "failed");
  assert.match(fr.error, /上限/);
  assert.equal(control.registry.total, 1);
  // 検証で拒否される要求のために待機中の会話を解放しない
  control.cancel(second.jobId); await control.wait(second.jobId); // 実行中を待機中にする
  const keep = control.start(base(cwd, { task: "K" }));
  assert.equal((await control.wait(keep.jobId)).status, "succeeded");
  const evictionsBefore = control.status().evictions;
  const bad = control.start(base(cwd, { model: "not-allowed" }));
  assert.equal((await control.wait(bad.jobId)).status, "rejected");
  assert.equal(control.status().evictions, evictionsBefore, "拒否される要求で解放しない");
  // 制限権限（replay）は常駐しないため上限の対象外
  const restricted = control.start(base(cwd, { permission: "read-only" }));
  assert.equal(restricted.mode, "replay");
  await control.wait(restricted.jobId);
  const third = control.start(base(cwd));
  assert.equal((await control.wait(third.jobId)).status, "succeeded");
  assert.equal(control.registry.total, 1);
  await control.shutdown();
});

test("一定時間使われていない常駐プロセスは解放し、終わったジョブは古い順に捨てて受付を止めない", async () => {
  const { control, log, cwd } = setupControl({ maxLiveSessions: 6 });
  const first = control.start(base(cwd));
  await control.wait(first.jobId);
  await control.evictIdle(Date.now() + control.idleSessionMs + 1);
  await Promise.allSettled([...control.closingSessions]);
  assert.equal(log.sessions[0].closed, true);
  assert.equal(control.registry.total, 0);
  assert.equal(control.conversations()[0].evicted, true);
  control.maxJobs = 3;
  const ids = [];
  for (let i = 0; i < 6; i++) { const j = control.start(base(cwd, { permission: "read-only", task: `J${i}` })); ids.push(j.jobId); await control.wait(j.jobId); }
  assert.ok(control.jobs.size <= 3, `保持ジョブ ${control.jobs.size}`);
  assert.ok(control.jobs.has(ids.at(-1)), "最新の結果は残る");
  assert.ok(!control.jobs.has(ids[0]), "古い結果から捨てる");
  await control.shutdown();
});

test("開始できなかったnative会話は常駐枠を返す（原典のSpawnReservation破棄）", async () => {
  const { control, cwd } = setupControl({ maxLiveSessions: 1 });
  const rejected = control.start(base(cwd, { model: "not-allowed" }));
  assert.equal((await control.wait(rejected.jobId)).status, "rejected");
  assert.equal(control.registry.total, 0);
  const ok = control.start(base(cwd));
  assert.equal((await control.wait(ok.jobId)).status, "succeeded");
});

test("制限権限は既存の単発実行＋明示した履歴再送で継続する", async () => {
  const { control, log, cwd } = setupControl();
  const first = control.start(base(cwd, { permission: "workspace-write", task: "FIRST_MARKER" }));
  await control.wait(first.jobId);
  const second = control.start(base(cwd, { permission: "workspace-write", task: "SECOND", conversation_id: first.conversationId }));
  await control.wait(second.jobId);
  assert.equal(log.opened, 0);
  assert.match(log.runs[1].prompt, /FIRST_MARKER/);
  assert.equal(log.runs[1].permission, "workspace-write");
});

test("wait_agents: 終了で戻り、timeoutをmin/maxで補正し、終了済みなら即時に戻る", async () => {
  const { control, cwd } = setupControl();
  const blocked = control.start(base(cwd, { task: "BLOCK" }));
  await until(() => control.get(blocked.jobId).agentStatus === "running", "実行中");
  const timedOut = await control.waitAny({ job_ids: [blocked.jobId], timeout_ms: 1 });
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.message, /補正/);
  await assert.rejects(control.waitAny({ timeout_ms: 999999 }), /以下/);
  const waiting = control.waitAny({ job_ids: [blocked.jobId], timeout_ms: 2000 });
  control.cancel(blocked.jobId);
  const done = await waiting;
  assert.equal(done.timedOut, false);
  assert.equal(done.jobs[0].status, "cancelled");
  const again = await control.waitAny({ job_ids: [blocked.jobId], timeout_ms: 2000 });
  assert.equal(again.timedOut, false);
  const any = control.start(base(cwd, { conversation_id: blocked.conversationId }));
  const anyDone = await control.waitAny({ timeout_ms: 2000 });
  assert.ok(anyDone.completed.some(n => n.jobId === any.jobId));
});

test("shutdown: 新規受付を遮断し、実行中を停止確認してから全セッションを閉じる", async () => {
  const { control, runner, log, cwd } = setupControl();
  const idle = control.start(base(cwd));
  await control.wait(idle.jobId);
  const busy = control.start(base(cwd, { provider: "beta", task: "BLOCK" }));
  await until(() => control.get(busy.jobId).agentStatus === "running", "実行中");
  const report = await control.shutdown();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(control.get(busy.jobId).status, "cancelled");
  assert.ok(log.sessions.every(s => s.closed));
  assert.equal(control.registry.total, 0);
  assert.throws(() => control.start(base(cwd)), /終了中/);
  assert.equal(runner.coordinator.status().occupied, 0);
  await tick();
});

// ---- 公開前レビューで見つかった不具合の回帰試験 ----
test("停止に失敗した会話は常駐枠を保持し、再closeで子を停止して枠を返す", async () => {
  const { control, log, cwd } = setupControl();
  const first = control.start(base(cwd, { task: "CLOSEFAIL" }));
  assert.equal((await control.wait(first.jobId)).status, "succeeded");
  assert.equal(control.registry.total, 1);
  const failed = await control.close(first.conversationId);
  assert.equal(failed.closed, false);
  assert.equal(failed.session, "failed");
  assert.equal(control.registry.total, 1, "停止未確認のまま枠を返さない");
  const retried = await control.close(first.conversationId);
  assert.equal(retried.closed, true, JSON.stringify(retried));
  assert.equal(retried.session, "terminated", "再closeで実際に停止を試みる");
  assert.equal(log.sessions[0].closed, true);
  assert.equal(control.registry.total, 0, "停止確認後に枠を返す");
  await control.shutdown();
});

test("同期実行(run)はwait_agents用の終了通知を積まず、古い通知でwaitAnyが即時に戻らない", async () => {
  const { control, cwd } = setupControl();
  const result = await control.run(base(cwd));
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(control.mailboxes.hasMail("root"), false);
  const waited = await control.waitAny({ timeout_ms: 30 });
  assert.equal(waited.timedOut, true);
  assert.deepEqual(waited.completed, []);
  await control.shutdown();
});

test("自動解放は停止確認まで常駐枠を保持し、新しい子を先に起動しない", async () => {
  const { control, log, cwd } = setupControl({ maxLiveSessions: 1 });
  const first = control.start(base(cwd));
  await control.wait(first.jobId);
  const agent = control.agents.get(first.conversationId);
  const original = agent.session.close;
  let unblock, closing;
  const started = new Promise(r => { closing = r; });
  const blocked = new Promise(r => { unblock = r; });
  agent.session.close = async () => { closing(); await blocked; await original(); };
  const second = control.start(base(cwd));
  await started;
  assert.equal(control.registry.total, 1);
  assert.equal(log.opened, 1, "停止確認前には次の子を起動しない");
  unblock();
  assert.equal((await control.wait(second.jobId)).status, "succeeded");
  assert.equal(log.sessions[0].closed, true);
  assert.equal(control.registry.total, 1);
  await control.shutdown();
});

test("自動解放の停止失敗は枠と再停止できる参照を保持する", async () => {
  const { control, log, cwd } = setupControl({ maxLiveSessions: 1 });
  const first = control.start(base(cwd, { task: "CLOSEFAIL" }));
  await control.wait(first.jobId);
  const second = control.start(base(cwd));
  assert.equal((await control.wait(second.jobId)).status, "failed");
  assert.equal(log.opened, 1);
  assert.equal(control.registry.total, 1);
  assert.equal((await control.close(first.conversationId)).closed, true);
  assert.equal(log.sessions[0].closed, true);
  assert.equal(control.registry.total, 0);
  await control.shutdown();
});

test("完了ジョブの破棄では対応する未読通知も破棄する", async () => {
  const { control, cwd } = setupControl();
  control.maxJobs = 1;
  const a = control.start(base(cwd));
  await control.wait(a.jobId);
  const b = control.start(base(cwd));
  await control.wait(b.jobId);
  const notices = control.mailboxes.take("root");
  assert.deepEqual(notices.map(n => n.jobId), [b.jobId]);
  await control.shutdown();
});
