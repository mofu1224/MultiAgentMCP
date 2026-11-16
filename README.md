# MultiAgentMCP

[English](README.en.md) · [変更履歴](CHANGELOG.md) · [セキュリティ](SECURITY.md) · [開発・リリース](CONTRIBUTING.md)

モデルを固定しないサブエージェント実行基盤（stdio MCP サーバー）。各社の公式CLIを正規のログインで呼び出す。

> **実行方式**: OpenAI Codexの子エージェント制御（生成・状態・継続・待機・取消・終了）をNodeへ移植した子実行制御（`src/child-control/`、Apache-2.0、`third_party/codex/`）から、実行先ごとのアダプターを同じ契約で呼びます。親が許可済みモデル・Effort・作業場所を指定し、**permission省略時はfull-access**（信頼する子向け）。read-only/workspace-writeは従来のCLI標準制限（WindowsではMXC）を維持します。CLI実装・ホスト設定は信頼する設計で、CLIプロセス全体をVMへ閉じ込める機能ではありません。

**敵対的な子には `run_brokered_agent` を使ってください。** こちらは認証を持つホストの推論専用サービスと、認証・通信のないMXC操作子を分離します。full-accessとは併用できず、read-only/workspace-writeの明示が必須です。

| 指定 | 実行 | 継続方式 |
|---|---|---|
| 省略 / `full-access` | Codex: `codex app-server`（danger-full-access・承認never・ephemeral）。Claude: `--input-format stream-json`（bypassPermissions・`--no-session-persistence`・空MCP） | 会話ごとの子プロセスへ新しい入力だけを送る（mode=native） |
| `read-only` / `workspace-write` | 従来の単発CLI＋標準制限（Codex sandbox＋MXC、Claude restricted＋専用MXCシェル） | 明示した履歴再送（mode=replay） |
| `isolation: "brokered"` | ホスト推論＋認証なしMXC操作子 | 明示した履歴再送（mode=replay） |

Node.js 24以上が必要です。Windowsで制限権限のコマンドを実行するにはMXC対応OSと対応Codex CLIが必要です。利用不能な場合、弱い隔離方式へ自動切替しません。他のOSで使える範囲は下の「macOS・Linux」節を参照。

- `codex-cli`: Codex CLI（ChatGPT Plus のサインイン）。モデル一覧・Effort候補は `codex debug models` から実行時取得
- `claude-cli`: Claude Code（Claude Pro のログイン）。CLIの `stream-json` 初期化応答から正式モデル名・モデル別Effortを取得。ヘルプの別名・実行履歴・API課金側の一覧は混ぜない
- `openai-compatible`: OpenAI互換API（OpenAI / OpenRouter / Ollama 等）。`config.json` に追記するだけで追加

モデル名・Effortの選択肢はコードに書いていない。新モデルはCLI側の一覧に出た後、ユーザーの許可で利用可能になる。一覧に無いIDを指定すると一度再取得してから判定する。WindowsのCLI探索もPATH順を尊重するため、後順位の別インストールを優先しない。

一覧はログイン環境のCLIが提示する候補であり、ChatGPT/ClaudeのWeb画面の全モデルや、各モデルの実行成功・残り利用枠を保証するものではない。モデル取得時には生成依頼を送らない。

## エージェントにインストールを頼む

Codex・Claude Code・OpenCodeなど、ターミナル操作ができるエージェントへ、このリポジトリのURLと一緒に次のように依頼してください。

> このMCPをインストールして。READMEの導入手順に従って、クローン、依存関係の導入、MCP接続確認、導入済みのCodex・Claude Code・OpenCodeへの登録まで進めて。既存設定とモデル許可は保持して。
>
> https://github.com/mofu1224/MultiAgentMCP

対象を限定したい場合は「Codexだけに登録して」「このフォルダに入れて」と付け加えられます。**配布ファイルは不要で、クローンしたフォルダをそのまま使います。** 導入先にソース・lock・試験・手順が揃うため、後から更新・検証できます。

