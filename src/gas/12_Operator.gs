/**
 * 12_Operator.gs
 * 有人オペレーター対応（お問い合わせ →「オペレーターに相談」）。
 *
 * ■ 流れ
 *   1. お問い合わせの種別選択に「オペレーターに相談」（postback a=inq_operator）
 *   2. 受付返信 →（LINE が応答を受理したら）問い合わせ管理に 種別「オペレーター相談」・対応状況「未対応」で1行追加
 *      → その利用者をオペレーター対応モードにする → 運営に通知
 *   3. オペレーター対応モード中は、その利用者からの Webhook イベントに GAS は一切自動返信しない
 *      （担当者は LINE Official Account Manager のチャット画面から直接返信する。専用チャット画面は作らない）
 *   4. 担当者が「問い合わせ管理」の対応状況を「対応完了」にすると、自動応答を再開する
 *      （次にその利用者からイベントが届いた時点でシートを確認して解除する。自動応答はイベントへの返信なので、
 *       これで「対応完了以降の最初のメッセージから自動応答に戻る」ことになる）
 *
 * ■ 保存先
 *   モードはスクリプトプロパティ OPERATOR_MODE:<LINEユーザーID> に保存（キャッシュと違い期限切れで消えない）。
 *   値は { id: 受付ID, since: 開始時刻ms, n: 停止した件数, last: 最終受信ms }。メッセージ本文は保存しない。
 *   対応状況の正本は「問い合わせ管理」シート。
 *
 * ■ 安全性（GAS単体受信＝署名未検証の前提）
 *   - 開始：先に応答し、LINE が応答を受理した（本物の応答トークン）場合のみモードを開始する。
 *     偽装イベントで他人をオペレーター対応モード（＝自動応答停止）にはできない。
 *   - 解除：Webhook からは解除できない。シートの「対応完了」か、管理メニュー（ADMIN_USERS 確認あり）のみ。
 *   - モード中のイベントは返信しないため応答トークンで真偽を確認できない。よって本文の保存・通知はせず、
 *     件数と最終受信時刻のみ記録する（偽装イベントでもシート・通知に影響しない）。
 *   - シートの確認に失敗した場合は安全側（モード継続＝自動返信しない）に倒し、エラーログに記録する。
 */

var OPERATOR = {
  PROP_PREFIX: 'OPERATOR_MODE:',
  CATEGORY_LABEL: 'オペレーター相談',
  STATUSES: ['未対応', '対応中', '対応完了'],
  DONE: '対応完了',
  NOTE_ACTIVE: 'オペレーター対応（自動応答停止中）'
};

var DEFAULT_OPERATOR_START_TEXT = '担当者（オペレーター）におつなぎします。\n' +
  'このトークにご相談内容をお送りください。担当者が確認のうえ、このトークで順次返信いたします。\n\n' +
  '※担当者の対応が終わるまで、自動応答は停止します。';

function operatorPropKey_(userId) {
  return OPERATOR.PROP_PREFIX + userId;
}

function getOperatorState_(userId) {
  if (!userId) return null;
  var raw = PropertiesService.getScriptProperties().getProperty(operatorPropKey_(userId));
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : { id: '' };
  } catch (e) {
    return { id: '' }; // 壊れた値でもモード中として扱う（安全側）
  }
}

function setOperatorState_(userId, state) {
  PropertiesService.getScriptProperties().setProperty(operatorPropKey_(userId), JSON.stringify(state));
}

/** オペレーター対応モード中の全利用者 [{userId, state}] */
function listOperatorStates_() {
  var all = PropertiesService.getScriptProperties().getProperties() || {};
  return Object.keys(all).filter(function (k) { return k.indexOf(OPERATOR.PROP_PREFIX) === 0; }).map(function (k) {
    var st;
    try { st = JSON.parse(all[k]) || {}; } catch (e) { st = {}; }
    return { userId: k.substring(OPERATOR.PROP_PREFIX.length), state: st };
  });
}

/** 問い合わせ管理の対応状況（行がなければ null） */
function operatorInquiryStatus_(inquiryId) {
  if (!inquiryId) return null;
  var row = findRow_(SHEETS.INQUIRIES, '受付ID', inquiryId);
  return row ? String(row['対応状況'] || '').trim() : null;
}

function releaseOperatorMode_(userId, reason) {
  PropertiesService.getScriptProperties().deleteProperty(operatorPropKey_(userId));
  logInfo_('operator.released', { userId: userId, reason: reason });
}

/**
 * オペレーター対応モード中か（true=自動返信しない）。
 * 「問い合わせ管理」の該当行が「対応完了」ならここで解除して false を返す（自動応答の再開）。
 */
