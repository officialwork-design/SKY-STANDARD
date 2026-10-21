# SKY STANDARD 公式LINEシステム

ヘリコプター遊覧飛行・チャーター事業「SKY STANDARD」の LINE 公式アカウントを、予約導線・予約確認・顧客対応の営業チャネルとして運用するためのシステムです。

**標準構成は「LINE公式アカウント → Google Apps Script → Googleスプレッドシート」です。** Cloud Run・Firebase・外部の有料サーバーは使いません。ただし GAS 単体では、LINE の署名（`X-Line-Signature`）を検証できません。この制約と対策は[9章](#9-line-署名検証ができないことによる制約)に記載しています。

## 1. GAS単体構成の全体図

```text
 LINE ユーザー
   │ トーク・リッチメニュー
   ▼
 LINE Platform ──Webhook（直接）──▶ 本体GAS（Web アプリ, ID 1zlkPtaZ…）
   ▲                                 │ doPost：未検証イベントとして制限付きで処理
   │ reply / push（Messaging API）  │ FAQ 応答・顧客登録・問い合わせ・通知・ログ
   └─────────────────────────────────┤
                                     ▼
                         Google スプレッドシート（管理台帳 11シート）
                                     ▲
                                     │ ライブラリ呼び出し（SkyStandard.adminRun）
                         管理メニュー用GAS（スプレッドシートに紐づく, ID 1rK0ECYP…）
                           「SKY STANDARD」メニュー：設定チェック・通知承認・リッチメニュー…

 予約サイト ──HMAC 署名付き予約イベント──▶ 本体GAS（予約通知）
 予約確認画面（LIFF）──ID トークン──────▶ 本体GAS（本人の予約のみ返却）
```

任意構成として、署名検証リレー（`src/relay/`、Cloud Run 等）を前段に置く方式も残しています（[11章](#11-任意構成署名検証リレー旧構成)）。GAS単体構成の導入にリレーの設定は不要です。

## 2. 必要なサービス

| サービス | 用途 | 費用 |
|---|---|---|
| LINE公式アカウント（Messaging API チャネル） | Bot・Webhook・リッチメニュー・通知 | プランに応じた配信数 |
| LINE ログインチャネル＋LIFF | 予約確認画面の本人認証（使う場合） | 無料 |
| Google Apps Script（本体GAS・管理メニュー用GAS） | Webhook 受信・業務処理・管理メニュー | 無料（Google の割り当て内） |
| Google スプレッドシート | 管理台帳 | 無料 |
| Google ドライブ | リッチメニュー画像の保管 | 無料 |
| 予約サイト（別システム） | 予約・決済の正本。予約イベントを GAS へ送信 | 既存 |

## 3. 本体GASと管理メニュー用GASの役割

| | 本体GAS | 管理メニュー用GAS |
|---|---|---|
| Script ID | `1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff` | `1rK0ECYPeDHFUWLllzeuZPOaWrSBnou8fZPrtGUhPhUQFTK-vU2oEKSSd` |
| ソース | `src/gas/`（ルートの `.clasp.json`） | `src/sheet-admin/` |
| 種類 | 独立プロジェクト（Web アプリ兼ライブラリ） | スプレッドシートに紐づくプロジェクト |
| 役割 | Webhook 受信（doPost）、FAQ・問い合わせ・顧客・予約通知・リッチメニュー・ログ、管理 API `adminRun` | メニュー表示（onOpen）、確認ダイアログ、結果表示、ID管理の変更検知（onEdit） |
| 秘密情報 | スクリプトプロパティに保存 | 保存しない |

## 4. スクリプトプロパティ一覧（本体GAS）

秘密情報の値は、ソースコードにもスプレッドシートにも保存しません。公開してよい ID・URL は「ID管理」シートの B列で管理します（[docs/setup.md](docs/setup.md)）。

| キー | 必須 | 内容 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | ◎ | Messaging API チャネルアクセストークン |
| `SPREADSHEET_ID` | ◎ | 起動用（管理メニューの「シート列・設定行の補完」で自動設定） |
| `ADMIN_USERS` | ◎ | 管理メニューを操作できるメールアドレス（カンマ区切り） |
| `WEBHOOK_MODE` | 任意 | `direct`（既定・GAS単体）／`relay`（署名検証リレー経由）。未設定なら direct |
| `RESERVATION_WEBHOOK_SECRET` | 予約通知 | 予約サイトと共有する HMAC 署名用シークレット |
| `RESERVATION_API_KEY` / `RESERVATION_API_ALLOWED_HOST` | 予約API利用時 | 予約サイト API のキーと、キーの送信を許可するホスト |
| `ADMIN_EMAIL` | 任意 | 運営通知メールの宛先 |
| `RELAY_SHARED_SECRET` | relay のみ | リレーと共有する HMAC 鍵（GAS単体では不要） |
| `LINE_CHANNEL_SECRET` | 任意 | 参照用。GAS単体では署名検証に使えません |

自動で保存されるプロパティ: `BOT_USER_ID`（宛先照合用）、`LAST_WEBHOOK_AT` / `LAST_WEBHOOK_EVENTS`（受信記録）、`PENDING_*`、`TRIGGER_*`、`LAST_RUN_*`、`CURRENT_RICHMENU_ID`。

廃止したプロパティ: `ALLOW_UNSIGNED_WEBHOOK`（`WEBHOOK_MODE` に置き換え）。残っている場合は「ID・URL設定チェック」で注意が表示されます。

## 5. LINE Developers 側の設定手順

1. **Messaging API 設定**
   - Webhook URL: ID管理シートの `GAS_WEBAPP_URL`（`https://script.google.com/macros/s/…/exec`）をそのまま指定します。
   - Webhook の利用: **オン**
   - Webhook の再送: どちらでも構いません。GAS は HTTP 200 を返すため、通常は再送されません。再送されても、重複は `webhookEventId` で排除されます。
   - 「検証」ボタン: 最新コードを反映し、ウェブアプリを新バージョンで更新した後に押します（[8章](#8-http-302-の原因と対応)）。
2. **LINE Official Account Manager → 応答設定**
   - チャット: オン（オペレーター対応で担当者が返信するため。[docs/operator.md](docs/operator.md#6-line-official-account-manager-の設定)）
   - Webhook: オン
   - あいさつメッセージ: オフ（GAS が送信するため）
   - 応答メッセージ: オフ
3. **LINE ログインチャネル・LIFF**（予約確認を使う場合）: [docs/setup.md](docs/setup.md#1-2-line-ログインチャネルliff-用)

## 6. GAS Web アプリのデプロイ・更新手順

```bash
git clone https://github.com/officialwork-design/SKY-STANDARD.git && cd SKY-STANDARD
git checkout feature/line-system
npm install -g @google/clasp && clasp login
clasp push                     # 本体GAS（src/gas）を更新
```

1. 本体GASのエディタで「デプロイ → デプロイを管理」を開き、既存のウェブアプリを編集（鉛筆アイコン）します。
2. バージョンで「**新バージョン**」を選んで「デプロイ」を押します。URL は変わりません。
   - 実行ユーザー: **自分**
   - アクセスできるユーザー: **全員**
3. 新しいデプロイを作った場合は URL が変わります。その場合は ID管理の `GAS_WEBAPP_URL` と、LINE の Webhook URL の両方を更新してください。
4. 管理メニュー用GASは、本体GASの最新の保存内容（開発モード）を参照するため、`clasp push` の時点で反映されます。メニューの画面（`src/sheet-admin`）を変えた場合は `npm run sheet-admin:push` を実行します。

> `clasp push` しただけでは Web アプリ（Webhook）は更新されません。必ず手順1〜2の「新バージョン」デプロイを行ってください。

## 7. スプレッドシート管理メニューの運用

スプレッドシート上部の「SKY STANDARD」メニューから操作します。GAS エディタで関数を選んで実行する必要はありません。

| メニュー | 項目 |
|---|---|
| 初期設定 | シート列・設定行の補完 / ID・URL設定チェック / LINE接続チェック / ID管理の変更を反映 |
| LINE管理 | リッチメニュー登録・更新 / リッチメニュー設定確認 / 今月の配信数確認 |
| 予約・通知 | 承認待ち通知を送信 / 選択中の通知を却下 / 失敗した通知を再送 / 通知テンプレート確認 |
| お問い合わせ | オペレーター対応状況 / オペレーター対応を終了（選択中の行） |
| システム管理 | トリガー設定 / トリガー状態確認 / 接続・設定診断 / エラーログを開く / エラーログ設定・動作確認 |

- 実行のたびに `ADMIN_USERS` で管理者か確認します。送信・却下・再送・更新の前には確認ダイアログを表示します。
- **リッチメニュー**: URL 未設定のボタン（フライト予約・予約確認・プラン一覧・チャーター）は「現在準備中です」と返信します。予約サイト完成後は、ID管理に URL を入力して「リッチメニュー登録・更新」を実行するだけでリンク方式に切り替わります。「リッチメニュー設定確認」は LINE に登録せずに、画像（2500×1686・1MB 以下）・タップ領域・LINE 側との差分を確認します。詳細は [docs/setup.md](docs/setup.md#5-リッチメニュー)。
- **オペレーター対応**: お問い合わせで「オペレーターに相談」を選んだ利用者には、担当者が LINE Official Account Manager のチャット画面から返信します。その間 GAS は自動応答を止め、「問い合わせ管理」の対応状況を「対応完了」にすると再開します。詳細は [docs/operator.md](docs/operator.md)。
- **LINE接続チェック**で「疎通テストも実行」を選ぶと、次の2つを分けて表示します。
  - LINE が報告した HTTP ステータス
  - GAS 側で実際に受信できたか（受信記録）
- 詳細: [docs/sheet-admin.md](docs/sheet-admin.md)、日常運用: [docs/operations.md](docs/operations.md)

## 8. HTTP 302 の原因と対応

**原因（2026-10-21 に実測）**

- GAS の Web アプリは、`ContentService`（JSON・テキスト）で応答すると **HTTP 302** を返し、`script.googleusercontent.com/macros/echo` へリダイレクトします。doPost 自体はリダイレクト前に実行されています。
- LINE はリダイレクトを追わないため、「302 で失敗」と表示します。
- 当時の本番ウェブアプリも、匿名アクセスで POST すると 302 を返しました。リダイレクト先には doPost の出力（旧コードの `signature_required`）がありました。つまり公開設定（全員）は正しく、ログイン画面への 302 ではありません。
- 旧コードは署名なしの直接 Webhook を拒否していました。そのため 302 とは別に、メッセージは処理されていませんでした。
- 検証用プロジェクトで応答方式ごとに実測した結果は次のとおりです。

| 応答 | HTTP ステータス |
|---|---|
| ContentService（JSON） | 302 |
| ContentService（テキスト） | 302 |
| **HtmlService** | **200**（リダイレクトなし） |
| 何も返さない | 200（ただし本文はエラーページ） |

**対応**

- LINE からの直接 Webhook には **HtmlService で応答**するよう変更しました。LIFF と予約イベントの応答は、従来どおり JSON（302→追従）です。
- ブラウザの `fetch` などリダイレクトを追うクライアントでは、302 でも問題ありません。

**302 が続いた確定原因（2026-10-21 再調査）**

- HtmlService 対応のコード（`0ec6ad5`）は GitHub にはありましたが、本体GASに反映されていませんでした。エディタも本番デプロイ（バージョン3）も、旧コード `a23fac1` と完全に一致していました。
- 反映してバージョン4でデプロイした後、LINE の Webhook テスト API で **成功（HTTP 200 OK）**、GAS 側の受信記録も確認しました。詳細は [docs/gas-only.md](docs/gas-only.md#1-5-再調査302-が続いた確定原因と-line-側の検証結果2026-10-21-14401452-jst)。
- 再発防止のため、管理メニューの「LINE接続チェック」「接続・設定診断」が、本番 Web アプリの版（doGet の `build`）と保存済みコードの版を比較します。

詳細: [docs/gas-only.md](docs/gas-only.md)

## 9. LINE 署名検証ができないことによる制約

GAS の `doPost(e)` には HTTP ヘッダーが渡されません（実測した `e` のキーは `contentLength, contextPath, parameter, parameters, postData, queryString` のみ）。そのため `X-Line-Signature` を検証できず、**受け取った Webhook が本当に LINE から来たものかを暗号学的に確かめられません**。Web アプリの URL を知っている人は、LINE を装ったリクエストを送れます。URL を秘密にしても、トークンを付けても、署名検証の代わりにはなりません。

そこで GAS単体構成では、直接届いたイベントを**すべて「未検証」**として扱い、次の制限を設けています。

| 処理 | 未検証イベントでの扱い |
|---|---|
| FAQ・キーワード自動応答 | 実行します。応答だけで記録は伴いません。偽造イベントの応答トークンは LINE が拒否します |
| 顧客登録（友だち追加） | あいさつの応答が LINE に受理された場合のみ登録します |
| 問い合わせ保存・運営通知 | 受付返信が LINE に受理された場合のみ、保存・通知します |
| オペレーター対応の開始 | 受付返信が LINE に受理された場合のみ開始します。**解除は Webhook からは不可**（シートの「対応完了」か管理メニューのみ） |
| 「担当者に送る」用の一時保存・入力待ち状態 | 応答が受理された場合のみ |
| ブロック反映（unfollow） | プロフィール API で「友だちでない」と確認できた場合のみ |
| 予約確定・決済完了・キャンセル等の状態変更 | **Webhook からは不可**。予約サイトの HMAC 署名付きイベントのみで行います |
| 予約内容・個人情報の開示 | **Webhook からは不可**。LIFF＋ID トークン検証のみで行います |
| 管理者操作（通知承認・リッチメニュー更新等） | **Webhook からは不可**。管理メニュー＋`ADMIN_USERS` のみで行います |

応答トークンによる確認は**補助的な対策**で、署名検証と同等の保証ではありません。ただし、LINE が発行する1回限りのトークンが偽造イベントでは使えないことを利用しており、偽造による記録・通知の大半を防ぎます。残るリスクは[12章](#12-残っているセキュリティリスク)を参照してください。

## 10. 本番運用できる機能と未対応の機能

| 区分 | 機能 |
|---|---|
| GAS単体で運用可能 | FAQ・キーワード自動応答、友だち追加あいさつ・顧客登録、問い合わせ受付・保存・運営通知、有人オペレーター対応（自動応答の停止・再開）、リッチメニュー登録・管理、予約イベント通知（HMAC）、承認制の運航案内、再送、前日リマインド、LIFF 予約確認（ID トークン検証）、管理メニュー一式、送信ログ・冪等性 |
| 設定・外部準備が必要 | LIFF（LIFF ID・ホスティング）、予約サイトからの予約イベント送信・予約 API、リッチメニュー URL・画像 |
| GAS単体では実現不可 | LINE 署名（`X-Line-Signature`）の検証、送信元が LINE であることの暗号学的な保証、Webhook 本文の改ざん検知 |
| 実環境で未確認 | LINE の「検証」「疎通テスト」で 200 になること（HtmlService 応答）、実機での一連の操作 |

## 11. 任意構成：署名検証リレー（旧構成）

署名検証が必要になった場合は、`src/relay/` を Cloud Run 等にデプロイして `WEBHOOK_MODE=relay` を設定すると、署名検証済みとして処理できます。手順は [docs/deployment.md](docs/deployment.md#任意署名検証リレー旧構成)。GAS単体構成では、この設定は不要です。

## 12. 残っているセキュリティリスク

- **偽造 Webhook の受信**: URL を知る人は偽のイベントを送れます。応答トークン確認により記録・通知は抑止されますが、次の影響は残ります。
  - 受信記録の更新
  - GAS の実行時間・URL Fetch 割り当ての消費（大量送信による妨害）
  - ログの増加
- **応答トークン確認の限界**: LINE が発行した本物の応答トークンを第三者が入手した場合（通常は起こりません）、その1回分は防げません。イベント本文の改ざんも検知できません。
- **スプレッドシート編集者**: 管理メニュー用GASを編集できるため、管理者がメニューを実行したときに管理者権限で任意の処理を実行させることが可能です。編集権限は信頼できる担当者に限定してください。
- **Web アプリは「全員」公開**: LIFF・予約イベントは ID トークン・HMAC で認証しています。管理操作は Web アプリからは実行できません。

## エラーログ

本体GASで発生したエラー（ERROR / FATAL）だけを、「エラーログ」シートに記録します。INFO・WARN、正常な受信・送信は記録しません。

- 同じエラーは10分（FATAL は1分）に1件だけ記録します。
- 機密情報（トークン・本文・LINE ユーザーID・メール・電話番号）は記録しません。
- ログの書き込みに失敗しても、本来の処理は止まりません。
- 過去の実行履歴のエラーは取得できません（Apps Script API の制約）。

詳細: [docs/errorlog.md](docs/errorlog.md)

## 13. エラー時の復旧方法

| 症状 | 確認・対処 |
|---|---|
| LINE の検証が 302 | 「LINE接続チェック」の「Web アプリの反映状況」が【NG】なら旧コードが動いています。ウェブアプリを「新バージョン」で更新し、1〜2分待ってから疎通テストを実行してください |
| 疎通テストは失敗だが GAS 受信記録は OK | GAS は処理しています。デプロイが新バージョンか確認してください |
| 疎通テストは成功だが GAS 受信記録が NG | Webhook URL が別のデプロイを指しています。ID管理の `GAS_WEBAPP_URL` と LINE の設定を一致させてください |
| まず確認すること | 「システム管理 → エラーログを開く」で、未対応の FATAL / ERROR を確認します |
| 返信が来ない | 「接続・設定診断」でトークン・Webhook の利用（オン）・応答モード（Bot）を確認します。本体GASの「実行数」でエラーを確認します |
| 特定の利用者に自動応答しない | オペレーター対応中です。「お問い合わせ → オペレーター対応状況」で確認し、対応が済んでいれば対応状況を「対応完了」にします |
| 問い合わせが保存されない | 受付返信が LINE に拒否されています。実行ログの `webhook.event_failed` を確認してください（応答トークンの期限切れなど） |
| 「設定が不足しています」 | 表示されたキーを、ID管理シートまたはスクリプトプロパティに入力します |
| 管理メニューが動かない | [docs/sheet-admin.md](docs/sheet-admin.md#トラブルシューティング) |

その他: [docs/operations.md](docs/operations.md#障害時の確認手順)

## テスト

```bash
npm test          # モックテスト（GAS ロジック・Webhook・管理メニュー・リレー・構文）
npm run test:e2e  # 予約確認画面のブラウザ確認（Playwright・LIFF/API はモック）
```

モックテストは、実際の LINE・Google 環境での動作を保証しません。

## リポジトリ構成

```text
SKY-STANDARD/
├── README.md
├── docs/            gas-only.md / architecture.md / setup.md / sheet-admin.md / deployment.md / operations.md / errorlog.md / operator.md
├── src/
│   ├── gas/         本体GAS（00_Config.gs 〜 12_Operator.gs, appsscript.json）
│   ├── sheet-admin/ 管理メニュー用GAS（Code.gs, appsscript.json）
│   ├── relay/       任意：署名検証リレー（Cloud Run 等・旧構成）
│   └── web/booking/ 予約確認画面（LIFF）
├── assets/richmenu/ リッチメニュー画像
├── tests/           モックテスト
└── tools/           画像生成スクリプト
```
