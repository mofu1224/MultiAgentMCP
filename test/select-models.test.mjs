import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-select-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "provider.mjs");
  const config = path.join(dir, "config.json");
  const allow = path.join(dir, "allow.json");
  writeFileSync(fixture, `export default id => ({
    id, type: "fixture", available: async () => ({ ok: true }),
    listModels: async () => [
      { id: "chosen", efforts: ["low", "medium", "high"], description: "Long provider description" },
      { id: "hidden-model", hidden: true },
      { id: "new-model", efforts: ["low", "high"] },
      { id: "known-model" },
    ],
  });`);
  writeFileSync(config, JSON.stringify({
    providers: { codex: { enabled: false }, claude: { enabled: false }, demo: { module: fixture } },
    dataDir: path.join(dir, "data"),
  }));
  const initial = JSON.stringify({ providers: { demo: {
    models: { chosen: { efforts: ["low", "medium"] }, "hidden-model": { efforts: "*" }, retired: { efforts: "*" } },
    reviewed: ["chosen", "known-model"],
  } } });
  writeFileSync(allow, initial);
  return {
    run(args, input = "") {
      const command = process.platform === "win32" ? ["cmd.exe", "/d", "/c", "select-models.cmd"]
        : process.platform === "darwin" ? ["/bin/zsh", "./select-models.command"]
          : [process.execPath, "src/select-models.mjs"];
      const result = spawnSync(command[0], [...command.slice(1), ...args], {
        cwd: ROOT, input, encoding: "utf8", timeout: 10000, windowsHide: true,
        env: { ...process.env, MAMCP_CONFIG: config, MAMCP_ALLOWLIST: allow },
      });
      assert.ifError(result.error);
      return result;
    },
    assertUnchanged: () => assert.equal(readFileSync(allow, "utf8"), initial),
  };
}

test("--show はモデルを1行ずつ表示し、許可済みと新着を区別する", t => {
  const { run, assertUnchanged } = setup(t);
  const { status, stdout, stderr } = run(["--show"]);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /demo：3モデル \/ 許可済み 1/);
  assert.match(stdout, /^\s*1\. \[許可済\] chosen — low, medium\r?$/m);
  assert.match(stdout, /^\s*2\. \[未許可\] new-model \[新着\]\r?$/m);
  assert.match(stdout, /^\s*3\. \[未許可\] known-model\r?$/m);
  assert.match(stdout, /一覧に無いモデル: retired/);
  assert.match(stdout, /非表示モデル（変更せず保持）: hidden-model/);
  assert.doesNotMatch(stdout, /Long provider description|対応Effort:|入力 >|何かキー|Press any key/);
  assertUnchanged();
});

test("対話では選んだモデルだけにEffortの候補と現在値を示し、EOFでは保存しない", t => {
  const { run, assertUnchanged } = setup(t);
  const { status, stdout, stderr } = run([], "1\n");
  assert.equal(status, 1, stderr);
  assert.match(stdout, /既存の選択を置き換えます/);
  assert.match(stdout, /chosen のEffort（現在: low, medium）/);
  assert.match(stdout, /1=low\s+2=medium\s+3=high/);
  assert.match(stdout, /Enter: low, medium/);
  assert.match(stdout, /保存せず中断/);
  if (process.platform === "win32") assert.match(stdout, /Exit code: 1/);
  assertUnchanged();
});

test("ランチャーは未対応の引数で対話せず、終了コードを返す", t => {
  const { run, assertUnchanged } = setup(t);
  const { status, stdout, stderr } = run(["--unknown"]);
  assert.equal(status, 2);
  assert.match(stderr, /使い方:.*--show/);
  assert.doesNotMatch(stdout, /モデル許可設定|入力 >|何かキー|Press any key/);
  assertUnchanged();
});
