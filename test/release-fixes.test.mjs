// 公開前レビューで見つかった不具合の回帰試験（生成通信なし）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mamcp-fixes-"));
process.env.MAMCP_ALLOWLIST = path.join(dir, "allow.json");
after(() => rmSync(dir, { recursive: true, force: true }));

const { runProcess } = await import("../src/proc.mjs");
const { Coordinator } = await import("../src/coordinator.mjs");
const { Registry } = await import("../src/registry.mjs");
const { Runner } = await import("../src/runner.mjs");
const { RunLog } = await import("../src/runlog.mjs");
const { loadConfig } = await import("../src/config.mjs");
const { agentResult } = await import("../src/agent-response.mjs");
const { parseCodexMcpNames } = await import("../src/adapters/codex-app-server.mjs");
const { openCodexSession } = await import("../src/adapters/codex-app-server.mjs");
const { openClaudeSession } = await import("../src/adapters/claude-stream.mjs");
const { sameClaudeModel } = await import("../src/providers/claude-models.mjs");
const createOpenAICompatible = (await import("../src/providers/openai-compatible.mjs")).default;

const fixture = name => path.resolve("test", "fixtures", name);

test("runProcess: チャンク境界で分割された多バイト文字を壊さない", async () => {
  // 「あ」(E3 81 82) を2回の書込みに分けて出力する
  const script = "process.stdout.write(Buffer.from([0xe3,0x81]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0x0a])),50)";
  const r = await runProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 10000 });
  assert.equal(r.stdout, "あ\n");
  assert.doesNotMatch(r.stdout, /�/);
});

test("許可選択: 非表示の許可を失わず、巨大・範囲外の番号を拒否する", async () => {
  const allow = path.join(dir, "selector-allow.json"), config = path.join(dir, "selector-config.json");
  const provider = path.join(dir, "selector-provider.mjs");
  writeFileSync(provider, `export default id => ({ id, type: "fake", capabilities: { tools: false, fileAccess: false, permissions: ["read-only"] },
    available: async () => ({ok:true}), listModels: async () => [{id:"visible",efforts:[]},{id:"hidden",hidden:true,efforts:[]}] });`);
  writeFileSync(config, JSON.stringify({ providers: { codex: { enabled: false }, claude: { enabled: false }, fixture: { module: provider } }, dataDir: path.join(dir, "selector-data") }));
  writeFileSync(allow, JSON.stringify({ providers: { fixture: { models: { visible: { efforts: "*" }, hidden: { efforts: "*" } } } } }));
  const result = await runProcess({ command: process.execPath, args: [path.resolve("src/select-models.mjs")],
    env: { MAMCP_CONFIG: config, MAMCP_ALLOWLIST: allow }, stdin: "1-99999999999999999999\n\n", timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /範囲で指定/);
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(allow, "utf8"));
  assert.ok(saved.providers.fixture.models.hidden);
  assert.ok(saved.providers.fixture.models.visible);
});

test("登録スクリプトは不明引数で設定変更せず、helpは成功する", async () => {
  for (const file of ["src/register-hosts.mjs"]) {
    const help = await runProcess({ command: process.execPath, args: [path.resolve(file), "--help"], timeoutMs: 10000 });
    assert.equal(help.code, 0, help.stderr);
    const bad = await runProcess({ command: process.execPath, args: [path.resolve(file), "--unknown-flag"], timeoutMs: 10000 });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /未知の引数/);
  }
});

test("登録dry-runは指定ホストだけを計画し、CLIや設定を変更しない", async () => {
  const file = path.resolve("src/register-hosts.mjs");
  for (const host of ["codex", "claude", "opencode"]) {
    const dry = await runProcess({ command: process.execPath, args: [file, "--host", host, "--dry-run"] });
    assert.equal(dry.code, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.deepEqual(plan.add.map(s => s.command), [host]);
    assert.ok(plan.remove.every(s => s.command === host));
    assert.deepEqual(plan.configFiles, []);
    assert.ok(path.isAbsolute(plan.add[0].args.at(-1)));
  }
  const invalid = await runProcess({ command: process.execPath, args: [file, "--host", "other", "--dry-run"] });
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /--host/);
});

test("Coordinator: 解放の失敗で例外を投げず、ハートビートは使用中の枠だけを更新する", () => {
  const c = new Coordinator(path.join(dir, "coord"), { heartbeatMs: 3600000 });
  try {
    c.reserve("a"); c.reserve("b");
    assert.equal(c.release("a"), true);
    assert.ok(!c.owned.has("a") && c.owned.has("b"));
    const original = c.db.bind(c);
    c.db = () => { throw new Error("database is locked"); };
    assert.equal(c.release("b"), false, "失敗しても呼出し元の結果を壊さない");
    assert.ok(c.pendingRelease.has("b"));
    c.db = original;
    c.heartbeat(); // 再解放
    assert.equal(c.status().leases.length, 0);
    assert.equal(c.pendingRelease.size, 0);
  } finally { c.close(); }
});

