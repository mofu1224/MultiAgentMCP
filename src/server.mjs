#!/usr/bin/env node
// MultiAgentMCP: モデルを固定しないサブエージェント実行基盤（stdio MCP サーバー）
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.mjs";
import { Registry } from "./registry.mjs";
import { RunLog } from "./runlog.mjs";
import { Runner } from "./runner.mjs";
import { loadAllowlist, allowedEntry } from "./allowlist.mjs";
import { CONTROL, runRequest, brokeredRequest } from "./control.mjs";
import { ChildControl } from "./child-control/control.mjs";
import { Sandbox } from "./sandbox.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { platformFeatures, platformNotice } from "./platform.mjs";
import { agentResult, agentState } from "./agent-response.mjs";

const cfg = loadConfig();
const log = new RunLog(cfg.dataDir);
const reg = new Registry(cfg, log);
await reg.init();
const runner = new Runner(cfg, reg, log);
const agents = new ChildControl(runner, { maxContextChars: cfg.policy.maxPromptChars,
  maxLiveSessions: cfg.policy.maxLiveSessions, maxJobs: cfg.policy.maxRetainedJobs, waitTimeouts: cfg.policy.waitTimeouts,
  idleSessionMs: cfg.policy.liveSessionIdleMs });
const sandbox = new Sandbox({ ...cfg.sandbox, coordinator: runner.coordinator });
const conversationField = { conversation_id: z.string().uuid().optional().describe("同じサーバーの完了した会話を継続するID") };
const agentRequest = runRequest.extend(conversationField);

const features = platformFeatures(process.platform, cfg.sandbox);
// 版はクローン先のpackage.jsonが正本。
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const server = new McpServer({ name: "multi-agent-mcp", version: VERSION }, {
  instructions: platformNotice(features) + readFileSync(path.join(ROOT, "PARENT_GUIDE.md"), "utf8"),
});
const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });
const safe = (fn) => async (args, extra) => { try { return await fn(args, extra); } catch (e) { return fail(e.message); } };
const progress = extra => {
  let sequence = 0;
  return event => {
    if (extra?._meta?.progressToken !== undefined)
      void extra.sendNotification({ method: "notifications/progress", params: {
        progressToken: extra._meta.progressToken, progress: ++sequence, message: event.stage,
      } }).catch(() => {});
  };
};

server.registerTool("list_providers", {
  description: "登録済みプロバイダーと利用可否・機能（ツール実行・権限範囲など）を返す",
  inputSchema: {},
}, safe(async () => reply({ providers: await reg.describeProviders() })));

server.registerTool("list_models", {
  description: "実行時に取得したモデル一覧（ID・対応Effort・既定Effortなど）を返す。モデル名はハードコードされていない",
  inputSchema: {
    provider: z.string().optional().describe("省略時は全プロバイダー"),
    refresh: z.boolean().optional().describe("キャッシュを無視して再取得"),
    include_hidden: z.boolean().optional(),
    include_disallowed: z.boolean().optional().describe("ユーザー未許可のモデルも含める（実行は不可）"),
  },
}, safe(async ({ provider, refresh, include_hidden, include_disallowed }) => {
  const ids = provider ? [provider] : [...reg.providers.keys()];
  const al = loadAllowlist();
  const out = {};
  for (const id of ids) {
    try {
      const r = await reg.models(id, { refresh });
      const reviewed = new Set(al.providers?.[id]?.reviewed || []);
      const models = r.models.map((m) => {
        const a = allowedEntry(al, id, m.id);
        const allowedEfforts = !a.allowed ? [] : a.efforts === "*" ? m.efforts : (m.efforts || a.efforts).filter((e) => a.efforts.includes(e));
        return { ...m, allowed: a.allowed, allowedEfforts, ...(!reviewed.has(m.id) && { unreviewed: true }) };
      });
      const newModels = models.filter((m) => m.unreviewed && !m.hidden).map((m) => m.id);
      out[id] = {
        fetchedAt: new Date(r.at).toISOString(),
        ...(r.error && { error: r.error, stale: r.stale }),
        ...(newModels.length && { notice: `ユーザー未確認のモデルがあります: ${newModels.join(", ")}（許可はユーザーが select-models（Windowsは.cmd、macOSは.command）で行う）` }),
        models: models.filter((m) => (include_hidden || !m.hidden) && (include_disallowed || m.allowed)),
      };
    } catch (e) { out[id] = { error: e.message, models: [] }; }
  }
  return reply(out);
}));

