# Claude 管制室 実装計画

作成日：2026-10-06 ・ 更新日：2026-10-06（進捗と計画の変更を反映）

## 進捗と計画の変更（2026-10-06 時点）

| フェーズ | 状況 |
| --- | --- |
| 1 受信と一覧 | 完了。Team プランでも利用枠（rate_limits）の値が届くことを確認 |
| 2 詳細と履歴 | 完了。サブエージェントは実機、Codex CLI は検知用のダミーで確認（モデルは起動コマンドの `-m` などから読む） |
| 3 指示送信 | **保留**。自作 Channel が組織の設定で無効なため、代わりに Remote Control への導線を実装 |
| 4 アラート | 完了。放置・ファイル競合・危険操作のガード・Web Push 通知 |
| 5 拡張 | 上限予測・消費内訳・物理表示灯は完了。Cowork の OTel 受信は見送り（送信先の設定に組織の管理者の作業が必要） |

計画から変えた点は次のとおりです。

- **指示送信（フェーズ3）**：試作の Channel で確かめたところ、組織の管理設定（`channelsEnabled`）が無効で、Claude Code が通知を捨てていました（デバッグ出力に「channels not enabled by org policy」）。開発用のフラグを付けても同じです。有効にするには組織の Owner による設定と、ISMS 上の確認が必要なため保留しました。hooks を使ってセッションに指示を入れる回り道は、組織の意図を避けることになるので採りません。
- **Remote Control への導線**：Remote Control の URL は `https://claude.ai/code/<bridgeSessionId>` です。bridgeSessionId は、各 PC の `~/.claude/sessions/<pid>.json` に、`/remote-control` が有効な間だけ書かれます（公開されていない内部ファイル。macOS と Windows で確認）。エージェントがこれを送り、詳細パネルとアラートに「Remote Control で開く」を出します。
- **危険操作のガード**：計画では Mac Mini で判定して実行を止め、画面で許可したら Channel で再実行を伝える設計でした。Channel が使えないため、PC 側のエージェントが手元で判定し、当たったら Claude Code の許可ダイアログに回す（PreToolUse で `permissionDecision: "ask"`）方式にしました。許可・却下は端末か Remote Control で行います。自動モードでもダイアログは出ます。
- **Mac Mini が止まったときのガード**：判定は PC 側で完結するため、Mac Mini が止まっていてもガードは働きます。PC 側のエージェントが応答しない場合は、3秒（Claude Code 側は5秒）で打ち切って通します（「通す側に倒す」）。
- **エージェントの起動役（macOS）**：macOS 27 で、Bun 製の実行ファイルが起動・終了の途中で止まり、Claude Code ごと固まる事象がありました。hooks と statusLine は `/bin/sh` の起動役から呼び、エージェントを切り離して起動します。
- **放置アラートの対象**：許可待ちと質問への回答待ちに限りました。作業を終えて次の指示を待っているだけの状態は、通常の休憩なので対象外です。
- **プッシュ通知**：Web Push（VAPID）で実装しました。iPhone はホーム画面に追加したアプリから購読します。
- **上限予測**：同じアカウント（5時間枠のリセット時刻が同じ）の直近の記録を直線で近似し、100% に届く見込みの時刻を出します。5時間枠は直近30分、週間枠は直近3時間の記録を使い、短すぎる期間では出しません。
- **消費内訳**：計画の OTel のトークン数ではなく、statusLine の `cost.total_cost_usd`（セッションの累計、API 料金換算の推定）の、今の枠の中での増分で割合を出します。各 PC に OTel の設定を足さずに済むためです。statusLine が呼ばれない VS Code・Desktop のセッションは、エージェントが会話記録のトークン数を10分刻みの時間帯ごとに数えて送り、サーバーが API の単価で換算します（見積もり）。開き直した古い会話の分は、時間帯で除きます。見積もりは、会話記録に残らない裏側の呼び出しを含まないため、statusLine の値より少なめに出ます（このプロジェクトのセッションで約12%）。チャットと Cowork の消費は含みません。
- **物理表示灯**：M5Stack Atom Matrix を Mac Mini に USB でつなぎ、サーバーがいちばん重い状態をシリアル通信で送ります。計画の WebSocket（Wi-Fi）をやめ、ネットワークに口を開けないようにしました。表示は画面の表示灯と同じ形（朱の四角・黄の三角・緑の丸）で、45秒届かなければ「途切れた」表示になります。書き込みは arduino-cli で、速さは 115200bps です。

## 概要

