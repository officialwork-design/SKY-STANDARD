/**
 * ユーザー向けメッセージ（文言）の回帰テスト。
 * - お問い合わせ画面の本文に選択肢を繰り返さない
 * - ボタン（クイックリプライ・postback）は従来どおり
 * - 管理台帳（2026-10-28 時点）の通知テンプレート・FAQ の本文をそのまま使い、差し込み変数が置換される
 * - URL 未設定の機能は「準備中」と案内し、ページがあるかのように案内しない
 * - LINE の文字数制限・絵文字ルール
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv, relayEnvelope, reservationEnvelope } = require('./helpers/gas-env');

const RELAY = 'relay-secret';
const RESV = 'resv-secret';
const USER = 'U' + 'a'.repeat(32);

/** 管理台帳の通知テンプレート（2026-10-28 時点。本文・ON/OFF とも実シートと同じ） */
const SHEET_TEMPLATES = [
  ['WELCOME', '友だち追加', '友だち追加時', '🚁 SKY STANDARDへようこそ\n\n公式LINEをご登録いただき、誠にありがとうございます。\n\nSKY STANDARDでは、空からの美しい景色と、心に残る特別なひとときをご案内しております。✨\n\nフライトのご予約やプランのご相談は、下部のメニューからお気軽にお申し付けください。\n\n皆様を空の旅へご案内できますことを、心より楽しみにしております。\n\nSKY STANDARD', 'ON', ''],
  ['BOOKING_RECEIVED', '予約受付', '予約サイトで受付時', '📩【SKY STANDARD｜ご予約受付】\n\nこの度はお申し込みいただき、誠にありがとうございます。\n\nご予約リクエストを承りました。\n\n🔖 予約ID：{{予約ID}}\n\n現在、内容を確認しております。ご予約はまだ確定しておりませんので、確定のご案内まで今しばらくお待ちくださいませ。\n\nSKY STANDARD', 'ON', '確定前と区別'],
  ['BOOKING_CONFIRMED', '予約確定', '事業者承認後', '✅【SKY STANDARD｜ご予約確定】\n\nこの度はSKY STANDARDをお選びいただき、誠にありがとうございます。\n\nフライトのご予約が確定いたしました。\n\n🔖 予約ID：{{予約ID}}\n📅 搭乗日時：{{搭乗日時}}\n\n集合場所や当日のご案内は、予約確認ページにてご確認くださいませ。\n\n特別な空のひとときをお届けできますことを、スタッフ一同楽しみにしております。🚁\n\nSKY STANDARD', 'ON', ''],
  ['FLIGHT_REMINDER', '搭乗前案内', '搭乗前日', '🌤️【SKY STANDARD｜ご搭乗前日のご案内】\n\nいよいよ明日はご搭乗予定日です。\n\n📍 集合場所やお時間、当日の注意事項を予約確認ページにてご確認くださいませ。\n\nなお、天候や運航状況により、予定が変更となる場合がございます。運航の最終確定をお知らせするものではございません。\n\nどうぞお気をつけてお越しください。✨\n\nSKY STANDARD', 'ON', '運航確定の保証ではない'],
  ['FLIGHT_CHANGE', '運航変更', '担当者承認後', '📢【SKY STANDARD｜運航に関するご案内】\n\nご予約のフライトについて、大切なお知らせがございます。\n\n最新のご案内を予約確認ページにてご確認くださいますようお願いいたします。\n\nご不明な点がございましたら、このLINEよりお問い合わせくださいませ。🚁\n\nSKY STANDARD', 'ON', '自動で欠航確定しない'],
  ['BOOKING_CHANGED', '予約変更', '予約サイトで変更時', '🗓️【SKY STANDARD｜ご予約内容変更のご案内】\n\nご予約内容の変更を承りました。\n\n🔖 予約ID：{{予約ID}}\n📅 変更後の搭乗日時：{{搭乗日時}}\n\n変更内容の詳細は、予約確認ページにてご確認くださいませ。\n\n引き続き、どうぞよろしくお願いいたします。✨\n\nSKY STANDARD', 'OFF', '自動追加。文面確認後に ON にしてください'],
  ['BOOKING_CANCELLED', 'キャンセル', '予約サイトでキャンセル時', '📋【SKY STANDARD｜キャンセル受付のご案内】\n\nご予約のキャンセルを承りました。\n\n🔖 予約ID：{{予約ID}}\n\nキャンセル条件や返金に関するご案内は、予約確認ページにてご確認くださいませ。\n\nまたの機会に、空の旅をご案内できますことを心よりお待ちしております。🚁\n\nSKY STANDARD', 'OFF', '自動追加。文面確認後に ON にしてください'],
  ['PAYMENT_COMPLETED', '決済完了', '予約サイトで決済完了時', '💳【SKY STANDARD｜お支払い完了のご案内】\n\nお支払いのお手続きが完了いたしました。\n\n🔖 予約ID：{{予約ID}}\n\nご予約の確定状況やフライトの詳細は、予約確認ページにてご確認いただけます。\n\nこの度は誠にありがとうございます。✨\n\nSKY STANDARD', 'OFF', '自動追加。文面確認後に ON にしてください'],
  ['OPERATOR_START', 'オペレーター対応開始', 'お問い合わせで「オペレーターに相談」を選択時', '💬【SKY STANDARD｜コンシェルジュへのご相談】\n\nお問い合わせいただき、誠にありがとうございます。\n\nただいま担当スタッフへおつなぎしております。\n\n📝 ご相談内容をこのトークにお送りください。確認のうえ、担当者より順次ご返信いたします。\n\n※担当者による対応中は、自動返信を一時停止いたします。\n\nSKY STANDARD', 'OFF', '自動追加。文面確認後に ON にしてください']
];
/** 管理台帳の FAQ（2026-10-28 時点） */
const SHEET_FAQ = [
  ['F001', '予約', '予約方法', '🚁 フライトのご予約は、リッチメニューの「フライト予約」からお進みくださいませ。', 'ON', 'NO'],
  ['F002', '予約', '予約確認', '🔖 ご予約内容は、リッチメニューの「予約確認」からご確認いただけます。ご本人様確認が必要です。', 'ON', 'NO'],
  ['F003', '運航', '雨天・悪天候', '🌤️ 天候や運航状況により、フライト内容が変更となる場合がございます。最新の状況は担当者よりご案内いたします。', 'ON', 'YES'],
  ['F004', 'キャンセル', 'キャンセル料', '📋 キャンセル条件はプランやご予約内容によって異なります。詳しくは予約詳細をご確認くださいませ。', 'ON', 'YES']
];

