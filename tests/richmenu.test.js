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
const IMG_ID = '17JrCm0unhRnSG2En65jmVSl116Sq4ipf';
const IMG_NAME = '空と都市を巡るヘリチャーター案内.png';
const W = 1543, H = 1019;

function env(opts = {}) {
  const e = createGasEnv({
    props: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: 'tok', RELAY_SHARED_SECRET: 'r',
      SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, opts.props || {}),
    fetch: opts.fetch || ((url) => (/\/v2\/bot\/user\/all\/richmenu$/.test(url) ? { code: 404, body: { message: 'not found' } } : { code: 200, body: {} })),
    // 実画像は PNG 2.2MB（LINE 上限 1MB 超）。GAS の Blob.getAs で JPEG に変換して使う
    driveFiles: opts.driveFiles || { [IMG_ID]: { name: IMG_NAME, contentType: 'image/png', bytes: fakeImage('png', W, H, 2200 * 1024),
      asJpeg: fakeImage('jpeg', W, H, 420 * 1024) } }
  });
  e.setSetting('RICHMENU_IMAGE_FILE_ID', IMG_ID);
  return e;
}
const areasOf = (e) => JSON.parse(JSON.stringify(e.ctx.buildRichMenuDefinition_().definition.areas));

/* ---------- タップ領域 ---------- */

test('タップ領域は4つ（上部全面＋下段3分割）で、画像全面（1543×1019）を重なり・隙間なく覆う', () => {
  const e = env();
  const d = JSON.parse(JSON.stringify(e.ctx.buildRichMenuDefinition_().definition));
  assert.deepEqual(d.size, { width: W, height: H });
  assert.ok(d.size.width >= 800 && d.size.width <= 2500 && d.size.width / d.size.height >= 1.45, 'LINE のサイズ条件');
  const a = d.areas;
  assert.equal(a.length, 4);
  let total = 0;
  a.forEach((x) => {
    total += x.bounds.width * x.bounds.height;
    assert.ok(x.bounds.x >= 0 && x.bounds.y >= 0 && x.bounds.x + x.bounds.width <= W && x.bounds.y + x.bounds.height <= H);
  });
  assert.equal(total, W * H);
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    const p = a[i].bounds, q = a[j].bounds;
    assert.equal(p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height, false, i + ' と ' + j + ' が重なっています');
  }
});

test('タップ判定：画像の各ボタンの絵柄が対応する領域に入り、区切り線（実測 y=535〜536, x=514〜516 / 1028〜1030）が境界', () => {
  const a = areasOf(env());
  assert.deepEqual(a.map((x) => x.action.label), ['ご予約はこちら', '予約確認', 'お問い合わせ', 'よくある質問']);
  assert.deepEqual(a.map((x) => [x.bounds.x, x.bounds.y, x.bounds.width, x.bounds.height]),
    [[0, 0, 1543, 536], [0, 536, 515, 483], [515, 536, 514, 483], [1029, 536, 514, 483]]);
  const hit = (px, py) => a.find((x) => px >= x.bounds.x && px < x.bounds.x + x.bounds.width && py >= x.bounds.y && py < x.bounds.y + x.bounds.height).action.label;
  // 画像上の文字・アイコンの位置（800×530 表示の実測を 1543×1019 に換算）
  assert.equal(hit(270, 375), 'ご予約はこちら');   // 「ご予約はこちら ❯❯❯❯」
  assert.equal(hit(1100, 300), 'ご予約はこちら');  // ヘリコプター
  assert.equal(hit(258, 805), '予約確認');        // 「予約確認」
  assert.equal(hit(772, 805), 'お問い合わせ');    // 「お問い合わせ」
  assert.equal(hit(1290, 805), 'よくある質問');   // 「よくある質問」
  assert.equal(hit(0, 1018), '予約確認');
  assert.equal(hit(1542, 1018), 'よくある質問');
});

/* ---------- ボタンの動作 ---------- */

