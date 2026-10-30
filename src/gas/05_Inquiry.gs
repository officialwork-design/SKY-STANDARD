/**
 * 05_Inquiry.gs
 * お問い合わせ（4カテゴリ）と、問い合わせ内容の受付。
 *
 * 「お問い合わせ」（リッチメニュー postback a=inq_start／「お問い合わせ」と送信）→ 4項目のボタン:
 *   チャーター見積         a=inq_cat&c=4 → 必要事項の案内 → 内容を受信 → 受付・保存 → 有人対応へ（自動返信停止）
 *   フライト予約について   a=inq_cat&c=1 → 予約サイト（未公開なら準備中）を案内。解決しなければ「オペレーターに相談」
 *   その他のお問い合わせ   a=inq_cat&c=5 → 自由入力の案内 → 内容を受信 → 受付・保存 → 有人対応へ
 *   オペレーターに相談     a=inq_operator → 相談内容の案内 → 内容を受信 → 受付・保存 → 有人対応へ
 * 予約の確認・変更はリッチメニュー「予約確認」（06_Reservation.gs）、天候・運航などの一般的な質問は
 * 公式サイトの FAQ に集約するため、このメニューには出さない。
 * 旧メニューの c=2（予約内容の確認・変更）・c=3（天候・運航）のボタンが押された場合は、それぞれ
 * 予約確認・FAQ の案内に振り替える（古いトーク画面のボタン対策）。
 *
 * 受付・保存・自動返信の停止は 12_Operator.gs の共通処理 handoffToOperator_ で行う。
 * チャーター料金は GAS では算出・確約しない（担当者が運航条件と料金を確認して案内する）。
 * 対応期限（○時間以内など）は営業時間が確定するまで約束しない。
 */

/** 種別選択に表示する有人対応の項目 */
var OPERATOR_MENU_LABEL = 'オペレーターに相談';

/** 問い合わせ種別（キーは postback の c。既存の番号を維持） */
var INQUIRY_CATEGORIES = {
  '4': { label: 'チャーター見積', important: true, input: true },
  '1': { label: 'フライト予約について', important: false, input: false },
  '5': { label: 'その他のお問い合わせ', important: false, input: true }
};
/** 種別選択のボタンの並び（オペレーターに相談は最後に付ける） */
var INQUIRY_MENU_ORDER = ['4', '1', '5'];
/** 「オペレーターに相談」の内容入力（種別キー） */
var OPERATOR_CATEGORY_KEY = 'op';

/** お問い合わせ開始（種別選択）の本文。選択肢はクイックリプライのボタンで表示する */
var MSG_INQUIRY_MENU = '🚁 お問い合わせありがとうございます。\nご希望の内容を下記よりお選びくださいませ。';

/** 種別を選んだ後の案内 */
var INQUIRY_GUIDE_TEXT = {
  '4': '📩【チャーター見積】\n下記をご記入のうえ、1通のメッセージでお送りくださいませ。未定の項目は「未定」で構いません。\n\n' +
    '・希望日時\n・出発地\n・目的地\n・搭乗人数\n・利用目的\n・その他のご要望',
  '5': '📩【その他のお問い合わせ】\nお問い合わせ内容を、1通のメッセージでお送りくださいませ。'
};
var FLIGHT_GUIDE_TEXT = '🚁 フライトのご予約は、公式サイトにて地域・プラン・コースをお選びいただき、日時と人数をご入力のうえお申し込みいただけます。\n' +
  '解決しない場合は、下記よりオペレーターにご相談くださいませ。';
var FLIGHT_GUIDE_PENDING_TEXT = '🚁 オンラインでのご予約受付は、現在準備中でございます。\n' +
  'ご予約のご相談は、下記よりオペレーターが承ります。';

/** 種別選択メッセージ（本文は短い案内のみ。選択肢はボタン） */
function buildInquiryCategoryMessage_() {
  var items = INQUIRY_MENU_ORDER.map(function (k) {
    var label = INQUIRY_CATEGORIES[k].label;
    return postbackAction_(label, 'a=inq_cat&c=' + k, label);
  });
  items.push(postbackAction_(OPERATOR_MENU_LABEL, 'a=inq_operator', OPERATOR_MENU_LABEL));
  return withQuickReply_(MSG_INQUIRY_MENU, items);
}