function env(opts = {}) {
  const e = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: 't', RELAY_SHARED_SECRET: RELAY, RESERVATION_WEBHOOK_SECRET: RESV,
    SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', WEBHOOK_MODE: 'relay' },
  fetch: (url) => (url.indexOf('/v2/bot/profile/') !== -1 ? { code: 200, body: { displayName: '空野', language: 'ja' } } : { code: 200, body: {} }) });
  const t = e.sheets['通知テンプレート'].data;
  t.splice(1, t.length - 1, ...SHEET_TEMPLATES.map((r) => r.slice()));
  if (!opts.seedFaq) {
    const f = e.sheets['FAQ'].data;
    f.splice(1, f.length - 1, ...SHEET_FAQ.map((r) => r.slice()));
  }
  if (opts.urls) {
    Object.keys(opts.urls).forEach((k) => e.setSetting(k, opts.urls[k]));
  }
  return e;
}
let seq = 0;
const textEv = (t) => ({ type: 'message', webhookEventId: 'm' + (++seq), replyToken: 'rt' + seq, source: { type: 'user', userId: USER },
  message: { type: 'text', text: t } });
const pbEv = (d) => ({ type: 'postback', webhookEventId: 'p' + (++seq), replyToken: 'rt' + seq, source: { type: 'user', userId: USER }, postback: { data: d } });
function send(e, ev) {
  const before = e.linePosts('/v2/bot/message/reply').length;
  e.doPost(relayEnvelope({ destination: 'U' + 'f'.repeat(32), events: [ev] }, RELAY));
  const r = e.linePosts('/v2/bot/message/reply');
  return r.length > before ? r[r.length - 1].json.messages : null;
}
const actions = (m) => (m.quickReply ? m.quickReply.items.map((i) => i.action) : []);

