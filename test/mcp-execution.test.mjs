import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP経由で許可済み指定を実行し、許可取消・未指定を拒否する（生成通信なし）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-mcp-"));
  const allow = path.join(dir, "allow.json"), config = path.join(dir, "config.json");
  const fixture = path.join(dir, "provider.mjs");
  writeFileSync(fixture, `export default id => ({
    id, type: "fixture",
    capabilities: { tools: true, fileAccess: true, executionControl: "provider-native", brokered: true, jsonSchema: true, permissions: ["read-only", "workspace-write"] },
    available: async () => ({ ok: true }),
    listModels: async () => [{ id: "chosen", efforts: ["deep", "light"] }],
    infer: async () => ({ ok: true, text: '{"action":"finish","code":"","text":"BROKER_DONE"}', usage: {tokens: 10} }),
    run: async ({model, effort, permission,prompt,signal}) => {
      if(prompt.includes("WAIT_FOR_CANCEL")) await new Promise(resolve => signal.addEventListener("abort", resolve, {once:true}));
      return { ok: !signal.aborted, proc: {aborted:signal.aborted},
        text: JSON.stringify({model, effort, permission, ...(prompt.includes("CHECK_HISTORY") && {hasHistory:prompt.includes("FIRST_MARKER")})}) };
    }
  });`);
  writeFileSync(config, JSON.stringify({
    providers: { codex: { enabled: false }, claude: { enabled: false }, fixture: { module: fixture } },
    dataDir: path.join(dir, "data"), policy: { allowedCwdRoots: [dir] },
  }));
  writeFileSync(allow, JSON.stringify({ providers: { fixture: { models: { chosen: { efforts: ["deep"] } } } } }));
  const client = new Client({ name: "execution-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.resolve("src/server.mjs")],
      env: { ...process.env, MAMCP_CONFIG: config, MAMCP_ALLOWLIST: allow },
    }));
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) return { error: response.content[0].text };
      return JSON.parse(response.content[0].text);
    };
    const models = await call("list_models");
    assert.deepEqual(models.fixture.models[0].allowedEfforts, ["deep"]);
    const req = { provider: "fixture", model: "chosen", effort: "deep", permission: "read-only", cwd: dir, task: "test" };
    const result = await call("run_agent", req);
    assert.equal(result.status, "succeeded", result.error);
    assert.deepEqual(JSON.parse(result.output), { model: "chosen", effort: "deep", permission: "read-only" });
    assert.equal(result.isolation, undefined);
    assert.equal(result.usage, undefined);
    const detailed = await call("run_agent", { ...req, include_details: true });
    assert.equal(detailed.isolation, "provider-native");
    const records = await call("get_run", { run_id: result.runId });
    assert.equal(records.at(-1).isolation, "provider-native");
    assert.equal(records.at(-1).status, "succeeded");
    const parallel = await call("run_agents_parallel", { runs: [req, { ...req, permission: "workspace-write" }] });
    assert.ok(parallel.results.every(r => r.status === "succeeded"));
    assert.ok(parallel.results.every(r => r.usage === undefined && r.isolation === undefined));
    const schema = { type: "object", properties: { model: { type: "string" } }, required: ["model"] };
    const structured = await call("run_agent", { ...req, json_schema: schema });
    assert.equal(structured.status, "succeeded");
    assert.equal(structured.structured.model, "chosen");
    assert.equal(structured.output, undefined);
    const invalid = await call("run_agent", { ...req, json_schema: {
      type: "object", properties: { missing: { type: "boolean" } }, required: ["missing"],
    } });
    assert.equal(invalid.status, "failed");
    assert.match(invalid.error, /JSON Schema/);
    assert.equal(JSON.parse(invalid.output).model, "chosen");
    assert.equal((await call("run_agent", { ...req, effort: "light" })).status, "rejected");
    assert.ok((await call("run_agent", { ...req, permission: undefined })).error);
    const progress = [];
    const notified = await client.callTool({ name: "run_agent", arguments: req }, undefined, {
      onprogress: event => progress.push(event),
    });
    assert.equal(JSON.parse(notified.content[0].text).status, "succeeded");
    assert.deepEqual(progress, [], "進捗通知は既定で送らない");
    await client.callTool({ name: "run_agent", arguments: { ...req, notify_progress: true } }, undefined, {
      onprogress: event => progress.push(event),
    });
    assert.ok(progress.some(p => p.message === "running"));
    const parallelProgress = [];
    const parallelNotified = await client.callTool({ name: "run_agents_parallel", arguments: {
      runs: [{ ...req, notify_progress: true }, { ...req, notify_progress: true, include_details: true }],
    } }, undefined, { onprogress: e => parallelProgress.push(e) });
    const parallelOut = JSON.parse(parallelNotified.content[0].text).results;
    assert.equal(parallelOut[0].usage, undefined);
    assert.deepEqual(parallelOut[1].usage, {});
    assert.ok(parallelProgress.length > 1);
    assert.ok(parallelProgress.every((e, i) => i === 0 || e.progress > parallelProgress[i - 1].progress),
      "並列通知のprogressは同じリクエスト内で単調増加する");
    if (process.platform === "win32") {
      const cwd = mkdtempSync(path.join(dir, "workspace-"));
      const brokerProgress = [];
      const brokerReq = { ...req, cwd };
      const response = await client.callTool({ name: "run_brokered_agent", arguments: brokerReq }, undefined, {
        onprogress: e => brokerProgress.push(e),
      });
      const broker = JSON.parse(response.content[0].text);
      assert.equal(broker.status, "succeeded", broker.error);
      assert.equal(broker.output, "BROKER_DONE");
      assert.equal(broker.isolationEvidence, undefined);
      assert.equal(broker.usage, undefined);
      assert.deepEqual(brokerProgress, []);
      const detailedBroker = await call("run_brokered_agent", { ...brokerReq, include_details: true });
      assert.equal(detailedBroker.isolation, "brokered-mxc");
      assert.deepEqual(detailedBroker.usage, { tokens: 10 });
      const asyncBroker = await call("start_agent", { ...brokerReq, isolation: "brokered" });
      await call("wait_agents", { job_ids: [asyncBroker.jobId], timeout_ms: 5000 });
      const asyncResult = await call("get_agent", { job_id: asyncBroker.jobId });
      assert.equal(asyncResult.events, undefined);
      assert.equal(asyncResult.result.output, "BROKER_DONE");
      assert.equal(asyncResult.result.usage, undefined);
      await client.callTool({ name: "run_brokered_agent", arguments: { ...brokerReq, notify_progress: true } }, undefined, {
        onprogress: e => brokerProgress.push(e),
      });
      assert.ok(brokerProgress.some(e => e.message === "broker-inference"));
    }
    const first = await call("start_agent", { ...req, task: "FIRST_MARKER" });
    const waitJob = async id => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await call("get_agent", { job_id: id });
        if (state.result) return state;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("job timeout");
    };
    const compact = await waitJob(first.jobId);
    assert.equal(compact.status, "succeeded");
    assert.equal(compact.events, undefined);
    assert.equal(compact.lastSequence, undefined);
    assert.equal(compact.result.usage, undefined);
    const withEvents = await call("get_agent", { job_id: first.jobId, include_events: true });
    assert.ok(withEvents.events.some(e => e.stage === "running"));
    assert.deepEqual(await call("get_agent", { job_id: first.jobId, include_events: true, after_event: withEvents.lastSequence }),
      { ...withEvents, events: [] });
    const withDetails = await call("get_agent", { job_id: first.jobId, include_details: true });
    assert.equal(withDetails.result.isolation, "provider-native");
    assert.equal(withDetails.events, undefined, "詳細とイベントは独立した指定");
    assert.ok((await call("get_agent", { job_id: first.jobId, after_event: 0 })).error);
    const second = await call("send_agent_message", { ...req, task: "CHECK_HISTORY", conversation_id: first.conversationId });
    assert.equal(JSON.parse((await waitJob(second.jobId)).result.output).hasHistory, true);
    const pending = await call("start_agent", { ...req, task: "WAIT_FOR_CANCEL" });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await call("get_agent", { job_id: pending.jobId });
      assert.equal(state.events, undefined);
      if (state.status === "running") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await call("cancel_agent", { job_id: pending.jobId })).requested, true);
    assert.equal((await waitJob(pending.jobId)).status, "cancelled");
    const timed = await call("run_agent", { ...req, task: "WAIT_FOR_CANCEL", timeout_ms: 100 });
    assert.equal(timed.status, "timeout");
    assert.equal(timed.usage, undefined);
    assert.equal((await call("close_conversation", { conversation_id: first.conversationId })).closed, true);
    assert.ok((await call("get_agent", { job_id: first.jobId })).error);
    const partial = await call("run_agents_parallel", { runs: [
      req, { ...req, conversation_id: first.conversationId },
    ] });
    assert.equal(partial.results.length, 2);
    assert.equal(partial.results[0].status, "succeeded", JSON.stringify(partial));
    assert.ok(partial.results[0].jobId, "他の受付失敗で成功したジョブのIDを失わない");
    assert.equal(partial.results[1].status, "rejected");
    assert.match(partial.results[1].error, /会話が存在しません/);
    writeFileSync(allow, '{"providers":{}}');
    assert.equal((await call("run_agent", req)).status, "rejected");
    // 制限権限のfixtureではpermission省略（=full-access）を実行先未対応として拒否する
    writeFileSync(allow, JSON.stringify({ providers: { fixture: { models: { chosen: { efforts: ["deep"] } } } } }));
    const defaulted = await call("run_agent", { ...req, permission: undefined });
    assert.equal(defaulted.status, "rejected");
    assert.match(defaulted.error, /full-access/);
    const shared = (await call("get_policy")).shared;
    assert.equal(shared.occupied, 0);
    assert.equal(shared.queued, 0);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP経由: 省略時full-accessのnative会話を継続・待機・終了し、brokeredのfull-accessを拒否する", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-native-"));
  const allow = path.join(dir, "allow.json"), config = path.join(dir, "config.json");
  const fixture = path.join(dir, "provider.mjs");
  writeFileSync(fixture, `export default id => ({
    id, type: "fixture",
    capabilities: { tools: true, fileAccess: true, executionControl: "provider-native", jsonSchema: true, permissions: ["full-access", "read-only", "workspace-write"] },
    available: async () => ({ ok: true }),
    listModels: async () => [{ id: "chosen", efforts: ["deep"] }],
    run: async () => ({ ok: false, error: "単発経路は使わない" }),
    openSession: async ({ permission }) => {
      const memory = [];
      return { capabilities: { nativeContinuation: true, modelSwitch: true, effortSwitch: true },
        effective: { permission },
        async turn({ turnId, prompt, onEvent }) {
          memory.push(prompt.includes("SECOND") ? "SECOND" : prompt.includes("FIRST") ? "FIRST" : "?");
          onEvent({ turnId, type: "turn_started" });
          onEvent({ turnId, type: "turn_completed" });
          return { ok: true, text: JSON.stringify({ memory, resent: prompt.includes("FIRST") && prompt.includes("SECOND") }), effective: { permission } };
        },
        async close() {} };
    },
  });`);
  writeFileSync(config, JSON.stringify({
    providers: { codex: { enabled: false }, claude: { enabled: false }, fixture: { module: fixture } },
    dataDir: path.join(dir, "data"), policy: { allowedCwdRoots: [dir] },
  }));
  writeFileSync(allow, JSON.stringify({ providers: { fixture: { models: { chosen: { efforts: ["deep"] } } } } }));
  const client = new Client({ name: "native-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.resolve("src/server.mjs")],
      env: { ...process.env, MAMCP_CONFIG: config, MAMCP_ALLOWLIST: allow },
    }));
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) return { error: response.content[0].text };
      return JSON.parse(response.content[0].text);
    };
    const req = { provider: "fixture", model: "chosen", effort: "deep", cwd: dir, task: "FIRST" };
    const first = await call("start_agent", req);
    assert.equal(first.mode, "native");
    const waited = await call("wait_agents", { job_ids: [first.jobId], timeout_ms: 5000 });
    assert.equal(waited.timedOut, false);
    const firstResult = (await call("get_agent", { job_id: first.jobId, include_details: true })).result;
    assert.equal(firstResult.permission, "full-access");
    assert.equal(firstResult.isolation, "full-access");
    const second = await call("send_agent_message", { ...req, task: "SECOND", conversation_id: first.conversationId });
    await call("wait_agents", { job_ids: [second.jobId], timeout_ms: 5000 });
    const out = JSON.parse((await call("get_agent", { job_id: second.jobId })).result.output);
    assert.deepEqual(out.memory, ["FIRST", "SECOND"]);
    assert.equal(out.resent, false);
    const listed = await call("list_agents");
    assert.equal(listed.conversations[0].liveSession, true);
    assert.equal(listed.control.liveSessions, 1);
    const closed = await call("close_conversation", { conversation_id: first.conversationId });
    assert.equal(closed.session, "terminated");
    assert.equal((await call("get_policy")).childControl.liveSessions, 0);
    const toolNames = (await client.listTools()).tools.map(t => t.name);
    if (process.platform === "win32") {
      assert.ok((await call("run_brokered_agent", { ...req })).error, "brokeredは権限明示が必須");
      assert.ok((await call("run_brokered_agent", { ...req, permission: "full-access" })).error);
      const conflicting = await call("run_agent", { ...req, isolation: "brokered", permission: "full-access" });
      assert.equal(conflicting.status, "rejected");
      assert.match(conflicting.error, /brokered/);
      assert.equal(toolNames.length, 17);
    } else {
      // MXCが無いOSでは動かない機能を公開しない
      for (const name of ["run_brokered_agent", "run_isolated_code", "sandbox_status"]) assert.ok(!toolNames.includes(name), name);
      assert.equal(toolNames.length, 14);
      assert.ok((await call("run_agent", { ...req, isolation: "brokered", permission: "read-only" })).error, "isolationは入力項目にない");
      assert.match(client.getInstructions(), /このOS.*除去済み/s);
      assert.equal((await call("get_policy")).fixedControl.brokeredIsolation, false);
    }
    const shared = (await call("get_policy")).shared;
    assert.equal(shared.occupied, 0);
    assert.equal(shared.queued, 0);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
