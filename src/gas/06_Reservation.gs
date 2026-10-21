/**
 * 06_Reservation.gs
 * 予約サイト API との連携、予約ステータス取得、予約確認（LIFF）API。
 *
 * ■ 正本
 *   予約・決済・空き枠の正本は予約サイト。スプレッドシート「予約管理」は
 *   予約イベントで同期された管理用の写しである。
 *
 * ■ 予約データの取得元
 *   - RESERVATION_API_BASE_URL が設定されている → 予約サイト API（正本）から取得
 *   - 未設定 → 「予約管理」シート（予約イベントで同期された実データ）から取得
 *   ダミーデータは一切返さない。
 *
 * ■ 本人認証
 *   LIFF から受け取った ID トークンを LINE の verify エンドポイントでサーバー側検証し、
 *   検証済みの sub（LINE ユーザーID）に紐づく予約だけを返す。
 *   クライアントから送られた userId は一切信用しない。
 *
 * ■ 予約サイト側に実装が必要な API（提案インターフェース。docs/architecture.md 参照）
 *   GET  {BASE}/line/reservations?lineUserId={sub}       → { reservations: [Reservation] }
 *   POST {BASE}/line/link  { lineUserId, reservationId, contact } → { linked: true, reservation: Reservation }
 *   認証: Authorization: Bearer {RESERVATION_API_KEY}
 */

var STATUS_LABELS = {
  requested: '予約リクエスト受付', received: '予約リクエスト受付', pending: '予約リクエスト受付',
  confirmed: '予約確定', changed: '予約変更済み', cancelled: 'キャンセル', canceled: 'キャンセル', completed: '搭乗済み'
};
var PAYMENT_LABELS = {
  unpaid: '未決済', pending: '決済待ち', paid: '決済完了', refunded: '返金済み', failed: '決済失敗'
};

/** LIFF API 入口 */
function handleLiffApi_(req) {
  var sub;
  try {
    sub = verifyIdToken_(req.idToken);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    logWarn_('liff.auth_failed', { reason: e.message });
    return { ok: false, error: 'auth_failed' };
  }

  switch (req.action) {
    case 'list':
      return { ok: true, source: reservationSource_(), reservations: listReservationsForUser_(sub).map(toPublicReservation_) };
    case 'link':
      return linkReservation_(sub, req.reservationId, req.contact);
    default:
      return { ok: false, error: 'unknown_action' };
  }
}

