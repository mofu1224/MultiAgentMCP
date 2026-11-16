import { test } from "node:test";
import assert from "node:assert/strict";

test("Claudeの推論専用モードにはツール・MCP・カスタマイズを渡さない", async () => {
  const { buildClaudeInferenceArgs } = await import("../src/inference-only.mjs");
  const args = buildClaudeInferenceArgs({ model: "chosen", effort: "deep" });
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf("--model") + 1], "chosen");
  assert.equal(args[args.indexOf("--effort") + 1], "deep");
  assert.equal(args.includes("--bare"), false);
});

test("OpenCode推論は履歴へ入力せずツール無しgenerateだけを使い、モデル・variantを固定する", async () => {
  const { opencodeInference } = await import("../src/inference-only.mjs");
  const calls = [];
  const api = async (method, endpoint, data) => {
    calls.push({ method, endpoint, data });
    if (endpoint.startsWith("/api/model")) return { data: [{ id: "chosen", providerID: "openai", variants: [{ id: "deep" }] }] };
    if (endpoint === "/api/session") return { data: { id: "ses_test", model: data.model } };
    if (endpoint.endsWith("/generate")) return { data: { text: "RESULT", tokens: { input: 1 }, cost: 0 } };
    return {};
  };
  const result = await opencodeInference({ model: "chosen", effort: "deep", prompt: "private prompt", timeoutMs: 1000 }, api);
  assert.equal(result.text, "RESULT");
  const created = calls.find(c => c.endpoint === "/api/session").data;
  assert.deepEqual(created.model, { providerID: "openai", id: "chosen", variant: "deep" });
  assert.deepEqual(created.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  assert.equal(calls.some(c => /\/prompt$/.test(c.endpoint)), false);
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).endpoint, "/api/session/ses_test");
});

test("OpenCodeに指定モデルやEffortがなければ別モデルで推論しない", async () => {
  const { opencodeInference } = await import("../src/inference-only.mjs");
  let created = false;
  await assert.rejects(opencodeInference({ model: "chosen", effort: "deep", prompt: "task" }, async (_method, route) => {
    if (route.startsWith("/api/model")) return { data: [{ id: "chosen", providerID: "openai", variants: [{ id: "light" }] }] };
    created = true; return {};
  }), /自動変換しません/);
  assert.equal(created, false);
});

test("OpenCode削除失敗は成功結果を隠さず警告し、生成失敗なら元の原因を残す", async () => {
  const { opencodeInference } = await import("../src/inference-only.mjs");
  for (const fail of [false, true]) {
    const api = async (method, endpoint, data) => {
      if (endpoint.startsWith("/api/model")) return { data: [{ id: "chosen", providerID: "openai", variants: [] }] };
      if (endpoint === "/api/session") return { data: { id: "ses_test", model: data.model } };
      if (endpoint.endsWith("/generate")) {
        if (fail) throw new Error("original failure");
        return { data: { text: "OK" } };
      }
      if (method === "DELETE") throw new Error("cleanup failed");
      return {};
    };
    const req = { model: "chosen", prompt: "dummy", timeoutMs: 1000 };
    if (fail) await assert.rejects(opencodeInference(req, api), /original failure.*削除/);
    else {
      const r = await opencodeInference(req, api);
      assert.equal(r.ok, true);
      assert.equal(r.text, "OK");
      assert.match(r.warnings[0], /削除/);
    }
  }
});
