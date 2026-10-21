/**
 * リッチメニュー（準備中表示・タップ領域・画像検査・登録）のモックテスト。
 * LINE への実際の登録は行わない（LINE API はすべてモック）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv, relayEnvelope, fakeImage } = require('./helpers/gas-env');

const USER = 'U' + 'a'.repeat(32);
const BOT = 'U' + 'f'.repeat(32);
const IMG_ID = '1eeeCZj8orlRinPwtS7nV-7z2G_-aFspY';

function env(opts = {}) {
  const e = createGasEnv({
    props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: 'tok', RELAY_SHARED_SECRET: 'r',
      SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, opts.props || {}),
    fetch: opts.fetch || ((url) => (/\/v2\/bot\/user\/all\/richmenu$/.test(url) ? { code: 404, body: { message: 'not found' } } : { code: 200, body: {} })),
    driveFiles: opts.driveFiles || { [IMG_ID]: { name: 'SKY_STANDARD_RICHMENU_2500x1686.jpg', contentType: 'image/jpeg', bytes: fakeImage('jpeg', 2500, 1686) } }
  });
  e.setSetting('RICHMENU_IMAGE_FILE_ID', IMG_ID);
  return e;
}
const areasOf = (e) => JSON.parse(JSON.stringify(e.ctx.buildRichMenuDefinition_().definition.areas));

/* ---------- タップ領域 ---------- */

test('タップ領域は 3列×2行で全面（2500×1686）を重なり・隙間なく覆う', () => {
  const a = areasOf(env());
  assert.equal(a.length, 6);
  const cover = new Map();
  let total = 0;
  a.forEach((x) => {
    total += x.bounds.width * x.bounds.height;
    assert.ok(x.bounds.x >= 0 && x.bounds.y >= 0 && x.bounds.x + x.bounds.width <= 2500 && x.bounds.y + x.bounds.height <= 1686);
  });
  assert.equal(total, 2500 * 1686);
  // 重なりがない（各行・各列の境界が一致）
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    const p = a[i].bounds, q = a[j].bounds;
    const overlap = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    assert.equal(overlap, false, i + ' と ' + j + ' が重なっています');
  }
  void cover;
});

test('タップ領域は画像の各セル（実測した絵柄の範囲）を完全に含み、区切りは白い余白の中にある', () => {
  // 2026-10-21 実測：列の絵柄 x=15〜829 / 844〜1658 / 1673〜2487、行の絵柄 y=10〜832 / 844〜1670
  const cols = [[15, 829], [844, 1658], [1673, 2487]];
  const rows = [[10, 832], [844, 1670]];
  const a = areasOf(env());
  a.forEach((x, i) => {
    const c = cols[i % 3], r = rows[Math.floor(i / 3)], b = x.bounds;
    assert.ok(b.x <= c[0] && b.x + b.width - 1 >= c[1], x.action.label + ' の横方向');
    assert.ok(b.y <= r[0] && b.y + b.height - 1 >= r[1], x.action.label + ' の縦方向');
  });
  assert.deepEqual(a.map((x) => x.action.label), ['フライト予約', '予約確認', 'プラン一覧', 'チャーター', 'お問い合わせ', 'よくある質問']);
  assert.deepEqual(a.map((x) => [x.bounds.x, x.bounds.y, x.bounds.width, x.bounds.height]),
    [[0, 0, 837, 838], [837, 0, 829, 838], [1666, 0, 834, 838], [0, 838, 837, 848], [837, 838, 829, 848], [1666, 838, 834, 848]]);
});

/* ---------- ボタンの動作 ---------- */

