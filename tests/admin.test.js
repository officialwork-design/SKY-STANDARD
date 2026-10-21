/**
 * 管理機能（ID管理シート・adminRun）のモックテスト。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv, relayEnvelope, reservationEnvelope } = require('./helpers/gas-env');

const TOKEN = 'test-token-SECRET-VALUE';
const USER = 'U' + 'a'.repeat(32);
const ADMIN_LINE = 'U' + 'c'.repeat(32);
const RESV = 'resv-secret';

function lineOk(url) {
  if (url.indexOf('/v2/bot/info') !== -1) return { code: 200, body: { displayName: 'SKY STANDARD', basicId: '@sky' } };
  if (url.indexOf('/webhook/endpoint') !== -1) return { code: 200, body: { endpoint: 'https://relay.example/webhook', active: true } };
  if (url.indexOf('/webhook/test') !== -1) return { code: 200, body: { success: true, statusCode: 200, reason: 'OK' } };
  if (url.indexOf('/message/quota/consumption') !== -1) return { code: 200, body: { totalUsage: 12 } };
  if (url.indexOf('/message/quota') !== -1) return { code: 200, body: { type: 'limited', value: 200 } };
  if (url.indexOf('/user/all/richmenu') !== -1) return { code: 404, body: { message: 'no default' } };
  return { code: 200, body: {} };
}
function env(opts = {}) {
  return createGasEnv(Object.assign({
    props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN, RELAY_SHARED_SECRET: 'r', RESERVATION_WEBHOOK_SECRET: RESV,
      SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, opts.props || {}),
    fetch: opts.fetch || lineOk
  }, opts.env || {}));
}

/* ---------- ID管理シート ---------- */

test('ID・URL は ID管理シートの B列から取得し、変更は再読込で反映', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://booking.example.jp/');
  assert.equal(e.ctx.getUrlSetting_(e.ctx.ID_KEYS.BOOKING_SITE_URL), 'https://booking.example.jp/');
  // シート編集（キャッシュ有効期間中は旧値）
  e.editIdSheet('BOOKING_SITE_URL', 'https://new.example.jp/');
  e.ctx.__settingsCache = null;
  assert.equal(e.ctx.getUrlSetting_(e.ctx.ID_KEYS.BOOKING_SITE_URL), 'https://booking.example.jp/');
  // 管理メニュー「ID管理の変更を反映」／onEdit トリガー
  assert.equal(e.ctx.adminRun('invalidateCache').ok, true);
  assert.equal(e.ctx.getUrlSetting_(e.ctx.ID_KEYS.BOOKING_SITE_URL), 'https://new.example.jp/');
});

test('ID・URL設定チェックはキャッシュを更新し最新値を表示', () => {
  const e = env();
  e.setSetting('LIFF_ID', '1234567890-AbCd');
  e.editIdSheet('LIFF_ID', '9999999999-Zz');
  e.ctx.adminRun('checkIds');
  e.ctx.__settingsCache = null;
  assert.equal(e.ctx.getBookingCheckUrl_(), 'https://liff.line.me/9999999999-Zz');
});

test('旧「LINE設定」シートは参照しない（参照先は ID管理 に統一）', () => {
  const e = env();
  e.sheets['LINE設定'].data[1][1] = 'https://legacy.example.jp/';
  e.ctx.invalidateIdCache_();
  assert.equal(e.ctx.getUrlSetting_(e.ctx.ID_KEYS.BOOKING_SITE_URL), '');
  const r = e.ctx.adminRun('checkIds');
  assert.match(r.message, /【移行が必要】.*予約サイトURL → BOOKING_SITE_URL/);
});

