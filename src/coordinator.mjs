// 配置単位の同時実行枠と受付数。本文・認証情報は保存しない。
// 受付予算は既定で上限なし（2026-11-15 ユーザー判断）。config の maxCallsPerRoot を正の整数にした場合だけ上限として使う。
// 実行枠は所有プロセスのハートビートで生存を示し、所有者が消えた枠・更新が途絶えた枠は自動で回収する。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const HEARTBEAT_MS = 15000;
const STALE_MS = 120000;

/** 同じOSユーザーのプロセスが存在するか。権限不足（EPERM）は存在扱いにして誤回収しない。 */
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export class Coordinator {
  constructor(dir, { maxConcurrent = 3, maxCalls = 0, staleMs = STALE_MS, heartbeatMs = HEARTBEAT_MS, alive = processAlive } = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "control.sqlite");
    this.staleMs = staleMs;
    this.alive = alive;
    const limit = Number.isSafeInteger(maxCalls) && maxCalls > 0 ? maxCalls : 0; // 0 = 上限なし
    this.db(db => {
      db.exec(`CREATE TABLE IF NOT EXISTS control (
        id INTEGER PRIMARY KEY CHECK(id=1), accepted INTEGER NOT NULL,
        maxConcurrent INTEGER NOT NULL, maxCalls INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, ownerPid INTEGER NOT NULL, state TEXT NOT NULL, createdAt TEXT NOT NULL);`);
      if (!db.prepare("PRAGMA table_info(leases)").all().some(c => c.name === "heartbeat"))
        db.exec("ALTER TABLE leases ADD COLUMN heartbeat TEXT");
      db.prepare("INSERT OR IGNORE INTO control VALUES (1,0,?,?)").run(maxConcurrent, limit);
      // 同じ配置は同じ設定を使う。起動した設定で上書きする（旧版の永続上限30を引き継がない）。
      db.prepare("UPDATE control SET maxConcurrent=?, maxCalls=? WHERE id=1").run(maxConcurrent, limit);
    });
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.timer.unref?.();
  }
  db(fn) {
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA busy_timeout=5000;");
      db.exec("BEGIN IMMEDIATE");
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 開始前のエラー */ }
      throw error;
    } finally { db.close(); }
  }
  /** 所有プロセスが存在しない枠と、ハートビートが途絶えた枠を回収する。回収数を返す。 */
  #reclaim(db) {
    const now = Date.now();
    let n = 0;
    for (const l of db.prepare("SELECT id, ownerPid, createdAt, heartbeat FROM leases").all()) {
      const last = Date.parse(l.heartbeat || l.createdAt) || 0;
      const dead = l.ownerPid !== process.pid && !this.alive(l.ownerPid);
      if (dead || now - last > this.staleMs) { db.prepare("DELETE FROM leases WHERE id=?").run(l.id); n++; }
    }
    return n;
  }
  #check(db) {
    const c = db.prepare("SELECT accepted,maxCalls FROM control WHERE id=1").get();
    if (c.maxCalls > 0 && c.accepted >= c.maxCalls) throw new Error(`共有の呼び出し上限 (${c.maxCalls}) に達しました`);
  }
  /** このプロセスが現在使っている枠だけを更新する。解放に失敗した枠は更新せず再解放を試み、更新途絶で回収されるようにする。 */
  heartbeat() {
    try {
      this.db(db => {
        const del = db.prepare("DELETE FROM leases WHERE id=? AND ownerPid=?");
        for (const id of this.pendingRelease) del.run(id, process.pid);
        const beat = db.prepare("UPDATE leases SET heartbeat=? WHERE id=? AND ownerPid=?");
        const now = new Date().toISOString();
        for (const id of this.owned) beat.run(now, id, process.pid);
      });
      this.pendingRelease.clear();
    } catch { /* 一時的なロック競合は次回 */ }
  }
  owned = new Set();
  pendingRelease = new Set();
  reserve(id) {
    this.db(db => {
      this.#reclaim(db);
      this.#check(db);
      const now = new Date().toISOString();
      db.prepare("INSERT INTO leases (id, ownerPid, state, createdAt, heartbeat) VALUES (?,?,?,?,?)").run(id, process.pid, "waiting", now, now);
      db.prepare("UPDATE control SET accepted=accepted+1 WHERE id=1").run();
    });
    this.owned.add(id);
  }
  charge() {
    this.db(db => {
      this.#check(db);
      db.prepare("UPDATE control SET accepted=accepted+1 WHERE id=1").run();
    });
  }
  tryAcquire(id) {
    return this.db(db => {
      const c = db.prepare("SELECT * FROM control WHERE id=1").get();
      const own = db.prepare("SELECT * FROM leases WHERE id=?").get(id);
      if (!own || own.ownerPid !== process.pid) throw new Error("共有実行枠の所有者が不正です");
      db.prepare("UPDATE leases SET heartbeat=? WHERE id=?").run(new Date().toISOString(), id);
      if (own.state === "running") return true;
      this.#reclaim(db);
      const count = db.prepare("SELECT count(*) AS n FROM leases WHERE state='running'").get().n;
      if (count >= c.maxConcurrent) return false;
      db.prepare("UPDATE leases SET state='running' WHERE id=?").run(id);
      return true;
    });
  }
  /** 解放は例外を投げない。失敗した枠はハートビートを止めて次回再解放し、それでも残れば更新途絶で回収される。 */
  release(id) {
    this.owned.delete(id);
    try { this.db(db => db.prepare("DELETE FROM leases WHERE id=? AND ownerPid=?").run(id, process.pid)); }
    catch { this.pendingRelease.add(id); return false; }
    return true;
  }
  status() {
    return this.db(db => {
      const reclaimed = this.#reclaim(db);
      const c = db.prepare("SELECT accepted,maxConcurrent,maxCalls FROM control WHERE id=1").get();
      const leases = db.prepare("SELECT id,ownerPid,state,createdAt,heartbeat FROM leases ORDER BY rowid").all();
      return { ...c, maxCalls: c.maxCalls || null, occupied: leases.filter(l => l.state === "running").length,
        queued: leases.filter(l => l.state === "waiting").length, leases, ...(reclaimed && { reclaimed }) };
    });
  }
  resetBudget() {
    this.db(db => {
      if (db.prepare("SELECT count(*) AS n FROM leases").get().n)
        throw new Error("待機・実行枠があるため受付数をリセットできません");
      db.prepare("UPDATE control SET accepted=0 WHERE id=1").run();
    });
  }
  close() { clearInterval(this.timer); }
}