CLIのログインや、どのモデル・Effortを許可するかの決定は利用者の判断が必要です。エージェントが認証情報を要求・コピーしたり、モデルを勝手に全許可したりする手順ではありません。

### 導入を依頼されたエージェント向け手順

利用者の依頼範囲と実行環境の権限に従い、次の順で進めてください。

1. OS、`git --version`、`node --version`、`npm --version`、対象ホストのCLIを確認する。Node.jsは**24以上**。不足している場合は公式の導入方法を示し、必要な権限を超えてインストールしない。Codex / Claude Codeは利用するものだけ必要。
2. 利用者指定の保存先、または利用者領域の永続的で書込み可能な場所へ、この依頼で渡されたリポジトリを `git clone` する。一時フォルダや他案件の中へ置かない。既存フォルダがあれば上書きせず、同じリポジトリかと未コミット変更の有無を確認する。
3. **クローン先を作業ディレクトリ**として、順に実行する。

   ```sh
   npm ci --ignore-scripts
   npm test
   npm run check:release
   npm run verify:install -- .
   ```

   この検証は認証・モデル生成・モデル許可・ホスト登録を必要としない。失敗したら登録せず、原因を報告する。

4. 登録対象を確認する。対象の指定が無ければ導入済みのCodex・Claude Code・OpenCode。登録前に `node src/register-hosts.mjs --dry-run` で変更予定を確認し、`node src/register-hosts.mjs` で登録する。単独ホストなら両コマンドに `--host codex` / `--host claude` / `--host opencode` を付ける。他のMCP・ホスト全体の設定は変更せず、`multi-agent` だけを更新する。未導入CLIはスキップする。
5. 既存の `config.json`・`allowlist.json`・`data/` と公式CLIの認証は保持する。初回はモデルが一つも許可されていない。`node src/select-models.mjs --show` で候補・許可状況を確認し、必要なら利用者に `node src/select-models.mjs` の選択を案内する。対話を自動操作する場合も、利用者が明示したモデル・Effortだけを設定する。
6. クローン先、版、Nodeの起動元、登録したホスト、接続検証結果、ログイン・モデル許可の残作業を報告する。対象ホストのMCPだけを再接続できる場合は再接続し、できない場合は新しい接続から反映されることを伝える。ユーザーの他のセッションを強制終了しない。初回の実生成を無断で試さない。

接続後は親から `list_providers` → `get_policy` → `list_models` を呼び、対応機能と許可範囲を確認して `start_agent` を使う。

### 手動で導入する場合

```sh
git clone https://github.com/mofu1224/MultiAgentMCP.git
cd MultiAgentMCP
```

クローン先で上記の4つのコマンドを実行した後、`node src/select-models.mjs` と `node src/register-hosts.mjs` を実行する。Windowsでは `select-models.cmd` / `register-hosts.cmd`、macOSでは同名の `.command` も使える。

通常起動は `npm start` または `node src/server.mjs`。stdio MCPサーバーのため、単体起動では画面や対話メニューは出ない。許可リスト・設定・`data/` は配置先に作られるので公開・配布しない。

**注意:** `permission` 省略時は **full-access**。信頼する子だけに使い、制限したい場合は明示する。モデル生成は各サービスの利用枠・料金に数えられる。本ソフトは各社の非公式連携ツールであり、サービスの利用条件に従う。

## ツール

