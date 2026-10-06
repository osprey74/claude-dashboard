# Claude 管制室 フェーズ1 実装指示書（Claude Code 向け）

作成日：2026-10-06（同日、実環境との差異を反映）

この指示書は Claude Code に渡して使います。Claude Code は、まずこの指示書と参考資料を読み、実装計画を提示して承認を得てから作業を始めてください。

## 目的と完了条件

フェーズ1では、各PCの Claude Code から Mac Mini へイベントを集め、PC・セッション一覧と表示灯をブラウザで表示できる状態を作ります。指示の送信、アラート、Cowork 連携は後のフェーズで扱います。

完了条件（フェーズ1のゲート）は次のとおりです。すべて満たしたら、結果を報告して作業を止めてください。

- [ ] 2台以上のPC（Windows と macOS を各1台以上）で Claude Code を動かし、画面の PC カードとセッションタイルに表示される
- [ ] 表示灯（緑・黄・朱）が、実際のセッションの状態と一致する
- [ ] セッションのモデル名が表示される
- [ ] statusLine 経由で利用枠（5時間枠・週間枠）の値が Mac Mini に届くかを確認し、届いた値または「届かない」という結果を報告する
- [ ] 会社PCから `https://<Mac Mini の MagicDNS 名>:8443` で画面を開ける
- [ ] Mac Mini の 443 番で公開中の既存ウェブアプリに影響がない

## 前提と環境

サーバーは自宅の Mac Mini 1台で動かし、各PCからは Tailscale 経由で接続します。ネットワークと ACL の設定は済んでいるため、変更しないでください。

| 項目 | 内容 |
| --- | --- |
| サーバー | Mac Mini（macOS）、個人の Tailscale に参加。Tailscale IP は設置先の Mac Mini で確認 |
| クライアント | 会社の Windows PC（複数台）と macOS の端末。会社 PC は会社の Tailscale に参加し、Mac Mini はマシン共有で見えている |
| 公開ポート | ダッシュボードは 8443 番（`tailscale serve` で HTTPS 公開）。会社アカウントから許可されているのは 8443 番のみ |
| 使用中のポート | 443 番は既存のウェブアプリが `tailscale serve` で使用中。触らないこと |
| アプリの待ち受け | サーバーは 127.0.0.1 の 8790 番で待ち受け、`tailscale serve` で 8443 番へ中継する（当初案の 8787 番は既存サービスが使用中のため変更） |
| 認証 | Claude Code は claude.ai の Team プランでログイン済み。Remote Control は有効 |

Mac Mini 上の作業は、別のPCの Claude Code から SSH 経由で行う場合があります。

## 範囲

フェーズ1は「集めて、正しく表示する」ことだけに絞ります。後のフェーズの機能は作らず、データの受け皿だけを用意してください。

| フェーズ1でやること | フェーズ1ではやらないこと（後のフェーズ） |
| --- | --- |
| 受信 API、SQLite、WebSocket 配信 | 自作 Channel による指示送信（フェーズ3） |
| PC 側エージェント（hooks・statusLine の送信） | 危険操作ガード、ファイル競合、放置アラート（フェーズ4） |
| PC・セッション一覧、表示灯、モデル表示、件数表示 | 詳細パネル、履歴画面、利用枠の行、コンテキストゲージ（フェーズ2） |
| 全 hooks イベントの保存（後で使うため） | プレイヤー・Codex CLI の表示（フェーズ2） |
| `tailscale serve` での 8443 番公開、launchd での常駐 | Cowork の OTel 受信、物理表示灯（フェーズ5） |

PreToolUse フックは、フェーズ1では記録のみ行い、実行を止める処理は入れないでください。

## 構成とリポジトリ

TypeScript のモノレポとし、サーバー・画面・PC 側エージェントで型定義を共有します。ランタイムとパッケージ管理は Bun に統一します。

```text
claude-dashboard/    # リポジトリのルート（当初案の名称は kanseishitsu/）
├─ packages/
│  └─ shared/        # イベント・状態の型定義、状態判定の共通ロジック
├─ apps/
│  ├─ server/        # Bun + Hono + bun:sqlite（受信 API、WebSocket、静的ファイル配信）
│  ├─ web/           # React + TypeScript + Vite（一覧画面）
│  └─ agent/         # PC 側エージェント（bun build --compile で単一実行ファイル化）
├─ deploy/
│  └─ macos/         # launchd の plist、tailscale serve の設定手順
└─ docs/
   ├─ phase1.md      # この指示書
   ├─ plan.md        # 実装計画（任意）
   └─ design/        # デザイン案の HTML（Main / Legend / Mobile）
```