test('URL 未設定：予約確認・お問い合わせは LINE 内の postback、ご予約はこちら・よくある質問は準備中 postback（ダミー URL なし）', () => {
  const a = areasOf(env());
  assert.deepEqual(a.map((x) => [x.action.type, x.action.data, x.action.displayText]), [
    ['postback', 'a=menu_unset&item=BOOKING', 'ご予約はこちら'],
    ['postback', 'a=rsv_start', '予約確認'],
    ['postback', 'a=inq_start', 'お問い合わせ'],
    ['postback', 'a=menu_unset&item=FAQ', 'よくある質問']]);
  a.forEach((x) => {
    assert.ok(x.action.label.length <= 20);
    assert.ok(!x.action.uri);
  });
  assert.deepEqual([...env().ctx.buildRichMenuDefinition_().unset], ['ご予約はこちら', 'よくある質問']);
});

test('公式サイト・FAQ の URL を設定すると、ご予約はこちら・よくある質問がリンクに切り替わる', () => {
  const e = env();
  e.setSetting('BOOKING_SITE_URL', 'https://sky-standard.example/');
  e.setSetting('FAQ_PAGE_URL', 'https://sky-standard.example/faq');
  const a = areasOf(e);
  assert.deepEqual(a.map((x) => [x.action.type, x.action.uri || x.action.data]), [
    ['uri', 'https://sky-standard.example/'], ['postback', 'a=rsv_start'], ['postback', 'a=inq_start'], ['uri', 'https://sky-standard.example/faq']]);
  // http や不正な URL は使わない
  const e2 = env();
  e2.setSetting('FAQ_PAGE_URL', 'http://sky-standard.example/faq');
  assert.equal(areasOf(e2)[3].action.type, 'postback');
});

/* ---------- タップ時の返信（Webhook） ---------- */

const ulid = () => crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26);
function tap(e, data) {
  e.doPost({ destination: BOT, events: [{ type: 'postback', webhookEventId: ulid(), timestamp: Date.now(),
    replyToken: crypto.randomBytes(16).toString('hex'), source: { type: 'user', userId: USER }, postback: { data } }] });
  const r = e.linePosts('/v2/bot/message/reply');
  return r[r.length - 1].json.messages;
}

test('準備中ボタン（ご予約はこちら・よくある質問）をタップすると「現在準備中」を返信し、記録しない', () => {
  const e = env();
  let m = tap(e, 'a=menu_unset&item=BOOKING')[0];
  assert.match(m.text, /^🚁 フライトのご予約は、現在準備中でございます。/);
  assert.ok(m.quickReply.items.some((i) => i.action.data === 'a=inq_start'));
  m = tap(e, 'a=menu_unset&item=FAQ')[0];
  assert.match(m.text, /^📋 よくある質問のページは、現在準備中でございます。/);
  assert.deepEqual(m.quickReply.items.map((i) => i.action.data), ['a=inq_start']);
  assert.equal(e.rows('問い合わせ管理').length, 0);
});

test('旧メニュー（6領域）のボタンにも応答する：プラン・チャーターは準備中、予約確認は LINE での予約確認を開始', () => {
  const e = env();
  assert.match(tap(e, 'a=menu_unset&item=PLANS')[0].text, /^✨ プラン一覧は、現在準備中でございます。/);
  const charter = tap(e, 'a=menu_unset&item=CHARTER')[0];
  assert.ok(charter.quickReply.items.some((i) => i.action.data === 'a=inq_cat&c=4'));
  assert.match(tap(e, 'a=menu_unset&item=BOOKING_CHECK')[0].text, /予約IDを入力してくださいませ/);
  assert.ok(e.cache.get('rsv:' + USER));
  assert.match(tap(e, 'a=menu_unset&item=' + encodeURIComponent('プラン一覧'))[0].text, /^✨ プラン一覧は/);
  const m = tap(e, 'a=menu_unset&item=' + encodeURIComponent('<偽の案内>こちらへ'))[0];
  assert.equal(m.text, '🚁 このメニューは、現在準備中でございます。\nご不明な点は、下記よりお気軽にご相談くださいませ。');
});

