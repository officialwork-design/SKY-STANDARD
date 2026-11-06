/**
 * 監視・エラーログ強化（LINE操作ログ・原因コード・設定警告・LINEシステム診断）のモックテスト。
 * LINE API・Google のサービスはすべてモック。実際の LINE での動作確認ではない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv } = require('./helpers/gas-env');

const BOT = 'U' + 'f'.repeat(32);
const USER = 'U' + 'a'.repeat(32);
const TOKEN = 'SECRET-CHANNEL-TOKEN-' + 'x'.repeat(20);
const OPLOG = 'LINE操作ログ';
const ERRLOG = 'エラーログ';

function ulid() { return crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26); }

/**
 * @param {{reply?:number, replyBody?:Object, failInsert?:boolean, registered?:Object, props?:Object}} o
 */
function env(o = {}) {
  const e = createGasEnv({
    failInsert: o.failInsert,
    props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN, SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es',
      ADMIN_USERS: 'owner@example.com' }, o.props || {}),
    fetch: (url, p) => {
      if (url.indexOf('/v2/bot/message/reply') !== -1) {
        const code = e.replyCode || 200;
        return { code, body: code === 200 ? {} : (o.replyBody || { message: 'error ' + code }) };
      }
      if (/\/v2\/bot\/info$/.test(url)) return { code: 200, body: { displayName: 'SKY', basicId: '@686mdyho', chatMode: 'chat' } };
      if (/webhook\/endpoint$/.test(url)) return { code: 200, body: { active: true, endpoint: 'https://script.google.com/macros/s/AAA/exec' } };
      if (/\/v2\/bot\/user\/all\/richmenu$/.test(url)) return o.registered ? { code: 200, body: { richMenuId: 'richmenu-a77466a8ad199fbac64d4c011468831b' } } : { code: 404, body: {} };
      if (/\/v2\/bot\/richmenu\/richmenu-/.test(url)) return { code: 200, body: o.registered };
      if (/\/v2\/bot\/profile\//.test(url)) return { code: 200, body: { displayName: '空野 太郎' } };
      return { code: 200, body: {} };
    }
  });
  e.replyCode = o.reply || 200;
  return e;
}
const ev = (type, fields = {}) => Object.assign({ type, webhookEventId: ulid(), timestamp: Date.now(), mode: 'active',
  replyToken: crypto.randomBytes(16).toString('hex'), source: { type: 'user', userId: USER }, deliveryContext: { isRedelivery: false } }, fields);
const postback = (d) => ev('postback', { postback: { data: d } });
const text = (t) => ev('message', { message: { type: 'text', id: '1', text: t } });
const post = (e, events) => e.doPost({ destination: BOT, events: [].concat(events) });
const opRows = (e) => (e.sheets[OPLOG] ? e.sheets[OPLOG].data.slice(1).map((r) => ({ at: r[0], id: r[1], type: r[2], op: r[3], result: r[4], cause: r[5], ms: r[6] })) : []);
const errRows = (e) => (e.sheets[ERRLOG] ? e.rows(ERRLOG) : []);
const replies = (e) => e.linePosts('/v2/bot/message/reply');
const allLogText = (e) => JSON.stringify([e.sheets[OPLOG] && e.sheets[OPLOG].data, e.sheets[ERRLOG] && e.sheets[ERRLOG].data, e.logs]);

/* ---------- LINE操作ログ ---------- */

test('LINE操作ログ：シートを作成し、7列（日時/追跡ID/イベント種別/操作名/処理結果/原因コード/処理時間ms）で記録', () => {
  const e = env();
  post(e, postback('a=rsv_start'));
  assert.deepEqual([...e.sheets[OPLOG].data[0]], ['日時', '追跡ID', 'イベント種別', '操作名', '処理結果', '原因コード', '処理時間ms']);
});

