/**
 * 07_Notification.gs
 * 予約通知・搭乗前リマインド・運航変更（承認制）・再試行。
 *
 * ■ 予約サイトからのイベント（doPost）
 *   { kind:'reservation_event', ts:<epoch ms>, payload:'<JSON文字列>', sig:'<hex HMAC-SHA256>' }
 *   sig = HMAC_SHA256(RESERVATION_WEBHOOK_SECRET, ts + "." + payload) の16進
 *   payload = { eventId, eventType, occurredAt, reservation: {...} }
 *
 * ■ 冪等性
 *   冪等キー = 予約ID:イベント種別:イベントID を「送信ログ」に記録し、同じキーは二度処理しない。
 *   さらに LINE の X-Line-Retry-Key（冪等キーから生成した UUID）で API 側でも重複送信を防ぐ。
 *
 * ■ 承認制
 *   FLIGHT_CHANGE（運航変更・欠航案内）は自動送信せず「承認待ち」として送信ログに記録し、
 *   担当者がスプレッドシートのメニューから承認したときに送信する。
 */

var EVENT_TYPES = {
  BOOKING_RECEIVED: { template: 'BOOKING_RECEIVED', status: 'requested', approval: false },
  BOOKING_CONFIRMED: { template: 'BOOKING_CONFIRMED', status: 'confirmed', approval: false },
  // 変更後の状態（確定のまま等）は予約サイトが送る reservation.status をそのまま採用する
  BOOKING_CHANGED: { template: 'BOOKING_CHANGED', status: null, approval: false },
  BOOKING_CANCELLED: { template: 'BOOKING_CANCELLED', status: 'cancelled', approval: false },
  PAYMENT_COMPLETED: { template: 'PAYMENT_COMPLETED', status: null, payment: 'paid', approval: false },
  FLIGHT_CHANGE: { template: 'FLIGHT_CHANGE', status: null, approval: true }
};

/** 不足時に「通知テンプレート」へ追加するテンプレート（文面確認のため 有効=OFF で追加） */
var DEFAULT_TEMPLATES = [
  // 本文は管理台帳（2026-10-28 時点）の承認済み文面と同じ。シートに行がある場合は追加・上書きしない
  { id: 'BOOKING_CHANGED', use: '予約変更', timing: '予約サイトで変更時',
    body: '🗓️【SKY STANDARD｜ご予約内容変更のご案内】\n\nご予約内容の変更を承りました。\n\n🔖 予約ID：{{予約ID}}\n📅 変更後の搭乗日時：{{搭乗日時}}\n\n変更内容の詳細は、予約確認ページにてご確認くださいませ。\n\n引き続き、どうぞよろしくお願いいたします。✨\n\nSKY STANDARD' },
  { id: 'BOOKING_CANCELLED', use: 'キャンセル', timing: '予約サイトでキャンセル時',
    body: '📋【SKY STANDARD｜キャンセル受付のご案内】\n\nご予約のキャンセルを承りました。\n\n🔖 予約ID：{{予約ID}}\n\nキャンセル条件や返金に関するご案内は、予約確認ページにてご確認くださいませ。\n\nまたの機会に、空の旅をご案内できますことを心よりお待ちしております。🚁\n\nSKY STANDARD' },
  { id: 'PAYMENT_COMPLETED', use: '決済完了', timing: '予約サイトで決済完了時',
    body: '💳【SKY STANDARD｜お支払い完了のご案内】\n\nお支払いのお手続きが完了いたしました。\n\n🔖 予約ID：{{予約ID}}\n\nご予約の確定状況やフライトの詳細は、予約確認ページにてご確認いただけます。\n\nこの度は誠にありがとうございます。✨\n\nSKY STANDARD' },
  // 「オペレーターに相談」選択時の返信（ON の場合のみ使用。{{受付ID}} が使える。なければ末尾に受付IDが付く。OFF なら 12_Operator.gs の既定文）
  { id: 'OPERATOR_START', use: 'オペレーター対応開始', timing: 'お問い合わせで「オペレーターに相談」を選択時',
    body: '💬【SKY STANDARD｜コンシェルジュへのご相談】\n\nお問い合わせいただき、誠にありがとうございます。\n\nただいま担当スタッフへおつなぎしております。\n\n📝 ご相談内容をこのトークにお送りください。確認のうえ、担当者より順次ご返信いたします。\n\n※担当者による対応中は、自動返信を一時停止いたします。\n\nSKY STANDARD' }
];

