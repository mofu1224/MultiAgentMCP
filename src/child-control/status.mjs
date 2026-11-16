// 移植元: openai/codex@b1573f1 codex-rs/core/src/agent/status.rs（Apache-2.0）
// agent_status_from_event / is_final をNodeへ移植。イベント名は実行アダプター契約の正規化名へ置換した。

export const AgentStatus = Object.freeze({
  PendingInit: "pending_init",
  Running: "running",
  Interrupted: "interrupted",
  Completed: "completed",
  Errored: "errored",
  Shutdown: "shutdown",
  NotFound: "not_found",
});

/**
 * 1件のアダプターイベントから次の子状態を導く。状態に影響しないイベントはnull。
 * 原典: TurnStarted→Running、TurnComplete→Completed/Errored、TurnAborted(Interrupted|BudgetLimited)→Interrupted、
 * その他のAbort→Errored、Error→Errored、ShutdownComplete→Shutdown。
 */
export function statusFromEvent(event) {
  switch (event?.type) {
    case "turn_started": return { status: AgentStatus.Running };
    case "turn_completed":
      return event.error
        ? { status: AgentStatus.Errored, message: String(event.error) }
        : { status: AgentStatus.Completed, message: event.lastMessage ?? null };
    case "turn_aborted":
      return ["interrupted", "budget_limited"].includes(event.reason)
        ? { status: AgentStatus.Interrupted }
        : { status: AgentStatus.Errored, message: String(event.reason) };
    case "error": return { status: AgentStatus.Errored, message: String(event.message) };
    case "shutdown_complete": return { status: AgentStatus.Shutdown };
    default: return null;
  }
}

/** 原典どおり PendingInit / Running / Interrupted 以外を終端とする。 */
export function isFinal(status) {
  const value = typeof status === "string" ? status : status?.status;
  return ![AgentStatus.PendingInit, AgentStatus.Running, AgentStatus.Interrupted].includes(value);
}
