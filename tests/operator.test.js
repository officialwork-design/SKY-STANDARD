/**
 * 有人オペレーター対応（src/gas/12_Operator.gs）のモックテスト。
 * LINE の reply API は「LINE が発行した応答トークンのみ受理」を模擬する。
 * 実際の LINE プラットフォーム・LINE Official Account Manager のチャット画面はここでは検証できない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv, relayEnvelope } = require('./helpers/gas-env');

const BOT = 'U' + 'f'.repeat(32);
const USER = 'U' + 'a'.repeat(32);
const OTHER = 'U' + 'b'.repeat(32);
const ADMIN = 'U' + 'c'.repeat(32);
const RELAY = 'relay-secret';
const GOOD = new Set();
const PROP = 'OPERATOR_MODE:';
const SHEET = '問い合わせ管理';
const hasError = (e, code) => (e.sheets['エラーログ'] ? e.rows('エラーログ') : []).some((r) =>
  r['発生元'] === 'オペレーター対応' && String(r['エラー詳細・スタックトレース']).includes('コード: ' + code) && r['対応状況'] === '未対応');

function ulid() { return crypto.randomBytes(13).toString('hex').toUpperCase().replace(/[^0-9A-Z]/g, 'A').slice(0, 26); }
function tok(valid = true) { const t = crypto.randomBytes(16).toString('hex'); if (valid) GOOD.add(t); return t; }

function env(opts = {}) {
  const state = { profile404: false, replyFail: false };
  const e = createGasEnv({
    props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: 'tok', RESERVATION_WEBHOOK_SECRET: 'resv', RELAY_SHARED_SECRET: RELAY,
      SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, opts.props || {}),
    fetch: (url, params) => {
      if (url.indexOf('/v2/bot/message/reply') !== -1) {
        if (state.replyFail) return { code: 500, body: { message: 'boom' } };
        const t = JSON.parse(params.payload).replyToken;
        if (opts.relay) return { code: 200, body: {} };
        if (!GOOD.has(t)) return { code: 400, body: { message: 'Invalid reply token' } };
        GOOD.delete(t);
        return { code: 200, body: {} };
      }
      if (url.indexOf('/v2/bot/profile/') !== -1) {
        return state.profile404 ? { code: 404, body: { message: 'Not found' } } : { code: 200, body: { displayName: '空野 太郎', language: 'ja' } };
      }
      return { code: 200, body: {} };
    }
  });
  if (opts.notify !== false) e.setSetting('ADMIN_NOTIFY_TARGET', ADMIN);
  e.state = state;
  return e;
}
function ev(type, fields = {}, valid = true) {
  const base = { type, webhookEventId: ulid(), timestamp: Date.now(), mode: 'active',
    source: { type: 'user', userId: fields.userId || USER }, deliveryContext: { isRedelivery: false } };
  if (type !== 'unfollow') base.replyToken = tok(valid);
  delete fields.userId;
  return Object.assign(base, fields);
}
const text = (t, o = {}, valid = true) => ev('message', Object.assign({ message: { type: 'text', id: '1', text: t } }, o), valid);
const postback = (d, o = {}, valid = true) => ev('postback', Object.assign({ postback: { data: d } }, o), valid);
const post = (e, events) => e.doPost({ destination: BOT, events: [].concat(events) });
const relay = (e, events) => e.doPost(relayEnvelope({ destination: BOT, events: [].concat(events) }, RELAY));

const replies = (e) => e.linePosts('/v2/bot/message/reply');
const pushes = (e) => e.linePosts('/v2/bot/message/push');
const replyText = (r) => r.json.messages.map((m) => m.text || '').join('\n');
const opState = (e, u = USER) => (e.props[PROP + u] ? JSON.parse(e.props[PROP + u]) : null);
/** 担当者がシートのセルを編集したのと同じ（列がなければ追加） */
function setCell(e, id, colName, value) {
  const d = e.sheets[SHEET].data;
  let col = d[0].indexOf(colName);
  if (col === -1) { d[0].push(colName); col = d[0].length - 1; }
  const row = d.find((r) => String(r[0]).replace(/^'/, '') === id);
  row[col] = value;
}
/** 問い合わせ行を直接追加（top=true ならシートの2行目＝並べ替え後を想定） */
function addRow(e, id, at, flag, top = false, user = USER, status = '未対応') {
  const d = e.sheets[SHEET].data;
  if (d[0].indexOf('自動返信有効') === -1) d[0].push('自動返信有効');
  const r = d[0].map(() => '');
  const set = (k, v) => { r[d[0].indexOf(k)] = v; };
  set('受付ID', id); set('LINEユーザーID', user); set('受付日時', at); set('種別', 'その他のお問い合わせ'); set('内容', 'x');
  set('対応状況', status); set('自動返信有効', flag);
  if (top) d.splice(1, 0, r); else d.push(r);
}
function startOperator(e, u = USER) {
  post(e, postback('a=inq_operator', { userId: u }));
  return opState(e, u).id;
}

/* ---------- 1. メニュー ---------- */

test('お問い合わせの種別選択に「オペレーターに相談」（postback a=inq_operator）が追加され、既存5種別はそのまま', () => {
  const e = env();
  post(e, text('お問い合わせ'));
  const m = replies(e)[0].json.messages[0];
  const items = m.quickReply.items.map((i) => i.action);
  assert.deepEqual(items.slice(0, 5).map((a) => a.data), ['a=inq_cat&c=1', 'a=inq_cat&c=2', 'a=inq_cat&c=3', 'a=inq_cat&c=4', 'a=inq_cat&c=5']);
  assert.equal(items[5].label, 'オペレーターに相談');
  assert.equal(items[5].data, 'a=inq_operator');
  assert.equal(m.text, '🚁 お問い合わせありがとうございます。\nご希望の内容を下記よりお選びくださいませ。');
});

/* ---------- 2〜6. 開始・記録・通知 ---------- */

test('「オペレーターに相談」：受付返信 → 問い合わせ管理に「未対応」「自動返信有効=FALSE」で記録 → 停止を記録 → 運営通知', () => {
  const e = env();
  post(e, postback('a=inq_operator'));
  const r = replies(e);
  assert.equal(r.length, 1);
  assert.match(replyText(r[0]), /^💬 担当スタッフへおつなぎいたします。/);
  assert.match(replyText(r[0]), /自動返信を一時停止いたします/);
  const rows = e.rows(SHEET);
  assert.equal(rows.length, 1);
  assert.match(rows[0]['受付ID'], /^INQ-\d{8}-0001$/);
  assert.match(replyText(r[0]), new RegExp('受付ID：' + rows[0]['受付ID']));
  assert.equal(rows[0]['LINEユーザーID'], USER);
  assert.equal(rows[0]['種別'], 'オペレーター相談');
  assert.equal(rows[0]['対応状況'], '未対応');
  assert.equal(rows[0]['自動返信有効'], false);
  assert.equal(e.sheets[SHEET].data[0].indexOf('自動返信有効'), 9, '既存9列の後ろ（末尾）に追加');
  assert.match(rows[0]['内容'], /LINE表示名：空野 太郎/);
  assert.match(rows[0]['備考'], /自動返信有効=FALSE/);
  assert.match(rows[0]['備考'], /署名未検証/);
  const st = opState(e);
  assert.equal(st.id, rows[0]['受付ID']);
  assert.equal(st.n, 0);
  const p = pushes(e);
  assert.equal(p.length, 1);
  assert.equal(p[0].json.to, ADMIN);
  assert.match(p[0].json.messages[0].text, /【オペレーター対応依頼】INQ-/);
  assert.match(p[0].json.messages[0].text, /チャット画面から/);
  assert.match(p[0].json.messages[0].text, /「自動返信有効」を TRUE/);
});

test('通常の問い合わせ（5種別・担当者に送る）は「自動返信有効=TRUE」で記録し、自動返信を続ける', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=4'));
  post(e, text('12/1 4名 見積希望'));
  assert.equal(e.rows(SHEET)[0]['自動返信有効'], true);
  const n0 = replies(e).length;
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1);
  assert.equal(opState(e), null);
});

