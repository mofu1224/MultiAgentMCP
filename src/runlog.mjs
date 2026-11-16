// 実行記録（JSONL）。モデル別の使用量集計と、観測したモデル名の取得に使う。
import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

// 本運用で無制限に増えないよう、上限を超えたら新しい側の半分だけ残す（集計・観測モデルは残った範囲で行う）。
const MAX_BYTES = 4 * 1024 * 1024;

export class RunLog {
  constructor(dataDir, { maxBytes = MAX_BYTES } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "runs.jsonl");
    this.maxBytes = maxBytes;
  }

  compact() {
    try {
      if (statSync(this.file).size <= this.maxBytes) return false;
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      const kept = [];
      let size = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const bytes = Buffer.byteLength(lines[i], "utf8") + 1;
        if (size + bytes > this.maxBytes / 2) break;
        kept.unshift(lines[i]); size += bytes;
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, kept.map(l => `${l}\n`).join(""), { mode: 0o600 });
      renameSync(tmp, this.file); // 置換は一度に行う。同時に追記された数行が失われることはある（記録用途のため許容）
      return true;
    } catch { return false; } // 他プロセスと競合した場合は次回の追記で再試行
  }

  append(rec) {
    // 本文やエラーの部分文字列でも秘密が漏れるため、記録可能なメタデータだけを選ぶ。
    const fields = ["runId", "rootId", "parentRun", "depth", "provider",
      "modelRequested", "modelUsed", "modelsObserved", "effort", "permission", "isolation",
      "phase", "startedAt", "endedAt", "ok", "status", "timedOut", "durationMs"];
    const entry = Object.fromEntries(fields.filter(k => rec[k] !== undefined).map(k => [k, rec[k]]));
    if (rec.usage) entry.usage = Object.fromEntries(Object.entries(rec.usage).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
    appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    this.compact();
  }

  read() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  get(runId) { return this.read().find((r) => r.runId === runId) || null; }

  observedModels(providerId) {
    const s = new Set();
    for (const r of this.read()) if (r.provider === providerId) for (const m of r.modelsObserved || []) s.add(m);
    return [...s];
  }

  summary({ since, provider } = {}) {
    const t = since ? Date.parse(since) : 0;
    if (Number.isNaN(t)) throw new Error("since はISO日時で指定してください");
    const agg = {};
    for (const r of this.read()) {
      if (r.phase !== "end" || Date.parse(r.endedAt) < t || (provider && r.provider !== provider)) continue;
      const k = `${r.provider}/${r.modelUsed || r.modelRequested || "(default)"}`;
      const a = (agg[k] ||= { provider: r.provider, model: r.modelUsed || r.modelRequested || null, runs: 0, ok: 0, failed: 0, timedOut: 0, totalMs: 0, usage: {} });
      a.runs++; r.ok ? a.ok++ : a.failed++; if (r.timedOut) a.timedOut++;
      a.totalMs += r.durationMs || 0;
      for (const [uk, uv] of Object.entries(r.usage || {})) if (typeof uv === "number") a.usage[uk] = (a.usage[uk] || 0) + uv;
    }
    return Object.values(agg);
  }
}
