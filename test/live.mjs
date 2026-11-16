// 明示した許可済みモデルでだけ実行する任意の実機試験。通常のnpm testでは実行しない。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const [provider, model, effort] = process.argv.slice(2);
if (!provider || !model || !effort) {
  console.log("使い方: node test/live.mjs <provider> <許可済みmodel> <許可済みeffort>");
  process.exit(1);
}
const dir = mkdtempSync(path.join(tmpdir(), "mamcp-live-"));
const cwd = path.join(dir, "workspace");
mkdirSync(cwd);
const config = path.join(dir, "config.json");
writeFileSync(config, JSON.stringify({ dataDir: path.join(dir, "state"), policy: { allowedCwdRoots: [cwd] } }));
const client = new Client({ name: "live-verification", version: "1" });
const print = (name, evidence) => console.log(JSON.stringify({ provider, test: name, ...evidence }));
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.resolve("src/server.mjs")],
    env: { ...process.env, MAMCP_CONFIG: config },
  }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const base = { provider, model, effort, cwd, permission: "read-only", timeout_ms: 120000 };
  const wait = async id => {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const state = await call("get_agent", { job_id: id, include_events: true });
      if (state.result) return state;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("実機ジョブ待機の上限");
  };
  const edit = await call("run_agent", {
    ...base, permission: "workspace-write", include_details: true,
    task: 'この作業フォルダでのみ動作確認してください。proof.txtを作成し内容をEDIT_OKにしてください。その後、利用可能なシェルツール（Claudeではmamcp_shellのrun_command）で node -e "require(\'fs\').writeFileSync(\'execution-proof.txt\',String(6*7));console.log(6*7)" を実行してください。できなかった操作は明示してください。',
  });
  const edited = existsSync(path.join(cwd, "proof.txt")) && readFileSync(path.join(cwd, "proof.txt"), "utf8").trim() === "EDIT_OK";
  const executed = existsSync(path.join(cwd, "execution-proof.txt")) && readFileSync(path.join(cwd, "execution-proof.txt"), "utf8") === "42";
  print("edit-and-shell", { status: edit.status, edited, executed, toolUsage: edit.toolUsage, output: edit.output, error: edit.error });
  assert.equal(edit.status, "succeeded");
  assert.ok(edited);
  assert.ok(executed);
  assert.ok(edit.toolUsage.successfulShellCalls > 0);
  writeFileSync(path.join(cwd, "locked.txt"), "UNCHANGED");
  const denied = await call("run_agent", {
    ...base, task: "権限制御の動作確認です。locked.txtをMODIFIEDに上書きしようとしてください。権限で拒否された場合は迂回せずDENIEDと返してください。",
  });
  const unchanged = readFileSync(path.join(cwd, "locked.txt"), "utf8") === "UNCHANGED";
  print("read-only-denial", { status: denied.status, unchanged, output: denied.output });
  assert.ok(unchanged);
  const first = await call("start_agent", { ...base, task: "会話の検証用の合言葉はORCHID_731です。覚えてACKとだけ返してください。" });
  assert.equal((await wait(first.jobId)).status, "succeeded");
  const next = await call("send_agent_message", {
    ...base, conversation_id: first.conversationId, task: "前の依頼で伝えた合言葉だけ返してください。",
  });
  const continued = await wait(next.jobId);
  print("conversation", { status: continued.status, remembered: continued.result.output.includes("ORCHID_731"), events: continued.events.map(e => e.stage) });
  assert.ok(continued.result.output.includes("ORCHID_731"));
  const slowTask = "動作確認です。まずシェルで node -e \"setTimeout(()=>console.log('DONE'),60000)\" を実行してください。勝手に短縮せず完了を待ってください。";
  const cancelled = await call("start_agent", { ...base, permission: "workspace-write", task: slowTask });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await call("cancel_agent", { job_id: cancelled.jobId });
  const stopped = await wait(cancelled.jobId);
  print("cancel", { status: stopped.status });
  assert.equal(stopped.status, "cancelled");
  const timeout = await call("run_agent", { ...base, permission: "workspace-write", task: slowTask, timeout_ms: 1000 });
  print("timeout", { status: timeout.status });
  assert.equal(timeout.status, "timeout");
  const shared = (await call("get_policy")).shared;
  print("shared-slots", { occupied: shared.occupied, queued: shared.queued, accepted: shared.accepted });
  assert.equal(shared.occupied, 0);
  assert.equal(shared.queued, 0);
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
