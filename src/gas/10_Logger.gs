/**
 * 10_Logger.gs
 * イベント・送信結果・エラーのログ。
 *
 * - アクセストークン・シークレット・メッセージ本文・電話番号等はログに出さない。
 * - LINE ユーザーID はマスクして出力する。
 * - 送信結果は「送信ログ」シートへ記録する。
 */

/** LINE ユーザーID 等をマスク（先頭5文字のみ残す） */
function maskId_(id) {
  if (!id) return '';
  var s = String(id);
  return s.length <= 5 ? '***' : s.substring(0, 5) + '***';
}

/** ログに出してはいけないキーを除去 */
function scrubForLog_(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  var deny = /token|secret|password|authorization|signature|phone|email|text|message|content|内容|電話|メール|氏名/i;
  var out = Array.isArray(obj) ? [] : {};
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (deny.test(k)) out[k] = '[REDACTED]';
    else if (/userid|lineuserid|to$/i.test(k) && typeof v === 'string') out[k] = maskId_(v);
    else if (v && typeof v === 'object') out[k] = scrubForLog_(v);
    else out[k] = v;
  });
  return out;
}

function logInfo_(event, detail) {
  console.info(JSON.stringify({ level: 'INFO', event: event, detail: scrubForLog_(detail || {}) }));
}

function logWarn_(event, detail) {
  console.warn(JSON.stringify({ level: 'WARN', event: event, detail: scrubForLog_(detail || {}) }));
}

function logError_(event, err, detail) {
  var msg = err && err.message ? err.message : String(err);
  // エラーメッセージ中にトークンが混入しないよう Bearer 以降を除去
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [REDACTED]');
  // UrlFetchApp の例外メッセージには URL（lineUserId 等）が含まれるためマスク
  msg = msg.replace(/[UCR][0-9a-f]{32}/g, function (id) { return maskId_(id); });
  msg = msg.replace(/([?&](?:lineUserId|id_token|token)=)[^&\s]+/gi, '$1[REDACTED]');
  console.error(JSON.stringify({ level: 'ERROR', event: event, message: msg, detail: scrubForLog_(detail || {}) }));
}

/**
 * 送信ログへ記録。
 * @param {{sendId?:string,userId?:string,type:string,reservationId?:string,result:string,error?:string,
 *          idempotencyKey?:string,eventId?:string,retryCount?:number}} e
 * @return {string} 送信ID
 */
function writeSendLog_(e) {
  var sendId = e.sendId || ('SND-' + Utilities.getUuid().substring(0, 8).toUpperCase());
  try {
    appendRow_(SHEETS.SEND_LOG, {
      '送信ID': sendId,
      'LINEユーザーID': e.userId || '',
      '通知種別': e.type || '',
      '予約ID': e.reservationId || '',
      '送信日時': nowString_(),
      '結果': e.result || '',
      'エラー内容': (e.error || '').substring(0, 500),
      '冪等キー': e.idempotencyKey || '',
      'イベントID': e.eventId || '',
      '再試行回数': e.retryCount || 0
    });
  } catch (err) {
    logError_('sendlog.write', err, { type: e.type });
  }
  return sendId;
}
