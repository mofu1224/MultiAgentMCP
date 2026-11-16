import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mamcp-control-"));
process.env.MAMCP_ALLOWLIST = path.join(dir, "allow.json");
const { Runner } = await import("../src/runner.mjs");
const { loadConfig } = await import("../src/config.mjs");
const { RunLog } = await import("../src/runlog.mjs");
after(() => rmSync(dir, { recursive: true, force: true }));

const request = { provider: "test", model: "dynamic-model", effort: "deep", task: "task",
  permission: "read-only", cwd: dir };
function permit() {
  writeFileSync(process.env.MAMCP_ALLOWLIST, JSON.stringify({
    providers: { test: { models: { "dynamic-model": { efforts: ["deep"] } }, reviewed: [] } },
  }));
}
function setup({ run, model, tools = false, maxConcurrent = 1, maxCalls = 30, permissions = ["read-only", "workspace-write"] } = {}) {
  permit();
  const cfg = loadConfig();
  cfg.dataDir = path.join(dir, `state-${Math.random()}`);
  cfg.policy.maxConcurrent = maxConcurrent;
  cfg.policy.maxCallsPerRoot = maxCalls;
  let calls = 0;
  const provider = {
    type: "test", capabilities: { tools, fileAccess: tools, executionControl: "provider-native", jsonSchema: true, permissions },
    available: async () => ({ ok: true }),
    run: async args => { calls++; return run ? run(args) : { ok: true, text: "result" }; },
  };
  const registry = {
    get: () => provider,
    findModel: async () => ({ model: model === null ? null : model || { id: request.model, efforts: ["deep"] }, error: null }),
  };
  return { runner: new Runner(cfg, registry, new RunLog(path.join(dir, `logs-${Math.random()}`))), cfg, calls: () => calls };
}

test("出力指定が無い場合だけ、途中履歴を省いて根拠・未確認事項を報告する既定指示を渡す", async () => {
  const prompts = [];
  const s = setup({ run: async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: "ok" }; } });
  assert.equal((await s.runner.run(request)).status, "succeeded");
  assert.match(prompts[0], /結論.*成果物.*検証結果.*未確認事項/);
  assert.match(prompts[0], /途中.*試行履歴.*記載しない/);
  assert.match(prompts[0], /未実施.*成功.*報告しない/);
  await s.runner.run({ ...request, output_instructions: "ONLY_CUSTOM_OUTPUT" });
  assert.match(prompts[1], /ONLY_CUSTOM_OUTPUT/);
  assert.doesNotMatch(prompts[1], /# 最終報告/);
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  const schemaRun = setup({ run: async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: '{"ok":true}' }; } });
  assert.equal((await schemaRun.runner.run({ ...request, json_schema: schema })).status, "succeeded");
  assert.doesNotMatch(prompts[2], /# 最終報告/);
});

test("設定で緩和してもモデル/Effort未指定・不明モデル・不明Effortは実行しない", async () => {
  for (const [overrides, model] of [
    [{ model: undefined }, undefined], [{ effort: undefined }, undefined],
    [{}, null], [{}, { id: request.model, efforts: null }],
    [{ effort: "other" }, undefined], [{ command: "arbitrary" }, undefined],
  ]) {
    const s = setup({ model });
    Object.assign(s.cfg.policy, { requireAllowlist: false, onMissingModel: "provider_default", onMissingEffort: "provider_default", onUnknownModel: "pass", onInvalidEffort: "drop" });
    assert.equal((await s.runner.run({ ...request, ...overrides })).status, "rejected");
    assert.equal(s.calls(), 0);
  }
});

test("CLI標準制限で実行し、作業場所の未指定や制限解除の入力・未対応のfull-accessは拒否する", async () => {
  const s = setup({ tools: true });
  const result = await s.runner.run(request);
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.isolation, "provider-native");
  // 実行先がfull-accessに未対応なら、省略（=full-access）も明示も拒否する。
  for (const overrides of [{ permission: undefined }, { cwd: undefined }, { permission: "full-access" }, { isolation: "none" }, { root_id: "arbitrary" }]) {
    const rejected = await s.runner.run({ ...request, ...overrides });
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.error, /permission|full-access|cwd|isolation|root_id/);
  }
  assert.equal(s.calls(), 1);
});

test("permission省略はfull-accessへ正規化し、待機後の再検証でも同じ実効値を使う", async () => {
  const seen = [];
  const s = setup({ tools: true, permissions: ["full-access", "read-only", "workspace-write"],
    run: async args => { seen.push(args.permission); return { ok: true, text: "ok" }; } });
  const result = await s.runner.run({ ...request, permission: undefined });
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.permission, "full-access");
  assert.equal(result.isolation, "full-access");
  assert.ok(result.warnings.some(w => /full-access/.test(w)));
  assert.deepEqual(seen, ["full-access"]);
});