Mac Mini に自作の監視サーバーを置き、各PCの Claude Code と Cowork から情報を集めて、デザイン案「Claude 管制室」を Web 画面として表示します。表示だけでなく、Claude Code のセッションへの指示送信と、危険操作の停止まで扱います。

| 対象 | 情報の集め方 | 画面での扱い | 指示の送信 |
| --- | --- | --- | --- |
| Claude Code（CLI・Desktop・VS Code） | hooks、statusLine、自作 Channel | すべての機能 | 自作 Channel 経由で可能 |
| Codex CLI（Claude Code の配下） | Claude Code のツール実行イベントから検知 | プレイヤーとして表示 | コンダクター経由 |
| Cowork | OTel（組織の管理設定で送信先を指定） | 状態は推定表示 | 対象外 |
| チャット | 収集手段なし | 対象外 | 対象外 |

前提条件は次のとおりです。

- 会社の設定で Remote Control が有効化済みです。込み入った対話や許可操作は Remote Control（公式アプリ）で行い、本ツールは俯瞰と簡単な指示に絞ります。
- Mac Mini へのダッシュボード設置と、業務情報を個人の Tailscale 上の Mac Mini へ送ることについて、社内の許諾を取得済みです。
- 契約プランは Team です。利用枠の値（rate_limits）は Pro・Max 向けとする情報がありましたが、Team でも取得できることを確認しました（2026-10-06）。

## 全体構成

すべての情報は Mac Mini に集まり、そこから画面と物理表示灯へ配信されます。

```text
┌─────────────── 各PC（Claude Code） ───────────────┐   ┌──── Cowork（クラウド） ────┐
│  hooks          statusLine        自作 Channel     │   │  OTel（http/json）          │
│  イベント・ガード  モデル・利用枠     指示受信・心拍    │   │  組織設定で送信先を指定      │
│  ※ Codex CLI は配下のプレイヤーとして検知           │   └──────────────┬─────────────┘
└──────┬───────────────────────▲──────────────────┘                  │
       │ イベント・利用枠          │ 指示（PC から取得）                    │ OTLP
       ▼                         │                                     ▼
┌──────────────── Mac Mini（個人の Tailscale から共有） ────────────────┐
│  受信 API                   SQLite                  WebSocket 配信     │
│  hooks・OTel・ガード判定     履歴・状態・送信キュー    画面・表示灯へ即時反映 │
└──────┬──────────────────────────────────────────────┬────────────────┘
       │ 閲覧・指示送信（双方向）                          │ 状態のみ
       ▼                                              ▼
 ブラウザ・スマホ（Tailscale 経由で接続）        物理表示灯（M5Stack）：いちばん重い状態を点灯
```

| 部品 | 置き場所 | 役割 |
| --- | --- | --- |
| hooks | 各PC | イベントの送信、危険操作のガード |
| statusLine | 各PC | モデル・コンテキスト使用率・利用枠の送信 |
| 自作 Channel | 各PC（セッションごと） | Mac Mini から指示を取得、心拍の送信（**保留**：組織の設定で無効） |
| Cowork（OTel） | クラウド | プロンプト・ツール使用・エラーのイベント送信 |
| 受信 API | Mac Mini | hooks・OTel の受信、ガード判定 |
| SQLite | Mac Mini | 履歴・状態・送信キューの保存 |
| WebSocket 配信 | Mac Mini | 画面と物理表示灯への即時反映 |
| ブラウザ・スマホ | 利用者の端末 | 閲覧と指示送信 |
| 物理表示灯 | 机上 | いちばん重い状態を LED で点灯 |

Remote Control は Anthropic を経由してスマホと各PCを直接つなぐ公式の経路で、この構成とは別に併用します。

## 技術選定

サーバーとフロントを TypeScript で統一し、型定義を共有する構成を推奨します。OTel は専用の Collector を置かず、受信 API が OTLP の http/json を直接受け取ります。

| 層 | 採用案 | 理由 |
| --- | --- | --- |
| 受信 API・配信 | Bun ＋ Hono | 軽量で WebSocket を標準で扱える。フロントと型を共有できる |
| データベース | SQLite（WAL モード） | 単一ファイルで運用が簡単。書き込みは1台の Mac Mini に集約される |
| フロント | React ＋ TypeScript ＋ Vite | デザイン案の構造をそのまま部品化できる。グラフは手書き SVG |
| OTel 受信 | 受信 API に `/v1/logs` を実装 | Cowork は送信方式として http/json を選べるため、Collector が不要 |
| PC 側の送信処理 | TypeScript を Bun で単一実行ファイル化し、Windows・macOS に配布 | hooks・statusLine・Channel を1つのコードで保守できる |
| 常駐 | launchd（Mac Mini） | 再起動時の自動起動とログ管理 |
| ネットワーク | 個人の Tailscale に Mac Mini を置き、会社の Tailscale 上の自分のアカウントへマシン共有 | Mac Mini をインターネットに公開せず、他の社員からも見えない |
| 物理表示灯 | M5Stack（PlatformIO） | WebSocket で状態を受けて LED を点灯。**変更**：Atom Matrix を USB シリアルでつなぎ、arduino-cli で書き込む |

