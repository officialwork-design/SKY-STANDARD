/**
 * エラーログ（「エラーログ」シート）のモックテスト。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv, relayEnvelope, reservationEnvelope, fakeImage } = require('./helpers/gas-env');

const TOKEN = 'tok-SECRET-abcdefghijklmnop';
const USER = 'U' + 'a'.repeat(32);
const BOT = 'U' + 'f'.repeat(32);
const SHEET = 'エラーログ';

function env(opts = {}) {
  return createGasEnv(Object.assign({
    props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN, RELAY_SHARED_SECRET: 'r', RESERVATION_WEBHOOK_SECRET: 'resv',
      SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, opts.props || {}),
    fetch: opts.fetch || (() => ({ code: 200, body: {} }))
  }, opts.env || {}));
}
const errRows = (e) => (e.sheets[SHEET] ? e.rows(SHEET) : []);

test('logError_ で「エラーログ」シートを作成し、8項目を記録（ヘッダー固定・フィルター・色分け・選択肢）', () => {
  const e = env();
  assert.equal(e.sheets[SHEET], undefined);
  e.ctx.logError_('notify.push_failed', new Error('LINE API error 500: boom'), { sendId: 'SND-1', type: 'BOOKING_CONFIRMED' });
  const sh = e.sheets[SHEET];
  assert.deepEqual([...sh.data[0]], ['発生日時', '重要度', '発生元', '関数名', 'エラーメッセージ', 'エラー詳細・スタックトレース', '関連ID', '対応状況']);
  const r = errRows(e)[0];
  assert.match(r['発生日時'], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(r['重要度'], 'ERROR');
  assert.equal(r['発生元'], '通知');
  assert.ok(r['関数名']);
  assert.equal(r['エラーメッセージ'], 'LINE API error 500: boom');
  assert.match(r['エラー詳細・スタックトレース'], /コード: notify\.push_failed/);
  assert.match(r['エラー詳細・スタックトレース'], /スタック:/);
  assert.equal(r['関連ID'], 'sendId:SND-1');
  assert.equal(r['対応状況'], '未対応');
  assert.equal(sh.fmt.frozenRows, 1);
  assert.ok(sh.fmt.filter);
  assert.deepEqual(sh.fmt.rules.map((x) => x.formula), ['=$B2="FATAL"', '=$B2="ERROR"']);
  assert.ok(sh.fmt.validations.some((v) => v.col === 8 && v.v.list.includes('未対応')));
});

test('既存の呼び出し形式（3引数・2引数・Error 以外）と互換', () => {
  const e = env();
  e.ctx.logError_('faq.read', new Error('a'));
  e.ctx.logError_('template.read', 'string error');
  e.ctx.logError_('idsheet.read', { message: 'obj' }, null);
  assert.equal(errRows(e).length, 3);
  assert.equal(errRows(e)[1]['エラーメッセージ'], 'string error');
});

test('INFO・WARN・正常な Webhook 受信・正常な LINE 送信は記録しない', () => {
  const e = env();
  e.ctx.logInfo_('x', {});
  e.ctx.logWarn_('y', {});
  e.doPost(relayEnvelope({ destination: BOT, events: [{ type: 'message', webhookEventId: 'w1', replyToken: 'rt', source: { type: 'user', userId: USER }, message: { type: 'text', text: '予約' } }] }, 'r'));
  e.doPost({ destination: BOT, events: [] });
  e.doPost(reservationEnvelope({ eventId: 'e1', eventType: 'BOOKING_CONFIRMED', occurredAt: new Date().toISOString(), reservation: { reservationId: 'R1', lineUserId: USER } }, 'resv'));
  assert.ok(e.linePosts('/push').length >= 1);
  assert.equal(errRows(e).length, 0);
  assert.equal(e.sheets[SHEET], undefined); // エラーがなければシートも作らない
});

test('同一エラーは短時間に1件だけ。異なるエラーは記録し、期間後の再発は抑制件数付きで記録', () => {
  const e = env();
  for (let i = 0; i < 5; i++) e.ctx.logError_('notify.push_failed', new Error('LINE API error 500: id ' + i), { sendId: 'S' + i });
  e.ctx.logError_('notify.push_failed', new Error('LINE API error 400: invalid'));
  e.ctx.logError_('faq.read', new Error('LINE API error 500: id 1'));
  assert.equal(errRows(e).length, 3);
  // 抑制期間の終了を模擬（記録済みキーのみ削除。抑制件数は残る）
  for (const k of [...e.cache.keys()]) if (/^errlog:/.test(k) && !/:n$/.test(k)) e.cache.delete(k);
  e.ctx.logError_('notify.push_failed', new Error('LINE API error 500: id 9'));
  const rows = errRows(e);
  assert.equal(rows.length, 4);
  assert.match(rows[3]['エラー詳細・スタックトレース'], /直前の同一エラー 4 件は重複のため記録を省略/);
});

test('FATAL：処理全体の失敗（doPost 例外・トリガー失敗）。FATAL の抑制は1分', () => {
  const e = env();
  e.ctx.logError_('doPost.unhandled', new Error('x'));
  e.ctx.logError_('inquiry.save_failed_after_reply', new Error('y'), { id: 'INQ-20261021-0001' });
  e.ctx.logError_('admin.action_failed', new Error('z'), { action: 'quota' }, { severity: 'FATAL' });
  const rows = errRows(e);
  assert.deepEqual(rows.map((r) => r['重要度']), ['FATAL', 'FATAL', 'FATAL']);
  assert.equal(rows[1]['関連ID'], 'id:INQ-20261021-0001');
  assert.equal(e.ctx.ERROR_LOG.DEDUP_SEC.FATAL, 60);
});

test('機密情報（トークン・メール・電話・LINE ユーザーID・本文・JWT）を記録しない', () => {
  const e = env();
  const err = new Error('Request failed for https://api.line.me/v2/bot/profile/' + USER + '?lineUserId=' + USER +
    '&token=abc123 with Bearer ' + TOKEN + ' mail taro@example.com tel 090-1234-5678 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig');
  e.ctx.logError_('webhook.event_failed', err, { userId: USER, text: '私の住所は東京都…', message: '本文', to: USER, type: 'message' });
  const all = JSON.stringify(e.sheets[SHEET].data);
  for (const bad of [TOKEN, USER, 'taro@example.com', '090-1234-5678', '東京都', '本文', 'abc123', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.ok(!all.includes(bad), '含まれてはいけない: ' + bad);
  }
  assert.match(all, /Bearer \[REDACTED\]/);
  assert.match(all, /\[EMAIL\]/);
  assert.match(all, /\[PHONE\]/);
  assert.equal(errRows(e)[0]['関連ID'], 'type:message');
});

test('ID・日付・時刻は電話番号として誤ってマスクしない', () => {
  const e = env();
  const s = e.ctx.sanitizeErrorText_('INQ-20261021-0001 at 2026-10-21 14:56:01 file 02_LineApi:67:11');
  assert.equal(s, 'INQ-20261021-0001 at 2026-10-21 14:56:01 file 02_LineApi:67:11');
});

test('ログ書き込みに失敗しても例外を出さず、Webhook は HTTP 200（HtmlService）を返す', () => {
  const e = env({ env: { failInsert: true }, fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 500, body: {} } : { code: 200, body: {} }) });
  assert.doesNotThrow(() => e.ctx.logError_('faq.read', new Error('x')));
  const ulid = () => crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26);
  const out = e.doPost({ destination: BOT, events: [{ type: 'message', webhookEventId: ulid(), timestamp: Date.now(), replyToken: crypto.randomBytes(16).toString('hex'),
    source: { type: 'user', userId: USER }, message: { type: 'text', text: '予約' } }] });
  assert.equal(out.__html, true);
  assert.ok(e.logs.some((l) => /errorlog\.write_failed/.test(l)));
});

test('Webhook のエラー（LINE API 5xx）は記録、偽造イベントの応答拒否（400）は記録しない', () => {
  const ulid = () => crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26);
  const ev = () => ({ type: 'message', webhookEventId: ulid(), timestamp: Date.now(), replyToken: crypto.randomBytes(16).toString('hex'),
    source: { type: 'user', userId: USER }, message: { type: 'text', text: '予約' } });
  const e400 = env({ fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 400, body: { message: 'Invalid reply token' } } : { code: 200, body: {} }) });
  e400.doPost({ destination: BOT, events: [ev()] });
  assert.equal(errRows(e400).length, 0);
  const e500 = env({ fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 500, body: { message: 'Internal' } } : { code: 200, body: {} }) });
  e500.doPost({ destination: BOT, events: [ev()] });
  const rows = errRows(e500);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['発生元'], 'Webhook');
  assert.match(rows[0]['エラーメッセージ'], /LINE API error 500/);
  assert.match(rows[0]['エラー詳細・スタックトレース'], /HTTP ステータス: 500/);
});

test('通知の LINE 送信失敗は記録（通知）', () => {
  const e = env({ fetch: (url) => (url.indexOf('/push') !== -1 ? { code: 500, body: {} } : { code: 200, body: {} }) });
  e.doPost(reservationEnvelope({ eventId: 'e2', eventType: 'BOOKING_CONFIRMED', occurredAt: new Date().toISOString(), reservation: { reservationId: 'R2', lineUserId: USER } }, 'resv'));
  const r = errRows(e);
  assert.equal(r.length, 1);
  assert.equal(r[0]['発生元'], '通知');
  assert.match(r[0]['関連ID'], /^sendId:SND-/);
});

test('予約 API・LIFF の想定外エラー（doPost 例外）は FATAL', () => {
  const e = env({ props: { RESERVATION_API_KEY: 'k', RESERVATION_API_ALLOWED_HOST: 'api.example.jp', LINE_LOGIN_CHANNEL_ID: '2000000001' },
    fetch: (url) => {
      if (url.indexOf('verify') !== -1) return { code: 200, body: { iss: 'https://access.line.me', aud: '2000000001', sub: USER, exp: Math.floor(Date.now() / 1000) + 60 } };
      if (url.indexOf('/line/reservations') !== -1) return { code: 503, body: {} };
      return { code: 200, body: {} };
    } });
  e.setSetting('RESERVATION_API_BASE_URL', 'https://api.example.jp');
  assert.equal(e.doPost({ kind: 'liff_api', action: 'list', idToken: 't' }).error, 'internal_error');
  const r = errRows(e)[0];
  assert.equal(r['重要度'], 'FATAL');
  assert.equal(r['発生元'], 'Webhook');
  assert.match(r['エラーメッセージ'], /reservation_api_unavailable_503/);
  assert.equal(r['関連ID'], 'kind:liff_api');
});

test('トリガー処理の失敗は FATAL で記録し、実行履歴にも失敗として残す（再スロー）', () => {
  const e = env();
  delete e.sheets['送信ログ'];
  assert.throws(() => e.ctx.triggerRetryFailedSends(), /送信ログ/);
  const r = errRows(e)[0];
  assert.equal(r['重要度'], 'FATAL');
  assert.equal(r['発生元'], 'トリガー');
  assert.equal(r['関連ID'], 'action:triggerRetryFailedSends');
});

test('リッチメニュー作成途中の削除失敗（従来は握りつぶし）を記録', () => {
  const e = env({ fetch: (url, p) => {
    if (/\/v2\/bot\/richmenu$/.test(url)) return { code: 200, body: { richMenuId: 'richmenu-123' } };
    if (/\/v2\/bot\/richmenu\/richmenu-123$/.test(url) && p.method === 'delete') return { code: 500, body: {} };
    if (/\/v2\/bot\/user\/all\/richmenu$/.test(url)) return { code: 404, body: {} };
    if (/\/content$/.test(url)) return { code: 500, body: {} }; // 画像アップロード失敗
    return { code: 200, body: {} };
  }, env: { driveFiles: { ['a'.repeat(30)]: { name: 'menu.jpg', contentType: 'image/jpeg', bytes: fakeImage('jpeg', 1543, 1019) } } } });
  e.setSetting('RICHMENU_IMAGE_FILE_ID', 'a'.repeat(30));
  const res = e.ctx.adminRun('richMenuDeploy'); // 画像アップロード失敗 → 作成したメニューを削除 → 削除も失敗
  assert.equal(res.ok, false);
  const rows = errRows(e);
  assert.ok(rows.some((r) => r['発生元'] === 'LINE API' && r['関連ID'] === 'id:richmenu-123'));
  assert.ok(rows.some((r) => r['発生元'] === '管理メニュー' && r['関連ID'] === 'action:richMenuDeploy'));
});

test('管理メニュー：設定確認はテスト行を書かず、テストは明示実行で1件だけ記録', () => {
  const e = env();
  const st = e.ctx.adminRun('errorLogStatus');
  assert.equal(st.ok, true);
  assert.match(st.message, /【作成】エラーログシートを新規作成しました/);
  assert.match(st.message, /過去のエラーは自動取得できません/);
  assert.equal(errRows(e).length, 0);
  const t = e.ctx.adminRun('errorLogTest');
  assert.equal(t.ok, true);
  const rows = errRows(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['発生元'], '管理メニュー（動作確認）');
  assert.equal(rows[0]['関数名'], 'adminErrorLogTest_');
  e.ctx.adminRun('errorLogTest'); // 重複抑制の対象外（明示実行のたびに1件）
  assert.equal(errRows(e).length, 2);
  // 権限のない人は実行できない
  e.setUser('intruder@example.com');
  assert.equal(e.ctx.adminRun('errorLogTest').denied, true);
  assert.equal(errRows(e).length, 2);
});

test('設定確認は既存のエラーログ行・他シートを変更しない（何度実行しても同じ）', () => {
  const e = env();
  e.ctx.logError_('faq.read', new Error('x'));
  e.sheets[SHEET].data[1][7] = '対応済み';
  const snapshot = JSON.stringify(Object.fromEntries(Object.entries(e.sheets).map(([k, v]) => [k, v.data])));
  e.ctx.adminRun('errorLogStatus');
  e.ctx.adminRun('errorLogStatus');
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(e.sheets).map(([k, v]) => [k, v.data]))), snapshot);
  assert.equal(e.sheets[SHEET].fmt.rules.length, 2); // 色分けルールが重複しない
});

test('シート補完でエラーログシートを作成。診断にエラーログの件数を表示', () => {
  const e = env();
  const r = e.ctx.adminRun('setupSheets');
  assert.match(r.message, /エラーログシート：新規作成しました/);
  e.ctx.logError_('doPost.unhandled', new Error('x'));
  const d = e.ctx.adminRun('diagnose');
  assert.match(d.message, /◆ エラーログ\n【要対応】未対応 1 件（うち FATAL 1 件）/);
});

test('通常運用ではテストエラーを自動生成しない（コード上の呼び出しは管理メニューのみ）', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'gas');
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.gs'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => /adminErrorLogTest_\(/.test(l)).map((l) => f + ': ' + l.trim()));
  assert.deepEqual(hits.map((h) => h.split(':')[0]).sort(), ['11_Admin.gs', '11_Admin.gs']); // 定義と ADMIN_ACTIONS の1か所のみ
});

/* ---------- レビュー指摘への回帰テスト ---------- */

