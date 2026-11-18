#!/usr/bin/env node
// 許可するモデル・Effortを選ぶ対話画面。サブスク側（各CLI）から一覧を取得して表示する。
// 使い方: node src/select-models.mjs        … 対話で選択
//         node src/select-models.mjs --show … 現在の許可状態を表示のみ
import readline from "node:readline";
import { loadConfig } from "./config.mjs";
import { Registry } from "./registry.mjs";
import { RunLog } from "./runlog.mjs";
import { loadAllowlist, saveAllowlist, ALLOWLIST_FILE } from "./allowlist.mjs";

const args = process.argv.slice(2);
const showOnly = args.length === 1 && args[0] === "--show";
if (args.length && !showOnly) {
  console.error("使い方: node src/select-models.mjs [--show]");
  process.exit(2);
}
const cfg = loadConfig();
const reg = new Registry(cfg, new RunLog(cfg.dataDir));
await reg.init();
const al = loadAllowlist();
al.providers ||= {};
// 行を貯めておく入力（一覧取得中に届いた入力も失わない。入力終了時は保存せず中断）
const rl = showOnly ? null : (() => {
  const r = readline.createInterface({ input: process.stdin });
  const lines = [], waiters = [];
  let closed = false;
  r.on("line", (l) => {
    if (!waiters.length) { lines.push(l); return; }
    if (!process.stdin.isTTY) process.stdout.write(l + "\n");
    waiters.shift()(l);
  });
  r.on("close", () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return {
    question(q) {
      process.stdout.write(q);
      if (lines.length) { const l = lines.shift(); process.stdout.write(l + "\n"); return Promise.resolve(l); }
      if (closed) return Promise.resolve(null);
      return new Promise((res) => waiters.push(res));
    },
    close: () => r.close(),
  };
})();

/** "1,3-5" / "all" / "none" / "" を番号配列へ。空は null（現状維持） */
function parsePick(s, n) {
  s = s.trim().toLowerCase();
  if (!s) return null;
  if (s === "all" || s === "a") return [...Array(n).keys()];
  if (s === "none" || s === "n" || s === "0") return [];
  const out = new Set();
  for (const part of s.split(/[,\s]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`解釈できません: ${part}`);
    const start = Number(m[1]), end = Number(m[2] || m[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > n || start > end)
      throw new Error(`番号は1〜${n}の範囲で指定してください: ${part}`);
    for (let i = start; i <= end; i++) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}

async function ask(q, n) {
  for (;;) {
    const line = await rl.question(q);
    if (line === null) { console.log("\n入力が終了したため保存せず中断しました。"); process.exit(1); }
    try { return parsePick(line, n); } catch (e) { console.log(`  ${e.message}`); }
  }
}

const effortLabel = (efforts) => efforts === "*" ? "全Effort" : efforts.join(", ") || "許可Effortなし";

console.log(`MultiAgentMCP / モデル許可設定${showOnly ? "（表示のみ）" : ""}`);
console.log(`保存先: ${ALLOWLIST_FILE}`);
for (const p of await reg.describeProviders()) {
  console.log();
  if (!p.available) { console.log(`■ ${p.id}: 利用不可（${p.reason}）`); continue; }
  const { models, error } = await reg.models(p.id, { refresh: true });
  if (error) { console.log(`■ ${p.id}: 一覧取得失敗（許可設定を変更しません）: ${error}`); continue; }
  const pa = (al.providers[p.id] ||= { models: {}, reviewed: [] });
  const reviewed = new Set(pa.reviewed);
  const list = models.filter((m) => !m.hidden);
  console.log(`■ ${p.id}：${list.length}モデル / 許可済み ${list.filter((m) => pa.models[m.id]).length}`);
  list.forEach((m, i) => {
    const cur = pa.models[m.id];
    const status = cur ? "[許可済]" : "[未許可]";
    const recent = reviewed.has(m.id) ? "" : " [新着]";
    const efforts = cur ? ` — ${effortLabel(cur.efforts)}` : "";
    console.log(`  ${String(i + 1).padStart(2)}. ${status} ${m.id}${recent}${efforts}`);
  });
  const gone = Object.keys(pa.models).filter((id) => !models.some((m) => m.id === id));
  if (gone.length) console.log(`  ※許可済みだが現在の一覧に無いモデル: ${gone.join(", ")}（廃止・改名の可能性）`);
  const hiddenAllowed = models.filter((m) => m.hidden && pa.models[m.id]).map((m) => m.id);
  if (hiddenAllowed.length) console.log(`  ※許可済みの非表示モデル（変更せず保持）: ${hiddenAllowed.join(", ")}`);
  if (showOnly) continue;

  console.log("\n  残すモデルも含め、許可する番号を入力してください。既存の選択を置き換えます。");
  console.log("  例: 1,3-4  |  all: 全件  |  none: 解除  |  Enter: モデル選択を維持");
  const pick = await ask("  入力 > ", list.length);
  const chosen = pick === null ? list.filter((m) => pa.models[m.id]) : pick.map((i) => list[i]);
  const next = {};
  for (const m of chosen) {
    const cur = pa.models[m.id];
    if (!m.efforts?.length) { next[m.id] = { efforts: "*" }; continue; }
    const curList = cur ? (cur.efforts === "*" ? m.efforts : cur.efforts) : null;
    console.log(`\n    ${m.id} のEffort（現在: ${cur ? effortLabel(cur.efforts) : "未設定"}）`);
    console.log(`    ${m.efforts.map((e, i) => `${i + 1}=${e}`).join("  ")}`);
    console.log(`    許可する番号を入力（Enter: ${curList ? effortLabel(curList) : "全候補"}）`);
    const ep = await ask("    入力 > ", m.efforts.length);
    next[m.id] = { efforts: ep === null ? curList || [...m.efforts] : ep.map((i) => m.efforts[i]) };
  }
  if (gone.length && pick === null) for (const id of gone) next[id] = pa.models[id]; // 現状維持時は一覧外も保持
  // 画面に出さない非表示モデルの許可は、この画面で変更できないため常に保持する。
  for (const m of models) if (m.hidden && pa.models[m.id]) next[m.id] = pa.models[m.id];
  pa.models = next;
  pa.reviewed = [...new Set([...reviewed, ...list.map((m) => m.id)])];
}

if (!showOnly) {
  saveAllowlist(al);
  console.log("\n保存しました。現在の許可:");
  let count = 0;
  for (const [pid, pa] of Object.entries(al.providers)) {
    const entries = Object.entries(pa.models);
    if (!entries.length) continue;
    console.log(`  ■ ${pid}`);
    for (const [mid, v] of entries) console.log(`    ${mid} — ${effortLabel(v.efforts)}`);
    count += entries.length;
  }
  if (!count) console.log("  許可済みモデルなし");
  rl.close();
}
