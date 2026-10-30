/**
 * LINE トークでの予約確認（リッチメニュー「予約確認」）のモックテスト。
 * 予約サイト API・LINE API はすべてモック。実際の予約サイト・LINE とは通信しない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv } = require('./helpers/gas-env');

const BOT = 'U' + 'f'.repeat(32);
const USER = 'U' + 'a'.repeat(32);
const OTHER = 'U' + 'b'.repeat(32);
const RID = 'SKY-20261201-A1B2C3';
const API = 'https://api.sky.example';
const GOOD = new Set();

function tok(valid = true) { const t = crypto.randomBytes(16).toString('hex'); if (valid) GOOD.add(t); return t; }
function ulid() { return crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26); }

/** 予約サイトの予約（API が返す形。docs/reservation-api.md） */
const SITE_RESV = {
  reservationId: RID, lineUserId: '', planName: '東京夜景フライト', courseName: '15分コース', flightDate: '2026-12-01',
  timeSlot: '18:00', passengers: 2, status: 'CONFIRMED', statusLabel: '予約確定', amount: 99000,
  changeable: true, cancellable: true, cancellationPolicy: '前日 50%／当日 100%', cancellationFee: '49,500円',
  changeUrl: API + '/reservations/' + RID + '/change', cancelUrl: API + '/reservations/' + RID + '/cancel'
};

/**
 * @param {{api?:boolean, linked?:Object<string,string>, apiDown?:boolean, contact?:string, resv?:Object}} o
 */
function env(o = {}) {
  const state = { linked: Object.assign({}, o.linked || {}), apiCalls: [] };
  const resv = Object.assign({}, SITE_RESV, o.resv || {});
  const e = createGasEnv({
    props: { LINE_CHANNEL_ACCESS_TOKEN: 'tok', SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es',
      RESERVATION_API_KEY: 'api-key-SECRET', RESERVATION_API_ALLOWED_HOST: 'api.sky.example' },
    fetch: (url, params) => {
      if (url.indexOf('/v2/bot/message/reply') !== -1) {
        const t = JSON.parse(params.payload).replyToken;
        if (!GOOD.has(t)) return { code: 400, body: { message: 'Invalid reply token' } };
        GOOD.delete(t);
        return { code: 200, body: {} };
      }
      if (url.indexOf(API) === 0) {
        state.apiCalls.push({ url, method: params.method, body: params.payload ? JSON.parse(params.payload) : null, auth: params.headers.Authorization });
        if (o.apiDown) return { code: 503, body: {} };
        if (url.indexOf('/line/reservations?lineUserId=') !== -1) {
          const uid = decodeURIComponent(url.split('lineUserId=')[1]);
          return { code: 200, body: { reservations: state.linked[RID] === uid ? [Object.assign({}, resv, { lineUserId: uid })] : [] } };
        }
        if (url.indexOf('/line/link') !== -1) {
          const b = JSON.parse(params.payload);
          if (b.reservationId === RID && b.contact === (o.contact || '09012345678')) {
            state.linked[RID] = b.lineUserId;
            return { code: 200, body: { linked: true, reservation: Object.assign({}, resv, { lineUserId: b.lineUserId }) } };
          }
          return { code: 404, body: { linked: false } };
        }
      }
      return { code: 200, body: {} };
    }
  });
  if (o.api) e.setSetting('RESERVATION_API_BASE_URL', API);
  e.state = state;
  return e;
}
function ev(type, fields = {}, valid = true) {
  const base = { type, webhookEventId: ulid(), timestamp: Date.now(), mode: 'active', replyToken: tok(valid),
    source: { type: 'user', userId: fields.userId || USER }, deliveryContext: { isRedelivery: false } };
  delete fields.userId;
  return Object.assign(base, fields);
}
const text = (t, o = {}, v = true) => ev('message', Object.assign({ message: { type: 'text', id: '1', text: t } }, o), v);
const postback = (d, o = {}, v = true) => ev('postback', Object.assign({ postback: { data: d } }, o), v);
const post = (e, events) => e.doPost({ destination: BOT, events: [].concat(events) });
const replies = (e) => e.linePosts('/v2/bot/message/reply');
const last = (e) => replies(e).pop().json.messages;
const lastText = (e) => last(e).map((m) => m.text || (m.template && m.template.text) || '').join('\n');
const qr = (m) => (m.quickReply ? m.quickReply.items.map((i) => i.action) : []);
/** 「予約管理」シートに LINE ユーザーID付きの予約を置く（予約サイト API 未設定時の照会先） */
function sheetResv(e, uid, status = '予約確定', rid = RID) {
  e.sheets['予約管理'].data.push([rid, uid, 'P1', '東京夜景フライト', '2026-12-01', '18:00', 2, 99000, status, '決済完了', '', '']);
}

