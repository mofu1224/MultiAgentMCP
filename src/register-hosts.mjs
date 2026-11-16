import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ROOT } from "./config.mjs";
import { runProcess, resolveCommand } from "./proc.mjs";

const NAME = "multi-agent";

/** 導入先を指定できるようにし、エージェントによる導入で他ホストを変更しない。 */
export function registrationOptions(args) {
  const options = { host: "all", vscode: false, dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--host":
        options.host = args[++i];
        if (!["all", "codex", "claude", "opencode"].includes(options.host))
          throw new Error("--host は codex / claude / opencode / all で指定してください");
        break;
      case "--vscode": options.vscode = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`未知の引数です: ${args[i]}`);
    }
  }
  return options;
}

export function registrationCommands(root, node) {
  const server = path.join(root, "src", "server.mjs");
  return [
    { command: "codex", args: ["mcp", "add", NAME, "--", node, server] },
    { command: "claude", args: ["mcp", "add", "--scope", "user", NAME, "--", node, server] },
    { command: "opencode", args: ["mcp", "add", NAME, "--global", "--", node, server] },
  ];
}

/** 既存の同名登録を外す（導入先が変わっても古いパスを残さない）。OpenCodeのaddは同名を上書きする。 */
export function unregistrationCommands() {
  return [
    { command: "codex", args: ["mcp", "remove", NAME] },
    { command: "claude", args: ["mcp", "remove", "--scope", "user", NAME] },
  ];
}

/**
 * 登録CLIを持たないホスト（VS CodeのGitHub Copilot）の設定ファイル。`--vscode` を指定した場合だけ登録する。
 * ホストの設定フォルダが存在する場合だけ対象にし、未導入のホストへフォルダを作らない。
 */
export function configFileTargets({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const codeUser = platform === "win32"
    ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User")
    : platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Code", "User")
      : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User");
  return [
    { host: "vscode-copilot", dir: codeUser, file: path.join(codeUser, "mcp.json"), key: "servers", extra: {} },
  ];
}

/** 既存のサーバー定義を保ったまま multi-agent だけを追加・更新したJSON文字列を返す。 */
export function mergeServerConfig(existingText, key, entry) {
  const data = existingText && existingText.trim() ? JSON.parse(existingText) : {};
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("設定ファイルの最上位がオブジェクトではありません");
  const servers = data[key] && typeof data[key] === "object" && !Array.isArray(data[key]) ? data[key] : {};
  data[key] = { ...servers, [NAME]: entry };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function registerConfigFile(target, root, node) {
  if (!existsSync(target.dir)) return "未導入のため対象外";
  const entry = { type: "stdio", command: node, args: [path.join(root, "src", "server.mjs")], ...target.extra };
  const before = existsSync(target.file) ? readFileSync(target.file, "utf8") : "";
  const next = mergeServerConfig(before, target.key, entry); // 解析できない（JSONC等）場合は書き換えず失敗する
  if (next === before) return "登録済み（変更なし）";
  const tmp = `${target.file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, target.file);
  return "登録成功";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = registrationOptions(process.argv.slice(2));
  if (options.help) {
    console.log("使い方: node src/register-hosts.mjs [--host codex|claude|opencode|all] [--dry-run] [--vscode]");
    process.exit(0);
  }
  const selected = spec => options.host === "all" || spec.command === options.host;
  const remove = unregistrationCommands().filter(selected);
  const add = registrationCommands(ROOT, process.execPath).filter(selected);
  const targets = options.vscode ? configFileTargets() : [];
  if (options.dryRun) {
    console.log(JSON.stringify({ remove, add, configFiles: targets.map(t => t.file) }, null, 2));
    process.exit(0);
  }
  // 未登録なら失敗するだけなので結果は問わない。
  for (const spec of remove) {
    if (!resolveCommand(spec.command)) continue;
    try { await runProcess({ ...spec, timeoutMs: 30000 }); } catch { /* 未登録 */ }
  }
  let registered = 0;
  for (const spec of add) {
    if (!resolveCommand(spec.command)) { console.log(`${spec.command}: 未導入のため対象外`); continue; }
    registered++;
    try {
      const result = await runProcess({ ...spec, timeoutMs: 30000 });
      console.log(`${spec.command}: ${result.code === 0 ? "登録成功" : "登録失敗"}`);
      if (result.code !== 0) { console.error(result.stderr.slice(-1000)); process.exitCode = 1; }
    } catch (error) { console.error(`${spec.command}: ${error.message}`); process.exitCode = 1; }
  }
  for (const target of targets) {
    try { console.log(`${target.host}: ${registerConfigFile(target, ROOT, process.execPath)}`); registered++; }
    catch (error) { console.error(`${target.host}: 登録失敗（${target.file}: ${error.message}）`); process.exitCode = 1; }
  }
  if (!registered) { console.error("登録できるホスト（codex / claude / opencode）が見つかりません"); process.exitCode = 1; }
  console.log(`登録先: ${path.join(ROOT, "src", "server.mjs")}`);
  console.log(`Node: ${process.execPath}（Nodeを別の場所へ更新・移動したら再実行してください）`);
}