test('1. 予約確認 postback：受信 → 開始 → 返信成功 → 正常終了（同じ追跡ID）', () => {
  const e = env();
  const x = postback('a=rsv_start');
  post(e, x);
  const rows = opRows(e);
  assert.deepEqual(rows.map((r) => r.result), ['受信', '開始', '開始', '返信成功', '正常終了']);
  assert.ok(rows.every((r) => r.id === x.webhookEventId && r.type === 'postback'));
  assert.equal(rows[0].op, 'postback：予約確認の開始');
  assert.match(rows[2].op, /予約確認の開始（予約IDの入力案内）/);
  assert.equal(rows[4].cause, '');
  assert.ok(rows.every((r) => typeof r.ms === 'number' && r.ms >= 0));
  assert.equal(errRows(e).length, 0);
});

test('2. 問い合わせ postback：問い合わせメニューの開始を記録し、返信も従来どおり', () => {
  const e = env();
  post(e, postback('a=inq_start'));
  const rows = opRows(e);
  assert.equal(rows[0].op, 'postback：問い合わせメニューの開始');
  assert.deepEqual(rows.map((r) => r.result).slice(-2), ['返信成功', '正常終了']);
  assert.deepEqual(replies(e)[0].json.messages[0].quickReply.items.map((i) => i.action.label),
    ['チャーター見積', 'フライト予約について', 'その他のお問い合わせ', 'オペレーターに相談']);
  post(e, postback('a=inq_cat&c=4'));
  assert.ok(opRows(e).some((r) => r.op === '問い合わせ項目：チャーター見積' && r.result === '開始'));
});

test('3. 自動返信有効=FALSE：返信せず、LINE操作ログに「設定により停止」、エラーログに CONFIG_WARNING（6時間に1件）', () => {
  const e = env();
  e.sheets['問い合わせ管理'].data[0].push('自動返信有効');
  e.sheets['問い合わせ管理'].data.push(['INQ-20261106-0001', USER, '2026-11-06 10:00:00', 'オペレーター相談', 'x', '未対応', '', '', '', false]);
  post(e, postback('a=rsv_start'));
  post(e, postback('a=inq_start'));
  post(e, text('こんにちは'));
  assert.equal(replies(e).length, 0, '返信しない（既存動作）');
  const byId = {};
  opRows(e).forEach((r) => { byId[r.id] = r; }); // 追跡IDごとの最終行
  const finals = Object.values(byId);
  assert.equal(finals.length, 3);
  assert.ok(finals.every((r) => r.result === '設定により停止' && r.cause === 'AUTO_REPLY_DISABLED'));
  const w = errRows(e);
  assert.equal(w.length, 1, '同じ顧客・同じ受付IDの設定警告は1件にまとめる');
  assert.equal(w[0]['重要度'], 'CONFIG_WARNING');
  assert.equal(w[0]['原因コード'], 'AUTO_REPLY_DISABLED');
  assert.equal(w[0]['処理結果'], '設定により停止');
  assert.equal(w[0]['関連設定キー'], '問い合わせ管理:自動返信有効');
  assert.equal(w[0]['関連ID'], 'id:INQ-20261106-0001');
  assert.match(w[0]['エラーメッセージ'], /自動返信有効が FALSE/);
  assert.ok(!w.some((r) => r['重要度'] === 'ERROR'), 'ERROR としては記録しない');
});

test('4. RESERVATION_CHECK_MODE=OFF：既存動作（予約内容を表示せずオペレーター案内）を維持し、エラーログには残さない', () => {
  const e = env();
  e.sheets['予約管理'].data.push(['SKY-20261201-A1B2C3', USER, 'P1', '東京夜景', '2026-12-01', '18:00', 2, 1, '予約確定', '', '', '']);
  post(e, postback('a=rsv_start'));
  post(e, text('SKY-20261201-A1B2C3'));
  const m = replies(e).pop().json.messages[0];
  assert.match(m.text, /準備中/);
  assert.doesNotMatch(m.text, /東京夜景/);
  const rows = opRows(e);
  assert.ok(rows.some((r) => r.result === '設定により停止' && r.cause === 'RESERVATION_CHECK_OFF'));
  assert.equal(rows[rows.length - 1].result, '正常終了', '案内は返信しているので正常終了');
  assert.equal(rows[rows.length - 1].cause, 'RESERVATION_CHECK_OFF');
  assert.equal(errRows(e).length, 0, 'OFF は正常な運用設定');
  // 不正な値は設定警告
  e.setSetting('RESERVATION_CHECK_MODE', 'TRUE');
  post(e, postback('a=rsv_start'));
  post(e, text('SKY-20261201-A1B2C3'));
  assert.doesNotMatch(replies(e).pop().json.messages[0].text, /東京夜景/, '不正値でも表示しない');
  const w = errRows(e);
  assert.equal(w.length, 1);
  assert.equal(w[0]['重要度'], 'CONFIG_WARNING');
  assert.equal(w[0]['原因コード'], 'CONFIG_INVALID');
  assert.equal(w[0]['関連設定キー'], 'RESERVATION_CHECK_MODE');
});