/* ---------- 3. 予約ID入力の開始 ---------- */

test('予約確認 → 予約IDの入力を案内し、入力待ちにする（10分）。入力をやめるボタン付き', () => {
  const e = env();
  post(e, postback('a=rsv_start'));
  const m = last(e)[0];
  assert.equal(m.text, '🔖 ご予約の確認ですね。\n予約IDを入力してくださいませ。\n（例：SKY-20261101-A1B2C3）');
  assert.deepEqual(qr(m).map((a) => a.data), ['a=rsv_cancel']);
  assert.deepEqual(JSON.parse(e.cache.get('rsv:' + USER)), { step: 'id', n: 0 });
  post(e, postback('a=rsv_cancel'));
  assert.match(lastText(e), /ご予約の確認を終了いたしました/);
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
});

/* ---------- 4. 正しい予約IDの照会 ---------- */

test('LINEアカウントに紐づく予約（予約管理シート）は、予約IDの入力で内容を表示（最小限の項目）＋3ボタン', () => {
  const e = env();
  sheetResv(e, USER);
  post(e, postback('a=rsv_start'));
  post(e, text('ｓｋｙ－２０２６１２０１－ａ１ｂ２ｃ３')); // 全角・小文字でも受け付ける
  const m = last(e)[0];
  assert.equal(m.text, '🔖 ご予約内容\n予約ID：SKY-20261201-A1B2C3\nプラン：東京夜景フライト\n📅 搭乗予定日：2026-12-01\n時間帯：18:00\n人数：2名\n予約状況：予約確定\n\nご希望のお手続きを下記よりお選びくださいませ。');
  assert.doesNotMatch(m.text, /99000|決済|LINEユーザーID|U[0-9a-f]{32}/, '金額・決済・ID は表示しない');
  assert.deepEqual(qr(m).map((a) => [a.label, a.data]), [['予約変更', 'a=rsv_change&rid=' + RID], ['キャンセル', 'a=rsv_cancel_req&rid=' + RID],
    ['オペレーターに相談', 'a=inq_operator&rid=' + RID]]);
  assert.equal(e.cache.get('rsv:' + USER) || null, null, '表示後は入力待ちを終了');
});

test('予約サイト API：紐づく予約はコース名・予約状況（statusLabel）を表示。API キーは Authorization ヘッダーのみ', () => {
  const e = env({ api: true, linked: { [RID]: USER } });
  post(e, [postback('a=rsv_start'), text(RID)]);
  assert.match(lastText(e), /コース：15分コース\n📅 搭乗予定日：2026-12-01\n時間帯：18:00\n人数：2名\n予約状況：予約確定/);
  const call = e.state.apiCalls[0];
  assert.equal(call.url, API + '/line/reservations?lineUserId=' + USER);
  assert.equal(call.auth, 'Bearer api-key-SECRET');
  assert.ok(!e.logs.some((l) => /api-key-SECRET|東京夜景/.test(l)), 'API キー・予約内容をログに出さない');
});

/* ---------- 5. 不正な予約ID ---------- */

test('形式が違う予約IDは再入力を案内し、3回で入力待ちを終了（オペレーター導線）', () => {
  const e = env();
  post(e, postback('a=rsv_start'));
  post(e, text('12345'));
  assert.match(lastText(e), /予約IDの形式が正しくないようでございます/);
  assert.equal(JSON.parse(e.cache.get('rsv:' + USER)).n, 1);
  post(e, text('SKY-2026'));
  post(e, text('ABC'));
  assert.match(lastText(e), /予約IDを確認できませんでした/);
  assert.deepEqual(qr(last(e)[0]).map((a) => a.data), ['a=inq_operator']);
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
});

/* ---------- 6. 本人確認 ---------- */