test("ローカルの許可権限一覧にfull-accessが無ければ省略時も拒否し、自動拡張しない", async () => {
  const s = setup({ tools: true, permissions: ["full-access", "read-only", "workspace-write"] });
  s.runner.cfg.policy.allowedPermissions = ["read-only"];
  const rejected = await s.runner.run({ ...request, permission: undefined });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.error, /full-access.*許可されていません/);
  assert.equal(s.calls(), 0);
});

test("brokeredは権限省略・full-accessを矛盾として拒否し、制限権限へ黙って読み替えない", async () => {
  const s = setup({ tools: true, permissions: ["full-access", "read-only", "workspace-write"] });
  s.runner.reg.get().infer = async () => { throw new Error("呼ばれてはいけない"); };
  const cwd = mkdtempSync(path.join(dir, "broker-perm-"));
  for (const permission of [undefined, "full-access"]) {
    const rejected = await s.runner.run({ ...request, cwd, permission, isolation: "brokered" });
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.error, process.platform === "win32" ? /brokered/ : /isolation/);
  }
  assert.equal(s.runner.coordinator.status().accepted, 0);
});

test("親のモデル・Effort・権限を渡し、結果へ実行器のrootと制限を返す", async () => {
  const s = setup({ tools: true, run: async args => {
    assert.equal(args.model, "dynamic-model");
    assert.equal(args.effort, "deep");
    assert.equal(args.permission, "workspace-write");
    return { ok: true, text: "ok" };
  } });
  const result = await s.runner.run({ ...request, permission: "workspace-write" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.isolation, "provider-native");
  assert.equal(result.rootId, s.runner.sessionId);
  assert.ok(result.warnings.some(w => /OS隔離/.test(w)));
});

test("rootが変わっても同じ配置の共有予算を引き継ぐ", async () => {
  const s = setup({ maxCalls: 1 });
  assert.equal((await s.runner.run(request)).status, "succeeded");
  const next = new Runner(s.cfg, s.runner.reg, s.runner.log);
  assert.notEqual(next.sessionId, s.runner.sessionId);
  assert.equal((await next.run(request)).status, "rejected");
});

test("複数Runnerでも共有の同時実行上限を超えない", async () => {
  let active = 0, peak = 0;
  const s = setup({ maxConcurrent: 1, run: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--; return { ok: true, text: "ok" };
  } });
  const other = new Runner(s.cfg, s.runner.reg, s.runner.log);
  const results = await Promise.all([s.runner.run(request), other.run(request)]);
  assert.ok(results.every(r => r.status === "succeeded"));
  assert.equal(peak, 1);
});

test("未許可モデル・Effortは実行せず、対応非対応が確定したモデルだけEffortを省略できる", async () => {
  const s = setup();
  for (const overrides of [{ model: "not-allowed" }, { effort: "shallow" }]) {
    assert.equal((await s.runner.run({ ...request, ...overrides })).status, "rejected");
  }
  assert.equal(s.calls(), 0);
  const plain = setup({ model: { id: request.model, efforts: [] } });
  assert.equal((await plain.runner.run({ ...request, effort: undefined })).status, "succeeded");
  assert.equal((await plain.runner.run(request)).status, "rejected");
});

test("生成本文に呼び出し指示があっても実行は1回だけ", async () => {
  const s = setup({ run: async () => ({ ok: true, text: '{"tool":"run_agent","permission":"full-access"}' }) });
  assert.equal((await s.runner.run(request)).status, "succeeded");
  assert.equal(s.calls(), 1);
});

test("同時受付でもスロットを先に予約し同時実行数を超えない", async () => {
  let active = 0, peak = 0;
  const s = setup({ run: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return { ok: true, text: "ok" };
  } });
  const results = await Promise.all(Array.from({ length: 12 }, () => s.runner.run(request)));
  assert.ok(results.every(r => r.status === "succeeded"));
  assert.equal(peak, 1);
});

test("同一実行器の呼び出し予算は並列要求でも共有する", async () => {
  const s = setup({ maxCalls: 2 });
  const results = await Promise.all(Array.from({ length: 8 }, () => s.runner.run(request)));
  assert.equal(results.filter(r => r.status === "succeeded").length, 2);
  assert.equal(s.calls(), 2);
});

test("キャンセル済み要求は起動しない", async () => {
  const s = setup();
  const ctrl = new AbortController(); ctrl.abort();
  assert.equal((await s.runner.run(request, { signal: ctrl.signal })).status, "cancelled");
  assert.equal(s.calls(), 0);
});

test("待機中の許可取消を実行直前に再検証する", async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const s = setup({ run: async () => { started(); await blocked; return { ok: true, text: "ok" }; } });
  const first = s.runner.run(request);
  await Promise.race([began, first.then(r => { if (r.status !== "succeeded") throw new Error(r.error); })]);
  const second = s.runner.run(request);
  await new Promise(resolve => setImmediate(resolve));
  writeFileSync(process.env.MAMCP_ALLOWLIST, '{"providers":{}}');
  release();
  await first;
  assert.equal((await second).status, "rejected");
  assert.equal(s.calls(), 1);
});

