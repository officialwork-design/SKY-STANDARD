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
- 管理データは Google スプレッドシートで確認・編集

## 2. 構成

| 要素 | 場所 | 役割 |
|---|---|---|
| GitHub | `officialwork-design/SKY-STANDARD` | ソース管理（本リポジトリ） |
| GAS | スプレッドシートにバインドされたプロジェクト（`.clasp.json`） | Webhook 処理・通知・予約確認 API |
| 署名検証リレー | `src/relay/`（Cloud Run 等） | LINE 署名検証 → GAS へ転送（GAS はヘッダーを読めないため） |
| 予約確認画面 | `src/web/booking/` | LIFF。静的ホスティングに配置 |
| スプレッドシート | 「SKY STANDARD｜公式LINE管理台帳」10 シート | 設定・顧客・予約（写し）・問い合わせ・FAQ・テンプレート・送信ログ |
| 予約サイト | 別システム（本リポジトリ外） | 予約・決済の正本。予約イベントを GAS へ送信 |

```text
SKY-STANDARD/
├── README.md
├── docs/            architecture.md / setup.md / deployment.md / operations.md
├── src/
│   ├── gas/         00_Config.gs 〜 11_Admin.gs, appsscript.json
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
2. GAS にコードを反映（clasp）し、スクリプトプロパティを設定
3. スプレッドシートのメニュー「SKY STANDARD → シート列・設定行の補完」
4. 「LINE設定」シートに URL・LIFF ID・管理者通知先を入力
5. GAS を Web アプリとしてデプロイ → リレーをデプロイ → Webhook URL 設定
6. リッチメニュー登録、トリガー設定、予約確認画面の配置

手順の詳細: [docs/setup.md](docs/setup.md)

## 4. LINE Developers の設定

- Messaging API: チャネルアクセストークン（長期）発行、Webhook オン、応答メッセージ・あいさつメッセージはオフ（GAS が送信）
- LINE ログイン: Messaging API と**同一プロバイダー**に作成、公式アカウントをリンク
- 詳細: [docs/setup.md §1](docs/setup.md#1-line-developers)

## 5. GAS スクリプトプロパティ一覧

| キー | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API（必須） |
| `RELAY_SHARED_SECRET` | リレー封筒の検証（必須） |
| `LINE_LOGIN_CHANNEL_ID` | ID トークン検証（予約確認） |
| `RESERVATION_WEBHOOK_SECRET` | 予約イベントの署名検証（予約通知） |
| `RESERVATION_API_BASE_URL` / `RESERVATION_API_KEY` | 予約サイト API（任意。未設定ならシート参照） |
| `RICHMENU_IMAGE_FILE_ID` | リッチメニュー画像（ドライブ） |
| `ADMIN_EMAIL` | 運営通知メール（任意） |
| `LINE_CHANNEL_SECRET` / `SPREADSHEET_ID` / `ALLOW_UNSIGNED_WEBHOOK` | 任意・開発用 |

値は記載しません。`.env.example` にキー一覧があります。

## 6. LIFF の設定

LINE ログインチャネルに LIFF（Full / scope: `openid` `profile` `chat_message.write`）を作成し、エンドポイントに予約確認画面の HTTPS URL を設定。LIFF ID を「LINE設定」と `src/web/booking/config.json` に入力します。

## 7. リッチメニューの登録方法

`assets/richmenu/richmenu.png` をドライブへアップロード → `RICHMENU_IMAGE_FILE_ID` を設定 → メニュー「リッチメニューを登録・更新」。URL 未設定のボタンは「準備中」と返信します（ダミー URL は使いません）。

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
npm test                 # GAS ロジック・リレーのモックテスト（外部サービスは呼ばない）
npm run test:e2e         # 予約確認画面のブラウザ確認（Playwright 必要・LIFF/API はモック）
```

モックテストは実環境の動作保証ではありません。設定完了後に [docs/deployment.md §5](docs/deployment.md#5-実環境テストチェックリスト) の実環境チェックリストを実施してください。

## 12. 運用方法

問い合わせ対応・FAQ 更新・テンプレート編集・運航案内の承認・配信数確認: [docs/operations.md](docs/operations.md)

## 13. 障害時の確認手順

設定チェック → GAS 実行ログ → リレーのログ → LINE Developers の Webhook 検証 → 送信ログ の順に確認します。イベント名ごとの原因と対処: [docs/operations.md](docs/operations.md#障害時の確認手順)

---

### セキュリティ方針

- 秘密情報はスクリプトプロパティ／Secret Manager のみ。リポジトリ・スプレッドシートに保存しない
- Webhook は署名検証済みのみ処理。予約確認は ID トークンをサーバー側で検証し、本人の予約のみ返却
- 既存シート・既存データは削除・初期化しない（不足列は末尾に追加のみ）
- ログはユーザーIDマスク・本文／トークン非出力
