// ローカル利用者専用。共有状態の確認と受付数のリセット（MCPツールとしては提供しない）。
// 所有者が消えた実行枠は status の時点で自動回収される。
import { loadConfig } from "./config.mjs";
import { Coordinator } from "./coordinator.mjs";
import { CONTROL } from "./control.mjs";

let state;
try {
  const cfg = loadConfig();
  state = new Coordinator(cfg.dataDir, {
    maxConcurrent: Math.min(cfg.policy.maxConcurrent, CONTROL.maxConcurrent),
    maxCalls: cfg.policy.maxCallsPerRoot ?? 0,
  });
  const command = process.argv[2] || "status";
  if (command === "reset-budget") state.resetBudget();
  else if (command !== "status") throw new Error("使い方: node src/manage-state.mjs [status|reset-budget]");
  console.log(JSON.stringify(state.status(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { state?.close(); }
