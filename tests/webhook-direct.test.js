/**
 * GAS単体（direct）Webhook 受信のモックテスト。
 * 実際の LINE プラットフォームからの受信（HTTP ステータス・到達）はここでは検証できない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv, reservationEnvelope } = require('./helpers/gas-env');

const TOKEN = 'token-SECRET';
const BOT = 'U' + 'f'.repeat(32);
const USER = 'U' + 'a'.repeat(32);
const VICTIM = 'U' + 'b'.repeat(32);
const ADMIN = 'U' + 'c'.repeat(32);
const GOOD_TOKENS = new Set();

let seq = 0;
function ulid() { return crypto.randomBytes(13).toString('hex').toUpperCase().replace(/[^0-9A-Z]/g, 'A').slice(0, 26); }
function token(valid = true) {
  const t = crypto.randomBytes(16).toString('hex');
  if (valid) GOOD_TOKENS.add(t);
  return t;
}
/** LINE の reply API を模擬：LINE が発行した（GOOD_TOKENS にある）応答トークンのみ受理 */
function lineMock(extra) {
  return (url, params) => {
    if (extra) { const r = extra(url, params); if (r) return r; }
    if (url.indexOf('/v2/bot/message/reply') !== -1) {
      const t = JSON.parse(params.payload).replyToken;
      if (!GOOD_TOKENS.has(t)) return { code: 400, body: { message: 'Invalid reply token' } };
      GOOD_TOKENS.delete(t);
      return { code: 200, body: {} };
    }
    if (url.indexOf('/v2/bot/profile/') !== -1) return { code: 200, body: { displayName: 'テスト', language: 'ja' } };
    return { code: 200, body: {} };
  };
}
function env(opts = {}) {
  const e = createGasEnv({ props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN, RESERVATION_WEBHOOK_SECRET: 'resv',
    SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, opts.props || {}),
  fetch: lineMock(opts.extra) });
  e.setSetting('ADMIN_NOTIFY_TARGET', ADMIN);
  return e;
}
function ev(type, fields = {}, validToken = true) {
  seq++;
  const base = { type, webhookEventId: ulid(), timestamp: Date.now(), mode: 'active',
    source: { type: 'user', userId: fields.userId || USER }, deliveryContext: { isRedelivery: false } };
  if (type !== 'unfollow') base.replyToken = token(validToken);
  delete fields.userId;
  return Object.assign(base, fields);
}
const text = (t, o = {}, valid = true) => ev('message', Object.assign({ message: { type: 'text', id: String(seq), text: t } }, o), valid);
const postback = (d, o = {}, valid = true) => ev('postback', Object.assign({ postback: { data: d } }, o), valid);
function post(e, events, destination = BOT) {
  return e.doPost({ destination, events: [].concat(events) });
}

test('直接 Webhook は常に HTTP 200 用の HtmlService で応答（LINE の「検証」= 空イベント）', () => {
  const e = env();
  const out = post(e, []);
  assert.equal(out.__html, true);
  assert.ok(Number(e.props.LAST_WEBHOOK_AT) > 0);
});

test('既定（WEBHOOK_MODE 未設定）は GAS単体で受信し、Cloud Run の設定は不要', () => {
  const e = env();
  post(e, text('予約'));
  assert.equal(e.linePosts('/reply').length, 1);
  const cfg = e.ctx.checkConfig_();
  assert.ok(!Object.keys(cfg.missing).some((k) => /Webhook|リレー/.test(k)));
  assert.ok(cfg.warnings.some((w) => /署名（X-Line-Signature）を検証できません/.test(w)));
});

test('正しい応答トークンの友だち追加：あいさつ送信後に顧客登録', () => {
  const e = env();
  post(e, ev('follow'));
  assert.equal(e.rows('顧客管理').length, 1);
  assert.equal(e.rows('顧客管理')[0]['LINEユーザーID'], USER);
});

test('偽造された友だち追加（応答トークン無効）では顧客登録しない', () => {
  const e = env();
  post(e, ev('follow', { userId: VICTIM }, false));
  assert.equal(e.rows('顧客管理').length, 0);
});

