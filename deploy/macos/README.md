# Mac Mini への設置手順

既存のサービスとぶつからないよう、次の値を使います。設置前に、ポートと serve の設定が空いていることを必ず確認してください。

```sh
lsof -nP -iTCP:8790 -sTCP:LISTEN      # 何も出なければ空いている
tailscale serve status                 # 8443 番が未使用であること
```

| 項目 | 値 | 備考 |
| --- | --- | --- |
| 待ち受け | `127.0.0.1:8790` | 既存サービスと重なる場合は config.json の `port` で変更 |
| 公開 | `tailscale serve` の HTTPS 8443 番 | 既存の 443 番の設定には触れない |
| launchd | `~/Library/LaunchAgents/com.osprey74.kanseishitsu.plist` | `install.sh` がテンプレートから生成する。既存の plist は変更しない |
| データ | `~/Library/Application Support/kanseishitsu/`（config.json・kanseishitsu.db） | リポジトリには含めない |
| ログ | `~/Library/Logs/kanseishitsu/` | |

この Mac 固有の使用中ポートなどのメモは `deploy/macos/local.md`（.gitignore で除外）に置きます。

## 1. ビルドとパスワード

```sh
cd ~/_dev/claude-dashboard
bun install
bun run build:web
bun apps/server/src/cli.ts set-password      # 画面ログイン用（12文字以上）
```

## 2. launchd で常駐

```sh
deploy/macos/install.sh                      # テンプレートから plist を生成して登録
curl -s http://127.0.0.1:8790/healthz        # {"ok":true}
```

コードを更新したあとの再起動：

```sh
launchctl kickstart -k gui/$(id -u)/com.osprey74.kanseishitsu
```

停止して登録を外す：

```sh
launchctl bootout gui/$(id -u)/com.osprey74.kanseishitsu
```

## 3. tailscale serve で 8443 番を公開

```sh
tailscale serve status                                  # 先に 443 の設定を確認
tailscale serve --bg --https=8443 http://127.0.0.1:8790
tailscale serve status                                  # 443 と 8443 の両方があること
```

8443 番だけを外す：

```sh
tailscale serve --https=8443 off
```

`tailscale serve reset`、`tailscale funnel` は使わないでください（既存の 443 番のサイトが止まる、または外部に公開されるため）。

## 4. PC の登録

Mac Mini でトークンを発行します（平文はこのときだけ表示されます）。

```sh
bun apps/server/src/cli.ts add-host office-win
bun apps/server/src/cli.ts list-hosts
bun apps/server/src/cli.ts revoke-host office-win     # 無効化
```

PC 側では、`bun run build:agent` で作った実行ファイル（`apps/agent/bin/`）をコピーして次を実行します。

```sh
# macOS
./kanseishitsu-agent-macos-arm64 setup            # 設定ファイルの作成と、登録内容の表示のみ
./kanseishitsu-agent-macos-arm64 setup --apply    # 内容を確認して ~/.claude/settings.json に追記（バックアップを作成）
```

```powershell
# Windows
.\kanseishitsu-agent-windows-x64.exe setup
.\kanseishitsu-agent-windows-x64.exe setup --apply
```

setup は実行ファイルを `~/.kanseishitsu/bin/` に置き、hooks（11 イベント、`async: true`）と statusLine を登録します。statusLine が既に設定されている場合は上書きせず、警告だけを出します。

## 確認用

- `GET /api/debug/statusline`（ログイン後）：各 PC から最後に届いた statusLine の内容。`rate_limits` が届いているかの確認に使う
- `sqlite3 ~/Library/Application\ Support/kanseishitsu/kanseishitsu.db 'select type, count(*) from events group by 1'`
