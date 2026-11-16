// claude -p --input-format stream-json の試験用模擬。モデル通信はしない。
import readline from "node:readline";

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const memory = [], used = new Set();
let pending = null, model = arg("--model");

function result(subtype, text, isError = false) {
  used.add(model);
  out({ type: "result", subtype, is_error: isError, result: text, usage: { output_tokens: 1 },
    modelUsage: Object.fromEntries([...used].map(m => [m, {}])), num_turns: 1 }); // 実CLI同様に会話の累計
  pending = null;
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    const text = msg.message.content;
    out({ type: "system", subtype: "init", model: process.env.FAKE_MODEL_OVERRIDE || model,
      permissionMode: arg("--permission-mode"), session_id: "s1" });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash" }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: false }] } });
    if (text.includes("HANG") || text.includes("IGNORE")) { pending = { ignore: text.includes("IGNORE") }; return; }
    memory.push(text);
    if (text.includes("DIE_AFTER")) setTimeout(() => process.exit(3), 20); // 応答後、待機中に異常終了する
    return result("success", JSON.stringify({ memory, model, effort: arg("--effort"), noPersist: process.argv.includes("--no-session-persistence") }));
  }
  if (msg.type === "control_request" && msg.request?.subtype === "set_model") {
    if (msg.request.model === "reject-me")
      return out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unknown model" } });
    model = msg.request.model;
    return out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { model } } });
  }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
    if (pending && !pending.ignore) result("error_during_execution", "interrupted", true);
  }
});
