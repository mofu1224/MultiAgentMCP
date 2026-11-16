// OpenAI/Codex向け実行アダプター（full-access会話）。公式CLIの `codex app-server`（JSON-RPC over stdio）を
// 会話ごとの長寿命プロセスとして使い、thread/start（ephemeral）→ turn/start → turn/interrupt で継続・取消する。
// これはCodex向けの接続方式であり、共通の子制御をapp-serverへ依存させるものではない。
import { spawnLongLived, runProcess } from "../proc.mjs";
import { awaitTurn, lineReader } from "./session.mjs";
import { readFileSync } from "node:fs";

const CLIENT = { name: "multiagentmcp", title: null,
  version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version };

/** CLIが解決した一覧を使い、TOMLの記法・プロファイル・プロジェクト設定を独自解釈しない。 */
export function parseCodexMcpNames(stdout) {
  let rows;
  try { rows = JSON.parse(stdout); } catch { throw new Error("CodexのMCP設定一覧を解析できません"); }
  if (!Array.isArray(rows) || !rows.every(r => r && typeof r.name === "string" && r.name))
    throw new Error("CodexのMCP設定一覧の形式が不正です");
  return [...new Set(rows.map(r => r.name))];
}

const DISABLED_FEATURES = ["plugins", "apps", "computer_use", "hooks"].flatMap(f => ["--disable", f]);

export function buildAppServerArgs(mcpServers = []) {
  // 承認は常に不要、内部のマルチエージェントは無効（子からの再委譲をしない）。
  // ユーザーのMCP（multi-agent自身・画面操作系を含む）・プラグイン・アプリ・画面操作・フック・通知は子へ持ち込まない
  // （restrictedの `codex exec --ignore-user-config`、Claudeの空MCPと同じ扱い）。
  return ["app-server", "-c", 'approval_policy="never"', "-c", "agents.enabled=false",
    ...DISABLED_FEATURES, "-c", "notify=[]",
    ...mcpServers.flatMap(name => {
      // -cのドット区切りは引用符を解釈しないため、名前はそのまま渡す。ドットを含む名前は無効化できないので起動しない。
      if (name.includes(".")) throw new Error(`Codexのユーザー設定のMCPサーバー「${name}」を子で無効化できません（名前にドットを含む）`);
      return ["-c", `mcp_servers.${name}.enabled=false`];
    })];
}

export function threadStartParams({ model, effort, cwd }) {
  return { model, cwd, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true,
    ...(effort && { config: { model_reasoning_effort: effort } }) };
}

/** thread/start応答の実効値を要求と照合する。不一致は失敗として返し、別設定で続行しない。 */
export function verifyThreadStart(response, { model, effort }) {
  const sandbox = response?.sandbox?.type ?? response?.sandbox ?? null;
  const effective = { model: response?.model ?? null, effort: response?.reasoningEffort ?? null,
    sandbox, approvalPolicy: response?.approvalPolicy ?? null, ephemeral: response?.thread?.ephemeral ?? null };
  const problems = [];
  if (effective.model !== model) problems.push(`model=${effective.model}`);
  if (effort && effective.effort !== effort) problems.push(`effort=${effective.effort}`);
  if (!/^danger-?full-?access$/i.test(String(sandbox))) problems.push(`sandbox=${JSON.stringify(sandbox)}`);
  if (effective.approvalPolicy !== "never") problems.push(`approvalPolicy=${JSON.stringify(effective.approvalPolicy)}`);
  if (effective.ephemeral !== true) problems.push(`ephemeral=${effective.ephemeral}`);
  return { effective, problems };
}