Mac Mini は個人の Tailscale に参加させ、マシン共有で会社の Tailscale 上の自分のアカウントにだけ公開します。共有されたマシンは受け取った本人にしか見えず、他の社員からは見えません。共有マシンは自分から接続を始められませんが、本構成の通信はすべて PC 側から始まるため影響はありません。共有マシンはタグ付き端末からはアクセスできませんが、会社の PC はタグ管理されておらず、ユーザー所有の端末であることを確認済みです。

## データモデル

10 個のテーブルで、画面の全要素と送信キューをまかないます。画面の「現在の状態」は sessions と players が持ち、履歴はすべて events に残します。

| テーブル | 主な列 | 用途 |
| --- | --- | --- |
| hosts | host_id, hostname, os, label, last_heartbeat_at | PC カードと心拍 |
| sessions | session_id, host_id, source（claude_code / cowork）, project, cwd, model, status, ctx_pct, started_at, last_event_at, remote_url | セッションタイルと表示灯 |
| players | player_id, session_id, kind（claude / codex）, model, task, status, started_at, ended_at | コンダクター配下のプレイヤー |
| events | event_id, session_id, player_id, type, tool_name, payload_json, created_at | 履歴、進捗、作業結果 |
| prompts | prompt_id, session_id, text, origin（local / dashboard）, created_at | 直近のプロンプト |
| usage_snapshots | taken_at, host_id, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset | 利用枠の行と上限予測 |
| token_usage | session_id, ts, input_tokens, output_tokens | 消費内訳。**変更**：session_costs（statusLine の費用）と transcript_costs（会話記録からの見積もり、10分刻み）にした |
| file_touches | session_id, player_id, path, ts | ファイル競合の検知 |
| alerts | alert_id, kind（danger / conflict / idle / offline）, session_id, detail_json, state, created_at | アラート欄 |
| outbox | command_id, session_id, text, state（queued / delivered / acked）, created_at | 指示の送信キュー |

- 未決事項：events と prompts の保持期間（何日分残すか）を決める必要があります。

## 収集側の仕様

各PCからの通信はすべて PC から Mac Mini への外向きで、PC 側に受信ポートは開けません。指示の受け取りも、Channel が Mac Mini に取りに行く方式にします。

### hooks（イベントの送信）

| フックイベント | 送る内容 | サーバー側の処理 |
| --- | --- | --- |
| SessionStart | session_id, cwd, ホスト名 | sessions を登録 |
| UserPromptSubmit | プロンプト本文 | prompts に保存、状態を緑に |
| PreToolUse | ツール名、コマンド | 危険操作を判定し、該当すれば実行を止める（同期処理） |
| PostToolUse | ツール名、編集したファイルのパス | events と file_touches に保存、Codex CLI の呼び出しを検知 |
| Notification | 許可要求・質問の種別 | 状態を黄に |
| Stop | 停止理由 | 状態を黄（指示待ち）に |
| SubagentStop | サブエージェントの識別子 | players を終了扱いに |
| SessionEnd | 終了理由 | セッションを終了扱いに |

- PreToolUse 以外は非同期で送り、タイムアウトを短くして Claude Code の動作を遅らせないようにします。
- 各イベントで受け取れる項目名は、実装前に公式ドキュメントで確認します（未確認）。

### statusLine（モデル・利用枠・コンテキスト）

statusLine スクリプトは、端末に1行を表示しつつ、受け取った JSON から model、context_window、rate_limits を Mac Mini へ送ります。利用枠はこの経路でしか取得できないため、全PCで同じスクリプトを使います。

### 自作 Channel（指示の受信と心拍）

セッションごとに起動する MCP サーバーとして実装します。役割は2つです。

1. Mac Mini の送信キューをロングポーリングで確認し、届いた指示をセッションへ渡して受領を返す。
2. 一定間隔で心拍を送る。hooks はイベントがないと何も送らないため、オフライン検知にはこの心拍を使う。

研究プレビュー中は、開発用フラグ付きで Claude Code を起動する必要があります。

