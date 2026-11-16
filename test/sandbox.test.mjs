import { test } from "node:test";
import assert from "node:assert/strict";

test("隔離実行はホストディスク・認証・ネットワークを公開せず資源を制限する", async () => {
  const { dockerArgs } = await import("../src/sandbox.mjs");
  const args = dockerArgs("mamcp-test", "node:24-alpine", 100);
  for (const option of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=64", "--memory=128m", "--cpus=1", "--pull=never", "--user=65534:65534"]) assert.ok(args.includes(option));
  assert.equal(args.some(a => a === "-v" || a === "--volume" || a === "--mount" || a === "-e"), false);
  assert.ok(args.includes("node:24-alpine"));
  assert.equal(args.at(-1), "-");
});

test("Dockerが存在しない環境でホスト実行へフォールバックしない", async () => {
  const { Sandbox } = await import("../src/sandbox.mjs");
  const sandbox = new Sandbox({ backend: "docker", command: "mamcp-no-such-docker" });
  const status = await sandbox.available();
  assert.equal(status.ok, false);
  const result = await sandbox.run({ code: "console.log('not-on-host')" });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /Docker/);
});

test("MXCは最小読取・作業場所以外拒否・通信禁止のプロファイルを明示する", async () => {
  const { mxcArgs } = await import("../src/sandbox.mjs");
  assert.equal(typeof mxcArgs, "function");
  const args = mxcArgs("C:\\scratch", ["node.exe", "-"]);
  assert.ok(args.includes('windows.sandbox="mxc"'));
  const profile = args.find(a => a.startsWith("permissions="));
  assert.match(profile, /":root"="deny"/);
  assert.match(profile, /":minimal"="read"/);
  assert.match(profile, /enabled=false/);
  assert.ok(args.includes("--include-managed-config"));
  assert.deepEqual(args.slice(-2), ["node.exe", "-"]);
});

test("Docker shutdownは実行を取消し、コンテナ削除を確認してから共有枠を返す", async () => {
  const { Sandbox } = await import("../src/sandbox.mjs");
  const events = [];
  let started;
  const running = new Promise(r => { started = r; });
  const sandbox = new Sandbox({ backend: "docker",
    coordinator: { reserve: () => events.push("reserve"), tryAcquire: () => true, release: () => events.push("release") },
    execute: async ({ args, signal }) => {
      if (args[0] === "rm") { events.push("removed"); return { code: 0 }; }
      events.push("running"); started();
      await new Promise(resolve => {
        signal.addEventListener("abort", resolve, { once: true });
        if (signal.aborted) resolve();
      });
      events.push("stopped");
      return { code: null, stdout: "", stderr: "", aborted: true };
    },
  });
  sandbox.available = async () => ({ ok: true });
  const result = sandbox.run({ code: "unused" });
  await running;
  assert.equal(sandbox.active.size, 1);
  await sandbox.shutdown();
  assert.equal((await result).status, "cancelled");
  assert.equal((await result).cleanupConfirmed, true);
  assert.equal(sandbox.active.size, 0);
  assert.deepEqual(events, ["reserve", "running", "stopped", "removed", "release"]);
});
