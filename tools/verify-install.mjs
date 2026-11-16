// 導入先のMCPサーバーを実際に起動し、公開ツール数とinstructionsを確認する（生成通信なし）。
// 使い方: node verify-install.mjs <導入先フォルダ> [期待ツール数]
// 期待ツール数を省略すると、導入先が報告したOS別機能（get_policy の platform）から求める。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const [targetArg, expectedArg] = process.argv.slice(2);
if (!targetArg) { console.error("使い方: node verify-install.mjs <導入先フォルダ> [期待ツール数]"); process.exit(2); }
const target = path.resolve(targetArg);
// 共通14ツール＋brokered（run_brokered_agent）＋隔離実行（sandbox_status・run_isolated_code）
const expectedFor = platform => 14 + (platform?.brokered ? 1 : 0) + (platform?.isolatedCode ? 2 : 0);
const sdk = p => import(pathToFileURL(path.join(target, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const client = new Client({ name: "install-check", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(target, "src", "server.mjs")], stderr: "ignore",
  env: { ...process.env, MAMCP_CONFIG: path.join(target, "config.json"), MAMCP_ALLOWLIST: path.join(target, "allowlist.json") } }));
try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  const policy = JSON.parse((await client.callTool({ name: "get_policy", arguments: {} })).content[0].text);
  const expected = expectedArg ? Number(expectedArg) : expectedFor(policy.platform);
  const result = { target, tools: tools.length, expected, hasWait: tools.includes("wait_agents"),
    instructions: /full-access/.test(client.getInstructions() || ""), platform: policy.platform?.platform,
    version: policy.version, allowlist: existsSync(path.join(target, "allowlist.json")), source: policy.release };
  console.log(JSON.stringify(result));
  const pkg = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
  if (result.tools !== result.expected || !result.hasWait || !result.instructions || result.version !== pkg.version) process.exitCode = 1;
} finally { await client.close(); }
