#!/bin/zsh -l
# macOS用。Finderでダブルクリックして起動する（Windowsの select-models.cmd に相当）。
cd "${0:A:h}" || exit 1
node "src/select-models.mjs" "$@"
echo
read -k 1 "?何かキーを押すと閉じます"
