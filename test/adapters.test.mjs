import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { openCodexSession, verifyThreadStart, threadStartParams, buildAppServerArgs, parseCodexMcpNames } from "../src/adapters/codex-app-server.mjs";
import { openClaudeSession, buildClaudeStreamArgs } from "../src/adapters/claude-stream.mjs";
import { awaitTurn } from "../src/adapters/session.mjs";

const fixture = name => path.resolve("test", "fixtures", name);
const codex = (extra = {}) => openCodexSession({ command: process.execPath, prefixArgs: [fixture("fake-app-server.mjs")],
  model: "m1", effort: "low", cwd: tmpdir(), permission: "full-access", ...extra });
const claude = (extra = {}) => openClaudeSession({ command: process.execPath, prefixArgs: [fixture("fake-claude-stream.mjs")],
  model: "c1", effort: "low", cwd: tmpdir(), permission: "full-access", ...extra });
const turn = (session, turnId, prompt, extra = {}) => {
  const events = [];
  return session.turn({ turnId, prompt, model: "m1", effort: "low", signal: new AbortController().signal,
    interruptGraceMs: 200, onEvent: e => events.push(e), ...extra }).then(r => ({ ...r, events }));
};

test("Codex起動引数: full-access・承認never・ephemeral・内部マルチエージェント無効", () => {
  const appArgs = buildAppServerArgs(["multi-agent", "windows-mcp"]);
  assert.deepEqual(appArgs.slice(0, 5), ["app-server", "-c", 'approval_policy="never"', "-c", "agents.enabled=false"]);
  for (const feature of ["plugins", "apps", "computer_use", "hooks"]) assert.equal(appArgs[appArgs.indexOf(feature) - 1], "--disable");
  assert.ok(appArgs.includes("notify=[]"));
  assert.ok(appArgs.includes("mcp_servers.multi-agent.enabled=false"), "子からmulti-agent自身を呼べない");
  assert.ok(appArgs.includes("mcp_servers.windows-mcp.enabled=false"));
  assert.throws(() => buildAppServerArgs(["a.b"]), /無効化できません/);
  assert.deepEqual(parseCodexMcpNames('[{"name":"github"},{"name":"a.b"},{"name":"github"}]'), ["github", "a.b"]);
  assert.throws(() => parseCodexMcpNames("{}"), /形式/);
  const p = threadStartParams({ model: "m", effort: "high", cwd: "C:\\w" });
  assert.equal(p.sandbox, "danger-full-access");
  assert.equal(p.approvalPolicy, "never");
  assert.equal(p.ephemeral, true);
  assert.equal(p.config.model_reasoning_effort, "high");
  const ok = verifyThreadStart({ model: "m", reasoningEffort: "high", sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", thread: { ephemeral: true } }, { model: "m", effort: "high" });
  assert.deepEqual(ok.problems, []);
  const bad = verifyThreadStart({ model: "x", reasoningEffort: "low", sandbox: { type: "readOnly" }, approvalPolicy: "on-request", thread: { ephemeral: false } }, { model: "m", effort: "high" });
  assert.equal(bad.problems.length, 5);
});

test("Claude起動引数: 永続化なし・bypassPermissions・空MCP（再委譲なし）・restrictedを使わない", () => {
  const args = buildClaudeStreamArgs({ model: "c", effort: "high" });
  for (const flag of ["--no-session-persistence", "--dangerously-skip-permissions", "--strict-mcp-config", "--input-format"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(!args.includes("--restricted"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
});

test("Codexアダプター: 同じプロセスで新入力だけを送り、遅延通知を前ターンとして返し、モデル切替を渡す", async () => {
  const session = await codex();
  try {
    assert.equal(session.effective.ephemeral, true);
    assert.equal(session.effective.sandbox, "dangerFullAccess");
    const r1 = await turn(session, "t1", "FIRST");
    assert.equal(r1.ok, true, r1.error);
    const r2 = await turn(session, "t2", "SECOND", { model: "m2", jsonSchema: { type: "object" } });
    assert.equal(r2.ok, true, r2.error);
    const out = JSON.parse(r2.text);
    assert.deepEqual(out.memory, ["FIRST", "SECOND"]); // 子プロセス側に文脈が残る
    assert.equal(out.inputItems, 1);
    assert.equal(out.model, "m2");
    assert.equal(out.schema, true);
    assert.ok(r2.events.some(e => e.turnId === "t1" && e.type === "late"), "前ターンの遅延通知は旧ターンIDで通知");
    assert.ok(r2.events.some(e => e.turnId === "t2" && e.type === "turn_completed"));
    assert.equal(r2.toolUsage.successfulShellCalls, 1);
  } finally { await session.close(); }
});

test("Codexアダプター: interruptで停止確認、停止しない場合は強制終了して継続不能を返す", async () => {
  const session = await codex();
  const ctrl = new AbortController();
  const hanging = turn(session, "t1", "HANG", { signal: ctrl.signal });
  await new Promise(r => setTimeout(r, 100));
  ctrl.abort();
  const r1 = await hanging;
  assert.equal(r1.aborted, true);
  assert.equal(r1.broken, undefined);
  assert.ok(r1.events.some(e => e.type === "turn_aborted"));
  const r2 = await turn(session, "t2", "AFTER");
  assert.equal(r2.ok, true, "取消後も同じ会話を継続できる");
  const ctrl2 = new AbortController();
  const ignoring = turn(session, "t3", "IGNORE", { signal: ctrl2.signal });
  await new Promise(r => setTimeout(r, 100));
  ctrl2.abort();
  const r3 = await ignoring;
  assert.equal(r3.aborted, true);
  assert.match(r3.broken, /強制終了/);
  await assert.rejects(turn(session, "t4", "X"), /終了/);
});

test("Codexアダプター: 実効モデルが要求と異なれば開始せず子を停止する", async () => {
  await assert.rejects(codex({ env: { FAKE_MODEL_OVERRIDE: "other" } }), /実効設定が要求と一致しません: model=other/);
  await assert.rejects(codex({ permission: "read-only" }), /full-access会話専用/);
});

test("Claudeアダプター: 同じプロセスで継続し、interruptと実効設定照合を行う", async () => {
  const session = await claude();
  try {
    const r1 = await turn(session, "t1", "FIRST", { model: "c1" });
    assert.equal(r1.ok, true, r1.error);
    assert.equal(session.effective.permissionMode, "bypassPermissions");
    const r2 = await turn(session, "t2", "SECOND", { model: "c1", jsonSchema: { type: "object" } });
    const out = JSON.parse(r2.text);
    assert.equal(out.memory.length, 2);
    assert.match(out.memory[1], /JSON Schema/); // 構造化指示を付けてRunnerで検証する
    assert.equal(out.noPersist, true);
    assert.equal(r2.toolUsage.successfulShellCalls, 1);
    // モデル切替はset_model→次ターンのinitで照合。modelUsageは累計なのでinitのモデルを返す。
    const switched = await turn(session, "t3", "X", { model: "c2" });
    assert.equal(switched.ok, true, switched.error);
    assert.equal(JSON.parse(switched.text).model, "c2");
    assert.equal(switched.modelUsed, "c2");
    assert.deepEqual(switched.modelsObserved, ["c1", "c2"]);
    assert.equal(session.effective.model, "c2");
    const refused = await turn(session, "t3b", "X", { model: "reject-me" });
    assert.equal(refused.ok, false);
    assert.equal(refused.broken, undefined, "切替拒否では会話を壊さない");
    assert.match((await turn(session, "t3c", "X", { model: "c2", effort: "high" })).error, /Effort変更に未対応/);
    const ctrl = new AbortController();
    const hanging = turn(session, "t4", "HANG", { model: "c2", signal: ctrl.signal });
    await new Promise(r => setTimeout(r, 100));
    ctrl.abort();
    const r4 = await hanging;
    assert.equal(r4.aborted, true);
    assert.equal(r4.broken, undefined);
  } finally { await session.close(); }
  const mismatch = await claude({ env: { FAKE_MODEL_OVERRIDE: "other" } });
  try {
    const r = await turn(mismatch, "t1", "FIRST", { model: "c1" });
    assert.equal(r.ok, false);
    assert.match(r.broken, /model=other/);
  } finally { await mismatch.close(); }
});

test("awaitTurn: 正常終了・中断・停止しない場合の強制終了を区別する", async () => {
  const done = await awaitTurn(Promise.resolve({ ok: true }), { interrupt() {}, kill() {} });
  assert.equal(done.ok, true);
  const ctrl = new AbortController();
  let killed = false;
  const stuck = awaitTurn(new Promise(() => {}), { signal: ctrl.signal, graceMs: 20, interrupt() {}, kill: async () => { killed = true; } });
  ctrl.abort();
  const r = await stuck;
  assert.equal(killed, true);
  assert.ok(r.broken);
});
