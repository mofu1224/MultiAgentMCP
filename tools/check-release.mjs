// 公開前のローカル検査。CLI認証・モデル通信・ホスト登録・公開操作は行わない。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
function check(ok, message) { if (!ok) throw new Error(message); }
check(pkg.version === lock.version && pkg.version === lock.packages[""].version, "packageとlockの版が一致しません");
check(pkg.license === "Apache-2.0" && lock.packages[""].license === pkg.license, "ライセンス表記が一致しません");
check(pkg.private === true, "npm誤公開防止の private:true が必要です");
check(pkg.engines?.node === ">=24", "Node.jsの要件が一致しません");

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? files(file) : e.isFile() ? [file] : [];
  });
}
let syntax = 0;
for (const file of ["src", "tools", "test"].flatMap(d => files(path.join(ROOT, d))).filter(f => f.endsWith(".mjs"))) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
  check(!r.error && r.status === 0, `構文検査失敗: ${path.relative(ROOT, file)}\n${r.stderr || r.error?.message || ""}`);
  syntax++;
}

// 追跡候補を検査する。削除予定の旧ファイルは除外し、ローカル状態は公開候補へ混ぜない。
const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT, encoding: "utf8", windowsHide: true,
});
check(!r.error && r.status === 0, `Gitの公開候補を取得できません: ${r.stderr || r.error?.message || ""}`);
const paths = [...new Set(r.stdout.split("\0").filter(p => p && existsSync(path.join(ROOT, p))))];
const required = ["LICENSE", "NOTICE", "README.md", "README.en.md", "CHANGELOG.md", "SECURITY.md",
  "PARENT_GUIDE.md", "CONTRIBUTING.md", "config.example.json", "src/server.mjs", "third_party/codex/LICENSE", "third_party/codex/NOTICE",
  "package.json", "package-lock.json", ".gitignore", ".gitattributes", ".github/workflows/ci.yml"];
for (const p of required) check(paths.includes(p), `公開候補に必須ファイルがありません: ${p}`);
const allowedRoot = new Set([...required, "select-models.cmd", "select-models.command",
  "register-hosts.cmd", "register-hosts.command", "manage-state.cmd", "manage-state.command", "third_party/codex/README.md"]);
for (const p of paths) {
  check(allowedRoot.has(p) || /^(src|tools|test)\/(?:[\w-]+\/)*[\w.-]+\.mjs$/.test(p) || p === "src/child-control/README.md",
    `想定外の公開ファイル: ${p}`);
}
// ローカルのMarkdownリンクを確認する（外部リンクは取得しない）。
const docs = readdirSync(ROOT).filter(f => f.endsWith(".md")).map(f => path.join(ROOT, f));
docs.push(path.join(ROOT, "src/child-control/README.md"), path.join(ROOT, "third_party/codex/README.md"));
for (const file of docs) {
  for (const [, href] of readFileSync(file, "utf8").matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("#")) continue;
    check(existsSync(path.resolve(path.dirname(file), decodeURIComponent(href.split("#")[0]))),
      `リンク切れ: ${path.relative(ROOT, file)} → ${href}`);
  }
}
console.log(JSON.stringify({ version: pkg.version, syntaxFiles: syntax, sourceFiles: paths.length,
  license: pkg.license, localLinks: "OK", private: pkg.private }));