| ツール | 内容 |
|---|---|
| `list_providers` | プロバイダーの利用可否・機能・対応権限 |
| `list_models` | 実行時取得のモデル一覧（`efforts`・`defaultEffort` など） |
| `run_agent` | 1件実行。`provider` `model` `effort` `task` `role` `context` `files` `cwd` `permission` `timeout_ms` `json_schema` |
| `run_brokered_agent` | 敵対的な子向けの認証・推論分離。毎推論で許可を再検証して受付数に数え（上限は任意設定）、操作は認証なしMXCだけで実行 |
| `run_agents_parallel` | 複数件を並列実行 |
| `start_agent` / `get_agent` / `list_agents` | 非同期開始・進捗・結果取得（`list_agents` は会話・常駐セッションも返す） |
| `wait_agents` | 指定ジョブ（省略時は未読の非同期完了通知）の終了待ち。timeoutは最小値未満を補正、最大値超過は拒否 |
| `send_agent_message` | 完了した会話へ追加入力。毎回モデル・Effort・権限を再検証 |
| `cancel_agent` / `close_conversation` | 取消要求（停止確認まで枠を保持）／会話の終了（native会話は子プロセス終了を待つ） |
| `sandbox_status` / `run_isolated_code` | 隔離環境の準備確認／使い捨てJavaScript実行 |
| `get_run` / `usage_summary` | 実行記録・モデル別使用量（`data/runs.jsonl`。4MBを超えると新しい側の半分だけ残す） |
| `get_policy` | 現在のポリシーと呼び出し連鎖の状態 |

## モデル・Effortの決め方

- **呼び出し元のエージェントが毎回決める**。`model` と `effort`（モデルがEffort対応の場合）は必須で、未指定は拒否する。CLIの既定モデル（例: Fable）へ暗黙に流れることはない。
- **使ってよい範囲はユーザーが決める**。`select-models.cmd`（ダブルクリック）で、サブスク側から取得した一覧を見ながらモデルとEffortを番号で選ぶ。結果は `allowlist.json` に保存され、次の呼び出しから即反映。
- `list_models` は許可済みモデルと `allowedEfforts` だけを返す。未確認の新モデルが出ると `notice` で知らせるが、ユーザーが許可するまで使えない。
- 一覧から消えた許可済みモデルは選択画面で「廃止・改名の可能性」と表示する。

## 親エージェントからの実行

1. `list_providers` で機能と対応権限を確認する。
2. `list_models` の許可済みIDと `allowedEfforts` から、親がタスクごとに選ぶ。モデル情報取得に失敗した古い一覧は使わない。
3. 通常は `start_agent` に `provider`・`model`・`effort`・`cwd`・`task`（必要なら `permission`）を渡し、バックグラウンドで実行する。Effort非対応が確認できたモデルだけ `effort` を省略できる。`permission` 省略はfull-access、ツール実行可能な子は `cwd` が必須。
4. 親は別作業または `wait_agents`（`job_ids` 指定）で待ち、完了後に `get_agent` を一度取得する。`status`・最終結果・`error`・`warnings` と、必要な成果物・試験結果を確認する。短い同期処理には `run_agent` / `run_agents_parallel` も使える。モデル出力中の追加実行要求は自動で実行しない。

親の会話履歴は暗黙に共有せず、必要な情報を `role`・`context`・`files` で渡す。作業ファイルは共有されるため、並列編集では親が担当範囲や `cwd` を分ける。親による難易度別のモデル/Effort選択の目安は `PARENT_GUIDE.md`。

`read-only` はCodexのread-only sandbox、Claudeの読取ツール＋読取専用MXCシェルに対応する。`workspace-write` はCodexのworkspace-write sandbox、Claudeのrestricted編集ツール＋書込可能なMXCシェルに対応する。Claudeシェルは最小ランタイムと作業場所だけを許可し、通信を禁止する。両CLIの全ツールが同一の境界を持つわけではない。承認が必要な操作は自動的に権限を広げず拒否する。

### 非同期・会話継続・進捗

