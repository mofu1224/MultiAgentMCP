// Claude Code CLI（Claude サブスクリプションのログイン）プロバイダー。
// モデル名・モデル別EffortはCLIのstream-json初期化応答から取得する。
import { runProcess, resolveCommand } from "../proc.mjs";
import { parseClaudeModels } from "./claude-models.mjs";
import path from "node:path";
import { ROOT } from "../config.mjs";
import { claudeInference } from "../inference-only.mjs";
import { openClaudeSession } from "../adapters/claude-stream.mjs";
import { FEATURES } from "../platform.mjs";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"];
const WRITE_TOOLS = [...READ_ONLY_TOOLS, "Edit", "Write", "MultiEdit", "NotebookEdit"];

export function parseClaudeExecution(stdout) {
  let result = null;
  const pending = new Set(), completed = new Set(), toolUsage = { shellCalls: 0, successfulShellCalls: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "result") result = ev;
    for (const block of ev.message?.content || []) {
      if (block.type === "tool_use" && ["Bash", "PowerShell", "mcp__mamcp_shell__run_command"].includes(block.name))
        pending.add(block.id);
      if (block.type === "tool_result" && pending.has(block.tool_use_id) && !completed.has(block.tool_use_id)) {
        completed.add(block.tool_use_id);
        if (!block.is_error) toolUsage.successfulShellCalls++;
      }
    }
  }
  toolUsage.shellCalls = pending.size;
  return { result, toolUsage };
}

export function buildClaudeArgs({ model, effort, permission, jsonSchema, cwd }, features = FEATURES) {
  if (!["read-only", "workspace-write"].includes(permission)) throw new Error("未対応のpermissionです");
  if (!features.claudeRestricted) throw new Error("このOSではClaudeの制限権限（専用MXCシェル）を提供しません");
  const shellConfig = { mcpServers: { mamcp_shell: {
    command: process.execPath, args: [path.join(ROOT, "src", "shell-server.mjs")],
    env: { MAMCP_SHELL_CWD: cwd, MAMCP_SHELL_PERMISSION: permission },
  } } };
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--restricted", "--setting-sources", "", "--disable-slash-commands",
    "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify(shellConfig),
    "--permission-prompts", "none",
    "--permission-mode", permission === "workspace-write" ? "acceptEdits" : "dontAsk",
    "--tools", (permission === "workspace-write" ? WRITE_TOOLS : READ_ONLY_TOOLS).join(","),
    "--allowedTools", "mcp__mamcp_shell__run_command",
    "--model", model];
  if (effort) args.push("--effort", effort);
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  return args;
}

export default function create(id, cfg = {}) {
  const command = cfg.command || "claude";
  if (cfg.extraArgs != null && (!Array.isArray(cfg.extraArgs) || cfg.extraArgs.length))
    throw new Error("claude-cliのextraArgsは固定制御を上書きできるため使用できません");
  return {
    id,
    type: "claude-cli",
    description: "Anthropic Claude Code CLI（Claude アカウントのログインを使用）。ツール実行可能なエージェント。",
    // 制限権限のシェルは専用MXCシェル経由のため、MXCが無いOSではfull-accessだけを公開する。
    capabilities: { tools: true, fileAccess: true, executionControl: "provider-native", brokered: FEATURES.brokered,
      inferenceBackend: "claude-tools-empty", jsonSchema: true,
      permissions: FEATURES.claudeRestricted ? ["full-access", "read-only", "workspace-write"] : ["full-access"],
      session: { adapter: "claude stream-json", permissions: ["full-access"], nativeContinuation: true,
        modelSwitch: true, effortSwitch: false, persistence: "none", jsonSchema: "prompt-validated" } },
    infer: req => claudeInference(req, command),
    // full-access会話の継続用セッション。制限権限（restricted＋専用MXCシェル）は下のrunを維持する。
    openSession: opts => openClaudeSession({ command, ...opts }),

    async available() {
      return resolveCommand(command) ? { ok: true } : { ok: false, reason: `${command} が PATH にありません` };
    },

    async listModels() {
      const requestId = "models";
      const r = await runProcess({
        command,
        args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
          "--verbose", "--no-session-persistence", "--bare", "--strict-mcp-config",
          "--mcp-config", JSON.stringify({ mcpServers: {} })],
        stdin: JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } }) + "\n",
        timeoutMs: 60000,
      });
      if (r.code !== 0 || r.timedOut) throw new Error(`Claudeモデル取得失敗: ${r.stderr.slice(0, 500) || `exit=${r.code}`}`);
      return parseClaudeModels(r.stdout, requestId);
    },

    async run({ model, effort, prompt, cwd, permission, timeoutMs, jsonSchema, env, signal, onProgress }) {
      const args = buildClaudeArgs({ model, effort, permission, jsonSchema, cwd });
      const r = await runProcess({ command, args, stdin: prompt, cwd, env, timeoutMs, signal, onProgress });
      const { result: j, toolUsage } = parseClaudeExecution(r.stdout);
      const modelUsage = j?.modelUsage || {};
      return {
        ok: r.code === 0 && !r.timedOut && j && !j.is_error,
        text: j?.result ?? r.stdout,
        structured: j?.structured_output,
        toolUsage,
        usage: { ...(j?.usage || {}), total_cost_usd_equivalent: j?.total_cost_usd, num_turns: j?.num_turns },
        modelUsed: Object.keys(modelUsage)[0] || model || null,
        modelsObserved: Object.keys(modelUsage),
        error: j?.is_error ? j.result || j.subtype : r.code !== 0 ? r.stderr.slice(-2000) : undefined,
        proc: r,
      };
    },
  };
}
