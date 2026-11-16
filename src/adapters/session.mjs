// 実行アダプター契約（共通の子制御 → 各実行先）。
//
// provider.openSession({ model, effort, cwd, permission, env, signal }) → Session
// Session:
//   capabilities: { nativeContinuation, modelSwitch, effortSwitch, jsonSchema: "native"|"prompt-validated", persistence }
//   effective:    開始時に実行先が報告した実効値（未報告の値は "unreported" と明示し、検証済みと偽らない）
//   turn({ turnId, prompt, model, effort, jsonSchema, signal, interruptGraceMs, onEvent }) →
//     { ok, text, structured?, usage, modelUsed, effective, error?, aborted?, broken? }
//     ・停止を確認してから解決する（解決まで共有枠を返さない）。
//     ・onEvent({ turnId, type: "turn_started"|"item_completed"|"turn_completed"|"turn_aborted"|"error", ... })
//     ・broken: 会話を継続できない理由（取消後に停止せず強制終了した、通信が壊れた等）
//   close() → 子プロセスの終了を待つ。
//
// 実行先固有のCLI/APIはアダプター内に閉じ込め、子制御はモデル推論・認証・ツールに結合しない。

/** 中断要求→猶予内に停止しなければ強制終了。どちらでも停止確認後に解決する。 */
export function awaitTurn(ended, { signal, interrupt, kill, graceMs = 5000 }) {
  return new Promise(resolve => {
    let timer, settled = false, killing = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      Promise.resolve().then(interrupt).catch(() => { /* 停止済み・未開始 */ });
      timer = setTimeout(async () => {
        killing = true; // 強制終了に伴う通信切断は、停止確認後の結果で上書きする
        try { await kill(); } catch { /* 停止済み */ }
        finish({ ok: false, aborted: true, error: "取消後に実行先が停止しなかったため子プロセスを終了しました",
          broken: "取消後の停止を確認できず子プロセスを強制終了しました" });
      }, graceMs);
    };
    ended.then(
      result => finish({ ...result, aborted: !!(result.aborted || signal?.aborted) }),
      error => killing || finish({ ok: false, aborted: !!signal?.aborted, error: error.message, broken: `実行先が異常終了しました: ${error.message}` }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** 改行区切りJSONの読取り。壊れた行は無視せず呼出し側へ渡す。 */
export function lineReader(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
}
