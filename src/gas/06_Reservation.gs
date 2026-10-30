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
  confirmed: '予約確定', changed: '予約変更済み', cancelled: 'キャンセル', canceled: 'キャンセル', completed: '搭乗済み',
  // 予約サイト（Prisma BookingStatus）の値。表示は API の statusLabel を優先する
  authorizing: 'お支払い手続き中', authorized: '運航確認中', operation_confirming: '運航確認中',
  capture_pending: '決済確定待ち', hold: '仮押さえ中', payment_pending: '決済待ち', operation_declined: '運航見合わせ',
  authorization_expired: 'お支払い期限切れ', payment_review: '決済確認中', refunded: '返金済み', expired: '期限切れ'
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
  var clientId = requireSetting_(ID_KEYS.LINE_LOGIN_CHANNEL_ID);
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
  return getSetting_(ID_KEYS.RESERVATION_API_BASE_URL) ? 'api' : 'sheet';
}

/** 予約サイト API 呼び出し */
function reservationApiFetch_(method, path, payload) {
  var base = requireSetting_(ID_KEYS.RESERVATION_API_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new ConfigError('RESERVATION_API_BASE_URL は https で指定してください', [PROP_KEYS.RESERVATION_API_BASE_URL]);
  // API キーの送信先を固定：ID管理シート（編集者が変更可能）の URL だけを信用せず、
  // スクリプトプロパティ RESERVATION_API_ALLOWED_HOST と一致するホストにのみキーを送る
  var allowedHost = requireProp_(PROP_KEYS.RESERVATION_API_ALLOWED_HOST).toLowerCase();
  var host = (base.match(/^https:\/\/([^\/:?#]+)/i) || [])[1] || '';
  if (host.toLowerCase() !== allowedHost) {
    throw new ConfigError('RESERVATION_API_BASE_URL（ID管理シート）のホスト「' + host + '」が、スクリプトプロパティ ' +
      'RESERVATION_API_ALLOWED_HOST と一致しないため、API キーを送信しません。', [PROP_KEYS.RESERVATION_API_ALLOWED_HOST]);
  }
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
    manageUrl: String(o.manageUrl || ''),
    // LINE トークの予約確認用（予約サイト API が返す場合のみ。docs/reservation-api.md）
    courseName: String(o.courseName || ''),
    statusLabel: String(o.statusLabel || ''),
    changeable: typeof o.changeable === 'boolean' ? o.changeable : null,
    changeBlockedReason: String(o.changeBlockedReason || ''),
    cancellable: typeof o.cancellable === 'boolean' ? o.cancellable : null,
    cancelBlockedReason: String(o.cancelBlockedReason || ''),
    cancellationPolicy: String(o.cancellationPolicy || ''),
    cancellationFee: o.cancellationFee == null ? '' : String(o.cancellationFee),
    changeUrl: String(o.changeUrl || ''),
    cancelUrl: String(o.cancelUrl || '')
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
    status: r.statusLabel || STATUS_LABELS[String(r.status || '').toLowerCase()] || r.status,
    paymentStatus: PAYMENT_LABELS[r.paymentStatus] || r.paymentStatus,
    meetingPoint: r.meetingPoint,
    notes: r.notes,
    courseName: r.courseName || ''
  };
}

/* ======================================================================
 * LINE トークでの予約確認（リッチメニュー「予約確認」 postback a=rsv_start）
 *
 *   1.「予約IDを入力してください」と返信し、予約ID の入力待ちにする（10分）
 *   2. 予約IDの形式を検証（予約サイトの形式 SKY-YYYYMMDD-XXXXXX）
 *   3. その LINE アカウントに紐づく予約か確認（予約サイト API、未設定なら「予約管理」シート）
 *        紐づいている → 予約内容を返信（予約変更／キャンセル／オペレーターに相談 のボタン付き）
 *        紐づいていない → 追加の本人確認（ご予約時の電話番号またはメールアドレス）を求める
 *          → 予約サイト API の /line/link で照合 → 一致すれば紐づけて予約内容を返信
 *   予約IDだけでは予約内容を表示しない。照合できない場合も「予約が存在するか」は答えない。
 *
 * 予約の変更・キャンセルは GAS では行わない。予約サイトが返す可否・理由・キャンセル規定を表示し、
 * 予約サイトの手続き画面（URL がある場合）または担当者（オペレーター）へ案内する。
 *
 * 安全性（GAS単体受信＝署名未検証）:
 *   予約内容は replyMessage_ だけで送る（プッシュでは送らない）。偽装イベントの応答トークンは LINE が拒否するため、
 *   偽装イベントで他人の予約内容を受け取ることはできない。入力待ちの状態は応答が受理された場合のみ変更する。
 *   本人確認の照合回数は LINE ユーザーごとに1時間 APP.LINK_ATTEMPT_LIMIT_PER_HOUR 回まで（予約サイト側でも予約IDごとに制限すること）。
 *   電話番号・メールアドレス・予約内容はログに残さない。
 * ====================================================================== */

/** 予約IDの形式（予約サイトの採番 SKY-YYYYMMDD-XXXXXX。テスト予約は TEST-） */
var RESERVATION_ID_PATTERN = /^(SKY|TEST)-\d{8}-[0-9A-F]{6}$/;

var RSV_TEXT = {
  ASK_ID: '🔖 ご予約の確認ですね。\n予約IDを入力してくださいませ。\n（例：SKY-20261101-A1B2C3）',
  BAD_FORMAT: '🔖 予約IDの形式が正しくないようでございます。\n「SKY-」から始まる予約IDを、もう一度ご入力くださいませ。',
  TOO_MANY: '🔖 予約IDを確認できませんでした。\nお手数ですが、予約確認メールに記載の予約IDをご確認のうえ、改めてお試しくださいませ。',
  ASK_CONTACT: '🔖 ご本人様確認のため、ご予約時にご登録の電話番号またはメールアドレスをお送りくださいませ。\n' +
    '確認できた場合のみ、ご予約内容をお知らせいたします。',
  NOT_VERIFIED: '🔖 ご本人様を確認できませんでした。\nお手数ですが、予約IDとご登録内容をご確認のうえ、改めてお試しくださいませ。',
  TOO_MANY_ATTEMPTS: '🔖 確認の回数が上限に達しました。\nしばらく時間をおいてからお試しいただくか、下記よりオペレーターにご相談くださいませ。',
  NO_VERIFY: '🔖 このLINEアカウントでは、該当するご予約を確認できませんでした。\n' +
    '現在LINEでのご本人様確認は準備中のため、ご予約のご確認は下記よりオペレーターが承ります。',
  API_ERROR: '🔖 ただいまご予約情報を確認できません。\nお手数ですが、時間をおいて改めてお試しいただくか、下記よりオペレーターにご相談くださいませ。',
  CANCELLED_INPUT: '✅ ご予約の確認を終了いたしました。\nまたいつでもお気軽にご利用くださいませ。',
  NOT_FOUND_ACTION: '🔖 ご予約を確認できませんでした。\nお手数ですが、メニューの「予約確認」から改めてお試しくださいませ。',
  CHANGE_BY_STAFF: '📅 ご予約の変更は、担当者が変更条件と差額を確認のうえ承ります。\n下記よりオペレーターにご相談くださいませ。',
  CHANGE_BLOCKED: '📅 こちらのご予約は、現在LINEから変更のお手続きをお受けできません。',
  CANCEL_BLOCKED: '📋 こちらのご予約は、現在LINEからキャンセルのお手続きをお受けできません。',
  CANCEL_BY_STAFF: '💬 キャンセルのお手続きは、担当者が規定を確認のうえ承ります。下記よりオペレーターにご相談くださいませ。\n' +
    '※この時点では、ご予約はキャンセルされておりません。'
};

/** 予約IDの正規化（全角→半角、空白除去、大文字）。形式に合わなければ '' */
function normalizeReservationId_(s) {
  var t = String(s || '');
  if (t.normalize) t = t.normalize('NFKC');
  t = t.replace(/[\s　]/g, '').replace(/[‐－―−ー]/g, '-').toUpperCase();
  return RESERVATION_ID_PATTERN.test(t) ? t : '';
}

/** 予約確認を始める（リッチメニュー「予約確認」・「予約確認」と送信・旧メニュー） */
function startReservationCheck_(ev, userId) {
  if (!isOneToOne_(ev)) return replyMessage_(ev.replyToken, MSG_ONE_TO_ONE_ONLY);
  var res = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.ASK_ID, [postbackAction_('入力をやめる', 'a=rsv_cancel', '入力をやめる')]));
  if (userId && (__replySent || isVerifiedEvent_())) setReservationState_(userId, { step: 'id', n: 0 });
  return res;
}

/** 予約確認の入力をやめる */
function cancelReservationCheck_(ev, userId) {
  var res = replyMessage_(ev.replyToken, RSV_TEXT.CANCELLED_INPUT);
  if (__replySent || isVerifiedEvent_()) clearReservationState_(userId);
  return res;
}

function operatorQuickReply_(rid) {
  return [postbackAction_(OPERATOR_MENU_LABEL, 'a=inq_operator' + (rid ? '&rid=' + encodeURIComponent(rid) : ''), OPERATOR_MENU_LABEL)];
}

/** 予約確認の入力（予約ID／本人確認）を受け取ったとき */
function handleReservationInput_(ev, userId, text) {
  var st = getReservationState_(userId) || { step: 'id', n: 0 };
  var commit = function (fn) { if (__replySent || isVerifiedEvent_()) fn(); };

  if (st.step === 'contact' && st.rid) {
    var contact = normalizeContact_(text);
    if (!contact) {
      return replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.ASK_CONTACT, [postbackAction_('入力をやめる', 'a=rsv_cancel', '入力をやめる')]));
    }
    var linked;
    try {
      linked = linkReservation_(userId, st.rid, contact);
    } catch (e) {
      logError_('reservation_check.link_failed', e, {});
      var r0 = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.API_ERROR, operatorQuickReply_(st.rid)));
      commit(function () { clearReservationState_(userId); });
      return r0;
    }
    var msg;
    if (linked.ok && linked.reservation) {
      logInfo_('reservation_check.verified', { userId: userId });
      msg = buildReservationCard_(normalizeReservation_(linked.reservation), st.rid);
    } else if (linked.error === 'too_many_attempts') {
      msg = withQuickReply_(RSV_TEXT.TOO_MANY_ATTEMPTS, operatorQuickReply_(''));
    } else {
      logInfo_('reservation_check.not_verified', { userId: userId, reason: linked.error });
      msg = withQuickReply_(RSV_TEXT.NOT_VERIFIED, [postbackAction_('予約確認をやり直す', 'a=rsv_start', '予約確認'), operatorQuickReply_('')[0]]);
    }
    var r1 = replyMessage_(ev.replyToken, msg);
    commit(function () { clearReservationState_(userId); }); // 照合は1回ごとに予約IDの入力からやり直す
    return r1;
  }

  // step 'id'
  var rid = normalizeReservationId_(text);
  if (!rid) {
    var n = (Number(st.n) || 0) + 1;
    if (n >= APP.RESERVATION_ID_MAX_TRIES) {
      var r2 = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.TOO_MANY, operatorQuickReply_('')));
      commit(function () { clearReservationState_(userId); });
      return r2;
    }
    var r3 = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.BAD_FORMAT, [postbackAction_('入力をやめる', 'a=rsv_cancel', '入力をやめる')]));
    commit(function () { setReservationState_(userId, { step: 'id', n: n }); });
    return r3;
  }
  var own;
  try {
    own = findOwnReservation_(userId, rid);
  } catch (e) {
    if (e instanceof ConfigError) logError_('config.missing', e, { missing: e.missingKeys });
    else logError_('reservation_check.lookup_failed', e, {});
    var r4 = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.API_ERROR, operatorQuickReply_(rid)));
    commit(function () { clearReservationState_(userId); });
    return r4;
  }
  if (own) {
    logInfo_('reservation_check.shown', { userId: userId });
    var r5 = replyMessage_(ev.replyToken, buildReservationCard_(own, rid));
    commit(function () { clearReservationState_(userId); });
    return r5;
  }
  // このアカウントに紐づく予約ではない（または存在しない）。存在の有無は答えずに追加の本人確認へ
  if (reservationSource_() !== 'api') {
    var r6 = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.NO_VERIFY, operatorQuickReply_(rid)));
    commit(function () { clearReservationState_(userId); });
    return r6;
  }
  var r7 = replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.ASK_CONTACT, [postbackAction_('入力をやめる', 'a=rsv_cancel', '入力をやめる')]));
  commit(function () { setReservationState_(userId, { step: 'contact', rid: rid }); });
  return r7;
}