server.registerTool("run_agent", {
  description: `子を1件実行し完了を待つ。permission省略はfull-access（信頼する子向け・OSユーザー権限の範囲）。制限はread-only/workspace-write（実行先が対応する場合）${features.brokered ? "、敵対的な子にはrun_brokered_agent" : "。このOSにbrokeredは無い"}。指定モデル・Effort・権限を検証する`,
  inputSchema: agentRequest,
}, safe(async (args, extra) => reply(agentResult(await agents.run(args, {
  signal: extra?.signal, ...(args.notify_progress && { onProgress: progress(extra) }),
}), args))));

if (features.brokered) server.registerTool("run_brokered_agent", {
  description: "敵対的な子向け。認証をホスト推論ブローカーに保持し、全操作を認証/通信なしMXCで実行する。permission（read-only/workspace-write）は必須でfull-accessは不可。毎推論に許可・共有予算を適用し、通常CLI実行へ切替しない",
  inputSchema: brokeredRequest.extend(conversationField),
}, safe(async (args, extra) => reply(agentResult(await agents.run({ ...args, isolation: "brokered" }, {
  signal: extra?.signal, ...(args.notify_progress && { onProgress: progress(extra) }),
}), args))));

server.registerTool("run_agents_parallel", {
  description: "複数のサブエージェントを並列実行する（同時実行数はポリシー maxConcurrent で制限）。比較・分担・相互レビューに使う",
  inputSchema: z.object({ runs: z.array(agentRequest).min(1).max(10) }).strict(),
}, safe(async ({ runs }, extra) => {
  const onProgress = progress(extra);
  // 1件の受付失敗で他の実行結果を失わないよう、全件の結果またはエラーを順に返す。
  const settled = await Promise.allSettled(runs.map(async r => agentResult(
    await agents.run(r, { signal: extra?.signal, ...(r.notify_progress && { onProgress }) }), r,
  )));
  return reply({ results: settled.map(s => s.status === "fulfilled" ? s.value : { status: "rejected", error: s.reason?.message || String(s.reason) }) });
}));

server.registerTool("start_agent", {
  description: "子をバックグラウンド実行しjobId/conversationIdを即返す。通常の委譲に推奨。完了待ちはwait_agents、最終結果はget_agent（途中イベントは明示要求時のみ）。full-accessは会話ごとの子プロセスで継続（mode=native）",
  inputSchema: agentRequest,
}, safe(async args => reply(agents.start(args))));

server.registerTool("send_agent_message", {
  description: "完了した会話へ追加入力して新しいジョブを開始する。native会話は新しい入力だけを同じ子へ送る（過去入力を再送しない）。provider/cwd/権限/隔離方式は変更不可。モデル・Effortは毎回明示し再検証する。同時ターンは不可",
  inputSchema: runRequest.extend({ conversation_id: z.string().uuid() }),
}, safe(async args => reply(agents.start(args))));

server.registerTool("wait_agents", {
  description: "指定ジョブ（省略時は任意のジョブ）が終了するまで待つ。timeout_msは最小値未満を最小値へ補正し、最大値超過は拒否する。期限到達時はtimedOut=trueで戻る。終了通知（jobId/状態のみ）を返す",
  inputSchema: {
    job_ids: z.array(z.string().uuid()).max(20).optional(),
    timeout_ms: z.number().int().positive().optional(),
  },
}, safe(async (args, extra) => reply(await agents.waitAny(args, { signal: extra?.signal }))));