test('秘密情報がシートに入力されていても使わず、危険として表示', () => {
  const e = env({ props: { LINE_CHANNEL_ACCESS_TOKEN: '' } });
  e.setSetting('LINE_CHANNEL_ACCESS_TOKEN', 'sheet-token-should-not-be-used');
  assert.equal(e.ctx.readIdSettings_(true).LINE_CHANNEL_ACCESS_TOKEN, undefined);
  const r = e.ctx.adminRun('checkIds');
  assert.equal(r.ok, false);
  assert.match(r.message, /【危険】.*LINE_CHANNEL_ACCESS_TOKEN/);
  assert.doesNotMatch(r.message, /sheet-token-should-not-be-used/);
  // LINE API はシートの値で呼ばれない
  const res = e.doPost(relayEnvelope({ events: [{ type: 'message', webhookEventId: 'x', replyToken: 'r', source: { userId: USER }, message: { type: 'text', text: '予約' } }] }, 'r'));
  assert.equal(res.ok, true);
  assert.equal(e.fetchCalls.length, 0);
  assert.doesNotMatch(e.logs.join('\n'), /sheet-token-should-not-be-used/);
});

test('形式が正しくない ID・URL は未設定として扱い、日本語で表示', () => {
  const e = env();
  e.setSetting('PLAN_LIST_URL', 'http://insecure.example/');
  e.setSetting('LIFF_ID', 'not a liff');
  e.setSetting('ADMIN_NOTIFY_TARGET', 'someone@example.com');
  assert.equal(e.ctx.getUrlSetting_(e.ctx.ID_KEYS.PLAN_LIST_URL), '');
  const r = e.ctx.adminRun('checkIds');
  assert.match(r.message, /【形式エラー】 PLAN_LIST_URL（プラン一覧ページURL）/);
  assert.match(r.message, /【形式エラー】 LIFF_ID/);
  assert.match(r.message, /【形式エラー】 ADMIN_NOTIFY_TARGET/);
  assert.match(r.message, /【未設定】 CHARTER_URL（チャーターページURL）/);
});

test('設定不足時は不足キーを日本語で表示（LINE ログインチャネルID 未設定で予約確認 API は not_configured）', () => {
  const e = env();
  const cfg = e.ctx.checkConfig_();
  assert.ok(cfg.missing['予約確認(LIFF)'].some((x) => /LINE_LOGIN_CHANNEL_ID（LINEログイン チャネルID・ID管理シート）/.test(x)));
  assert.equal(e.doPost({ kind: 'liff_api', action: 'list', idToken: 't' }).error, 'not_configured');
  assert.ok(e.logs.some((l) => /LINE_LOGIN_CHANNEL_ID/.test(l)));
});

test('LINE_LOGIN_CHANNEL_ID は ID管理から取得し、ID トークン検証に使用', () => {
  const e = env({ fetch: (url, params) => {
    if (url.indexOf('verify') !== -1) {
      assert.equal(params.payload.client_id, '2000000001');
      return { code: 200, body: { iss: 'https://access.line.me', aud: '2000000001', sub: USER, exp: Math.floor(Date.now() / 1000) + 60 } };
    }
    return lineOk(url);
  } });
  e.setSetting('LINE_LOGIN_CHANNEL_ID', '2000000001');
  assert.equal(e.doPost({ kind: 'liff_api', action: 'list', idToken: 't' }).ok, true);
});

test('Web アプリ（SPREADSHEET_ID 未設定・アクティブなし）は日本語エラーで安全に停止', () => {
  const e = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: TOKEN, RELAY_SHARED_SECRET: 'r' }, fetch: lineOk, noActive: true });
  assert.throws(() => e.ctx.getSpreadsheet_(), /SPREADSHEET_ID/);
});

/* ---------- 権限 ---------- */

test('ADMIN_USERS 未登録なら、オーナーを含め誰も管理操作できない（別シートからの乗っ取り防止）', () => {
  const e = env({ props: { ADMIN_USERS: '', SPREADSHEET_ID: '' } });
  const r = e.ctx.adminRun('setupSheets');
  assert.equal(r.denied, true);
  assert.match(r.message, /ADMIN_USERS を追加/);
  assert.equal(e.props.SPREADSHEET_ID, '');
  assert.equal(e.ctx.adminRun('whoami').ok, false);
});