test('他人の予約ID（シートで別の LINE アカウントに紐づく）は表示せず、存在の有無も答えない', () => {
  const e = env();
  sheetResv(e, OTHER);
  post(e, [postback('a=rsv_start'), text(RID)]);
  const t = lastText(e);
  assert.match(t, /このLINEアカウントでは、該当するご予約を確認できませんでした/);
  assert.doesNotMatch(t, /東京夜景|2026-12-01|予約確定/);
  // 存在しない予約IDでも同じ文面（存在の有無を推測させない）
  const e2 = env();
  post(e2, [postback('a=rsv_start'), text('SKY-20991231-FFFFFF')]);
  assert.equal(lastText(e2), t);
});

test('予約サイト API：未紐づけの予約は電話番号・メールで追加の本人確認 → 一致すれば紐づけて表示', () => {
  const e = env({ api: true });
  post(e, [postback('a=rsv_start'), text(RID)]);
  assert.match(lastText(e), /ご本人様確認のため、ご予約時にご登録の電話番号またはメールアドレスをお送りくださいませ/);
  assert.doesNotMatch(lastText(e), /東京夜景/, '予約IDだけでは表示しない');
  assert.deepEqual(JSON.parse(e.cache.get('rsv:' + USER)), { step: 'contact', rid: RID });
  post(e, text('090-1234-5678'));
  assert.match(lastText(e), /プラン：東京夜景フライト/);
  const link = e.state.apiCalls.find((c) => /\/line\/link$/.test(c.url));
  assert.deepEqual(link.body, { lineUserId: USER, reservationId: RID, contact: '09012345678' });
  assert.ok(!e.logs.some((l) => /09012345678|090-1234-5678/.test(l)), '電話番号をログに出さない');
  // 次回からは紐づけ済みのため追加確認なしで表示
  post(e, [postback('a=rsv_start'), text(RID)]);
  assert.match(lastText(e), /プラン：東京夜景フライト/);
});

test('本人確認に失敗したら予約情報を表示しない。照合は1回ごとに予約IDの入力からやり直し、回数制限あり', () => {
  const e = env({ api: true });
  post(e, [postback('a=rsv_start'), text(RID), text('09099999999')]);
  assert.match(lastText(e), /ご本人様を確認できませんでした/);
  assert.doesNotMatch(lastText(e), /東京夜景|2026-12-01/);
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
  for (let i = 0; i < 4; i++) post(e, [postback('a=rsv_start'), text(RID), text('09099999999')]);
  post(e, [postback('a=rsv_start'), text(RID), text('09012345678')]); // 6回目は正しくても制限
  assert.match(lastText(e), /確認の回数が上限に達しました/);
  assert.doesNotMatch(lastText(e), /東京夜景/);
});

test('偽装イベント（応答トークンが LINE に拒否）では予約内容を受け取れない（プッシュでも送らない）', () => {
  const e = env();
  sheetResv(e, OTHER);
  post(e, [postback('a=rsv_start', { userId: OTHER }, false), text(RID, { userId: OTHER }, false)]);
  assert.equal(e.cache.get('rsv:' + OTHER) || null, null, '偽装イベントで入力待ちにならない');
  e.ctx.setReservationState_(OTHER, { step: 'id', n: 0 });
  post(e, text(RID, { userId: OTHER }, false));
  assert.equal(e.linePosts('/v2/bot/message/push').length, 0);
  assert.ok(e.cache.get('rsv:' + OTHER), '応答が拒否されたら状態も変えない');
});

/* ---------- 7・8. 予約変更・キャンセル ---------- */

test('予約変更：予約サイトの変更画面（予約サイトのホストのみ）へ案内。GAS では変更しない', () => {
  const e = env({ api: true, linked: { [RID]: USER } });
  post(e, postback('a=rsv_change&rid=' + RID));
  const msgs = last(e);
  assert.match(msgs[0].text || msgs[0].template.text, /ご予約の変更は、下記の予約サイトにて承ります/);
  const btn = msgs.find((m) => m.type === 'template');
  assert.equal(btn.template.actions[0].uri, API + '/reservations/' + RID + '/change');
  assert.deepEqual(qr(msgs[msgs.length - 1]).map((a) => a.data), ['a=inq_operator&rid=' + RID]);
  assert.ok(e.state.apiCalls.every((c) => (c.method || 'get') === 'get'), '変更 API は呼ばない');
  // 予約サイト以外のホストの URL は使わない（担当者が承る）
  const e2 = env({ api: true, linked: { [RID]: USER }, resv: { changeUrl: 'https://evil.example/x' } });
  post(e2, postback('a=rsv_change&rid=' + RID));
  assert.match(lastText(e2), /担当者が変更条件と差額を確認のうえ承ります/);
  assert.ok(!last(e2).some((m) => m.type === 'template'));
});

