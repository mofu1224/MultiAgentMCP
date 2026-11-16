import { z } from "zod";
import { FEATURES } from "./platform.mjs";

// モデルやローカルの緩和設定では変更できない呼び出し規則。
export const CONTROL = Object.freeze({
  maxConcurrent: 3,
  maxCallsPerSession: null, // 受付予算の固定上限なし（2026-11-15 ユーザー判断）。configで任意に設定できる
  maxTimeoutMs: 3600000,
  nestedCalls: false,
  requireAllowlist: true,
  requireKnownModel: true,
  requireKnownEfforts: true,
  automaticRetry: false,
  automaticFallback: false,
  isolation: "provider-native",
  brokeredIsolation: FEATURES.brokered, // Windows MXC専用。他OSでは除去
  defaultPermission: "full-access",
  brokeredRequiresRestrictedPermission: true,
});

export const PERMISSIONS = ["full-access", "read-only", "workspace-write"];
export const RESTRICTED_PERMISSIONS = ["read-only", "workspace-write"];

/**
 * 実効権限へ正規化する。通常の省略はfull-access。brokeredは制限権限の明示が必須で、
 * 省略・full-accessを黙って読み替えず矛盾として拒否する。
 */
export function effectivePermission(req) {
  if (req.isolation === "brokered") {
    if (req.permission === undefined) return { error: "brokeredではpermission（read-only/workspace-write）の明示が必須です。省略時のfull-accessとは併用できません" };
    if (!RESTRICTED_PERMISSIONS.includes(req.permission)) return { error: "brokeredとfull-accessは矛盾するため拒否しました" };
    return { permission: req.permission };
  }
  return { permission: req.permission ?? "full-access" };
}

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]*$/);
export const runShape = {
  provider: identifier.describe("プロバイダーID"),
  model: identifier.describe("必須。許可済みの取得済みモデルID"),
  effort: identifier.optional().describe("Effort対応モデルでは必須。対応・許可済みの値のみ"),
  task: z.string().min(1).max(400000),
  role: z.string().max(400000).optional(),
  context: z.string().max(400000).optional(),
  files: z.array(z.string().min(1).max(4096)).max(100).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  permission: z.enum(PERMISSIONS).optional().describe("省略時full-access（OSユーザー権限の範囲で標準編集・シェル）。read-only/workspace-writeは既存のCLI標準制限。brokeredではread-only/workspace-writeの明示が必須"),
  isolation: z.literal("brokered").optional().describe("敵対的な子には必須。ホスト推論と認証なしMXC操作を分離する。full-accessとは併用不可"),
  max_steps: z.number().int().min(1).max(8).optional().describe("brokered専用の最大推論回数。各回を共有予算で検証"),
  timeout_ms: z.number().int().positive().max(CONTROL.maxTimeoutMs).optional(),
  json_schema: z.record(z.string(), z.unknown()).optional(),
  output_instructions: z.string().max(400000).optional(),
  include_details: z.boolean().optional().describe("同期結果に使用量・実行メタデータを含める。既定false。非同期結果はget_agentで指定"),
  notify_progress: z.boolean().optional().describe("同期実行の進捗通知を送る。既定false。バックグラウンド実行では通知しない"),
};
// brokeredを提供しないOSでは入力項目自体を公開しない（strictのため指定すると入力検証で拒否される）。
if (!FEATURES.brokered) { delete runShape.isolation; delete runShape.max_steps; }
export const runRequest = z.object(runShape).strict();
// run_brokered_agentは通常ツールの既定値から分離し、制限権限を必須にする。
export const brokeredRequest = FEATURES.brokered ? z.object({ ...runShape,
  permission: z.enum(RESTRICTED_PERMISSIONS).describe("必須。brokered操作子の権限上限"),
}).omit({ isolation: true }).strict() : null;

// 信頼する子にCLI標準制限を適用する。未対応のプロバイダーを無制限で起動しない。
// これは外部OS隔離や、敵対的な子の認証・通信の封じ込めを保証するものではない。
export function isolationError(provider) {
  if ((provider.capabilities?.tools !== false || provider.capabilities?.fileAccess !== false)
      && provider.capabilities?.executionControl !== "provider-native")
    return "ファイル操作・実行可能なプロバイダーがCLI標準制限に未対応のため起動を拒否しました";
  return null;
}