/* ---------- 最優先：お問い合わせ画面 ---------- */

test('お問い合わせ：本文は2行の案内のみ（番号付き一覧・オペレーターの説明を本文に含めない）', () => {
  const e = env();
  for (const trigger of [() => send(e, textEv('お問い合わせ')), () => send(e, pbEv('a=inq_start'))]) {
    const m = trigger()[0];
    assert.equal(m.text, '🚁 お問い合わせありがとうございます。\nご希望の内容を下記よりお選びくださいませ。');
    assert.doesNotMatch(m.text, /^\s*\d+\./m);
    assert.doesNotMatch(m.text, /フライト予約について|予約内容の確認・変更|天候・運航について|チャーター見積|その他のお問い合わせ|オペレーターに相談/);
  }
});

test('お問い合わせ：選択ボタンは4件（チャーター見積・フライト予約について・その他・オペレーターに相談）。postback は従来の番号を維持', () => {
  const e = env();
  const a = actions(send(e, textEv('お問い合わせ'))[0]);
  assert.deepEqual(a.map((x) => [x.type, x.label, x.data, x.displayText]), [
    ['postback', 'チャーター見積', 'a=inq_cat&c=4', 'チャーター見積'],
    ['postback', 'フライト予約について', 'a=inq_cat&c=1', 'フライト予約について'],
    ['postback', 'その他のお問い合わせ', 'a=inq_cat&c=5', 'その他のお問い合わせ'],
    ['postback', 'オペレーターに相談', 'a=inq_operator', 'オペレーターに相談']
  ]);
});

test('お問い合わせ：すべてのボタンが動作する（入力案内 → 受付完了 → 有人対応）。旧ボタン c=2・c=3 も安全に振り替える', () => {
  const guides = {
    4: '📩【チャーター見積】\n下記をご記入のうえ、1通のメッセージでお送りくださいませ。未定の項目は「未定」で構いません。\n\n・希望日時\n・出発地\n・目的地\n・搭乗人数\n・利用目的\n・その他のご要望',
    5: '📩【その他のお問い合わせ】\nお問い合わせ内容を、1通のメッセージでお送りくださいませ。',
    op: '💬 担当スタッフへおつなぎいたします。\nご相談内容を、このトークに1通のメッセージでお送りくださいませ。'
  };
  const acks = {
    4: /^✅ チャーターのお見積りのご依頼を承りました。\n🔖 受付ID：INQ-\d{8}-0001\n\n担当者が運航条件と料金を確認のうえ、このトークでご案内いたします。ご案内まで、自動返信を一時停止いたします。$/,
    5: /^✅ お問い合わせを承りました。\n🔖 受付ID：INQ-\d{8}-0001\n\n担当者が内容を確認のうえ、このトークで順次ご返信いたします。それまで、自動返信を一時停止いたします。$/,
    op: /^💬 ご相談内容を承りました。\n🔖 受付ID：INQ-\d{8}-0001\n\n担当スタッフがこのトークで順次ご返信いたします。対応中は、自動返信を一時停止いたします。$/
  };
  for (const c of ['4', '5', 'op']) {
    const e = env();
    const g = send(e, pbEv(c === 'op' ? 'a=inq_operator' : 'a=inq_cat&c=' + c))[0];
    assert.equal(g.text, guides[c]);
    assert.deepEqual(actions(g).map((x) => [x.label, x.data]), [['入力をやめる', 'a=inq_cancel']]);
    const ack = send(e, textEv('テストのお問い合わせ'))[0].text;
    assert.match(ack, acks[c]);
    assert.equal(e.rows('問い合わせ管理').length, 1);
    assert.equal(e.rows('問い合わせ管理')[0]['自動返信有効'], false);
  }
  const e = env();
  assert.match(send(e, pbEv('a=inq_cat&c=1'))[0].text, /オンラインでのご予約受付は、現在準備中でございます/);
  send(e, pbEv('a=inq_cat&c=5'));
  assert.equal(send(e, pbEv('a=inq_cancel'))[0].text, '✅ お問い合わせの入力を取り消しました。\nまたいつでもお気軽にご相談くださいませ。');
  assert.match(send(e, pbEv('a=inq_cat&c=2'))[0].text, /予約IDを入力してくださいませ/, '旧：予約内容の確認・変更 → 予約確認');
  assert.match(send(e, pbEv('a=inq_cat&c=3'))[0].text, /よくある質問のページは、現在準備中/, '旧：天候・運航 → FAQ');
  assert.equal(e.rows('問い合わせ管理').length, 0);
});