test('5・6. LINE API の HTTP 400・401・429・500：原因コードと HTTP ステータスを記録し、返信成功とは記録しない', () => {
  const cases = [
    [400, { message: 'The request body has 1 error(s)' }, 'LINE_API_400', 'ERROR'],
    [400, { message: 'Invalid reply token' }, 'LINE_API_400_INVALID_REPLY_TOKEN', 'WARNING'],
    [401, { message: 'Authentication failed' }, 'LINE_API_401', 'ERROR'],
    [429, { message: 'Too Many Requests' }, 'LINE_API_429', 'ERROR'],
    [500, { message: 'Internal Server Error' }, 'LINE_API_5XX', 'ERROR']
  ];
  for (const [code, body, cause, level] of cases) {
    const e = env({ reply: code, replyBody: body });
    post(e, postback('a=inq_start'));
    const rows = opRows(e);
    if (cause === 'LINE_API_400_INVALID_REPLY_TOKEN') {
      assert.equal(rows.length, 0, '偽装・期限切れの応答トークンは LINE操作ログに書かない（エラーログの WARNING のみ）');
      const w = errRows(e);
      assert.equal(w.length, 1);
      assert.equal(w[0]['重要度'], 'WARNING');
      assert.equal(w[0]['原因コード'], cause);
      continue;
    }
    assert.ok(!rows.some((r) => r.result === '返信成功'), code + ' は返信成功にしない');
    assert.ok(rows.some((r) => r.result === '返信失敗' && r.cause === cause), code + ' 返信失敗');
    assert.equal(rows[rows.length - 1].result, '異常終了');
    const er = errRows(e);
    assert.equal(er.length, 1, String(code));
    assert.equal(er[0]['重要度'], level);
    assert.equal(er[0]['原因コード'], cause);
    if (level === 'ERROR') assert.equal(er[0]['HTTPステータス'], code);
    assert.equal(er[0]['追跡ID'], rows[0].id);
  }
  // 成功時だけ返信成功
  const ok = env();
  post(ok, postback('a=inq_start'));
  assert.equal(opRows(ok).filter((r) => r.result === '返信成功').length, 1);
});

test('通信エラー（UrlFetchApp の例外）は LINE_API_NETWORK。再送で再処理できる（イベントの処理済み登録を解除）', () => {
  const e = env();
  e.setFetch((url) => { if (url.indexOf('/reply') !== -1) throw new Error('Address unavailable'); return { code: 200, body: {} }; });
  const x = postback('a=inq_start');
  post(e, x);
  assert.equal(errRows(e)[0]['原因コード'], 'LINE_API_NETWORK');
  assert.equal(e.cache.get('evt:' + x.webhookEventId) || null, null);
});

test('7. Webhook 処理中の例外：WEBHOOK_EXCEPTION として記録し、LINE操作ログは異常終了', () => {
  const e = env();
  e.ctx.buildAutoReply_ = () => { throw new Error('boom'); };
  post(e, text('予約'));
  const er = errRows(e);
  assert.equal(er.length, 1);
  assert.equal(er[0]['原因コード'], 'WEBHOOK_EXCEPTION');
  assert.equal(er[0]['イベント種別'], 'message');
  const last = opRows(e).pop();
  assert.equal(last.result, '異常終了');
  assert.equal(last.cause, 'WEBHOOK_EXCEPTION');
});