export async function openCodexSession({ command = "codex", prefixArgs = [], model, effort, cwd, permission, env, signal }) {
  if (permission !== "full-access") throw new Error("codex app-serverアダプターはfull-access会話専用です");
  const configured = await runProcess({ command, args: [...prefixArgs, ...DISABLED_FEATURES, "mcp", "list", "--json"],
    cwd, env, signal, timeoutMs: 15000 });
  if (configured.code !== 0 || configured.aborted || configured.timedOut)
    throw new Error("CodexのMCP設定を確認できないため子を起動しません");
  const mcpServers = parseCodexMcpNames(configured.stdout);
  signal?.throwIfAborted();
  const proc = spawnLongLived({ command, args: [...prefixArgs, ...buildAppServerArgs(mcpServers)], cwd, env });
  let nextId = 1, closed = false, threadId = null, current = null, stderrTail = "", dead = null;
  const pending = new Map(), nativeToOurs = new Map();
  const fail = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    current?.reject(error);
  };
  proc.child.stderr.setEncoding("utf8");
  proc.child.stderr.on("data", d => { stderrTail = (stderrTail + d).slice(-2000); });
  proc.exited.then(exit => {
    // 待機中に終了した場合も記録し、以後の要求を期限まで待たせず即座に失敗させる。
    dead = `codex app-serverが終了しました (${exit.code ?? exit.signal ?? exit.error}) ${stderrTail.slice(-300)}`;
    if (!closed) fail(new Error(dead));
  });
  const send = message => proc.child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("セッションは終了しています"));
    if (dead) return reject(new Error(dead));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

  const onNotification = (method, params) => {
    const native = params?.turnId ?? params?.turn?.id ?? null;
    if (!current) return;
    if (native && current.nativeId === null) { current.buffer.push([method, params]); return; }
    const ours = native ? nativeToOurs.get(native) : current.turnId;
    const emit = event => current.onEvent?.({ turnId: ours ?? "unknown", ...event });
    if (native && native !== current.nativeId) { emit({ type: "late", method }); return; }
    switch (method) {
      case "turn/started": emit({ type: "turn_started" }); break;
      case "item/completed":
        if (params.item?.type === "agentMessage") current.lastMessage = params.item.text ?? "";
        if (params.item?.type === "commandExecution") {
          current.toolUsage.shellCalls++;
          if (params.item.exitCode === 0 || params.item.exit_code === 0) current.toolUsage.successfulShellCalls++;
        }
        emit({ type: "item_completed", itemType: params.item?.type });
        break;
      case "thread/tokenUsage/updated": current.usage = params.tokenUsage?.total ?? current.usage; break;
      case "error": if (!params.willRetry) current.errors.push(params.error?.message || "unknown error"); break;
      case "turn/completed": {
        const turn = params.turn || {};
        if (turn.status === "interrupted") {
          emit({ type: "turn_aborted", reason: "interrupted" });
          current.resolve({ ok: false, aborted: true, error: "中断されました" });
        } else if (turn.status === "completed" && !current.errors.length) {
          emit({ type: "turn_completed", lastMessage: null });
          current.resolve({ ok: true });
        } else {
          const error = turn.error?.message || current.errors.join("\n") || `turn status=${turn.status}`;
          emit({ type: "turn_completed", error });
          current.resolve({ ok: false, error });
        }
        break;
      }
      default: break;
    }
  };

  lineReader(proc.child.stdout, line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      // 承認neverのため承認要求は想定外。自動承認せず拒否を返す。
      send({ id: message.id, error: { code: -32601, message: "multiagentmcp: server requests are not supported" } });
    } else if (message.method) onNotification(message.method, message.params);
  });

  const close = async () => {
    if (!closed) {
      closed = true;
      fail(new Error("セッションを終了しました"));
    }
    await proc.stop();
  };

  let started;
  let onStartupAbort;
  try {
    const abort = new Promise((_, reject) => {
      if (signal?.aborted) reject(new Error("cancelled"));
      onStartupAbort = () => reject(new Error("cancelled"));
      signal?.addEventListener("abort", onStartupAbort, { once: true });
    });
    await Promise.race([request("initialize", { clientInfo: CLIENT }), abort]);
    send({ method: "initialized" });
    started = await Promise.race([request("thread/start", threadStartParams({ model, effort, cwd })), abort]);
    threadId = started?.thread?.id;
    const { problems } = verifyThreadStart(started, { model, effort });
    if (!threadId) problems.push("thread.idなし");
    if (problems.length) throw new Error(`実効設定が要求と一致しません: ${problems.join(", ")}`);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onStartupAbort);
  }
  const opened = verifyThreadStart(started, { model, effort }).effective;

  return {
    capabilities: { nativeContinuation: true, modelSwitch: true, effortSwitch: true, jsonSchema: "native",
      persistence: "ephemeral（app-serverのthread/start ephemeral=true。プロセス内のみ）" },
    effective: { ...opened, continuation: "native-process", verifiedBy: "thread/start応答" },
    async turn({ turnId, prompt, model: turnModel, effort: turnEffort, jsonSchema, signal: turnSignal, interruptGraceMs, onEvent }) {
      if (closed) throw new Error("セッションは終了しています");
      if (current) throw new Error("同じ会話で同時ターンは実行できません");
      if (dead || !proc.alive) { const reason = dead || "codex app-serverが終了しています"; return { ok: false, error: reason, broken: reason }; }
      let resolveEnded, rejectEnded;
      const ended = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
      ended.catch(() => {}); // turn/start応答前に終了した場合も未処理のrejectionを作らない
      current = { turnId, nativeId: null, buffer: [], onEvent, lastMessage: "", usage: {}, errors: [],
        toolUsage: { shellCalls: 0, successfulShellCalls: 0 }, resolve: resolveEnded, reject: rejectEnded };
      const state = current;
      const startTurn = async () => {
        const response = await request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }],
          model: turnModel, ...(turnEffort && { effort: turnEffort }), ...(jsonSchema && { outputSchema: jsonSchema }) });
        state.nativeId = response?.turn?.id ?? null;
        if (!state.nativeId) throw new Error("turn/start応答にturn.idがありません");
        // 遅延通知の識別に直前のターンだけ残し、長寿命会話で対応表を増やし続けない。
        if (nativeToOurs.size >= 2) nativeToOurs.delete(nativeToOurs.keys().next().value);
        nativeToOurs.set(state.nativeId, turnId);
        for (const [method, params] of state.buffer.splice(0)) onNotification(method, params);
      };
      // turn/startの拒否（未対応モデル等）はプロセスが生きていれば会話を壊さず失敗として返す。
      const run = startTurn().then(() => ended,
        error => !closed && proc.alive ? { ok: false, error: `turn/startが拒否されました: ${error.message}` } : Promise.reject(error));
      try {
        const result = await awaitTurn(run, { signal: turnSignal, graceMs: interruptGraceMs,
          interrupt: async () => {
            if (!state.nativeId) await new Promise(resolve => setTimeout(resolve, 200));
            if (state.nativeId) await request("turn/interrupt", { threadId, turnId: state.nativeId });
          },
          kill: close });
        return { ...result, text: state.lastMessage, usage: state.usage, toolUsage: state.toolUsage,
          modelUsed: turnModel, effective: { ...opened, model: turnModel, effort: turnEffort ?? opened.effort,
            continuation: "native-process", turnOverride: "turn/start引数で指定（応答による確認なし）" } };
      } finally {
        if (current === state) current = null;
      }
    },
    close,
  };
}