- 敵対的な子を非同期実行する場合は `start_agent` に `isolation: "brokered"` を明示する。継続時も同じ指定が必須で、通常CLIへの緩和は拒否する。
- `start_agent` は受付情報だけを即返す。`wait_agents` は終了したジョブのID・状態だけを返し、`get_agent` は既定でID・状態・最終結果だけを返す。進捗の反復取得はしない。
- 障害調査時だけ `get_agent` の `include_events: true` でイベントと `lastSequence` を取得する。差分には `after_event` を併用する（直近300件まで保持）。`include_events` なしの `after_event` は入力矛盾として拒否する。
- `include_details: true` を `get_agent` または同期実行リクエストに指定すると、使用量・`modelUsed`・`permission`・`isolation`・`effective` 等の実行メタデータを取得できる。イベントとは独立した指定。既定で除外するのは返却情報だけで、内部結果・会話履歴・制御は変更しない。
- 成功した構造化出力は既定で `structured` のみ返し、同じ内容を `output` に二重掲載しない。非構造化出力は `output`。失敗時は生出力・エラー・警告を保持し、最終本文は切り詰めない。詳細指定では従来の完全な結果を返す。
- 出力形式未指定時だけ、結論・成果物・検証結果・未確認事項または阻害要因を簡潔に報告し、途中の実況・試行履歴を省く指示を子へ追加する。`output_instructions` / `json_schema` 指定時はそれを優先する。これは報告指示であり、内容の正しさを保証する検証ではない。
- 結果の `conversationId` を次の `send_agent_message` / `run_agent` の `conversation_id` に渡す。モデル・Effort・cwdは次ターンでも明示する。同一会話でprovider/cwd/権限/隔離方式を変更したり同時ターンを開始したりはできない。
- **native会話**（full-access）: 会話ごとに常駐する子プロセス（Codex app-server / Claude stream-json）へ新しい入力だけを送る。履歴は子プロセス内にだけあり、Codexは `ephemeral=true`、Claudeは `--no-session-persistence` でディスクへ会話を保存しない（実機で `~/.codex/sessions`・`~/.claude/projects` に新規ファイルが増えないことを確認）。Codexは会話中のモデル/Effort変更に対応。Claudeはモデル変更に対応（制御要求 `set_model`、切替後のinit応答で照合）し、Effort変更は未対応（新しい会話が必要）。常駐数は `policy.maxLiveSessions`（既定6）。親が閉じ忘れても止まらないよう、上限に達したときは最も長く使われていない待機中の会話の子プロセスを解放して新しい会話を受け付け、`policy.liveSessionIdleMs`（既定30分）使われていない子プロセスも解放する（全て実行中なら上限エラー）。解放された会話は `evicted` と表示され、継続要求には理由付きで拒否する。保持ジョブ（`policy.maxRetainedJobs`、既定100）も終わったものから古い順に捨て、受付を止めない。開始時に実効モデル・権限を実行先の応答と照合し、不一致なら開始しない。中断に従わない子は強制終了し、その会話だけ継続不能にする（通常経路へ自動切替しない）。
- **replay会話**（制限権限・brokered）: 過去の実行プロンプト・添付スナップショット・応答をメモリから明示的に再送する。上限超過時は黙って履歴を切らず、新しい会話を要求する。
- どちらもサーバー再起動後の復元はしない。
- 同期実行は `notify_progress: true` とクライアントのprogress tokenが揃う場合だけMCP進捗通知を送る。非同期開始では通知しない。進捗はメタデータであり、思考本文の配信ではない。
- 取消は要求受付と終了を区別し、`get_agent` / `wait_agents` で確定状態を確認する。共有枠は停止確認後に返す。完了会話は `close_conversation` で閉じる。メモリ保持は最大100ジョブ（`policy.maxRetainedJobs`、超えたら終わったものから古い順に破棄）。
- ジョブ状態: `accepted → queued → running → (cancelling) → succeeded / failed / cancelled / timeout`、検証拒否は `rejected`。子の状態（`agentStatus`）はCodex由来の `pending_init / running / interrupted / completed / errored / shutdown`。
- 利用ルールは `PARENT_GUIDE.md` をMCP初期化のinstructionsとしてホストへ自動提供する。

