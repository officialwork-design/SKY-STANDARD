# 予約サイト API 連携仕様（LINE 予約確認用）

LINE トークでの予約確認（リッチメニュー「予約確認」）で、本体GASが予約サイト（Next.js / Prisma / PostgreSQL）に問い合わせるための API の仕様です。

**2026-10-30 時点で、予約サイトにはこの API はまだありません。** 予約サイトは未公開（`NEXT_PUBLIC_APP_URL=http://localhost:3000`）で、利用者向けの予約照会・変更・キャンセル画面もありません（予約変更は管理画面 `/api/admin/bookings/[id]/change` のみ）。GAS 側は API が無い間、「予約管理」シートで LINE ユーザーIDが紐づいた予約だけを表示し、それ以外はオペレーターへ案内します。

予約IDだけで個人情報を返す公開 API は作りません。

## 1. 共通

| 項目 | 内容 |
|---|---|
| ベース URL | ID管理 `RESERVATION_API_BASE_URL`（https のみ） |
| 認証 | `Authorization: Bearer <RESERVATION_API_KEY>`（サーバー間。予約サイト側で定数時間比較） |
| キーの送信先の固定 | GAS は スクリプトプロパティ `RESERVATION_API_ALLOWED_HOST` と一致するホストにだけキーを送る |
| 文字コード | JSON（UTF-8） |
| 応答コード | 200 成功 ／ 401 認証失敗 ／ 404 該当なし（存在しない・一致しない・紐づかないを区別しない）／ 429 回数超過 ／ 5xx 障害 |

GAS は 429・5xx を「ただいま確認できません」として案内し、エラーログに記録します。予約サイトの内部エラー内容は利用者に表示しません。

## 2. 本人の予約一覧（既存の提案インターフェース）

```text
GET {BASE}/line/reservations?lineUserId={LINEユーザーID}
→ 200 { "reservations": [ Reservation, ... ] }
```

- その LINE ユーザーID に**紐づけ済み**の予約だけを返す（紐づけは 3. で行う）。
- GAS は返ってきた予約の `lineUserId` を再確認し、他人の予約が混ざっても表示しない。

## 3. 予約と LINE アカウントの紐づけ（追加の本人確認）

```text
POST {BASE}/line/link
{ "lineUserId": "U…", "reservationId": "SKY-20261201-A1B2C3", "contact": "09012345678" | "taro@example.com" }
→ 200 { "linked": true, "reservation": Reservation }
→ 404 { "linked": false }     … 予約IDが無い／連絡先が一致しない（理由を区別しない）
→ 429                        … 回数超過
```

- `contact` は予約時の顧客の電話番号（数字のみ、ハイフン・空白なしに正規化済み）またはメールアドレス（小文字化済み）。`Customer.phone` / `Customer.email` と照合する。
- **予約IDごとに照合回数を制限すること**（例：1時間5回）。GAS 側も LINE ユーザーごとに1時間5回まで。
- 一致したら、その予約（または顧客）に LINE ユーザーIDを保存し、以後は 2. で返す。
- 連絡先・照合結果をログに残さない。

## 4. Reservation（返す項目）

LINE に表示するのは最小限です。氏名・電話・メール・金額・決済情報は返さないでください（返しても GAS は表示しません）。

| 項目 | 型 | 内容 | 予約サイトでの元 |
|---|---|---|---|
| `reservationId` | string | 予約ID（`SKY-YYYYMMDD-XXXXXX`） | `Booking.reference` |
| `lineUserId` | string | 紐づいた LINE ユーザーID | （新規）紐づけ情報 |
| `planName` | string | プラン名 | `Plan.name` |
| `courseName` | string | コース名 | 予約したコースの名称（`Course`） |
| `flightDate` | string | 搭乗予定日 `YYYY-MM-DD`（JST） | `FlightSlot.startsAt` |
| `timeSlot` | string | 時間帯 `HH:mm`（JST） | `FlightSlot.startsAt` |
| `passengers` | number | 人数 | `Booking.partySize` |
| `status` | string | 予約状態 | `Booking.status`（例 `CONFIRMED`） |
| `statusLabel` | string | 表示用の予約状況（任意。なければ GAS が変換） | |
| `changeable` | boolean | LINE から変更手続きに進めるか | 予約サイトの変更条件 |
| `changeBlockedReason` | string | 変更できない理由（任意） | |
| `cancellable` | boolean | キャンセル手続きに進めるか | キャンセル条件 |
| `cancelBlockedReason` | string | キャンセルできない理由（任意） | |
| `cancellationPolicy` | string | キャンセル規定の要約（任意） | |
| `cancellationFee` | string | 現時点のキャンセル料の目安（任意。例 `49,500円`） | |
| `changeUrl` | string | 利用者向け変更画面の URL（任意） | 未実装 |
| `cancelUrl` | string | 利用者向けキャンセル画面の URL（任意） | 未実装 |

- `changeable` / `cancellable` が無い場合、GAS は予約状態で判断します（キャンセル・返金済み・期限切れ・搭乗済みなどは不可）。
- `changeUrl` / `cancelUrl` は、`BOOKING_SITE_URL` または `RESERVATION_API_ALLOWED_HOST` と同じホストの https URL だけを使います。それ以外・未設定のときは「担当者が承ります」と案内し、オペレーターへの相談ボタンを出します。
- 変更・キャンセル画面は、**予約サイト側で本人確認（ログインまたはワンタイムリンク）を行うこと**。URL を知っているだけで変更・取消ができる画面にしないでください。差額・キャンセル料の確認と最終確認は予約サイトで行います。GAS は予約の変更・取消を一切行いません。

## 5. 予約サイト側で必要な作業（未実施）

1. 上記 2・3 の API（API キー認証・回数制限）
2. LINE ユーザーIDの保存先（`Booking` または `Customer` に列を追加、Prisma Migration）
3. 利用者向けの予約変更・キャンセル画面（本人確認付き）と、それを使うための `changeUrl` / `cancelUrl`
4. 公開 URL の決定（`BOOKING_SITE_URL`、FAQ ページ `FAQ_PAGE_URL`）と、FAQ ページへの LINE 問い合わせ導線

予約サイトのコードはこの作業では変更していません。