/** 電話番号またはメールアドレス（形式が明らかに違う場合は ''） */
function normalizeContact_(text) {
  var t = String(text || '');
  if (t.normalize) t = t.normalize('NFKC');
  t = t.trim();
  if (/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(t)) return t.toLowerCase().substring(0, 254);
  var digits = t.replace(/[\s()\-‐－―−]/g, '');
  if (/^\+81/.test(digits)) digits = '0' + digits.substring(3); // 国番号表記（+81 90…）は国内表記（090…）にそろえる
  digits = digits.replace(/^\+/, '');
  if (/^\d{10,15}$/.test(digits)) return digits;
  return '';
}

/** その LINE ユーザーに紐づく予約から予約IDで探す（なければ null。他人の予約は返さない） */
function findOwnReservation_(userId, rid) {
  var list = listReservationsForUser_(userId);
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].reservationId).toUpperCase() === rid && (!list[i].lineUserId || list[i].lineUserId === userId)) return list[i];
  }
  return null;
}

/** 予約状況の表示名 */
function reservationStatusLabel_(r) {
  if (r.statusLabel) return r.statusLabel;
  var k = String(r.status || '').toLowerCase();
  return STATUS_LABELS[k] || r.status || '';
}

/** 予約内容の返信（表示は最小限：予約ID・プラン・コース・搭乗予定日・時間帯・人数・予約状況） */
function buildReservationCard_(r, rid) {
  var id = r.reservationId || rid;
  var lines = ['🔖 ご予約内容', '予約ID：' + id];
  if (r.planName) lines.push('プラン：' + r.planName);
  if (r.courseName) lines.push('コース：' + r.courseName);
  if (r.flightDate) lines.push('📅 搭乗予定日：' + r.flightDate);
  if (r.timeSlot) lines.push('時間帯：' + r.timeSlot);
  if (r.passengers !== '' && r.passengers != null) lines.push('人数：' + r.passengers + '名');
  var label = reservationStatusLabel_(r);
  if (label) lines.push('予約状況：' + label);
  var enc = encodeURIComponent(id);
  return withQuickReply_(lines.join('\n') + '\n\nご希望のお手続きを下記よりお選びくださいませ。', [
    postbackAction_('予約変更', 'a=rsv_change&rid=' + enc, '予約変更'),
    postbackAction_('キャンセル', 'a=rsv_cancel_req&rid=' + enc, 'キャンセル'),
    operatorQuickReply_(id)[0]
  ]);
}