この返却方針は親のコンテキスト消費と途中仮説の混入を抑える。子自身の推論・ツール実行のトークン消費は残り、総トークン削減やハルシネーションの完全防止を保証しない。旧クライアントでメタデータやイベントが必要な場合は上記フラグを追加する。導入後はホストを再接続してツール定義とinstructionsを更新する。

## 安全装置

- 呼び出し規則は `src/control.mjs` とRunnerで固定。モデル名やEffortの候補は固定しない。
- 未指定・未許可・モデル情報取得失敗・Effort対応不明は拒否。自動のモデル切替・Effort除去・再試行はしない。モデルの生成本文に呼び出し指示があっても実行しない。
- 子からの直接再帰は禁止。Codexはネイティブの追加エージェントを無効化、Claudeは使用ツールを限定し、継承MCP・カスタマイズを無効化する。追加要求はデータとして親へ返す。環境変数による再帰判定は補助であり、別CLIを起動する敵対的プロセスへの封じ込めではない。
- 同じ `dataDir` のSQLiteで全MCPプロセスの同時実行枠（最大3）をトランザクション予約し、受付数を数える。受付回数の上限は既定で無い（2026-11-15 ユーザー判断）。`config.json` の `policy.maxCallsPerRoot` に正の整数を書いた場合だけ、配置全体の通算上限として適用する（別の会話ID・再起動ではリセットされない）。
- 実行枠は所有プロセスのハートビート（15秒ごと）で生存を示す。所有プロセスが存在しない枠・120秒以上更新の無い枠は自動で回収するため、強制終了で枠が詰まって止まることはない。保存先を別々にした構成・別端末には集中制御が及ばない。
- 待機後にユーザー許可を再検証。待機中キャンセルに対応。JSON Schema出力は返却前にも検証する。
- `full-access` は既定（ローカル `policy.allowedPermissions` から外せば省略時も拒否され、自動で広げない）。full-accessの子に対する許可リスト・同時実行枠は信頼する子の運用制御であり、悪意ある子による別CLI起動等の迂回を防ぐものではない。厳密な保護が必要ならbrokeredを使う。ファイル転送は `allowedCwdRoots` の明示設定を必須とし、実体パスで範囲確認する。
- ファイル操作・コード実行可能なプロバイダーは `capabilities.executionControl: "provider-native"` の実装が必要。未対応のものは拒否。
- CLIの `extraArgs` は空配列以外を拒否し、指定したモデル・権限・追加委譲の制限を上書きさせない。Codexはユーザー設定・execpolicy rulesを読み込まず、Claudeは設定ソースを空にし、フック・自動記憶・claude.aiコネクタ・スラッシュコマンドを無効化する。safe-modeは明示した専用MCPまで無効化するため生成実行では使用しない。管理者ポリシーは引き続き適用される。以上は制限権限の単発経路の設定。full-accessのnative経路は標準環境で動かし、ユーザー設定（Codexのconfig、Claudeのsettings/フック/CLAUDE.md等）を読み込む。ただし再委譲と画面操作を防ぐため、Codexは `agents.enabled=false` に加え、ユーザーの `config.toml` に定義されたMCPサーバー（本MCP自身・画面操作系を含む）を個別に無効化し、プラグイン・アプリ・computer use・フック・通知も無効化する（app-serverに `--ignore-user-config` が無いため）。Claudeは空MCP（`--strict-mcp-config`）。子の環境変数で本MCPの再帰呼出しも拒否する。

### 外部コード隔離

`run_isolated_code` は `code` と任意の `timeout_ms`（最大60秒）を受け取る。Windows既定はMXCで、親の秘密環境変数を引き継がず、最小ランタイム＋使い捨て作業場所だけを許可し、ネットワークを禁止する。

任意設定の `sandbox.backend: "docker"` も用意する。Dockerではホストディスク・認証・ネットワークを渡さず資源を制限し、イメージの自動pullは行わない。Docker未導入のためコンテナ実機検証は未実施であり、Windowsの検証済み既定方式はMXC。CLI自体の認証・推論通信はホストで維持し、CLI実装を信頼する。

