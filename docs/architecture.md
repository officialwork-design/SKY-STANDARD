# アーキテクチャ

> 標準構成は GAS単体（LINE → 本体GAS 直接）です。下図のリレーは任意構成です。GAS単体構成の制約と Webhook の扱いは [gas-only.md](gas-only.md) を参照してください。

## 全体構成

```text
                       ┌────────────────────────┐
  LINE ユーザー ─────▶ │ LINE Platform           │
   (トーク/メニュー)     └──────────┬─────────────┘
                                  │ Webhook (X-Line-Signature)
                                  ▼
                       ┌────────────────────────┐
                       │ 署名検証リレー           │  src/relay（Cloud Run 等）
                       │ ・X-Line-Signature 検証  │
                       │ ・HMAC 封筒で GAS へ転送  │
                       └──────────┬─────────────┘
                                  │ POST {kind:'line_webhook', ts, body, sig}
                                  ▼
 予約サイト ─────────▶ ┌────────────────────────┐ ◀──── 予約確認画面（LIFF）
 (正本: 予約・決済)       │ Google Apps Script      │        src/web/booking
 POST reservation_event │ Web アプリ (doPost)      │        POST {kind:'liff_api', idToken}
 (HMAC 署名)             │ src/gas                 │
          ▲              └──────┬─────────┬───────┘
          │ GET/POST /line/*     │         │ Messaging API（reply/push）
          └──────────────────────┘         ▼
                                 ┌────────────────────────┐
                                 │ Google スプレッドシート   │ 管理台帳（10シート）
                                 └────────────────────────┘
```

| 役割 | 実装 | 備考 |
|---|---|---|
| 予約・決済・空き枠 | 予約ホームページ（既存/別途） | **正本**。本リポジトリでは再構築しない |
| Webhook 署名検証 | `src/relay/server.js` | GAS はリクエストヘッダーを読めないため必須 |
| 自動応答・問い合わせ・通知 | `src/gas/*.gs` | 独立GAS（Web アプリ兼ライブラリ）。`SPREADSHEET_ID` で台帳を開く |
| 管理メニュー | `src/sheet-admin/` | スプレッドシートに紐づく GAS。独立GASをライブラリとして呼ぶ |
| 予約確認画面 | `src/web/booking/` | LIFF。ID トークンをサーバー側で検証 |
| 管理台帳 | スプレッドシート | 運営が閲覧・編集する設定と記録 |

## GAS ファイル

| ファイル | 内容 |
|---|---|
| `00_Config.gs` | 定数、ID管理シート（公開 ID・URL）／スクリプトプロパティ（秘密情報）の読み込み、キャッシュ、設定チェック |
| `01_Webhook.gs` | `doPost`/`doGet`、GAS単体受信（未検証イベントの形式検証・制限・HtmlService 応答）、任意のリレー封筒検証、イベント振り分け、重複排除 |
| `02_LineApi.gs` | reply / push / profile / quota、`X-Line-Retry-Key`、エラー分類 |
| `03_User.gs` | 顧客登録・友だち状態の更新 |
| `04_FAQ.gs` | 表記揺れ正規化、キーワード優先順位、FAQ 検索 |
| `05_Inquiry.gs` | 問い合わせ受付（種別 → 内容）、有人対応への切り替え |
| `06_Reservation.gs` | ID トークン検証、予約取得（API / シート）、本人確認による紐付け |
| `07_Notification.gs` | 予約イベント受信、冪等送信、承認制、再試行、前日リマインド |
| `08_RichMenu.gs` | リッチメニュー定義の生成・登録 |
| `09_Spreadsheet.gs` | ヘッダー名ベースの読み書き、列補完、ロック、数式インジェクション対策 |
| `10_Logger.gs` | マスク付きログ、送信ログ記録 |
| `11_Admin.gs` | 運営通知、管理 API `adminRun`（ライブラリ公開・管理者確認付き） |
| `sheet-admin/Code.gs` | スプレッドシートに紐づく管理メニュー（ライブラリ `SkyStandard` を呼び出す）・トリガー |

GAS は全ファイルを同一スコープで評価するため、トップレベルでは定数定義のみを行い、他ファイルの関数は関数内からのみ呼び出しています（読み込み順序に依存しません）。

## doPost の受付種別

| kind | 送信元 | 認証 |
|---|---|---|
| LINE Webhook（`destination`・`events`） | LINE（直接・既定） | **認証なし**（GAS はヘッダーを読めないため署名検証不可）。未検証イベントとして制限付きで処理。[gas-only.md](gas-only.md) |
| `line_webhook` | リレー（任意） | `sig = base64(HMAC_SHA256(RELAY_SHARED_SECRET, ts + "." + body))`、`ts` は ±5分以内 |
| `liff_api` | 予約確認画面 | LINE の ID トークンを `https://api.line.me/oauth2/v2.1/verify` で検証（`aud`/`iss`/`exp` も確認） |
| `reservation_event` | 予約サイト | `sig = hex(HMAC_SHA256(RESERVATION_WEBHOOK_SECRET, ts + "." + payload))`、`ts` は ±5分以内 |

## 予約サイトとの連携インターフェース（提案）

