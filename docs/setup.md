# 初期セットアップ

| 種類 | 保存先 | 例 |
|---|---|---|
| 公開可能な ID・URL | スプレッドシート **「ID管理」シート B列** | LIFF_ID, BOOKING_SITE_URL |
| 秘密情報 | **独立GASのスクリプトプロパティ**（リレーは Cloud Run Secret Manager） | LINE_CHANNEL_ACCESS_TOKEN |
| 起動用 | 独立GASのスクリプトプロパティ `SPREADSHEET_ID` | （ID管理にも確認用の写しあり） |

秘密情報はシートにも GitHub にも保存しないでください。ID管理シートに秘密情報の値が入っていても、システムは読み込みません（「ID・URL設定チェック」で【危険】と表示します）。

## 1. LINE Developers

### 1-1. Messaging API チャネル（公式アカウント）

1. LINE Developers コンソールでプロバイダー「SKY STANDARD」を選択し、Messaging API チャネルを開く。
2. 「チャネル基本設定」→ **チャネルシークレット** を控える（リレーの `LINE_CHANNEL_SECRET`）。
3. 「Messaging API設定」→ **チャネルアクセストークン（長期）** を発行（GAS の `LINE_CHANNEL_ACCESS_TOKEN`）。
4. LINE Official Account Manager → 応答設定:
   - 応答モード: **Bot**
   - あいさつメッセージ: **オフ**（GAS が送信するため。二重送信防止）
   - 応答メッセージ（自動応答）: **オフ**
   - Webhook: **オン**
5. Webhook URL はリレーをデプロイ後に設定（[deployment.md](deployment.md) の 3 章）。「Webhookの再送」はオンを推奨（重複は GAS 側で排除）。

### 1-2. LINE ログインチャネル（LIFF 用）

1. 同じプロバイダーに **LINE ログインチャネル** を作成（Messaging API チャネルと同一プロバイダー必須。ユーザーIDが一致するため）。
2. チャネルID を ID管理シートの `LINE_LOGIN_CHANNEL_ID` に入力。
3. 「リンクされたボット」に公式アカウントを設定。

### 1-3. LIFF アプリ

| 項目 | 値 |
|---|---|
| サイズ | Full |
| エンドポイントURL | 予約確認画面の公開 URL（https）例 `https://<host>/booking/index.html` |
| Scope | `openid`（必須）, `profile`, `chat_message.write`（問い合わせボタン用） |
| ボットリンク機能 | On (Aggressive) を推奨 |

作成後の **LIFF ID** を ID管理シートの `LIFF_ID` に入力し、`src/web/booking/config.json` にも設定します。

## 2. 「ID管理」シート（公開可能な ID・URL）

A列「設定キー」・B列「設定値」を読み込みます（C〜E列は説明用）。行の順番は自由です。

| 設定キー | 内容 | 形式 | 使用する機能 |
|---|---|---|---|
| `SPREADSHEET_ID` | このスプレッドシートのID（確認用の写し） | 英数字 | 起動用はスクリプトプロパティ側 |
| `GAS_SCRIPT_ID` | 独立GASのスクリプトID（管理用） | 英数字 | — |
| `LINE_LOGIN_CHANNEL_ID` | LINE ログインのチャネルID | 数字 | 予約確認（ID トークン検証） |
| `LIFF_ID` | 予約確認 LIFF ID | `1234567890-xxxx` | 予約確認・リッチメニュー |
| `GAS_WEBAPP_URL` | GAS Web アプリ URL | `https://script.google.com/macros/s/…/exec` | リレー転送先・LIFF の API |
| `BOOKING_SITE_URL` | フライト予約ページ | `https://` | リッチメニュー・自動応答 |
| `BOOKING_CONFIRM_URL` | 本人認証付き予約確認ページ（LIFF を使わない場合） | `https://` | リッチメニュー |
| `PLAN_LIST_URL` | プラン一覧ページ | `https://` | リッチメニュー・自動応答 |
| `CHARTER_URL` | チャーター専用ページ | `https://` | リッチメニュー・自動応答 |
| `ADMIN_NOTIFY_TARGET` | 運営通知を受ける LINE ユーザーID / グループID（カンマ区切りで複数可） | `U` / `C` / `R` + 32桁 | 運営通知 |
| `RICHMENU_IMAGE_FILE_ID` | リッチメニュー画像のドライブ ファイルID | 英数字 | リッチメニュー登録 |
| `RESERVATION_API_BASE_URL` | 予約システム API（任意） | `https://` | 予約確認（API 連携） |

- 形式が正しくない値は「未設定」として扱い、ダミーの URL へは遷移しません。
- `https://` 以外の URL は使用しません。
- `LINE_LOGIN_CHANNEL_ID`・`RICHMENU_IMAGE_FILE_ID`・`RESERVATION_API_BASE_URL` は、シートが空の場合のみ旧構成の同名スクリプトプロパティを参照します（移行用）。
- 旧「LINE設定」シートは参照しなくなりました。値が残っていて ID管理が空の場合は「ID・URL設定チェック」で【移行が必要】と表示します（シートは削除していません）。
- 管理者通知先の LINE ユーザーIDは、担当者が公式アカウントを友だち追加した後「顧客管理」シートで確認できます。

### 値を変更したとき

- 独立GASは ID管理の値を最大 5 分キャッシュします。
- ID管理シートを編集すると、管理メニュー用GAS の `onEdit` がキャッシュを破棄し、すぐに反映されます。
- すぐに反映したい場合は「初期設定 → ID管理の変更を反映（再読込）」または「ID・URL設定チェック」を実行してください。
- リッチメニューの URL を変えた場合は「リッチメニュー登録・更新」の再実行が必要です（LINE 側に登録済みの内容を更新するため）。

