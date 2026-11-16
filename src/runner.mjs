// サブエージェント実行：検証 → 再帰・ループ・権限・範囲チェック → 実行 → 構造化結果と記録。
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadAllowlist, allowedEntry } from "./allowlist.mjs";
import Ajv from "ajv";
import { CONTROL, runRequest, isolationError, effectivePermission } from "./control.mjs";
import { Coordinator } from "./coordinator.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { BrokeredAgent, protectedBrokerPaths, assertBrokeredScope } from "./brokered-agent.mjs";

const ENV_DEPTH = "MAMCP_DEPTH", ENV_CHAIN = "MAMCP_CHAIN", ENV_ROOT = "MAMCP_ROOT_ID", ENV_PARENT = "MAMCP_PARENT_RUN";

export class Runner {
  constructor(cfg, registry, log) {
    this.cfg = structuredClone(cfg); this.reg = registry; this.log = log;
    this.active = new Map();
    this.waiters = [];
    this.occupied = 0;
    this.accepted = 0;
    this.sessionId = randomUUID();
    this.coordinator = new Coordinator(cfg.dataDir, {
      maxConcurrent: Math.min(cfg.policy.maxConcurrent, CONTROL.maxConcurrent),
      maxCalls: cfg.policy.maxCallsPerRoot ?? 0, // 0 = 上限なし
    });
    this.ajv = new Ajv({ allErrors: false, strict: true, ownProperties: true });
    this.broker = new BrokeredAgent({ protectedPaths: protectedBrokerPaths(cfg) });
    // config で指定したAPIキー用の環境変数（openai-compatible の apiKeyEnv 等）は子CLIへ継承しない（値undefinedは起動時に除去される）。
    this.hiddenEnv = Object.fromEntries(Object.values(cfg.providers || {})
      .map(p => p?.apiKeyEnv).filter(k => typeof k === "string" && k).map(k => [k, undefined]));
    // このサーバー自体がサブエージェント内で起動された場合、親の深さ・連鎖を継承する
    this.inherited = {
      depth: Number(process.env[ENV_DEPTH] || 0),
      chain: safeJson(process.env[ENV_CHAIN]) || [],
      rootId: process.env[ENV_ROOT] || null,
      parentRun: process.env[ENV_PARENT] || null,
    };
  }

