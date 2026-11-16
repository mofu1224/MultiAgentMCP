// Claude向け実行アダプター（full-access会話）。公式CLIの `--input-format stream-json` を会話ごとの長寿命プロセスとして使い、
// 同じプロセスへ新しいユーザー入力だけを送って継続する。--no-session-persistenceでディスクに会話を保存しない。
// 取消は制御要求 interrupt。モデル変更はset_model、Effort変更は未対応。
import { randomUUID } from "node:crypto";
import { spawnLongLived } from "../proc.mjs";
import { awaitTurn, lineReader } from "./session.mjs";
import { sameClaudeModel } from "../providers/claude-models.mjs";

export function buildClaudeStreamArgs({ model, effort }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions",
    // 子から別のMCP（このMultiAgentMCPを含む）へ再委譲しない。標準ツールは既定のまま使う。
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--model", model];
  if (effort) args.push("--effort", effort);
  return args;
}

/** 構造化出力はプロセス単位のため、ターンごとのSchemaは指示＋Runner側のJSON Schema検証で扱う。 */
export function withSchemaInstruction(prompt, jsonSchema) {
  if (!jsonSchema) return prompt;
  return `${prompt}\n\n# 出力の厳守事項\n最終応答は次のJSON Schemaに適合するJSONオブジェクトだけを出力する（前後に文章やコードフェンスを付けない）。\n${JSON.stringify(jsonSchema)}`;
}