/* ---------- 自動返信の TRUE / FALSE ---------- */

test('自動返信有効=FALSE の間は返信せず、TRUE に戻すと次のメッセージから返信する（文言変更後も維持）', () => {
  const e = env();
  send(e, pbEv('a=inq_operator'));
  send(e, textEv('相談です'));
  assert.equal(send(e, textEv('予約')), null);
  assert.equal(send(e, pbEv('a=menu_unset&item=BOOKING')), null);
  const d = e.sheets['問い合わせ管理'].data;
  d[1][d[0].indexOf('自動返信有効')] = true;
  assert.ok(send(e, textEv('予約')));
});

/* ---------- FAQ ---------- */

test('FAQ：管理台帳の回答をそのまま返し、要有人確認は短い一文とボタンを付ける', () => {
  const e = env();
  let m = send(e, textEv('予約方法'))[0];
  assert.equal(m.text, SHEET_FAQ[0][3]);
  assert.deepEqual(actions(m).map((x) => x.label), ['よくある質問', 'お問い合わせ']);
  m = send(e, textEv('雨天'))[0];
  assert.equal(m.text, SHEET_FAQ[2][3] + '\n\n個別のご状況につきましては、担当者がご案内いたします。下記よりお気軽にご相談くださいませ。');
  assert.deepEqual(actions(m).map((x) => x.label), ['お問い合わせ', 'よくある質問']);
  const menu = send(e, textEv('FAQ'))[0];
  assert.equal(menu.text, '📋 よくあるご質問です。\n下記よりお選びいただくか、知りたい内容をメッセージでお送りくださいませ。');
  assert.deepEqual(actions(menu).map((x) => [x.label, x.data]), [['予約方法', 'a=faq&id=F001'], ['予約確認', 'a=faq&id=F002'],
    ['雨天・悪天候', 'a=faq&id=F003'], ['キャンセル料', 'a=faq&id=F004'], ['お問い合わせ', 'a=inq_start']]);
  assert.equal(send(e, pbEv('a=faq&id=F004'))[0].text.indexOf(SHEET_FAQ[3][3]), 0);
});

test('一致しない質問：本文でボタン名を繰り返さず、担当者に送る導線は従来どおり', () => {
  const e = env();
  const m = send(e, textEv('ヘリの座席の色は？'))[0];
  assert.equal(m.text, '📩 メッセージをありがとうございます。\n自動ではお答えできない内容のため、ご希望の対応を下記よりお選びくださいませ。');
  assert.deepEqual(actions(m).map((x) => x.label), ['担当者に送る', 'よくある質問', 'お問い合わせ', '予約']);
  const ack = send(e, pbEv('a=inq_handoff'))[0].text;
  assert.match(ack, /^✅ お問い合わせを承りました。/);
  assert.equal(e.rows('問い合わせ管理')[0]['自動返信有効'], false);
});

/* ---------- 準備中（未実装機能） ---------- */