test('8. 未対応の postback：返信しない（既存動作）が、WARNING（UNSUPPORTED_POSTBACK）とLINE操作ログに記録', () => {
  const e = env();
  post(e, postback('a=old_menu_button&x=1'));
  assert.equal(replies(e).length, 0);
  const rows = opRows(e);
  assert.equal(rows[0].op, 'postback（未対応: old_menu_button）');
  assert.equal(rows[rows.length - 1].result, '返信なし');
  assert.equal(rows[rows.length - 1].cause, 'UNSUPPORTED_POSTBACK');
  const er = errRows(e);
  assert.equal(er.length, 1, '「返信なし」の警告と二重に記録しない');
  assert.equal(er[0]['重要度'], 'WARNING');
  assert.equal(er[0]['原因コード'], 'UNSUPPORTED_POSTBACK');
  assert.match(er[0]['エラー詳細・スタックトレース'], /old_menu_button/);
  // a= を変えた大量の偽装 postback でもエラーログは増えない（10分に1件）
  for (let i = 0; i < 5; i++) post(e, postback('a=spoof' + i));
  assert.equal(errRows(e).length, 1);
});

test('9. ログの保存に失敗しても LINE の返信・既存の処理は続く', () => {
  const e = env({ failInsert: true }); // エラーログ・LINE操作ログのシートを作成できない
  post(e, postback('a=inq_start'));
  post(e, postback('a=unknown_x'));
  assert.equal(replies(e).length, 1, '返信は送られる');
  assert.equal(e.sheets[OPLOG], undefined);
  assert.ok(e.logs.some((l) => /oplog\.write_failed|errorlog\.write_failed/.test(l)));
  // 問い合わせの受付・保存も行われる
  post(e, postback('a=inq_cat&c=5'));
  post(e, text('団体利用の相談です'));
  assert.equal(e.rows('問い合わせ管理').length, 1);
});

test('11. 既存のエラーログ（8列・既存行）を消さず、不足列だけ末尾に補完', () => {
  const e = env();
  const old = [['発生日時', '重要度', '発生元', '関数名', 'エラーメッセージ', 'エラー詳細・スタックトレース', '関連ID', '対応状況'],
    ['2026-10-21 16:00:19', 'ERROR', '管理メニュー（動作確認）', 'adminErrorLogTest_', 'テストエラー', 'コード: errorlog.test', 'action:errorLogTest', '対応済み']];
  e.ctx.SpreadsheetApp.openById('x').insertSheet(ERRLOG);
  old.forEach((r) => e.sheets[ERRLOG].data.push(r.slice()));
  e.ctx.logError_('faq.read', new Error('x'));
  const d = e.sheets[ERRLOG].data;
  assert.deepEqual(d[1].slice(0, 8), old[1], '既存行は変更しない');
  assert.deepEqual(d[0].slice(0, 8), old[0]);
  assert.deepEqual(d[0].slice(8), ['イベント種別', '追跡ID', '原因コード', '処理結果', '関連設定キー', 'HTTPステータス']);
  assert.equal(d.length, 3);
});

test('13. 再送 Webhook（同じ webhookEventId）は処理・ログとも1回だけ', () => {
  const e = env();
  const x = postback('a=inq_start');
  post(e, x);
  post(e, Object.assign({}, x, { deliveryContext: { isRedelivery: true } }));
  assert.equal(replies(e).length, 1);
  assert.equal(opRows(e).filter((r) => r.result === '受信').length, 1);
});

