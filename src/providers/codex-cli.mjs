// Codex CLI（ChatGPT サインイン）プロバイダー。モデル一覧は `codex debug models` から実行時取得する。
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess, resolveCommand } from "../proc.mjs";
import { opencodeInference } from "../inference-only.mjs";
import { openCodexSession } from "../adapters/codex-app-server.mjs";
import { FEATURES } from "../platform.mjs";

const SANDBOX = { "read-only": "read-only", "workspace-write": "workspace-write" };

export function parseCodexExecution(stdout) {
  const usage = {}, errors = [], toolUsage = { shellCalls: 0, successfulShellCalls: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "turn.completed" && ev.usage)
      for (const [k, v] of Object.entries(ev.usage)) if (typeof v === "number") usage[k] = (usage[k] || 0) + v;
    if (ev.type === "error" || ev.type === "turn.failed") errors.push(ev.message || ev.error?.message || JSON.stringify(ev));
    if (ev.type === "item.completed" && ev.item?.type === "command_execution") {
      toolUsage.shellCalls++;
      if (ev.item.exit_code === 0) toolUsage.successfulShellCalls++;
    }
  }
  return { usage, errors, toolUsage };
}

export function buildCodexArgs({ model, effort, cwd, permission }, out, schemaFile) {
  if (!Object.hasOwn(SANDBOX, permission)) throw new Error("未対応のpermissionです");
  const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral",
    "--ignore-user-config", "--ignore-rules", "-s", SANDBOX[permission], "-o", out,
    "-c", 'approval_policy="never"', "-c", "agents.enabled=false"];
  if (process.platform === "win32") args.push("-c", 'windows.sandbox="mxc"');
  if (cwd) args.push("-C", cwd);
  args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  if (schemaFile) args.push("--output-schema", schemaFile);
  args.push("-");
  return args;
}

export default function create(id, cfg = {}) {
  const command = cfg.command || "codex";
  if (cfg.extraArgs != null && (!Array.isArray(cfg.extraArgs) || cfg.extraArgs.length))
    throw new Error("codex-cliのextraArgsは固定制御を上書きできるため使用できません");
  return {
    id,
    type: "codex-cli",
    description: "OpenAI Codex CLI（ChatGPT アカウントのサインインを使用）。ツール実行可能なエージェント。",
    capabilities: { tools: true, fileAccess: true, executionControl: "provider-native", brokered: FEATURES.brokered,
      inferenceBackend: "opencode-generate", jsonSchema: true, permissions: ["full-access", ...Object.keys(SANDBOX)],
      session: { adapter: "codex app-server", permissions: ["full-access"], nativeContinuation: true,
        modelSwitch: true, effortSwitch: true, persistence: "ephemeral" } },
    infer: opencodeInference,
    // full-access会話の継続用セッション。制限権限は下のrun（codex exec＋標準sandbox。WindowsはMXC）を維持する。
    openSession: opts => openCodexSession({ command, ...opts }),

    async available() {
      return resolveCommand(command) ? { ok: true } : { ok: false, reason: `${command} が PATH にありません` };
    },

    async listModels() {
      const r = await runProcess({ command, args: ["debug", "models"], timeoutMs: 60000 });
      if (r.code !== 0) throw new Error(`codex debug models 失敗: ${r.stderr.slice(0, 500)}`);
      const data = JSON.parse(r.stdout);
      return (data.models || []).map((m) => ({
        id: m.slug,
        displayName: m.display_name,
        description: m.description,
        efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l.effort) : null,
        defaultEffort: m.default_reasoning_level ?? null,
        hidden: m.visibility && m.visibility !== "list",
        extra: { priority: m.priority, speedTiers: m.additional_speed_tiers, supportedInApi: m.supported_in_api },
      }));
    },

    async run({ model, effort, prompt, cwd, permission, timeoutMs, jsonSchema, env, signal, onProgress }) {
      const dir = mkdtempSync(path.join(tmpdir(), "mamcp-codex-"));
      try {
        const out = path.join(dir, "last.txt");
        let sf;
        if (jsonSchema) {
          sf = path.join(dir, "schema.json");
          writeFileSync(sf, JSON.stringify(jsonSchema));
        }
        const args = buildCodexArgs({ model, effort, cwd, permission }, out, sf);
        const r = await runProcess({ command, args, stdin: prompt, cwd, env, timeoutMs, signal, onProgress });
        const { usage, errors, toolUsage } = parseCodexExecution(r.stdout);
        let text = "";
        try { text = readFileSync(out, "utf8"); } catch { /* 出力なし */ }
        return {
          ok: r.code === 0 && !r.timedOut && errors.length === 0,
          text,
          usage,
          toolUsage,
          modelUsed: model || null,
          error: errors.join("\n") || (r.code !== 0 ? r.stderr.slice(-2000) : undefined),
          proc: r,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
