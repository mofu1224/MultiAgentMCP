import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCommand, runProcess } from "../src/proc.mjs";

test("Windowsでは拡張子よりPATHのディレクトリ順を優先する", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "mamcp-path-"));
  const previous = process.env.PATH;
  try {
    const first = path.join(root, "first"), second = path.join(root, "second");
    mkdirSync(first); mkdirSync(second);
    writeFileSync(path.join(first, "path-test.cmd"), "");
    writeFileSync(path.join(second, "path-test.exe"), "");
    process.env.PATH = `${first};${second}`;
    assert.deepEqual(resolveCommand("path-test"), { file: path.join(first, "path-test.cmd"), shell: true });
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windowsの拡張子付き指定を解決し、見つからなかったコマンドも導入後は再探索する", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "mamcp-path-ext-"));
  const previous = process.env.PATH;
  try {
    process.env.PATH = root;
    assert.equal(resolveCommand("mamcp-new.exe"), null);
    writeFileSync(path.join(root, "mamcp-new.exe"), "");
    assert.deepEqual(resolveCommand("mamcp-new.exe"), { file: path.join(root, "mamcp-new.exe"), shell: false });
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知のcmdラッパーでメタ文字のある引数を展開・実行しない", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mamcp-cmd-safe-"));
  try {
    const command = path.join(root, "custom.cmd");
    writeFileSync(command, "@echo off\r\necho %*\r\n");
    for (const arg of ['%PATH%', 'a\" & whoami', "a\nwhoami"])
      await assert.rejects(runProcess({ command, args: [arg] }), /安全に表現/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("環境変数の継承を無効化でき、親の秘密値を子へ渡さない", async () => {
  process.env.MAMCP_TEST_SECRET = "private-marker";
  try {
    const result = await runProcess({ command: process.execPath,
      args: ["-e", "console.log(process.env.MAMCP_TEST_SECRET || 'ABSENT')"], inheritEnv: false });
    assert.equal(result.stdout.trim(), "ABSENT");
  } finally { delete process.env.MAMCP_TEST_SECRET; }
});

test("npmのcmdラッパーはシェルを介さずJSON・引用符・環境変数文字列をそのまま渡す", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mamcp-shim-"));
  try {
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "node_modules", "echo.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
    const command = path.join(root, "echo.cmd");
    writeFileSync(command, '@echo off\r\n"%_prog%"  "%dp0%\\node_modules\\echo.mjs" %*\r\n');
    const args = ['{"a":"quoted & value"}', "%PATH%", 'single"quote'];
    const result = await runProcess({ command, args });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("取消は実際に起動した子孫プロセスも終了し、abort済みの起動を放置しない", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mamcp-tree-"));
  const ready = path.join(root, "ready.json");
  const ctrl = new AbortController();
  const source = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(ready)},String(child.pid));
    setInterval(()=>{},1000);
  `;
  try {
    const running = runProcess({ command: process.execPath, args: ["-e", source], signal: ctrl.signal, timeoutMs: 5000 });
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(ready));
    const childPid = Number(readFileSync(ready, "utf8"));
    ctrl.abort();
    const result = await running;
    assert.equal(result.aborted, true);
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    assert.equal(alive, false);
  } finally { ctrl.abort(); rmSync(root, { recursive: true, force: true }); }
});

test("ネイティブexeのnpmラッパーもcmdの8191文字制限を経由しない", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mamcp-native-shim-"));
  try {
    mkdirSync(path.join(root, "node_modules"));
    copyFileSync(process.execPath, path.join(root, "node_modules", "node.exe"));
    const command = path.join(root, "native.cmd");
    writeFileSync(command, '@echo off\r\n"%dp0%\\node_modules\\node.exe"   %*\r\n');
    const result = await runProcess({ command, args: ["-e", "console.log(process.argv[1].length)", "x".repeat(12000)] });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "12000");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