test("Registry: 一覧取得の失敗を長時間キャッシュせず、次の要求で再取得する", async () => {
  let calls = 0;
  const provider = { listModels: async () => { calls++; if (calls === 1) throw new Error("一時的な失敗"); return [{ id: "m", efforts: [] }]; } };
  const reg = new Registry({ providers: {}, policy: { modelCacheTtlMs: 600000 } }, { observedModels: () => [] });
  reg.providers.set("p", provider);
  const first = await reg.models("p");
  assert.equal(first.error, "一時的な失敗");
  reg.cache.get("p").at -= 6000; // 失敗の保持時間（5秒）を経過
  const second = await reg.findModel("p", "m");
  assert.equal(second.error, null);
  assert.equal(second.model.id, "m");
});

function runnerWith(provider) {
  writeFileSync(process.env.MAMCP_ALLOWLIST, JSON.stringify({ providers: { p: { models: { m: { efforts: "*" } } } } }));
  const cfg = loadConfig();
  cfg.dataDir = path.join(dir, `state-${Math.random()}`);
  const registry = { get: () => provider, findModel: async (_p, id) => ({ model: { id, efforts: [] }, error: null }) };
  return new Runner(cfg, registry, new RunLog(path.join(dir, `logs-${Math.random()}`)));
}
const toolProvider = run => ({ type: "fake", capabilities: { tools: true, fileAccess: true, executionControl: "provider-native",
  jsonSchema: true, permissions: ["full-access", "read-only", "workspace-write"] }, available: async () => ({ ok: true }), run });

test("Runner: 存在しないcwdは生の例外ではなく意図したエラーで拒否する", async () => {
  const runner = runnerWith(toolProvider(async () => ({ ok: true, text: "x" })));
  const r = await runner.run({ provider: "p", model: "m", task: "t", cwd: path.join(dir, "no-such-dir") });
  assert.equal(r.status, "rejected");
  assert.match(r.error, /cwd が存在しません/);
});

test("Runner: 実行失敗時はJSON Schemaの不適合で本来のエラーを上書きしない", async () => {
  const runner = runnerWith(toolProvider(async () => ({ ok: false, text: "", error: "認証が切れています" })));
  const cwd = mkdtempSync(path.join(dir, "w-"));
  const r = await runner.run({ provider: "p", model: "m", task: "t", cwd, json_schema: { type: "object" } });
  assert.equal(r.status, "failed");
  assert.equal(r.error, "認証が切れています");
});

test("Runner: configのAPIキー用環境変数を子へ継承しない", async () => {
  let seen;
  const runner = runnerWith(toolProvider(async ({ env }) => { seen = env; return { ok: true, text: "x" }; }));
  runner.hiddenEnv = { OPENROUTER_API_KEY: undefined };
  const cwd = mkdtempSync(path.join(dir, "w-"));
  const r = await runner.run({ provider: "p", model: "m", task: "t", cwd });
  assert.equal(r.status, "succeeded", r.error);
  assert.ok(Object.hasOwn(seen, "OPENROUTER_API_KEY") && seen.OPENROUTER_API_KEY === undefined);
});

test("Runner: 構成済みproviderのapiKeyEnvを除外対象に集める", () => {
  const cfg = loadConfig();
  cfg.dataDir = path.join(dir, `state-${Math.random()}`);
  cfg.providers = { a: { type: "openai-compatible", apiKeyEnv: "X_KEY" }, b: { type: "codex-cli" } };
  const runner = new Runner(cfg, { get() {}, findModel() {} }, new RunLog(path.join(dir, `logs-${Math.random()}`)));
  assert.deepEqual(runner.hiddenEnv, { X_KEY: undefined });
});

test("config: waitTimeoutsの大小関係を検証し、allowedCwdRootsの相対パスを配置基準で解決する", () => {
  const file = path.join(dir, "config-test.json");
  const load = conf => { writeFileSync(file, JSON.stringify(conf)); process.env.MAMCP_CONFIG = file; try { return loadConfig(); } finally { delete process.env.MAMCP_CONFIG; } };
  assert.throws(() => load({ policy: { waitTimeouts: { minMs: 500, defaultMs: 100, maxMs: 1000 } } }), /waitTimeouts/);
  assert.throws(() => load({ policy: { waitTimeouts: { minMs: 0, defaultMs: 100, maxMs: 1000 } } }), /waitTimeouts/);
  const cfg = load({ policy: { allowedCwdRoots: ["work"] } });
  assert.ok(path.isAbsolute(cfg.policy.allowedCwdRoots[0]));
});