test('オペレーター対応中は、テキスト・定型語・FAQ・リッチメニュー・画像・postback のいずれにも自動返信しない', () => {
  const e = env();
  const id = startOperator(e);
  const before = replies(e).length;
  const pushBefore = pushes(e).length;
  post(e, [text('予約'), text('FAQ'), text('お問い合わせ'), text('料金を教えて'), text('あいうえお'),
    postback('a=menu_unset&item=BOOKING'), postback('a=faq_list'), postback('a=inq_start'), postback('a=inq_operator'),
    postback('a=inq_cat&c=2'), postback('a=inq_handoff'), ev('message', { message: { type: 'image', id: '9' } })]);
  assert.equal(replies(e).length, before, '自動返信していない');
  assert.equal(pushes(e).length, pushBefore, '運営通知・プッシュもしていない');
  assert.equal(e.rows(SHEET).length, 1, '問い合わせを追加登録していない');
  const st = opState(e);
  assert.equal(st.id, id);
  assert.equal(st.n, 12, '停止した件数を記録');
  assert.ok(st.last > 0);
  assert.equal(e.cache.get('inq:' + USER) || null, null, '入力待ち状態にもならない');
  // メッセージ本文はログ・プロパティに残さない
  assert.ok(!JSON.stringify(e.props).includes('料金を教えて'));
  assert.ok(e.logs.some((l) => /operator\.auto_reply_suppressed/.test(l)));
  assert.ok(!e.logs.some((l) => /料金を教えて/.test(l)));
});

