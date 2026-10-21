# SKY STANDARD 公式LINEシステム

ヘリコプター遊覧飛行・チャーター事業「SKY STANDARD」の LINE 公式アカウントを、予約導線・予約確認・顧客対応を担う営業チャネルとして運用するためのシステムです。

## 1. システム概要

- **予約・決済は予約ホームページで完結**（正本）。LINE は予約サイトへの導線、本人の予約確認、問い合わせ、通知を担当します。
- 6 分割リッチメニュー（フライト予約／予約確認／プラン一覧／チャーター／お問い合わせ／よくある質問）
- 友だち追加あいさつ、キーワード・FAQ 自動応答（表記揺れ対応・優先順位あり）
- 問い合わせ受付（5 種別）→「問い合わせ管理」へ保存 → 運営へ通知、有人対応への切り替え
- LIFF による本人認証付き予約確認（ID トークンをサーバー側で検証）
- 予約イベント通知（受付／確定／変更／キャンセル／決済完了／前日リマインド／運航変更は承認制）
- 冪等性（Webhook 再送・予約イベント再送でも二重処理しない）、通知の再試行
- 管理データは Google スプレッドシートで確認・編集。ID・URL は「ID管理」シートで変更でき、コード編集は不要
- スプレッドシート上部の「SKY STANDARD」メニューから管理操作（GAS エディタ不要）

## 2. 構成

| 要素 | 場所 | 役割 |
|---|---|---|
| GitHub | `officialwork-design/SKY-STANDARD` | ソース管理（本リポジトリ） |
| 独立GAS | `src/gas`（`.clasp.json`、ID `1zlkPtaZ…`） | Webhook 処理・通知・予約確認 API。管理メニューのライブラリも兼ねる |
| 管理メニュー用GAS | `src/sheet-admin`（スプレッドシートに紐づく） | 「SKY STANDARD」メニュー・確認ダイアログ・トリガー |
| 署名検証リレー | `src/relay/`（Cloud Run 等） | LINE 署名検証 → GAS へ転送（GAS はヘッダーを読めないため） |
| 予約確認画面 | `src/web/booking/` | LIFF。静的ホスティングに配置 |
| スプレッドシート | 「SKY STANDARD｜公式LINE管理台帳」11 シート | ID管理（ID・URL）・顧客・予約（写し）・問い合わせ・FAQ・テンプレート・送信ログ ほか |
| 予約サイト | 別システム（本リポジトリ外） | 予約・決済の正本。予約イベントを GAS へ送信 |

```text
SKY-STANDARD/
├── README.md
├── docs/            architecture.md / setup.md / sheet-admin.md / deployment.md / operations.md
├── src/
│   ├── gas/         00_Config.gs 〜 11_Admin.gs, appsscript.json（独立GAS）
│   ├── sheet-admin/ Code.gs, appsscript.json（スプレッドシートの管理メニュー）
│   ├── relay/       server.js, Dockerfile, package.json
│   └── web/booking/ index.html, app.js, style.css, config.example.json
├── assets/richmenu/ richmenu.svg（元データ）, richmenu.png（2500×1686）
├── tests/           モックテスト（node --test）, e2e/（ブラウザ確認）
├── tools/           render-richmenu.js
├── .clasp.json / .env.example / .gitignore / package.json
```

詳細は [docs/architecture.md](docs/architecture.md)。

## 3. 初期セットアップ

1. LINE Developers で Messaging API チャネル・LINE ログインチャネル・LIFF を設定
2. 独立GAS にコードを反映（clasp）し、秘密情報・`ADMIN_USERS` をスクリプトプロパティに設定
3. スプレッドシートに管理メニュー用GASを作成（[docs/sheet-admin.md](docs/sheet-admin.md)）
4. メニュー「SKY STANDARD → 初期設定 → シート列・設定行の補完」→「ID・URL設定チェック」
5. 「ID管理」シートに ID・URL を入力
6. GAS を Web アプリとしてデプロイ → リレーをデプロイ → Webhook URL 設定
7. メニューからリッチメニュー登録・トリガー設定、予約確認画面の配置

手順の詳細: [docs/setup.md](docs/setup.md)

## 4. LINE Developers の設定

