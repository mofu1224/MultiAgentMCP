// OS別に利用できる機能の一元判定。動かない機能はそのOSでは公開・受付しない（自動で弱い方式へ切り替えない）。
//
// | 機能                         | Windows | macOS/Linux | 理由                                       |
// |------------------------------|---------|-------------|--------------------------------------------|
// | full-access（native継続）     | ○       | ○           | 公式CLIのapp-server / stream-json          |
// | Codex read-only/workspace-write | ○（MXC）| ○（CLI標準sandbox） | codex execの標準sandbox             |
// | Claude read-only/workspace-write | ○     | ×           | シェルを専用MXCシェル（Windows専用）へ委譲  |
// | brokered                     | ○       | ×           | 操作子がMXC前提                            |
// | run_isolated_code            | ○（MXC）| Docker明示設定時のみ | 既定のMXCが無い                      |

export function platformFeatures(platform = process.platform, sandboxConfig = {}) {
  const windows = platform === "win32";
  return Object.freeze({
    platform,
    mxc: windows,
    brokered: windows,
    claudeRestricted: windows,
    isolatedCode: windows || sandboxConfig.backend === "docker",
  });
}

export const FEATURES = platformFeatures();

/** 親向けinstructionsへ付ける、このOSで除去した機能の案内。Windowsでは空。 */
export function platformNotice(features = FEATURES) {
  const removed = [];
  if (!features.brokered) removed.push("brokered（run_brokered_agent・isolation指定）");
  if (!features.claudeRestricted) removed.push("Claudeのread-only/workspace-write（Claudeはfull-accessのみ）");
  if (!features.isolatedCode) removed.push("run_isolated_code・sandbox_status");
  if (!removed.length) return "";
  return `\n# このOS（${features.platform}）での制限\n- 次の機能は動作しないため除去済み。下記ルール中の該当記述は適用しない: ${removed.join("、")}。\n- 敵対的・非信頼の子を安全に動かす経路はこのOSには無い。信頼できない作業は委譲しない。\n`;
}
