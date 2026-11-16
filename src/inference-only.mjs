// 認証を持つホスト側の推論専用アダプター。モデルへツールを公開しない。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "./proc.mjs";
import { ROOT } from "./config.mjs";
import { Service } from "@opencode/client/service";
import { sameClaudeModel } from "./providers/claude-models.mjs";

export function buildClaudeInferenceArgs({ model, effort }) {
  const args = ["-p", "--output-format", "json", "--no-session-persistence",
    "--safe-mode", "--restricted", "--tools", "", "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }), "--permission-prompts", "none",
    "--permission-mode", "dontAsk", "--model", model];
  if (effort) args.push("--effort", effort);
  return args;
}

export async function claudeInference(req, command = "claude") {
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-inference-"));
  try {
    const r = await runProcess({ command, args: buildClaudeInferenceArgs(req),
      cwd: dir, stdin: req.prompt, signal: req.signal, timeoutMs: req.timeoutMs });
    let result; try { result = JSON.parse(r.stdout.trim()); } catch { /* 下で失敗 */ }
    const observed = Object.keys(result?.modelUsage || {});
    if (observed.some(model => !sameClaudeModel(model, req.model)))
      return { ok: false, text: "", error: "Claudeが指定外モデルを使用したため拒否しました" };
    const ok = r.code === 0 && !r.timedOut && !!result && !result.is_error;
    return { ok, text: result?.result || "", usage: result?.usage || {}, modelUsed: req.model,
      ...(!ok && { error: r.timedOut ? "Claude推論専用呼び出しがタイムアウトしました" : "Claude推論専用呼び出しに失敗しました" }) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function opencodeInference(req, api) {
  // OpenCodeはLocationの監視を保持するため、呼出しごとの一時Locationを作らない。
  // このホスト専用ディレクトリにはプロンプト/出力をファイル保存しない。
  const dir = path.join(ROOT, "data", "inference-host");
  mkdirSync(dir, { recursive: true });
  let endpoint;
  const call = api || ((method, route, data, cleanup = false) => request(route, method, data, cleanup));
  const request = async (route, method, data, cleanup) => {
    endpoint ||= await Service.discover();
    if (!endpoint) throw new Error("既存OpenCodeサービスが見つかりません。通常CLIへ切り替えません");
    const timed = AbortSignal.timeout(cleanup ? 10000 : req.timeoutMs);
    const signal = cleanup ? timed : AbortSignal.any([timed, ...(req.signal ? [req.signal] : [])]);
    const response = await fetch(new URL(route, endpoint.url), {
      method, headers: { ...Service.headers(endpoint), "content-type": "application/json" },
      ...(data !== undefined && { body: JSON.stringify(data) }), signal,
    });
    if (!response.ok) throw new Error(`OpenCode推論API ${method} ${route} に失敗しました (HTTP ${response.status})`);
    return response.status === 204 ? {} : response.json();
  };
  let sessionId, result, originalError;
  try {
    const suffix = `?location%5Bdirectory%5D=${encodeURIComponent(dir)}`;
    const models = await call("GET", `/api/model${suffix}`);
    const selected = models.data?.find(m => m.providerID === "openai" && m.id === req.model);
    if (!selected || (req.effort && !selected.variants?.some(v => v.id === req.effort)))
      throw new Error("既存OpenCodeのOpenAIモデル/variantに明示指定が存在しません。自動変換しません");
    const model = { providerID: "openai", id: req.model, ...(req.effort && { variant: req.effort }) };
    const created = await call("POST", "/api/session", {
      title: "MultiAgentMCP inference-only", location: { directory: dir }, model,
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    sessionId = created.data?.id;
    if (!sessionId || created.data.model?.id !== model.id || created.data.model?.providerID !== model.providerID
        || created.data.model?.variant !== model.variant)
      throw new Error("OpenCodeが指定モデル/variantを保持していないため拒否しました");
    // prompt/generate-agent-loopは使わない。generateはツール実行のない一回のテキスト推論。
    const generated = await call("POST", `/api/session/${sessionId}/generate`, { prompt: req.prompt });
    result = { ok: true, text: generated.data.text, usage: generated.data.tokens || {}, modelUsed: req.model };
    return result;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    if (sessionId) {
      try { await call("POST", `/api/session/${sessionId}/interrupt`, undefined, true); } catch { /* deleteも試す */ }
      try { await call("DELETE", `/api/session/${sessionId}`, undefined, true); }
      catch {
        const warning = "OpenCode推論用セッションを削除できませんでした";
        if (result) result.warnings = [warning];
        if (originalError) originalError.message += `（${warning}）`;
      }
    }
  }
}
