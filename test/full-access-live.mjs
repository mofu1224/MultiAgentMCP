// 既定full-access（permission省略）のnative会話を実機で検証する任意試験。モデル利用枠を消費する。通常のnpm testでは実行しない。
// 使い方: node test/full-access-live.mjs <provider> <許可済みmodel> <許可済みeffort>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const [provider, model, effort, switchModel] = process.argv.slice(2);
if (!provider || !model || !effort) {
  console.log("使い方: node test/full-access-live.mjs <provider> <許可済みmodel> <許可済みeffort> [会話中に切り替える許可済みmodel]");
  process.exit(1);
}
const dir = mkdtempSync(path.join(tmpdir(), "mamcp-falive-"));
const cwd = path.join(dir, "workspace");
mkdirSync(cwd);
const config = path.join(dir, "config.json");
writeFileSync(config, JSON.stringify({ dataDir: path.join(dir, "state"), policy: { allowedCwdRoots: [cwd] } }));
const print = (name, evidence) => console.log(JSON.stringify({ provider, test: name, ...evidence }));

// 履歴がディスクへ作られないことの確認用（内容は読まず、更新時刻と件数だけを見る）
function newestUnder(root, depth = 4) {
  let newest = 0, count = 0;
  const walk = (p, d) => {
    let entries; try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { if (d > 0) walk(f, d - 1); }
      else { count++; try { newest = Math.max(newest, statSync(f).mtimeMs); } catch { /* 消えた */ } }
    }
  };
  walk(root, depth);
  return { newest, count };
}
const historyRoot = provider === "codex" ? path.join(homedir(), ".codex", "sessions") : path.join(homedir(), ".claude", "projects");
const before = newestUnder(historyRoot);
const started = Date.now();

