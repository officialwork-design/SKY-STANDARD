/**
 * 03_User.gs
 * 顧客登録・ユーザー情報更新（シート「顧客管理」）。
 *
 * - 既存行は「氏名・電話番号・メール・顧客区分・同意状況・備考」など
 *   運営が手入力した列を上書きしない。更新するのは表示名・言語・友だち状態・最終更新のみ。
 */

/** 友だち追加時の顧客登録／再追加時の状態更新 */
function registerCustomer_(userId) {
  var profile = getProfile_(userId) || {};
  return withLock_(function () {
    var existing = findRow_(SHEETS.CUSTOMERS, 'LINEユーザーID', userId);
    if (existing) {
      var patch = { '友だち状態': '友だち', '最終更新': nowString_() };
      if (profile.displayName) patch['表示名'] = profile.displayName;
      if (profile.language && !existing['言語']) patch['言語'] = profile.language;
      updateRow_(SHEETS.CUSTOMERS, existing.__row, patch);
      return { created: false };
    }
    appendRow_(SHEETS.CUSTOMERS, {
      'LINEユーザーID': userId,
      '表示名': profile.displayName || '',
      '言語': profile.language || '',
      '登録日時': nowString_(),
      '顧客区分': '新規',
      '友だち状態': '友だち',
      '最終更新': nowString_()
    });
    logInfo_('customer.registered', { userId: userId });
    return { created: true };
  });
}

/** ブロック（友だち解除）時 */
function markCustomerUnfollowed_(userId) {
  return withLock_(function () {
    var existing = findRow_(SHEETS.CUSTOMERS, 'LINEユーザーID', userId);
    if (existing) updateRow_(SHEETS.CUSTOMERS, existing.__row, { '友だち状態': 'ブロック', '最終更新': nowString_() });
  });
}

/**
 * 友だち関係の確認（プロフィール API）。
 * @return {'friend'|'not_friend'|'unknown'} 404 は「友だちでない（ブロック・未追加）」
 */
function checkFriendship_(userId) {
  try {
    lineFetch_('get', '/v2/bot/profile/' + encodeURIComponent(userId));
    return 'friend';
  } catch (e) {
    if (e instanceof LineApiError && e.status === 404) return 'not_friend';
    logWarn_('line.friendship_unknown', { userId: userId, status: e.status });
    return 'unknown';
  }
}

/** プッシュ送信可能か（ブロック中は送らない。未登録は送信可として扱う） */
function isPushAllowed_(userId) {
  if (!userId) return false;
  var row = findRow_(SHEETS.CUSTOMERS, 'LINEユーザーID', userId);
  return !(row && row['友だち状態'] === 'ブロック');
}

/** 顧客の言語（将来の多言語対応用。未設定は ja） */
function getCustomerLanguage_(userId) {
  var row = findRow_(SHEETS.CUSTOMERS, 'LINEユーザーID', userId);
  var lang = row && row['言語'] ? String(row['言語']) : 'ja';
  return lang.split('-')[0];
}

/* ---------- 会話の状態（入力待ち） ---------- */

/**
 * 利用者ごとの会話の状態。同時に持てる入力待ちは1つだけ。
 *   operator    : 有人対応中（自動返信有効=FALSE。12_Operator.gs。シートが正本）
 *   reservation : 予約確認の入力待ち（予約ID／本人確認）。キャッシュ rsv:<userId>（10分）
 *   inquiry     : 問い合わせ内容の入力待ち。キャッシュ inq:<userId>（30分）
 *   none        : 通常（キーワード・FAQ の自動返信）
 * 新しい入力待ちを始めると、もう一方の入力待ちは取り消す（中断）。
 * 入力待ちの途中でメニュー操作（リッチメニュー・定型語）をした場合も入力待ちを取り消す（01_Webhook.gs）。
 * 状態はイベントの応答が LINE に受理されてから変更する（偽装イベントで他人の状態を変えない）。
 */
function getConversationMode_(userId) {
  if (!userId) return 'none';
  if (getOperatorState_(userId)) return 'operator';
  if (getReservationState_(userId)) return 'reservation';
  if (getInquiryState_(userId)) return 'inquiry';
  return 'none';
}

function getReservationState_(userId) {
  if (!userId) return null;
  var v = CacheService.getScriptCache().get('rsv:' + userId);
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function setReservationState_(userId, state) {
  CacheService.getScriptCache().remove('inq:' + userId);
  CacheService.getScriptCache().put('rsv:' + userId, JSON.stringify(state), APP.RESERVATION_STATE_TTL_SEC);
}

function clearReservationState_(userId) {
  if (userId) CacheService.getScriptCache().remove('rsv:' + userId);
}

/** 入力待ち（予約確認・問い合わせ）と「担当者に送る」用の一時保存をすべて取り消す */
function clearConversationStates_(userId) {
  if (!userId) return;
  var cache = CacheService.getScriptCache();
  cache.remove('rsv:' + userId);
  cache.remove('inq:' + userId);
  cache.remove('last:' + userId);
}
