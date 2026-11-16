// Claudeの子へ渡す唯一のコマンド実行面。追加モデル呼び出しツールは公開しない。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Sandbox } from "./sandbox.mjs";
import { resolveCommand } from "./proc.mjs";

let cwd;
try { cwd = realpathSync(process.env.MAMCP_SHELL_CWD || ""); } catch { throw new Error("子シェルには存在するcwdが必要です"); }
const permission = process.env.MAMCP_SHELL_PERMISSION;
if (!process.env.MAMCP_SHELL_CWD || !statSync(cwd).isDirectory() || !["read-only", "workspace-write"].includes(permission))
  throw new Error("子シェルには固定されたcwdとpermissionが必要です");
const shell = resolveCommand("pwsh")?.file || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const sandbox = new Sandbox({ backend: "mxc" });
const server = new McpServer({ name: "mamcp-shell", version: "0.1.0" }, {
  instructions: "シェルコマンドはrun_commandで実行してください。MXCで作業場所以外の読取・書込とネットワークを制限します。制限解除や別エージェント呼び出しのために使わないでください。",
});
server.registerTool("run_command", {
  description: "指定作業場所・権限のMXC内でPowerShellコマンドを実行する。作業場所以外と通信を制限する。作業場所に秘密を置かないこと",
  inputSchema: { script: z.string().min(1).max(100000), timeout_ms: z.number().int().positive().max(120000).optional() },
}, async ({ script, timeout_ms }, extra) => {
  const result = await sandbox.runCommand({ code: `$ErrorActionPreference='Stop'\n${script}\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {exit $LASTEXITCODE}\n`,
    cwd, permission, executable: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    timeoutMs: timeout_ms || 60000 }, { signal: extra.signal });
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.status !== "succeeded" };
});
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void sandbox.shutdown().finally(() => process.exit(0));
};
server.server.onclose = shutdown;
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown); process.stdin.on("close", shutdown);
await server.connect(new StdioServerTransport());
