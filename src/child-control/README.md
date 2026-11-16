# 子実行制御（Codex由来）の移植対応表

原典: openai/codex `b1573f102413e96a6481087922bf425231222dee`（Apache-2.0、`third_party/codex/`）。Rust実装をNode.jsへ移植・改変した。

## 採用（移植）

| 原典 | 移植先 | 移植した挙動 | 変更理由 |
|---|---|---|---|
| `agent/status.rs` | `status.mjs` | イベント→状態、`is_final`（Interruptedは非終端） | イベント名を実行アダプター契約の正規化名へ |
| `agent/registry.rs` | `registry.mjs` | 生成枠予約・上限拒否・確定・未確定予約の解放・二重解除で件数を壊さない | Dropが無いため `abandon()` を明示。AgentPath木/nicknameは除外 |
| `control/mailbox.rs` | `mailbox.mjs` | キュー型通知・受信待ち・閉鎖後の投入拒否 | tokio::watch → Promise待受。診断ゲージ除外 |
| `control/watch.rs` | `watch.mjs` | 初期スナップショット＋合成された変化、閉鎖で終了 | tokio::watch → 版番号付き値チャネル |
| `control/runtime.rs` | `runtime.mjs` | 受付遮断・開始拒否・全メンバー待機・後片付け失敗/放棄の記録（上限64） | TaskTracker → 件数とPromise。suspension除外 |
| `control/spawn_guard.rs` | `control.mjs` `PendingSpawn` | 生成確定前の失敗で子を必ず停止 | thread store/graph edge処理を除外 |
| `control/interrupt.rs`・`api.rs interrupt` | `control.mjs` `cancel` | 事前状態を返す、終了済みへの中断は何もしない成功 | root/self判定はMCP親子1段のため不要 |
| `control/completion.rs` | `control.mjs` `#finishTurn` | 終端結果を親の受信箱へキュー（本文を含めない） | AgentPath・trace・guardian表示を除外 |
| `control.rs handle_thread_request_result` | `control.mjs` `#executeNative` | 実行先が壊れたら当該子だけ除去し登録を解放 | 自動再起動・通常経路への切替をしない |
| `tools/handlers/multi_agents_v2/wait.rs` | `control.mjs` `waitAny` | timeoutのmin補正・max超過拒否・受信箱の変化かtimeoutで戻る・補正の通知 | 待機対象をジョブIDで絞れるようにした |

## 置換

- `CodexThread` / `ThreadManagerState` → 実行アダプターのセッション（`src/adapters/session.mjs` の契約）
- 親providerの継承 → 親が明示し許可リストで検証したprovider/model/effort
- `control/execution.rs`（実行枠の即時拒否） → 既存Runner/Coordinator（同じdataDirの全MCPプロセスで共有するSQLite枠。待機してから実行）

## 除外

ThreadManager・rollout/履歴保存・agent graph store・guardian/承認・service tier・rollout budget reminder・nickname・AgentPath木・原典のresidency/eviction基盤・root handoff・telemetry/otel。常駐上限と未使用時間による解放は本プロジェクトの簡略実装であり、停止確認後に枠を返す。

## 試験

`test/child-control.test.mjs`（移植部品と、異なる2種の偽実行先での契約試験）、`test/adapters.test.mjs`（実アダプターと模擬プロセス）。