## 3. スクリプトプロパティ（独立GAS）

独立GASのエディタ → 「プロジェクトの設定」→「スクリプト プロパティ」。値は ID管理シートに入力しないでください。

| キー | 必須 | 内容 |
|---|---|---|
| `SPREADSHEET_ID` | ◎ | 起動用。管理メニューの「シート列・設定行の補完」で自動設定されます |
| `ADMIN_USERS` | ◎ | 管理メニューを操作できる人のメールアドレス（カンマ区切り）。**未設定の間は誰も操作できません**。最初に登録してください |
| `LINE_CHANNEL_ACCESS_TOKEN` | ◎ | Messaging API チャネルアクセストークン |
| `RELAY_SHARED_SECRET` | ◎ | リレーと共有するランダム文字列（32文字以上） |
| `RESERVATION_WEBHOOK_SECRET` | 予約通知 | 予約サイトと共有する署名用シークレット |
| `RESERVATION_API_KEY` | API 利用時 | 予約サイト API の Bearer キー |
| `RESERVATION_API_ALLOWED_HOST` | API 利用時 | API キーを送ってよいホスト名（例 `api.example.jp`）。ID管理の URL と一致しない場合は送信しません |
| `ADMIN_EMAIL` | 任意 | 運営通知メールの宛先 |
| `LINE_CHANNEL_SECRET` | 任意 | 参照用（署名検証はリレーで実施） |
| `ALLOW_UNSIGNED_WEBHOOK` | 開発のみ | `true` で署名なし直結を許可。**本番では設定しない** |

ランダム文字列の生成例: `openssl rand -base64 48`

スクリプトが自動で作成・削除するプロパティ: `PENDING_<送信ID>`（承認待ち・再送待ちの送信内容）、`CURRENT_RICHMENU_ID`。

## 4. スプレッドシート管理メニュー

GAS エディタで関数を選んで実行する必要はありません。スプレッドシート上部の「SKY STANDARD」メニューから操作します。作成・反映手順は [sheet-admin.md](sheet-admin.md)。

初回は、独立GASのスクリプトプロパティに `ADMIN_USERS` を登録してから、次の順で実行してください。

1. 初期設定 → **シート列・設定行の補完**（`SPREADSHEET_ID` の保存、不足列・テンプレートの追加）
2. 初期設定 → **ID・URL設定チェック**（不足キーを確認し、ID管理・スクリプトプロパティを入力）
3. 初期設定 → **LINE接続チェック**
4. システム管理 → **トリガー設定**
5. LINE管理 → **リッチメニュー登録・更新**（URL・画像ID 入力後）

補完で追加される内容（既存データは変更しません）:

- 予約管理: `集合場所`, `注意事項`, `最終イベント日時`
- 顧客管理: `友だち状態`, `最終更新`
- 送信ログ: `冪等キー`, `イベントID`, `再試行回数`
- ID管理: 不足している設定キー行（値は空）
- 通知テンプレート: `BOOKING_CHANGED`, `BOOKING_CANCELLED`, `PAYMENT_COMPLETED`（**有効=OFF**。文面確認後に ON）

> 通知テンプレート `WELCOME` が ON の場合はその本文があいさつに使われます。依頼書のあいさつ文を使う場合は、`WELCOME` の本文を差し替えるか OFF にしてください（OFF ならコード既定の文面を送信）。

## 5. リッチメニュー

1. `assets/richmenu/richmenu.png`（2500×1686, 約0.5MB）を Google ドライブにアップロード。
2. ファイルID（URL の `/d/<ID>/`）を ID管理シートの `RICHMENU_IMAGE_FILE_ID` に入力。
3. 「LINE管理 → リッチメニュー設定確認」で内容を確認し、「リッチメニュー登録・更新」を実行。

| 位置 | ボタン | 動作 |
|---|---|---|
| 上段左 | フライト予約 | `BOOKING_SITE_URL` を開く |
| 上段中 | 予約確認 | LIFF（`LIFF_ID`）または `BOOKING_CONFIRM_URL` を開く |
| 上段右 | プラン一覧 | `PLAN_LIST_URL` を開く |
| 下段左 | チャーター | `CHARTER_URL` を開く |
| 下段中 | お問い合わせ | 「お問い合わせ」を送信 → 種別選択 |
| 下段右 | よくある質問 | 「FAQ」を送信 → FAQ 一覧 |

URL 未設定のボタンは「準備中」を返信する postback として登録され、シート「リッチメニュー」の実装状態に `未設定（準備中表示）` と記録されます。

画像を修正する場合は `assets/richmenu/richmenu.svg` を編集し、`npm run richmenu:render`（要 Playwright）で PNG を再生成します。

## 6. トリガー

「システム管理 → トリガー設定」で、**独立GAS**に以下を作成します（Web アプリ経由。作成済みのものは作らず、重複・旧版の関数名は整理）。トリガーは独立GASの所有者の権限で動作します。仕組みは [sheet-admin.md](sheet-admin.md#トリガー設定の仕組み)。

| 関数 | 頻度 | 内容 |
|---|---|---|
| `triggerFlightReminders` | 毎日 10 時台 | 翌日搭乗・予約確定の予約へ前日案内 |
| `triggerRetryFailedSends` | 10 分おき | 一時エラーの通知を最大 3 回再送 |

ID管理シートの変更は、スプレッドシート側のシンプルトリガー `onEdit` が検知してキャッシュを破棄します（インストール型トリガーは使いません）。