test('URL 未設定：予約・プラン・料金・チャーター・FAQ ページは「準備中」と案内し、ページへ誘導しない', () => {
  const e = env({ seedFaq: true });
  e.sheets['FAQ'].data.splice(1); // 料金の FAQ がない状態
  const cases = {
    '予約': '🚁 オンラインでのご予約受付は、現在準備中でございます。\nご予約のご相談は、メニューの「お問い合わせ」より承ります。',
    'プラン': '✨ プラン一覧は、現在準備中でございます。\n公開まで今しばらくお待ちくださいませ。',
    '料金': '🚁 料金はプラン・人数・日程により異なります。\nプラン一覧は現在準備中のため、料金のご相談はメニューの「お問い合わせ」より承ります。'
  };
  for (const k of Object.keys(cases)) {
    const msgs = send(e, textEv(k));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'text');
    assert.equal(msgs[0].text, cases[k]);
    assert.doesNotMatch(msgs[0].text, /下記の|ページより承って|お支払いまで/);
  }
  const ch = send(e, textEv('チャーター'));
  assert.equal(ch[0].text, '🚁 チャーターのご案内ページは、現在準備中でございます。');
  assert.equal(ch[1].text, '✨ チャーターのお見積りも承っております。');
  assert.deepEqual(actions(ch[1]).map((x) => [x.label, x.data]), [['見積を依頼', 'a=inq_cat&c=4']]);
  assert.match(send(e, textEv('キャンセル'))[0].text, /担当者がご案内いたします/);
  assert.match(send(e, textEv('集合場所'))[0].text, /担当者がご案内いたします/);
  assert.match(send(e, textEv('予約確認'))[0].text, /^🔖 ご予約の確認ですね。/, '予約確認は LINE トークで開始');
  send(e, pbEv('a=rsv_cancel'));
  for (const k of ['BOOKING', 'FAQ', 'PLANS', 'CHARTER']) {
    const m = send(e, pbEv('a=menu_unset&item=' + k))[0];
    assert.match(m.text, /現在準備中でございます/);
    assert.doesNotMatch(m.text, /「お問い合わせ」|「よくある質問」|「チャーター見積」/, 'ボタン名を本文で繰り返さない');
    assert.ok(actions(m).some((x) => x.data === 'a=inq_start'));
  }
});

test('URL 設定済み：ボタン付きで案内し、ボタン本文は160字以内', () => {
  const e = env({ seedFaq: true, urls: { BOOKING_SITE_URL: 'https://example.com/book', FAQ_PAGE_URL: 'https://example.com/faq',
    PLAN_LIST_URL: 'https://example.com/plans', CHARTER_URL: 'https://example.com/charter', BOOKING_CONFIRM_URL: 'https://example.com/my' } });
  e.sheets['FAQ'].data.splice(1);
  for (const [k, url] of [['予約', 'https://example.com/book'], ['プラン', 'https://example.com/plans'],
    ['料金', 'https://example.com/plans'], ['チャーター', 'https://example.com/charter'], ['FAQ', 'https://example.com/faq']]) {
    const b = send(e, textEv(k)).find((m) => m.type === 'template');
    assert.ok(b, k);
    assert.ok(b.template.text.length <= 160, k);
    assert.equal(b.template.actions[0].uri, url);
  }
  assert.match(send(e, textEv('キャンセル'))[0].text, /予約確認ページにてご確認/);
  const m = send(e, pbEv('a=menu_unset&item=BOOKING'));
  assert.equal(m[0].template.text, '✨ 「ご予約はこちら」は、下記よりご利用いただけます。');
  const fl = send(e, pbEv('a=inq_cat&c=1'));
  assert.equal(fl[fl.length - 1].template.actions[0].uri, 'https://example.com/book');
});

/* ---------- 通知テンプレート ---------- */

