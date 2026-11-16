import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

test("上限を設定した場合は複数実行器で予算と枠を共有し、再起動でも受付数を引き継ぐ", async () => {
  const { Coordinator } = await import("../src/coordinator.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-coordinator-"));
  const options = { maxConcurrent: 1, maxCalls: 2 };
  let a, b;
  try {
    a = new Coordinator(dir, options);
    b = new Coordinator(dir, options);
    a.reserve("a");
    b.reserve("b");
    assert.throws(() => b.reserve("c"), /上限/);
    assert.equal(a.tryAcquire("a"), true);
    assert.equal(b.tryAcquire("b"), false);
    a.release("a");
    assert.equal(b.tryAcquire("b"), true);
    assert.equal(a.status().occupied, 1);
    assert.throws(() => a.resetBudget(), /実行/);
    b.release("b");
    a.close(); a = null;
    b.close(); b = new Coordinator(dir, options);
    assert.equal(b.status().accepted, 2);
    assert.throws(() => b.reserve("d"), /上限/);
    b.resetBudget();
    b.reserve("d");
    assert.equal(b.status().accepted, 1);
  } finally {
    a?.close(); b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("所有者が生きている実行枠は回収せず、所有プロセスが消えた枠は自動で回収する", async () => {
  const { Coordinator } = await import("../src/coordinator.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-orphan-"));
  const moduleUrl = pathToFileURL(path.resolve("src/coordinator.mjs")).href;
  let b;
  try {
    // 生存中の所有者（このプロセス）の枠は回収しない
    const a = new Coordinator(dir, { maxConcurrent: 1 });
    a.reserve("live"); a.tryAcquire("live");
    b = new Coordinator(dir, { maxConcurrent: 1 });
    b.reserve("next");
    assert.equal(b.tryAcquire("next"), false);
    a.release("live"); a.close();
    assert.equal(b.tryAcquire("next"), true);
    b.release("next");
    // 強制終了などで所有プロセスが消えた枠は回収する
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e",
        `import {Coordinator} from ${JSON.stringify(moduleUrl)}; const c=new Coordinator(process.argv[1],{maxConcurrent:1}); c.reserve("dead"); c.tryAcquire("dead"); process.exit(0);`, dir], { windowsHide: true });
      child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    b.reserve("after");
    assert.equal(b.tryAcquire("after"), true, "消えた所有者の枠で詰まらない");
    assert.ok(!b.status().leases.some(l => l.id === "dead"));
  } finally {
    b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ハートビートが途絶えた枠は回収し、受付数は既定で上限なし", async () => {
  const { Coordinator } = await import("../src/coordinator.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-stale-"));
  try {
    const a = new Coordinator(dir, { maxConcurrent: 1, staleMs: 50, alive: () => true });
    for (let i = 0; i < 40; i++) { a.reserve(`r${i}`); a.release(`r${i}`); } // 旧版の永続上限30を超えても受け付ける
    assert.equal(a.status().maxCalls, null);
    assert.equal(a.status().accepted, 40);
    a.reserve("hung"); a.tryAcquire("hung");
    await new Promise(r => setTimeout(r, 120));
    const s = a.status();
    assert.equal(s.occupied, 0);
    assert.equal(s.reclaimed, 1);
    a.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("旧版のDBに残る永続上限30は引き継がない", async () => {
  const { Coordinator } = await import("../src/coordinator.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-migrate-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "control.sqlite"));
    db.exec(`CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), accepted INTEGER NOT NULL, maxConcurrent INTEGER NOT NULL, maxCalls INTEGER NOT NULL);
      CREATE TABLE leases (id TEXT PRIMARY KEY, ownerPid INTEGER NOT NULL, state TEXT NOT NULL, createdAt TEXT NOT NULL);
      INSERT INTO control VALUES (1,30,3,30);`);
    db.close();
    const c = new Coordinator(dir, { maxConcurrent: 3 });
    c.reserve("x");
    assert.equal(c.status().accepted, 31);
    c.release("x"); c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("独立したOSプロセス間でも受付予算を原子的に確保する", async () => {
  const { Coordinator } = await import("../src/coordinator.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-multiprocess-"));
  const moduleUrl = pathToFileURL(path.resolve("src/coordinator.mjs")).href;
  const source = `
    import {Coordinator} from ${JSON.stringify(moduleUrl)};
    import {setTimeout as delay} from "node:timers/promises";
    const c = new Coordinator(process.argv[1], {maxConcurrent:2,maxCalls:4});
    const id = String(process.pid);
    try {
      c.reserve(id);
      while(!c.tryAcquire(id)) await delay(10);
      const n = c.status().occupied;
      await delay(20);
      c.release(id);
      console.log(JSON.stringify({accepted:true,occupied:n}));
    } catch(error) {console.log(JSON.stringify({accepted:false,error:error.message}));}
  `;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, dir], { windowsHide: true });
      let out = "", err = "";
      child.stdout.on("data", d => out += d);
      child.stderr.on("data", d => err += d);
      child.on("error", reject);
      child.on("close", code => {
        if (code !== 0) reject(new Error(err));
        else { try { resolve(JSON.parse(out.trim())); } catch(error) { reject(error); } }
      });
    })));
    assert.equal(results.filter(r => r.accepted).length, 4);
    assert.ok(results.filter(r => r.accepted).every(r => r.occupied <= 2));
    const status = new Coordinator(dir, { maxConcurrent: 2, maxCalls: 4 }).status();
    assert.equal(status.accepted, 4);
    assert.equal(status.occupied, 0);
    assert.equal(status.queued, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("同じ実行枠の追加推論も永続予算へ課金し、上限で拒否する", async () => {
  const { Coordinator } = await import("../src/coordinator.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "mamcp-inference-budget-"));
  try {
    const c = new Coordinator(dir, { maxConcurrent: 1, maxCalls: 2 });
    c.reserve("job"); c.tryAcquire("job");
    c.charge();
    assert.equal(c.status().accepted, 2);
    assert.equal(c.status().occupied, 1);
    assert.throws(() => c.charge(), /上限/);
    c.release("job");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
