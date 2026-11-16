// MCP クライアントとして主要ツールと実機のモデル一覧を確認する。生成依頼は送らない。
// 本番の allowlist.json は使わず、一時ファイルの許可リストで検証する。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowFile = path.join(tmpdir(), `mamcp-smoke-allow-${process.pid}.json`);
writeFileSync(allowFile, JSON.stringify({ providers: {} }));
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.mjs")], cwd: root, env: { ...process.env, MAMCP_ALLOWLIST: allowFile } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (r.isError) return { error: r.content[0].text };
  return JSON.parse(r.content[0].text);
};
const ok = (c, m) => { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };

try {
  const prov = await call("list_providers");
  ok(prov.providers.length >= 2, `providers: ${prov.providers.map((p) => `${p.id}=${p.available}`).join(" ")}`);

  const none = await call("list_models");
  ok(Object.values(none).every((v) => v.models.length === 0 && v.notice), "未許可時は list_models が空で新規通知あり");
  const all = await call("list_models", { include_disallowed: true });
  for (const [id, v] of Object.entries(all)) ok(v.models.length > 0, `${id}: ${v.models.map((m) => m.id).join(" ")}`);

  // 各プロバイダーの末尾モデル・先頭Effortだけを許可する（テスト用）
  const cm = all.codex.models.at(-1), cl = all.claude.models.at(-1), cDeny = all.codex.models[0];
  writeFileSync(allowFile, JSON.stringify({ providers: {
    codex: { models: { [cm.id]: { efforts: [cm.efforts[0]] } }, reviewed: all.codex.models.map((m) => m.id) },
    claude: { models: { [cl.id]: { efforts: [cl.efforts[0]] } }, reviewed: all.claude.models.map((m) => m.id) },
  } }));
  const allowed = await call("list_models");
  ok(allowed.codex.models.length === 1 && allowed.codex.models[0].allowedEfforts.join() === cm.efforts[0] && !allowed.codex.notice, `許可反映: ${allowed.codex.models.map((m) => `${m.id}[${m.allowedEfforts}]`)}`);

  const t = "x";
  const cases = [
    [{ provider: "codex", task: t, permission: "read-only", cwd: root }, "モデル未指定"],
    [{ provider: "codex", model: cm.id, task: t, permission: "read-only", cwd: root }, "Effort未指定"],
    [{ provider: "codex", model: cDeny.id, effort: cDeny.efforts[0], task: t, permission: "read-only", cwd: root }, "未許可モデル"],
    [{ provider: "codex", model: cm.id, effort: cm.efforts[1], task: t, permission: "read-only", cwd: root }, "未許可Effort"],
    [{ provider: "codex", model: cm.id, effort: cm.efforts[0], task: t, permission: "danger-full-access", cwd: root }, "未定義権限"],
    [{ provider: "codex", model: cm.id, effort: cm.efforts[0], task: t, permission: "full-access", isolation: "brokered", cwd: root }, "brokered+full-access矛盾"],
    [{ provider: "codex", model: cm.id, effort: cm.efforts[0], task: t, isolation: "brokered", cwd: root }, "brokered権限省略"],
  ];
  for (const [args, label] of cases) { const r = await call("run_agent", args); ok(r.status === "rejected" || !!r.error, `${label}: ${r.error}`); }

  const r = await call("run_agents_parallel", { runs: [
    { provider: "codex", model: cm.id, effort: cm.efforts[0], permission: "read-only", task: "この要求は起動しないこと" },
    { provider: "claude", model: cl.id, effort: cl.efforts[0], task: "この要求は起動しないこと" }, // 省略=full-access（全OSで対応）
  ] });
  for (const x of r.results) ok(x.status === "rejected" && /cwd/.test(x.error), `${x.provider || "CLI"} 作業場所未指定の拒否: ${x.error}`);
  const policy = await call("get_policy");
  ok(policy.fixedControl.nestedCalls === false && policy.fixedControl.requireAllowlist === true, "固定制御ポリシーを公開");
  ok(policy.fixedControl.defaultPermission === "full-access" && policy.childControl?.liveSessions === 0, "既定full-accessと子制御状態を公開");
  const sessions = prov.providers.filter(p => p.capabilities?.session).map(p => `${p.id}:${p.capabilities.session.adapter}`);
  ok(sessions.length === 2, `継続セッション対応: ${sessions.join(" ")}`);
  const tools = (await client.listTools()).tools.map(x => x.name);
  const winOnly = ["run_brokered_agent", "run_isolated_code", "sandbox_status"];
  ok(process.platform === "win32" ? winOnly.every(n => tools.includes(n)) : winOnly.every(n => !tools.includes(n)),
    `OS別の公開ツール（${process.platform}）: ${tools.length}件`);
} finally {
  await client.close();
  rmSync(allowFile, { force: true });
}