var SEND_RESULT = {
  PROCESSING: '処理中',
  SUCCESS: '成功',
  PENDING_APPROVAL: '承認待ち',
  RETRY_WAIT: '失敗(再試行待ち)',
  FAILED: '失敗',
  NO_TARGET: '対象なし',
  BLOCKED: '対象外(ブロック)',
  TEMPLATE_OFF: 'テンプレート無効',
  REJECTED: '承認却下',
  OUT_OF_ORDER: '古いイベント(スキップ)'
};

/** 処理中のまま放置された送信を再送対象とみなすまでの時間 */
var STALE_PROCESSING_MS = 15 * 60 * 1000;
/** X-Line-Retry-Key は24時間有効。余裕を見て23時間を自動再送の上限にする */
var RETRY_KEY_SAFE_MS = 23 * 60 * 60 * 1000;

/** イベント日時・シート日時の解釈（Date / ISO / 'yyyy-MM-dd HH:mm:ss'(JST)） */
function parseEventTime_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + '+09:00';
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/* ---------- テンプレート ---------- */

/** 有効なテンプレート本文（言語別 ID_en 等があれば優先）。無効・未登録は '' */
function getTemplate_(id, lang) {
  var rows;
  try { rows = readRows_(SHEETS.TEMPLATES); } catch (e) { logError_('template.read', e); return ''; }
  var ids = lang && lang !== 'ja' ? [id + '_' + lang, id] : [id];
  for (var i = 0; i < ids.length; i++) {
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (String(r['テンプレートID']) === ids[i] && String(r['有効']).toUpperCase() === 'ON' && r['本文']) return String(r['本文']);
    }
  }
  return '';
}

/** {{変数}} 置換。値がない変数は空文字 */
function renderTemplate_(body, vars) {
  return String(body).replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (_, k) {
    return vars && vars[k] != null ? String(vars[k]) : '';
  });
}

function reservationVars_(r) {
  return {
    '予約ID': r.reservationId,
    'プラン名': r.planName,
    '搭乗日': r.flightDate,
    '時間帯': r.timeSlot,
    '搭乗日時': [r.flightDate, r.timeSlot].filter(String).join(' '),
    '人数': r.passengers,
    '集合場所': r.meetingPoint
  };
}

/* ---------- 予約イベント受信 ---------- */

function handleReservationEvent_(req) {
  var secret = requireProp_(PROP_KEYS.RESERVATION_WEBHOOK_SECRET);
  if (!isFreshTimestamp_(req.ts)) return { ok: false, error: 'stale' };
  if (!safeEqual_(hmacHex_(String(req.ts) + '.' + String(req.payload || ''), secret), String(req.sig || '').toLowerCase())) {
    logWarn_('reservation_event.bad_signature', {});
    return { ok: false, error: 'bad_signature' };
  }
  var p = JSON.parse(req.payload || '{}');
  var def = EVENT_TYPES[p.eventType];
  if (!def) return { ok: false, error: 'unknown_event_type' };
  if (!p.eventId) return { ok: false, error: 'event_id_required' };
  var r = normalizeReservation_(p.reservation);
  if (!r.reservationId) return { ok: false, error: 'reservation_id_required' };

  var idemKey = r.reservationId + ':' + p.eventType + ':' + p.eventId;

  // 再送・リプレイ：同期より前に冪等キーを確認し、処理済みならシートも変更しない
  var dup = findRow_(SHEETS.SEND_LOG, '冪等キー', idemKey);
  if (dup) return { ok: true, result: String(dup['結果']), duplicate: true };

  // 順序逆転：既に新しいイベントを反映済みなら、古いイベントで状態を戻さない・通知しない
  var existing = findRow_(SHEETS.RESERVATIONS, '予約ID', r.reservationId);
  var occurred = parseEventTime_(p.occurredAt);
  var lastApplied = existing ? parseEventTime_(existing['最終イベント日時']) : null;
  if (occurred && lastApplied && occurred.getTime() < lastApplied.getTime()) {
    writeSendLog_({ userId: r.lineUserId, type: p.eventType, reservationId: r.reservationId, result: SEND_RESULT.OUT_OF_ORDER,
      idempotencyKey: idemKey, eventId: String(p.eventId) });
    logWarn_('reservation_event.out_of_order', { reservationId: r.reservationId, type: p.eventType });
    return { ok: true, result: SEND_RESULT.OUT_OF_ORDER, duplicate: false };
  }

  // 予約管理シートへ同期（正本は予約サイト）
  if (def.status) r.status = def.status;
  if (def.payment) r.paymentStatus = def.payment;
  if (occurred) r.lastEventAt = occurred.toISOString();
  if (!r.lineUserId && existing && existing['LINEユーザーID']) r.lineUserId = String(existing['LINEユーザーID']);
  syncReservationToSheet_(r);

  var result = queueAndSend_({
    userId: r.lineUserId,
    templateId: def.template,
    type: p.eventType,
    reservationId: r.reservationId,
    eventId: String(p.eventId),
    idempotencyKey: idemKey,
    vars: reservationVars_(r),
    requireApproval: def.approval
  });
  return { ok: true, result: result.result, duplicate: !!result.duplicate };
}