function getInquiryState_(userId) {
  if (!userId) return null;
  var v = CacheService.getScriptCache().get('inq:' + userId);
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

/** 問い合わせ内容の入力待ちにする（予約確認の入力待ちは取り消す） */
function setInquiryState_(userId, state) {
  CacheService.getScriptCache().remove('rsv:' + userId);
  CacheService.getScriptCache().put('inq:' + userId, JSON.stringify(state), APP.INQUIRY_STATE_TTL_SEC);
}

function clearInquiryState_(userId) {
  if (userId) CacheService.getScriptCache().remove('inq:' + userId);
}

/** 応答が LINE に受理された（または署名検証済み）場合だけ状態を変える */
function replyThenSetInquiryState_(ev, userId, message, state) {
  var res = replyMessage_(ev.replyToken, message);
  if (userId && (__replySent || isVerifiedEvent_())) setInquiryState_(userId, state);
  return res;
}

/** 種別を選んだとき（postback a=inq_cat&c=N） */
function startInquiry_(ev, userId, categoryKey) {
  var k = String(categoryKey || '');
  if (k === '2') return startReservationCheck_(ev, userId); // 旧メニュー：予約内容の確認・変更
  if (k === '1' || k === '3') {
    // 案内だけで入力は受けないため、前の入力待ちは中断する（旧メニュー：天候・運航 → FAQ）
    var r = replyMessage_(ev.replyToken, k === '1' ? buildFlightGuideMessage_() : buildFaqPageMessage_());
    if (userId && (__replySent || isVerifiedEvent_())) { clearInquiryState_(userId); clearReservationState_(userId); }
    return r;
  }
  var cat = INQUIRY_CATEGORIES[k];
  if (!cat || !userId) return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  return replyThenSetInquiryState_(ev, userId,
    withQuickReply_(INQUIRY_GUIDE_TEXT[k], [postbackAction_('入力をやめる', 'a=inq_cancel', '入力をやめる')]), { c: k });
}

/** フライト予約について：予約サイトを案内し、解決しなければオペレーターへ */
function buildFlightGuideMessage_() {
  var op = [postbackAction_(OPERATOR_MENU_LABEL, 'a=inq_operator', OPERATOR_MENU_LABEL)];
  var url = getUrlSetting_(SETTING_KEYS.BOOKING_URL);
  if (!url) return withQuickReply_(FLIGHT_GUIDE_PENDING_TEXT, op);
  var msgs = buildLinkMessage_(FLIGHT_GUIDE_TEXT, 'ご予約はこちら', url);
  var last = msgs[msgs.length - 1];
  withQuickReply_(last, op);
  return msgs;
}

/**
 * 「オペレーターに相談」（postback a=inq_operator、予約確認からは rid=予約ID 付き）。
 * 相談内容の入力を案内し、内容を受け取ったら受付・有人対応に切り替える。
 */
function startOperatorRequest_(ev, userId, reservationId) {
  if (!userId) return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  var rid = normalizeReservationId_(reservationId);
  var state = { c: OPERATOR_CATEGORY_KEY };
  if (rid) state.rid = rid;
  return replyThenSetInquiryState_(ev, userId,
    withQuickReply_(operatorPromptText_(rid), [postbackAction_('入力をやめる', 'a=inq_cancel', '入力をやめる')]), state);
}

/** 問い合わせ内容を受け取ったとき（入力待ち中のテキスト） */
function handleInquiryInput_(ev, userId, text) {
  var state = getInquiryState_(userId) || {};
  var key = String(state.c || '');
  var label, important = false, note = '';
  if (key === OPERATOR_CATEGORY_KEY) {
    label = OPERATOR.CATEGORY_LABEL;
  } else if (INQUIRY_CATEGORIES[key] && INQUIRY_CATEGORIES[key].input) {
    label = INQUIRY_CATEGORIES[key].label;
    important = INQUIRY_CATEGORIES[key].important;
  } else {
    // 旧版の入力待ち（c=1〜3）が残っていた場合は「その他」として受け付ける
    label = INQUIRY_CATEGORIES['5'].label;
  }
  var content = String(text || '');
  if (state.rid) {
    // postback の予約IDは信用しない。受付時にその LINE アカウントの予約か確認して、確認できた場合だけ「本人確認済み」と記す
    var own = null;
    try { own = findOwnReservation_(userId, state.rid); } catch (e) { own = null; }
    content = '【予約ID：' + state.rid + (own ? '（本人確認済み）' : '（お客様申告・本人未確認）') + '】\n' + content;
    note = '予約確認から';
  }
  return handoffToOperator_(ev, userId, { category: label, content: content, important: important, note: note,
    ack: key === OPERATOR_CATEGORY_KEY ? 'operator' : key === '4' ? 'charter' : 'inquiry' });
}

/**
 * 受付IDの予約（シート上の最大番号とキャッシュ上の採番済み番号の大きい方＋1）。
 * 応答 API 呼び出しの間ロックを保持しないため、同時受付でも同じ ID にならないよう採番だけをロック内で行う。
 */
function reserveInquiryId_() {
  return withLock_(reserveInquiryIdLocked_);
}

/** 受付IDの採番本体（ロック内で呼ぶこと。ロックは入れ子にしない） */
function reserveInquiryIdLocked_() {
  return (function () {
    var cache = CacheService.getScriptCache();
    var day = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd');
    var key = 'inqseq:' + day;
    var fromSheet = parseInt(nextId_('INQ', SHEETS.INQUIRIES, '受付ID').split('-').pop(), 10);
    var fromCache = parseInt(cache.get(key) || '0', 10) + 1;
    var n = Math.max(fromSheet, fromCache);
    cache.put(key, String(n), 21600);
    return 'INQ-' + day + '-' + ('000' + n).slice(-4);
  })();
}

/**
 * Webhook イベントごとに受付IDを予約する（同じイベントには同じ受付IDを返し、二重発行しない）。
 * 照合はロック内で、キャッシュ inqevt:<イベントID>（6時間）と「問い合わせ管理」の LINEイベントID 列の両方で行う。
 * @return {{id:string, dup:boolean}} dup=true は受付済み（同じ受付IDを案内するだけにする）
 */
function reserveInquiryIdForEvent_(eventId) {
  if (!eventId) return { id: reserveInquiryId_(), dup: false };
  return withLock_(function () {
    var cache = CacheService.getScriptCache();
    var key = 'inqevt:' + eventId;
    var known = cache.get(key) || findInquiryByEventId_(eventId);
    if (known) return { id: known, dup: true };
    var id = reserveInquiryIdLocked_();
    cache.put(key, id, 21600);
    return { id: id, dup: false };
  });
}

/** 「担当者に送る」：直前の未一致メッセージを「その他のお問い合わせ」として受け付け、有人対応へ */
function handoffLastMessage_(ev, userId) {
  var cache = CacheService.getScriptCache();
  var last = userId ? cache.get('last:' + userId) : null;
  if (!last) return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  return handoffToOperator_(ev, userId, { category: INQUIRY_CATEGORIES['5'].label, content: last,
    note: '自動応答で未一致→担当者に送る', ack: 'inquiry' });
}

/** 受付完了の文面（種類別）。受付IDを必ず含める */
function inquiryReceivedText_(id, kind) {
  if (kind === 'charter') {
    return '✅ チャーターのお見積りのご依頼を承りました。\n🔖 受付ID：' + id +
      '\n\n担当者が運航条件と料金を確認のうえ、このトークでご案内いたします。ご案内まで、自動返信を一時停止いたします。';
  }
  if (kind === 'operator') {
    return '💬 ご相談内容を承りました。\n🔖 受付ID：' + id +
      '\n\n担当スタッフがこのトークで順次ご返信いたします。対応中は、自動返信を一時停止いたします。';
  }
  return '✅ お問い合わせを承りました。\n🔖 受付ID：' + id +
    '\n\n担当者が内容を確認のうえ、このトークで順次ご返信いたします。それまで、自動返信を一時停止いたします。';
}

/** 運営通知（既存の通知先：ADMIN_NOTIFY_TARGET の LINE／ADMIN_EMAIL。重要カテゴリは件名に【重要】） */
function notifyInquiry_(id, cat, text) {
  var head = (cat.important ? '【重要】' : '') + '新しいお問い合わせ';
  var body = head + '\n受付ID：' + id + '\n種別：' + cat.label + '\n内容：' + String(text || '').substring(0, 300) +
    '\n\nこの利用者への自動返信は停止しています。LINE Official Account Manager のチャットから返信し、' +
    '対応が終わったら「問い合わせ管理」の自動返信有効を TRUE にしてください。';
  return notifyAdmin_(head + ' ' + id, body);
}