test('新メニューの「予約確認」「お問い合わせ」はそれぞれのフローを起動', () => {
  const e = env();
  assert.match(tap(e, 'a=rsv_start')[0].text, /予約IDを入力してくださいませ/);
  const inq = tap(e, 'a=inq_start')[0];
  assert.deepEqual(inq.quickReply.items.map((i) => i.action.label), ['チャーター見積', 'フライト予約について', 'その他のお問い合わせ', 'オペレーターに相談']);
  assert.equal(e.cache.get('rsv:' + USER) || null, null, 'メニュー操作で予約確認の入力待ちを中断');
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

test('旧メニューのメッセージ「お問い合わせ」「FAQ」にも引き続き応答（FAQ ページ未公開の間は LINE 内 FAQ）', () => {
  const e = env();
  e.doPost(relayEnvelope({ destination: BOT, events: [{ type: 'message', webhookEventId: 'q1', replyToken: 'rt1', source: { type: 'user', userId: USER }, message: { type: 'text', text: 'お問い合わせ' } }] }, 'r'));
  let r = e.linePosts('/v2/bot/message/reply').pop().json.messages[0];
  assert.deepEqual(r.quickReply.items.map((i) => i.action.label), ['チャーター見積', 'フライト予約について', 'その他のお問い合わせ', 'オペレーターに相談']);
  e.doPost(relayEnvelope({ destination: BOT, events: [{ type: 'message', webhookEventId: 'q2', replyToken: 'rt2', source: { type: 'user', userId: USER }, message: { type: 'text', text: 'FAQ' } }] }, 'r'));
  r = e.linePosts('/v2/bot/message/reply').pop().json.messages[0];
  assert.match(r.text, /よくあるご質問/);
  assert.ok(r.quickReply.items.some((i) => i.action.data === 'a=faq&id=F001'));
  e.setSetting('FAQ_PAGE_URL', 'https://sky-standard.example/faq');
  e.doPost(relayEnvelope({ destination: BOT, events: [{ type: 'message', webhookEventId: 'q3', replyToken: 'rt3', source: { type: 'user', userId: USER }, message: { type: 'text', text: 'FAQ' } }] }, 'r'));
  r = e.linePosts('/v2/bot/message/reply').pop().json.messages[0];
  assert.equal(r.template.actions[0].uri, 'https://sky-standard.example/faq', 'FAQ ページ公開後は公式サイトへ');
});

test('準備中ボタンのタップはエラーログに記録しない', () => {
  const e = env();
  tap(e, 'a=menu_unset&item=BOOKING');
  assert.equal(e.sheets['エラーログ'], undefined);
});

/* ---------- 画像の検査 ---------- */

test('画像検査：指定画像（PNG 1543×1019・2.2MB）は JPEG に変換して 1MB 以下・同サイズで使う（元画像は変更しない）', () => {
  const e = env();
  const r = e.ctx.validateRichMenuImage_();
  assert.equal(r.ok, true);
  assert.equal(r.width, W);
  assert.equal(r.height, H);
  assert.equal(r.type, 'image/jpeg');
  assert.ok(r.bytes <= 1024 * 1024);
  assert.match(r.converted, /PNG（2200KB）を JPEG（420KB）に変換して使用/);
  assert.equal(r.name, IMG_NAME);
});

test('画像検査：サイズ違い・1MB 超（変換できない）・PNG/JPEG 以外・ファイルなしは NG（日本語で表示）', () => {
  const mk = (f) => env({ driveFiles: { [IMG_ID]: Object.assign({ name: 'x' }, f) } }).ctx.validateRichMenuImage_();
  assert.match(mk({ contentType: 'image/png', bytes: fakeImage('png', 2500, 1686) }).problems.join(), /1543×1019px にしてください（現在: 2500×1686px）/);
  assert.match(mk({ contentType: 'image/png', bytes: fakeImage('png', W, H, 2200 * 1024) }).problems.join(), /1MB 以下/);
  assert.match(mk({ contentType: 'image/png', bytes: fakeImage('png', W, H, 2200 * 1024), asJpeg: fakeImage('jpeg', W, H, 1500 * 1024) }).problems.join(), /1MB 以下/);
  assert.match(mk({ contentType: 'image/png', bytes: fakeImage('png', W, H, 2200 * 1024), asJpeg: fakeImage('jpeg', 800, 528, 200 * 1024) }).problems.join(), /1MB 以下/,
    '変換でサイズが変わる場合は使わない');
  assert.match(mk({ contentType: 'image/gif', bytes: Buffer.from('GIF89a' + 'x'.repeat(100)) }).problems.join(), /PNG または JPEG/);
  const none = env({ driveFiles: {} }).ctx.validateRichMenuImage_();
  assert.equal(none.ok, false);
  assert.match(none.problems[0], /Google ドライブの画像を開けません/);
  assert.equal(mk({ contentType: 'image/jpeg', bytes: fakeImage('jpeg', W, H) }).ok, true);
});

test('画像に問題があれば LINE には何も作らずに止める（旧画像 2500×1686 のままでは登録しない）', () => {
  const e = env({ driveFiles: { [IMG_ID]: { name: 'old', contentType: 'image/jpeg', bytes: fakeImage('jpeg', 2500, 1686) } } });
  const r = e.ctx.adminRun('richMenuDeploy');
  assert.equal(r.ok, false);
  assert.match(r.message, /画像サイズを 1543×1019px にしてください/);
  assert.equal(e.fetchCalls.filter((c) => /api(-data)?\.line\.me/.test(c.url)).length, 0);
});

/* ---------- 設定確認（LINE に登録しない） ---------- */

test('リッチメニュー設定確認は LINE に登録しない（GET のみ）。準備中・画像・未登録を表示', () => {
  const e = env();
  const r = e.ctx.adminRun('richMenuCheck');
  assert.equal(r.ok, true);
  assert.match(r.message, /【準備中】ご予約はこちら → 「現在準備中です」を返信（URL 未設定）\n    タップ領域 x:0〜1542 \/ y:0〜535/);
  assert.match(r.message, /【OK】予約確認 → LINE トークで予約IDの入力を開始\n    タップ領域 x:0〜514 \/ y:536〜1018/);
  assert.match(r.message, /【OK】お問い合わせ → LINE トークでお問い合わせメニューを表示\n    タップ領域 x:515〜1028 \/ y:536〜1018/);
  assert.match(r.message, /【準備中】よくある質問 → 「現在準備中です」を返信（URL 未設定）\n    タップ領域 x:1029〜1542 \/ y:536〜1018/);
  assert.match(r.message, /【OK】空と都市を巡るヘリチャーター案内\.png（image\/jpeg・1543×1019px・420KB）\n    PNG（2200KB）を JPEG（420KB）に変換して使用/);
  assert.match(r.message, /【未登録】既定のリッチメニューはまだ登録されていません/);
  assert.match(r.message, /BOOKING_SITE_URL・FAQ_PAGE_URL を入力し、「リッチメニュー登録・更新」を実行するとリンク方式に切り替わります/);
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
  assert.match(m, /ご予約はこちら: postback（準備中表示・LINE内の操作） → リンク に切り替えが必要/);
  // 現在 LINE に登録されている旧メニュー（2500×1686・6領域）との差も表示する
  registered = { size: { width: 2500, height: 1686 }, areas: [1, 2, 3, 4, 5, 6].map((i) => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, action: { type: 'message', label: 'x' + i, text: 'x' } })) };
  assert.match(e.ctx.adminRun('richMenuCheck').message, /メニューの構成が異なります（LINE 側: 2500×1686・6領域 → 新: 1543×1019・4領域）/);
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
  assert.match(r.message, /準備中」と表示されるボタン: ご予約はこちら、よくある質問/);
  assert.deepEqual(calls.filter((c) => /richmenu/.test(c)), [
    'get /v2/bot/user/all/richmenu', 'post /v2/bot/richmenu/validate', 'post /v2/bot/richmenu',
    'post /v2/bot/richmenu/richmenu-new/content', 'post /v2/bot/user/all/richmenu/richmenu-new', 'delete /v2/bot/richmenu/richmenu-old']);
  const upload = e.fetchCalls.find((c) => /\/content$/.test(c.url));
  assert.equal(upload.params.contentType, 'image/jpeg');
  assert.equal(upload.params.payload.length, 420 * 1024, '変換後の JPEG をアップロード');
  const sheet = e.rows('リッチメニュー');
  const st = Object.fromEntries(sheet.map((x) => [x['表示名'], x['実装状態'].replace(/ \d.*/, '')]));
  assert.equal(st['予約確認'], '登録済み');
  assert.equal(st['お問い合わせ'], '登録済み');
  assert.equal(st['よくある質問'], '未設定（準備中表示）');
  assert.equal(st['ご予約はこちら'], '未設定（準備中表示）', '新しいボタンは行を追加');
  assert.equal(st['プラン一覧'], '未設定', '旧メニューの行は削除・変更しない');
  // 他の列は変更しない
  assert.equal(sheet[0]['遷移先URL・送信テキスト'], '[予約サイトURL]');
});