test('通知テンプレート：管理台帳の本文で差し込み変数を置換し、OFF のテンプレートは送らない', () => {
  const e = env({ urls: { BOOKING_CONFIRM_URL: 'https://example.com/my' } });
  const resv = { reservationId: 'R-100', lineUserId: USER, planName: '東京夜景', flightDate: '2026-12-01', timeSlot: '18:00', passengers: 2 };
  const post = (type, id) => e.doPost(reservationEnvelope({ eventId: id, eventType: type, occurredAt: new Date(Date.now() + seq++).toISOString(), reservation: resv }, RESV));
  post('BOOKING_RECEIVED', 'e1');
  post('BOOKING_CONFIRMED', 'e2');
  post('BOOKING_CHANGED', 'e3');
  post('PAYMENT_COMPLETED', 'e4');
  post('BOOKING_CANCELLED', 'e5');
  const pushes = e.linePosts('/v2/bot/message/push').filter((p) => p.json.to === USER);
  assert.equal(pushes.length, 2, 'ON の予約受付・予約確定のみ送信（変更・決済・キャンセルは OFF）');
  const t1 = pushes[0].json.messages[0].text;
  const t2 = pushes[1].json.messages[0].text;
  assert.match(t1, /🔖 予約ID：R-100\n/);
  assert.match(t2, /🔖 予約ID：R-100\n📅 搭乗日時：2026-12-01 18:00\n/);
  for (const t of [t1, t2]) assert.doesNotMatch(t, /\{\{|\}\}/);
  const link = pushes[1].json.messages[1];
  assert.equal(link.template.text, '🔖 ご予約の詳細は、下記よりご確認いただけます。');
  assert.equal(link.template.actions[0].uri, 'https://example.com/my');
  const results = e.rows('送信ログ').map((r) => r['結果']);
  assert.equal(results.filter((r) => r === 'テンプレート無効').length, 3);
});

test('通知テンプレート：シートの本文を GAS が上書き・追加しない（補完は不足分のみ）', () => {
  const e = env();
  e.setUser('owner@example.com');
  e.props.ADMIN_USERS = 'owner@example.com';
  const before = JSON.stringify(e.sheets['通知テンプレート'].data);
  e.ctx.adminRun('setupSheets');
  assert.equal(JSON.stringify(e.sheets['通知テンプレート'].data), before);
});

test('既定テンプレート（不足時に OFF で追加する文面）は管理台帳の承認済み文面と同じ', () => {
  const e = env();
  const defs = JSON.parse(JSON.stringify(e.ctx.DEFAULT_TEMPLATES));
  for (const d of defs) {
    const row = SHEET_TEMPLATES.find((r) => r[0] === d.id);
    assert.ok(row, d.id);
    assert.equal(d.body, row[3], d.id);
  }
});

test('OPERATOR_START を ON にすると管理台帳の文面で相談内容を案内し、受付IDは受付完了で案内', () => {
  const e = env();
  const row = e.sheets['通知テンプレート'].data.find((r) => r[0] === 'OPERATOR_START');
  row[4] = 'ON';
  assert.equal(send(e, pbEv('a=inq_operator'))[0].text, SHEET_TEMPLATES[8][3]);
  assert.match(send(e, textEv('相談です'))[0].text, /🔖 受付ID：INQ-\d{8}-0001/);
});

test('友だち追加：WELCOME（ON）の本文をそのまま送る。OFF なら GAS の予備の文面', () => {
  const e = env();
  const follow = () => send(e, { type: 'follow', webhookEventId: 'f' + (++seq), replyToken: 'rt' + seq, source: { type: 'user', userId: USER } })[0];
  assert.equal(follow().text, SHEET_TEMPLATES[0][3]);
  e.sheets['通知テンプレート'].data.find((r) => r[0] === 'WELCOME')[4] = 'OFF';
  assert.equal(follow().text, '🚁 SKY STANDARD公式LINEへようこそ。\nご登録いただき、誠にありがとうございます。\n\n空の旅に関するご相談は、画面下のメニューよりお気軽にお申し付けくださいませ。✨');
});

test('テキスト以外のメッセージ：文字かメニューの利用を案内', () => {
  const e = env();
  const m = send(e, { type: 'message', webhookEventId: 'i' + (++seq), replyToken: 'rt' + seq, source: { type: 'user', userId: USER }, message: { type: 'sticker' } })[0];
  assert.equal(m.text, '📩 メッセージをお送りいただき、ありがとうございます。\n恐れ入りますが、文字でお送りいただくか、画面下のメニューをご利用くださいませ。');
});

/* ---------- 文字数制限・絵文字ルール（GAS 固定文言すべて） ---------- */