/* ---------- 送信本体 ---------- */

/**
 * 冪等キーで重複を排除して送信（または承認待ちに登録）する。
 * @return {{result:string, sendId?:string, duplicate?:boolean}}
 */
function queueAndSend_(n) {
  var claim = withLock_(function () {
    var dup = findRow_(SHEETS.SEND_LOG, '冪等キー', n.idempotencyKey);
    if (dup) return { duplicate: true, result: String(dup['結果']), sendId: String(dup['送信ID']) };
    var sendId = 'SND-' + Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
    var initial = n.requireApproval ? SEND_RESULT.PENDING_APPROVAL : SEND_RESULT.PROCESSING;
    var row = appendRow_(SHEETS.SEND_LOG, {
      '送信ID': sendId, 'LINEユーザーID': n.userId || '', '通知種別': n.type, '予約ID': n.reservationId || '',
      '送信日時': nowString_(), '結果': initial, 'エラー内容': '', '冪等キー': n.idempotencyKey,
      'イベントID': n.eventId || '', '再試行回数': 0
    });
    return { duplicate: false, sendId: sendId, row: row };
  });
  if (claim.duplicate) {
    logInfo_('notify.duplicate_skipped', { key: n.idempotencyKey });
    return claim;
  }
  savePendingPayload_(claim.sendId, n);
  if (n.requireApproval) {
    notifyAdmin_('【承認待ち】運航案内', '運航変更・欠航案内が承認待ちです。\n送信ID：' + claim.sendId + '\n予約ID：' + (n.reservationId || '') +
      '\n\nスプレッドシート「送信ログ」で該当行を選択し、メニュー「SKY STANDARD → 選択中の通知を承認して送信」を実行してください。');
    return { result: SEND_RESULT.PENDING_APPROVAL, sendId: claim.sendId };
  }
  return deliver_(claim.sendId, claim.row, n, 0);
}

/** 実送信して送信ログを更新 */
function deliver_(sendId, row, n, retryCount) {
  var result, error = '';
  var body = '';
  if (!n.userId) {
    result = SEND_RESULT.NO_TARGET;
  } else if (!isPushAllowed_(n.userId)) {
    result = SEND_RESULT.BLOCKED;
  } else {
    body = getTemplate_(n.templateId, getCustomerLanguage_(n.userId));
    if (!body) result = SEND_RESULT.TEMPLATE_OFF;
  }
  if (!result) {
    var messages = [{ type: 'text', text: renderTemplate_(body, n.vars) }];
    var checkUrl = getBookingCheckUrl_();
    if (checkUrl) messages = messages.concat(buildLinkMessage_('🔖 ご予約の詳細は、下記よりご確認いただけます。', '予約確認', checkUrl));
    try {
      pushMessage_(n.userId, messages, deterministicUuid_(n.idempotencyKey));
      result = SEND_RESULT.SUCCESS;
    } catch (e) {
      error = e.message || String(e);
      var retryable = e.retryable || !(e instanceof LineApiError);
      result = retryable && retryCount < APP.MAX_SEND_RETRY ? SEND_RESULT.RETRY_WAIT : SEND_RESULT.FAILED;
      logError_('notify.push_failed', e, { sendId: sendId, type: n.type });
    }
  }
  updateRow_(SHEETS.SEND_LOG, row, { '結果': result, 'エラー内容': error.substring(0, 500), '送信日時': nowString_(), '再試行回数': retryCount });
  if (result !== SEND_RESULT.RETRY_WAIT) deletePendingPayload_(sendId);
  if (result === SEND_RESULT.FAILED) {
    notifyAdmin_('【通知失敗】' + n.type, '通知の送信に失敗しました。\n送信ID：' + sendId + '\n予約ID：' + (n.reservationId || '') + '\nエラー：' + error.substring(0, 200));
  }
  return { result: result, sendId: sendId };
}

