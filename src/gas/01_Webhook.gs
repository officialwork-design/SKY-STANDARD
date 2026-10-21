/**
 * 01_Webhook.gs
 * Web アプリの入口（doPost / doGet）とイベント振り分け。
 *
 * ■ なぜリレーが必要か
 *   GAS の doPost(e) では HTTP リクエストヘッダー（X-Line-Signature）を参照できないため、
 *   LINE の署名検証を GAS 単体では行えない。そこで、署名を検証できる入口
 *   （src/relay: Cloud Run 等）で X-Line-Signature を検証し、
 *   共有シークレット RELAY_SHARED_SECRET で HMAC 署名した封筒に包んで GAS へ転送する。
 *   GAS は封筒の HMAC と時刻を検証してから処理する。
 *
 * ■ doPost が受け付ける kind
 *   - line_webhook      : リレー経由の LINE Webhook
 *   - liff_api          : 予約確認画面（LIFF）からの API 呼び出し（IDトークン検証）
 *   - reservation_event : 予約サイトからの予約イベント（HMAC 署名）
 */

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
  return jsonOut_({ ok: true, service: APP.NAME + ' LINE', time: new Date().toISOString() });
}

function doPost(e) {
  var raw = e && e.postData ? e.postData.contents : '';
  var req;
  try {
    req = JSON.parse(raw || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid_json' });
  }

  try {
    if (req.kind === 'line_webhook') return jsonOut_(handleRelayedWebhook_(req));
    if (req.kind === 'liff_api') return jsonOut_(handleLiffApi_(req));
    if (req.kind === 'reservation_event') return jsonOut_(handleReservationEvent_(req));

    // 開発専用: リレーを介さない LINE 直結（署名未検証）。本番では使用禁止。
    if (Array.isArray(req.events) && req.destination !== undefined) {
      if (getProp_(PROP_KEYS.ALLOW_UNSIGNED_WEBHOOK) === 'true') {
        logWarn_('webhook.unsigned_accepted', { count: req.events.length });
        return jsonOut_(processLineEvents_(req.events));
      }
      logWarn_('webhook.unsigned_rejected', {});
      return jsonOut_({ ok: false, error: 'signature_required' });
    }
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

/* ---------- 署名検証 ---------- */

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
 * リレー封筒の検証。
 * 封筒: { kind:'line_webhook', ts:<epoch ms>, body:'<LINE の生 JSON 文字列>', sig: base64(HMAC(secret, ts + "." + body)) }
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
  return processLineEvents_(payload.events || []);
}

/* ---------- イベント処理 ---------- */

/**
 * LINE イベント配列を処理。webhookEventId で重複排除する。
 * Webhook の「検証」ボタン（events が空）は ok を返す。
 */
function processLineEvents_(events) {
  var handled = 0, skipped = 0, retryable = 0;
  events.forEach(function (ev) {
    if (!claimEvent_(ev.webhookEventId)) {
      skipped++;
      logInfo_('webhook.duplicate_skipped', { id: ev.webhookEventId, redelivery: ev.deliveryContext && ev.deliveryContext.isRedelivery });
      return;
    }
    __replySent = false;
    try {
      dispatchEvent_(ev);
      handled++;
    } catch (err) {
      logError_('webhook.event_failed', err, { type: ev.type });
      // 利用者へ未応答かつ一時的な失敗なら登録を解除し、LINE の再送で再処理できるようにする。
      // （応答済み、または 400 等の恒久エラーは再処理しても改善しないため解除しない）
      var permanent = (err instanceof LineApiError && !err.retryable) || err instanceof ConfigError;
      if (ev.webhookEventId && !__replySent && !permanent) {
        CacheService.getScriptCache().remove('evt:' + ev.webhookEventId);
        retryable++;
      }
    }
  });
  // retryable>0 の場合 ok:false を返し、リレーは LINE に 500 を返す（→ LINE が再送）
  return { ok: retryable === 0, handled: handled, skipped: skipped, retryable: retryable };
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

/** 友だち追加 */
function handleFollow_(ev, userId) {
  if (userId) {
    try { registerCustomer_(userId); } catch (e) { logError_('customer.register_failed', e); }
  }
  var tpl = getTemplate_('WELCOME');
  var text = tpl || DEFAULT_WELCOME_MESSAGE;
  return replyMessage_(ev.replyToken, withQuickReply_(text, mainQuickReplies_()));
}

/** ブロック */
function handleUnfollow_(userId) {
  if (userId) {
    try { markCustomerUnfollowed_(userId); } catch (e) { logError_('customer.unfollow_failed', e); }
  }
}

/** テキストメッセージ */
function handleTextMessage_(ev, userId, text) {
  // 1) 問い合わせ入力待ちなら受付
  //    ただしメニュー操作（「予約」「FAQ」等の定型語の完全一致）は入力を取り消してそちらを優先
  if (userId && getInquiryState_(userId)) {
    if (!matchIntentExact_(normalizeText_(text))) return handleInquiryInput_(ev, userId, text);
    clearInquiryState_(userId);
  }
  // 2) キーワード・FAQ 応答
  var messages = buildAutoReply_(text, userId);
  return replyMessage_(ev.replyToken, messages);
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
      clearInquiryState_(userId);
      return replyMessage_(ev.replyToken, 'お問い合わせの入力を取り消しました。');
    case 'inq_handoff':
      return handoffLastMessage_(ev, userId);
    case 'faq':
      return replyMessage_(ev.replyToken, buildFaqAnswerById_(p.id));
    case 'faq_list':
      return replyMessage_(ev.replyToken, buildFaqMenu_());
    case 'menu_unset':
      logWarn_('richmenu.unset_tapped', { item: p.item });
      return replyMessage_(ev.replyToken, '「' + (p.item || 'このメニュー') + '」は現在準備中です。お手数ですが「お問い合わせ」からご連絡ください。');
    default:
      logInfo_('postback.unknown', { a: p.a });
  }
}

function parseQuery_(s) {
  var out = {};
  String(s).split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = decodeURIComponent(i < 0 ? kv : kv.substring(0, i));
    var v = i < 0 ? '' : decodeURIComponent(kv.substring(i + 1));
    out[k] = v;
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