test('FALSE の間は対応状況に関係なく停止を継続し、管理者が TRUE にすると次のメッセージから自動返信を再開', () => {
  const e = env();
  const id = startOperator(e);
  const n0 = replies(e).length;
  setCell(e, id, '対応状況', '対応中');
  post(e, text('予約'));
  setCell(e, id, '対応状況', '対応完了');
  post(e, text('予約'));
  assert.equal(replies(e).length, n0, '対応状況を対応完了にしても FALSE なら停止のまま');
  assert.ok(opState(e));
  setCell(e, id, '自動返信有効', true); // シートで TRUE に変更（チェック値＝boolean）
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1, '自動返信が再開');
  assert.equal(opState(e), null, '内部記録（スクリプトプロパティ）も削除');
  assert.ok(e.logs.some((l) => /operator\.released/.test(l)));
  // 再開後は既存のお問い合わせフローがそのまま動く
  post(e, postback('a=inq_cat&c=4'));
  post(e, text('12/1 4名 見積希望'));
  const rows = e.rows(SHEET);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]['種別'], 'チャーター見積');
  assert.equal(rows[0]['対応状況'], '対応完了', '担当者が設定した値は変更しない');
});

test('文字列の "TRUE" / "false"（手入力）も受け付ける', () => {
  const e = env();
  const id = startOperator(e);
  setCell(e, id, '自動返信有効', ' true ');
  const n0 = replies(e).length;
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1);
  setCell(e, id, '自動返信有効', 'FALSE');
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1);
});

test('管理者がシートで FALSE にした顧客（オペレーター依頼なし）も停止し、内部記録を作成。TRUE に戻すと削除', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=1'));
  post(e, text('予約について質問'));
  const id = e.rows(SHEET)[0]['受付ID'];
  assert.equal(opState(e), null);
  setCell(e, id, '自動返信有効', false);
  const n0 = replies(e).length;
  post(e, [text('予約'), postback('a=menu_unset&item=BOOKING')]);
  assert.equal(replies(e).length, n0, '停止');
  const st = opState(e);
  assert.equal(st.id, id);
  assert.equal(st.by, 'sheet');
  assert.equal(st.n, 2);
  setCell(e, id, '自動返信有効', true);
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1);
  assert.equal(opState(e), null);
});