### 認証・推論ブローカー方式

`run_brokered_agent`、または通常の実行ツールへ `isolation: "brokered"` を指定する。

```text
親 → 許可/権限/共有予算の検証 → 推論専用ホスト
                               ↓ 固定スキーマの操作
                          認証なしMXC子 → 結果データ
                               ↓ 次の推論も予算検証
```

- モデルが直接使えるホストツールはない。ホストで受理するモデル出力は `execute`（JavaScript）/`finish` の固定JSONのみ。操作コードはホストでevalせずMXC子にだけ渡す。
- OpenAIモデルは既存OpenCodeのOpenAI接続とツール実行のない `session.generate` を使う。公式クライアントのサービス発見・認証をホスト内だけで使用する。同名モデルと同名variantがなければ拒否し、Codex CLIへフォールバックしない。推論用セッションは削除し、入力はセッション履歴に追加しない。
- Claudeモデルは公式CLIを `--safe-mode --tools ""`・空MCPで推論専用にする。サブスクの正規認証はホストだけで利用し、モデルにホストツールを公開しない。
- 最初の推論は受付時、次からの推論もSQLiteで一回ずつ受付数として数える（上限を設定した場合は毎推論で適用）。最大 `max_steps`（1〜8、既定8）。モデル/Effortの変更や子からの追加推論要求は入力データとして扱い、制御命令として解釈しない。各推論前と操作前に許可を再検証する。
- MXC子は通信禁止、秘密環境変数を非継承。ホスト認証・本システムのコード/設定/許可リスト/状態DBを明示的に拒否する。作業場所が保護対象と重なる場合は推論前に拒否し、添付も作業場所内だけに限定する。workspace内の `.env` 等にも拒否ルールを追加する。
- 返却の `isolation` は `brokered-mxc`。`isolationEvidence` にホストが記録した実行コード・SHA-256・実際の終了状態/出力を含める。証跡はメモリと返却結果だけで、永続ログに本文を保存しない。侵害試験は実行コード自体も既知の試験コードと照合する。
- Windows MXC専用。未対応プロバイダー・モデル・OS・停止したブローカーでは拒否し、弱い方式に自動切替しない。推論サービスとOS/CLI実装は信頼する制御基盤であり、それ自体の侵害やカーネル脆弱性を防ぐ設計ではない。

### 状態管理

`manage-state.cmd` のダブルクリック、または `node src/manage-state.mjs status` で共有状態を確認できる。ローカル利用者の明示的な `node src/manage-state.mjs reset-budget` は、待機・実行枠がないときだけ受付数を0に戻す（上限を設定した場合の復旧用）。MCPには公開しない。所有者が消えた実行枠は `status` を含む各操作の時点で自動回収される（回収した数を `reclaimed` で表示）。

## 設定

`config.example.json` を `config.json` にコピーして編集（任意）。過去の `onMissingModel` / `onMissingEffort` / `requireAllowlist` / `onInvalidEffort` / `onUnknownEffortSupport` / `onUnknownModel` は無視し、緩和しない。`get_policy` の `fixedControl` が変更不能な規則を示す。

permission省略時はfull-accessへ正規化してから `policy.allowedPermissions` と実行先の対応を検証する（`defaultPermission` は表示用で、省略時の実効値は固定制御 `CONTROL.defaultPermission`）。brokeredでは省略を補完せず拒否する。MCPに許可リストを書き換えるツールは提供しない。ただし同じOSユーザーで動く信頼されたローカルクライアントに対し、ファイルへの直接変更まで防ぐものではない。

`policy.allowedCwdRoots` は空（既定）＝子の作業場所の制限なし。full-accessの子はOSユーザー権限でどのフォルダでも編集できる。空のときは `files` による添付（ホストのファイルを読み込んでプロンプトへ渡す機能）は拒否されるため、子には `cwd` 内のファイルを自分で読ませる。

