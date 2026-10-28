/**
 * 05_Inquiry.gs
 * 問い合わせ受付・保存（シート「問い合わせ管理」）・有人対応への切り替え。
 *
 * フロー:
 *   「お問い合わせ」→ 種別を選択（postback a=inq_cat&c=N）→ 内容をテキスト送信 → 保存・受付返信・運営通知
 *   自動応答で一致しなかった文は「担当者に送る」で、そのまま問い合わせとして登録できる。
 *
 * 対応期限（○時間以内など）は営業時間が確定するまで約束しない。
 */

/** 種別選択に表示する有人対応の項目 */
var OPERATOR_MENU_LABEL = 'オペレーターに相談';

var INQUIRY_CATEGORIES = {
  '1': { label: 'フライト予約について', important: false },
  '2': { label: '予約内容の確認・変更', important: true },
  '3': { label: '天候・運航について', important: true },
  '4': { label: 'チャーター見積', important: true },
  '5': { label: 'その他のお問い合わせ', important: false }
};

/** お問い合わせ開始（種別選択）の本文。選択肢はクイックリプライのボタンで表示する */
var MSG_INQUIRY_MENU = '🚁 お問い合わせありがとうございます。\nご希望の内容を下記よりお選びくださいませ。';

/** 種別選択メッセージ */
function buildInquiryCategoryMessage_() {
  var items = Object.keys(INQUIRY_CATEGORIES).map(function (k) {
    var label = INQUIRY_CATEGORIES[k].label;
    return postbackAction_(label, 'a=inq_cat&c=' + k, label);
  });
  // 有人対応（12_Operator.gs）。選択すると担当者が LINE のチャット画面から返信し、その間は自動応答を停止する
  items.push(postbackAction_(OPERATOR_MENU_LABEL, 'a=inq_operator', OPERATOR_MENU_LABEL));
  // 選択肢はボタンに表示されるため、本文には繰り返さない
  return withQuickReply_(MSG_INQUIRY_MENU, items);
}

function getInquiryState_(userId) {
  var v = CacheService.getScriptCache().get('inq:' + userId);
  return v ? JSON.parse(v) : null;
}

function setInquiryState_(userId, state) {
  CacheService.getScriptCache().put('inq:' + userId, JSON.stringify(state), APP.INQUIRY_STATE_TTL_SEC);
}

function clearInquiryState_(userId) {
  if (userId) CacheService.getScriptCache().remove('inq:' + userId);
}

/** 種別選択後：内容入力待ちにする */
function startInquiry_(ev, userId, categoryKey) {
  var cat = INQUIRY_CATEGORIES[categoryKey];
  if (!cat || !userId) return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  var guide = categoryKey === '4'
    ? '📩【チャーター見積】\nご希望日・人数・出発地／目的地・ご予算などを、1通のメッセージでお送りくださいませ。'
    : '📩【' + cat.label + '】\nお問い合わせ内容を、1通のメッセージでお送りくださいませ。' +
      (categoryKey === '2' ? '\n🔖 予約番号をお持ちの場合は、併せてご記入ください。' : '');
  // 応答が LINE に受理されてから入力待ち状態にする（偽装イベントで他人の状態を変えさせない）
  var res = replyMessage_(ev.replyToken, withQuickReply_(guide, [postbackAction_('入力をやめる', 'a=inq_cancel', '入力をやめる')]));
  if (__replySent || isVerifiedEvent_()) setInquiryState_(userId, { c: categoryKey });
  return res;
}

/** 内容入力を受け付けて保存 */
function handleInquiryInput_(ev, userId, text) {
  var state = getInquiryState_(userId);
  var cat = INQUIRY_CATEGORIES[state && state.c] || INQUIRY_CATEGORIES['5'];
  if (!isVerifiedEvent_()) return acceptInquiryUnverified_(ev, userId, cat, text, '');
  clearInquiryState_(userId);
  var id = saveInquiry_(userId, cat, text);
  notifyInquiry_(id, cat, text); // 返信に失敗しても運営には必ず通知する
  replyReceivedSafely_(ev, id);
  return id;
}

/**
 * 未検証イベント（GAS単体受信）の問い合わせ受付。
 * 受付IDを予約して先に応答し、LINE が応答を受理した（＝本物の応答トークン）場合のみ保存・運営通知する。
 * 応答に失敗・応答トークンなしの場合は何も保存せず、入力待ち状態も変更しない。
 * 応答後に保存が失敗した場合は、運営に「保存失敗」として内容を通知する（LINE の再送は来ないため）。
 */