test('URL 未設定でも6ボタンを登録できる：4つは準備中 postback、お問い合わせ・FAQ はメッセージ送信', () => {
  const a = areasOf(env());
  assert.deepEqual(a.map((x) => x.action.type), ['postback', 'postback', 'postback', 'postback', 'message', 'message']);
  assert.deepEqual(a.slice(0, 4).map((x) => x.action.data),
    ['a=menu_unset&item=BOOKING', 'a=menu_unset&item=BOOKING_CHECK', 'a=menu_unset&item=PLANS', 'a=menu_unset&item=CHARTER']);
  assert.deepEqual(a.slice(0, 4).map((x) => x.action.displayText), ['フライト予約', '予約確認', 'プラン一覧', 'チャーター']);
  assert.equal(a[4].action.text, 'お問い合わせ');
  assert.equal(a[5].action.text, 'FAQ');
  // LINE の上限（label 20 / data 300 / displayText 300 文字）
  a.forEach((x) => {
    assert.ok(x.action.label.length <= 20);
    if (x.action.data) assert.ok(x.action.data.length <= 300);
  });
  assert.deepEqual([...env().ctx.buildRichMenuDefinition_().unset], ['フライト予約', '予約確認', 'プラン一覧', 'チャーター']);
});

test('予約サイト完成後は URL を設定するだけでリンク方式に切り替わる（予約確認は LIFF を優先）', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://sky-standard.example/booking');
  e.setSetting('BOOKING_CONFIRM_URL', 'https://sky-standard.example/mypage');
  e.setSetting('PLAN_LIST_URL', 'https://sky-standard.example/plans');
  e.setSetting('CHARTER_URL', 'https://sky-standard.example/charter');
  let a = areasOf(e);
  assert.deepEqual(a.slice(0, 4).map((x) => [x.action.type, x.action.uri]), [
    ['uri', 'https://sky-standard.example/booking'], ['uri', 'https://sky-standard.example/mypage'],
    ['uri', 'https://sky-standard.example/plans'], ['uri', 'https://sky-standard.example/charter']]);
  e.setSetting('LIFF_ID', '1234567890-AbCdEf');
  a = areasOf(e);
  assert.equal(a[1].action.uri, 'https://liff.line.me/1234567890-AbCdEf');
  // 一部だけ設定した場合はそのボタンだけ切り替わる
  const e2 = env();
  e2.setSetting('CHARTER_URL', 'https://sky-standard.example/charter');
  assert.deepEqual(areasOf(e2).slice(0, 4).map((x) => x.action.type), ['postback', 'postback', 'postback', 'uri']);
});

/* ---------- タップ時の返信（Webhook） ---------- */

const ulid = () => crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26);
function tap(e, data) {
  e.doPost({ destination: BOT, events: [{ type: 'postback', webhookEventId: ulid(), timestamp: Date.now(),
    replyToken: crypto.randomBytes(16).toString('hex'), source: { type: 'user', userId: USER }, postback: { data } }] });
  const r = e.linePosts('/v2/bot/message/reply');
  return r[r.length - 1].json.messages;
}

test('準備中ボタンをタップすると項目名に応じた「現在準備中です」を返信', () => {
  const e = env();
  const expect = { BOOKING: 'フライト予約', BOOKING_CHECK: '予約確認', PLANS: 'プラン一覧', CHARTER: 'チャーター' };
  Object.keys(expect).forEach((k) => {
    const m = tap(e, 'a=menu_unset&item=' + k)[0];
    assert.match(m.text, new RegExp('^「' + expect[k] + '」は現在準備中です。'));
    assert.ok(m.quickReply.items.some((i) => i.action.data === 'a=inq_start'));
  });
  const charter = tap(e, 'a=menu_unset&item=CHARTER')[0];
  assert.ok(charter.quickReply.items.some((i) => i.action.data === 'a=inq_cat&c=4'));
  assert.equal(e.rows('問い合わせ管理').length, 0); // 返信のみで記録しない
});

test('旧形式（item=表示名）にも対応し、未知の item は文面に反映しない', () => {
  const e = env();
  assert.match(tap(e, 'a=menu_unset&item=' + encodeURIComponent('プラン一覧'))[0].text, /^「プラン一覧」は現在準備中です/);
  const m = tap(e, 'a=menu_unset&item=' + encodeURIComponent('<偽の案内>こちらへ'))[0];
  assert.equal(m.text, 'このメニューは現在準備中です。お手数ですが「お問い合わせ」からご連絡ください。');
});

test('URL を設定後、LINE 側の再登録前に準備中ボタンがタップされたらリンクを案内', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://sky-standard.example/booking');
  const m = tap(e, 'a=menu_unset&item=BOOKING');
  assert.equal(m[0].template.actions[0].uri, 'https://sky-standard.example/booking');
});