test('予約変更・キャンセル不可：理由と問い合わせ導線を表示', () => {
  const e = env({ api: true, linked: { [RID]: USER }, resv: { changeable: false, changeBlockedReason: '搭乗3日前を過ぎています',
    cancellable: false, cancelBlockedReason: '搭乗済みです' } });
  post(e, postback('a=rsv_change&rid=' + RID));
  assert.match(lastText(e), /現在LINEから変更のお手続きをお受けできません。\n理由：搭乗3日前を過ぎています/);
  assert.deepEqual(qr(last(e)[0]).map((a) => a.data), ['a=inq_operator&rid=' + RID]);
  post(e, postback('a=rsv_cancel_req&rid=' + RID));
  assert.match(lastText(e), /現在LINEからキャンセルのお手続きをお受けできません。\n理由：搭乗済みです/);
  // 予約サイトが可否を返さない（シート）場合は状態で判断：キャンセル済みは不可
  const e2 = env();
  sheetResv(e2, USER, 'キャンセル');
  post(e2, postback('a=rsv_change&rid=' + RID));
  assert.match(lastText(e2), /変更のお手続きをお受けできません/);
});

test('キャンセル：規定・料金を表示して予約サイトの手続き（最終確認）へ案内。ボタンだけでは取り消さない', () => {
  const e = env({ api: true, linked: { [RID]: USER } });
  const before = JSON.stringify(e.sheets['予約管理'].data);
  post(e, postback('a=rsv_cancel_req&rid=' + RID));
  const t = lastText(e);
  assert.match(t, /📋 キャンセルについてのご案内\n前日 50%／当日 100%\nキャンセル料（目安）：49,500円/);
  assert.match(t, /この時点では、ご予約はキャンセルされておりません/);
  assert.equal(last(e).find((m) => m.type === 'template').template.actions[0].uri, API + '/reservations/' + RID + '/cancel');
  assert.equal(JSON.stringify(e.sheets['予約管理'].data), before, '予約データを変更しない');
  assert.ok(e.state.apiCalls.every((c) => (c.method || 'get') === 'get'), '取消 API は呼ばない');
  // 手続き画面がなければ担当者へ
  const e2 = env();
  sheetResv(e2, USER);
  post(e2, postback('a=rsv_cancel_req&rid=' + RID));
  assert.match(lastText(e2), /キャンセル規定・料金は、ご予約のプランにより異なります。[\s\S]*担当者が規定を確認のうえ承ります/);
});

test('予約変更・キャンセルの postback の予約IDは信用しない（他人の予約は表示も案内もしない）', () => {
  const e = env();
  sheetResv(e, OTHER);
  post(e, postback('a=rsv_cancel_req&rid=' + RID));
  assert.match(lastText(e), /ご予約を確認できませんでした/);
  assert.doesNotMatch(lastText(e), /キャンセル料|東京夜景/);
  post(e, postback('a=rsv_change&rid=' + encodeURIComponent('<script>')));
  assert.match(lastText(e), /ご予約を確認できませんでした/);
});

/* ---------- 9. オペレーターに相談（予約から） ---------- */

test('予約内容からオペレーターに相談：予約IDを添えて受付し、有人対応へ（自動返信停止）', () => {
  const e = env();
  sheetResv(e, USER);
  post(e, postback('a=inq_operator&rid=' + RID));
  assert.match(lastText(e), /🔖 対象の予約ID：SKY-20261201-A1B2C3/);
  post(e, text('日程を1週間後ろにずらせますか'));
  const row = e.rows('問い合わせ管理')[0];
  assert.equal(row['内容'], '【予約ID：' + RID + '（本人確認済み）】\n日程を1週間後ろにずらせますか');
  assert.equal(row['自動返信有効'], false);
  assert.match(row['備考'], /予約確認から/);
  const n0 = replies(e).length;
  post(e, [postback('a=rsv_start'), text(RID)]);
  assert.equal(replies(e).length, n0, '有人対応中は予約ID入力も割り込まない');
});