/* 再送・承認のため送信内容を一時保存（スクリプトプロパティ。送信完了で削除） */
function savePendingPayload_(sendId, n) {
  PropertiesService.getScriptProperties().setProperty('PENDING_' + sendId, JSON.stringify({
    userId: n.userId, templateId: n.templateId, type: n.type, reservationId: n.reservationId,
    eventId: n.eventId, idempotencyKey: n.idempotencyKey, vars: n.vars
  }));
}
function loadPendingPayload_(sendId) {
  var v = PropertiesService.getScriptProperties().getProperty('PENDING_' + sendId);
  return v ? JSON.parse(v) : null;
}
function deletePendingPayload_(sendId) {
  PropertiesService.getScriptProperties().deleteProperty('PENDING_' + sendId);
}

/* ---------- 再試行（時間主導トリガー） ---------- */

/**
 * 送信ログの行をロック内で「処理中」に切り替えて確保する（承認・再送の同時実行による二重送信防止）。
 * @return {Object|null} 確保できた行（確保できなければ null）
 */
function claimForDelivery_(sendId, canClaim) {
  return withLock_(function () {
    var row = findRow_(SHEETS.SEND_LOG, '送信ID', sendId);
    if (!row || !canClaim(row)) return null;
    updateRow_(SHEETS.SEND_LOG, row.__row, { '結果': SEND_RESULT.PROCESSING, '送信日時': nowString_() });
    return row;
  });
}

function isRetryTarget_(row) {
  if (row['結果'] === SEND_RESULT.RETRY_WAIT) return true;
  if (row['結果'] !== SEND_RESULT.PROCESSING) return false;
  // 実行中断等で「処理中」のまま残った行（同じ X-Line-Retry-Key で再送するため二重送信にならない）。
  // ただし X-Line-Retry-Key の有効期間（24時間）を過ぎた行は重複の恐れがあるため自動再送しない。
  var t = parseEventTime_(row['送信日時']);
  if (!t) return false;
  var age = Date.now() - t.getTime();
  return age > STALE_PROCESSING_MS && age < RETRY_KEY_SAFE_MS;
}

/** 24時間近く「処理中」のまま残った行を「失敗」にする（重複送信を避けるため手動確認に回す） */
function failExpiredProcessing_() {
  var n = 0;
  readRows_(SHEETS.SEND_LOG).forEach(function (row) {
    if (row['結果'] !== SEND_RESULT.PROCESSING) return;
    var t = parseEventTime_(row['送信日時']);
    if (t && Date.now() - t.getTime() >= RETRY_KEY_SAFE_MS) {
      updateRow_(SHEETS.SEND_LOG, row.__row, { '結果': SEND_RESULT.FAILED,
        'エラー内容': '処理中のまま24時間近く経過したため自動再送を停止（重複送信防止）。利用者への到達を確認してください' });
      n++;
    }
  });
  return n;
}

