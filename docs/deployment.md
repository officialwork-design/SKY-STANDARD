# デプロイ手順

本番反映は「必要な設定」と「テスト」が完了してから行ってください。

## 1. GAS へのコード反映（clasp）

対象 GAS プロジェクト: `1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff`（独立GAS。Web アプリ兼、管理メニューのライブラリ）。

```bash
npm install -g @google/clasp
clasp login                       # GAS 編集権限のある Google アカウントで
# https://script.google.com/home/usersettings で「Google Apps Script API」をオン
git clone https://github.com/officialwork-design/SKY-STANDARD.git
cd SKY-STANDARD
clasp status                      # 反映対象（src/gas/*.gs, appsscript.json）を確認
clasp push                        # src/gas の内容で独立GASを更新
```

- `.clasp.json` の `rootDir` は `src/gas` です。

### 手動で反映する場合

GAS エディタで `src/gas` の各ファイルと同名のスクリプトファイルを作成して内容を貼り付け、「プロジェクトの設定」→「appsscript.json をエディタで表示」をオンにして `appsscript.json` を置き換えます。

## 1-2. 管理メニュー用GAS（スプレッドシートに紐づく）

[sheet-admin.md](sheet-admin.md) の手順で作成・反映します（`cd src/sheet-admin && clasp create … && clasp push --force`）。独立GASはライブラリ `SkyStandard`（開発モード）として読み込まれるため、独立GASに `clasp push` するとメニューの処理も更新されます。

## 2. GAS Web アプリのデプロイ

1. スプレッドシートのメニュー「SKY STANDARD → 初期設定 → シート列・設定行の補完」を実行（`SPREADSHEET_ID` が独立GASのスクリプトプロパティに保存されます）。独立GASのエディタで任意の関数（例 `doGet`）を一度実行して、Web アプリ用の権限も承認してください。
2. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**（LINE・予約サイト・LIFF から匿名で呼び出すため。各リクエストは署名／ID トークンで認証）
3. 発行された URL（`https://script.google.com/macros/s/.../exec`）を ID管理シートの `GAS_WEBAPP_URL` に入力（リレーの環境変数にも設定）。
4. コード更新時は「デプロイを管理」→ 既存デプロイを編集 →「新バージョン」で URL を変えずに更新（`clasp deploy -i <deploymentId>` でも可）。

## 任意：署名検証リレー（旧構成）

> 標準の GAS単体構成では不要です（LINE の Webhook URL に GAS_WEBAPP_URL を直接指定）。署名検証が必要になった場合のみ実施し、本体GASのスクリプトプロパティに `WEBHOOK_MODE=relay` と `RELAY_SHARED_SECRET` を設定してください。

### Cloud Run の例

```bash
cd src/relay
gcloud run deploy sky-standard-line-relay \
  --source . --region asia-northeast1 \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 3 \
  --set-secrets LINE_CHANNEL_SECRET=line-channel-secret:latest,RELAY_SHARED_SECRET=relay-shared-secret:latest \
  --set-env-vars GAS_WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec
```

- 事前に Secret Manager に `line-channel-secret` と `relay-shared-secret` を作成。
- リレーは GAS の処理完了を待ってから LINE に応答します。GAS が一時失敗（`ok:false`）を返した場合や転送に失敗した場合は 5xx を返し、LINE の「Webhookの再送」（オン推奨）で再配信されます。処理済みのイベントは GAS 側で重複排除されます。
- GAS の処理が長引き LINE 側でタイムアウトした場合も再送されますが、同じ `webhookEventId` は二重処理されません。
- LINE Developers の Webhook URL に `https://<relay-host>/webhook` を設定し「検証」→ 成功を確認。
- ヘルスチェック: `GET /healthz`。

Cloud Run 以外（Cloudflare Workers / AWS Lambda 等）でも、`server.js` の `verifyLineSignature` と `buildEnvelope` と同じ処理を実装すれば利用できます。

## 4. 予約確認画面（LIFF）

`src/web/booking/` は静的ファイルのみです。HTTPS で配信できる任意のホスティング（既存予約サイトの配下、Firebase Hosting、Cloudflare Pages 等）に配置します。

```bash
cp src/web/booking/config.example.json src/web/booking/config.json
# liffId と apiUrl（= GAS_WEBAPP_URL）を記入。いずれも公開値（秘密情報ではない）
```

- `config.json` は `.gitignore` 済み。ホスティング側で配置してください。
- 既存の予約サイトに同等の本人認証付きマイページがある場合は、この画面は使わず `予約確認URL` にそのページを設定してください。

## 5. 実環境テスト（チェックリスト）

モックテスト（`npm test`）とは別に、設定完了後に実機で確認します。結果は「実装タスク」シートの備考などに記録してください。

| # | 確認内容 | 期待結果 |
|---|---|---|
| 1 | Webhook の「検証」 | 成功 |
| 2 | テスト端末で友だち追加 | あいさつ受信・「顧客管理」に1行追加 |
| 3 | リッチメニュー 6 ボタン | 各 URL へ遷移／お問い合わせ・FAQ が応答 |
| 4 | 「予約」「キャンセル」「集合場所」「天気」等を送信 | 対応する案内・FAQ |
| 5 | 問い合わせ（種別→内容） | 受付ID 返信・「問い合わせ管理」に保存・管理者通知 |
| 6 | 予約確認（LIFF） | ログイン後に本人の予約のみ表示 |
| 7 | 別アカウントで予約確認 | 他人の予約が表示されない |
| 8 | 署名付きテスト予約イベント（受付→確定） | 区別された通知・「送信ログ」に成功 |
| 9 | 同じイベントを再送 | 通知は 1 回のみ |
| 10 | FLIGHT_CHANGE | 承認待ち → メニューから承認で送信 |
| 11 | アクセストークンを一時的に誤った値に | 送信ログ／実行ログにエラー記録、処理は停止しない |

予約イベントのテスト送信例（Node.js）:

```js
const crypto = require('crypto');
const ts = Date.now();
const payload = JSON.stringify({ eventId: 'test-1', eventType: 'BOOKING_RECEIVED',
  reservation: { reservationId: 'TEST-001', lineUserId: '<自分のLINEユーザーID>', planName: 'テスト', flightDate: '2026-12-01', timeSlot: '10:00', passengers: 1 } });
const sig = crypto.createHmac('sha256', process.env.RESERVATION_WEBHOOK_SECRET).update(ts + '.' + payload).digest('hex');
fetch(process.env.GAS_WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'reservation_event', ts, payload, sig }) }).then(r => r.text()).then(console.log);
```
