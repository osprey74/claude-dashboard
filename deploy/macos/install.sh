#!/bin/bash
# launchd の設定をテンプレートから生成して登録する（環境固有のパスはリポジトリに含めない）
set -euo pipefail

LABEL=com.osprey74.kanseishitsu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BUN="$(command -v bun)"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/Logs/kanseishitsu"
sed -e "s#__BUN_DIR__#$(dirname "$BUN")#g" \
    -e "s#__BUN__#$BUN#g" \
    -e "s#__REPO__#$REPO#g" \
    -e "s#__HOME__#$HOME#g" \
    "$REPO/deploy/macos/kanseishitsu.plist.template" > "$DEST.new"
plutil -lint "$DEST.new" >/dev/null

if [ -f "$DEST" ] && cmp -s "$DEST" "$DEST.new"; then
  rm "$DEST.new"
  echo "変更なし: $DEST"
  exit 0
fi
mv "$DEST.new" "$DEST"
echo "配置しました: $DEST"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" || true
fi
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "登録しました: $LABEL"