const EMOJI = /\p{Extended_Pictographic}/gu;
function fixedTexts(e) {
  const c = e.ctx;
  const vm = require('vm');
  const get = (expr) => vm.runInContext(expr, c);
  const out = {};
  const intent = get('INTENT_TEXT');
  Object.keys(intent).forEach((k) => { out['INTENT_TEXT.' + k] = intent[k]; });
  const pending = get('RICHMENU_PENDING_TEXT');
  Object.keys(pending).forEach((k) => { out['RICHMENU_PENDING_TEXT.' + k] = pending[k]; });
  out.DEFAULT_WELCOME_MESSAGE = get('DEFAULT_WELCOME_MESSAGE');
  out.DEFAULT_OPERATOR_PROMPT_TEXT = get('DEFAULT_OPERATOR_PROMPT_TEXT');
  const rsv = get('RSV_TEXT');
  Object.keys(rsv).forEach((k) => { out['RSV_TEXT.' + k] = rsv[k]; });
  const guides = get('INQUIRY_GUIDE_TEXT');
  Object.keys(guides).forEach((k) => { out['INQUIRY_GUIDE_TEXT.' + k] = guides[k]; });
  out.FLIGHT_GUIDE_TEXT = get('FLIGHT_GUIDE_TEXT');
  out.FLIGHT_GUIDE_PENDING_TEXT = get('FLIGHT_GUIDE_PENDING_TEXT');
  out.inquiryReceivedCharter = get("inquiryReceivedText_('INQ-20261028-0001', 'charter')");
  out.inquiryReceivedOperator = get("inquiryReceivedText_('INQ-20261028-0001', 'operator')");
  out.MSG_INQUIRY_MENU = get('MSG_INQUIRY_MENU');
  out.MSG_NON_TEXT = get('MSG_NON_TEXT');
  out.MSG_INQUIRY_CANCELLED = get('MSG_INQUIRY_CANCELLED');
  out.inquiryReceived = get("inquiryReceivedText_('INQ-20261028-0001')");
  return out;
}

test('GAS 固定文言：LINE の上限内（テキスト5000字）・絵文字は1〜3種類で連続させない・旧文言が残っていない', () => {
  const e = env();
  const texts = fixedTexts(e);
  assert.ok(Object.keys(texts).length >= 28);
  for (const [k, t] of Object.entries(texts)) {
    assert.ok(t.length > 0 && t.length <= 5000, k);
    const kinds = new Set((t.match(EMOJI) || []));
    assert.ok(kinds.size >= 1 && kinds.size <= 3, k + ' 絵文字の種類: ' + kinds.size);
    assert.doesNotMatch(t.replace(/️/g, ''), /\p{Extended_Pictographic}\s*\p{Extended_Pictographic}/u, k + ' 絵文字が連続');
    assert.doesNotMatch(t, /選択してください|からどうぞ。$|見つかりませんでした|自動応答は停止します/, k);
  }
});

test('ボタン：クイックリプライは13件以内・ラベル20字以内、ボタンテンプレートの本文160字以内・代替テキスト400字以内', () => {
  const e = env({ urls: { BOOKING_SITE_URL: 'https://example.com/book', BOOKING_CONFIRM_URL: 'https://example.com/my',
    PLAN_LIST_URL: 'https://example.com/plans', CHARTER_URL: 'https://example.com/charter' } });
  const all = [];
  for (const t of ['お問い合わせ', 'FAQ', '予約', '予約確認', 'プラン', 'チャーター', '料金', '雨天', 'キャンセル', '集合場所', 'ヘリの色']) all.push(...send(e, textEv(t)));
  for (const d of ['a=inq_cat&c=2', 'a=inq_cancel', 'a=menu_unset&item=PLANS', 'a=faq_list']) all.push(...send(e, pbEv(d)));
  assert.ok(all.length > 15);
  for (const m of all) {
    if (m.type === 'text') assert.ok(m.text.length <= 5000);
    if (m.quickReply) {
      assert.ok(m.quickReply.items.length <= 13);
      m.quickReply.items.forEach((i) => assert.ok(i.action.label.length <= 20, i.action.label));
    }
    if (m.type === 'template') {
      assert.ok(m.template.text.length <= 160);
      assert.ok(m.altText.length <= 400);
    }
  }
});