`dataDir` と `allowedCwdRoots` の相対パスは配置ルートから解決する。設定を分離する場合は `MAMCP_CONFIG`、許可リストは `MAMCP_ALLOWLIST` にファイルパスを指定する。APIキーの値は設定に書かず `apiKeyEnv` で環境変数名だけを指定する。この変数は子CLIへ渡さないが、full-accessでホスト上の秘密そのものを保護できるわけではない。

### OpenAI互換API

テキスト生成専用。`baseUrl` と必要なら `apiKeyEnv` を設定する。APIがモデル別Effort候補を返さない場合は、確認済みの候補を `modelEfforts: { "<model-id>": ["<effort>"] }` または全モデル共通の `efforts` に設定する。Effortを送らないサービス・モデル群は `effortParam: null` とする（対応なし＝空配列）。候補が不明なままなら実行を拒否する。`GET /models` の期限は既定15秒（`listTimeoutMs`）。HTTPエンドポイントは信頼するものだけを設定する。

## 更新・移動・削除

更新するときは対象MCPのジョブが終わっていることを確認して接続を停止し、クローン先で `git status --short` を確認する。変更があれば保持して判断し、無ければ `git pull --ff-only` → `npm ci --ignore-scripts` → `npm test` → `npm run check:release` → `npm run verify:install -- .` の順で検証して再接続する。認証・`config.json`・`allowlist.json`・`data/` はコピーや初期化をしない。

配置やNodeの実行パスを移した場合は登録も更新する。`get_policy` の `version`・`root` で起動元を確認できる。削除するときは先に対象ホストの `multi-agent` 登録を解除し、必要なローカル設定を利用者の手元に保存したうえでクローン先を削除する。

ソースのクローンだけを導入経路とし、別の配布物・端末間コピー・専用の配布スクリプトは用意しない。npmレジストリへの公開は `private: true` で無効化している。開発者向けの確認は [開発・リリース手順](CONTRIBUTING.md) を参照。

## 登録例

`register-hosts.cmd` のダブルクリック、または `node src/register-hosts.mjs` でCodex・Claude Code・OpenCodeへユーザー単位で登録する。未導入のCLIはスキップし、導入済みのCLIが失敗した場合はエラーを返す。既存の `multi-agent` 登録は更新する。取得したフォルダと実行中のNodeのパスを保存するため、配置移動・Node更新後は再実行する。

`--host codex` / `--host claude` / `--host opencode` で登録先を一つに限定できる。`--dry-run` は変更予定の表示だけを行い、登録や解除は実行しない。

VS CodeのGitHub Copilotへの登録は既定で行わない。必要な場合だけ `--vscode` を付ける（ユーザーの `Code/User/mcp.json` の `multi-agent` だけを更新。他の定義は保持。JSONCなど解析できない既存ファイルは書き換えず失敗する）。

```powershell
$server = Join-Path (Get-Location) "src/server.mjs"
claude mcp add --scope user multi-agent -- node $server
codex mcp add multi-agent -- node $server
```

```sh
claude mcp add --scope user multi-agent -- node "$PWD/src/server.mjs"
codex mcp add multi-agent -- node "$PWD/src/server.mjs"
```

## ソース公開前提

- `config.json`・`allowlist.json`・`.env*`・`data/` は非公開のローカルデータ。サンプル設定とは分離する。
- 認証は各CLIで管理する。認証ファイル・トークンを本プロジェクトへコピーしない。
- 新規の実行ログには使用量・成否等のメタデータだけを記録し、依頼・応答・エラー本文・作業パスは記録しない。旧ログには本文が含まれる可能性があるため、既存の `data/` も公開しない。
- `private: true` で誤ったnpm公開を防ぐ。導入先と開発環境は同じソース構成を使い、ローカル状態はGitへ追加しない。
- 公開前にGitの追跡対象・履歴を確認する。ignore追加では既存の追跡・履歴は消えない。フォルダ全体のコピーではなくGitの追跡内容だけを公開する。
- ソース公開の前提は、公開操作・ライセンス選定・認証情報の公開を許可するものではない。