test('優先順位：同じ顧客の複数行は「TRUE/FALSE が入った行のうち受付日時が最も新しい行」で決まり、空欄は無視', () => {
  const e = env();
  addRow(e, 'INQ-20261001-0001', '2026-10-01 10:00:00', false);
  addRow(e, 'INQ-20261002-0001', '2026-10-02 10:00:00', true);
  addRow(e, 'INQ-20261003-0001', '2026-10-03 10:00:00', ''); // 空欄（既存の履歴）
  const n0 = replies(e).length;
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1, '最新の明示値 TRUE（10/02）が優先');
  // 古い行を FALSE にしても、より新しい TRUE が優先
  setCell(e, 'INQ-20261002-0001', '自動返信有効', 'FALSE');
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1, '10/02 を FALSE にすると停止');
  assert.equal(opState(e).id, 'INQ-20261002-0001');
  // シートが並べ替えられていても受付日時で判定。より新しい行を TRUE にすると再開
  addRow(e, 'INQ-20261004-0001', '2026-10-04 09:00:00', true, true);
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 2);
  // 受付日時が同じならシートで下の行
  const e2 = env();
  addRow(e2, 'INQ-20261005-0001', '2026-10-05 10:00:00', true);
  addRow(e2, 'INQ-20261005-0002', '2026-10-05 10:00:00', false);
  post(e2, text('予約'));
  assert.equal(replies(e2).length, 0);
});

test('TRUE/FALSE 以外の値は判定に使わず、状況確認で【要確認】として表示', () => {
  const e = env();
  e.setUser('owner@example.com');
  addRow(e, 'INQ-20261001-0001', '2026-10-01 10:00:00', false);
  addRow(e, 'INQ-20261002-0001', '2026-10-02 10:00:00', 'はい');
  post(e, text('予約'));
  assert.equal(replies(e).length, 0, '入力ミスの行は無視し、10/01 の FALSE で停止');
  const r = e.ctx.adminRun('operatorStatus');
  assert.equal(r.ok, false);
  assert.match(r.message, /【要確認】自動返信有効が TRUE \/ FALSE 以外/);
  assert.match(r.message, /INQ-20261002-0001：「はい」/);
});

test('他の利用者はオペレーター対応中の影響を受けない', () => {
  const e = env();
  startOperator(e, USER);
  const n0 = replies(e).length;
  post(e, text('予約', { userId: OTHER }));
  assert.equal(replies(e).length, n0 + 1);
});

test('入力待ち中に「オペレーターに相談」を選ぶと入力待ちを破棄し、モード中の文は問い合わせとして保存しない', () => {
  const e = env();
  post(e, postback('a=inq_cat&c=2'));
  assert.ok(e.cache.get('inq:' + USER));
  startOperator(e);
  assert.equal(e.cache.get('inq:' + USER) || null, null);
  post(e, text('予約番号 R-1 の日程を変えたい'));
  assert.equal(e.rows(SHEET).length, 1);
});

test('通知テンプレート OPERATOR_START が ON なら、その文面＋受付IDで返信', () => {
  const e = env();
  e.sheets['通知テンプレート'].data.push(['OPERATOR_START', 'オペレーター対応開始', '', 'スタッフにおつなぎします。', 'ON', '']);
  post(e, postback('a=inq_operator'));
  const t = replyText(replies(e)[0]);
  assert.match(t, /^スタッフにおつなぎします。\n\n🔖 受付ID：INQ-\d{8}-0001$/);
});

/* ---------- 偽装イベント（GAS単体＝署名未検証） ---------- */

test('偽装イベント（応答トークンが LINE に拒否）では記録・モード開始・通知を一切しない', () => {
  const e = env();
  post(e, postback('a=inq_operator', { userId: OTHER }, false));
  assert.equal(e.rows(SHEET).length, 0);
  assert.equal(opState(e, OTHER), null);
  assert.equal(pushes(e).length, 0);
  // 本人はその後も通常どおり自動応答を受けられる
  post(e, text('予約', { userId: OTHER }));
  assert.equal(replies(e).length, 2);
  assert.equal(replies(e)[1].json.messages.length > 0, true);
});

test('偽装イベントでは自動返信を再開できない（再開はシートの TRUE か管理メニューのみ）', () => {
  const e = env();
  const id = startOperator(e);
  post(e, [postback('a=inq_cancel', {}, false), text('TRUE', {}, false), postback('a=inq_operator', {}, false)]);
  assert.equal(opState(e).id, id);
  assert.equal(e.rows(SHEET)[0]['自動返信有効'], false);
  assert.equal(e.rows(SHEET).length, 1);
});

