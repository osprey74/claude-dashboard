// macOS 用の起動役スクリプト。hooks と statusLine からはこれを呼ぶ。
// macOS 27 では Bun でビルドした実行ファイルが起動・終了の途中でカーネル内で止まり（ps の状態 U）、
// kill も効かなくなることがあった。Claude Code がその終了を待つと端末ごと応答しなくなるため、
// Apple 署名の /bin/sh でエージェントを切り離して起動し、起動役自体はすぐに終える。

export const LAUNCHER_NAME = "kanseishitsu-launch";

/** 同時に動いているエージェントがこの数以上なら、新しく起動しない（止まったものが溜まり続けるのを防ぐ） */
export const MAX_RUNNING = 8;

export const LAUNCHER_SH = `#!/bin/sh
# Claude 管制室：エージェントの起動役（setup が生成。手で編集しても setup で上書きされます）
# エージェントを切り離して起動し、Claude Code を待たせずにすぐ終わる。
AGENT="$(dirname "$0")/kanseishitsu-agent"

# 止まったエージェントが溜まっているときは起動しない
running=$(/usr/bin/pgrep -f "$AGENT (hook|statusline)" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
[ "\${running:-0}" -lt ${MAX_RUNNING} ] && ok=1 || ok=0

# 非対話のシェルでは & で起動したコマンドの標準入力が /dev/null になるため、fd 3 に退避して渡す
exec 3<&0

case "$1" in
  hook)
    # 「[ ] && cmd &」と書くと間に入るサブシェルが標準出力を握ったまま残るため、if で単純コマンドとして起動する
    if [ $ok = 1 ]; then
      "$AGENT" "$@" <&3 >/dev/null 2>&1 3<&- &
    fi
    exit 0
    ;;
  statusline)
    text=""
    if [ $ok = 1 ] && out=$(/usr/bin/mktemp -t kanseishitsu); then
      "$AGENT" statusline <&3 >"$out" 2>/dev/null 3<&- &
      # エージェントは表示を先に書き、送信はその後に行う。表示が書かれるまで最大1秒待つ
      i=0
      while [ $i -lt 20 ] && [ ! -s "$out" ]; do /bin/sleep 0.05; i=$((i + 1)); done
      text=$(/bin/cat "$out")
      /bin/rm -f "$out"
    fi
    [ -n "$text" ] || text="[管制室] エージェント応答なし"
    printf '%s\\n' "$text"
    exit 0
    ;;
esac
exec 3<&-
exec "$AGENT" "$@"
`;