## 確認

`npm test` はCLI導入・認証・モデル通信を必要としない回帰試験とMCP統合試験。`npm run check:release` は構文・lock整合性・Gitの公開候補・ライセンス・ローカルリンクを検査する。CIはNode 24のWindows / macOS / Linuxで同じ自動試験を行う設定になっている。

実環境のCLIモデル一覧は別途 `npm run test:smoke` で確認する（両CLIとログインが必要。生成依頼なし）。実生成の検証は利用枠を消費するため自動試験・CIに含めない。自動試験の成功は、実モデルやCLI更新後の互換性まで保証するものではない。

任意の実機試験（サブスク利用枠を消費）: `node test/live.mjs <provider> <許可済みmodel> <許可済みeffort>`（制限権限）、`node test/full-access-live.mjs <provider> <model> <effort>`（既定full-accessの編集・シェル・native継続・取消・timeout・close・履歴非保存）。`npm test` には子制御の契約試験と、Codex app-server / Claude stream-json の模擬プロセスによるアダプター試験（生成通信なし）を含む。
MXC境界の実機試験（モデル生成なし）: `node test/mxc-live.mjs`。
実モデルによる侵害・予算迂回試験: `node test/brokered-live.mjs <provider> <許可済みmodel> <effort>`。
full-access-liveの第4引数に許可済みの別モデルを渡すと、同じ会話のまま切り替えて文脈が残ることも確認する。

## macOS・Linux

OS別の可否は `src/platform.mjs` で一元判定する。Windows MXCに依存する機能はmacOS・Linuxで公開しない（ツール一覧・入力項目・instructionsから除去し、弱い方式へ切り替えない）。実CLIを使う前に `list_providers` とモデル一覧で利用可否を確認する。

| 機能 | Windows | macOS・Linux |
|---|---|---|
| full-access（native継続） | ○ | ○ |
| Codex read-only / workspace-write | ○（MXC） | ○（Codex標準sandbox） |
| Claude read-only / workspace-write | ○（restricted＋専用MXCシェル） | ×（Claudeはfull-accessのみ） |
| brokered（`run_brokered_agent`・`isolation`） | ○ | ×（ツール・入力項目なし） |
| `run_isolated_code`・`sandbox_status` | ○（MXC） | config で `sandbox.backend: "docker"` を明示した場合のみ |

- 公開ツールはWindows 17件、macOS・Linuxは既定で14件（Dockerを明示設定すると隔離実行の2件が加わる）。
- 起動ファイルはWindowsの `*.cmd` に対し、macOSは同名の `*.command`（Finderでダブルクリック）。端末ごとの許可リストは通常独立している。
- SSH経由のシェルではmacOSのログインキーチェーンが使えず、Claude Codeが未ログインに見える。MCPホスト（GUIで起動したCodex/Claude Code/OpenCode）からは通常どおり使える。SSHから試験する場合はGUIセッションのLaunchAgentとして実行する。

## プロバイダー追加

`src/providers/<type>.mjs` に `export default (id, cfg) => ({ id, type, description, capabilities, available(), listModels(), run() })` を置き、`config.json` の `providers` に `{ "type": "<type>" }` を追加する。本体の変更は不要。full-accessのnative継続に対応する場合は `openSession()`（契約は `src/adapters/session.mjs`）を実装する。未実装の実行先はreplay継続になる。

## ライセンス

[Apache-2.0](LICENSE)。Codex由来の移植部分の出典・変更対応は [src/child-control/README.md](src/child-control/README.md)、原典の表示は [third_party/codex](third_party/codex/README.md) と [NOTICE](NOTICE) に保持している。依存パッケージ・外部CLIはそれぞれのライセンスと利用条件に従う。
