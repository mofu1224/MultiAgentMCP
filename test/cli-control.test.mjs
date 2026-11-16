import { test } from "node:test";
import assert from "node:assert/strict";
import codex, * as codexModule from "../src/providers/codex-cli.mjs";
import claude, * as claudeModule from "../src/providers/claude-cli.mjs";
import { platformFeatures, platformNotice } from "../src/platform.mjs";

const req = { model: "chosen-model", effort: "chosen-effort", permission: "read-only", cwd: "/work" };
const value = (args, key) => args[args.indexOf(key) + 1];

test("Codexは親の明示値を使い、承認待ち・ネイティブ再委譲・ユーザー設定の干渉を止める", () => {
  assert.equal(typeof codexModule.buildCodexArgs, "function");
  const args = codexModule.buildCodexArgs(req, "/out", "/schema");
  assert.equal(value(args, "-m"), "chosen-model");
  assert.equal(value(args, "-s"), "read-only");
  assert.equal(value(args, "-C"), "/work");
  assert.ok(args.includes('model_reasoning_effort="chosen-effort"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes("agents.enabled=false"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(value(args, "--output-schema"), "/schema");
  assert.equal(args.at(-1), "-");
  assert.equal(value(codexModule.buildCodexArgs({ ...req, permission: "workspace-write" }, "/out"), "-s"), "workspace-write");
  if (process.platform === "win32") assert.ok(args.includes('windows.sandbox="mxc"'));
});

test("Claudeは正規認証を残しつつモデル・Effortとツールを限定し、承認待ちと追加MCPを止める", () => {
  assert.equal(typeof claudeModule.buildClaudeArgs, "function");
  const win = platformFeatures("win32");
  const args = claudeModule.buildClaudeArgs(req, win);
  assert.equal(value(args, "--model"), "chosen-model");
  assert.equal(value(args, "--effort"), "chosen-effort");
  assert.equal(value(args, "--permission-prompts"), "none");
  assert.equal(value(args, "--permission-mode"), "dontAsk");
  const settings = JSON.parse(value(args, "--settings"));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.disableClaudeAiConnectors, true);
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--strict-mcp-config"));
  const mcp = JSON.parse(value(args, "--mcp-config"));
  assert.ok(mcp.mcpServers.mamcp_shell);
  assert.equal(args.includes("--bare"), false);
  const tools = value(args, "--tools").split(",");
  assert.ok(tools.includes("Read"));
  assert.equal(tools.includes("Bash"), false);
  assert.equal(tools.includes("Write"), false);
  assert.equal(tools.includes("Agent"), false);
  const write = claudeModule.buildClaudeArgs({ ...req, permission: "workspace-write" }, win);
  assert.equal(value(write, "--permission-mode"), "acceptEdits");
  assert.equal(value(write, "--tools").split(",").includes("Bash"), false);
  assert.ok(value(write, "--tools").split(",").includes("Edit"));
  assert.ok(value(write, "--allowedTools").includes("mcp__mamcp_shell__run_command"));
});

test("MXCが無いOSではbrokered・Claude制限権限・既定の隔離実行を除去し、弱い方式へ切り替えない", () => {
  const mac = platformFeatures("darwin");
  assert.deepEqual({ ...mac }, { platform: "darwin", mxc: false, brokered: false, claudeRestricted: false, isolatedCode: false });
  assert.equal(platformFeatures("darwin", { backend: "docker" }).isolatedCode, true);
  assert.throws(() => claudeModule.buildClaudeArgs(req, mac), /このOS/);
  assert.match(platformNotice(mac), /brokered.*Claude.*run_isolated_code/s);
  assert.equal(platformNotice(platformFeatures("win32")), "");
  const provider = claude("claude");
  assert.deepEqual(provider.capabilities.permissions,
    process.platform === "win32" ? ["full-access", "read-only", "workspace-write"] : ["full-access"]);
  assert.equal(provider.capabilities.brokered, process.platform === "win32");
});

test("実際に完了したCLIツールイベントからシェル実行の証拠を抽出する", () => {
  assert.equal(typeof codexModule.parseCodexExecution, "function");
  const codexResult = codexModule.parseCodexExecution([
    { type: "item.completed", item: { type: "command_execution", exit_code: 0 } },
    { type: "item.completed", item: { type: "command_execution", exit_code: 1 } },
    { type: "turn.completed", usage: { input_tokens: 5 } },
  ].map(JSON.stringify).join("\n"));
  assert.deepEqual(codexResult.toolUsage, { shellCalls: 2, successfulShellCalls: 1 });
  assert.equal(typeof claudeModule.parseClaudeExecution, "function");
  const claudeResult = claudeModule.parseClaudeExecution([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "mcp__mamcp_shell__run_command" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: false }] } },
    { type: "result", result: "done", is_error: false },
  ].map(JSON.stringify).join("\n"));
  assert.deepEqual(claudeResult.toolUsage, { shellCalls: 1, successfulShellCalls: 1 });
  assert.equal(claudeResult.result.result, "done");
});

test("追加引数からモデル・権限・再委譲を上書きさせない", () => {
  for (const create of [codex, claude]) {
    assert.throws(() => create("test", { extraArgs: ["--dangerously-skip-permissions"] }), /extraArgs/);
  }
});
