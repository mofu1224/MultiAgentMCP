// 旧AgentManagerの窓口名。状態遷移の所有者は Codex由来の子実行制御（./child-control/control.mjs）へ一本化した。
// 二重管理を避けるため、ここには状態を持たない。
export { ChildControl as AgentManager } from "./child-control/control.mjs";
