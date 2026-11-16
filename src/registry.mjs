// プロバイダー登録とモデル一覧のキャッシュ。プロバイダー種別は src/providers/<type>.mjs を動的に読み込む。
import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ROOT } from "./config.mjs";
import { isolationError } from "./control.mjs";

const ERROR_RETRY_MS = 5000;

export class Registry {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.providers = new Map();
    this.cache = new Map(); // providerId -> {at, models, error}
  }

  async init() {
    for (const [id, pc] of Object.entries(this.cfg.providers)) {
      if (pc.enabled === false) continue;
      const file = pc.module ? path.resolve(ROOT, pc.module) : path.join(ROOT, "src", "providers", `${pc.type}.mjs`);
      if (!existsSync(file)) { this.providers.set(id, { id, type: pc.type, broken: `プロバイダー種別 ${pc.type} の実装がありません` }); continue; }
      const mod = await import(pathToFileURL(file).href);
      this.providers.set(id, mod.default(id, pc));
    }
  }

  get(id) {
    const p = this.providers.get(id);
    if (!p) throw new Error(`未知のプロバイダー: ${id}（利用可能: ${[...this.providers.keys()].join(", ")}）`);
    if (p.broken) throw new Error(p.broken);
    return p;
  }

  async describeProviders() {
    const out = [];
    for (const p of this.providers.values()) {
      if (p.broken) { out.push({ id: p.id, type: p.type, available: false, reason: p.broken }); continue; }
      const a = await p.available().catch((e) => ({ ok: false, reason: e.message }));
      const blocked = isolationError(p);
      out.push({ id: p.id, type: p.type, description: p.description, available: a.ok,
        executionAvailable: a.ok && !blocked, executionBlockedReason: blocked,
        reason: a.reason, capabilities: p.capabilities });
    }
    return out;
  }

  async models(providerId, { refresh = false } = {}) {
    const p = this.get(providerId);
    const c = this.cache.get(providerId);
    // 取得失敗は短時間だけ保持し、一時的な失敗で全実行を長時間止めない。
    const ttl = c?.error ? Math.min(ERROR_RETRY_MS, this.cfg.policy.modelCacheTtlMs) : this.cfg.policy.modelCacheTtlMs;
    if (!refresh && c && Date.now() - c.at < ttl) return c;
    try {
      const models = await p.listModels({ observed: this.log.observedModels(providerId) });
      const entry = { at: Date.now(), models, error: null };
      this.cache.set(providerId, entry);
      return entry;
    } catch (e) {
      const entry = { at: Date.now(), models: c?.models || [], error: e.message, stale: !!c };
      this.cache.set(providerId, entry);
      return entry;
    }
  }

  async findModel(providerId, modelId) {
    const { models, error } = await this.models(providerId);
    let m = models.find((x) => x.id === modelId);
    if (!m) { // 改名・追加直後の可能性があるので一度だけ強制再取得
      const r = await this.models(providerId, { refresh: true });
      m = r.models.find((x) => x.id === modelId);
      return { model: m || null, known: r.models.map((x) => x.id), error: r.error };
    }
    return { model: m, known: models.map((x) => x.id), error };
  }
}
