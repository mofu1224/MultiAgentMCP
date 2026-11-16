// 設定の読込。config.json（任意）を既定値へ深くマージする。パスはプロジェクト基準の相対で解決する。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  providers: {
    codex: { type: "codex-cli", enabled: true },
    claude: { type: "claude-cli", enabled: true },
  },
  policy: {
    maxDepth: 1,                 // 直接再帰は固定制御で禁止
    maxConcurrent: 3,            // 同時実行数（同じdataDirの全MCPプロセスで共有。固定上限3を超えない）
    maxCallsPerRoot: null,       // 受付予算。null = 上限なし（既定）。正の整数で同じdataDirの全MCPプロセス共通の通算上限
    defaultTimeoutMs: 900000,
    maxTimeoutMs: 3600000,
    allowedPermissions: ["full-access", "read-only", "workspace-write"], // 明示したローカル設定はそのまま優先（自動拡張しない）
    defaultPermission: "full-access", // 参考表示。実際の省略時正規化は control.mjs の effectivePermission
    maxLiveSessions: 6,          // 継続用に常駐する子プロセス（ネイティブ会話）の上限
    maxRetainedJobs: 100,        // メモリに保持するジョブ数（超えたら終わったものから古い順に捨てる）
    liveSessionIdleMs: 1800000,  // この時間使われていない常駐子プロセスを解放（上限到達時は最古の待機中から解放）
    waitTimeouts: { minMs: 100, defaultMs: 30000, maxMs: 300000 },
    allowedCwdRoots: [],         // 空 = 制限なし
    maxPromptChars: 400000,
    maxFileBytes: 200000,
    modelCacheTtlMs: 600000,
  },
  dataDir: "data",
};

function merge(a, b) {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in (a || {}) ? merge(a[k], v) : v;
  return out;
}

export function loadConfig() {
  const file = process.env.MAMCP_CONFIG ? path.resolve(process.env.MAMCP_CONFIG) : path.join(ROOT, "config.json");
  const user = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const cfg = merge(DEFAULTS, user);
  if (cfg.policy.maxCallsPerRoot !== null && (!Number.isSafeInteger(cfg.policy.maxCallsPerRoot) || cfg.policy.maxCallsPerRoot < 1))
    throw new Error("policy.maxCallsPerRoot は null（上限なし）か正の整数で指定してください");
  for (const field of ["maxConcurrent", "maxDepth", "defaultTimeoutMs", "maxTimeoutMs", "maxPromptChars", "maxFileBytes", "modelCacheTtlMs", "maxLiveSessions", "maxRetainedJobs", "liveSessionIdleMs"]) {
    if (!Number.isSafeInteger(cfg.policy[field]) || cfg.policy[field] < 1) throw new Error(`policy.${field} は正の整数で指定してください`);
  }
  const w = cfg.policy.waitTimeouts;
  if (!w || !["minMs", "defaultMs", "maxMs"].every(k => Number.isSafeInteger(w[k]) && w[k] > 0 && w[k] <= 2147483647) || !(w.minMs <= w.defaultMs && w.defaultMs <= w.maxMs))
    throw new Error("policy.waitTimeouts は正の整数の minMs <= defaultMs <= maxMs で指定してください");
  if (!Array.isArray(cfg.policy.allowedPermissions) || !cfg.policy.allowedPermissions.every(p => ["full-access", "read-only", "workspace-write"].includes(p)))
    throw new Error("policy.allowedPermissions は対応権限の配列で指定してください");
  if (!Array.isArray(cfg.policy.allowedCwdRoots) || !cfg.policy.allowedCwdRoots.every(r => typeof r === "string")) throw new Error("allowedCwdRootsはパスの配列が必要です");
  cfg.policy.allowedCwdRoots = cfg.policy.allowedCwdRoots.map(r => path.resolve(ROOT, r)); // 相対パスは配置基準
  for (const field of ["onMissingModel", "onMissingEffort", "requireAllowlist", "onInvalidEffort", "onUnknownEffortSupport", "onUnknownModel"])
    delete cfg.policy[field]; // 過去の緩和設定を継承しない
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.configFile = existsSync(file) ? file : null;
  return cfg;
}
