// 非信頼JavaScriptの実行専用。モデルCLI自身の認証・通信の隔離とは別機能。
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess, resolveCommand } from "./proc.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function mxcArgs(cwd, commandArgs, permission = "workspace-write", deniedPaths = []) {
  const access = permission === "read-only" ? "read" : "write";
  const denied = deniedPaths.map(p => `${JSON.stringify(path.resolve(p))}="deny"`).join(",");
  const secrets = deniedPaths.length ? ',".env"="deny",".env.*"="deny",".npmrc"="deny",".ssh"="deny",".aws"="deny","**/.env"="deny","**/.env.*"="deny"' : "";
  const policy = `permissions={mamcp={filesystem={${secrets ? "glob_scan_max_depth=8," : ""}":root"="deny",":minimal"="read"${denied ? `,${denied}` : ""},":workspace_roots"={"."="${access}"${secrets}}},network={enabled=false}}}`;
  return ["-c", 'windows.sandbox="mxc"', "-c", policy, "sandbox",
    "--include-managed-config", "--permission-profile", "mamcp", "-C", cwd, "--", ...commandArgs];
}

function cleanEnv(cwd) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "CODEX_HOME"])
    if (process.env[key]) env[key] = process.env[key];
  env.TEMP = cwd; env.TMP = cwd;
  return env;
}

export function dockerArgs(name, image) {
  return ["run", "--name", name, "--rm", "--interactive", "--pull=never",
    "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=64", "--memory=128m", "--cpus=1", "--ipc=none",
    "--user=65534:65534", "--tmpfs=/work:rw,nosuid,nodev,size=16m,mode=1777", "--workdir=/work",
    image, "node", "--max-old-space-size=64", "-"];
}