test('14. ログにアクセストークン・応答トークン・LINE ユーザーID・メッセージ本文を残さない', () => {
  const e = env({ reply: 500 });
  const x = text('090-1234-5678 taro@example.com こんにちは');
  post(e, x);
  e.replyCode = 200;
  e.sheets['問い合わせ管理'].data[0].push('自動返信有効');
  e.sheets['問い合わせ管理'].data.push(['INQ-20261106-0009', USER, '2026-11-06 10:00:00', 'オペレーター相談', 'x', '未対応', '', '', '', false]);
  post(e, text('秘密の相談内容です'));
  const sheetsText = JSON.stringify([e.sheets[OPLOG].data, e.sheets[ERRLOG].data]);
  for (const s of [TOKEN, x.replyToken, USER, '090-1234-5678', 'taro@example.com', 'こんにちは', '秘密の相談内容']) {
    assert.ok(!sheetsText.includes(s), s + ' がシートに記録されている');
  }
  assert.ok(!allLogText(e).includes(TOKEN));
});

test('12. リッチメニュー4ボタンの動作と座標は変わらない', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://sky-standard-test-677788669305.asia-northeast1.run.app/');
  e.setSetting('FAQ_PAGE_URL', 'https://sky-standard-test-677788669305.asia-northeast1.run.app/');
  const d = e.ctx.buildRichMenuDefinition_().definition;
  assert.deepEqual(JSON.parse(JSON.stringify(d.areas.map((a) => [a.bounds.x, a.bounds.y, a.bounds.width, a.bounds.height, a.action.type, a.action.uri || a.action.data]))), [
    [0, 0, 2500, 885, 'uri', 'https://sky-standard-test-677788669305.asia-northeast1.run.app/'],
    [0, 885, 833, 801, 'postback', 'a=rsv_start'],
    [833, 885, 833, 801, 'postback', 'a=inq_start'],
    [1666, 885, 834, 801, 'uri', 'https://sky-standard-test-677788669305.asia-northeast1.run.app/']]);
});

/* ---------- LINEシステム診断 ---------- */

function registeredMenu(e, extra) {
  const def = JSON.parse(JSON.stringify(e.ctx.buildRichMenuDefinition_().definition));
  if (extra) def.areas.push(extra);
  return def;
}

test('10. LINEシステム診断：自動返信 FALSE・不正な設定値・未設定の通知先・未対応ボタンを日本語で表示（読み取り専用）', () => {
  const e0 = env();
  const reg = registeredMenu(e0, { bounds: { x: 0, y: 0, width: 1, height: 1 }, action: { type: 'postback', label: '旧ボタン', data: 'a=old_menu' } });
  const e = env({ registered: reg });
  e.sheets['問い合わせ管理'].data[0].push('自動返信有効');
  e.sheets['問い合わせ管理'].data.push(['INQ-20261106-0001', USER, '2026-11-06 10:00:00', 'オペレーター相談', 'x', '未対応', '', '', '', false]);
  e.setSetting('RESERVATION_CHECK_MODE', 'yes');
  e.setSetting('BOOKING_SITE_URL', 'http://insecure.example');
  e.ctx.logError_('faq.read', new Error('x'));
  const before = JSON.stringify(Object.fromEntries(Object.entries(e.sheets).map(([k, v]) => [k, v.data])));
  const propsBefore = JSON.stringify(e.props);
  const nPosts = e.fetchCalls.filter((c) => (c.params.method || 'get') !== 'get').length;
  const r = e.ctx.adminRun('lineDiagnose');
  assert.equal(r.title, 'LINEシステム診断');
  assert.equal(r.ok, false);
  const m = r.message;
  assert.match(m, /1 名の顧客の自動返信が停止中です（自動返信有効=FALSE。判定行の受付ID：INQ-20261106-0001）/);
  assert.match(m, /RESERVATION_CHECK_MODE の値「yes」が正しくありません/);
  assert.match(m, /BOOKING_SITE_URL の値が https の URL ではありません/);
  assert.match(m, /運営通知の送信先.*未設定です/);
  assert.match(m, /このコードが処理できないボタンがあります：旧ボタン（a=old_menu）/);
  assert.match(m, /◆ Webhook（LINE → GAS）[\s\S]*GAS には何も記録されません/);
  assert.match(m, /【OK】チャネルアクセストークンは有効です/);
  assert.match(m, /エラーログ 24時間：FATAL 0 \/ ERROR 1/);
  assert.match(m, /対応が必要な設定キー：.*RESERVATION_CHECK_MODE/);
  assert.match(m, /対応が必要な設定キー：.*問い合わせ管理:自動返信有効/);
  // 読み取り専用：シート・プロパティを変更せず、LINE には GET しか送らない
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(e.sheets).map(([k, v]) => [k, v.data]))), before);
  assert.equal(JSON.stringify(e.props), propsBefore);
  assert.equal(e.fetchCalls.filter((c) => (c.params.method || 'get') !== 'get').length, nPosts);
  assert.ok(!m.includes(TOKEN));
});