| 部品 | 技術 | 備考 |
| --- | --- | --- |
| サーバー | Bun ＋ Hono ＋ bun:sqlite | SQLite は WAL モード。画面のビルド成果物もサーバーから配信する |
| 画面 | React ＋ TypeScript ＋ Vite | グラフ等のライブラリは入れず、表示灯は手書き SVG |
| エージェント | TypeScript を Bun で単一実行ファイル化 | Windows（x64）と macOS（arm64）向けにビルド。Bun 1.3.13 の出力は macOS 27 で起動できないため、ビルドにはリポジトリ内の Bun 1.4.2 を使う |
| DB マイグレーション | SQL ファイルを連番で管理 | 起動時に未適用分を実行 |

## サーバー仕様

サーバーはイベントを受け取って保存し、状態を判定して画面へ配信します。判定は必ずサーバー側で行い、しきい値は設定ファイルで変更できるようにします。

### API（フェーズ1）

| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | /api/ingest/hook | hooks のイベント受信。ペイロードはそのまま events に保存 |
| POST | /api/ingest/statusline | モデル、コンテキスト使用率、利用枠の受信 |
| GET | /api/state | 現在の PC・セッション一覧と件数（画面の初期表示用） |
| WS | /ws | 状態が変わるたびに差分を配信 |
| GET | /healthz | 稼働確認 |

- 受信系の API は、PC ごとに発行した API トークンを `Authorization: Bearer` で検証します。
- 受信系は 200 を即座に返し、保存と判定はその後に行います。PC 側の Claude Code を待たせないためです。

### テーブル（フェーズ1）

| テーブル | 主な列 |
| --- | --- |
| hosts | host_id, hostname, os, label, token_hash, last_seen_at |
| sessions | session_id, host_id, project, cwd, model, status, ctx_pct, started_at, last_event_at, ended_at |
| events | event_id, session_id, type, tool_name, payload_json, created_at |
| prompts | prompt_id, session_id, text, created_at |
| usage_snapshots | taken_at, host_id, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset |

players、alerts、outbox など後のフェーズのテーブルは、フェーズ1では作らなくて構いません。

### 状態判定（初期値）

| 状態 | 条件 |
| --- | --- |
| 緑・稼働中 | UserPromptSubmit または ツール実行イベントの後で、Stop・Notification を受けていない |
| 黄・入力待ち | Notification を受信、または Stop の後 |
| 朱・異常 | API エラーのイベントを受信、または稼働中のまま最後のイベントから 15 分経過（「応答なし（推定）」と表示） |
| 終了 | SessionEnd を受信。一覧から外し、履歴には残す |

フェーズ1には心拍の仕組みがないため、朱の「応答なし」は推定です。フェーズ3で Channel の心拍に置き換えます。

## PC 側エージェント仕様

エージェントは1つの実行ファイルで、hooks と statusLine の両方から呼ばれます。最優先は「Claude Code の動作を絶対に妨げない」ことです。

### 動作の決まり

1. 標準入力の JSON を読み、ホスト名と設定上のラベルを付けて Mac Mini へ送る。
2. 送信のタイムアウトは短く（初期値 1.5 秒）、失敗しても再送せず、エラーを出さずに終了コード 0 で終える。
3. 送信失敗はローカルのログファイルにだけ記録する。
4. プロンプトやコマンドに含まれるトークン・パスワードらしい文字列は、送信前に伏せ字にする。

### サブコマンド

| コマンド | 呼び出し元 | 処理 |
| --- | --- | --- |
| `agent hook <イベント名>` | hooks（全イベント） | 受け取った JSON を /api/ingest/hook へ送る |
| `agent statusline` | statusLine | 端末に1行（モデル・コンテキスト・利用枠）を表示し、同じ内容を /api/ingest/statusline へ非同期で送る |
| `agent setup` | 人が手動で実行 | 設定ファイルの作成と、Claude Code の設定への登録手順の表示 |

### 設定ファイル

ユーザーのホームディレクトリ配下に置きます（例：`~/.kanseishitsu/config.json`）。

```json
{
  "serverUrl": "https://<Mac Mini の MagicDNS 名>:8443",
  "token": "<PC ごとの API トークン>",
  "hostLabel": "office-win"
}
```

### Claude Code への登録

ユーザー設定（`~/.claude/settings.json`）の hooks と statusLine にエージェントを登録します。対象イベントは SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Notification、Stop、SubagentStop、SessionEnd です。状態判定の精度を上げるため、公式ドキュメントで存在を確認した PostToolUseFailure、PermissionRequest（許可待ち）、StopFailure（API エラー）も登録します。すべて `async: true` で登録し、Claude Code を待たせません。

設定の書式と、各イベントで渡される JSON の項目名は、実装前に必ず公式ドキュメントで確認してください。この指示書では項目名を決め打ちしていません。既存の `~/.claude/settings.json` に他の設定がある場合は、上書きせずに追記してください。

## 画面（フェーズ1）

デザイン案「Claude 管制室」のうち、ヘッダーと「PC とセッション」の一覧だけを作ります。見た目はデザイン案に合わせ、データは /api/state と /ws から取得します。