### Cowork（OTel）

組織の管理者が Cowork の管理設定で、送信先に Mac Mini の `/v1/logs` を、方式に http/json を指定します。prompt.id で同じプロンプト由来のイベントをまとめます。

### 受信 API の一覧

| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | /api/ingest/hook | hooks のイベント受信 |
| POST | /api/ingest/statusline | モデル・利用枠・コンテキストの受信 |
| POST | /api/guard/pretooluse | 危険操作の判定（同期）。**変更**：判定は PC 側で行い、当たったものだけ /api/ingest/hook に GuardHit として送る |
| POST | /v1/logs | Cowork の OTel 受信 |
| POST | /api/alerts/:id/dismiss | アラートを閉じる |
| GET・POST | /api/push/key・subscribe・unsubscribe・test | Web Push の購読 |
| GET | /api/outbox/:sessionId | Channel による指示の取得（保留） |
| POST | /api/outbox/:commandId/ack | 指示の受領 |
| POST | /api/sessions/:id/prompt | 画面からの指示登録 |
| WS | /ws | 画面へのリアルタイム配信 |
| WS | /ws/device | 物理表示灯への配信。**変更**：USB シリアルにしたため作らない |

## 状態判定ロジック

判定はすべて Mac Mini 側で行い、しきい値は設定ファイルで変更できるようにします。下表の数値は初期値の提案で、運用しながら調整します。

| 判定 | 条件（初期値） | 画面の表現 |
| --- | --- | --- |
| 緑・稼働中 | 最後のツール実行イベントから 60 秒以内で、停止イベントの後ではない | 緑の丸 |
| 黄・入力待ち | Notification（許可要求・質問）を受信、または Stop の後 | 黄の三角 |
| 朱・異常 | Channel の心拍が 120 秒途絶、または API エラーのイベントを受信 | 朱の四角 |
| コンテキスト警告 | 使用率が 70% 以上 | ゲージが黄色、「圧縮間近」 |
| ファイル競合 | 同じパスを、10 分以内に2つ以上のプレイヤーが編集 | アラート、タイルに「競合」 |
| 危険操作 | PreToolUse のコマンドが禁止パターンに一致 | 実行を止めてアラート |
| 放置 | 入力待ちが 10 分以上続く | アラート、プッシュ通知 |

補足する仕組みは次のとおりです。

- **危険操作の「許可して再実行」**：画面で許可すると、一度だけ有効な許可トークンを発行します。あわせて Channel 経由で「承認済みのため再実行してよい」と伝え、次の PreToolUse で通します。**変更**：Channel が使えないため、Claude Code の許可ダイアログに回す方式にしました（冒頭の「進捗と計画の変更」を参照）。
- **上限到達の予測**：直近 30 分の usage_snapshots から増加ペースを直線で近似し、100% に達する時刻を出します。公式の計算方法は非公開のため、目安として表示します。
- **消費内訳**：利用枠の割合はセッション別には取得できません。推測ですが、OTel のトークン数をセッション別に集計し、その比率で按分するのが現実的です。**変更**：statusLine の費用と会話記録からの見積もりを使いました（冒頭の「進捗と計画の変更」を参照）。
- **Codex CLI の検知**：推測ですが、Bash で実行されたコマンドが `codex` で始まるもの、またはツール名に codex を含む MCP ツールを、Codex のプレイヤーとして扱います。
- **プレイヤーのモデル**：hooks で取得できるかは未確認です。取得できない場合は、サブエージェント定義ファイルのモデル指定と突き合わせます。

## セキュリティ設計

本ツールは外部からセッションへ指示を注入できる経路を持つため、閲覧系より一段厳しい管理が必要です。ISMS 上の扱いは、ISMS 管理責任者など専門家への確認が必要です。

| 観点 | 対策 |
| --- | --- |
| 通信経路 | Mac Mini をインターネットに公開しない。個人の Tailscale からマシン共有で自分のアカウントにだけ公開し、個人側と会社側の両方の ACL で、ダッシュボード専用の 8443 番への接続だけを許可する。既存のウェブアプリが使う 443 番は、会社アカウントから拒否されることを ACL のテストで常時検証する。通信は HTTPS |
| PC からの送信 | PC ごとに API トークンを発行し、受信 API で検証する |
| 画面へのアクセス | Tailscale の端末認証に加え、画面にもパスキー等のログインを設ける |
| 指示の送信 | Channel 側でもトークンと送信元を検証する。送信内容はすべて outbox と events に記録 |
| 物理表示灯 | 専用トークンで受信のみ許可し、状態以外の情報は送らない。**変更**：USB シリアルにしたため、ネットワークの口もトークンも不要。送るのは状態の種類だけ |
| 機密情報 | プロンプトやコマンド内のトークン・パスワードらしい文字列を保存前に伏せ字化する |
| 保存データ | Mac Mini のディスク暗号化（FileVault）を有効にし、保持期間を定める |

