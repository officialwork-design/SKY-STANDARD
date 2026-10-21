/**
 * 12_Operator.gs
 * 有人オペレーター対応と、顧客ごとの自動返信の有効／停止（「問い合わせ管理」の「自動返信有効」列）。
 *
 * ■ 自動返信有効（TRUE / FALSE）
 *   TRUE  : Bot の自動返信を行う
 *   FALSE : その顧客への Bot の自動返信をすべて停止する（担当者は LINE Official Account Manager のチャットから返信）
 *   空欄  : 指定なし（判定に使わない）。既存の問い合わせ行は空欄のまま変更しない
 *   新しく作る行には、通常の問い合わせは TRUE、「オペレーターに相談」は FALSE を書き込む。
 *
 * ■ 同じ顧客に複数の問い合わせがある場合の優先順位
 *   その顧客（LINEユーザーID）の行のうち、自動返信有効が TRUE / FALSE の行だけを対象に、
 *     1. 受付日時が新しい行
 *     2. 受付日時が同じ・読めない場合は、シート上で下にある行
 *   を優先し、最も優先される1行（＝判定行）の値で決める。対象の行がなければ TRUE（既定）。
 *   TRUE / FALSE 以外の値（入力ミス）の行は判定に使わず、管理メニューの状況確認で【要確認】として表示する。
 *   → 再開するときは判定行（通常は最新の「オペレーター相談」の行）を TRUE にする。
 *     古い行だけを FALSE にしても、より新しい行に TRUE があれば停止しない（状況確認で表示する）。
 *
 * ■ スクリプトプロパティとの整合
 *   正本はシート。スクリプトプロパティ OPERATOR_MODE:<LINEユーザーID> は「停止中」であることの内部記録
 *   （判定行の受付ID・開始時刻・停止した件数）で、シートから導く。イベントを受信するたびに判定し、
 *     シート FALSE ／ プロパティなし → プロパティを作成（シートで手動停止した場合）
 *     シート TRUE  ／ プロパティあり → プロパティを削除（シートで手動再開した場合）
 *     シート FALSE ／ 判定行が変わった → プロパティの受付IDを更新
 *   のようにプロパティをシートに合わせる。管理メニュー「自動返信の状態を同期」で全顧客をまとめて合わせることもできる。
 *   例外：シートを読めない場合のみプロパティで判断する（プロパティあり＝停止。安全側）。
 *   旧版（対応状況「対応完了」で再開していた版）で作られたプロパティは、自動返信有効が空欄なら
 *   対応状況から TRUE / FALSE を一度だけ書き込んで移行する。
 *
 * ■ 安全性（GAS単体受信＝署名未検証の前提）
 *   - 停止の開始（オペレーターに相談）：先に応答し、LINE が応答を受理した（本物の応答トークン）場合のみ。
 *   - 再開：Webhook からは不可。シートを TRUE にするか、管理メニュー（ADMIN_USERS 確認あり）のみ。
 *   - 停止中のイベントは返信しないため真偽を確認できない。本文の保存・通知はせず、件数と最終受信時刻のみ記録する。
 */

var OPERATOR = {
  PROP_PREFIX: 'OPERATOR_MODE:',
  CATEGORY_LABEL: 'オペレーター相談',
  STATUSES: ['未対応', '対応中', '対応完了'],
  DONE: '対応完了',
  COL: '自動返信有効',
  FLAG_VALUES: ['TRUE', 'FALSE'],
  NOTE_ACTIVE: 'オペレーター対応（自動返信有効=FALSE）'
};

var DEFAULT_OPERATOR_START_TEXT = '担当者（オペレーター）におつなぎします。\n' +
  'このトークにご相談内容をお送りください。担当者が確認のうえ、このトークで順次返信いたします。\n\n' +
  '※担当者の対応が終わるまで、自動応答は停止します。';

/* ---------- 自動返信有効（シート）の判定 ---------- */

/**
 * セル値 → true / false / null（空欄） / undefined（TRUE・FALSE 以外＝入力ミス）
 * チェックボックス・TRUE/FALSE の自動変換（boolean）と文字列の両方を受け付ける。
 */
function parseAutoReplyFlag_(v) {
  if (v === true || v === false) return v;
  var s = v == null ? '' : String(v).trim().toUpperCase();
  if (s === '') return null;
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return undefined;
}

/** 行の新しさ（受付日時 → シート上の位置） */
function inquiryRowOrder_(a, b) {
  var ta = parseEventTime_(a['受付日時']), tb = parseEventTime_(b['受付日時']);
  var va = ta ? ta.getTime() : 0, vb = tb ? tb.getTime() : 0;
  if (va !== vb) return vb - va;
  return (b.__row || 0) - (a.__row || 0);
}