export class Sandbox {
  constructor({ backend = process.platform === "win32" ? "mxc" : "docker", command, image = "node:24-alpine", coordinator, execute = runProcess } = {}) {
    this.backend = backend;
    this.command = command || (backend === "mxc" ? "codex" : "docker");
    this.image = image; this.coordinator = coordinator;
    this.active = new Set();
    this.execute = execute;
  }
  async available() {
    if (this.backend === "mxc") {
      if (process.platform !== "win32" || !resolveCommand(this.command))
        return { ok: false, reason: "Windows MXCと対応Codex CLIが必要です" };
      const dir = mkdtempSync(path.join(tmpdir(), "mamcp-mxc-probe-"));
      try {
        const r = await runProcess({ command: this.command, args: mxcArgs(dir, [process.execPath, "-"]),
          stdin: 'console.log("MXC_OK")', cwd: dir, env: cleanEnv(dir), inheritEnv: false, timeoutMs: 10000 });
        return r.code === 0 && r.stdout.trim() === "MXC_OK"
          ? { ok: true, backend: "mxc", network: false, filesystem: "minimal-and-workspace" }
          : { ok: false, reason: "MXCの制限付き起動に失敗しました。弱い方式へ切り替えません", detail: r.stderr.slice(-1000) };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    if (this.backend !== "docker") return { ok: false, reason: "未知の隔離バックエンドです" };
    if (!resolveCommand(this.command)) return { ok: false, reason: "Dockerが見つかりません。ホスト実行へはフォールバックしません" };
    const version = await runProcess({ command: this.command, args: ["version", "--format", "{{.Server.Os}}"], timeoutMs: 10000 });
    if (version.code !== 0 || version.stdout.trim() !== "linux")
      return { ok: false, reason: "利用可能なLinux Docker Engineが必要です" };
    const image = await runProcess({ command: this.command, args: ["image", "inspect", this.image], timeoutMs: 10000 });
    if (image.code !== 0) return { ok: false, reason: `隔離用イメージ ${this.image} がありません。自動pullは行いません` };
    return { ok: true, image: this.image };
  }
  async run({ code, timeout_ms = 30000 }, { signal, onProgress } = {}) {
    if (this.backend === "mxc") {
      const dir = mkdtempSync(path.join(tmpdir(), "mamcp-mxc-code-"));
      try {
        return await this.runCommand({ code, cwd: dir, executable: process.execPath, args: ["--max-old-space-size=64", "-"], timeoutMs: timeout_ms },
          { signal, onProgress });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // サーバー終了時に取消・コンテナ削除・枠解放まで待てるよう、Docker実行も active に登録する。
    const ctrl = new AbortController();
    const task = { ctrl };
    task.promise = this.#runDocker({ code, timeout_ms }, { signal: signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal, onProgress })
      .finally(() => this.active.delete(task));
    this.active.add(task);
    return task.promise;
  }
  async #runDocker({ code, timeout_ms }, { signal, onProgress }) {
    const ready = await this.available().catch(() => ({ ok: false, reason: "Dockerの状態確認に失敗しました" }));
    if (!ready.ok) return { status: "rejected", error: ready.reason };
    const id = `mamcp-${randomUUID()}`;
    let reserved = false, launched = false, cleanupConfirmed = true, result;
    const timed = AbortSignal.timeout(timeout_ms);
    const combined = AbortSignal.any([timed, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      if (this.coordinator) {
        this.coordinator.reserve(id); reserved = true;
        while (!this.coordinator.tryAcquire(id)) await delay(50, undefined, { signal: combined });
      }
      combined.throwIfAborted();
      launched = true;
      const run = await this.execute({ command: this.command, args: dockerArgs(id, this.image),
        stdin: code, timeoutMs: timeout_ms, signal: combined, onProgress, maxOutputBytes: 1024 * 1024 });
      result = { status: signal?.aborted ? "cancelled" : timed.aborted || run.timedOut ? "timeout" : run.code === 0 ? "succeeded" : "failed",
        isolation: "docker-code", stdout: run.stdout, stderr: run.stderr, exitCode: run.code };
    } catch (error) {
      result = { status: signal?.aborted ? "cancelled" : timed.aborted ? "timeout" : "rejected", error: error.message };
    } finally {
      if (launched) {
        // Dockerクライアントの終了だけではコンテナ終了を保証できない。
        try {
          const removed = await this.execute({ command: this.command, args: ["rm", "--force", id], timeoutMs: 10000 });
          cleanupConfirmed = removed.code === 0;
          if (!cleanupConfirmed) {
            const inspected = await this.execute({ command: this.command,
              args: ["container", "inspect", id], timeoutMs: 10000 });
            cleanupConfirmed = inspected.code !== 0 && /No such (container|object)/i.test(inspected.stderr);
          }
        } catch { cleanupConfirmed = false; }
      }
      if (reserved && cleanupConfirmed) this.coordinator.release(id);
    }
    return { ...result, cleanupConfirmed,
      ...(!cleanupConfirmed && { status: "failed", error: `コンテナ ${id} の終了を確認できません。共有枠を保持しています` }) };
  }
  async runCommand({ code, cwd, executable, args = [], permission = "workspace-write", timeoutMs = 30000, deniedPaths = [] }, { signal, onProgress } = {}) {
    if (this.backend !== "mxc" || process.platform !== "win32")
      return { status: "rejected", error: "このシェル実行にはWindows MXCが必要です" };
    const id = `mxc-${randomUUID()}`, ctrl = new AbortController();
    const combined = AbortSignal.any([ctrl.signal, ...(signal ? [signal] : [])]);
    const task = { ctrl };
    const work = async () => {
      let reserved = false;
      const timed = AbortSignal.timeout(timeoutMs);
      const execution = AbortSignal.any([combined, timed]);
      try {
        execution.throwIfAborted();
        if (this.coordinator) {
          this.coordinator.reserve(id); reserved = true;
          while (!this.coordinator.tryAcquire(id)) await delay(50, undefined, { signal: execution });
        }
        const r = await runProcess({ command: this.command,
          args: mxcArgs(cwd, [executable, ...args], permission, deniedPaths), stdin: code,
          cwd, env: cleanEnv(cwd), inheritEnv: false, signal: execution, timeoutMs, onProgress,
          maxOutputBytes: 1024 * 1024 });
        return { status: combined.aborted ? "cancelled" : timed.aborted || r.timedOut ? "timeout" : r.code === 0 ? "succeeded" : "failed",
          isolation: "windows-mxc", stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
      } catch (error) {
        return { status: combined.aborted ? "cancelled" : timed.aborted ? "timeout" : "rejected", error: error.message };
      } finally {
        if (reserved) this.coordinator.release(id);
      }
    };
    task.promise = work().finally(() => this.active.delete(task));
    this.active.add(task);
    return task.promise;
  }
  async shutdown() {
    for (const task of this.active) task.ctrl.abort();
    await Promise.allSettled([...this.active].map(t => t.promise));
  }
}
