# OpenAI Codex由来の移植部分

- 原典: https://github.com/openai/codex commit `b1573f102413e96a6481087922bf425231222dee`
- ライセンス: Apache License 2.0（同梱の `LICENSE`）、`NOTICE` は原典のまま同梱
- 対象: `src/child-control/` の子実行制御。Rustソースを転載せず、挙動をNode.jsへ移植・改変した派生物
- 変更の記録（Apache-2.0 §4(b)）: 各ファイル先頭の「移植元」「変更」コメントと `src/child-control/README.md` の対応表
- Ratatui由来の表示はCodex本体のNOTICE条件として同梱しているだけで、本プロジェクトはRatatui由来コードを使用していない

本プロジェクト全体もApache-2.0で提供する（ルートの `LICENSE`・`NOTICE`）。上記の原典の表示・ライセンス・変更記録は引き続き保持する。