test('書式は行数を限定しない列範囲（追加行も色分け・フィルター・選択肢の対象）', () => {
  const e = env();
  e.ctx.adminRun('errorLogStatus');
  const f = e.sheets[SHEET].fmt;
  assert.equal(f.filter.nr, 1000); // 'A1:H'（モックでは列範囲を1000行として扱う）
  assert.equal(f.rules[0].ranges[0].__range.row, 2);
  assert.ok(f.validations.some((v) => v.col === 8));
});

test('シートへの書き込みに失敗した同一エラーは抑制せず、次回に記録する', () => {
  const e = env({ env: { failInsert: true } });
  e.ctx.logError_('faq.read', new Error('x'));
  assert.equal(e.sheets[SHEET], undefined);
  assert.ok(![...e.cache.keys()].some((k) => /^errlog:[0-9a-f]+$/.test(k)));
});

test('直接受信の 400 でも「Invalid reply token」以外（自前の不正メッセージ等）はエラーとして記録', () => {
  const crypto2 = require('crypto');
  const e = env({ fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 400, body: { message: 'The request body has 1 error(s)', details: [{ property: 'messages[0].text', message: 'May not be empty' }] } } : { code: 200, body: {} }) });
  e.doPost({ destination: BOT, events: [{ type: 'message', webhookEventId: crypto2.randomBytes(13).toString('hex').toUpperCase().slice(0, 26), timestamp: Date.now(),
    replyToken: crypto2.randomBytes(16).toString('hex'), source: { type: 'user', userId: USER }, message: { type: 'text', text: '予約' } }] });
  assert.equal(errRows(e).length, 1);
  assert.match(errRows(e)[0]['エラーメッセージ'], /May not be empty/);
});

test('設定確認を再実行しても既存のフィルター（絞り込み条件）は作り直さない', () => {
  const e = env();
  e.ctx.adminRun('errorLogStatus');
  const f1 = e.sheets[SHEET].fmt.filter;
  f1.userCriteria = 'FATAL のみ';
  e.ctx.adminRun('errorLogStatus');
  assert.equal(e.sheets[SHEET].fmt.filter.userCriteria, 'FATAL のみ');
});