/* ---------- 例外・中断・重複 ---------- */

test('予約サイト API の障害時は安全なエラー案内（予約情報・内部エラーを出さない）、エラーログに記録', () => {
  const e = env({ api: true, apiDown: true });
  post(e, [postback('a=rsv_start'), text(RID)]);
  const t = lastText(e);
  assert.match(t, /ただいまご予約情報を確認できません/);
  assert.doesNotMatch(t, /503|reservation_api|Error/);
  assert.ok(e.rows('エラーログ').some((r) => /reservation_check\.lookup_failed/.test(r['エラー詳細・スタックトレース'])));
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
});

test('予約ID入力中にリッチメニュー（お問い合わせ）や定型語を操作したら入力を中断', () => {
  const e = env();
  post(e, [postback('a=rsv_start'), postback('a=inq_start')]);
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
  post(e, [postback('a=rsv_start'), text('FAQ')]);
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
  assert.match(lastText(e), /よくあるご質問/);
  post(e, [postback('a=inq_cat&c=5'), postback('a=rsv_start')]);
  assert.equal(e.cache.get('inq:' + USER) || null, null, '予約確認を始めると問い合わせ入力を中断');
});

test('同じ Webhook イベントの重複受信は1回だけ処理（予約IDの入力を二重に処理しない）', () => {
  const e = env();
  sheetResv(e, USER);
  post(e, postback('a=rsv_start'));
  const evt = text(RID);
  post(e, evt);
  const n = replies(e).length;
  post(e, Object.assign({}, evt, { deliveryContext: { isRedelivery: true } }));
  assert.equal(replies(e).length, n);
});

test('予約サイト API の URL がキー送信先と一致しなければキーを送らない（設定エラーとして安全に案内）', () => {
  const e = env({ api: true });
  e.setSetting('RESERVATION_API_BASE_URL', 'https://evil.example');
  post(e, [postback('a=rsv_start'), text(RID)]);
  assert.match(lastText(e), /ただいまご予約情報を確認できません/);
  assert.equal(e.state.apiCalls.length, 0);
  assert.ok(!e.fetchCalls.some((c) => /evil\.example/.test(c.url)));
});

test('予約IDが本人の予約と確認できない場合は「お客様申告・本人未確認」と記録する（postback の予約IDを信用しない）', () => {
  const e = env();
  sheetResv(e, OTHER);
  post(e, [postback('a=inq_operator&rid=' + RID), text('この予約について')]);
  assert.match(e.rows('問い合わせ管理')[0]['内容'], /^【予約ID：SKY-20261201-A1B2C3（お客様申告・本人未確認）】/);
});

test('グループ・トークルームでは予約確認・問い合わせ受付を行わない（予約内容をグループに出さない）', () => {
  const e = env();
  sheetResv(e, USER);
  const group = (x) => Object.assign(x, { source: { type: 'group', groupId: 'C' + 'd'.repeat(32), userId: USER } });
  post(e, group(postback('a=rsv_start')));
  assert.match(lastText(e), /1対1/);
  assert.equal(e.cache.get('rsv:' + USER) || null, null);
  post(e, group(text('予約確認')));
  assert.match(lastText(e), /1対1/);
  e.ctx.setReservationState_(USER, { step: 'id', n: 0 }); // 1対1で入力待ちのまま、グループで発言
  post(e, group(text(RID)));
  assert.doesNotMatch(lastText(e), /東京夜景|2026-12-01/);
  post(e, group(postback('a=inq_cat&c=5')));
  assert.match(lastText(e), /1対1/);
  assert.equal(e.rows('問い合わせ管理').length, 0);
});

test('本人確認：+81 の電話番号は国内表記にそろえ、確認後の表示にもコース名・予約状況を含める', () => {
  const e = env({ api: true });
  post(e, [postback('a=rsv_start'), text(RID), text('+81 90-1234-5678')]);
  const link = e.state.apiCalls.find((c) => /\/line\/link$/.test(c.url));
  assert.equal(link.body.contact, '09012345678');
  assert.match(lastText(e), /コース：15分コース[\s\S]*予約状況：予約確定/);
});