test('偽造 unfollow：プロフィール API で友だちと確認できればブロック扱いにしない', () => {
  const e = env();
  post(e, ev('follow'));
  post(e, ev('unfollow'));
  assert.equal(e.rows('顧客管理')[0]['友だち状態'], '友だち');
  assert.equal(e.ctx.isPushAllowed_(USER), true);
});

test('本物の unfollow（プロフィール API が 404）はブロックとして反映', () => {
  let blocked = false;
  const e = env({ extra: (url) => (blocked && url.indexOf('/v2/bot/profile/') !== -1 ? { code: 404, body: { message: 'Not found' } } : null) });
  post(e, ev('follow'));
  blocked = true;
  post(e, ev('unfollow'));
  assert.equal(e.rows('顧客管理')[0]['友だち状態'], 'ブロック');
});

test('問い合わせ：本物のイベントは応答後に保存・運営通知', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=4'));
  post(e, text('12/1 4名 見積希望'));
  const rows = e.rows('問い合わせ管理');
  assert.equal(rows.length, 1);
  assert.match(rows[0]['備考'], /署名未検証/);
  assert.ok(e.linePosts('/push').some((p) => p.json.to === ADMIN));
});

test('偽造イベントでは問い合わせ保存・運営通知・入力状態の変更をしない', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=5', { userId: VICTIM }, false));
  assert.equal(e.ctx.getInquiryState_(VICTIM), null);
  e.ctx.setInquiryState_(VICTIM, { c: '5' }); // 仮に入力待ちだったとしても
  post(e, text('なりすまし本文', { userId: VICTIM }, false));
  assert.equal(e.rows('問い合わせ管理').length, 0);
  assert.equal(e.linePosts('/push').length, 0);
});

test('偽造テキストで他人の「担当者に送る」内容を差し替えられない', () => {
  const e = env();
  post(e, text('ペットは乗れますか', { userId: VICTIM }));       // 本人の未一致メッセージ
  post(e, text('攻撃者の文面', { userId: VICTIM }, false));        // 偽造
  post(e, postback('a=inq_handoff', { userId: VICTIM }));        // 本人が担当者に送る
  const rows = e.rows('問い合わせ管理');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['内容'], 'ペットは乗れますか');
});

test('FAQ 自動応答は Webhook だけで完結（個人情報・予約情報は含めない）', () => {
  const e = env();
  e.sheets['予約管理'].data.push(['R-1', USER, '', '秘密のプラン', '2026-12-01', '10:00', 2, 99999, '予約確定', '決済完了', '', '']);
  post(e, text('キャンセル料'));
  post(e, text('予約確認'));
  post(e, text('R-1')); // 予約IDだけ（形式も違う）では予約内容を表示しない
  const all = JSON.stringify(e.linePosts('/reply').map((p) => p.json));
  assert.match(all, /キャンセル条件/);
  assert.doesNotMatch(all, /秘密のプラン|99999|R-1/);
});

test('Webhook からは予約状態の変更・決済完了・管理操作ができない', () => {
  const e = env();
  e.sheets['予約管理'].data.push(['R-2', USER, '', 'A', '2026-12-01', '10:00', 1, 1, '予約リクエスト受付', '未決済', '', '']);
  const before = JSON.stringify(e.sheets['予約管理'].data);
  post(e, [text('予約確定'), text('決済完了'), postback('a=approve&sendId=x'), postback('kind=reservation_event'),
    ev('message', { message: { type: 'text', text: JSON.stringify({ kind: 'reservation_event', eventType: 'PAYMENT_COMPLETED' }) } })]);
  assert.equal(JSON.stringify(e.sheets['予約管理'].data), before);
  assert.equal(e.rows('送信ログ').length, 0);
  assert.equal(e.linePosts('/push').length, 0);
  // 直接 Webhook 本文に kind を混ぜても予約イベントとして扱われない
  const out = e.doPost({ destination: BOT, events: [], kind: 'reservation_event', payload: '{}' });
  assert.notEqual(out.__html, true);
  assert.equal(out.error, 'stale');
});