test('オペレーター対応中でもブロック（unfollow）は記録する', () => {
  const e = env();
  post(e, ev('follow'));
  startOperator(e);
  e.state.profile404 = true;
  post(e, ev('unfollow'));
  assert.equal(e.rows('顧客管理')[0]['友だち状態'], 'ブロック');
  assert.ok(opState(e), 'モードは継続');
});

test('オペレーター対応中の友だち再追加は返信せず、友だちであることを確認できた場合のみ顧客状態を更新', () => {
  const e = env();
  post(e, ev('follow'));
  startOperator(e);
  e.state.profile404 = true;
  post(e, ev('unfollow'));
  e.state.profile404 = false;
  const n0 = replies(e).length;
  post(e, ev('follow'));
  assert.equal(replies(e).length, n0);
  assert.equal(e.rows('顧客管理')[0]['友だち状態'], '友だち');
});

test('問い合わせ管理を読めない場合は内部記録で判断（停止中なら返信しない）し、エラーログに記録', () => {
  const e = env();
  startOperator(e);
  post(e, text('予約', { userId: OTHER }));
  const n0 = replies(e).length;
  const orig = e.ctx.inquiryRowsOfUser_;
  e.ctx.inquiryRowsOfUser_ = () => { throw new Error('Service Spreadsheets timed out'); };
  post(e, text('予約'));
  post(e, text('予約', { userId: OTHER }));
  e.ctx.inquiryRowsOfUser_ = orig;
  assert.equal(replies(e).length, n0 + 1, '停止中の顧客には返信せず、それ以外の顧客には返信');
  assert.ok(opState(e));
  assert.ok(hasError(e, 'operator.status_check_failed'));
});

test('運営に通知できない（通知先未設定）場合はエラーログに記録', () => {
  const e = env({ notify: false });
  startOperator(e);
  assert.ok(hasError(e, 'operator.notify_failed'));
});

test('応答後にシート保存が失敗してもモードは開始し、運営通知に【要対応】を含め、エラーログに記録', () => {
  const e = env();
  const orig = e.ctx.appendRow_;
  e.ctx.appendRow_ = (name, obj) => { if (name === SHEET) throw new Error('quota'); return orig(name, obj); };
  post(e, postback('a=inq_operator'));
  e.ctx.appendRow_ = orig;
  assert.ok(opState(e));
  assert.match(pushes(e)[0].json.messages[0].text, /【要対応】問い合わせ管理への保存に失敗/);
  assert.ok(hasError(e, 'operator.save_failed'));
  // 行がないため自動では解除されない（停止継続）。管理メニューで解除できる
  const n0 = replies(e).length;
  post(e, text('予約'));
  assert.equal(replies(e).length, n0);
});

/* ---------- 署名検証済み（リレー）経路 ---------- */

test('リレー経由（署名検証済み）でも同じく開始・停止・再開する。応答失敗時はプッシュで受付IDを通知', () => {
  const e = env({ relay: true, props: { WEBHOOK_MODE: 'relay' } });
  e.state.replyFail = true;
  relay(e, postback('a=inq_operator'));
  e.state.replyFail = false;
  const st = opState(e);
  assert.ok(st);
  const userPush = pushes(e).filter((p) => p.json.to === USER);
  assert.equal(userPush.length, 1);
  assert.match(userPush[0].json.messages[0].text, new RegExp('受付ID：' + st.id));
  const n0 = replies(e).length;
  relay(e, text('予約'));
  assert.equal(replies(e).length, n0);
  setCell(e, st.id, '自動返信有効', true);
  relay(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1);
});