test('通知テンプレート MENU_PENDING_<KEY> が有効なら、その文面で返信（運用で変更可能）', () => {
  const e = env();
  e.sheets['通知テンプレート'].data.push(['MENU_PENDING_PLANS', 'リッチメニュー準備中', 'タップ時', 'プランは12月公開予定です。', 'ON', '']);
  assert.equal(tap(e, 'a=menu_unset&item=PLANS')[0].text, 'プランは12月公開予定です。');
});

test('リッチメニューの「お問い合わせ」「よくある質問」は既存フローを起動', () => {
  const e = env();
  e.doPost(relayEnvelope({ destination: BOT, events: [{ type: 'message', webhookEventId: 'q1', replyToken: 'rt1', source: { type: 'user', userId: USER }, message: { type: 'text', text: 'お問い合わせ' } }] }, 'r'));
  let r = e.linePosts('/v2/bot/message/reply').pop().json.messages[0];
  assert.deepEqual(r.quickReply.items.map((i) => i.action.label), ['フライト予約について', '予約内容の確認・変更', '天候・運航について', 'チャーター見積', 'その他のお問い合わせ', 'オペレーターに相談']);
  e.doPost(relayEnvelope({ destination: BOT, events: [{ type: 'message', webhookEventId: 'q2', replyToken: 'rt2', source: { type: 'user', userId: USER }, message: { type: 'text', text: 'FAQ' } }] }, 'r'));
  r = e.linePosts('/v2/bot/message/reply').pop().json.messages[0];
  assert.match(r.text, /よくある質問/);
  assert.ok(r.quickReply.items.some((i) => i.action.data === 'a=faq&id=F001'));
});

test('準備中ボタンのタップはエラーログに記録しない', () => {
  const e = env();
  tap(e, 'a=menu_unset&item=BOOKING');
  assert.equal(e.sheets['エラーログ'], undefined);
});

/* ---------- 画像の検査 ---------- */

test('画像検査：提供画像と同じ JPEG 2500×1686・1MB 以下は OK', () => {
  const r = env().ctx.validateRichMenuImage_();
  assert.equal(r.ok, true);
  assert.equal(r.width, 2500);
  assert.equal(r.height, 1686);
  assert.equal(r.type, 'image/jpeg');
});

test('画像検査：サイズ違い・1MB 超・PNG/JPEG 以外・ファイルなしは NG（日本語で表示）', () => {
  const mk = (bytes, ct) => env({ driveFiles: { [IMG_ID]: { name: 'x', contentType: ct, bytes } } }).ctx.validateRichMenuImage_();
  assert.match(mk(fakeImage('png', 2500, 843), 'image/png').problems.join(), /2500×1686px にしてください（現在: 2500×843px）/);
  assert.match(mk(fakeImage('jpeg', 2500, 1686, 1200 * 1024), 'image/jpeg').problems.join(), /1MB 以下/);
  assert.match(mk(Buffer.from('GIF89a' + 'x'.repeat(100)), 'image/gif').problems.join(), /PNG または JPEG/);
  const none = env({ driveFiles: {} }).ctx.validateRichMenuImage_();
  assert.equal(none.ok, false);
  assert.match(none.problems[0], /Google ドライブの画像を開けません/);
  assert.equal(mk(fakeImage('png', 2500, 1686), 'image/png').ok, true);
});

test('画像に問題があれば LINE には何も作らずに止める', () => {
  const e = env({ driveFiles: { [IMG_ID]: { name: 'x', contentType: 'image/jpeg', bytes: fakeImage('jpeg', 1200, 810) } } });
  const r = e.ctx.adminRun('richMenuDeploy');
  assert.equal(r.ok, false);
  assert.match(r.message, /画像サイズを 2500×1686px にしてください/);
  assert.equal(e.fetchCalls.filter((c) => /api(-data)?\.line\.me/.test(c.url)).length, 0);
});

/* ---------- 設定確認（LINE に登録しない） ---------- */