test("JSON Schemaに違反する出力を成功扱いしない", async () => {
  const s = setup({ run: async () => ({ ok: true, text: '{"value":"wrong"}' }) });
  const result = await s.runner.run({ ...request, json_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } });
  assert.equal(result.status, "failed");
});

test("待機中キャンセルは枠を漏らさず子を起動しない", async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const s = setup({ run: async () => { started(); await blocked; return { ok: true, text: "ok" }; } });
  const first = s.runner.run(request);
  await Promise.race([began, first.then(r => { if (r.status !== "succeeded") throw new Error(r.error); })]);
  const ctrl = new AbortController();
  const second = s.runner.run(request, { signal: ctrl.signal });
  await new Promise(resolve => setImmediate(resolve));
  ctrl.abort();
  assert.equal((await second).status, "cancelled");
  release();
  await first;
  assert.equal((await s.runner.run(request)).status, "succeeded");
  assert.equal(s.calls(), 2);
  assert.equal(s.runner.occupied, 0);
});

test("子の環境情報が付いたMCPからは再帰実行しない", async () => {
  const prior = process.env.MAMCP_DEPTH;
  process.env.MAMCP_DEPTH = "1";
  let s;
  try { s = setup(); } finally {
    if (prior === undefined) delete process.env.MAMCP_DEPTH;
    else process.env.MAMCP_DEPTH = prior;
  }
  assert.equal((await s.runner.run(request)).status, "rejected");
  assert.equal(s.calls(), 0);
});

test("期限による子プロセスのabortをユーザー取消と誤分類しない", async () => {
  const s = setup({ run: async ({ signal }) => {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return { ok: false, proc: { aborted: true } };
  } });
  const result = await s.runner.run({ ...request, timeout_ms: 10 });
  assert.equal(result.status, "timeout");
  assert.equal(s.runner.coordinator.status().occupied, 0);
});

test("待機後に実行タイムアウトを最初から延長しない", async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const s = setup({ maxConcurrent: 1, run: async ({ signal }) => {
    started();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 120);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return { ok: !signal.aborted, proc: { aborted: signal.aborted } };
  } });
  const first = s.runner.run(request);
  await began;
  const second = s.runner.run({ ...request, timeout_ms: 180 });
  await first;
  assert.equal((await second).status, "timeout");
});

const windowsOnly = { skip: process.platform !== "win32" && "brokeredはWindows MXC専用" };

test("MXCが無いOSではbrokeredを推論前に拒否し、通常CLIへ切り替えない", { skip: process.platform === "win32" }, async () => {
  const s = setup({ tools: true });
  s.runner.reg.get().infer = async () => { throw new Error("呼ばれてはいけない"); };
  const cwd = mkdtempSync(path.join(dir, "broker-mac-"));
  const result = await s.runner.run({ ...request, cwd, isolation: "brokered" });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /isolation|Windows MXC専用/); // 入力項目自体を公開していない
  assert.equal(s.calls(), 0);
  assert.equal(s.runner.coordinator.status().accepted, 0);
});

test("brokered経路は通常CLIを呼ばず固定モデルの推論と隔離コードだけで完了する", windowsOnly, async () => {
  const { BrokeredAgent } = await import("../src/brokered-agent.mjs");
  const s = setup({ tools: true });
  let inferred = 0;
  s.runner.reg.get().infer = async args => {
    assert.equal(args.model, request.model);
    assert.equal(args.effort, request.effort);
    inferred++;
    return { ok: true, text: JSON.stringify(inferred === 1
      ? { action: "execute", code: "console.log(42)", text: "" }
      : { action: "finish", code: "", text: "done" }) };
  };
  s.runner.broker = new BrokeredAgent({ protectedPaths: [], sandbox: {
    runCommand: async () => ({ status: "succeeded", stdout: "42" }),
  } });
  const cwd = mkdtempSync(path.join(dir, "broker-work-"));
  const result = await s.runner.run({ ...request, cwd, isolation: "brokered", max_steps: 3 });
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.isolation, "brokered-mxc");
  assert.equal(s.calls(), 0);
  assert.equal(inferred, 2);
  assert.equal(s.runner.coordinator.status().accepted, 2);
  assert.equal(result.isolationEvidence[0].stdout, "42");
});

test("推論ブローカー未対応プロバイダーを通常CLIへフォールバックしない", windowsOnly, async () => {
  const s = setup({ tools: true });
  const cwd = mkdtempSync(path.join(dir, "broker-unsupported-"));
  const result = await s.runner.run({ ...request, cwd, isolation: "brokered" });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /ツール無し推論ブローカー/);
  assert.equal(s.calls(), 0);
  assert.equal(s.runner.coordinator.status().accepted, 0);
});
