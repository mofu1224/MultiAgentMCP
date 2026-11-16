// 移植元: openai/codex@b1573f1 codex-rs/core/src/agent/control/runtime.rs（Apache-2.0）
// AgentTreeShutdownState / AgentTreeMembership / AgentTreeTeardownGuard / admit_start / request_shutdown を移植。
// 受付の遮断後に開始を拒否し、shutdownは全メンバーの終了を待ち、後片付けの失敗・放棄を報告に残す。
// 除外: suspension（親の退避・再読込）・子孫TaskTracker・tracing。変更: TaskTracker → 件数とPromise。

const MAX_RETAINED_SHUTDOWN_FAILURES = 64;

export class RuntimeShuttingDown extends Error {
  constructor() { super("子制御を終了中のため新しい開始を受け付けません"); }
}

export class AgentRuntime {
  #members = 0;
  #closed = false;
  #idle = [];
  #report = { failures: [], omittedFailures: 0 };

  get closed() { return this.#closed; }
  get members() { return this.#members; }

  /** 原典と同じく遮断の前後で二重確認する（JSは単一スレッドのため一度で同値）。 */
  admitStart() {
    if (this.#closed) throw new RuntimeShuttingDown();
    this.#members++;
    let released = false;
    const membership = {
      release: () => {
        if (released) return;
        released = true;
        if (--this.#members === 0) for (const resolve of this.#idle.splice(0)) resolve();
      },
      teardownGuard: (operation, agentId) => new TeardownGuard(this, membership, operation, agentId),
    };
    return membership;
  }

  recordFailure(failure) {
    if (this.#report.failures.length < MAX_RETAINED_SHUTDOWN_FAILURES) this.#report.failures.push(failure);
    else this.#report.omittedFailures++;
  }

  requestShutdown() { this.#closed = true; }

  /** 全メンバー終了後、失敗が無ければ ok:true。 */
  async wait() {
    if (this.#members) await new Promise(resolve => this.#idle.push(resolve));
    const report = structuredClone(this.#report);
    return { ok: !report.failures.length && !report.omittedFailures, ...report };
  }
}

/** complete() 前に finish() された後片付けを失敗（GuardAbandoned）として記録する。 */
export class TeardownGuard {
  #completed = false;
  constructor(runtime, membership, operation, agentId) {
    this.runtime = runtime; this.membership = membership; this.operation = operation; this.agentId = agentId;
  }
  recordFailure(phase, errorKind) {
    this.runtime.recordFailure({ operation: this.operation, agentId: this.agentId, reason: "operation_failed", phase, errorKind });
  }
  complete() { this.#completed = true; this.finish(); }
  finish() {
    if (!this.#completed) this.runtime.recordFailure({ operation: this.operation, agentId: this.agentId, reason: "guard_abandoned" });
    this.#completed = true;
    this.membership.release();
  }
}
