import { test } from "node:test";
import assert from "node:assert/strict";

test("ホスト登録は各公式CLIで既存設定を保ち、配置から絶対パスを導出する", async () => {
  const { registrationCommands } = await import("../src/register-hosts.mjs");
  const commands = registrationCommands("/portable/project", "/runtime/node");
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].args.slice(0, 3), ["mcp", "add", "multi-agent"]);
  assert.ok(commands[1].args.includes("--scope"));
  assert.ok(commands[1].args.includes("user"));
  assert.ok(commands[2].args.includes("--global"));
  for (const command of commands) {
    assert.ok(command.args.includes("/runtime/node"));
    assert.match(command.args.at(-1), /src[/\\]server\.mjs$/);
  }
});

test("再登録では古い導入先のCodex/Claude登録を先に外す（OpenCodeはaddで上書き）", async () => {
  const { unregistrationCommands } = await import("../src/register-hosts.mjs");
  const commands = unregistrationCommands();
  assert.deepEqual(commands.map(c => [c.command, c.args[1]]), [["codex", "remove"], ["claude", "remove"]]);
  assert.ok(commands[1].args.includes("user"));
});

test("VS Code Copilotの設定は既存サーバーを保って追加し、未導入なら作らない。Copilot CLIは対象外", async () => {
  const { configFileTargets, mergeServerConfig, registerConfigFile } = await import("../src/register-hosts.mjs");
  const { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const home = mkdtempSync(path.join(tmpdir(), "mamcp-reg-"));
  try {
    const targets = configFileTargets({ platform: "darwin", home, env: {} });
    assert.deepEqual(targets.map(t => [t.host, t.key]), [["vscode-copilot", "servers"]]);
    assert.match(targets[0].file, /Library[/\\]Application Support[/\\]Code[/\\]User[/\\]mcp\.json$/);
    const win = configFileTargets({ platform: "win32", home, env: { APPDATA: "C:\\R", COPILOT_HOME: "C:\\C" } });
    assert.deepEqual(win.map(t => t.file), [path.join("C:\\R", "Code", "User", "mcp.json")]);

    // 未導入（設定フォルダ無し）なら作らない
    const target = targets[0];
    assert.equal(registerConfigFile(target, "/opt/mamcp", "/bin/node"), "未導入のため対象外");
    assert.equal(existsSync(target.dir), false);

    // 既存のサーバーを保持して追加し、2回目は変更なし
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, JSON.stringify({ servers: { other: { command: "x" } }, keep: 1 }));
    assert.equal(registerConfigFile(target, "/opt/mamcp", "/bin/node"), "登録成功");
    const saved = JSON.parse(readFileSync(target.file, "utf8"));
    assert.deepEqual(saved.servers.other, { command: "x" });
    assert.equal(saved.keep, 1);
    assert.deepEqual(saved.servers["multi-agent"], { type: "stdio", command: "/bin/node", args: [path.join("/opt/mamcp", "src", "server.mjs")] });
    assert.equal(registerConfigFile(target, "/opt/mamcp", "/bin/node"), "登録済み（変更なし）");

    // 解析できない設定は書き換えない
    assert.throws(() => mergeServerConfig("{ // comment\n}", "servers", {}));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
