// ユーザーが許可したモデル・Effort（allowlist.json）。形式:
// { "providers": { "<provider>": { "models": { "<modelId>": { "efforts": ["low", ...] | "*" } }, "reviewed": ["<modelId>", ...] } }, "updatedAt": "..." }
// efforts が "*" のときはそのモデルの全Effortを許可。reviewed は選択画面で確認済みのモデル（新モデル検出用）。
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

export const ALLOWLIST_FILE = process.env.MAMCP_ALLOWLIST ? path.resolve(process.env.MAMCP_ALLOWLIST) : path.join(ROOT, "allowlist.json");

export function loadAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return { providers: {} };
  return JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8"));
}

/** 実行中のサーバーが書きかけを読まないよう、一時ファイルへ書いてから置き換える。 */
export function saveAllowlist(a) {
  a.updatedAt = new Date().toISOString();
  const tmp = `${ALLOWLIST_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n");
  renameSync(tmp, ALLOWLIST_FILE);
}

/** @returns {{allowed:boolean, efforts:string[]|"*"|null}} */
export function allowedEntry(a, provider, model) {
  const own = (o, k) => o && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined;
  const models = own(own(a?.providers, provider), "models");
  const m = own(models, model);
  const efforts = own(m, "efforts");
  const valid = efforts === "*" || (Array.isArray(efforts) && efforts.every(e => typeof e === "string" && e.length > 0));
  return valid ? { allowed: true, efforts } : { allowed: false, efforts: null };
}