test('LINEシステム診断：RESERVATION_CHECK_MODE=OFF は正常な設定として扱う。トークン未設定・401 は要対応', () => {
  const e = env({ registered: null });
  e.setSetting('RESERVATION_CHECK_MODE', 'OFF');
  const m = e.ctx.adminRun('lineDiagnose').message;
  assert.match(m, /【OK】RESERVATION_CHECK_MODE＝OFF（予約内容は表示せず、予約IDを添えてオペレーターへ案内する運用。現在の正常な設定です）/);
  assert.doesNotMatch(m, /【要対応】[^\n]*RESERVATION_CHECK_MODE/);
  const e2 = env({ props: { LINE_CHANNEL_ACCESS_TOKEN: '' } });
  assert.match(e2.ctx.adminRun('lineDiagnose').message, /【要対応】スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN が未設定です/);
  const e3 = env();
  e3.setFetch((url) => (/\/v2\/bot\/info$/.test(url) ? { code: 401, body: { message: 'Authentication failed' } } : { code: 404, body: {} }));
  assert.match(e3.ctx.adminRun('lineDiagnose').message, /【要対応】チャネルアクセストークンが無効です（HTTP 401）/);
});

test('LINEシステム診断：LINE操作ログの24時間集計（返信失敗・返信なし・設定により停止）', () => {
  const e = env();
  post(e, postback('a=inq_start'));
  post(e, postback('a=unknown_y'));
  e.replyCode = 500;
  post(e, postback('a=inq_start'));
  const m = e.ctx.adminRun('lineDiagnose').message;
  assert.match(m, /LINE操作ログ 24時間：受信 3 \/ 返信成功 1 \/ 返信失敗 1 \/ 返信なし 1/);
  assert.match(m, /直近24時間に返信失敗・異常終了があります/);
});

test('管理者以外は LINEシステム診断を実行できない', () => {
  const e = env();
  e.setUser('someone@example.com');
  const r = e.ctx.adminRun('lineDiagnose');
  assert.equal(r.denied, true);
});

test('シート補完で LINE操作ログを作成し、エラーログに不足列を補完（既存データは変更しない）', () => {
  const e = env();
  const r = e.ctx.adminRun('setupSheets');
  assert.match(r.message, /LINE操作ログシート：新規作成しました/);
  assert.deepEqual([...e.sheets[OPLOG].data[0]], ['日時', '追跡ID', 'イベント種別', '操作名', '処理結果', '原因コード', '処理時間ms']);
  assert.match(e.ctx.adminRun('setupSheets').message, /LINE操作ログシート：作成済み/);
});

test('LINE操作ログの行数：1操作あたり3〜7行（README の表と一致）', () => {
  const e = env({ props: { ADMIN_EMAIL: 'ops@example.com' } });
  const n = () => (e.sheets[OPLOG] ? e.sheets[OPLOG].data.length - 1 : 0);
  const count = (x) => { const a = n(); post(e, x); return n() - a; };
  assert.equal(count(ev('follow')), 4);
  assert.equal(count(postback('a=rsv_start')), 5);
  assert.equal(count(text('SKY-20261201-A1B2C3')), 5); // OFF
  assert.equal(count(postback('a=inq_start')), 4);
  assert.equal(count(postback('a=inq_cat&c=5')), 5);
  assert.equal(count(text('団体の相談')), 5); // 受付
  assert.equal(count(text('こんにちは')), 3); // 自動返信有効=FALSE
  assert.equal(count(postback('a=zzz')), 3, '停止中は未対応 postback も3行'); // 停止中
});
