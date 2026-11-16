// Codex由来の子実行制御（状態遷移の唯一の所有者）。
// 移植元: openai/codex@b1573f1 codex-rs/core/src/agent/control.rs・control/{api,interrupt,completion,spawn_guard}.rs、
// tools/handlers/multi_agents_v2/wait.rs（Apache-2.0）。対応表は ./README.md。
// 置換: CodexThread/ThreadManager → 実行アダプターのセッション、親provider継承 → 親が明示したprovider/model/effort、
// 実行枠 → 既存Runner/Coordinator（共有SQLite枠。原典の即時拒否ではなく待機）。
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "./registry.mjs";
import { Mailboxes } from "./mailbox.mjs";
import { StatusChannel } from "./watch.mjs";
import { AgentRuntime, RuntimeShuttingDown } from "./runtime.mjs";
import { AgentStatus, statusFromEvent } from "./status.mjs";
import { effectivePermission } from "../control.mjs";

const ROOT = "root"; // MCPの親（原典のroot thread）宛ての受信箱
const MAX_EVENTS = 300;
const CONTEXT_LIMIT = 400000; // control.mjs の context スキーマ上限と同じ

/** 原典 spawn_guard.rs の PendingSpawn: 確定（disarm）前に失敗したら必ず子を停止する。 */
class PendingSpawn {
  #session = null;
  #armed = true;
  constructor(guard) { this.guard = guard; }
  hold(session) { this.#session = session; }
  disarm() { this.#armed = false; this.guard.complete(); return this.#session; }
  async cleanup() {
    if (!this.#armed) return;
    this.#armed = false;
    if (this.#session) {
      try { await this.#session.close(); }
      catch (error) {
        this.guard.recordFailure("stop_child", error.message);
        this.guard.complete();
        return { session: this.#session, error: error.message };
      }
    }
    this.guard.complete();
  }
}

export class ChildControl {
  constructor(runner, { maxLiveSessions = 6, maxJobs = 100, maxContextChars = 400000,
    waitTimeouts = { minMs: 100, defaultMs: 30000, maxMs: 300000 }, interruptGraceMs = 5000,
    idleSessionMs = 1800000, resolveProvider } = {}) {
    this.runner = runner;
    // 本運用で親が閉じ忘れても止まらないよう、常駐プロセスと保持ジョブは古い順に自動で空ける（原典のresidency相当を簡略化）。
    this.idleSessionMs = idleSessionMs;
    this.closingSessions = new Set();
    this.evictions = 0;
    this.idleTimer = setInterval(() => { void this.evictIdle(); }, Math.min(60000, Math.max(1000, idleSessionMs / 2)));
    this.idleTimer.unref?.();
    this.resolveProvider = resolveProvider || (id => runner.reg?.get(id));
    this.maxLiveSessions = maxLiveSessions;
    this.maxJobs = maxJobs;
    this.maxContextChars = maxContextChars;
    this.waitTimeouts = waitTimeouts;
    this.interruptGraceMs = interruptGraceMs;
    this.registry = new AgentRegistry();
    this.mailboxes = new Mailboxes();
    this.runtime = new AgentRuntime();
    this.agents = new Map();
    this.jobs = new Map();
  }

  // ---- 状態・イベント ----
  #event(job, data) {
    const event = { sequence: ++job.sequence, at: new Date().toISOString(), ...data };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.shift();
    try { job.onProgress?.(event); } catch { /* 通知失敗で実行を再試行しない */ }
  }
  #progress(agent, job, progress) {
    if (job.result) return;
    if (progress.stage === "waiting" && job.status === "accepted") job.status = "queued";
    if (progress.stage === "running" && ["accepted", "queued"].includes(job.status)) job.status = "running";
    this.#event(job, progress);
  }
  /** アダプター通知。現在のターン以外（遅延通知）は状態にも結果にも反映しない。 */
  #adapterEvent(agent, event) {
    if (!event || event.turnId !== agent.currentTurnId) { agent.droppedLateEvents++; return; }
    const next = statusFromEvent(event);
    if (next) agent.status.set(next);
    const job = this.jobs.get(agent.currentJobId);
    if (job && !job.result) this.#event(job, { stage: `adapter:${event.type}`, ...(event.itemType && { item: event.itemType }) });
  }

  #mode(req) {
    if (req.isolation === "brokered") return "replay";
    const normalized = effectivePermission(req);
    if (normalized.error || normalized.permission !== "full-access") return "replay";
    let provider;
    try { provider = this.resolveProvider(req.provider); } catch { return "replay"; }
    return typeof provider?.openSession === "function" ? "native" : "replay";
  }

  // ---- 自動で空ける（常駐プロセス・保持ジョブ・会話記録） ----
  /** 常駐プロセスだけを解放する。会話は残し、継続要求には明確な理由を返す。 */
  #evict(agent, reason) {
    agent.closing = true;
    agent.broken = reason;
    agent.evicted = true;
    agent.status.set({ status: AgentStatus.Shutdown });
    this.evictions++;
    const closing = this.#stopSession(agent, "evict").finally(() => {
      agent.closing = false;
      this.closingSessions.delete(closing);
    });
    this.closingSessions.add(closing);
    return closing;
  }
  #idleSessions() {
    return [...this.agents.values()].filter(a => (a.session || a.failedSession) && a.committed && !a.busy && !a.closing)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }
  /** 一定時間使われていない常駐プロセスを解放する（定期実行）。 */
  async evictIdle(now = Date.now()) {
    const closing = [];
    for (const agent of this.#idleSessions())
      if (now - agent.lastUsedAt >= this.idleSessionMs)
        closing.push(this.#evict(agent, `${Math.round(this.idleSessionMs / 60000)}分以上使われなかったため子プロセスを解放しました`));
    await Promise.allSettled(closing);
  }
  /** 常駐上限に達していたら、最も長く使われていない会話の子プロセスを解放して枠を作る。 */
  async #makeRoomForSession() {
    while (this.registry.total >= this.maxLiveSessions) {
      const oldest = this.#idleSessions()[0];
      if (!oldest) return; // 全て実行中なら空けない（上限エラーを返す）
      const stopped = await this.#evict(oldest, `常駐上限（${this.maxLiveSessions}）のため、最も長く使われていない会話の子プロセスを解放しました`);
      if (stopped === "failed") return; // 停止未確認の子を上限外へ追い出さない
    }
  }
  /** 終わったジョブを古い順に捨てる。実行中のジョブは捨てない。 */
  #pruneJobs() {
    const removed = new Set();
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < this.maxJobs) break;
      if (job.result) { this.jobs.delete(id); removed.add(id); }
    }
    if (removed.size) this.mailboxes.take(ROOT, notice => removed.has(notice.jobId)); // 破棄したジョブの古い終了通知を残さない
    // ジョブも常駐プロセスも無い古い会話記録も上限内に保つ
    if (this.agents.size > this.maxJobs) {
      const referenced = new Set([...this.jobs.values()].map(j => j.conversationId));
      for (const [id, agent] of this.agents) {
        if (this.agents.size <= this.maxJobs) break;
        if (!agent.session && !agent.failedSession && !agent.committed && !agent.busy && !agent.closing && !agent.reservation?.active && !referenced.has(id)) this.agents.delete(id);
      }
    }
  }

  // ---- 開始・継続（原典 api.rs の spawn / send） ----
  start(input, { onProgress, notify = true } = {}) {
    if (this.runtime.closed) throw new RuntimeShuttingDown();
    this.#pruneJobs();
    if (this.jobs.size >= this.maxJobs) throw new Error(`実行中のジョブが保持上限（${this.maxJobs}）に達しています。完了を待ってください`);
    const { conversation_id, ...req } = structuredClone(input);
    let agent = conversation_id ? this.agents.get(conversation_id) : null;
    const normalized = effectivePermission(req);
    if (conversation_id) {
      if (!agent) throw new Error("会話が存在しません（再起動後の会話は継続できません）");
      if (agent.closing) throw new Error("この会話は終了処理中です");
      if (agent.busy) throw new Error("この会話は実行中です。完了または取消の確定を待ってください");
      if (agent.broken) throw new Error(`この会話は継続できません（${agent.broken}）。新しい会話を開始してください`);
      if (agent.exhausted) throw new Error("会話履歴の上限です。要約を渡して新しい会話を開始してください");
      if (agent.provider !== req.provider || agent.cwd !== req.cwd)
        throw new Error("会話のprovider/cwdを変更できません。新しい会話を開始してください");
      if (agent.isolation !== req.isolation)
        throw new Error("会話の隔離方式を変更できません。brokered指定を省略して緩和しないでください");
      if (!normalized.error && agent.permission && normalized.permission !== agent.permission)
        throw new Error("会話の権限を変更できません。以前の権限で得た履歴を分離するため新しい会話を開始してください");
      const caps = agent.session?.capabilities;
      if (caps && req.model !== agent.model && !caps.modelSwitch)
        throw new Error("この実行先は会話中のモデル変更に未対応です。新しい会話を開始してください");
      if (caps && req.effort !== agent.effort && !caps.effortSwitch)
        throw new Error("この実行先は会話中のEffort変更に未対応です。新しい会話を開始してください");
    }
    const history = agent?.history || "";
    // replayでは履歴と新しいcontextを区切り（2文字）で連結し、入力スキーマの上限（CONTEXT_LIMIT）も超えない。
    const combined = history ? history.length + 2 + (req.context?.length || 0) : (req.context?.length || 0);
    if (combined > Math.min(this.maxContextChars, CONTEXT_LIMIT))
      throw new Error("会話コンテキストの上限です。必要な要約を渡して新しい会話を開始してください");
    if (!agent) {
      agent = { id: randomUUID(), mode: this.#mode(req), provider: req.provider, cwd: req.cwd,
        isolation: req.isolation, permission: normalized.permission ?? null, model: req.model, effort: req.effort,
        history: "", busy: false, session: null, reservation: null, committed: false, broken: null,
        exhausted: false, closing: false, droppedLateEvents: 0, currentTurnId: null, currentJobId: null,
        status: new StatusChannel({ status: AgentStatus.PendingInit }), createdAt: new Date().toISOString(), lastUsedAt: Date.now() };
      this.agents.set(agent.id, agent);
    }
    agent.lastUsedAt = Date.now();
    // 常駐枠の予約（原典 reserve_spawn_slot）は、検証と実行枠の確保を通った後、子プロセスを起動する直前に行う（#executeNative）。
    // 拒否される要求のために使用中の会話を解放しないため。
    const membership = this.runtime.admitStart();
    const jobId = randomUUID(), turnId = randomUUID();
    const job = { jobId, conversationId: agent.id, turnId, status: "accepted", createdAt: new Date().toISOString(),
      sequence: 0, events: [], ctrl: new AbortController(), onProgress, membership, notify };
    agent.busy = true;
    agent.currentTurnId = turnId;
    agent.currentJobId = jobId;
    this.jobs.set(jobId, job);
    this.#event(job, { stage: "accepted", mode: agent.mode });
    // 継続方式: nativeはアダプター会話へ新しい入力だけを渡す。replayは明示した履歴再送（制限権限・brokered・セッション非対応先）。
    const runReq = agent.mode === "replay" && history ? { ...req, context: `${history}\n\n${req.context || ""}` } : req;
    let prepared;
    let running;
    try {
      running = this.runner.run(runReq, { signal: job.ctrl.signal,
        onPrepared: prompt => { prepared = prompt; },
        onProgress: progress => this.#progress(agent, job, progress),
        ...(agent.mode === "native" && { execute: (execution, v) => this.#executeNative(agent, job, execution, v) }) });
    } catch (error) { running = Promise.reject(error); }
    job.promise = Promise.resolve(running)
      .catch(error => ({ status: "failed", error: error.message, output: "" }))
      .then(result => this.#finishTurn(agent, job, result, { prepared, input, history }));
    return { jobId, conversationId: agent.id, status: job.status, mode: agent.mode };
  }

  async #executeNative(agent, job, execution, v) {
    if (!agent.session) {
      if (!agent.reservation?.active) {
        await this.#makeRoomForSession(); // 停止確認後にだけ新しい子の枠を予約する
        try { agent.reservation = this.registry.reserveSpawnSlot(this.maxLiveSessions); }
        catch (error) { return { ok: false, error: error.message, proc: { aborted: false } }; }
      }
      let pending;
      try { pending = new PendingSpawn(this.runtime.admitStart().teardownGuard("open_session", agent.id)); }
      catch (error) { return { ok: false, error: error.message, proc: { aborted: true } }; }
      try {
        const session = await v.provider.openSession({ model: v.model, effort: v.effort, cwd: v.cwd,
          permission: v.permission, env: execution.env, signal: execution.signal });
        pending.hold(session);
        execution.signal.throwIfAborted();
        agent.session = pending.disarm();
        agent.reservation.commit({ agentId: agent.id, provider: agent.provider, mode: agent.mode, createdAt: agent.createdAt });
        agent.committed = true;
      } catch (error) {
        const failed = await pending.cleanup();
        if (failed) {
          agent.session = null;
          agent.failedSession = failed.session;
          agent.closeFailed = failed.error;
          agent.broken = "開始失敗後の子プロセスの停止を確認できません";
          agent.reservation.commit({ agentId: agent.id, provider: agent.provider, mode: agent.mode, createdAt: agent.createdAt });
          agent.committed = true;
        }
        return { ok: false, error: `子セッションを開始できません: ${error.message}`, proc: { aborted: execution.signal.aborted } };
      }
    }
    let res;
    try {
      res = await agent.session.turn({ turnId: job.turnId, prompt: execution.prompt, model: v.model, effort: v.effort,
        jsonSchema: execution.jsonSchema, signal: execution.signal, interruptGraceMs: this.interruptGraceMs,
        onEvent: event => this.#adapterEvent(agent, event) });
    } catch (error) {
      res = { ok: false, error: error.message, broken: `実行先との通信が失敗しました: ${error.message}` };
    }
    if (res.ok) { agent.model = v.model; agent.effort = v.effort; }
    if (res.broken) {
      // 実行器が壊れたら通常経路へ切り替えず、この会話だけを継続不能にする。
      agent.broken = res.broken;
      await this.#stopSession(agent, "broken_session");
    }
    return { ...res, proc: { aborted: !!res.aborted, timedOut: !!res.timedOut } };
  }

  #finishTurn(agent, job, result, { prepared, input, history }) {
    job.result = { ...result, jobId: job.jobId, conversationId: agent.id, mode: agent.mode };
    job.status = result.status;
    if (agent.mode === "replay") {
      if (result.status === "succeeded") {
        const turn = prepared
          ? `${prepared}\n\n# 過去の応答\n${result.output || ""}`
          : `${history}\n\n${input.role ? `# 過去の役割\n${input.role}\n` : ""}${input.context ? `# 過去のコンテキスト\n${input.context}\n` : ""}# 過去の依頼\n${input.task}\n# 過去の応答\n${result.output || ""}`;
        if (turn.length <= Math.min(this.maxContextChars, CONTEXT_LIMIT)) agent.history = turn;
        else { agent.history = ""; agent.exhausted = true; } // 黙って一部だけ切り捨てた会話を続けない
      }
      agent.status.set(result.status === "succeeded" ? { status: AgentStatus.Completed }
        : result.status === "cancelled" ? { status: AgentStatus.Interrupted }
        : { status: AgentStatus.Errored, message: result.error || result.status });
    } else if (!agent.session) {
      agent.reservation?.abandon(); // 開始できなかった常駐枠を返す（原典 SpawnReservation の Drop）
      if (agent.status.value.status === AgentStatus.PendingInit && result.status !== "succeeded")
        agent.status.set({ status: AgentStatus.Errored, message: result.error || result.status });
    }
    if (agent.mode === "native" && job.result.status !== "succeeded" && agent.status.value.status === AgentStatus.Running)
      agent.status.set(result.status === "cancelled" || result.status === "timeout"
        ? { status: AgentStatus.Interrupted } : { status: AgentStatus.Errored, message: result.error || result.status });
    this.#event(job, { stage: result.status });
    // 原典 completion.rs: 終端結果を親の受信箱へキュー（本文は含めずジョブIDと状態のみ）。
    // 同期実行（run）は呼出し元が結果を直接受け取るため、wait_agents用の通知を積まない。
    if (job.notify) {
      try { this.mailboxes.enqueue(ROOT, [{ jobId: job.jobId, conversationId: agent.id, status: result.status }]); }
      catch { /* 終了処理中 */ }
    }
    agent.busy = false;
    agent.lastUsedAt = Date.now();
    agent.currentTurnId = null; // 以降に届く当該ターンの通知は遅延通知として捨てる
    agent.currentJobId = null;
    job.onProgress = undefined;
    job.membership.release();
    return job.result;
  }

  // ---- 参照 ----
  require(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("このサーバーにジョブが存在しません");
    return job;
  }
  get(jobId, after = 0) {
    const job = this.require(jobId);
    const agent = this.agents.get(job.conversationId);
    return { jobId, conversationId: job.conversationId, status: job.status,
      ...(agent && { mode: agent.mode, agentStatus: agent.status.value.status }),
      events: job.events.filter(e => e.sequence > after), lastSequence: job.sequence,
      ...(job.result && { result: job.result }) };
  }
  list() {
    return [...this.jobs.values()].map(j => ({
      jobId: j.jobId, conversationId: j.conversationId, status: j.status, createdAt: j.createdAt,
    }));
  }
  conversations() {
    return [...this.agents.values()].map(a => ({
      conversationId: a.id, provider: a.provider, mode: a.mode, permission: a.permission,
      isolation: a.isolation || null, model: a.model, effort: a.effort ?? null, status: a.status.value.status,
      busy: a.busy, liveSession: !!(a.session || a.failedSession), ...(a.evicted && { evicted: true }), ...(a.broken && { broken: a.broken }), createdAt: a.createdAt,
    }));
  }
  status() {
    return { liveSessions: this.registry.total, maxLiveSessions: this.maxLiveSessions,
      conversations: this.agents.size, jobs: this.jobs.size, maxJobs: this.maxJobs,
      idleSessionMinutes: Math.round(this.idleSessionMs / 60000), evictions: this.evictions, shuttingDown: this.runtime.closed };
  }
  async wait(jobId) { return this.require(jobId).promise; }

  // ---- 取消（原典 interrupt.rs: 事前状態を返す。終了済みへの取消は成功扱いで何もしない） ----
  cancel(jobId) {
    const job = this.require(jobId);
    const agent = this.agents.get(job.conversationId);
    const previousStatus = job.status;
    const requested = !job.result;
    if (requested && !job.ctrl.signal.aborted) {
      job.status = "cancelling";
      this.#event(job, { stage: "cancelling" });
      job.ctrl.abort();
    }
    return { jobId, requested, previousStatus, ...(agent && { agentStatus: agent.status.value.status }) };
  }

  // ---- 待機（原典 multi_agents_v2/wait.rs: min/max補正・受信箱の変化かtimeoutで戻る） ----
  async waitAny({ job_ids, timeout_ms } = {}, { signal } = {}) {
    const { minMs, defaultMs, maxMs } = this.waitTimeouts;
    if (timeout_ms !== undefined && timeout_ms > maxMs) throw new Error(`timeout_msは${maxMs}以下で指定してください`);
    const timeout = timeout_ms === undefined ? defaultMs : Math.max(timeout_ms, minMs);
    const ids = job_ids?.length ? job_ids : null;
    ids?.forEach(id => this.require(id));
    const accept = notice => !ids || ids.includes(notice.jobId);
    const ready = () => ids ? ids.some(id => this.jobs.get(id)?.result) : this.mailboxes.hasMail(ROOT, accept);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
    try {
      while (!ready() && !combined.aborted && !this.runtime.closed)
        await this.mailboxes.changed(ROOT, { signal: combined });
    } finally { clearTimeout(timer); }
    const done = ready();
    const notices = this.mailboxes.take(ROOT, accept);
    let message = done ? "待機が完了しました" : "待機がタイムアウトしました";
    if (timeout_ms !== undefined && timeout_ms < timeout) message += `（要求timeout ${timeout_ms}msを最小値${timeout}msへ補正）`;
    return { timedOut: !done, message, completed: notices,
      ...(ids && { jobs: ids.map(id => ({ jobId: id, status: this.jobs.get(id)?.status ?? "not_found" })) }) };
  }

  // ---- 終了 ----
  /** 停止に失敗したセッションは参照を残し（failedSession）、後のclose・shutdownで再停止できるようにする。 */
  async #stopSession(agent, operation) {
    const session = agent.session || agent.failedSession;
    agent.session = null;
    agent.failedSession = null;
    if (!session) {
      if (agent.committed) { this.registry.releaseSpawnedThread(agent.id); agent.committed = false; }
      return "none";
    }
    try {
      await session.close();
      agent.closeFailed = null;
      return "terminated";
    } catch (error) {
      this.runtime.recordFailure({ operation, agentId: agent.id, reason: "operation_failed", phase: "close_session", errorKind: error.message });
      agent.closeFailed = error.message;
      agent.failedSession = session;
      return "failed";
    } finally {
      if (agent.committed && !agent.closeFailed) { this.registry.releaseSpawnedThread(agent.id); agent.committed = false; }
    }
  }

  async close(conversationId) {
    const agent = this.agents.get(conversationId);
    if (!agent) throw new Error("会話が存在しません");
    if (agent.busy) throw new Error("実行中の会話は破棄できません。cancel_agentの後、終了確認してから閉じてください");
    if (agent.closing) throw new Error("この会話は終了処理中です");
    agent.closing = true;
    const session = await this.#stopSession(agent, "close_conversation");
    if (session === "failed") {
      agent.closing = false;
      agent.broken = "子プロセスの停止を確認できません";
      return { conversationId, closed: false, session, error: agent.closeFailed };
    }
    agent.reservation?.abandon();
    agent.status.set({ status: AgentStatus.Shutdown });
    agent.status.close();
    this.agents.delete(conversationId);
    for (const [id, job] of this.jobs) if (job.conversationId === conversationId) this.jobs.delete(id);
    this.mailboxes.take(ROOT, notice => notice.conversationId === conversationId);
    return { conversationId, closed: true, session,
      history: agent.mode === "native" ? "子プロセス内の会話をプロセス終了で破棄（ディスクへ保存しない設定）" : "メモリ内の履歴を破棄" };
  }

  async run(req, { signal, onProgress } = {}) {
    const job = this.start(req, { onProgress, notify: false });
    const abort = () => this.cancel(job.jobId);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await this.wait(job.jobId); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  /** 原典 request_shutdown: 新規受付を遮断→実行中を取消→停止確認→全セッション終了→報告。 */
  async shutdown() {
    this.runtime.requestShutdown();
    clearInterval(this.idleTimer);
    for (const job of this.jobs.values()) if (!job.result) job.ctrl.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise));
    await Promise.allSettled([...this.agents.values()].map(agent => this.#stopSession(agent, "shutdown")));
    await Promise.allSettled([...this.closingSessions]); // 自動解放中の子プロセスの終了も待つ
    this.mailboxes.close();
    return this.runtime.wait();
  }
}