予約サイトの実装はリポジトリに存在しないため、以下は **LINE 連携側が期待するインターフェースの提案** です。予約サイト側で実装・合意されるまで、該当機能は「未設定」として安全に停止します。

### 1. 予約イベント（予約サイト → GAS）

```http
POST {GAS_WEBAPP_URL}
Content-Type: application/json

{
  "kind": "reservation_event",
  "ts": 1792550000000,
  "payload": "{\"eventId\":\"evt_01\",\"eventType\":\"BOOKING_CONFIRMED\",\"occurredAt\":\"2026-10-21T10:00:00+09:00\",\"reservation\":{...}}",
  "sig": "<hex HMAC-SHA256(RESERVATION_WEBHOOK_SECRET, ts + '.' + payload)>"
}
```

| eventType | 意味 | LINE 通知テンプレート | 予約状態の更新 |
|---|---|---|---|
| `BOOKING_RECEIVED` | 予約リクエスト受付（未確定） | `BOOKING_RECEIVED` | 予約リクエスト受付 |
| `BOOKING_CONFIRMED` | 事業者による予約確定 | `BOOKING_CONFIRMED` | 予約確定 |
| `BOOKING_CHANGED` | 予約内容の変更 | `BOOKING_CHANGED` | `reservation.status` を採用 |
| `BOOKING_CANCELLED` | キャンセル | `BOOKING_CANCELLED` | キャンセル |
| `PAYMENT_COMPLETED` | 決済完了 | `PAYMENT_COMPLETED` | 決済状態＝決済完了 |
| `FLIGHT_CHANGE` | 運航変更・欠航案内 | `FLIGHT_CHANGE` | **承認待ち**（担当者承認後に送信） |

`reservation` オブジェクト:

| フィールド | 型 | 説明 |
|---|---|---|
| `reservationId` | string | 必須 |
| `lineUserId` | string | LINE ログイン連携済みの場合。未連携なら空（シートに紐付けがあればそれを使用） |
| `planId`, `planName` | string | |
| `flightDate` | string | `YYYY-MM-DD` |
| `timeSlot` | string | 例 `18:00` |
| `passengers` | number | |
| `amount` | number | 税込金額 |
| `status` | string | `requested` / `confirmed` / `changed` / `cancelled` / `completed` |
| `paymentStatus` | string | `unpaid` / `pending` / `paid` / `refunded` / `failed` |
| `meetingPoint`, `notes` | string | 集合場所・注意事項 |
| `manageUrl` | string | 運営用管理画面 URL（利用者には返さない） |

レスポンス: `{"ok":true,"result":"成功|承認待ち|対象なし|...","duplicate":false}`。同じ `reservationId:eventType:eventId` は二重処理されません（`duplicate:true`）。

> 注意: GAS Web アプリは 302 リダイレクトでレスポンスを返します。予約サイト側の HTTP クライアントはリダイレクト追従（GET）を有効にしてください。

### 2. 予約取得 API（GAS → 予約サイト）— `RESERVATION_API_BASE_URL` 設定時のみ使用

```http
GET {BASE}/line/reservations?lineUserId={検証済み sub}
Authorization: Bearer {RESERVATION_API_KEY}
→ 200 { "reservations": [Reservation, ...] }
```

```http
POST {BASE}/line/link
Authorization: Bearer {RESERVATION_API_KEY}
{ "lineUserId": "...", "reservationId": "...", "contact": "電話番号またはメール" }
→ 200 { "linked": true, "reservation": Reservation }   一致しない場合は linked:false
```

`lineUserId` は GAS が ID トークンを検証して得た値のみを送ります。GAS 側でも返却データの `lineUserId` を照合し、他人の予約は表示しません（多重防御）。

API 未設定時は「予約管理」シート（予約イベントで同期された実データ）を参照します。この場合、予約番号＋連絡先による本人確認（紐付け）はできないため、画面には「お問い合わせください」と案内します。

## 冪等性と重複防止

| 対象 | 方法 |
|---|---|
| Webhook 再送 | `webhookEventId` を CacheService に 6 時間保持（ロック内で確認・登録） |
| 予約通知 | 冪等キー `予約ID:種別:イベントID` を「送信ログ」に記録して照合 |
| LINE 側 | 冪等キーから決定的に生成した UUID を `X-Line-Retry-Key` に指定（再送時も同じキー） |
| 前日リマインド | 冪等キー `予約ID:FLIGHT_REMINDER:搭乗日` |
| イベント順序 | `occurredAt` を「予約管理」の `最終イベント日時` と比較し、古いイベントで状態を戻さない（`occurredAt` は必ず送ること） |
| 承認・再送の同時実行 | ロック内で送信ログの行を「処理中」に切り替えてから送信 |
| Webhook の一時失敗 | GAS が `ok:false` を返すとリレーは 5xx を返し、LINE の再送で再処理（応答済みのイベントは再処理しない） |

## データ保護

- 既存シート・既存行は削除しません。必要な列は書き込み前に末尾へ追加するだけです。
- 利用者入力は `= + - @` で始まる場合 `'` を付けて保存（数式インジェクション対策）。
- ログはユーザーIDをマスクし、トークン・本文・電話番号・メールを出力しません。
- 予約確認 API は利用者向け項目のホワイトリストのみ返します（LINE ユーザーID・管理 URL は返さない）。