### 作る部分

- **ヘッダー**：タイトル「Claude 管制室」、監視中の PC 数、最終更新時刻、稼働中・入力待ち・異常の件数
- **PC カード**：横2列のグリッド（スマホ幅では1列）。ホスト名、OS、最終イベントからの経過時間
- **セッションタイル**：表示灯、プロジェクト名（cwd の末尾のフォルダ名）、モデル名のラベル、状態の文言

### デザインの決まり

| 要素 | 値 |
| --- | --- |
| 背景・パネル・枠線 | #0B111C ・ #131B2A ・ #263247 |
| 文字（通常・補助） | #E8EDF4 ・ #9DA9BB |
| アクセント | #5BC0D6 |
| 表示灯 | 緑の丸 #43C57F（稼働中）、黄の三角 #F5C451（入力待ち）、朱の四角 #F06A43（異常）。色だけでなく形と文言を必ず併記 |
| モデルのラベル | Opus #C9A2FF、Sonnet #7DBBFF、Haiku #7FE0C6、Fable #FFB37A。枠付きの文字ラベル |
| フォント | BIZ UDPGothic（本文）、JetBrains Mono（数値・ホスト名・プロジェクト名） |

- タイルは `<button>` で作り、フェーズ2で詳細パネルを開けるようにしておきます（フェーズ1では選択状態の表示だけ）。
- デザイン案は `docs/design/` の HTML ファイルです。Claude Design 専用の形式のためブラウザでは正しく表示されないことがありますが、色・余白・フォントなどの指定はソースから読み取れます。画面構成に迷ったらデザイン案を優先してください。

## 公開・セキュリティ・作業ルール

### 公開と常駐

- サーバーは 127.0.0.1 の 8790 番だけで待ち受け、外部のインターフェースには直接公開しません。
- `tailscale serve` で HTTPS の 8443 番から 8790 番へ中継します。443 番の既存の serve 設定には触れず、8443 番の設定だけを追加してください。
- launchd で常駐させ、Mac Mini の再起動後も自動で起動するようにします。

### セキュリティ

- API トークンは PC ごとに発行し、サーバーにはハッシュ値だけを保存します。
- 画面へのアクセスにもログインを設けます。フェーズ1は、パスワード（Bun.password でハッシュ化して保存）と、署名付き Cookie（HttpOnly・Secure・SameSite=Strict、30日）の方式とします。連続5回失敗すると5分間ログインを拒否します。
- SQLite のデータベースファイルと設定ファイルは、リポジトリにコミットしないでください。

### 作業ルール（必ず守ること）

1. 着手前に、この指示書を踏まえた実装計画を提示し、承認を得る。
2. `tailscale serve reset`、`tailscale funnel` の操作、Tailscale の ACL の変更は行わない。既存のウェブアプリが止まる、または外部に公開されるおそれがあるため。
3. Mac Mini 上の既存のサービス・ポート・launchd の設定を変更・停止しない。
4. 各PCの `~/.claude/settings.json` を変更する前に、変更内容を提示して承認を得る。既存の設定は上書きしない。
5. 小さな単位でコミットし、各段階の動作確認の結果を報告する。
6. 仕様が不明な点は推測で実装せず、公式ドキュメントで確認するか、質問する。

## 着手前の確認事項と参考資料

実装計画を提示する前に、次の点を公式ドキュメントで確認し、結果を計画に含めてください。

- [ ] hooks の設定書式と、各イベントで標準入力に渡される JSON の項目（session_id、cwd、ツール名など）
- [ ] statusLine の設定書式と、渡される JSON の項目（model、context_window、rate_limits）
- [ ] Team プランで rate_limits が渡されるか（実機での確認でも可）
- [ ] Windows での hooks・statusLine の実行方法（パスの書き方、実行ファイルの呼び出し）
- [ ] `tailscale serve` で 443 番以外の HTTPS ポート（8443 番）を公開する書式

### 参考資料

- 実装計画：`docs/plan.md`（置かれている場合）
- デザイン案：`docs/design/Main.dc.html`（デスクトップ版）、`docs/design/Legend.dc.html`（アイコン凡例）、`docs/design/Mobile.dc.html`（スマホ版）
- [Claude Code hooks（公式）](https://code.claude.com/docs/en/hooks)
- [Claude Code statusLine（公式）](https://code.claude.com/docs/en/statusline)
- [Claude Code の OTel 監視（公式）](https://code.claude.com/docs/en/monitoring-usage)
- [statusLine の rate_limits 解説](https://wmedia.es/en/tips/claude-code-usage-limit-status-line)
- [Tailscale serve（公式）](https://tailscale.com/kb/1312/serve)

hooks と statusLine の公式ページの URL は、私が開いて確認したものではありません。リンクが切れている場合は、公式ドキュメントの目次から該当ページを探してください。