const client = new Client({ name: "full-access-live", version: "1" });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.resolve("src/server.mjs")],
    env: { ...process.env, MAMCP_CONFIG: config },
  }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const base = { provider, model, effort, cwd, timeout_ms: 240000 }; // permission省略 = full-access
  const finish = async id => {
    const waited = await call("wait_agents", { job_ids: [id], timeout_ms: 280000 });
    assert.equal(waited.timedOut, false, "待機上限");
    const compact = await call("get_agent", { job_id: id });
    assert.equal(compact.events, undefined);
    assert.equal(compact.result.usage, undefined);
    const detailed = await call("get_agent", { job_id: id, include_details: true });
    assert.equal(detailed.events, undefined);
    print("結果のみ返却", { compactBytes: Buffer.byteLength(JSON.stringify(compact)),
      detailedBytes: Buffer.byteLength(JSON.stringify(detailed)), status: compact.status });
    return detailed.result;
  };

  // 1. 既定full-access・標準編集・標準シェル
  const word = `PELICAN-${randomUUID().slice(0, 8)}`;
  const first = await call("start_agent", { ...base, task:
    `作業ディレクトリで次を行う。(1) ファイル edited.txt を作成し内容を正確に LIVE_EDIT_OK とする（改行なし可）。` +
    `(2) シェルで node -e "console.log(6*7)" を実行し、その標準出力を shell.txt に書く。` +
    `(3) 合言葉 ${word} を覚えておく。完了したら DONE とだけ答える。` });
  assert.equal(first.mode, "native");
  const r1 = await finish(first.jobId);
  const edited = existsSync(path.join(cwd, "edited.txt")) ? readFileSync(path.join(cwd, "edited.txt"), "utf8").trim() : null;
  const shell = existsSync(path.join(cwd, "shell.txt")) ? readFileSync(path.join(cwd, "shell.txt"), "utf8").trim() : null;
  print("full-access既定・編集・シェル", { status: r1.status, permission: r1.permission, isolation: r1.isolation,
    effective: r1.effective, edited, shell, toolUsage: r1.toolUsage, error: r1.error });
  assert.equal(r1.status, "succeeded", r1.error);
  assert.equal(r1.permission, "full-access");
  assert.equal(edited, "LIVE_EDIT_OK");
  assert.equal(shell, "42");

  // 2. 同じ会話へ新しい入力だけを送る（過去入力を再送しない）
  const second = await call("send_agent_message", { ...base, conversation_id: first.conversationId,
    task: "先ほど覚えた合言葉だけを答える。" });
  const r2 = await finish(second.jobId);
  print("native継続", { status: r2.status, output: r2.output?.trim(), expected: word, mode: r2.mode });
  assert.equal(r2.status, "succeeded", r2.error);
  assert.match(r2.output, new RegExp(word));

  // 2b. 任意: 同じ会話のまま許可済みの別モデルへ切り替える（第4引数）
  if (switchModel) {
    const sw = await call("send_agent_message", { ...base, model: switchModel, conversation_id: first.conversationId,
      task: "先ほど覚えた合言葉だけを答える。" });
    const rs = await finish(sw.jobId);
    print("会話中のモデル切替", { status: rs.status, modelUsed: rs.modelUsed, effective: rs.effective?.model, output: rs.output?.trim(), error: rs.error });
    assert.equal(rs.status, "succeeded", rs.error);
    assert.equal(rs.modelUsed, switchModel);
    assert.match(rs.output, new RegExp(word));
    base.model = switchModel; // 以降のターンも切替後のモデルで続ける
  }

  // 3. 実行中の取消（停止確認後に枠解放、他の会話へ波及しない）
  const other = await call("start_agent", { ...base, task: "OTHER_OK とだけ答える。" });
  const sleeper = await call("send_agent_message", { ...base, conversation_id: first.conversationId,
    task: 'シェルで node -e "setTimeout(()=>{},120000)" を実行し、終わったら SLEPT と答える。' });
  for (let i = 0; i < 120; i++) {
    const s = await call("get_agent", { job_id: sleeper.jobId, include_events: true, include_details: true });
    if (s.agentStatus === "running" && s.events.some(e => /adapter:item_completed|output/.test(e.stage)) || i > 40) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const cancelAt = Date.now();
  const cancel = await call("cancel_agent", { job_id: sleeper.jobId });
  const r3 = await finish(sleeper.jobId);
  const rOther = await finish(other.jobId);
  const listed = await call("list_agents");
  const conv = listed.conversations.find(c => c.conversationId === first.conversationId);
  print("取消", { requested: cancel.requested, status: r3.status, stopMs: Date.now() - cancelAt,
    conversationBroken: conv?.broken ?? null, otherStatus: rOther.status, shared: (await call("get_policy")).shared });
  assert.equal(r3.status, "cancelled");
  assert.equal(rOther.status, "succeeded");

  // 取消後も継続できるか（実行先が中断に従った場合）
  if (!conv?.broken) {
    const after = await call("send_agent_message", { ...base, conversation_id: first.conversationId, task: "AFTER_CANCEL_OK とだけ答える。" });
    const ra = await finish(after.jobId);
    print("取消後の継続", { status: ra.status, output: ra.output?.trim() });
    assert.equal(ra.status, "succeeded");
  }

  // 4. timeout（ユーザー取消と区別）
  const timed = await call("start_agent", { ...base, timeout_ms: 20000,
    task: 'シェルで node -e "setTimeout(()=>{},120000)" を実行し、終わったら SLEPT と答える。' });
  const rt = await finish(timed.jobId);
  print("timeout", { status: rt.status, durationMs: rt.durationMs });
  assert.equal(rt.status, "timeout");

  // 5. close/shutdown後に常駐プロセス・枠を残さない
  const closed = [];
  for (const c of (await call("list_agents")).conversations) {
    if (!c.busy) closed.push(await call("close_conversation", { conversation_id: c.conversationId }));
  }
  const policy = await call("get_policy");
  print("close", { closed: closed.map(c => `${c.closed}:${c.session}`), childControl: policy.childControl, shared: policy.shared });
  assert.equal(policy.childControl.liveSessions, 0);
  assert.equal(policy.shared.occupied, 0);
  assert.equal(policy.shared.queued, 0);
} finally {
  await client.close();
  const after = newestUnder(historyRoot);
  print("履歴保存", { root: historyRoot.replace(homedir(), "~"), newFilesDuringTest: after.newest > started && after.newest > before.newest,
    filesBefore: before.count, filesAfter: after.count });
  rmSync(dir, { recursive: true, force: true });
}