/**
 * 顧客ごとの自動返信設定を判定する。
 * @param {Object[]} rows その顧客の問い合わせ行（readRows_ の結果を LINEユーザーID で絞ったもの）
 * @return {{enabled:boolean, row:Object|null, overridden:Object[], invalid:Object[]}}
 *   row=判定行（null なら既定 TRUE）、overridden=判定行より古く値が異なる行、invalid=TRUE/FALSE 以外の行
 */
function decideAutoReply_(rows) {
  var sorted = rows.slice().sort(inquiryRowOrder_);
  var decided = null, overridden = [], invalid = [];
  sorted.forEach(function (r) {
    var f = parseAutoReplyFlag_(r[OPERATOR.COL]);
    if (f === undefined) { invalid.push(r); return; }
    if (f === null) return;
    if (!decided) decided = { row: r, enabled: f };
    else if (f !== decided.enabled) overridden.push(r);
  });
  return { enabled: decided ? decided.enabled : true, row: decided ? decided.row : null, overridden: overridden, invalid: invalid };
}

/** 問い合わせ管理を顧客ごとにまとめる { userId: rows[] } */
function inquiryRowsByUser_() {
  var map = {};
  readRows_(SHEETS.INQUIRIES).forEach(function (r) {
    var u = String(r['LINEユーザーID'] || '').trim();
    if (!u) return;
    (map[u] = map[u] || []).push(r);
  });
  return map;
}

function inquiryRowsOfUser_(userId) {
  return readRows_(SHEETS.INQUIRIES).filter(function (r) { return String(r['LINEユーザーID'] || '').trim() === userId; });
}

/* ---------- スクリプトプロパティ（停止中の内部記録） ---------- */

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
    return { id: '' }; // 壊れた値でも停止中として扱う（安全側）
  }
}

function setOperatorState_(userId, state) {
  PropertiesService.getScriptProperties().setProperty(operatorPropKey_(userId), JSON.stringify(state));
}

/** 停止中として記録されている全顧客 [{userId, state}] */
function listOperatorStates_() {
  var all = PropertiesService.getScriptProperties().getProperties() || {};
  return Object.keys(all).filter(function (k) { return k.indexOf(OPERATOR.PROP_PREFIX) === 0; }).map(function (k) {
    var st;
    try { st = JSON.parse(all[k]) || {}; } catch (e) { st = {}; }
    return { userId: k.substring(OPERATOR.PROP_PREFIX.length), state: st };
  });
}

function releaseOperatorMode_(userId, reason) {
  PropertiesService.getScriptProperties().deleteProperty(operatorPropKey_(userId));
  logInfo_('operator.released', { userId: userId, reason: reason });
}

/**
 * 旧版のプロパティの移行：自動返信有効が空欄なら、対応状況から値を書き込む（対応完了→TRUE、それ以外→FALSE）。
 * @return {boolean} 書き込んだか
 */
function migrateLegacyOperatorRow_(rows, st) {
  if (!st || !st.id) return false;
  var row = rows.filter(function (r) { return String(r['受付ID']) === String(st.id); })[0];
  if (!row || parseAutoReplyFlag_(row[OPERATOR.COL]) !== null) return false;
  var done = String(row['対応状況'] || '').trim() === OPERATOR.DONE;
  updateRow_(SHEETS.INQUIRIES, row.__row, (function (p) { p[OPERATOR.COL] = done; return p; })({}));
  row[OPERATOR.COL] = done;
  logInfo_('operator.legacy_migrated', { id: st.id, enabled: done });
  return true;
}

/**
 * シートの判定結果にプロパティを合わせる。
 * @return {string} 実施内容（'' / 'created' / 'updated' / 'released'）
 */
function syncOperatorState_(userId, decision, st) {
  if (!decision.enabled) {
    var id = String(decision.row && decision.row['受付ID'] || '');
    if (!st) {
      setOperatorState_(userId, { id: id, since: Date.now(), n: 0, by: 'sheet' });
      logInfo_('operator.stopped_by_sheet', { id: id, userId: userId });
      return 'created';
    }
    if (String(st.id || '') !== id) {
      st.id = id;
      setOperatorState_(userId, st);
      return 'updated';
    }
    return '';
  }
  if (st) {
    releaseOperatorMode_(userId, decision.row ? 'sheet_true' : 'sheet_no_setting');
    return 'released';
  }
  return '';
}