test('リッチメニュー設定確認は LINE に登録しない（GET のみ）。準備中・画像・未登録を表示', () => {
  const e = env();
  const r = e.ctx.adminRun('richMenuCheck');
  assert.equal(r.ok, true);
  assert.match(r.message, /【準備中】フライト予約 → 「現在準備中です」を返信（URL 未設定）\n    タップ領域 x:0〜836 \/ y:0〜837/);
  assert.match(r.message, /【OK】お問い合わせ → メッセージ「お問い合わせ」を送信/);
  assert.match(r.message, /【OK】SKY_STANDARD_RICHMENU_2500x1686\.jpg（image\/jpeg・2500×1686px・400KB）/);
  assert.match(r.message, /【未登録】既定のリッチメニューはまだ登録されていません/);
  assert.match(r.message, /URL を入力し、「リッチメニュー登録・更新」を実行するとリンク方式に切り替わります/);
  const lineCalls = e.fetchCalls.filter((c) => /api(-data)?\.line\.me/.test(c.url));
  assert.ok(lineCalls.length > 0);
  assert.ok(lineCalls.every((c) => (c.params.method || 'get') === 'get'));
});

test('登録済みメニューと比較：URL 設定後は「要再登録」、一致していれば OK', () => {
  let registered = null;
  const fetch = (url) => {
    if (/\/v2\/bot\/user\/all\/richmenu$/.test(url)) return { code: 200, body: { richMenuId: 'richmenu-abc' } };
    if (/\/v2\/bot\/richmenu\/richmenu-abc$/.test(url)) return { code: 200, body: registered };
    return { code: 200, body: {} };
  };
  const e = env({ fetch });
  registered = JSON.parse(JSON.stringify(e.ctx.buildRichMenuDefinition_().definition));
  assert.match(e.ctx.adminRun('richMenuCheck').message, /【OK】登録済みの内容は現在の設定と一致しています（ID: richmenu-abc）/);
  e.setSetting('BOOKING_SITE_URL', 'https://sky-standard.example/booking');
  const m = e.ctx.adminRun('richMenuCheck').message;
  assert.match(m, /【要再登録】/);
  assert.match(m, /フライト予約: 準備中表示 → リンク に切り替えが必要/);
});

/* ---------- 登録（モック） ---------- */

test('登録：検証→作成→画像アップロード（JPEG）→既定に設定→旧メニュー削除、シートの実装状態を更新', () => {
  const calls = [];
  const fetch = (url, p) => {
    calls.push((p.method || 'get') + ' ' + url.replace(/^https:\/\/api(-data)?\.line\.me/, ''));
    if (/\/v2\/bot\/user\/all\/richmenu$/.test(url) && (p.method || 'get') === 'get') return { code: 200, body: { richMenuId: 'richmenu-old' } };
    if (/\/v2\/bot\/richmenu$/.test(url)) return { code: 200, body: { richMenuId: 'richmenu-new' } };
    return { code: 200, body: {} };
  };
  const e = env({ fetch });
  const r = e.ctx.adminRun('richMenuDeploy');
  assert.equal(r.ok, true);
  assert.match(r.message, /準備中」と表示されるボタン: フライト予約、予約確認、プラン一覧、チャーター/);
  assert.deepEqual(calls.filter((c) => /richmenu/.test(c)), [
    'get /v2/bot/user/all/richmenu', 'post /v2/bot/richmenu/validate', 'post /v2/bot/richmenu',
    'post /v2/bot/richmenu/richmenu-new/content', 'post /v2/bot/user/all/richmenu/richmenu-new', 'delete /v2/bot/richmenu/richmenu-old']);
  const upload = e.fetchCalls.find((c) => /\/content$/.test(c.url));
  assert.equal(upload.params.contentType, 'image/jpeg');
  const sheet = e.rows('リッチメニュー');
  assert.deepEqual(sheet.map((x) => x['実装状態'].replace(/ \d.*/, '')),
    ['未設定（準備中表示）', '未設定（準備中表示）', '未設定（準備中表示）', '未設定（準備中表示）', '登録済み', '登録済み']);
  // 他の列は変更しない
  assert.equal(sheet[0]['遷移先URL・送信テキスト'], '[予約サイトURL]');
});