/** 「失敗(再試行待ち)」と放置された「処理中」の通知を再送する（10分おきトリガー想定） */
function retryFailedSends_() {
  var started = Date.now();
  var summary = { targets: 0, processed: 0, results: {}, expired: failExpiredProcessing_() };
  var targets = readRows_(SHEETS.SEND_LOG).filter(isRetryTarget_);
  summary.targets = targets.length;
  targets.forEach(function (t) {
    if (Date.now() - started > 4 * 60 * 1000) return; // 実行時間制限（6分）対策
    var sendId = String(t['送信ID']);
    var row = claimForDelivery_(sendId, isRetryTarget_);
    if (!row) return;
    var n = loadPendingPayload_(sendId);
    var result;
    if (!n) {
      updateRow_(SHEETS.SEND_LOG, row.__row, { '結果': SEND_RESULT.FAILED, 'エラー内容': '再送データなし' });
      result = SEND_RESULT.FAILED;
    } else {
      result = deliver_(sendId, row.__row, n, (parseInt(row['再試行回数'], 10) || 0) + 1).result;
    }
    summary.processed++;
    summary.results[result] = (summary.results[result] || 0) + 1;
  });
  return summary;
}

/** 再送対象の件数（管理メニューの確認ダイアログ用） */
function countRetryTargets_() {
  return readRows_(SHEETS.SEND_LOG).filter(isRetryTarget_).length;
}

/* ---------- 承認 ---------- */

/** 送信IDを指定して承認・送信 */
function approvePendingNotification_(sendId, approver) {
  var current = findRow_(SHEETS.SEND_LOG, '送信ID', sendId);
  if (!current) throw new Error('送信IDが見つかりません: ' + sendId);
  if (current['結果'] !== SEND_RESULT.PENDING_APPROVAL) throw new Error('承認待ちではありません（現在: ' + current['結果'] + '）');
  if (!loadPendingPayload_(sendId)) throw new Error('送信データが見つかりません: ' + sendId);
  var row = claimForDelivery_(sendId, function (r) { return r['結果'] === SEND_RESULT.PENDING_APPROVAL; });
  if (!row) throw new Error('承認待ちではありません（現在: ' + current['結果'] + '）');
  logInfo_('notify.approved', { sendId: sendId, approver: approver ? 'set' : 'unknown' });
  return deliver_(sendId, row.__row, loadPendingPayload_(sendId), 0);
}

/** 承認却下 */
function rejectPendingNotification_(sendId) {
  withLock_(function () {
    var row = findRow_(SHEETS.SEND_LOG, '送信ID', sendId);
    if (!row || row['結果'] !== SEND_RESULT.PENDING_APPROVAL) throw new Error('承認待ちの送信IDではありません: ' + sendId);
    updateRow_(SHEETS.SEND_LOG, row.__row, { '結果': SEND_RESULT.REJECTED });
    deletePendingPayload_(sendId);
  });
}

/* ---------- 搭乗前日リマインド（時間主導トリガー） ---------- */

/**
 * 翌日搭乗かつ「予約確定」の予約へ FLIGHT_REMINDER を送る（1日1回トリガー想定）。
 * 冪等キー: 予約ID:FLIGHT_REMINDER:搭乗日 → 複数回実行しても1回のみ送信。
 * ※ 運航確定の保証ではない旨はテンプレート側で表現する。
 */
function sendFlightReminders_() {
  var started = Date.now();
  var tomorrow = Utilities.formatDate(new Date(Date.now() + 24 * 3600 * 1000), APP.TIMEZONE, 'yyyy-MM-dd');
  var sent = 0;
  readRows_(SHEETS.RESERVATIONS).map(reservationFromRow_).forEach(function (r) {
    if (Date.now() - started > 4 * 60 * 1000) return;
    if (r.flightDate !== tomorrow) return;
    if (r.status !== STATUS_LABELS.confirmed && r.status !== 'confirmed') return;
    if (!r.lineUserId) return;
    var res = queueAndSend_({
      userId: r.lineUserId, templateId: 'FLIGHT_REMINDER', type: 'FLIGHT_REMINDER', reservationId: r.reservationId,
      eventId: 'reminder-' + tomorrow, idempotencyKey: r.reservationId + ':FLIGHT_REMINDER:' + tomorrow,
      vars: reservationVars_(r), requireApproval: false
    });
    if (res.result === SEND_RESULT.SUCCESS && !res.duplicate) sent++;
  });
  logInfo_('reminder.done', { date: tomorrow, sent: sent });
  return sent;
}