test('ADMIN_USERS 登録後は登録者のみ。権限のない人は通知を送信できない', () => {
  const e = env({ props: { ADMIN_USERS: 'ops@example.com, Lead@Example.com' } });
  e.doPost(reservationEnvelope({ eventId: 'f1', eventType: 'FLIGHT_CHANGE', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R1', lineUserId: USER } }, RESV));
  const sendId = e.rows('送信ログ')[0]['送信ID'];
  e.setUser('owner@example.com'); // オーナーでも ADMIN_USERS 登録後は不可
  assert.equal(e.ctx.adminRun('approve', { sendId }).denied, true);
  e.setUser('intruder@example.com');
  assert.equal(e.ctx.adminRun('approve', { sendId }).denied, true);
  assert.equal(e.linePosts('/push').filter((p) => p.json.to === USER).length, 0);
  e.setUser('lead@example.com');
  const ok = e.ctx.adminRun('approve', { sendId });
  assert.equal(ok.ok, true);
  assert.equal(e.linePosts('/push').filter((p) => p.json.to === USER).length, 1);
});

test('メールアドレスを取得できない実行者は拒否', () => {
  const e = env();
  e.setUser('');
  assert.equal(e.ctx.adminRun('whoami').denied, true);
});

/* ---------- 各操作 ---------- */

test('シート補完: SPREADSHEET_ID を起動用プロパティに保存し、既存データを保持', () => {
  const e = env({ props: { SPREADSHEET_ID: '' } });
  const faq = JSON.stringify(e.sheets['FAQ'].data);
  const id = JSON.stringify(e.sheets['ID管理'].data);
  const r = e.ctx.adminRun('setupSheets');
  assert.equal(r.ok, true);
  assert.match(r.message, /SPREADSHEET_ID（起動用）をスクリプトプロパティに保存しました/);
  assert.equal(e.props.SPREADSHEET_ID, '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es');
  assert.equal(JSON.stringify(e.sheets['FAQ'].data), faq);
  assert.equal(JSON.stringify(e.sheets['ID管理'].data), id);
});

test('シート補完: ID管理に不足キーがあれば行を追加（既存行は変更しない）', () => {
  const e = env();
  const d = e.sheets['ID管理'].data;
  for (let i = d.length - 1; i >= 0; i--) if (d[i][0] === 'CHARTER_URL' || d[i][0] === 'RESERVATION_API_KEY') d.splice(i, 1);
  const before = e.sheets['ID管理'].data.map((r) => r.slice());
  e.ctx.adminRun('setupSheets');
  const after = e.sheets['ID管理'].data;
  before.forEach((r, i) => assert.deepEqual(after[i], r));
  const added = after.slice(before.length).map((r) => r[0]);
  assert.deepEqual(added.sort(), ['CHARTER_URL', 'RESERVATION_API_KEY']);
  assert.equal(after.find((r) => r[0] === 'RESERVATION_API_KEY')[2], '秘密情報');
});

test('シート補完: シートが無くても作成しない', () => {
  const e = env();
  delete e.sheets['実装タスク'];
  const r = e.ctx.adminRun('setupSheets');
  assert.equal(r.ok, false);
  assert.match(r.message, /見つかりません（自動作成はしません）：実装タスク/);
  assert.equal(e.sheets['実装タスク'], undefined);
});

test('LINE接続チェック: トークン未設定なら安全に停止し不足キーを表示', () => {
  const e = env({ props: { LINE_CHANNEL_ACCESS_TOKEN: '' } });
  const r = e.ctx.adminRun('checkLine');
  assert.equal(r.ok, false);
  assert.match(r.message, /LINE_CHANNEL_ACCESS_TOKEN/);
  assert.equal(e.fetchCalls.length, 0);
});

test('LINE接続チェック（relay モード）: Bot 情報・Webhook・疎通テスト', () => {
  const e = env({ props: { WEBHOOK_MODE: 'relay' }, fetch: (url) => {
    if (url.indexOf('/webhook/test') !== -1) {
      e.props.LAST_WEBHOOK_AT = String(Date.now() + 1); // リレー経由で GAS が受信した状態を模擬
      return { code: 200, body: { success: true, statusCode: 200, reason: 'OK' } };
    }
    return lineOk(url);
  } });
  const r = e.ctx.adminRun('checkLine', { testWebhook: true });
  assert.equal(r.ok, true);
  assert.match(r.message, /SKY STANDARD/);
  assert.match(r.message, /リレー経由/);
  assert.match(r.message, /Webhook URL: https:\/\/relay\.example\/webhook/);
  assert.match(r.message, /LINE 側の疎通テスト結果: 成功/);
  assert.match(r.message, /GAS 側の受信記録: テスト中に受信を確認/);
  assert.doesNotMatch(r.message, new RegExp(TOKEN));
});

test('LINE接続チェック: トークン無効（401）は日本語ヒント', () => {
  const e = env({ fetch: () => ({ code: 401, body: { message: 'Authentication failed' } }) });
  const r = e.ctx.adminRun('checkLine');
  assert.equal(r.ok, false);
  assert.match(r.message, /チャネルアクセストークンが無効/);
});

test('リッチメニュー設定確認・登録（画像ID 未設定なら安全に停止）', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://booking.example.jp/');
  const c = e.ctx.adminRun('richMenuCheck');
  assert.match(c.message, /【OK】フライト予約 → https:\/\/booking\.example\.jp\//);
  assert.match(c.message, /【未設定】プラン一覧 → 準備中/);
  assert.match(c.message, /既定リッチメニュー: 未登録/);
  const d = e.ctx.adminRun('richMenuDeploy');
  assert.equal(d.ok, false);
  assert.match(d.message, /RICHMENU_IMAGE_FILE_ID/);
  assert.equal(e.linePosts('/v2/bot/richmenu').filter((p) => p.params.method === 'post').length, 0);
});

test('配信数確認', () => {
  const r = env().ctx.adminRun('quota');
  assert.match(r.message, /今月の配信数: 12 通/);
  assert.match(r.message, /残り: 188 通/);
});

test('承認待ち通知: 確認情報 → 承認 → 二重承認は不可（二重送信なし）', () => {
  const e = env();
  e.doPost(reservationEnvelope({ eventId: 'f9', eventType: 'FLIGHT_CHANGE', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R9', lineUserId: USER } }, RESV));
  const sendId = e.rows('送信ログ')[0]['送信ID'];
  const info = e.ctx.adminRun('sendInfo', { sendId });
  assert.equal(info.data.pending, true);
  assert.match(info.message, /運航に関する重要なお知らせ/);
  assert.equal(e.ctx.adminRun('approve', { sendId }).ok, true);
  const again = e.ctx.adminRun('approve', { sendId });
  assert.equal(again.ok, false);
  assert.match(again.message, /承認待ちではありません/);
  assert.equal(e.ctx.adminRun('reject', { sendId }).ok, false);
  assert.equal(e.linePosts('/push').filter((p) => p.json.to === USER).length, 1);
});

test('却下した通知は送信されず、後から承認もできない', () => {
  const e = env();
  e.doPost(reservationEnvelope({ eventId: 'f10', eventType: 'FLIGHT_CHANGE', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R10', lineUserId: USER } }, RESV));
  const sendId = e.rows('送信ログ')[0]['送信ID'];
  assert.equal(e.ctx.adminRun('reject', { sendId }).ok, true);
  assert.equal(e.ctx.adminRun('approve', { sendId }).ok, false);
  assert.equal(e.linePosts('/push').filter((p) => p.json.to === USER).length, 0);
});

test('失敗した通知の再送: 件数確認 → 再送 → 再実行しても二重送信しない', () => {
  let fail = true;
  const e = env({ fetch: (url) => (url.indexOf('/push') !== -1 && fail ? { code: 503, body: {} } : lineOk(url)) });
  e.doPost(reservationEnvelope({ eventId: 'b1', eventType: 'BOOKING_CONFIRMED', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R11', lineUserId: USER } }, RESV));
  assert.equal(e.ctx.adminRun('retryCount').data.count, 1);
  fail = false;
  const r = e.ctx.adminRun('retry');
  assert.match(r.message, /成功: 1 件/);
  assert.equal(e.ctx.adminRun('retryCount').data.count, 0);
  e.ctx.adminRun('retry');
  const ok = e.linePosts('/push').filter((p) => p.json.to === USER);
  assert.equal(new Set(ok.map((p) => p.params.headers['X-Line-Retry-Key'])).size, 1);
  assert.equal(e.rows('送信ログ').filter((x) => x['結果'] === '成功').length, 1);
});

test('通知テンプレート確認: ON/OFF・未登録・未知の変数を表示', () => {
  const e = env();
  e.sheets['通知テンプレート'].data[2][3] = '受付 {{予約ID}} {{お名前}}';
  const r = e.ctx.adminRun('templates');
  assert.match(r.message, /【ON 】WELCOME/);
  assert.match(r.message, /使用できない変数: お名前/);
  assert.match(r.message, /【未登録】BOOKING_CHANGED、BOOKING_CANCELLED、PAYMENT_COMPLETED/);
});

test('接続・設定診断: 不足設定・トリガー未記録を表示（秘密値は出さない）', () => {
  const e = env();
  const r = e.ctx.adminRun('diagnose');
  assert.match(r.message, /【OK】必要な 11 シートあり/);
  assert.match(r.message, /状況が未記録です/);
  assert.match(r.message, /【不足】予約確認\(LIFF\)/);
  assert.doesNotMatch(r.message, new RegExp(TOKEN));
});

/* ---------- トリガー（独立GAS側） ---------- */

test('トリガー: 管理者の要求がない限り、Web アプリへの無認証アクセスでは作成しない', () => {
  const e = env();
  const out = JSON.parse(e.ctx.doGet({ parameter: { sync: 'triggers' } }).getContent());
  assert.equal(out.installed, false);
  assert.equal(e.triggers.length, 0);
});

test('トリガー: 管理者が要求 → Web アプリが独立GASに作成。再実行しても重複しない', () => {
  const e = env();
  e.setSetting('GAS_WEBAPP_URL', 'https://script.google.com/macros/s/AKfy123/exec');
  const req = e.ctx.adminRun('requestTriggerSync');
  assert.equal(req.data.webAppUrl, 'https://script.google.com/macros/s/AKfy123/exec');
  let out = JSON.parse(e.ctx.doGet({ parameter: { sync: 'triggers' } }).getContent());
  assert.equal(out.installed, true);
  e.ctx.adminRun('requestTriggerSync');
  e.ctx.doGet({ parameter: { sync: 'triggers' } });
  assert.deepEqual(e.triggers.map((t) => t.getHandlerFunction()).sort(), ['triggerFlightReminders', 'triggerRetryFailedSends']);
  // 要求は1回限り
  out = JSON.parse(e.ctx.doGet({ parameter: { sync: 'triggers' } }).getContent());
  assert.equal(out.installed, false);
  const st = e.ctx.adminRun('triggerStatus');
  assert.equal(st.ok, true);
  assert.match(st.message, /【OK】搭乗前日リマインド/);
});

test('トリガー: 権限のない人は作成要求できない', () => {
  const e = env();
  e.setUser('intruder@example.com');
  assert.equal(e.ctx.adminRun('requestTriggerSync').denied, true);
  e.ctx.doGet({ parameter: { sync: 'triggers' } });
  assert.equal(e.triggers.length, 0);
});

test('トリガー: 旧版の関数名・重複トリガーは整理', () => {
  const e = env();
  e.triggers.push({ getHandlerFunction: () => 'retryFailedSends' }, { getHandlerFunction: () => 'triggerRetryFailedSends' },
    { getHandlerFunction: () => 'triggerRetryFailedSends' });
  e.ctx.adminRun('requestTriggerSync');
  e.ctx.doGet({ parameter: { sync: 'triggers' } });
  assert.deepEqual(e.triggers.map((t) => t.getHandlerFunction()).sort(), ['triggerFlightReminders', 'triggerRetryFailedSends']);
});

test('トリガー実行で最終実行時刻を記録', () => {
  const e = env();
  e.ctx.triggerRetryFailedSends();
  e.ctx.adminRun('requestTriggerSync');
  e.ctx.doGet({ parameter: { sync: 'triggers' } });
  assert.match(e.ctx.adminRun('triggerStatus').message, /失敗した通知の再送（10分おき） … 最終実行/);
});

test('ライブラリとして公開される関数は限定（業務処理は非公開 _ ）', () => {
  const e = env();
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'gas');
  const publicFns = fs.readdirSync(dir).filter((f) => f.endsWith('.gs'))
    .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^function ([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]))
    .filter((n) => !n.endsWith('_') && !/Error$/.test(n));
  assert.deepEqual(publicFns.sort(), ['adminRun', 'doGet', 'doPost', 'installTriggers', 'invalidateIdCacheFromEdit',
    'triggerFlightReminders', 'triggerRetryFailedSends'].sort());
});

test('予約システム API キーは許可ホスト以外に送らない（ID管理の URL 改ざん対策）', () => {
  const e = env({ props: { RESERVATION_API_KEY: 'api-key-SECRET', RESERVATION_API_ALLOWED_HOST: 'api.booking.example.jp', LINE_LOGIN_CHANNEL_ID: '2000000001' },
    fetch: (url) => {
      if (url.indexOf('verify') !== -1) return { code: 200, body: { iss: 'https://access.line.me', aud: '2000000001', sub: USER, exp: Math.floor(Date.now() / 1000) + 60 } };
      return lineOk(url);
    } });
  e.setSetting('RESERVATION_API_BASE_URL', 'https://attacker.example.com');
  const r = e.doPost({ kind: 'liff_api', action: 'list', idToken: 't' });
  assert.equal(r.error, 'not_configured');
  assert.equal(e.fetchCalls.filter((c) => c.url.indexOf('attacker') !== -1).length, 0);
  assert.ok(e.logs.some((l) => /RESERVATION_API_ALLOWED_HOST/.test(l)));
});

test('処理中のまま24時間近く経過した通知は自動再送せず失敗にする', () => {
  const e = env();
  e.doPost(reservationEnvelope({ eventId: 'old', eventType: 'BOOKING_CONFIRMED', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R50', lineUserId: USER } }, RESV));
  const d = e.sheets['送信ログ'].data;
  const h = d[0];
  d[1][h.indexOf('結果')] = '処理中';
  d[1][h.indexOf('送信日時')] = e.ctx.Utilities.formatDate(new Date(Date.now() - 23.5 * 3600 * 1000), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const before = e.linePosts('/push').length;
  const r = e.ctx.adminRun('retry');
  assert.match(r.message, /24時間近く経過した 1 件/);
  assert.equal(e.rows('送信ログ')[0]['結果'], '失敗');
  assert.equal(e.linePosts('/push').filter((p) => p.json.to === USER).length, before === 0 ? 0 : 1);
});

test('不明な操作・例外は日本語のエラー結果で返る（画面表示用）', () => {
  const e = env();
  assert.equal(e.ctx.adminRun('dropAllData').ok, false);
  const r = e.ctx.adminRun('approve', { sendId: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.message, /送信IDが見つかりません/);
});

test('Web アプリ経由では管理操作を実行できない', () => {
  const e = env();
  assert.equal(e.doPost({ kind: 'admin', action: 'setupSheets' }).error, 'unknown_kind');
  assert.equal(e.doPost({ kind: 'adminRun', action: 'approve' }).error, 'unknown_kind');
});

test('既存の Webhook 処理は維持（ID管理の URL で応答）', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://booking.example.jp/');
  e.doPost(relayEnvelope({ events: [{ type: 'message', webhookEventId: 'w1', replyToken: 'r', source: { userId: USER }, message: { type: 'text', text: '予約' } }] }, 'r'));
  const reply = e.linePosts('/reply')[0].json;
  assert.equal(reply.messages[0].template.actions[0].uri, 'https://booking.example.jp/');
});

test('運営通知先は ID管理の ADMIN_NOTIFY_TARGET（複数可）', () => {
  const e = env();
  e.setSetting('ADMIN_NOTIFY_TARGET', ADMIN_LINE + ',' + 'C' + 'd'.repeat(32));
  e.ctx.notifyAdmin_('t', 'b');
  assert.deepEqual(e.linePosts('/push').map((p) => p.json.to), [ADMIN_LINE, 'C' + 'd'.repeat(32)]);
});