test("compact結果: 拒否理由の候補（knownModels・supportedEfforts）を残す", () => {
  const r = agentResult({ status: "rejected", error: "x", knownModels: ["a"], supportedEfforts: ["low"], usage: {} });
  assert.deepEqual(r.knownModels, ["a"]);
  assert.deepEqual(r.supportedEfforts, ["low"]);
  assert.equal(r.usage, undefined);
});

test("RunLog: 不正なsinceを黙って無視しない", () => {
  const log = new RunLog(path.join(dir, "log-since"));
  assert.throws(() => log.summary({ since: "yesterday" }), /ISO日時/);
});

test("Codex設定: CLIが解決したMCP名だけを抽出し、不明な一覧形式では起動を拒否する", () => {
  assert.deepEqual(parseCodexMcpNames('[{"name":"inline","transport":{"env":{"KEY":"DUMMY"}}},{"name":"project"}]'), ["inline", "project"]);
  assert.throws(() => parseCodexMcpNames("{}"), /形式/);
  assert.throws(() => parseCodexMcpNames("[{}]"), /形式/);
  assert.throws(() => parseCodexMcpNames("bad"), /解析/);
});

test("Claudeモデル照合: コンテキスト指定 [..] の有無だけを同一視し、別モデルは一致しない", () => {
  assert.equal(sameClaudeModel("claude-x-5", "claude-x-5[1m]"), true);
  assert.equal(sameClaudeModel("claude-x-5[1m]", "claude-x-5[1m]"), true);
  assert.equal(sameClaudeModel("claude-y-5", "claude-x-5[1m]"), false);
  assert.equal(sameClaudeModel(null, "claude-x-5"), false);
});

test("openai-compatible: effortParam:null・設定のefforts・APIの返却値でEffort対応を確定する", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b", supported_reasoning_efforts: ["low"] }] }));
  try {
    const none = await createOpenAICompatible("x", { effortParam: null }).listModels();
    assert.deepEqual(none.map(m => m.efforts), [[], ["low"]]);
    const configured = await createOpenAICompatible("x", { efforts: ["high"], modelEfforts: { a: ["medium"] } }).listModels();
    assert.deepEqual(configured.map(m => m.efforts), [["medium"], ["low"]]);
    const unknown = await createOpenAICompatible("x", {}).listModels();
    assert.equal(unknown[0].efforts, null, "情報が無ければ未知のまま（実行は拒否）");
  } finally { globalThis.fetch = realFetch; }
});

test("アダプター: 待機中に子が終了した会話の次のターンは期限を待たず即座に失敗する", async () => {
  const cwd = mkdtempSync(path.join(dir, "a-"));
  for (const open of [
    () => openCodexSession({ command: process.execPath, prefixArgs: [fixture("fake-app-server.mjs")], model: "m1", effort: "low", cwd, permission: "full-access" }),
    () => openClaudeSession({ command: process.execPath, prefixArgs: [fixture("fake-claude-stream.mjs")], model: "m1", effort: "low", cwd, permission: "full-access" }),
  ]) {
    const session = await open();
    try {
      const turn = prompt => session.turn({ turnId: String(Math.random()), prompt, model: "m1", effort: "low",
        signal: new AbortController().signal, interruptGraceMs: 200, onEvent: () => {} });
      assert.equal((await turn("DIE_AFTER")).ok, true);
      await new Promise(r => setTimeout(r, 300)); // 子が終了するのを待つ
      const started = Date.now();
      const r = await turn("next");
      assert.equal(r.ok, false);
      assert.ok(r.broken, "会話を継続不能として返す");
      assert.ok(Date.now() - started < 2000, "期限まで待たない");
    } finally { await session.close(); }
  }
});

test("server: ホストが終了してstdinが閉じたらサーバーも終了する（子プロセスを残さない）", async () => {
  const { spawn } = await import("node:child_process");
  const conf = path.join(dir, "server-config.json");
  // 常駐する子プロセスのパイプと同じく、イベントループを生かし続けるハンドルを持つプロバイダー
  const keepalive = path.join(dir, "keepalive-provider.mjs");
  writeFileSync(keepalive, 'export default id => { setInterval(() => {}, 1000); return { id, type: "keepalive", description: "", capabilities: { tools: false, fileAccess: false, permissions: ["read-only"] }, available: async () => ({ ok: true }), listModels: async () => [] }; };\n');
  writeFileSync(conf, JSON.stringify({ dataDir: path.join(dir, "server-data"),
    providers: { keep: { type: "keepalive", module: keepalive } } }));
  const child = spawn(process.execPath, [path.resolve("src", "server.mjs")], {
    env: { ...process.env, MAMCP_CONFIG: conf }, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise(r => setTimeout(r, 1500)); // 起動待ち
  const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
  child.stdin.end();
  let timer;
  const code = await Promise.race([exited, new Promise(r => { timer = setTimeout(() => r("timeout"), 10000); })]);
  clearTimeout(timer);
  if (code === "timeout") child.kill();
  assert.equal(code, 0);
});
