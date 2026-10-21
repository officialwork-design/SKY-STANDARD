/**
 * 01_Webhook.gs
 * Web アプリの入口（doPost / doGet）とイベント振り分け。
 *
 * ■ 受信方式（スクリプトプロパティ WEBHOOK_MODE）
 *   direct（既定・GAS単体）: LINE → GAS Web アプリに直接 Webhook を送る。
 *   relay（任意・旧構成）  : LINE → 署名検証リレー（src/relay, Cloud Run 等）→ GAS。
 *
 * ■ GAS単体（direct）の制約 ― 重要
 *   GAS の doPost(e) にはリクエストヘッダーが渡されない（e のキーは contentLength / contextPath /
 *   parameter / parameters / postData / queryString のみ。2026-10-21 実測）。
 *   そのため X-Line-Signature を検証できず、受け取った Webhook が本当に LINE から来たものかを
 *   暗号学的に確認できない。Web アプリの URL を知っている人は、LINE を装ったリクエストを送れる。
 *   URL を秘密にしても、共有トークンを付けても、署名検証の代わりにはならない（LINE は任意のヘッダー・
 *   トークンを付けられず、URL は LINE の設定画面・ログ等から漏れうるため）。
 *
 *   この前提で、direct で受けたイベントはすべて「未検証」として扱い、次のように処理を制限する。
 *     - 予約確定・決済完了・キャンセル等の予約状態の変更は Webhook からは一切行わない
 *       （予約サイトからの HMAC 署名付き reservation_event のみ）
 *     - 予約内容・個人情報は Webhook の応答に含めない（予約確認は LIFF＋ID トークン検証のみ）
 *     - 管理者操作は Webhook からは実行できない（管理メニュー＝ライブラリ経由＋ADMIN_USERS のみ）
 *     - 顧客登録・問い合わせ保存・運営通知など「記録や外部通知を伴う処理」は、
 *       先に LINE の応答 API（reply）が成功した場合にのみ実行する（応答トークン確認）。
 *       応答トークンは LINE が発行する1回限りの値で、偽造イベントの応答は LINE に拒否されるため、
 *       偽造イベントによる記録・通知の大半を防げる。ただしこれは補助的な対策であり、
 *       署名検証と同等の保証ではない（イベント本文の改ざん検知などはできない）。
 *     - ブロック（unfollow）は応答トークンがないため、プロフィール API で友だちでないことを
 *       確認できた場合のみ反映する。
 *
 * ■ HTTP 302 について
 *   ContentService の応答は 302（script.googleusercontent.com へのリダイレクト）になり、
 *   LINE はリダイレクトを追わないため「302 で失敗」と表示される（doPost 自体は実行される）。
 *   HtmlService の応答は 200 で返る（2026-10-21 実測）ため、LINE からの Webhook には HtmlService で応答する。
 *
 * ■ doPost が受け付ける形式
 *   - LINE Webhook（destination と events を持つ JSON）: direct モードで受信（未検証扱い）
 *   - { kind:'line_webhook' }      : リレー経由（署名検証済み）
 *   - { kind:'liff_api' }          : 予約確認画面（ID トークンをサーバー側で検証）
 *   - { kind:'reservation_event' } : 予約サイトからの予約イベント（HMAC 署名）
 */

/** Webhook の受信方式 */
var WEBHOOK_MODES = { DIRECT: 'direct', RELAY: 'relay' };

/** 1リクエストで受け付けるイベント数の上限（異常データ対策） */
var MAX_EVENTS_PER_REQUEST = 50;
/** 受け付けるイベントの最大経過時間（再送を含めても十分な幅） */
var MAX_EVENT_AGE_MS = 24 * 3600 * 1000;

/** 現在処理中のイベントの信頼度（verified=署名検証済み）。既定は未検証（安全側） */
var __eventTrust = { verified: false };

function getWebhookMode_() {
  var v = getProp_(PROP_KEYS.WEBHOOK_MODE).toLowerCase();
  return v === WEBHOOK_MODES.RELAY ? WEBHOOK_MODES.RELAY : WEBHOOK_MODES.DIRECT;
}