function isOperatorMode_(userId) {
  var st = getOperatorState_(userId);
  if (!st) return false;
  var status;
  try {
    status = operatorInquiryStatus_(st.id);
  } catch (e) {
    logError_('operator.status_check_failed', e, { id: st.id });
    return true; // 確認できない場合は自動返信しない
  }
  if (status === OPERATOR.DONE) {
    releaseOperatorMode_(userId, 'sheet_completed');
    return false;
  }
  if (status === null) logWarn_('operator.inquiry_row_missing', { id: st.id, userId: userId });
  return true;
}

/**
 * オペレーター対応モード中のイベント。返信は一切しない。
 * 記録は件数・最終受信時刻・ログのみ（本文は担当者が LINE のチャット画面で確認する）。
 */
function handleOperatorModeEvent_(ev, userId) {
  var st = getOperatorState_(userId) || {};
  if (ev.type === 'message' || ev.type === 'postback') {
    st.n = (Number(st.n) || 0) + 1;
    st.last = Date.now();
    try { setOperatorState_(userId, st); } catch (e) { logError_('operator.state_save_failed', e, { id: st.id }); }
  }
  if (ev.type === 'follow') {
    // ブロック解除・再追加。返信しないため、未検証イベントはプロフィール API で友だちであることを確認してから反映
    if (isVerifiedEvent_() || checkFriendship_(userId) === 'friend') {
      try { registerCustomer_(userId); } catch (e) { logError_('customer.register_failed', e); }
    }
  }
  logInfo_('operator.auto_reply_suppressed', { type: ev.type, id: st.id, userId: userId, verified: isVerifiedEvent_() });
}

/**
 * 「オペレーターに相談」：受付返信 → 問い合わせ記録 → モード開始 → 運営通知。
 * 未検証イベントは応答が LINE に受理された場合のみ記録・開始・通知する。
 */
function startOperatorHandoff_(ev, userId) {
  if (!userId) return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  var current = getOperatorState_(userId);
  if (current) return null; // 通常は dispatchEvent_ で止まるため到達しない（念のため二重登録しない）

  var id = reserveInquiryId_();
  var text = (getTemplate_('OPERATOR_START') || DEFAULT_OPERATOR_START_TEXT) + '\n\n受付ID：' + id;
  var replyError = null;
  try {
    replyMessage_(ev.replyToken, text);
  } catch (e) {
    if (!isVerifiedEvent_()) throw e; // 未検証：応答が拒否された＝偽装の可能性。何も記録しない
    replyError = e;
  }
  if (!__replySent && !isVerifiedEvent_()) {
    logWarn_('operator.unverified_no_reply', {});
    return null;
  }

  // 入力待ち・未一致メッセージの状態は破棄（モード中は使わない）
  clearInquiryState_(userId);
  CacheService.getScriptCache().remove('last:' + userId);

  var profile = getProfile_(userId) || {};
  var name = profile.displayName ? String(profile.displayName).substring(0, 50) : '';
  var saved = true;
  try {
    withLock_(function () {
      appendRow_(SHEETS.INQUIRIES, {
        '受付ID': id, 'LINEユーザーID': userId, '受付日時': nowString_(), '種別': OPERATOR.CATEGORY_LABEL,
        '内容': 'オペレーター対応の依頼' + (name ? '（LINE表示名：' + name + '）' : '') + '。相談内容は LINE 公式アカウントのチャット画面で確認してください。',
        '対応状況': '未対応', '担当者': '', '回答日時': '',
        '備考': [OPERATOR.NOTE_ACTIVE, isVerifiedEvent_() ? '' : 'GAS単体受信（応答トークン確認済み・署名未検証）'].filter(String).join(' / ')
      });
    });
  } catch (e) {
    saved = false;
    logError_('operator.save_failed', e, { id: id });
  }
  // 保存に失敗してもモードは開始する（利用者には「おつなぎします」と返信済みのため）。
  // シートに行がない間はモード継続（自動では解除されない）。管理メニューから解除できる。
  setOperatorState_(userId, { id: id, since: Date.now(), n: 0 });
  logInfo_('operator.started', { id: id, userId: userId, verified: isVerifiedEvent_() });

  var subject = '【オペレーター対応依頼】' + id;
  var body = subject + '\n' + (name ? 'LINE表示名：' + name + '\n' : '') + '受付ID：' + id +
    '\n\nLINE Official Account Manager のチャット画面から、この利用者に返信してください。' +
    '\nこの利用者への GAS の自動応答は停止しています。' +
    '\n対応が終わったら「問い合わせ管理」の対応状況を「対応完了」にしてください（自動応答が再開します）。' +
    (saved ? '' : '\n\n【要対応】問い合わせ管理への保存に失敗しました。手動で行を追加するか、管理メニューからオペレーター対応を終了してください。');
  if (!notifyAdmin_(subject, body)) {
    logError_('operator.notify_failed', new Error('オペレーター対応依頼を運営に通知できませんでした（ADMIN_NOTIFY_TARGET / ADMIN_EMAIL を確認）'), { id: id });
  }

  if (replyError) {
    // 署名検証済みイベントで応答に失敗した場合はプッシュで知らせる（受付済みのため再処理させない）
    logError_('operator.reply_failed', replyError, { id: id });
    __replySent = true;
    try { pushMessage_(userId, text, deterministicUuid_('op-ack:' + id)); }
    catch (e2) { logError_('operator.ack_push_failed', e2, { id: id }); }
  }
  return id;
}