- 決定（2026-10-06）：Mac Mini が停止しているとき、危険操作ガードは「通す側に倒す」ことにしました。判定は PC 側で行うため、Mac Mini が止まってもガード自体は働きます。

## 開発フェーズとマイルストーン

まず表示系を完成させ、研究プレビューに依存する指示送信と、誤作動の影響が大きいガードは後半に回します。各フェーズの日程は未定です。

| フェーズ | 内容 | 次へ進む条件（ゲート） |
| --- | --- | --- |
| 1 受信と一覧 | 受信 API と SQLite、hooks・statusLine の送信、PC・セッション一覧と表示灯 | 2台以上のPCで、表示灯が実際の状態と一致する。利用枠の値が届くかも確認 |
| 2 詳細と履歴 | 詳細パネル、履歴、利用枠の行、コンテキストゲージ、スマホ表示 | 指揮中のプレイヤー（Codex CLI を含む）とモデルが正しく表示される |
| 3 指示送信 | 自作 Channel、送信キュー、定型指示ボタン、Remote Control への導線 | 画面から送った指示が対象セッションに届き、受領が記録される |
| 4 アラート | 危険操作ガード、ファイル競合、放置アラート、プッシュ通知 | ガードの誤検知と見逃しを試験し、Mac Mini 停止時の挙動を決める |
| 5 拡張 | Cowork の OTel 受信、消費内訳と上限予測、物理表示灯 | — |

フェーズ1のゲートで利用枠の値が届かないと分かった場合は、利用枠の行を外して先へ進めます。

## リスクと未確認事項

最大のリスクは、指示送信が研究プレビューの Channel に依存している点です。仕様が変わっても、表示系（フェーズ1・2）は影響を受けない構成にしています。

| 項目 | 内容 | 対応 |
| --- | --- | --- |
| Channel の仕様変更 | 研究プレビューで、開発用フラグでの起動が必要 | 指示送信を独立したモジュールにし、使えない場合は Remote Control への導線で代替。**結果**：組織の設定で無効だったため、Remote Control への導線で代替した |
| 利用枠の取得 | rate_limits は Claude.ai の Pro・Max 向けとされ、契約中の Team で取れるかは未確認。過去に欠落する不具合の報告もある | フェーズ1で実際の値が届くか最初に確認。取れない場合は利用枠の行を非表示。**結果**：Team でも値が届いた |
| Cowork の OTel 送信元 | クラウドの Cowork セッションのイベントが、PC から届くか Anthropic 側から届くかは未確認。後者の場合、Tailscale 内の Mac Mini には届かない | ローカルの Cowork から試験し、届かない場合は対象を限定 |
| プレイヤーのモデル | hooks で取得できるかは未確認 | サブエージェント定義との突き合わせで代替。**結果**：Agent ツールの完了時の resolvedModel と、会話記録から取得できた。Codex は起動コマンドの指定から読む |
| Mac Mini の単一障害点 | Mac Mini が止まると監視とガードが止まる | ガードの倒し方を決め、launchd で自動復旧。**結果**：ガードは PC 側で判定するため、Mac Mini が止まっても働く |

### 出典

- [Remote Control（Claude Code 公式ドキュメント）](https://code.claude.com/docs/ja/remote-control)
- [Channels リファレンス（公式）](https://code.claude.com/docs/en/channels-reference)
- [Cowork のモニタリング（公式）](https://claude.com/docs/cowork/monitoring)
- [Cowork の OTel 監視（公式ヘルプ）](https://support.claude.com/en/articles/14477985)
- [Claude Code の OTel 監視（公式）](https://code.claude.com/docs/en/monitoring-usage)
- [statusLine の rate_limits 解説](https://wmedia.es/en/tips/claude-code-usage-limit-status-line)
- [rate_limits 欠落の不具合報告（GitHub）](https://github.com/anthropics/claude-code/issues/45133)
- [hooks を使った監視の実装例（GitHub）](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [Tailscale マシン共有（公式）](https://tailscale.com/kb/1084/)
- デザイン案：`docs/design/Main.dc.html`、`docs/design/Legend.dc.html`、`docs/design/Mobile.dc.html`