/**
 * ID トークンをサーバー側で検証し sub を返す。
 * https://developers.line.biz/ja/reference/line-login/#verify-id-token
 */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string') throw new Error('id_token_missing');
  var clientId = requireProp_(PROP_KEYS.LOGIN_CHANNEL_ID);
  var res = UrlFetchApp.fetch(APP.LINE_VERIFY_ID_TOKEN_URL, {
    method: 'post',
    payload: { id_token: idToken, client_id: clientId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('verify_rejected_' + res.getResponseCode());
  var claims = JSON.parse(res.getContentText());
  // verify エンドポイントは署名・aud・exp を検証済みだが、念のため再確認
  if (String(claims.aud) !== String(clientId)) throw new Error('aud_mismatch');
  if (claims.iss !== 'https://access.line.me') throw new Error('iss_mismatch');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('expired');
  if (!claims.sub) throw new Error('sub_missing');
  return claims.sub;
}

function reservationSource_() {
  return getProp_(PROP_KEYS.RESERVATION_API_BASE_URL) ? 'api' : 'sheet';
}

/** 予約サイト API 呼び出し */
function reservationApiFetch_(method, path, payload) {
  var base = requireProp_(PROP_KEYS.RESERVATION_API_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new ConfigError('RESERVATION_API_BASE_URL は https で指定してください', [PROP_KEYS.RESERVATION_API_BASE_URL]);
  var key = requireProp_(PROP_KEYS.RESERVATION_API_KEY);
  var params = { method: method, headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true };
  if (payload) { params.contentType = 'application/json'; params.payload = JSON.stringify(payload); }
  var res = UrlFetchApp.fetch(base + path, params);
  var code = res.getResponseCode();
  var body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { body = {}; }
  if (code >= 500 || code === 429) throw new Error('reservation_api_unavailable_' + code);
  return { status: code, body: body };
}

/** 本人の予約一覧（正規化済み） */
function listReservationsForUser_(lineUserId) {
  if (reservationSource_() === 'api') {
    var r = reservationApiFetch_('get', '/line/reservations?lineUserId=' + encodeURIComponent(lineUserId));
    if (r.status !== 200) throw new Error('reservation_api_error_' + r.status);
    return (r.body.reservations || []).map(normalizeReservation_)
      // API 側の不具合で他人の予約が混入しても表示しない（多重防御）
      .filter(function (x) { return x.lineUserId === lineUserId; });
  }
  return readRows_(SHEETS.RESERVATIONS)
    .filter(function (row) { return String(row['LINEユーザーID']) === String(lineUserId); })
    .map(reservationFromRow_);
}

/** 予約と LINE ユーザーの紐付け（予約サイト API が必要） */
function linkReservation_(sub, reservationId, contact) {
  if (!reservationId || !contact) return { ok: false, error: 'invalid_input' };
  if (!allowLinkAttempt_(sub)) return { ok: false, error: 'too_many_attempts' };
  if (reservationSource_() !== 'api') {
    // シートには本人確認に使える情報（電話・メール）が予約単位で存在しないため紐付け不可
    return { ok: false, error: 'link_unavailable' };
  }
  var r = reservationApiFetch_('post', '/line/link', {
    lineUserId: sub,
    reservationId: String(reservationId).trim().substring(0, 64),
    contact: String(contact).trim().substring(0, 254)
  });
  if (r.status !== 200 || !r.body.linked) {
    logInfo_('liff.link_rejected', { status: r.status });
    return { ok: false, error: 'not_matched' };
  }
  var resv = normalizeReservation_(r.body.reservation || {});
  if (resv.reservationId) {
    resv.lineUserId = sub;
    syncReservationToSheet_(resv);
  }
  return { ok: true, reservation: toPublicReservation_(resv) };
}

/** 紐付け試行回数制限（1時間あたり） */
function allowLinkAttempt_(sub) {
  var cache = CacheService.getScriptCache();
  var key = 'link:' + sub;
  return withLock_(function () {
    var n = parseInt(cache.get(key) || '0', 10);
    if (n >= APP.LINK_ATTEMPT_LIMIT_PER_HOUR) return false;
    cache.put(key, String(n + 1), 3600);
    return true;
  }, 10000);
}

/**
 * 予約サイト／予約イベントの予約オブジェクトを内部形式に正規化。
 * 期待するフィールド（予約サイト側で合わせる）:
 *   reservationId, lineUserId, planId, planName, flightDate(YYYY-MM-DD), timeSlot, passengers,
 *   amount, status, paymentStatus, meetingPoint, notes, manageUrl
 */
function normalizeReservation_(o) {
  o = o || {};
  return {
    reservationId: String(o.reservationId || o.id || ''),
    lineUserId: String(o.lineUserId || ''),
    planId: String(o.planId || ''),
    planName: String(o.planName || ''),
    flightDate: String(o.flightDate || ''),
    timeSlot: String(o.timeSlot || ''),
    passengers: o.passengers == null ? '' : o.passengers,
    amount: o.amount == null ? '' : o.amount,
    status: String(o.status || ''),
    paymentStatus: String(o.paymentStatus || ''),
    meetingPoint: String(o.meetingPoint || ''),
    notes: String(o.notes || ''),
    manageUrl: String(o.manageUrl || '')
  };
}

/** 「予約管理」シート行 → 内部形式 */
function reservationFromRow_(row) {
  return {
    reservationId: String(row['予約ID'] || ''),
    lineUserId: String(row['LINEユーザーID'] || ''),
    planId: String(row['プランID'] || ''),
    planName: String(row['プラン名'] || ''),
    flightDate: cellToString_(row['搭乗日'], 'yyyy-MM-dd'),
    timeSlot: cellToString_(row['時間帯'], 'HH:mm'),
    passengers: row['人数'],
    amount: row['金額'],
    status: String(row['予約状態'] || ''),
    paymentStatus: String(row['決済状態'] || ''),
    meetingPoint: String(row['集合場所'] || ''),
    notes: String(row['注意事項'] || ''),
    manageUrl: String(row['予約サイト管理URL'] || '')
  };
}

/** 予約を「予約管理」シートへ同期（予約IDで upsert。空値では既存値を上書きしない） */
function syncReservationToSheet_(r) {
  var obj = {
    '予約ID': r.reservationId,
    'LINEユーザーID': r.lineUserId,
    'プランID': r.planId,
    'プラン名': r.planName,
    '搭乗日': r.flightDate,
    '時間帯': r.timeSlot,
    '人数': r.passengers,
    '金額': r.amount,
    '予約状態': STATUS_LABELS[r.status] || r.status,
    '決済状態': PAYMENT_LABELS[r.paymentStatus] || r.paymentStatus,
    '予約サイト管理URL': r.manageUrl,
    '集合場所': r.meetingPoint,
    '注意事項': r.notes,
    '最終イベント日時': r.lastEventAt || ''
  };
  Object.keys(obj).forEach(function (k) { if (obj[k] === '' || obj[k] == null) delete obj[k]; });
  obj['予約ID'] = r.reservationId;
  obj['最終更新'] = nowString_();
  return withLock_(function () { return upsertRow_(SHEETS.RESERVATIONS, '予約ID', obj); });
}

/**
 * 利用者に返してよい項目だけを抽出（ホワイトリスト）。
 * LINE ユーザーID・予約サイト管理URL（運営用）は返さない。
 */
function toPublicReservation_(r) {
  return {
    reservationId: r.reservationId,
    planName: r.planName,
    flightDate: r.flightDate,
    timeSlot: r.timeSlot,
    passengers: r.passengers,
    amount: r.amount,
    status: STATUS_LABELS[r.status] || r.status,
    paymentStatus: PAYMENT_LABELS[r.paymentStatus] || r.paymentStatus,
    meetingPoint: r.meetingPoint,
    notes: r.notes
  };
}
