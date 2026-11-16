#!/bin/zsh -l
# macOS用。Finderでダブルクリックして起動する（Windowsの manage-state.cmd に相当）。
cd "${0:A:h}" || exit 1
node --no-warnings "src/manage-state.mjs" "$@"
echo
read -k 1 "?何かキーを押すと閉じます"