- Messaging API: チャネルアクセストークン（長期）発行、Webhook オン、応答メッセージ・あいさつメッセージはオフ（GAS が送信）
- LINE ログイン: Messaging API と**同一プロバイダー**に作成、公式アカウントをリンク
- 詳細: [docs/setup.md §1](docs/setup.md#1-line-developers)

## 5. 設定の保存先（ID管理シート／スクリプトプロパティ）

**公開可能な ID・URL は「ID管理」シートの B列**から読み込みます。旧「LINE設定」シートは参照しません。

| ID管理シートのキー | 用途 |
|---|---|
| `LINE_LOGIN_CHANNEL_ID` / `LIFF_ID` | 予約確認（ID トークン検証・LIFF） |
| `GAS_WEBAPP_URL` | Web アプリ URL（リレー・LIFF の接続先） |
| `BOOKING_SITE_URL` / `BOOKING_CONFIRM_URL` / `PLAN_LIST_URL` / `CHARTER_URL` | リッチメニュー・自動応答の遷移先 |
| `ADMIN_NOTIFY_TARGET` | 運営通知先 LINE ID |
| `RICHMENU_IMAGE_FILE_ID` | リッチメニュー画像（ドライブ） |
| `RESERVATION_API_BASE_URL` | 予約サイト API（任意） |
| `SPREADSHEET_ID` / `GAS_SCRIPT_ID` | 確認・管理用 |

**秘密情報は独立GASのスクリプトプロパティ**（リレーは Secret Manager）のみに保存します。シートに値があっても読み込みません。

| スクリプトプロパティ | 用途 |
|---|---|
| `SPREADSHEET_ID` | 起動用（シート補完で自動設定） |
| `ADMIN_USERS` | 管理メニューを操作できるメールアドレス |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API（必須） |
| `RELAY_SHARED_SECRET` | リレー封筒の検証（必須） |
| `RESERVATION_WEBHOOK_SECRET` | 予約イベントの署名検証 |
| `RESERVATION_API_KEY` / `RESERVATION_API_ALLOWED_HOST` | 予約サイト API キーと、その送信を許可するホスト（API 利用時） |
| `ADMIN_EMAIL` / `LINE_CHANNEL_SECRET` / `ALLOW_UNSIGNED_WEBHOOK` | 任意・開発用 |

ID管理の値を変更すると、スプレッドシートの `onEdit` で即時に反映されます（キャッシュは最大5分）。詳細は [docs/setup.md](docs/setup.md)。

## 6. LIFF の設定

LINE ログインチャネルに LIFF（Full / scope: `openid` `profile` `chat_message.write`）を作成し、エンドポイントに予約確認画面の HTTPS URL を設定。LIFF ID を「ID管理」の `LIFF_ID` と `src/web/booking/config.json` に入力します。

## 7. リッチメニューの登録方法

`assets/richmenu/richmenu.png` をドライブへアップロード → ID管理の `RICHMENU_IMAGE_FILE_ID` に入力 → メニュー「LINE管理 → リッチメニュー登録・更新」。URL 未設定のボタンは「準備中」と返信します（ダミー URL は使いません）。

## 8. Webhook 設定

LINE の Webhook URL は **リレー**（`https://<relay-host>/webhook`）を指定します。GAS の URL を直接指定すると署名検証ができないため、GAS は既定でそのリクエストを拒否します。

## 9. 予約サイト API の連携方法

予約サイトから GAS へ HMAC 署名付きの予約イベントを POST します。予約サイトに本人確認 API（`/line/reservations`, `/line/link`）を用意すると、予約確認・紐付けは予約サイトの正本データを参照します。インターフェース仕様: [docs/architecture.md](docs/architecture.md#予約サイトとの連携インターフェース提案)

## 10. GAS デプロイ方法

```bash
npm install -g @google/clasp && clasp login
clasp push
# GAS エディタ「デプロイ」→ ウェブアプリ（実行: 自分 / アクセス: 全員）
```

詳細・リレー（Cloud Run）・LIFF 配置: [docs/deployment.md](docs/deployment.md)

## 11. テスト方法

```bash
npm test                 # GAS ロジック・管理メニュー・リレーのモックテスト（外部サービスは呼ばない）
npm run test:e2e         # 予約確認画面のブラウザ確認（Playwright 必要・LIFF/API はモック）
```

モックテストは実環境の動作保証ではありません。設定完了後に [docs/deployment.md §5](docs/deployment.md#5-実環境テストチェックリスト) の実環境チェックリストを実施してください。

## 12. 運用方法

問い合わせ対応・FAQ 更新・テンプレート編集・運航案内の承認・配信数確認: [docs/operations.md](docs/operations.md)

## スプレッドシート管理メニュー

スプレッドシートを開くと上部に「SKY STANDARD」メニューが表示されます。GAS エディタで関数を選んで実行する必要はありません。

| メニュー | 項目 |
|---|---|
| 初期設定 | シート列・設定行の補完 / ID・URL設定チェック / LINE接続チェック / ID管理の変更を反映 |
| LINE管理 | リッチメニュー登録・更新 / リッチメニュー設定確認 / 今月の配信数確認 |
| 予約・通知 | 承認待ち通知を送信 / 選択中の通知を却下 / 失敗した通知を再送 / 通知テンプレート確認 |
| システム管理 | トリガー設定 / トリガー状態確認 / 接続・設定診断 |

- **仕組み**: スプレッドシートに紐づく GAS（`src/sheet-admin`）が、独立GASをライブラリ `SkyStandard` として呼び出します。公開 Web アプリには管理用の入口を設けていません。
- **権限**: 実行のたびに `ADMIN_USERS`（必須）で管理者か確認します。定期処理のトリガーは独立GAS側に作成します。送信・却下・再送・リッチメニュー更新の前には確認ダイアログを表示し、結果とエラーは画面に表示します。
- **作成・反映方法**（clasp / 手動）、**初回認証**、**ID管理シートの入力方法**、**秘密情報の設定方法**、**トラブルシューティング**: [docs/sheet-admin.md](docs/sheet-admin.md)・[docs/setup.md](docs/setup.md)

```bash
# 管理メニュー用GASの作成・反映（初回のみ create）
cd src/sheet-admin
clasp create --type sheets --title "SKY STANDARD 管理メニュー" --parentId 1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es --rootDir .
clasp push --force
```

## 13. 障害時の確認手順

メニュー「システム管理 → 接続・設定診断」→ GAS 実行ログ → リレーのログ → LINE Developers の Webhook 検証 → 送信ログ の順に確認します。管理メニュー自体の不具合は [docs/sheet-admin.md](docs/sheet-admin.md#トラブルシューティング)。イベント名ごとの原因と対処: [docs/operations.md](docs/operations.md#障害時の確認手順)

---

### セキュリティ方針

- 秘密情報はスクリプトプロパティ／Secret Manager のみ。リポジトリ・スプレッドシートに保存しない
- Webhook は署名検証済みのみ処理。予約確認は ID トークンをサーバー側で検証し、本人の予約のみ返却
- 既存シート・既存データは削除・初期化しない（不足列は末尾に追加のみ）
- ログはユーザーIDマスク・本文／トークン非出力
