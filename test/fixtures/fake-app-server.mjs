// codex app-server（JSON-RPC over stdio）の試験用模擬。モデル通信はしない。
// 会話メモリをプロセス内に持ち、前ターンの遅延通知を新ターンの前に送る。
import readline from "node:readline";

if (process.argv.includes("list") && process.argv.includes("--json")) {
  process.stdout.write("[]\n");
  process.exit(0);
}

const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const memory = [];
let thread = null, turns = 0, active = null, lastTurnId = null;

function finish(turnId, status, extra = {}) {
  out({ method: "turn/completed", params: { threadId: thread.id, turn: { id: turnId, status, error: null, items: [] , ...extra } } });
  if (active?.id === turnId) active = null;
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === "initialize") return out({ id, result: { userAgent: "fake" } });
  if (method === "initialized") return;
  if (method === "thread/start") {
    thread = { id: "thread-1", ephemeral: params.ephemeral === true };
    return out({ id, result: { thread, model: process.env.FAKE_MODEL_OVERRIDE || params.model,
      reasoningEffort: params.config?.model_reasoning_effort ?? null, sandbox: { type: "dangerFullAccess" },
      approvalPolicy: params.approvalPolicy, cwd: params.cwd } });
  }
  if (method === "turn/start") {
    const turnId = `native-${++turns}`;
    const text = params.input.map(i => i.text).join("");
    out({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    if (lastTurnId) out({ method: "turn/completed", params: { threadId: thread.id, turn: { id: lastTurnId, status: "completed", items: [] } } });
    lastTurnId = turnId;
    out({ method: "turn/started", params: { threadId: thread.id, turn: { id: turnId } } });
    active = { id: turnId, ignore: text.includes("IGNORE") };
    if (text.includes("HANG") || text.includes("IGNORE")) return;
    memory.push(text);
    if (text.includes("DIE_AFTER")) setTimeout(() => process.exit(3), 20); // 応答後、待機中に異常終了する
    out({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "commandExecution", exitCode: 0 } } });
    out({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "a", text:
      JSON.stringify({ turn: turns, model: params.model, effort: params.effort ?? null, inputItems: params.input.length, memory, schema: !!params.outputSchema }) } } });
    out({ method: "thread/tokenUsage/updated", params: { threadId: thread.id, turnId, tokenUsage: { total: { totalTokens: 10 * turns } } } });
    return finish(turnId, "completed");
  }
  if (method === "turn/interrupt") {
    out({ id, result: {} });
    if (active && active.id === params.turnId && !active.ignore) finish(params.turnId, "interrupted");
    return;
  }
  if (id !== undefined) out({ id, error: { code: -32601, message: `unknown ${method}` } });
});