test('予約イベント（HMAC 署名）は GAS単体でも従来どおり処理（Webhook とは別経路）', () => {
  const e = env();
  const r = e.doPost(reservationEnvelope({ eventId: 'e1', eventType: 'BOOKING_CONFIRMED', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R-9', lineUserId: USER } }, 'resv'));
  assert.equal(r.result, '成功');
});

test('同一 webhookEventId の再送は二重処理しない（LINE の再送・同時受信）', () => {
  const e = env();
  const a = postback('a=inq_cat&c=5');
  post(e, a);
  const t = text('問い合わせ本文');
  post(e, t);
  const dup = Object.assign({}, t, { replyToken: token(true), deliveryContext: { isRedelivery: true } });
  post(e, dup);
  assert.equal(e.rows('問い合わせ管理').length, 1);
});

test('形式が不正なイベントは処理しない', () => {
  const e = env();
  const bad = [
    Object.assign(text('予約'), { webhookEventId: 'short' }),
    Object.assign(text('予約'), { timestamp: Date.now() - 3 * 86400000 }),
    Object.assign(text('予約'), { timestamp: Date.now() + 3600000 }),
    Object.assign(text('予約'), { source: { type: 'user', userId: 'not-a-user' } }),
    Object.assign(text('予約'), { replyToken: '<script>' }),
    Object.assign(text('予約'), { type: 'adminCommand' }),
    Object.assign(text('予約'), { message: { type: 'text', text: 'x'.repeat(5001) } }),
    Object.assign(postback('a=faq'), { postback: { data: 'x'.repeat(301) } }),
    null, 'string', 42
  ];
  const out = post(e, bad);
  assert.equal(out.__html, true);
  assert.equal(e.fetchCalls.length, 0);
});

test('異常なリクエスト全体（宛先不一致・イベント過多・不正 JSON）は処理しない', () => {
  const e = env({ props: { BOT_USER_ID: BOT } });
  post(e, text('予約'), 'U' + '1'.repeat(32));
  post(e, text('予約'), 'not-a-bot');
  post(e, Array.from({ length: 51 }, () => text('予約')));
  assert.equal(e.fetchCalls.length, 0);
  assert.equal(e.ctx.doPost({ postData: { contents: '{broken' } }).getContent().indexOf('invalid_json') !== -1, true);
  assert.equal(e.doPost('[1,2]').error, 'invalid_body');
});

test('不正な URL エンコードの postback でも落ちない', () => {
  const e = env();
  const out = post(e, postback('a=faq&id=%E0%A4%A'));
  assert.equal(out.__html, true);
});

test('LINE接続チェック（direct）：302 と GAS 受信記録を区別して表示（障害の誤判定をしない）', () => {
  const e = env({ extra: (url) => {
    if (url.indexOf('/v2/bot/info') !== -1) return { code: 200, body: { displayName: 'SKY STANDARD', basicId: '@sky', userId: BOT } };
    if (url.indexOf('/webhook/endpoint') !== -1) return { code: 200, body: { endpoint: 'https://script.google.com/macros/s/AKfy/exec', active: true } };
    if (url.indexOf('/webhook/test') !== -1) {
      e.props.LAST_WEBHOOK_AT = String(Date.now() + 5); // GAS は実行された
      return { code: 200, body: { success: false, statusCode: 302, reason: 'Found' } };
    }
    if (url.indexOf('/quota') !== -1) return { code: 200, body: { type: 'none', totalUsage: 0 } };
    return null;
  } });
  e.setSetting('GAS_WEBAPP_URL', 'https://script.google.com/macros/s/AKfy/exec');
  const r = e.ctx.adminRun('checkLine', { testWebhook: true });
  assert.match(r.message, /GAS単体（direct・署名検証なし）/);
  assert.match(r.message, /【OK】Webhook URL: .*（ID管理の GAS_WEBAPP_URL と一致）/);
  assert.match(r.message, /【NG】LINE 側の疎通テスト結果: 失敗（HTTP 302 Found）/);
  assert.match(r.message, /【OK】GAS 側の受信記録: テスト中に受信を確認/);
  assert.match(r.message, /GAS は受信・処理していますが、LINE は失敗として扱っています/);
  assert.match(r.message, /古い（ContentService で応答）可能性/);
  assert.equal(r.ok, false);
  assert.equal(e.props.BOT_USER_ID, BOT);
  assert.doesNotMatch(r.message, /Cloud Run|リレーの \/webhook を指定/);
});

test('LINE接続チェック（direct）：LINE 側 200 かつ GAS 受信確認で OK', () => {
  const e = env({ extra: (url) => {
    if (url === 'https://script.google.com/macros/s/AKfy/exec') return { code: 200, body: { ok: true, build: e.ctx.APP.BUILD } };
    if (url.indexOf('/v2/bot/info') !== -1) return { code: 200, body: { displayName: 'SKY STANDARD', userId: BOT } };
    if (url.indexOf('/webhook/endpoint') !== -1) return { code: 200, body: { endpoint: 'https://script.google.com/macros/s/AKfy/exec', active: true } };
    if (url.indexOf('/webhook/test') !== -1) { e.props.LAST_WEBHOOK_AT = String(Date.now() + 5); return { code: 200, body: { success: true, statusCode: 200, reason: 'OK' } }; }
    if (url.indexOf('/quota') !== -1) return { code: 200, body: { type: 'none', totalUsage: 0 } };
    return null;
  } });
  e.setSetting('GAS_WEBAPP_URL', 'https://script.google.com/macros/s/AKfy/exec');
  const r = e.ctx.adminRun('checkLine', { testWebhook: true });
  assert.equal(r.ok, true);
  assert.match(r.message, /【OK】LINE 側の疎通テスト結果: 成功（HTTP 200 OK）/);
});

test('接続・設定診断：Cloud Run 未設定を障害扱いにしない', () => {
  const e = env();
  const r = e.ctx.adminRun('diagnose');
  assert.doesNotMatch(r.message, /RELAY_SHARED_SECRET|Cloud Run/);
  const ids = e.ctx.adminRun('checkIds');
  assert.match(ids.message, /◆ 注意（障害ではありません）/);
});

test('relay モード：署名なしの直接 Webhook は処理せず、RELAY_SHARED_SECRET 未設定を不足として表示', () => {
  const e = env({ props: { WEBHOOK_MODE: 'relay' } });
  post(e, text('予約'));
  assert.equal(e.fetchCalls.length, 0);
  assert.ok(Object.keys(e.ctx.checkConfig_().missing).some((k) => /リレー/.test(k)));
});

test('ログにアクセストークン・ユーザーID全体・本文を出さない（GAS単体）', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=5'));
  post(e, text('電話は09011112222です'));
  const all = e.logs.join('\n');
  assert.doesNotMatch(all, new RegExp(TOKEN));
  assert.doesNotMatch(all, /09011112222/);
  assert.doesNotMatch(all, new RegExp(USER));
});

/* ---------- レビュー指摘への回帰テスト ---------- */

test('応答トークンのない偽造イベントでは問い合わせを保存・通知しない', () => {
  const e = env();
  e.ctx.setInquiryState_(VICTIM, { c: '5' });
  const t = text('なりすまし', { userId: VICTIM });
  delete t.replyToken;
  post(e, t);
  const h = postback('a=inq_handoff', { userId: VICTIM });
  delete h.replyToken;
  e.cache.set('last:' + VICTIM, '本人の文面');
  post(e, h);
  assert.equal(e.rows('問い合わせ管理').length, 0);
  assert.equal(e.linePosts('/push').length, 0);
  assert.notEqual(e.ctx.getInquiryState_(VICTIM), null);
});

test('偽造イベント（定型語・入力取消）で他人の入力待ち状態を消せない', () => {
  const e = env();
  e.ctx.setInquiryState_(VICTIM, { c: '2' });
  post(e, text('予約', { userId: VICTIM }, false));
  post(e, postback('a=inq_cancel', { userId: VICTIM }, false));
  const noToken = postback('a=inq_cancel', { userId: VICTIM });
  delete noToken.replyToken;
  post(e, noToken);
  assert.deepEqual(JSON.parse(JSON.stringify(e.ctx.getInquiryState_(VICTIM))), { c: '2' });
});

test('本物のイベントでの定型語・入力取消は入力待ちを解除', () => {
  const e = env();
  e.ctx.setInquiryState_(USER, { c: '2' });
  post(e, text('FAQ'));
  assert.equal(e.ctx.getInquiryState_(USER), null);
});

test('応答後にシート保存が失敗したら運営に「保存失敗」を通知', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=5'));
  const orig = e.sheets['問い合わせ管理'].appendRow;
  e.sheets['問い合わせ管理'].appendRow = () => { throw new Error('Service unavailable'); };
  post(e, text('保存できない問い合わせ'));
  e.sheets['問い合わせ管理'].appendRow = orig;
  assert.ok(e.linePosts('/push').some((p) => p.json.to === ADMIN && /保存に失敗/.test(p.json.messages[0].text)));
});

test('同時刻に複数の未検証問い合わせを受けても受付IDが重複しない', () => {
  const e = env();
  const ids = new Set();
  for (let i = 0; i < 3; i++) {
    const u = 'U' + String(i).repeat(32);
    post(e, postback('a=inq_cat&c=5', { userId: u }));
    post(e, text('質問' + i, { userId: u }));
  }
  e.rows('問い合わせ管理').forEach((r) => ids.add(r['受付ID']));
  assert.equal(ids.size, 3);
});

/* ---------- デプロイ反映チェック（302 の再発防止） ---------- */

function buildEnv(deployedBody) {
  return env({ extra: (url) => {
    if (url === 'https://script.google.com/macros/s/AKfyDEPLOY/exec') return { code: 200, body: deployedBody };
    if (url.indexOf('/v2/bot/info') !== -1) return { code: 200, body: { displayName: 'SKY STANDARD', userId: BOT } };
    if (url.indexOf('/webhook/endpoint') !== -1) return { code: 200, body: { endpoint: 'https://script.google.com/macros/s/AKfyDEPLOY/exec', active: true } };
    if (url.indexOf('/quota') !== -1) return { code: 200, body: { type: 'none', totalUsage: 0 } };
    return null;
  } });
}

test('doGet は版（build）を返す（設定値・秘密は返さない）', () => {
  const e = env();
  const out = JSON.parse(e.ctx.doGet({ parameter: {} }).getContent());
  assert.equal(out.build, e.ctx.APP.BUILD);
  assert.doesNotMatch(JSON.stringify(out), /token|secret/i);
});

test('デプロイ済み Web アプリが旧コード（build なし）なら【NG】で新バージョンのデプロイを案内', () => {
  const e = buildEnv({ ok: true, service: 'SKY STANDARD LINE' });
  e.setSetting('GAS_WEBAPP_URL', 'https://script.google.com/macros/s/AKfyDEPLOY/exec');
  const r = e.ctx.adminRun('checkLine');
  assert.match(r.message, /【NG】Web アプリが古い版です（デプロイ済み: 版情報なし＝旧コード/);
  assert.match(r.message, /新バージョン/);
  assert.equal(r.ok, false);
  assert.match(e.ctx.adminRun('diagnose').message, /◆ Web アプリの反映状況\n【NG】/);
});

test('デプロイ済み Web アプリが同じ版なら【OK】', () => {
  const e = buildEnv(null);
  const b = e.ctx.APP.BUILD;
  e.setFetch((url, params) => (url === 'https://script.google.com/macros/s/AKfyDEPLOY/exec'
    ? { code: 200, body: { ok: true, build: b } }
    : lineMock((u) => {
      if (u.indexOf('/v2/bot/info') !== -1) return { code: 200, body: { displayName: 'SKY STANDARD', userId: BOT } };
      if (u.indexOf('/webhook/endpoint') !== -1) return { code: 200, body: { endpoint: 'https://script.google.com/macros/s/AKfyDEPLOY/exec', active: true } };
      if (u.indexOf('/quota') !== -1) return { code: 200, body: { type: 'none', totalUsage: 0 } };
      return null;
    })(url, params)));
  e.setSetting('GAS_WEBAPP_URL', 'https://script.google.com/macros/s/AKfyDEPLOY/exec');
  const r = e.ctx.adminRun('checkLine');
  assert.match(r.message, /【OK】Web アプリは保存済みコードと同じ版です/);
});
