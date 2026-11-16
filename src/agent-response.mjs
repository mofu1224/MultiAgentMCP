// 内部の完全な結果・履歴は保持し、親へ渡す情報だけを絞る。
export function agentResult(result, { include_details = false } = {}) {
  if (include_details) return { ...result };
  const compact = {};
  for (const key of ["runId", "jobId", "conversationId", "status", "error", "warnings", "knownModels", "supportedEfforts"])
    if (result[key] !== undefined) compact[key] = result[key];
  if (result.structured !== undefined) compact.structured = result.structured;
  if (result.structured === undefined || result.status !== "succeeded")
    if (result.output !== undefined) compact.output = result.output;
  return compact;
}

export function agentState(state, options = {}) {
  const compact = { jobId: state.jobId, conversationId: state.conversationId, status: state.status };
  if (options.include_details) {
    if (state.mode !== undefined) compact.mode = state.mode;
    if (state.agentStatus !== undefined) compact.agentStatus = state.agentStatus;
  }
  if (options.include_events) {
    compact.events = state.events;
    compact.lastSequence = state.lastSequence;
  }
  if (state.result) compact.result = agentResult(state.result, options);
  return compact;
}