function doGet(e) {
  // トリガー同期（管理者が管理メニューで要求した場合のみ作成。詳細は 11_Admin.gs）
  if (e && e.parameter && e.parameter.sync === 'triggers') {
    try {
      var r = handleTriggerSync_();
      return jsonOut_({ ok: r.ok, installed: r.installed });
    } catch (err) {
      logError_('triggers.sync_failed', err);
      return jsonOut_({ ok: false, error: 'internal_error' });
    }
  }
  // ヘルスチェック。設定値・内部情報は返さない。
  return jsonOut_({ ok: true, service: APP.NAME + ' LINE', build: APP.BUILD, time: new Date().toISOString() });
}

function doPost(e) {
  var raw = e && e.postData ? String(e.postData.contents || '') : '';
  var req;
  try {
    req = JSON.parse(raw || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid_json' });
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return jsonOut_({ ok: false, error: 'invalid_body' });

  // LINE からの直接 Webhook（HtmlService で応答し HTTP 200 を返す）
  if (isLineWebhookBody_(req)) return handleDirectWebhookRequest_(req, raw.length);

  try {
    if (req.kind === 'line_webhook') return jsonOut_(handleRelayedWebhook_(req));
    if (req.kind === 'liff_api') return jsonOut_(handleLiffApi_(req));
    if (req.kind === 'reservation_event') return jsonOut_(handleReservationEvent_(req));
    return jsonOut_({ ok: false, error: 'unknown_kind' });
  } catch (err) {
    if (err instanceof ConfigError) {
      logError_('config.missing', err, { missing: err.missingKeys });
      return jsonOut_({ ok: false, error: 'not_configured' });
    }
    logError_('doPost.unhandled', err, { kind: req.kind });
    return jsonOut_({ ok: false, error: 'internal_error' });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** LINE Webhook への応答。HtmlService は 302 にならず 200 で返る（ContentService は 302） */
function lineAckOut_() {
  return HtmlService.createHtmlOutput('OK');
}

function isLineWebhookBody_(req) {
  return req.kind === undefined && Object.prototype.hasOwnProperty.call(req, 'destination') && Array.isArray(req.events);
}

/* ---------- GAS単体（direct）受信 ---------- */

/**
 * LINE から直接届いた Webhook を処理する。常に HTTP 200（HtmlService）で応答する。
 * イベントは未検証として扱い、受信記録（診断用）→ 形式検証 → 制限付き処理 の順に行う。
 */
function handleDirectWebhookRequest_(req, rawLength) {
  try {
    recordWebhookReceipt_(req.events.length);
    if (getWebhookMode_() !== WEBHOOK_MODES.DIRECT) {
      logWarn_('webhook.direct_rejected_relay_mode', {});
      return lineAckOut_();
    }
    if (rawLength > 1024 * 1024) {
      logWarn_('webhook.too_large', { bytes: rawLength });
      return lineAckOut_();
    }
    if (!/^U[0-9a-f]{32}$/.test(String(req.destination))) {
      logWarn_('webhook.invalid_destination', {});
      return lineAckOut_();
    }
    var botId = getProp_(PROP_KEYS.BOT_USER_ID);
    if (botId && req.destination !== botId) {
      // ボットのユーザーIDは秘密情報ではないため認証にはならない（明らかに無関係なリクエストの除外のみ）
      logWarn_('webhook.destination_mismatch', {});
      return lineAckOut_();
    }
    if (req.events.length > MAX_EVENTS_PER_REQUEST) {
      logWarn_('webhook.too_many_events', { count: req.events.length });
      return lineAckOut_();
    }
    var valid = [];
    req.events.forEach(function (ev) {
      var reason = validateLineEvent_(ev);
      if (reason) logWarn_('webhook.invalid_event', { reason: reason });
      else valid.push(ev);
    });
    processLineEvents_(valid, { verified: false });
  } catch (err) {
    if (err instanceof ConfigError) logError_('config.missing', err, { missing: err.missingKeys });
    else logError_('webhook.direct_failed', err);
  }
  return lineAckOut_();
}

/** 受信記録（管理メニューの「LINE接続チェック」で LINE→GAS の到達確認に使う。内容は記録しない） */
function recordWebhookReceipt_(eventCount) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(PROP_KEYS.LAST_WEBHOOK_AT, String(Date.now()));
    props.setProperty(PROP_KEYS.LAST_WEBHOOK_EVENTS, String(eventCount));
  } catch (e) { /* 記録失敗は無視 */ }
}

/**
 * LINE イベントの形式検証。問題があれば理由を返す（null=OK）。
 * 正しい形式であることは「LINE から来た」ことの証明にはならない。
 */
function validateLineEvent_(ev) {
  if (!ev || typeof ev !== 'object') return 'not_object';
  var types = ['message', 'follow', 'unfollow', 'postback', 'join', 'leave', 'memberJoined', 'memberLeft', 'unsend',
    'videoPlayComplete', 'beacon', 'accountLink', 'things', 'membership'];
  if (types.indexOf(ev.type) === -1) return 'unknown_type';
  if (typeof ev.webhookEventId !== 'string' || !/^[0-9A-Z]{26}$/.test(ev.webhookEventId)) return 'invalid_event_id';
  var ts = Number(ev.timestamp);
  if (!isFinite(ts) || ts > Date.now() + APP.MAX_CLOCK_SKEW_MS || ts < Date.now() - MAX_EVENT_AGE_MS) return 'invalid_timestamp';
  if (!ev.source || ['user', 'group', 'room'].indexOf(ev.source.type) === -1) return 'invalid_source';
  if (ev.source.userId !== undefined && !/^U[0-9a-f]{32}$/.test(String(ev.source.userId))) return 'invalid_user_id';
  // message / postback / follow には必ず応答トークンがある（未検証イベントの記録は応答成功を条件にするため必須）
  var needsToken = ['message', 'postback', 'follow'].indexOf(ev.type) !== -1;
  if (needsToken && ev.replyToken === undefined) return 'missing_reply_token';
  if (ev.replyToken !== undefined && (typeof ev.replyToken !== 'string' || !/^[A-Za-z0-9]{16,128}$/.test(ev.replyToken))) return 'invalid_reply_token';
  if (ev.type === 'message') {
    if (!ev.message || typeof ev.message.type !== 'string') return 'invalid_message';
    if (ev.message.type === 'text' && (typeof ev.message.text !== 'string' || ev.message.text.length > 5000)) return 'invalid_text';
  }
  if (ev.type === 'postback' && (!ev.postback || typeof ev.postback.data !== 'string' || ev.postback.data.length > 300)) return 'invalid_postback';
  return null;
}

/* ---------- 署名検証（リレー経由・予約イベント） ---------- */

/** HMAC-SHA256 を base64 で返す */
function hmacBase64_(message, secret) {
  var sig = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(sig);
}

/** HMAC-SHA256 を16進で返す */
function hmacHex_(message, secret) {
  var sig = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  return sig.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

/** タイミング攻撃を避ける比較 */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length || a.length === 0) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 時刻ずれチェック */
function isFreshTimestamp_(ts) {
  var n = Number(ts);
  return isFinite(n) && Math.abs(Date.now() - n) <= APP.MAX_CLOCK_SKEW_MS;
}

/**
 * リレー封筒の検証（任意構成）。
 * 封筒: { kind:'line_webhook', ts:<epoch ms>, body:'<LINE の生 JSON 文字列>', sig: base64(HMAC(secret, ts + "." + body)) }
 * リレーが X-Line-Signature を検証済みのため、このイベントは「署名検証済み」として扱う。
 */
function handleRelayedWebhook_(req) {
  var secret = requireProp_(PROP_KEYS.RELAY_SHARED_SECRET);
  if (!isFreshTimestamp_(req.ts)) {
    logWarn_('webhook.stale', {});
    return { ok: false, error: 'stale' };
  }
  var expected = hmacBase64_(String(req.ts) + '.' + String(req.body || ''), secret);
  if (!safeEqual_(expected, req.sig)) {
    logWarn_('webhook.bad_signature', {});
    return { ok: false, error: 'bad_signature' };
  }
  var payload = JSON.parse(req.body || '{}');
  recordWebhookReceipt_((payload.events || []).length);
  return processLineEvents_(payload.events || [], { verified: true });
}

/* ---------- イベント処理 ---------- */

/**
 * LINE イベント配列を処理。webhookEventId で重複排除する。
 * @param {Object[]} events
 * @param {{verified:boolean}=} trust verified=false のとき記録・通知は応答成功後のみ
 */
function processLineEvents_(events, trust) {
  var handled = 0, skipped = 0, retryable = 0;
  events.forEach(function (ev) {
    if (!claimEvent_(ev.webhookEventId)) {
      skipped++;
      logInfo_('webhook.duplicate_skipped', { id: ev.webhookEventId, redelivery: ev.deliveryContext && ev.deliveryContext.isRedelivery });
      return;
    }
    __replySent = false;
    __pendingAfterReply = null;
    __eventTrust = { verified: !!(trust && trust.verified) };
    try {
      dispatchEvent_(ev);
      handled++;
    } catch (err) {
      if (!__eventTrust.verified && err instanceof LineApiError && err.status === 400 && /Invalid reply token/i.test(String(err.body || ''))) {
        // 未検証イベントの応答トークンが LINE に拒否された＝偽造・期限切れの可能性。システムエラーではないため警告のみ
        logWarn_('webhook.unverified_reply_rejected', { type: ev.type });
      } else {
        logError_('webhook.event_failed', err, { type: ev.type, verified: __eventTrust.verified });
      }
      // 利用者へ未応答かつ一時的な失敗なら登録を解除し、LINE の再送で再処理できるようにする。
      // （応答済み、または 400 等の恒久エラーは再処理しても改善しないため解除しない）
      var permanent = (err instanceof LineApiError && !err.retryable) || err instanceof ConfigError;
      if (ev.webhookEventId && !__replySent && !permanent) {
        CacheService.getScriptCache().remove('evt:' + ev.webhookEventId);
        retryable++;
      }
    } finally {
      __eventTrust = { verified: false };
    }
  });
  // retryable>0 の場合 ok:false を返し、リレーは LINE に 500 を返す（→ LINE が再送）
  return { ok: retryable === 0, handled: handled, skipped: skipped, retryable: retryable };
}

/** 署名検証済みのイベントか */
function isVerifiedEvent_() {
  return !!__eventTrust.verified;
}

/**
 * イベント ID を1度だけ処理済みとして登録（true=今回処理してよい）。
 * キャッシュ確認と登録をロック内で行い、同時再送による二重処理を防ぐ。
 */
function claimEvent_(eventId) {
  if (!eventId) return true; // ID がないイベント（旧形式）は重複判定不可
  var cache = CacheService.getScriptCache();
  var key = 'evt:' + eventId;
  return withLock_(function () {
    if (cache.get(key)) return false;
    cache.put(key, '1', APP.DEDUP_TTL_SEC);
    return true;
  }, 10000);
}

function dispatchEvent_(ev) {
  var userId = ev.source && ev.source.userId;
  // オペレーター対応モード中（1対1トーク）は一切自動返信しない。ブロック（unfollow）の記録のみ通常どおり行う。
  // 「対応完了」になっていればここで解除され、通常の自動応答に戻る（12_Operator.gs）
  if (userId && ev.source.type === 'user' && ev.type !== 'unfollow' && isOperatorMode_(userId)) {
    return handleOperatorModeEvent_(ev, userId);
  }
  switch (ev.type) {
    case 'follow':
      return handleFollow_(ev, userId);
    case 'unfollow':
      return handleUnfollow_(userId);
    case 'message':
      if (ev.message && ev.message.type === 'text') return handleTextMessage_(ev, userId, ev.message.text);
      return replyMessage_(ev.replyToken, 'メッセージありがとうございます。恐れ入りますが、テキストでお送りいただくか、画面下のメニューをご利用ください。');
    case 'postback':
      return handlePostback_(ev, userId, ev.postback && ev.postback.data);
    default:
      logInfo_('webhook.ignored', { type: ev.type });
  }
}

/** 友だち追加：あいさつを送り、応答が成功したら顧客登録（未検証イベントの偽装登録を防ぐ） */
function handleFollow_(ev, userId) {
  var tpl = getTemplate_('WELCOME');
  var text = tpl || DEFAULT_WELCOME_MESSAGE;
  var register = function () {
    if (!userId) return;
    try { registerCustomer_(userId); } catch (e) { logError_('customer.register_failed', e); }
  };
  if (isVerifiedEvent_()) {
    register();
    return replyMessage_(ev.replyToken, withQuickReply_(text, mainQuickReplies_()));
  }
  // 未検証：応答が LINE に受理された（＝本物の応答トークン）場合のみ登録
  var res = replyMessage_(ev.replyToken, withQuickReply_(text, mainQuickReplies_()));
  if (__replySent) register();
  return res;
}

/**
 * ブロック。応答トークンがないため、未検証イベントはプロフィール API で
 * 「友だちではない」ことを確認できた場合のみ反映する（偽装 unfollow で通知停止されるのを防ぐ）。
 */
function handleUnfollow_(userId) {
  if (!userId) return;
  if (!isVerifiedEvent_()) {
    var state = checkFriendship_(userId);
    if (state !== 'not_friend') {
      logWarn_('webhook.unfollow_unconfirmed', { userId: userId, state: state });
      return;
    }
  }
  try { markCustomerUnfollowed_(userId); } catch (e) { logError_('customer.unfollow_failed', e); }
}

/** テキストメッセージ */
function handleTextMessage_(ev, userId, text) {
  // 1) 問い合わせ入力待ちなら受付
  //    ただしメニュー操作（「予約」「FAQ」等の定型語の完全一致）は入力を取り消してそちらを優先
  var cancelInquiry = false;
  if (userId && getInquiryState_(userId)) {
    if (!matchIntentExact_(normalizeText_(text))) return handleInquiryInput_(ev, userId, text);
    cancelInquiry = true;
  }
  // 2) キーワード・FAQ 応答（記録・状態変更は応答成功後に実行）
  var messages = buildAutoReply_(text, userId);
  var res = replyMessage_(ev.replyToken, messages);
  if (cancelInquiry && (__replySent || isVerifiedEvent_())) clearInquiryState_(userId);
  runAfterReply_();
  return res;
}

/** postback（data は "a=xxx&k=v" 形式） */
function handlePostback_(ev, userId, data) {
  var p = parseQuery_(data || '');
  switch (p.a) {
    case 'inq_start':
      return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
    case 'inq_cat':
      return startInquiry_(ev, userId, p.c);
    case 'inq_cancel':
      var r = replyMessage_(ev.replyToken, 'お問い合わせの入力を取り消しました。');
      if (__replySent || isVerifiedEvent_()) clearInquiryState_(userId);
      return r;
    case 'inq_handoff':
      return handoffLastMessage_(ev, userId);
    case 'inq_operator':
      return startOperatorHandoff_(ev, userId);
    case 'faq':
      return replyMessage_(ev.replyToken, buildFaqAnswerById_(p.id));
    case 'faq_list':
      return replyMessage_(ev.replyToken, buildFaqMenu_());
    case 'menu_unset':
      // リッチメニューの準備中ボタン（URL 未設定）。返信のみで記録・状態変更はしない
      logInfo_('richmenu.pending_tapped', { item: String(p.item || '').substring(0, 20) });
      return replyMessage_(ev.replyToken, buildRichMenuPendingReply_(p.item));
    default:
      logInfo_('postback.unknown', { a: String(p.a || '').substring(0, 20) });
  }
}

/** 応答成功後に実行する処理（未検証イベントの記録を応答トークン確認後に限定するため） */
var __pendingAfterReply = null;

function runAfterReply_() {
  var fn = __pendingAfterReply;
  __pendingAfterReply = null;
  if (fn && (__replySent || isVerifiedEvent_())) fn();
}

function parseQuery_(s) {
  var out = {};
  String(s).split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    try {
      var k = decodeURIComponent(i < 0 ? kv : kv.substring(0, i));
      var v = i < 0 ? '' : decodeURIComponent(kv.substring(i + 1));
      out[k] = v;
    } catch (e) { /* 不正なエンコードは無視 */ }
  });
  return out;
}

/** 主要導線のクイックリプライ */
function mainQuickReplies_() {
  return [
    messageAction_('フライト予約', '予約'),
    messageAction_('予約確認', '予約確認'),
    messageAction_('プラン', 'プラン'),
    messageAction_('よくある質問', 'FAQ'),
    postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ')
  ];
}