server.registerTool("get_agent", {
  description: "開始した子の状態と最終結果だけを取得する。途中イベントはinclude_events、使用量等はinclude_detailsを明示した場合だけ返す。本文は開始したサーバーのメモリに保持",
  inputSchema: { job_id: z.string().uuid(), after_event: z.number().int().nonnegative().optional(),
    include_events: z.boolean().optional().describe("進捗イベントとlastSequenceを返す。既定false"),
    include_details: z.boolean().optional().describe("使用量・実行メタデータを返す。既定false") },
}, safe(async ({ job_id, after_event, ...options }) => {
  if (after_event !== undefined && !options.include_events) throw new Error("after_eventにはinclude_events:trueが必要です");
  return reply(agentState(agents.get(job_id, after_event), options));
}));

server.registerTool("list_agents", {
  description: "このMCPサーバーが所有するジョブと会話ID・状態を返す（依頼・応答本文は含まない）",
  inputSchema: {},
}, safe(async () => reply({ agents: agents.list(), conversations: agents.conversations(), control: agents.status() })));

server.registerTool("cancel_agent", {
  description: "実行・待機中の子へ取消を要求する。取消要求だけで枠を返さず、終了後にget_agentで確定を確認する",
  inputSchema: { job_id: z.string().uuid() },
}, safe(async ({ job_id }) => reply(agents.cancel(job_id))));

server.registerTool("close_conversation", {
  description: "完了した会話を閉じる。native会話は子プロセスの終了を待って常駐枠を返し、履歴とジョブ結果を破棄する。実行中は取消と終了確認が先に必要",
  inputSchema: { conversation_id: z.string().uuid() },
}, safe(async ({ conversation_id }) => reply(await agents.close(conversation_id))));

// 隔離実行はWindows MXC、またはconfigでDockerを明示した場合だけ公開する。
if (features.isolatedCode) server.registerTool("sandbox_status", {
  description: "ネットワーク・ホストファイル・認証情報を渡さないJavaScript隔離実行環境の準備状態を確認する",
  inputSchema: {},
}, safe(async () => reply(await sandbox.available())));

if (features.isolatedCode) server.registerTool("run_isolated_code", {
  description: "非信頼JavaScriptを使い捨て隔離環境で実行する。Windows既定はMXC、明示設定したDockerも対応。CLI自体の隔離ではない。未準備なら拒否し自動切替しない",
  inputSchema: {
    code: z.string().min(1).max(100000),
    timeout_ms: z.number().int().positive().max(60000).optional(),
  },
}, safe(async (args, extra) => reply(await sandbox.run(args, { signal: extra?.signal, onProgress: progress(extra) }))));

server.registerTool("get_run", {
  description: "実行IDの記録（開始・終了）を返す",
  inputSchema: { run_id: z.string() },
}, safe(async ({ run_id }) => reply(log.read().filter((r) => r.runId === run_id))));

server.registerTool("usage_summary", {
  description: "プロバイダー/モデル別の実行回数・成否・所要時間・トークン等の使用量を集計する",
  inputSchema: { since: z.string().refine(s => !Number.isNaN(Date.parse(s)), "ISO日時で指定してください").optional().describe("ISO日時"), provider: z.string().optional() },
}, safe(async (a) => reply({ summary: log.summary(a), active: [...runner.active.values()] })));

server.registerTool("get_policy", {
  description: "現在の実行ポリシー（再帰上限・権限・タイムアウト・未指定時の挙動など）と呼び出し連鎖の状態を返す",
  inputSchema: {},
}, safe(async () => reply({ version: VERSION, release: "ソースクローン", root: ROOT, policy: cfg.policy, fixedControl: CONTROL, platform: features, configFile: cfg.configFile,
  session: { id: runner.sessionId, accepted: runner.accepted, occupied: runner.occupied },
  shared: runner.coordinator.status(),
  childControl: agents.status(),
  inherited: runner.inherited })));

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 30000).unref(); // 停止処理が応答しない場合もサーバー自体は終了する
  void Promise.allSettled([agents.shutdown(), sandbox.shutdown()]).finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
server.server.onclose = shutdown;
// ホストが終了してstdinが閉じた場合も子プロセスを残さず終了する（SDKのstdio transportはstdin終了を検知しない）。
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
await server.connect(new StdioServerTransport());
