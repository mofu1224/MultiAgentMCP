// OpenAI 互換 API（OpenAI API・OpenRouter・Ollama・LM Studio など）の汎用プロバイダー。
// 設定ファイルで baseUrl と apiKeyEnv を与えるだけで追加できる。ツール実行はなく、テキスト生成のみ。
export default function create(id, cfg = {}) {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const key = () => (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
  const headers = () => ({ "content-type": "application/json", ...(key() ? { authorization: `Bearer ${key()}` } : {}), ...(cfg.headers || {}) });
  // null でEffort非対応扱い（?? では null が既定値に置き換わるため undefined だけを既定にする）
  const effortParam = cfg.effortParam === undefined ? "reasoning_effort" : cfg.effortParam;

  return {
    id,
    type: "openai-compatible",
    description: cfg.description || `OpenAI 互換 API (${baseUrl})。テキスト生成のみ（ツール実行なし）。`,
    capabilities: { tools: false, fileAccess: false, jsonSchema: true, permissions: ["read-only"] },

    async available() {
      if (cfg.apiKeyEnv && !key()) return { ok: false, reason: `環境変数 ${cfg.apiKeyEnv} が未設定` };
      return { ok: true };
    },

    async listModels() {
      const res = await fetch(`${baseUrl}/models`, { headers: headers(), signal: AbortSignal.timeout(cfg.listTimeoutMs ?? 15000) });
      if (!res.ok) throw new Error(`GET /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return (data.data || data.models || []).map((m) => {
        const id = m.id || m.name;
        // Effort候補の優先順: APIの返却値 → 設定のモデル別 modelEfforts → 設定の efforts → effortParam:null（非対応＝[]）。
        // どれも無ければ未知（null）として実行を拒否する（固定制御 requireKnownEfforts）。
        const configured = cfg.modelEfforts?.[id] ?? cfg.efforts;
        const efforts = Array.isArray(m.supported_reasoning_efforts) ? m.supported_reasoning_efforts
          : Array.isArray(configured) ? configured : effortParam === null ? [] : null;
        return { id, displayName: m.name || m.id, description: m.description, efforts };
      });
    },

    async run({ model, effort, prompt, timeoutMs, jsonSchema, signal }) {
      if (!model) return { ok: false, error: "このプロバイダーはモデル指定が必須です" };
      const body = { model, messages: [{ role: "user", content: prompt }] };
      if (effort && effortParam) body[effortParam] = effort;
      if (jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "result", schema: jsonSchema } };
      const ctrl = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: ctrl });
      const txt = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 1500)}`, httpStatus: res.status };
      const j = JSON.parse(txt);
      const text = j.choices?.[0]?.message?.content ?? "";
      let structured;
      if (jsonSchema) try { structured = JSON.parse(text); } catch { /* 不正JSON */ }
      return { ok: true, text, structured, usage: j.usage || {}, modelUsed: j.model || model };
    },
  };
}