/**
 * 自動返信を止める顧客か（true=自動返信しない）。シートを正本として判定し、プロパティを合わせる。
 * シートを読めない場合はプロパティで判断する（プロパティあり＝停止）。
 */
function isOperatorMode_(userId) {
  var st = getOperatorState_(userId);
  var rows;
  try {
    rows = inquiryRowsOfUser_(userId);
  } catch (e) {
    logError_('operator.status_check_failed', e, { id: st && st.id });
    return !!st;
  }
  var decision = decideAutoReply_(rows);
  if (!decision.row && st) {
    try {
      if (migrateLegacyOperatorRow_(rows, st)) decision = decideAutoReply_(rows);
    } catch (e) { logError_('operator.migrate_failed', e, { id: st.id }); }
    if (!decision.row && st.id && !rows.some(function (r) { return String(r['受付ID']) === String(st.id); })) {
      // 受付返信後に行の保存に失敗した等で、停止の根拠となる行がない。自動では再開しない（管理メニューで解除）
      logWarn_('operator.inquiry_row_missing', { id: st.id, userId: userId });
      return true;
    }
  }
  try { syncOperatorState_(userId, decision, st); } catch (e) { logError_('operator.state_save_failed', e, { id: st && st.id }); }
  return !decision.enabled;
}

/**
 * 自動返信停止中のイベント。返信は一切しない。
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

/* ---------- 「オペレーターに相談」 ---------- */

/**
 * 受付返信 → 問い合わせ記録（自動返信有効=FALSE）→ 停止の記録 → 運営通知。
 * 未検証イベントは応答が LINE に受理された場合のみ記録・停止・通知する。
 */