  async acquire(signal) {
    if (signal?.aborted) throw new Error("cancelled");
    if (this.occupied < Math.min(this.cfg.policy.maxConcurrent, CONTROL.maxConcurrent)) {
      this.occupied++;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal?.removeEventListener("abort", abort); resolve(); } };
      const abort = () => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("cancelled"));
      };
      this.waiters.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve(); // 枠を待機者へ移譲。occupiedは減らさない。
    else this.occupied--;
  }

  /** 実行前の検証。問題があれば {error} を返す。警告は warnings に積む */
  async validate(req) {
    const P = this.cfg.policy, warnings = [];
    const parsed = runRequest.safeParse(req);
    if (!parsed.success) return { error: `入力が固定スキーマに違反しています: ${parsed.error.message}` };
    if (this.inherited.depth !== 0 || this.inherited.rootId || this.inherited.parentRun)
      return { error: "子からの直接再帰呼び出しは禁止です。親の固定実行器へ要求を返してください" };
    const provider = this.reg.get(req.provider);
    const avail = await provider.available();
    if (!avail.ok) return { error: `プロバイダー ${req.provider} は利用不可: ${avail.reason}` };

    const depth = this.inherited.depth + 1;
    if (depth > P.maxDepth) return { error: `再帰上限に達しました（深さ ${depth} > maxDepth ${P.maxDepth}）` };

    const promptHash = hash(`${req.provider}|${req.model || ""}|${req.task}`);
    if (this.inherited.chain.some((c) => c.h === promptHash))
      return { error: "ループ検出: 呼び出し連鎖の上位に同一プロバイダー・モデル・タスクがあります" };

    const rootId = this.sessionId;

    // 省略権限は検証前に正規化し、待機後の再検証でも同じ規則で同じ実効値になる。
    const normalized = effectivePermission(req);
    if (normalized.error) return { error: normalized.error };
    const textOnly = provider.capabilities.tools === false && provider.capabilities.fileAccess === false;
    // ツールを持たないテキスト専用先では権限が作用しないため、省略時は読取扱いにする。
    const permission = textOnly && req.permission === undefined ? "read-only" : normalized.permission;
    if (!P.allowedPermissions.includes(permission)) return { error: `権限 ${permission} はポリシーで許可されていません（許可: ${P.allowedPermissions.join(", ")}）` };
    if (!provider.capabilities.permissions.includes(permission)) return { error: `プロバイダー ${req.provider} は権限 ${permission} に非対応（対応: ${provider.capabilities.permissions.join(", ")}）` };

    const usesTools = provider.capabilities.tools !== false || provider.capabilities.fileAccess !== false;
    if (usesTools && !req.cwd) return { error: "ツール実行可能な子には cwd の明示指定が必要です" };
    let cwd;
    if (req.cwd) {
      try { cwd = realpathSync(path.resolve(req.cwd)); } catch { return { error: `cwd が存在しません: ${path.resolve(req.cwd)}` }; }
      try { if (!statSync(cwd).isDirectory()) return { error: `cwd がディレクトリではありません: ${cwd}` }; } catch { return { error: `cwd が存在しません: ${cwd}` }; }
      if (!withinRoots(cwd, P.allowedCwdRoots)) return { error: `cwd が許可範囲外です: ${cwd}` };
    }
    if (req.isolation === "brokered") {
      if (process.platform !== "win32") return { error: "brokered隔離は検証済みWindows MXC専用です" };
      if (typeof provider.infer !== "function") return { error: "このプロバイダーにはツール無し推論ブローカーがありません" };
      assertBrokeredScope({ ...req, cwd }, this.broker.protectedPaths);
    } else if (req.max_steps !== undefined) return { error: "max_stepsはbrokered隔離専用です" };

    // モデル
    let model = req.model || null, modelInfo = null;
    if (!model) {
      return { error: "model が未指定です" };
    } else {
      const f = await this.reg.findModel(req.provider, model);
      modelInfo = f.model;
      if (f.error || !modelInfo) return { error: `モデル情報を確認できないため拒否しました: ${model}`, knownModels: f.known };
    }

    // ユーザー許可リスト（毎回ファイルから読むので、選択画面での変更が即時反映される）
    let allowEff = "*";
    {
      if (!model) return { error: "許可リスト運用中はモデルの明示指定が必須です" };
      const a = allowedEntry(loadAllowlist(), req.provider, model);
      if (!a.allowed) return { error: `モデル ${req.provider}/${model} はユーザーに許可されていません（list_models の allowed=true のものを選ぶ。許可の変更はユーザーが select-models（Windowsは.cmd、macOSは.command）で行う）` };
      allowEff = a.efforts;
    }

    // Effort（固定の選択肢を持たず、モデル情報から判定）
    let effort = req.effort || null;
    if (!Array.isArray(modelInfo?.efforts)) return { error: "モデル別Effort対応が不明なため実行を拒否しました" };
    if (!effort && modelInfo.efforts.length)
      return { error: `effort が未指定です（${model} の対応: ${modelInfo.efforts.join(", ")}${Array.isArray(allowEff) ? ` / 許可: ${allowEff.join(", ")}` : ""}）`, supportedEfforts: modelInfo.efforts };
    if (effort && Array.isArray(allowEff) && !allowEff.includes(effort))
      return { error: `Effort ${effort} は ${model} で許可されていません（許可: ${allowEff.join(", ") || "なし"}）`, supportedEfforts: allowEff };
    if (effort) {
      const efforts = modelInfo?.efforts;
      if (Array.isArray(efforts)) {
        if (!efforts.includes(effort)) {
          return { error: `Effort ${effort} は ${model} の対応範囲外です（対応: ${efforts.join(", ")}）`, supportedEfforts: efforts };
        }
      }
    }

    if (req.json_schema && !provider.capabilities.jsonSchema) return { error: `${req.provider} は json_schema に非対応` };
    let outputValidator;
    if (req.json_schema) {
      try { outputValidator = this.ajv.compile(req.json_schema); }
      catch { return { error: "json_schemaが不正または未対応です" }; }
    }
    const blocked = isolationError(provider);
    if (blocked) return { error: blocked };
    const isolation = req.isolation === "brokered" ? "brokered-mxc" : !usesTools ? "text-only"
      : permission === "full-access" ? "full-access" : "provider-native";
    if (isolation === "full-access") warnings.push("full-accessで実行します。OSユーザー権限の範囲でホストのファイル・認証・通信にアクセスでき、cwdは保護境界ではありません。敵対的な子にはbrokeredを使ってください");
    else if (usesTools && req.isolation !== "brokered") warnings.push("CLI標準制限で実行します。外部OS隔離・認証/通信の分離ではなく、信頼する子向けです");
    if (provider.type === "claude-cli" && isolation === "provider-native")
      warnings.push("Claudeのファイルツールはrestrictedで制限し、シェルは専用MXC実行器へ委譲します。Claude CLIプロセス自体は信頼境界の内側です");
    if (req.files?.length && !P.allowedCwdRoots.length) return { error: "ファイル転送にはallowedCwdRootsの明示設定が必要です" };

    const timeoutMs = Math.min(req.timeout_ms || P.defaultTimeoutMs, P.maxTimeoutMs, CONTROL.maxTimeoutMs);
    const prompt = this.buildPrompt(req, warnings);
    if (prompt.length > P.maxPromptChars) return { error: `プロンプトが上限 ${P.maxPromptChars} 文字を超えています（${prompt.length}）` };

    return { ok: true, provider, model, effort, permission, isolation, cwd, timeoutMs, prompt, promptHash, depth, rootId, warnings, outputValidator };
  }

  buildPrompt(req, warnings) {
    const parts = [];
    if (req.role) parts.push(`# 役割\n${req.role}`);
    parts.push(`# タスク\n${req.task}`);
    if (req.context) parts.push(`# 引き継ぎコンテキスト\n${req.context}`);
    for (const f of req.files || []) {
      let fp = path.resolve(req.cwd || process.cwd(), f);
      try {
        fp = realpathSync(fp);
        if (!withinRoots(fp, this.cfg.policy.allowedCwdRoots)) { warnings.push(`ファイル範囲外のため除外: ${fp}`); continue; }
        const st = statSync(fp);
        if (st.size > this.cfg.policy.maxFileBytes) { warnings.push(`サイズ超過のため除外: ${fp}`); continue; }
        parts.push(`# ファイル: ${fp}\n\`\`\`\n${readFileSync(fp, "utf8")}\n\`\`\``);
      } catch (e) { warnings.push(`ファイル読込失敗: ${fp} (${e.message})`); }
    }
    if (req.output_instructions) parts.push(`# 出力形式\n${req.output_instructions}`);
    else if (!req.json_schema) parts.push("# 最終報告\n最終回答には結論・成果物・検証結果・未確認事項または阻害要因だけを簡潔に記載する。途中の実況や試行履歴は記載しない。未実施の検証を成功として報告しない。");
    return parts.join("\n\n");
  }

  /**
   * execute: 子制御が渡す実行アダプター呼出し。共有枠の取得・再検証の後に呼ばれ、
   * 解決（停止確認）まで枠を解放しない。brokeredは常に既存ブローカーを使い、executeへ渡さない。
   */
  async run(req, { signal, onProgress, onPrepared, execute } = {}) {
    const runId = randomUUID();
    const cancelled = () => ({ runId, status: "cancelled", error: "実行がキャンセルされました" });
    const reject = v => ({ runId, status: "rejected", error: v.error, ...(v.knownModels && { knownModels: v.knownModels }), ...(v.supportedEfforts && { supportedEfforts: v.supportedEfforts }) });
    let held = false, reserved = false, queueSignal, deadlineSignal, deadline;
    try {
      if (signal?.aborted) return cancelled();
      const checked = await this.validate(req);
      if (checked.error) return reject(checked);
      // 同じ配置の全MCPプロセスで予算と枠を共有する。
      this.coordinator.reserve(runId);
      reserved = true;
      this.accepted++;
      onProgress?.({ stage: "waiting" });
      deadline = Date.now() + checked.timeoutMs;
      deadlineSignal = AbortSignal.timeout(checked.timeoutMs);
      queueSignal = AbortSignal.any([deadlineSignal, ...(signal ? [signal] : [])]);
      await this.acquire(queueSignal);
      held = true;
      if (signal?.aborted) return cancelled();
      while (!this.coordinator.tryAcquire(runId)) await delay(50, undefined, { signal: queueSignal });
      queueSignal.throwIfAborted();
      // 待機中の許可取消・一覧取得失敗を無視して起動しない。
      const v = await this.validate(req);
      if (v.error) return reject(v);
      if (signal?.aborted) return cancelled();
      queueSignal.throwIfAborted();
      v.timeoutMs = Math.min(v.timeoutMs, Math.max(1, deadline - Date.now()));
      const started = Date.now(), startedAt = new Date(started).toISOString();
      onPrepared?.(v.prompt);
      onProgress?.({ stage: "running" });
      const base = { runId, rootId: v.rootId, parentRun: null, depth: v.depth, provider: req.provider, modelRequested: v.model, effort: v.effort, permission: v.permission, isolation: v.isolation };
      this.log.append({ ...base, phase: "start", startedAt });
      this.active.set(runId, { ...base, startedAt });
      const timedSignal = deadlineSignal;
      const executionSignal = queueSignal;
      let res;
      try {
        const execution = { model: v.model, effort: v.effort, prompt: v.prompt, cwd: v.cwd,
          permission: v.permission, timeoutMs: v.timeoutMs, jsonSchema: req.json_schema,
          env: { ...this.hiddenEnv, [ENV_DEPTH]: "1", [ENV_ROOT]: v.rootId, [ENV_PARENT]: runId, [ENV_CHAIN]: "[]" },
          signal: executionSignal, onProgress };
        if (req.isolation === "brokered") {
          res = await this.broker.run({ ...execution,
            infer: args => v.provider.infer(args), maxSteps: req.max_steps }, {
            signal: executionSignal, onProgress,
            charge: () => this.coordinator.charge(),
            revalidate: async () => {
              const check = await this.validate(req);
              if (check.error) throw new Error(check.error);
            },
          });
        } else res = execute ? await execute(execution, v) : await v.provider.run(execution);
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      const timedOut = !!(timedSignal.aborted || res.timedOut || res.proc?.timedOut);
      const aborted = !!(signal?.aborted || (!timedOut && res.proc?.aborted));
      let structured = res.structured;
      // 実行自体が失敗した場合は本来のエラーを残し、Schema不適合で上書きしない。
      if (req.json_schema && res.ok) {
        if (structured === undefined) try { structured = JSON.parse(res.text); } catch { /* 下で拒否 */ }
        if (structured === undefined || !v.outputValidator(structured)) {
          res.ok = false;
          res.error = "モデル出力が指定されたJSON Schemaに適合しません";
          structured = undefined;
        }
      }
      const result = {
        runId, rootId: v.rootId, isolation: v.isolation, status: aborted ? "cancelled" : timedOut ? "timeout" : res.ok ? "succeeded" : "failed",
        provider: req.provider, modelRequested: v.model, modelUsed: res.modelUsed || null,
        effort: v.effort, permission: v.permission, depth: v.depth,
        durationMs: Date.now() - started, output: res.text ?? "",
        ...(structured !== undefined && { structured }), usage: res.usage || {},
        toolUsage: res.toolUsage || {},
        ...(res.isolationEvidence && { isolationEvidence: res.isolationEvidence }),
        ...(res.brokerSteps && { brokerSteps: res.brokerSteps }),
        ...(res.effective && { effective: res.effective }),
        ...(res.error && { error: String(res.error).slice(0, 4000) }),
        ...((v.warnings.length || res.warnings?.length) && { warnings: [...v.warnings, ...(res.warnings || [])] }),
      };
      this.log.append({ ...base, phase: "end", endedAt: new Date().toISOString(),
        ok: result.status === "succeeded", status: result.status, timedOut,
        modelUsed: result.modelUsed, usage: result.usage, durationMs: result.durationMs });
      return result;
    } catch (e) {
      if (signal?.aborted) return cancelled();
      if (queueSignal?.aborted) return { runId, status: "timeout", error: "共有実行枠の待機がタイムアウトしました" };
      return reject({ error: e.message });
    } finally {
      this.active.delete(runId);
      if (held) this.release();
      if (reserved) this.coordinator.release(runId);
    }
  }
}

function hash(s) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function withinRoots(p, roots) {
  if (!roots?.length) return true;
  const norm = (x) => (process.platform === "win32" ? path.resolve(x).toLowerCase() : path.resolve(x));
  return roots.some((r) => {
    let root;
    try { root = realpathSync(r); } catch { return false; } // 存在しない許可ルートは一致しないだけで、他のルートの判定を妨げない
    const rel = path.relative(norm(root), norm(p));
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}
