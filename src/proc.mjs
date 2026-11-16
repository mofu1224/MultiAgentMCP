// プロセス実行の共通処理（Windows の .cmd/.ps1 解決・タイムアウト時のツリー終了）
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const cache = new Map();

/** PATH のディレクトリ順にコマンドを解決する。.cmd はシェル経由で起動する */
export function resolveCommand(name) {
  if (cache.has(name)) return cache.get(name);
  let result = null;
  if (path.isAbsolute(name)) {
    if (existsSync(name)) result = { file: name, shell: /\.(cmd|bat)$/i.test(name) };
  } else if (process.platform === "win32") {
    const dirs = (process.env.PATH || "").split(";").filter(Boolean);
    // 拡張子付きの指定（codex.exe 等）はそのまま探し、拡張子なしは .exe → .cmd → .bat の順で探す。
    const exts = /\.(exe|cmd|bat)$/i.test(name) ? [""] : [".exe", ".cmd", ".bat"];
    outer: for (const d of dirs) {
      for (const ext of exts) {
        const f = path.join(d, name + ext);
        if (existsSync(f)) { result = { file: f, shell: !/\.exe$/i.test(f) }; break outer; }
      }
    }
  } else {
    try {
      const f = execFileSync("which", [name], { encoding: "utf8" }).trim();
      if (f) result = { file: f, shell: false };
    } catch { /* 見つからない */ }
  }
  if (result) cache.set(name, result); // 見つからない結果は保持せず、後から導入したCLIを再起動なしで検出する
  return result;
}

// cmd.exe経由の起動では引用符内でも % が展開され、改行でコマンドが分断される。安全に表現できない引数は拒否する。
const quoteWin = (a) => {
  const s = String(a);
  if (/[%!"&|<>^\r\n]/.test(s)) throw new Error("cmd.exe経由で安全に表現できない引数です。CLIの実体を直接指定してください");
  return /^[\w\-.:\\/=,@+]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
};

export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 終了済み */ }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* 終了済み */ } }
  }
}

/** npmラッパーを実体へ解決する。cmd.exeによる%展開・引用符変形と8191文字制限を避ける。 */
export function resolveLaunch(command, args = []) {
  let resolved = resolveCommand(command);
  if (!resolved) throw new Error(`コマンドが見つかりません: ${command}`);
  if (resolved.shell && process.platform === "win32") {
    const wrapper = readFileSync(resolved.file, "utf8");
    const match = wrapper.match(/"%_prog%"\s+"%dp0%\\(node_modules\\[^"\r\n]+\.(?:m?js|cjs))"\s+%\*/i);
    const native = wrapper.match(/"%dp0%\\(node_modules\\[^"\r\n]+\.exe)"\s+%\*/i);
    if (match) {
      const script = path.resolve(path.dirname(resolved.file), match[1]);
      if (existsSync(script)) {
        const localNode = path.join(path.dirname(resolved.file), "node.exe");
        args = [script, ...args];
        resolved = { file: existsSync(localNode) ? localNode : process.execPath, shell: false };
      }
    } else if (native) {
      const file = path.resolve(path.dirname(resolved.file), native[1]);
      if (existsSync(file)) resolved = { file, shell: false };
    }
  }
  return { ...resolved, args };
}

function spawnResolved(resolved, opts) {
  if (resolved.shell && /[%"\r\n]/.test(resolved.file))
    throw new Error("cmd.exe経由で安全に表現できないコマンドパスです。CLIの実体を直接指定してください");
  return resolved.shell
    ? spawn(`"${resolved.file}" ${resolved.args.map(quoteWin).join(" ")}`, [], { ...opts, shell: true })
    : spawn(resolved.file, resolved.args, opts);
}

/**
 * 継続会話用の長寿命プロセス。stdin/stdoutは呼出し側が扱い、stop()はプロセスツリー終了を待つ。
 * 長いJSONは引数でなくstdinで渡す前提（cmd経由の8191文字問題を避ける）。
 */
export function spawnLongLived({ command, args = [], cwd, env, inheritEnv = true }) {
  const resolved = resolveLaunch(command, args);
  const child = spawnResolved(resolved, { cwd, env: { ...(inheritEnv ? process.env : {}), ...env },
    windowsHide: true, detached: process.platform !== "win32" });
  let ended = false;
  const exited = new Promise(resolve => {
    child.on("close", (code, sig) => { ended = true; resolve({ code, signal: sig }); });
    child.on("error", error => { ended = true; resolve({ code: null, error: error.message }); });
  });
  child.stdin.on("error", () => { /* 子が先に終了した場合 */ });
  return {
    child,
    exited,
    get alive() { return !ended && child.exitCode === null && child.signalCode === null; },
    async stop({ graceMs = 3000 } = {}) {
      if (ended || child.exitCode !== null || child.signalCode !== null) return exited;
      try { child.stdin.end(); } catch { /* 既に閉じている */ }
      const waitForExit = async ms => {
        let timer;
        try { return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, ms, "timeout"); })]); }
        finally { clearTimeout(timer); }
      };
      if (await waitForExit(graceMs) !== "timeout") return exited;
      killTree(child);
      // 強制終了後も終了を確認できなければ呼出し側へ失敗を返す（枠・予約は保守的に保持される）。
      if (await waitForExit(10000) === "timeout") throw new Error("子プロセスの終了を確認できません");
      return exited;
    },
  };
}

/**
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, durationMs:number}>}
 */
export function runProcess({ command, args = [], stdin, cwd, env, inheritEnv = true, timeoutMs = 600000, signal, onProgress, maxOutputBytes = 20 * 1024 * 1024 }) {
  let resolved;
  try { resolved = resolveLaunch(command, args); } catch (error) { return Promise.reject(error); }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const opts = { cwd, env: { ...(inheritEnv ? process.env : {}), ...env }, windowsHide: true, detached: process.platform !== "win32" };
    const child = spawnResolved(resolved, opts);
    const progress = event => { try { onProgress?.(event); } catch { /* 通知失敗で子を再起動しない */ } };
    progress({ stage: "process-started", pid: child.pid });
    let stdout = "", stderr = "", timedOut = false, aborted = false;
    // チャンク境界で分割された多バイト文字（日本語等）を壊さないよう、ストリーム側でUTF-8を復号する。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (stdout.length < maxOutputBytes) stdout += d; progress({ stage: "output", stream: "stdout", bytes: d.length }); });
    child.stderr.on("data", (d) => { if (stderr.length < maxOutputBytes) stderr += d; progress({ stage: "output", stream: "stderr", bytes: d.length }); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (e) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    });
    child.stdin.on("error", () => { /* 子が先に終了した場合 */ });
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}
