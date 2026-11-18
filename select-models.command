#!/bin/zsh -l
# macOS用。Finderでダブルクリックして起動する（Windowsの select-models.cmd に相当）。
cd "${0:A:h}" || exit 1
node "src/select-models.mjs" "$@"
result=$?
if (( $# == 0 )) && [[ -t 0 ]]; then
  echo
  if (( result != 0 )); then echo "終了コード: $result"; fi
  read -k 1 "?何かキーを押すと閉じます"
fi
exit "$result"