/** 予約サイトの手続き画面の URL として使ってよいか（https かつ予約サイトのホスト） */
function isTrustedSiteUrl_(url) {
  var m = String(url || '').match(/^https:\/\/([^\/:?#\s]+)[^\s]*$/i);
  if (!m) return false;
  var host = m[1].toLowerCase();
  var hosts = [];
  var siteUrl = getUrlSetting_(SETTING_KEYS.BOOKING_URL);
  var sm = siteUrl.match(/^https:\/\/([^\/:?#]+)/i);
  if (sm) hosts.push(sm[1].toLowerCase());
  var api = getProp_(PROP_KEYS.RESERVATION_API_ALLOWED_HOST);
  if (api) hosts.push(api.toLowerCase());
  return hosts.indexOf(host) !== -1;
}

/** 状態から変更・キャンセルの可否を判断（予約サイトが可否を返さない場合の安全側の判定） */
function reservationClosed_(r) {
  var k = String(r.status || '').trim().toLowerCase();
  // 予約サイトの値と、「予約管理」シートの表示名（STATUS_LABELS）の両方で判定
  return ['cancelled', 'canceled', 'refunded', 'expired', 'completed', 'operation_declined', 'authorization_expired',
    'キャンセル', '返金済み', '期限切れ', '搭乗済み', '運航見合わせ', 'お支払い期限切れ'].indexOf(k) !== -1;
}

/**
 * 予約変更・キャンセルのボタン（postback a=rsv_change / a=rsv_cancel_req、rid=予約ID）。
 * postback の予約IDは信用せず、その LINE アカウントに紐づく予約かを再確認する。GAS では変更・取消を行わない。
 */
function handleReservationAction_(ev, userId, kind, ridRaw) {
  var rid = normalizeReservationId_(ridRaw);
  var r = null;
  try {
    r = rid && userId ? findOwnReservation_(userId, rid) : null;
  } catch (e) {
    logError_('reservation_check.action_lookup_failed', e, { kind: kind });
    return replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.API_ERROR, operatorQuickReply_(rid)));
  }
  if (!r) return replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.NOT_FOUND_ACTION, operatorQuickReply_('')));
  var op = operatorQuickReply_(rid);
  logInfo_('reservation_check.action', { kind: kind, userId: userId });

  if (kind === 'change') {
    var changeable = typeof r.changeable === 'boolean' ? r.changeable : !reservationClosed_(r);
    if (!changeable) {
      return replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.CHANGE_BLOCKED + (r.changeBlockedReason ? '\n理由：' + r.changeBlockedReason : '') +
        '\nご不明な点は、下記よりオペレーターにご相談くださいませ。', op));
    }
    if (isTrustedSiteUrl_(r.changeUrl)) {
      var m1 = buildLinkMessage_('📅 ご予約の変更は、下記の予約サイトにて承ります。\n日時・人数などの変更内容と差額をご確認のうえ、お手続きくださいませ。', '予約変更', r.changeUrl);
      withQuickReply_(m1[m1.length - 1], op);
      return replyMessage_(ev.replyToken, m1);
    }
    return replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.CHANGE_BY_STAFF, op));
  }

  // cancel
  var cancellable = typeof r.cancellable === 'boolean' ? r.cancellable : !reservationClosed_(r);
  if (!cancellable) {
    return replyMessage_(ev.replyToken, withQuickReply_(RSV_TEXT.CANCEL_BLOCKED + (r.cancelBlockedReason ? '\n理由：' + r.cancelBlockedReason : '') +
      '\nご不明な点は、下記よりオペレーターにご相談くださいませ。', op));
  }
  var policy = ['📋 キャンセルについてのご案内'];
  if (r.cancellationPolicy) policy.push(r.cancellationPolicy);
  if (r.cancellationFee) policy.push('キャンセル料（目安）：' + r.cancellationFee);
  if (!r.cancellationPolicy && !r.cancellationFee) policy.push('キャンセル規定・料金は、ご予約のプランにより異なります。');
  if (isTrustedSiteUrl_(r.cancelUrl)) {
    var m2 = buildLinkMessage_(policy.join('\n') + '\n\n下記の予約サイトで内容をご確認のうえ、最終確認を経てお手続きくださいませ。この時点では、ご予約はキャンセルされておりません。',
      'キャンセル手続き', r.cancelUrl);
    withQuickReply_(m2[m2.length - 1], op);
    return replyMessage_(ev.replyToken, m2);
  }
  return replyMessage_(ev.replyToken, withQuickReply_(policy.join('\n') + '\n\n' + RSV_TEXT.CANCEL_BY_STAFF, op));
}