test('管理：自動返信の状況（読み取りのみ）と、選択した顧客の再開（FALSE の行をすべて TRUE に。対応状況は変更しない）', () => {
  const e = env();
  e.setUser('owner@example.com');
  const old = 'INQ-20261001-0001';
  addRow(e, old, '2026-10-01 10:00:00', false);             // 古い FALSE（より新しい TRUE が優先され無効）
  addRow(e, 'INQ-20261002-0001', '2026-10-02 10:00:00', true);
  const id = startOperator(e);
  post(e, text('こんにちは'));
  let r = e.ctx.adminRun('operatorStatus');
  assert.equal(r.ok, true);
  assert.match(r.message, /自動返信を停止中（自動返信有効=FALSE）：1 名/);
  assert.match(r.message, new RegExp('・' + id + '（オペレーター相談）／対応状況：未対応'));
  assert.match(r.message, /停止した自動返信 1 件/);
  assert.match(r.message, /優先順位：/);
  assert.match(r.message, new RegExp('【情報】より新しい行の値が優先されている行：\\n・INQ-20261002-0001（TRUE）→ ' + id + '（FALSE）が優先'));
  assert.ok(!r.message.includes(USER), 'LINEユーザーIDは表示しない');
  assert.ok(opState(e), '状況確認では変更しない');

  r = e.ctx.adminRun('operatorRelease', { inquiryId: id });
  assert.equal(r.ok, true);
  assert.match(r.message, /自動返信を再開しました/);
  assert.match(r.message, new RegExp(old + '、' + id + '|' + id + '、' + old));
  assert.equal(opState(e), null);
  const rows = e.rows(SHEET);
  assert.deepEqual(rows.map((x) => x['自動返信有効']), [true, true, true]);
  assert.deepEqual(rows.map((x) => x['対応状況']), ['未対応', '未対応', '未対応'], '対応状況は変更しない');
  assert.equal(pushes(e).filter((p) => p.json.to === USER).length, 0, '利用者には送信しない');
  assert.match(e.ctx.adminRun('operatorStatus').message, /停止中（自動返信有効=FALSE）：0 名/);
  const n0 = replies(e).length;
  post(e, text('予約'));
  assert.equal(replies(e).length, n0 + 1);
  assert.equal(e.ctx.adminRun('operatorRelease', { inquiryId: 'x' }).ok, false);
  assert.equal(e.ctx.adminRun('operatorRelease', { inquiryId: 'INQ-20990101-0001' }).ok, false);
});

test('管理：自動返信の状態を同期で、シートとスクリプトプロパティの矛盾をまとめて解消（シートは変更しない）', () => {
  const e = env();
  e.setUser('owner@example.com');
  const U3 = 'U' + 'd'.repeat(32);
  addRow(e, 'INQ-20261001-0001', '2026-10-01 10:00:00', false);            // FALSE なのに記録なし
  addRow(e, 'INQ-20261001-0002', '2026-10-01 11:00:00', true, false, OTHER); // TRUE なのに記録あり
  e.ctx.setOperatorState_(OTHER, { id: 'INQ-20261001-0002', since: 1, n: 0 });
  e.ctx.setOperatorState_(U3, { id: 'INQ-20261001-0999', since: 1, n: 0 });   // 行がない記録
  let r = e.ctx.adminRun('operatorStatus');
  assert.equal(r.ok, false);
  assert.match(r.message, /シートと内部記録（スクリプトプロパティ）の差：2 件/);
  assert.match(r.message, /【要確認】停止中の記録があるのに、問い合わせ管理に行がない：1 件/);
  const before = JSON.stringify(e.sheets[SHEET].data);
  r = e.ctx.adminRun('operatorSync');
  assert.match(r.message, /停止の記録を作成：1 件/);
  assert.match(r.message, /停止の記録を削除（再開）：1 件/);
  assert.equal(JSON.stringify(e.sheets[SHEET].data), before, 'シートは変更しない');
  assert.equal(opState(e).id, 'INQ-20261001-0001');
  assert.equal(opState(e, OTHER), null);
  assert.ok(opState(e, U3), '根拠の行がない記録は自動では解除しない');
  assert.doesNotMatch(e.ctx.adminRun('operatorStatus').message, /内部記録（スクリプトプロパティ）の差/);
});

