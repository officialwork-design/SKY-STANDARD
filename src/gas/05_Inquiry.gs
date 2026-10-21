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

var INQUIRY_CATEGORIES = {
  '1': { label: 'フライト予約について', important: false },
  '2': { label: '予約内容の確認・変更', important: true },
  '3': { label: '天候・運航について', important: true },
  '4': { label: 'チャーター見積', important: true },
  '5': { label: 'その他のお問い合わせ', important: false }
};

/** 種別選択メッセージ */
function buildInquiryCategoryMessage_() {
  var items = Object.keys(INQUIRY_CATEGORIES).map(function (k) {
    var label = INQUIRY_CATEGORIES[k].label;
    return postbackAction_(label, 'a=inq_cat&c=' + k, label);
  });
  return withQuickReply_('お問い合わせありがとうございます。\nお問い合わせの種類を下から選択してください。\n\n' +
    Object.keys(INQUIRY_CATEGORIES).map(function (k) { return k + '. ' + INQUIRY_CATEGORIES[k].label; }).join('\n'), items);
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
  setInquiryState_(userId, { c: categoryKey });
  var guide = categoryKey === '4'
    ? '【チャーター見積】\nご希望日・人数・出発地／目的地・ご予算などを、1通のメッセージでお送りください。'
    : '【' + cat.label + '】\nお問い合わせ内容を1通のメッセージでお送りください。' +
      (categoryKey === '2' ? '\n予約番号をお持ちの場合は併せてご記入ください。' : '');
  return replyMessage_(ev.replyToken, withQuickReply_(guide, [postbackAction_('入力をやめる', 'a=inq_cancel', '入力をやめる')]));
}

/** 内容入力を受け付けて保存 */
function handleInquiryInput_(ev, userId, text) {
  var state = getInquiryState_(userId);
  clearInquiryState_(userId);
  var cat = INQUIRY_CATEGORIES[state && state.c] || INQUIRY_CATEGORIES['5'];
  var id = saveInquiry_(userId, cat, text);
  notifyInquiry_(id, cat, text); // 返信に失敗しても運営には必ず通知する
  replyReceivedSafely_(ev, id);
  return id;
}

/** 「担当者に送る」：直前の未一致メッセージを問い合わせとして登録 */
function handoffLastMessage_(ev, userId) {
  var cache = CacheService.getScriptCache();
  var last = userId ? cache.get('last:' + userId) : null;
  if (!last) {
    return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  }
  cache.remove('last:' + userId);
  var cat = INQUIRY_CATEGORIES['5'];
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
  return 'お問い合わせを受け付けました。\n受付ID：' + id + '\n\n内容を確認のうえ、担当者より順次ご連絡いたします。' +
    '追加のご連絡がある場合は、受付IDを添えてお送りください。';
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
      '備考': note || (cat.important ? '重要' : '')
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