function acceptInquiryUnverified_(ev, userId, cat, text, note) {
  var id = reserveInquiryId_();
  try {
    replyMessage_(ev.replyToken, inquiryReceivedText_(id));
  } catch (e) {
    logWarn_('inquiry.unverified_reply_rejected', { status: e.status });
    throw e;
  }
  if (!__replySent) {
    logWarn_('inquiry.unverified_no_reply', {});
    return null;
  }
  clearInquiryState_(userId);
  CacheService.getScriptCache().remove('last:' + userId);
  try {
    withLock_(function () {
      appendRow_(SHEETS.INQUIRIES, {
        '受付ID': id, 'LINEユーザーID': userId, '受付日時': nowString_(), '種別': cat.label,
        '内容': String(text || '').substring(0, 5000), '対応状況': '未対応', '担当者': '', '回答日時': '',
        '備考': [note, cat.important ? '重要' : '', 'GAS単体受信（応答トークン確認済み・署名未検証）'].filter(String).join(' / '),
        '自動返信有効': true
      });
    });
    logInfo_('inquiry.saved', { id: id, category: cat.label, userId: userId, verified: false });
  } catch (e) {
    logError_('inquiry.save_failed_after_reply', e, { id: id });
    notifyAdmin_('【要対応】問い合わせの保存に失敗 ' + id, '利用者には受付IDを返信済みですが、シートへの保存に失敗しました。\n受付ID：' + id +
      '\n種別：' + cat.label + '\n内容：' + String(text || '').substring(0, 300) + '\n\n「問い合わせ管理」に手動で追記してください。');
    return id;
  }
  notifyInquiry_(id, cat, text);
  return id;
}

/**
 * 受付IDの予約（シート上の最大番号とキャッシュ上の採番済み番号の大きい方＋1）。
 * 応答 API 呼び出しの間ロックを保持しないため、同時受付でも同じ ID にならないよう採番だけをロック内で行う。
 */
function reserveInquiryId_() {
  return withLock_(function () {
    var cache = CacheService.getScriptCache();
    var day = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd');
    var key = 'inqseq:' + day;
    var fromSheet = parseInt(nextId_('INQ', SHEETS.INQUIRIES, '受付ID').split('-').pop(), 10);
    var fromCache = parseInt(cache.get(key) || '0', 10) + 1;
    var n = Math.max(fromSheet, fromCache);
    cache.put(key, String(n), 21600);
    return 'INQ-' + day + '-' + ('000' + n).slice(-4);
  });
}

/** 「担当者に送る」：直前の未一致メッセージを問い合わせとして登録 */
function handoffLastMessage_(ev, userId) {
  var cache = CacheService.getScriptCache();
  var last = userId ? cache.get('last:' + userId) : null;
  if (!last) {
    return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  }
  var cat = INQUIRY_CATEGORIES['5'];
  if (!isVerifiedEvent_()) return acceptInquiryUnverified_(ev, userId, cat, last, '自動応答で未一致→有人対応');
  cache.remove('last:' + userId);
  var id = saveInquiry_(userId, cat, last, '自動応答で未一致→有人対応');
  notifyInquiry_(id, cat, last);
  replyReceivedSafely_(ev, id);
  return id;
}

/**
 * 受付返信。保存済みの問い合わせを Webhook 再送で二重登録しないよう、返信失敗は例外にせず記録のみ。
 * 返信できなかった場合はプッシュで受付IDを通知する。
 */
function replyReceivedSafely_(ev, id) {
  try {
    replyMessage_(ev.replyToken, inquiryReceivedText_(id));
  } catch (e) {
    logError_('inquiry.reply_failed', e, { id: id });
    __replySent = true; // 保存済みのため再処理させない
    try { pushMessage_(ev.source && ev.source.userId, inquiryReceivedText_(id), deterministicUuid_('inq-ack:' + id)); }
    catch (e2) { logError_('inquiry.ack_push_failed', e2, { id: id }); }
  }
}

function inquiryReceivedText_(id) {
  return '✅ お問い合わせを承りました。\n🔖 受付ID：' + id + '\n\n内容を確認のうえ、担当者より順次ご連絡いたします。' +
    '追加のご連絡は、受付IDを添えてお送りくださいませ。';
}

/** 問い合わせを保存して受付IDを返す */
function saveInquiry_(userId, cat, text, note) {
  return withLock_(function () {
    var id = nextId_('INQ', SHEETS.INQUIRIES, '受付ID');
    appendRow_(SHEETS.INQUIRIES, {
      '受付ID': id,
      'LINEユーザーID': userId,
      '受付日時': nowString_(),
      '種別': cat.label,
      '内容': String(text || '').substring(0, 5000),
      '対応状況': '未対応',
      '担当者': '',
      '回答日時': '',
      '備考': note || (cat.important ? '重要' : ''),
      '自動返信有効': true // 通常の問い合わせは自動返信を続ける（12_Operator.gs）
    });
    logInfo_('inquiry.saved', { id: id, category: cat.label, userId: userId });
    return id;
  });
}

/** 運営通知（全件通知。重要カテゴリは件名に【重要】） */
function notifyInquiry_(id, cat, text) {
  var head = (cat.important ? '【重要】' : '') + '新しいお問い合わせ';
  var body = head + '\n受付ID：' + id + '\n種別：' + cat.label + '\n内容：' + String(text || '').substring(0, 300) +
    '\n\n詳細はスプレッドシート「問い合わせ管理」を確認してください。';
  notifyAdmin_(head + ' ' + id, body);
}