/* ---------- 管理（adminRun から呼ぶ。ADMIN_USERS 確認済み） ---------- */

function formatElapsed_(ms) {
  var h = Math.floor(ms / 3600000);
  return h >= 24 ? Math.floor(h / 24) + '日' + (h % 24) + '時間' : h + '時間' + Math.floor((ms % 3600000) / 60000) + '分';
}

/** オペレーター対応中の一覧（読み取りのみ。解除はしない） */
function adminOperatorStatus_() {
  var list = listOperatorStates_();
  if (!list.length) return { ok: true, title: 'オペレーター対応状況', message: 'オペレーター対応中の利用者はいません（全員に自動応答しています）。' };
  var rows = {};
  try { readRows_(SHEETS.INQUIRIES).forEach(function (r) { rows[String(r['受付ID'])] = r; }); } catch (e) { rows = {}; }
  var now = Date.now();
  var warn = false;
  var lines = list.map(function (x) {
    var r = rows[String(x.state.id || '')];
    var status = r ? String(r['対応状況'] || '').trim() || '（空欄）' : '（行なし）';
    if (!r) warn = true;
    var mark = status === OPERATOR.DONE ? '【次回受信時に解除】' : (!r ? '【要確認】' : '【対応中】');
    return mark + ' ' + (x.state.id || '受付ID不明') + '／対応状況：' + status + '／担当者：' + (r && r['担当者'] ? r['担当者'] : '未設定') +
      '\n    開始から ' + (x.state.since ? formatElapsed_(now - Number(x.state.since)) : '不明') +
      '／停止した自動応答 ' + (Number(x.state.n) || 0) + ' 件' +
      (x.state.last ? '（最終受信 ' + Utilities.formatDate(new Date(Number(x.state.last)), APP.TIMEZONE, 'MM/dd HH:mm') + '）' : '');
  });
  return { ok: !warn, title: 'オペレーター対応状況',
    message: 'オペレーター対応中：' + list.length + ' 名\n\n' + lines.join('\n') +
      '\n\n・「対応完了」にした利用者は、次にメッセージが届いた時点で自動応答に戻ります。' +
      (warn ? '\n・【要確認】は問い合わせ管理に行が見つかりません。管理メニュー「オペレーター対応を終了（受付ID指定）」で解除できます。' : '') };
}

/**
 * 受付IDを指定してオペレーター対応を終了（自動応答を再開）。
 * 問い合わせ管理に行があり「対応完了」でなければ、対応状況を「対応完了」に更新する。
 */
function adminOperatorRelease_(inquiryId) {
  inquiryId = String(inquiryId || '').trim();
  if (!/^INQ-\d{8}-\d{4,}$/.test(inquiryId)) return { ok: false, title: 'オペレーター対応の終了', message: '受付ID（例 INQ-20261021-0001）を指定してください。' };
  var hit = listOperatorStates_().filter(function (x) { return String(x.state.id) === inquiryId; });
  var updated = false;
  withLock_(function () {
    var row = findRow_(SHEETS.INQUIRIES, '受付ID', inquiryId);
    if (row && String(row['対応状況'] || '').trim() !== OPERATOR.DONE) {
      updateRow_(SHEETS.INQUIRIES, row.__row, { '対応状況': OPERATOR.DONE });
      updated = true;
    }
  });
  hit.forEach(function (x) { releaseOperatorMode_(x.userId, 'admin'); });
  if (!hit.length) {
    return { ok: true, title: 'オペレーター対応の終了', message: inquiryId + ' はオペレーター対応中ではありません（自動応答中）。' +
      (updated ? '\n対応状況を「対応完了」に更新しました。' : '') };
  }
  return { ok: true, title: 'オペレーター対応の終了', message: inquiryId + ' のオペレーター対応を終了し、自動応答を再開しました。' +
    (updated ? '\n問い合わせ管理の対応状況を「対応完了」に更新しました。' : '') + '\n（利用者へのメッセージ送信は行っていません）' };
}

/** 問い合わせ管理の「対応状況」に選択肢（未対応／対応中／対応完了）を設定。既存の値は変更しない */
function ensureInquiryStatusValidation_() {
  var sh = getSheet_(SHEETS.INQUIRIES);
  var col = getHeaders_(sh).indexOf('対応状況') + 1;
  if (col <= 0) return false;
  var l = columnLetter_(col);
  sh.getRange(l + '2:' + l).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(OPERATOR.STATUSES, true).setAllowInvalid(true).build());
  return true;
}
