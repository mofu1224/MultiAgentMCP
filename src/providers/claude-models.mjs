// Claude Codeの初期化応答に含まれるModelInfoを共通形式へ変換する。

/**
 * 実行先が報告したモデル名が要求と同じか。一覧には `claude-x[1m]` のようなコンテキスト指定付きIDがあり、
 * 実行時の報告は接尾辞なしになりうるため、末尾の [..] だけを除いて比較する（別モデルは一致しない）。
 */
export function sameClaudeModel(reported, requested) {
  if (!reported) return false;
  const strip = s => String(s).replace(/\[[^\]]*\]$/, "");
  return reported === requested || strip(reported) === strip(requested);
}
export function parseClaudeModels(stdout, requestId) {
  for (const line of stdout.split(/\r?\n/)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type !== "control_response" || message.response?.request_id !== requestId) continue;
    const response = message.response;
    if (response.subtype !== "success") throw new Error(`Claude初期化失敗: ${response.error || response.subtype}`);
    const rows = response.response?.models;
    if (!Array.isArray(rows) || !rows.length) throw new Error("Claude初期化応答にモデル一覧がありません");
    const models = new Map();
    for (const m of rows) {
      // 既定先は選択肢にしない。長文コンテキスト等の修飾子は明示的な選択として保持。
      if (m.value === "default" || !m.value) continue;
      const id = m.value.includes("[") ? m.value : m.resolvedModel || m.value;
      models.set(id, {
        id,
        displayName: m.displayName,
        description: m.description,
        resolvedModel: m.resolvedModel || null,
        efforts: m.supportsEffort === false ? [] : Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : null,
        source: "claude-cli-initialize",
      });
    }
    return [...models.values()];
  }
  throw new Error("Claude初期化応答がありません（古いモデル一覧へのフォールバックは行いません）");
}