test('旧版の記録（自動返信有効が空欄）は対応状況から TRUE/FALSE を書き込んで移行', () => {
  const e = env();
  addRow(e, 'INQ-20261001-0001', '2026-10-01 10:00:00', '');
  e.ctx.setOperatorState_(USER, { id: 'INQ-20261001-0001', since: 1, n: 0 });
  post(e, text('予約'));
  assert.equal(replies(e).length, 0, '対応状況「未対応」→ FALSE として停止継続');
  assert.equal(e.rows(SHEET)[0]['自動返信有効'], false);
  const e2 = env();
  addRow(e2, 'INQ-20261001-0001', '2026-10-01 10:00:00', '', false, USER, '対応完了');
  e2.ctx.setOperatorState_(USER, { id: 'INQ-20261001-0001', since: 1, n: 0 });
  post(e2, text('予約'));
  assert.equal(replies(e2).length, 1, '対応状況「対応完了」→ TRUE として再開');
  assert.equal(e2.rows(SHEET)[0]['自動返信有効'], true);
  assert.equal(opState(e2), null);
});

test('管理：ADMIN_USERS 以外は自動返信の状況確認・再開・同期ができない', () => {
  const e = env();
  const id = startOperator(e);
  e.setUser('staff@example.com');
  assert.equal(e.ctx.adminRun('operatorStatus').denied, true);
  assert.equal(e.ctx.adminRun('operatorRelease', { inquiryId: id }).denied, true);
  assert.equal(e.ctx.adminRun('operatorSync').denied, true);
  assert.ok(opState(e));
  assert.equal(e.rows(SHEET)[0]['自動返信有効'], false);
});

test('シート列・設定行の補完：「自動返信有効」列を末尾に追加し、選択肢（TRUE/FALSE・対応状況）を設定。既存の履歴・値は変更しない', () => {
  const e = env();
  e.setUser('owner@example.com');
  e.sheets[SHEET].data.push(['INQ-20260101-0001', USER, '2026-01-01 10:00:00', 'その他', '旧データ', '完了', '山田', '2026-01-02', 'メモ']);
  const before = e.sheets[SHEET].data[1].slice();
  const r = e.ctx.adminRun('setupSheets');
  assert.match(r.message, /問い合わせ管理：自動返信有効/);
  assert.match(r.message, /自動返信有効：TRUE／FALSE）：設定しました/);
  const h = [...e.sheets[SHEET].data[0]];
  assert.deepEqual(h, ['受付ID', 'LINEユーザーID', '受付日時', '種別', '内容', '対応状況', '担当者', '回答日時', '備考', '自動返信有効']);
  assert.deepEqual([...e.sheets[SHEET].data[1]].slice(0, 9), before, '既存の行は変更しない');
  const row = e.rows(SHEET)[0];
  assert.equal(row['自動返信有効'], '', '既存行は空欄のまま（= 判定に使わない）');
  assert.equal(row['対応状況'], '完了');
  const v6 = e.sheets[SHEET].fmt.validations.find((x) => x.col === 6);
  assert.deepEqual([...v6.v.list], ['未対応', '対応中', '対応完了']);
  const v10 = e.sheets[SHEET].fmt.validations.find((x) => x.col === 10);
  assert.deepEqual([...v10.v.list], ['TRUE', 'FALSE']);
  // 既存の履歴しかない顧客は自動返信のまま
  post(e, text('予約'));
  assert.equal(replies(e).length, 1);
});

test('公開関数（ライブラリ利用者から見える関数）は増えていない', () => {
  const e = env();
  const pub = Object.keys(e.ctx).filter((k) => typeof e.ctx[k] === 'function' && /Operator|operator/.test(k) && !k.endsWith('_'));
  assert.deepEqual(pub, []);
});

test('LINE接続チェックでチャット（chatMode）を表示：オフならオペレーター対応のため要確認', () => {
  for (const [mode, re] of [['bot', /【要確認】チャット: オフ/], ['chat', /【OK】チャット: オン/]]) {
    const e = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: 't', SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' },
      fetch: (url) => (url.indexOf('/v2/bot/info') !== -1 ? { code: 200, body: { displayName: 'SKY', basicId: '@sky', chatMode: mode } } : { code: 200, body: {} }) });
    e.setUser('owner@example.com');
    assert.match(e.ctx.adminRun('checkLine', {}).message, re);
  }
});
