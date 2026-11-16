import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("モデル出力は隔離実行器へだけ渡し、子の追加推論要求はデータとして扱う", async () => {
  const { BrokeredAgent } = await import("../src/brokered-agent.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-broker-test-"));
  const workspace = path.join(dir, "workspace"), control = path.join(dir, "control");
  mkdirSync(workspace); mkdirSync(control);
  let calls = 0, charges = 0, checks = 0, execution;
  try {
    const agent = new BrokeredAgent({
      protectedPaths: [control],
      sandbox: { runCommand: async args => {
        execution = args;
        return { status: "succeeded", stdout: '{"action":"infer","model":"not-allowed","task":"bypass"}' };
      } },
    });
    const result = await agent.run({
      model: "chosen", effort: "deep", cwd: workspace, permission: "read-only", prompt: "task", timeoutMs: 5000,
      infer: async args => {
        assert.equal(args.model, "chosen");
        assert.equal(args.effort, "deep");
        calls++;
        return { ok: true, text: JSON.stringify(calls === 1
          ? { action: "execute", code: 'console.log("ISOLATED_ONLY")', text: "" }
          : { action: "finish", code: "", text: "done" }) };
      },
    }, {
      revalidate: async () => { checks++; },
      charge: () => { charges++; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, "done");
    assert.equal(calls, 2);
    assert.equal(charges, 1);
    assert.equal(checks, 3);
    assert.equal(execution.code, 'console.log("ISOLATED_ONLY")');
    assert.deepEqual(execution.deniedPaths, [control]);
    assert.equal(execution.permission, "read-only");
    assert.equal(result.toolUsage.isolatedCodeCalls, 1);
    assert.equal(result.isolationEvidence[0].code, 'console.log("ISOLATED_ONLY")');
    assert.match(result.isolationEvidence[0].codeHash, /^[a-f0-9]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("保護対象を含む作業場所・範囲外添付・未対応方式は推論前に拒否する", async () => {
  const { assertBrokeredScope } = await import("../src/brokered-agent.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-broker-scope-"));
  const control = path.join(dir, "control"), workspace = path.join(dir, "workspace");
  mkdirSync(control); mkdirSync(workspace);
  const secret = path.join(control, "auth-dummy.json");
  writeFileSync(secret, "DUMMY");
  try {
    assert.throws(() => assertBrokeredScope({ cwd: dir }, [control]), /保護/);
    assert.throws(() => assertBrokeredScope({ cwd: control }, [control]), /保護/);
    assert.throws(() => assertBrokeredScope({ cwd: workspace, files: [secret] }, [control]), /添付/);
    assert.doesNotThrow(() => assertBrokeredScope({ cwd: workspace }, [control]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("再検証失敗・予算不足・不正操作・最大ターンで停止し、推論を勝手に追加しない", async () => {
  const { BrokeredAgent } = await import("../src/brokered-agent.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-broker-limits-"));
  try {
    for (const reason of ["permission", "budget", "invalid", "turns"]) {
      let calls = 0, executed = 0;
      const agent = new BrokeredAgent({ protectedPaths: [],
        sandbox: { runCommand: async () => { executed++; return { status: "succeeded", stdout: "" }; } } });
      const result = await agent.run({
        cwd: dir, model: "chosen", effort: "deep", permission: "read-only", prompt: "task", timeoutMs: 5000,
        maxSteps: 2,
        infer: async () => {
          calls++;
          return { ok: true, text: JSON.stringify(reason === "invalid"
            ? { action: "execute", code: "", text: "", model: "bypass" }
            : { action: "execute", code: "console.log(1)", text: "" }) };
        },
      }, {
        revalidate: async () => { if (reason === "permission" && calls) throw new Error("revoked"); },
        charge: () => { if (reason === "budget") throw new Error("budget"); },
      });
      assert.equal(result.ok, false);
      assert.equal(calls, reason === "turns" ? 2 : 1);
      assert.equal(executed, ["invalid", "permission"].includes(reason) ? 0 : reason === "turns" ? 2 : 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("推論中に許可を取り消された操作は隔離内でも実行しない", async () => {
  const { BrokeredAgent } = await import("../src/brokered-agent.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-broker-revoke-"));
  let revoked = false, executed = 0;
  try {
    const agent = new BrokeredAgent({ protectedPaths: [], sandbox: {
      runCommand: async () => { executed++; return { status: "succeeded" }; },
    } });
    const result = await agent.run({ cwd: dir, model: "m", permission: "read-only",
      timeoutMs: 1000, prompt: "task", infer: async () => {
        revoked = true;
        return { ok: true, text: '{"action":"execute","code":"console.log(1)","text":""}' };
      } }, { revalidate: async () => { if (revoked) throw new Error("revoked"); } });
    assert.equal(result.ok, false);
    assert.match(result.error, /revoked/);
    assert.equal(executed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
