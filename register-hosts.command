#!/bin/zsh -l
# macOS用。Finderでダブルクリックして起動する（Windowsの register-hosts.cmd に相当）。
cd "${0:A:h}" || exit 1
node "src/register-hosts.mjs" "$@"
echo
read -k 1 "?何かキーを押すと閉じます"