export async function openClaudeSession({ command = "claude", prefixArgs = [], model, effort, cwd, permission, env }) {
  if (permission !== "full-access") throw new Error("Claude stream-jsonアダプターはfull-access会話専用です");
  const proc = spawnLongLived({ command, args: [...prefixArgs, ...buildClaudeStreamArgs({ model, effort })], cwd, env });
  let closed = false, current = null, init = null, stderrTail = "", activeModel = model, dead = null;
  const controls = new Map();
  proc.child.stderr.setEncoding("utf8");
  proc.child.stderr.on("data", d => { stderrTail = (stderrTail + d).slice(-2000); });
  proc.exited.then(exit => {
    // 待機中に終了した場合も記録し、次のターンを期限まで待たせず即座に失敗させる。
    dead = `claudeが終了しました (${exit.code ?? exit.signal ?? exit.error}) ${stderrTail.slice(-300)}`;
    if (!closed) current?.reject(new Error(dead));
    for (const resolve of [...controls.values()]) resolve({ subtype: "closed" });
  });
  const send = message => proc.child.stdin.write(`${JSON.stringify(message)}\n`);
  /** 制御要求を送り、対応するcontrol_responseを待つ。期限内に応答が無ければ失敗。 */
  const control = (request, timeoutMs = 15000) => new Promise(resolve => {
    const id = randomUUID();
    const timer = setTimeout(() => { controls.delete(id); resolve({ subtype: "timeout" }); }, timeoutMs);
    controls.set(id, response => { clearTimeout(timer); controls.delete(id); resolve(response); });
    send({ type: "control_request", request_id: id, request });
  });

  lineReader(proc.child.stdout, line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "control_response") { controls.get(ev.response?.request_id)?.(ev.response); return; }
    if (ev.type === "system" && ev.subtype === "init") {
      init = { model: ev.model ?? null, permissionMode: ev.permissionMode ?? null, sessionId: ev.session_id ?? null };
      if (current && !current.verified) {
        current.verified = true;
        const problems = [];
        if (!sameClaudeModel(init.model, current.model) && !String(init.model).startsWith(current.model)) problems.push(`model=${init.model}`);
        if (init.permissionMode !== "bypassPermissions") problems.push(`permissionMode=${init.permissionMode}`);
        if (problems.length) {
          current.mismatch = `実効設定が要求と一致しません: ${problems.join(", ")}`;
          send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
        }
      }
      current?.onEvent?.({ turnId: current.turnId, type: "turn_started" });
      return;
    }
    if (!current) return; // ターン外の出力は状態へ反映しない
    const emit = event => current.onEvent?.({ turnId: current.turnId, ...event });
    for (const block of ev.message?.content || []) {
      if (block.type === "tool_use" && ["Bash", "PowerShell"].includes(block.name)) current.shell.add(block.id);
      if (block.type === "tool_result" && current.shell.has(block.tool_use_id) && !block.is_error) current.toolUsage.successfulShellCalls++;
    }
    if (ev.type === "assistant") emit({ type: "item_completed", itemType: "assistant" });
    if (ev.type === "result") {
      current.toolUsage.shellCalls = current.shell.size;
      const modelUsage = ev.modelUsage || {};
      const base = { text: ev.result ?? "", structured: ev.structured_output,
        usage: { ...(ev.usage || {}), total_cost_usd_equivalent: ev.total_cost_usd, num_turns: ev.num_turns },
        // modelUsageは会話の累計のため、このターンのモデルは照合済みのinit応答から取る。
        modelUsed: init?.model || current.model, modelsObserved: Object.keys(modelUsage) };
      if (current.mismatch) {
        emit({ type: "turn_completed", error: current.mismatch });
        current.resolve({ ...base, ok: false, error: current.mismatch, broken: current.mismatch });
      } else if (current.interrupted) {
        emit({ type: "turn_aborted", reason: "interrupted" });
        current.resolve({ ...base, ok: false, aborted: true, error: "中断されました" });
      } else if (ev.is_error || ev.subtype !== "success") {
        const error = ev.result || ev.subtype || "error";
        emit({ type: "turn_completed", error });
        current.resolve({ ...base, ok: false, error: String(error) });
      } else {
        emit({ type: "turn_completed" });
        current.resolve({ ...base, ok: true });
      }
    }
  });

  const close = async () => {
    if (!closed) {
      closed = true;
      current?.reject(new Error("セッションを終了しました"));
      for (const resolve of [...controls.values()]) resolve({ subtype: "closed" });
    }
    await proc.stop();
  };

  return {
    // モデル切替は制御要求set_modelで実機確認済み。Effort切替の制御要求は未確認のため非対応。
    capabilities: { nativeContinuation: true, modelSwitch: true, effortSwitch: false, jsonSchema: "prompt-validated",
      persistence: "none（--no-session-persistence。プロセス内のみ）" },
    get effective() {
      return { model: init?.model ?? "unreported", effort: effort ? `${effort}（CLI引数。init応答で未報告）` : null,
        permissionMode: init?.permissionMode ?? "unreported", continuation: "native-process", verifiedBy: "system/init" };
    },
    async turn({ turnId, prompt, model: turnModel, effort: turnEffort, jsonSchema, signal, interruptGraceMs, onEvent }) {
      if (closed) throw new Error("セッションは終了しています");
      if (current) throw new Error("同じ会話で同時ターンは実行できません");
      if (dead || !proc.alive) { const reason = dead || "claudeが終了しています"; return { ok: false, error: reason, broken: reason }; }
      if (turnEffort !== effort) return { ok: false, error: "この実行先は会話中のEffort変更に未対応です" };
      if (turnModel !== activeModel) {
        const switched = await control({ subtype: "set_model", model: turnModel });
        if (switched.subtype !== "success" || !sameClaudeModel(switched.response?.model, turnModel))
          return { ok: false, error: `モデルを切り替えられませんでした（${switched.error || switched.subtype}）。会話は以前のモデルのままです` };
        activeModel = turnModel;
      }
      let resolveEnded, rejectEnded;
      const ended = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
      // 毎ターンのinit応答で実効モデル・権限を照合する（切替後も要求どおりかを確認）。
      current = { turnId, model: activeModel, onEvent, verified: false, interrupted: false, mismatch: null, shell: new Set(),
        toolUsage: { shellCalls: 0, successfulShellCalls: 0 }, resolve: resolveEnded, reject: rejectEnded };
      const state = current;
      try {
        send({ type: "user", message: { role: "user", content: withSchemaInstruction(prompt, jsonSchema) } });
        const result = await awaitTurn(ended, { signal, graceMs: interruptGraceMs,
          interrupt: () => {
            state.interrupted = true;
            send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
          },
          kill: close });
        return { ...result, toolUsage: state.toolUsage, effective: this.effective };
      } finally {
        if (current === state) current = null;
      }
    },
    close,
  };
}