function startOperatorHandoff_(ev, userId) {
  if (!userId) return replyMessage_(ev.replyToken, buildInquiryCategoryMessage_());
  if (getOperatorState_(userId)) return null; // 通常は dispatchEvent_ で止まるため到達しない（二重登録しない）

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

  // 入力待ち・未一致メッセージの状態は破棄（停止中は使わない）
  clearInquiryState_(userId);
  CacheService.getScriptCache().remove('last:' + userId);

  var profile = getProfile_(userId) || {};
  var name = profile.displayName ? String(profile.displayName).substring(0, 50) : '';
  var saved = true;
  try {
    withLock_(function () {
      var row = {
        '受付ID': id, 'LINEユーザーID': userId, '受付日時': nowString_(), '種別': OPERATOR.CATEGORY_LABEL,
        '内容': 'オペレーター対応の依頼' + (name ? '（LINE表示名：' + name + '）' : '') + '。相談内容は LINE 公式アカウントのチャット画面で確認してください。',
        '対応状況': '未対応', '担当者': '', '回答日時': '',
        '備考': [OPERATOR.NOTE_ACTIVE, isVerifiedEvent_() ? '' : 'GAS単体受信（応答トークン確認済み・署名未検証）'].filter(String).join(' / ')
      };
      row[OPERATOR.COL] = false;
      appendRow_(SHEETS.INQUIRIES, row);
    });
  } catch (e) {
    saved = false;
    logError_('operator.save_failed', e, { id: id });
  }
  // 保存に失敗しても停止は記録する（利用者には「おつなぎします」と返信済みのため）。
  // シートに行がない間は自動では再開しない。管理メニューから解除できる。
  setOperatorState_(userId, { id: id, since: Date.now(), n: 0, by: 'operator_request' });
  logInfo_('operator.started', { id: id, userId: userId, verified: isVerifiedEvent_() });

  var subject = '【オペレーター対応依頼】' + id;
  var body = subject + '\n' + (name ? 'LINE表示名：' + name + '\n' : '') + '受付ID：' + id +
    '\n\nLINE Official Account Manager のチャット画面から、この利用者に返信してください。' +
    '\nこの利用者への Bot の自動返信は停止しました（問い合わせ管理「自動返信有効」= FALSE）。' +
    '\n対応が終わったら、この受付IDの行の「自動返信有効」を TRUE にしてください（次のメッセージから自動返信を再開します）。' +
    (saved ? '' : '\n\n【要対応】問い合わせ管理への保存に失敗しました。手動で行を追加するか、管理メニューから自動返信を再開してください。');
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

/**
 * 全顧客の判定結果とプロパティを突き合わせる。
 * @return {{stopped:Object[], mismatch:Object[], orphan:Object[], invalid:Object[], overridden:Object[]}}
 */
function collectAutoReplyReport_() {
  var byUser = inquiryRowsByUser_();
  var states = {};
  listOperatorStates_().forEach(function (x) { states[x.userId] = x.state; });
  var rep = { stopped: [], mismatch: [], orphan: [], invalid: [], overridden: [] };
  Object.keys(byUser).forEach(function (u) {
    var d = decideAutoReply_(byUser[u]);
    var st = states[u] || null;
    d.invalid.forEach(function (r) { rep.invalid.push(r); });
    if (d.row) d.overridden.forEach(function (r) { rep.overridden.push({ row: r, by: d.row }); });
    if (!d.row && st) {
      var hasRow = byUser[u].some(function (r) { return String(r['受付ID']) === String(st.id); });
      if (hasRow) rep.mismatch.push({ userId: u, decision: d, state: st, legacy: true });
      else rep.orphan.push({ userId: u, state: st });
      delete states[u];
      return;
    }
    if (!d.enabled) rep.stopped.push({ userId: u, decision: d, state: st });
    var inSync = d.enabled ? !st : (st && String(st.id || '') === String(d.row['受付ID']));
    if (!inSync) rep.mismatch.push({ userId: u, decision: d, state: st });
    delete states[u];
  });
  Object.keys(states).forEach(function (u) { rep.orphan.push({ userId: u, state: states[u] }); });
  return rep;
}

/** 自動返信の状況（読み取りのみ。プロパティは変更しない）。LINEユーザーIDは表示しない */
function adminOperatorStatus_() {
  var rep = collectAutoReplyReport_();
  var now = Date.now();
  var lines = [];
  lines.push('自動返信を停止中（自動返信有効=FALSE）：' + rep.stopped.length + ' 名');
  rep.stopped.forEach(function (x) {
    var r = x.decision.row, st = x.state || {};
    lines.push('・' + r['受付ID'] + '（' + (r['種別'] || '-') + '）／対応状況：' + (String(r['対応状況'] || '').trim() || '（空欄）') +
      '／担当者：' + (r['担当者'] || '未設定') +
      '\n    ' + (st.since ? '停止から ' + formatElapsed_(now - Number(st.since)) : '停止時刻：未記録（次の受信時に記録）') +
      '／停止した自動返信 ' + (Number(st.n) || 0) + ' 件' +
      (st.last ? '（最終受信 ' + Utilities.formatDate(new Date(Number(st.last)), APP.TIMEZONE, 'MM/dd HH:mm') + '）' : ''));
  });
  var warn = rep.orphan.length + rep.invalid.length > 0;
  if (rep.orphan.length) {
    lines.push('\n【要確認】停止中の記録があるのに、問い合わせ管理に行がない：' + rep.orphan.length + ' 件');
    rep.orphan.forEach(function (x) { lines.push('・' + (x.state.id || '受付ID不明')); });
    lines.push('  受付返信後にシート保存が失敗した等が考えられます。この顧客の自動返信は停止したままです。' +
      '\n  問い合わせ管理にこの受付IDの行を追加し、「自動返信有効」に TRUE（再開）または FALSE（停止継続）を入力してください。入力後はシートに従います。');
  }
  if (rep.invalid.length) {
    lines.push('\n【要確認】自動返信有効が TRUE / FALSE 以外（判定に使っていません）：');
    rep.invalid.forEach(function (r) { lines.push('・' + r['受付ID'] + '：「' + String(r[OPERATOR.COL]).substring(0, 20) + '」'); });
  }
  if (rep.overridden.length) {
    lines.push('\n【情報】より新しい行の値が優先されている行：');
    rep.overridden.forEach(function (x) {
      lines.push('・' + x.row['受付ID'] + '（' + flagText_(x.row[OPERATOR.COL]) + '）→ ' + x.by['受付ID'] + '（' + flagText_(x.by[OPERATOR.COL]) + '）が優先');
    });
  }
  if (rep.mismatch.length) {
    lines.push('\n【情報】シートと内部記録（スクリプトプロパティ）の差：' + rep.mismatch.length + ' 件。' +
      'その顧客から次にメッセージが届いた時点で自動的にシートに合わせます（「自動返信の状態を同期」ですぐに合わせることもできます）。');
  }
  lines.push('\n優先順位：同じ顧客の行のうち、自動返信有効が TRUE / FALSE の行で受付日時が最も新しい行（同じならシートの下の行）の値で決まります。空欄の行は判定に使いません。');
  return { ok: !warn, title: '自動返信の状況（オペレーター対応）', message: lines.join('\n') };
}

function flagText_(v) {
  var f = parseAutoReplyFlag_(v);
  return f === true ? 'TRUE' : f === false ? 'FALSE' : '空欄';
}

/** シートの判定に合わせてスクリプトプロパティを修正（旧版の移行を含む）。シートの値は旧版の移行以外変更しない */
function adminOperatorSync_() {
  var rep = collectAutoReplyReport_();
  var n = { created: 0, updated: 0, released: 0, migrated: 0 };
  withLock_(function () {
    var byUser = null;
    rep.mismatch.forEach(function (x) {
      if (x.legacy) {
        byUser = byUser || inquiryRowsByUser_();
        if (migrateLegacyOperatorRow_(byUser[x.userId] || [], x.state)) n.migrated++;
        var d = decideAutoReply_(byUser[x.userId] || []);
        var r = syncOperatorState_(x.userId, d, x.state);
        if (r) n[r]++;
        return;
      }
      var res = syncOperatorState_(x.userId, x.decision, x.state);
      if (res) n[res]++;
    });
  });
  return { ok: rep.orphan.length === 0, title: '自動返信の状態を同期',
    message: 'シート（自動返信有効）に合わせて内部記録を修正しました。\n' +
      '・停止の記録を作成：' + n.created + ' 件\n・判定行の受付IDを更新：' + n.updated + ' 件\n・停止の記録を削除（再開）：' + n.released + ' 件' +
      (n.migrated ? '\n・旧版の停止記録をシートに移行（自動返信有効を書き込み）：' + n.migrated + ' 件' : '') +
      (rep.orphan.length ? '\n\n【要確認】問い合わせ管理に行がない停止記録が ' + rep.orphan.length + ' 件あります（自動では解除しません）。「自動返信の状況」で確認してください。' : '') +
      '\n\n利用者へのメッセージ送信は行っていません。' };
}

/**
 * 選択した問い合わせの顧客の自動返信を再開する。
 * その顧客の「自動返信有効」が FALSE の行をすべて TRUE にし（他の列・対応状況は変更しない）、内部記録を削除する。
 * 行がない停止記録（保存失敗など）は受付IDで解除する。
 */
function adminOperatorRelease_(inquiryId) {
  inquiryId = String(inquiryId || '').trim();
  var title = '自動返信の再開';
  if (!/^INQ-\d{8}-\d{4,}$/.test(inquiryId)) return { ok: false, title: title, message: '受付ID（例 INQ-20261021-0001）を指定してください。' };
  var changed = [];
  var userId = '';
  withLock_(function () {
    var row = findRow_(SHEETS.INQUIRIES, '受付ID', inquiryId);
    if (!row) return;
    userId = String(row['LINEユーザーID'] || '').trim();
    if (!userId) return;
    inquiryRowsOfUser_(userId).forEach(function (r) {
      if (parseAutoReplyFlag_(r[OPERATOR.COL]) === false) {
        var p = {}; p[OPERATOR.COL] = true;
        updateRow_(SHEETS.INQUIRIES, r.__row, p);
        changed.push(String(r['受付ID']));
      }
    });
  });
  var released = 0;
  listOperatorStates_().forEach(function (x) {
    if ((userId && x.userId === userId) || String(x.state.id) === inquiryId) { releaseOperatorMode_(x.userId, 'admin'); released++; }
  });
  if (!userId && !released) return { ok: false, title: title, message: inquiryId + ' は問い合わせ管理に見つかりません。' };
  return { ok: true, title: title,
    message: (changed.length || released ? inquiryId + ' の顧客の自動返信を再開しました。' : inquiryId + ' の顧客は自動返信中です（変更なし）。') +
      (changed.length ? '\n「自動返信有効」を TRUE にした行：' + changed.join('、') : '') +
      '\n（対応状況・担当者は変更していません。利用者へのメッセージ送信は行っていません）' };
}

/**
 * 問い合わせ管理の選択肢：「対応状況」（未対応／対応中／対応完了）と「自動返信有効」（TRUE／FALSE）。
 * 既存の値は変更しない（選択肢以外の値も警告のみで残す）。
 * 「自動返信有効」はチェックボックスにしない（空欄が FALSE と表示・解釈され、既存の行がすべて停止扱いになるのを防ぐ）。
 */
function ensureInquiryStatusValidation_() {
  var sh = getSheet_(SHEETS.INQUIRIES);
  var headers = getHeaders_(sh);
  var set = function (colName, list) {
    var col = headers.indexOf(colName) + 1;
    if (col <= 0) return false;
    var l = columnLetter_(col);
    sh.getRange(l + '2:' + l).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build());
    return true;
  };
  var a = set('対応状況', OPERATOR.STATUSES);
  var b = set(OPERATOR.COL, OPERATOR.FLAG_VALUES);
  return a && b;
}
