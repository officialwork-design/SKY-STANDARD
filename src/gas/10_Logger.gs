/**
 * 10_Logger.gs
 * イベント・送信結果・エラーのログ。
 *   - 「エラーログ」シート：障害（ERROR / FATAL）、注意（WARNING）、設定による停止（CONFIG_WARNING）
 *     （logError_ / logIncident_。INFO と一般の WARN は実行ログのみ）
 *   - 「LINE操作ログ」シート：Webhook イベントごとの受信 → 処理 → 返信 → 終了の記録（追記のみ。traceBegin_〜traceEnd_）
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

/**
 * エラーログ。実行ログ（console.error）に出力し、さらに「エラーログ」シートへ記録する。
 * 既存の呼び出し形式 logError_(event, err, detail) をそのまま維持する。
 *
 * @param {string} event  発生箇所を表すコード（例 'webhook.event_failed'）
 * @param {*} err         例外（Error 以外も可）
 * @param {Object=} detail 補足情報（scrubForLog_ で機密キーを除去してから使う）
 * @param {{severity?:string}=} opts severity: 'ERROR'（既定）/ 'FATAL'
 *
 * ログ処理自体の失敗で本来の処理を止めないよう、この関数は例外を投げない。
 */
function logError_(event, err, detail, opts) {
  var msg = '';
  try {
    msg = sanitizeErrorText_(err && err.message ? err.message : String(err));
    console.error(JSON.stringify({ level: 'ERROR', event: event, message: msg, detail: scrubForLog_(detail || {}) }));
  } catch (e) {
    try { console.error('logError_ failed: ' + event); } catch (e2) { /* noop */ }
  }
  try {
    recordErrorToSheet_(event, err, detail, opts);
  } catch (e) {
    try { console.error('errorlog.write_failed: ' + sanitizeErrorText_(e && e.message)); } catch (e2) { /* noop */ }
  }
}

/** エラーメッセージ・スタックから機密情報を取り除く */
function sanitizeErrorText_(text) {
  var s = String(text == null ? '' : text);
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [REDACTED]');
  // UrlFetchApp の例外メッセージには URL（lineUserId 等）が含まれるためマスク
  s = s.replace(/[UCR][0-9a-f]{32}/g, function (id) { return maskId_(id); });
  s = s.replace(/([?&](?:lineUserId|id_token|token|access_token|key|code)=)[^&\s"']+/gi, '$1[REDACTED]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
  s = s.replace(/(?<![\w-])(\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}(?![\w-])/g, '[PHONE]');
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[JWT]');
  return s;
}

/* ---------- エラーログシート ---------- */

var ERROR_LOG = {
  SHEET: 'エラーログ',
  /**
   * 既存8列（2026-10-21〜）＋監視用6列（2026-11 追加。既存列の後ろに補完し、既存の行・列は変更しない）。
   *   重要度＝ログレベル、発生元＝機能名、エラーメッセージ＝エラー内容、関連ID＝受付ID等の識別子
   */
  HEADERS: ['発生日時', '重要度', '発生元', '関数名', 'エラーメッセージ', 'エラー詳細・スタックトレース', '関連ID', '対応状況',
    'イベント種別', '追跡ID', '原因コード', '処理結果', '関連設定キー', 'HTTPステータス'],
  STATUSES: ['未対応', '対応中', '対応済み', '対象外'],
  /** 同一エラーの記録抑制時間（秒）。CONFIG_WARNING は同じ原因・同じ対象につき6時間に1件 */
  DEDUP_SEC: { ERROR: 600, FATAL: 60, WARNING: 600, CONFIG_WARNING: 21600 },
  MAX_MESSAGE: 500,
  MAX_DETAIL: 3000
};

/** 処理全体が止まる・データが失われる種類のエラー（FATAL） */
var FATAL_EVENTS = ['doPost.unhandled', 'webhook.direct_failed', 'inquiry.save_failed_after_reply', 'trigger.failed',
  'errorlog.test_fatal'];

/** event の接頭辞 → 発生元（日本語） */
var ERROR_SOURCES = [
  [/^webhook\.|^doPost\./, 'Webhook'],
  [/^line\.|^richmenu\./, 'LINE API'],
  [/^faq\./, 'FAQ'],
  [/^inquiry\./, '問い合わせ'],
  [/^operator\./, 'オペレーター対応'],
  [/^customer\./, '顧客管理'],
  [/^liff\.|^reservation/, '予約'],
  [/^notify\.|^template\.|^sendlog\.|^reminder\./, '通知'],
  [/^admin\.|^errorlog\./, '管理メニュー'],
  [/^trigger/, 'トリガー'],
  [/^config\.|^idsheet\./, '設定']
];

function errorSourceOf_(event) {
  for (var i = 0; i < ERROR_SOURCES.length; i++) if (ERROR_SOURCES[i][0].test(event)) return ERROR_SOURCES[i][1];
  return 'その他';
}

/** スタックトレースから、例外が発生した関数名を取り出す（GAS V8 形式 "at fn (file:line:col)"） */
function functionNameFromStack_(stack) {
  var lines = String(stack || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*at\s+(?:new\s+)?([A-Za-z0-9_$.]+)\s*\(/);
    if (m && m[1] !== 'logError_' && m[1] !== 'recordErrorToSheet_') return m[1];
  }
  return '';
}

/** 関連ID（機密でない識別子のみ。LINE ユーザーID・本文は含めない） */
function relatedIdOf_(detail) {
  if (!detail || typeof detail !== 'object') return '';
  var keys = ['sendId', 'id', 'reservationId', 'eventId', 'action', 'type', 'kind'];
  for (var i = 0; i < keys.length; i++) {
    var v = detail[keys[i]];
    if (v != null && v !== '' && typeof v !== 'object') return keys[i] + ':' + sanitizeErrorText_(String(v)).substring(0, 80);
  }
  return '';
}

/** 「エラーログ」シートを取得（なければ作成して書式設定）。既存シートの内容は変更しない */
function ensureErrorLogSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(ERROR_LOG.SHEET);
  var created = false;
  if (!sh) {
    sh = ss.insertSheet(ERROR_LOG.SHEET);
    sh.getRange(1, 1, 1, ERROR_LOG.HEADERS.length).setValues([ERROR_LOG.HEADERS]);
    created = true;
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, ERROR_LOG.HEADERS.length).setValues([ERROR_LOG.HEADERS]);
  }
  var addedCols = ensureColumns_(ERROR_LOG.SHEET, ERROR_LOG.HEADERS);
  if (created || addedCols.length) formatErrorLogSheet_(sh);
  return { sheet: sh, created: created, addedColumns: addedCols };
}

/**
 * 書式：ヘッダー固定・太字、フィルター、重要度の色分け（FATAL=赤 / ERROR=橙）、対応状況の選択肢。
 * 何度実行しても重複しない（既存のフィルター・条件付き書式は本シート用のものだけ置き換える）。
 */
function formatErrorLogSheet_(sh) {
  var headers = getHeaders_(sh);
  var lastCol = headers.length;
  var lastLetter = columnLetter_(lastCol);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#0E2547').setFontColor('#FFFFFF');
  // 行数を指定しない列範囲（A1:H など）にして、後から追加される行もフィルター・色分け・選択肢の対象にする
  // 既存のフィルター（利用者の絞り込み条件）は保持し、列が足りない場合だけ作り直す
  var filter = sh.getFilter();
  if (filter && filter.getRange().getNumColumns() < lastCol) { filter.remove(); filter = null; }
  if (!filter) sh.getRange('A1:' + lastLetter).createFilter();

  var sevCol = headers.indexOf('重要度') + 1;
  var rowRange = sh.getRange('A2:' + lastLetter);
  var colLetter = columnLetter_(sevCol);
  var rules = (sh.getConditionalFormatRules() || []).filter(function (r) {
    // 以前この関数が設定した色分けルールだけを除いて付け直す
    var c = r.getBooleanCondition && r.getBooleanCondition();
    var vals = c ? c.getCriteriaValues() : [];
    return !(vals.length && /^=\$[A-Z]+2="(FATAL|ERROR|WARNING|CONFIG_WARNING)"$/.test(String(vals[0])));
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + colLetter + '2="FATAL"')
    .setBackground('#F8D7DA').setFontColor('#842029').setRanges([rowRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + colLetter + '2="ERROR"')
    .setBackground('#FFF3CD').setFontColor('#664D03').setRanges([rowRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + colLetter + '2="CONFIG_WARNING"')
    .setBackground('#DCEBFA').setFontColor('#0B3C6E').setRanges([rowRange]).build());
  sh.setConditionalFormatRules(rules);

  var statusCol = headers.indexOf('対応状況') + 1;
  if (statusCol > 0) {
    var sl = columnLetter_(statusCol);
    sh.getRange(sl + '2:' + sl).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ERROR_LOG.STATUSES, true).setAllowInvalid(true).build());
  }
  var widths = { '発生日時': 150, '重要度': 110, '発生元': 170, '関数名': 160, 'エラーメッセージ': 320, 'エラー詳細・スタックトレース': 420, '関連ID': 160, '対応状況': 90,
    'イベント種別': 90, '追跡ID': 220, '原因コード': 220, '処理結果': 110, '関連設定キー': 200, 'HTTPステータス': 90 };
  headers.forEach(function (h, i) { if (widths[h]) sh.setColumnWidth(i + 1, widths[h]); });
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * 同一エラーの短時間重複を抑制する（判定のみ。記録済みの登録は書き込み成功後に errorDedupMark_ で行う）。
 *   キー = 発生箇所 + メッセージ（数字は同一視）。ERROR は10分、FATAL は1分に1件だけ記録。
 *   抑制した件数は次に記録する行の詳細に「抑制 N 件」と残す（同時発生時は概数）。
 * @return {{write:boolean, suppressed:number, key:string, ttl:number}}
 */
function errorDedup_(severity, event, message) {
  var cache = CacheService.getScriptCache();
  var norm = String(message).replace(/\d+/g, '#').substring(0, 200);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, event + '|' + norm, Utilities.Charset.UTF_8);
  var key = 'errlog:' + digest.slice(0, 12).map(function (b) { return ((b + 256) % 256).toString(16); }).join('');
  var countKey = key + ':n';
  var ttl = ERROR_LOG.DEDUP_SEC[severity] || ERROR_LOG.DEDUP_SEC.ERROR;
  if (cache.get(key)) {
    var n = parseInt(cache.get(countKey) || '0', 10) + 1;
    cache.put(countKey, String(n), 21600);
    return { write: false, suppressed: n, key: key, ttl: ttl };
  }
  return { write: true, suppressed: parseInt(cache.get(countKey) || '0', 10), key: key, ttl: ttl };
}

/** 書き込みに成功したときだけ「記録済み」にする（失敗した場合に同じエラーを抑制しないため） */
function errorDedupMark_(dedup) {
  if (!dedup || !dedup.key) return;
  var cache = CacheService.getScriptCache();
  cache.put(dedup.key, '1', dedup.ttl);
  cache.remove(dedup.key + ':n');
}

/**
 * エラーログシートへ1行追記。
 * 機密情報（トークン・シークレット・本文・個人情報）は書かない：
 *   メッセージ・スタックは sanitizeErrorText_、補足情報は scrubForLog_ を通し、
 *   関連IDは送信ID・受付ID・予約ID等の識別子だけにする。
 * ロックは使わない（logError_ はロック取得中から呼ばれることがあるため。appendRow は単独で原子的）。
 */
function recordErrorToSheet_(event, err, detail, opts) {
  opts = opts || {};
  var severity = opts.severity === 'FATAL' || FATAL_EVENTS.indexOf(event) !== -1 ? 'FATAL'
    : (opts.severity === LOG_LEVEL.WARNING || opts.severity === LOG_LEVEL.CONFIG_WARNING ? opts.severity : 'ERROR');
  var message = sanitizeErrorText_(err && err.message ? err.message : String(err)).substring(0, ERROR_LOG.MAX_MESSAGE);
  var dedup = opts.noDedup ? { write: true, suppressed: 0 } : errorDedup_(severity, event, message + (opts.dedupKey ? '|' + opts.dedupKey : ''));
  if (!dedup.write) return false;

  var stack = err && err.stack ? sanitizeErrorText_(err.stack) : '';
  var scrubbed = scrubForLog_(detail || {});
  delete scrubbed.userId; delete scrubbed.lineUserId; delete scrubbed.to;
  var details = [
    'コード: ' + event,
    Object.keys(scrubbed).length ? '補足: ' + sanitizeErrorText_(JSON.stringify(scrubbed)) : '',
    err && err.status ? 'HTTP ステータス: ' + err.status : '',
    dedup.suppressed ? '直前の同一エラー ' + dedup.suppressed + ' 件は重複のため記録を省略' : '',
    stack ? 'スタック:\n' + stack : ''
  ].filter(String).join('\n').substring(0, ERROR_LOG.MAX_DETAIL);

  var sh = ensureErrorLogSheet_().sheet;
  var headers = getHeaders_(sh);
  var values = {
    '発生日時': nowString_(),
    '重要度': severity,
    '発生元': errorSourceOf_(event) + (opts.sourceSuffix ? '（' + opts.sourceSuffix + '）' : ''),
    '関数名': opts.functionName || functionNameFromStack_(err && err.stack) || event,
    'エラーメッセージ': message,
    'エラー詳細・スタックトレース': details,
    '関連ID': relatedIdOf_(detail),
    '対応状況': '未対応',
    'イベント種別': (__trace && __trace.type) || opts.eventType || '',
    '追跡ID': (__trace && __trace.id) || opts.traceId || '',
    '原因コード': opts.cause || causeOf_(event, err),
    '処理結果': opts.result || resultOfSeverity_(severity),
    '関連設定キー': (opts.settingKeys || (err && err.missingKeys) || []).join(', '),
    'HTTPステータス': err && err.status ? Number(err.status) : ''
  };
  sh.appendRow(headers.map(function (h) { return values.hasOwnProperty(h) ? sanitizeCell_(values[h]) : ''; }));
  errorDedupMark_(dedup);
  return true;
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

/* ---------- 原因コード・ログレベル ---------- */

/** LINE API の HTTP エラー → 原因コード */
function lineApiCause_(err) {
  if (!err || !(err instanceof LineApiError)) return '';
  var st = Number(err.status) || 0;
  if (err.network || st === 0) return CAUSE.LINE_API_NETWORK;
  if (st === 400) return /Invalid reply token/i.test(String(err.body || '')) ? CAUSE.LINE_API_INVALID_REPLY_TOKEN : CAUSE.LINE_API_400;
  if (st === 401) return CAUSE.LINE_API_401;
  if (st === 403) return CAUSE.LINE_API_403;
  if (st === 404) return CAUSE.LINE_API_404;
  if (st === 429) return CAUSE.LINE_API_429;
  if (st >= 500) return CAUSE.LINE_API_5XX;
  return CAUSE.LINE_API_HTTP;
}

/** 発生箇所（event）と例外から原因コードを決める（呼び出し側が指定しない場合） */
function causeOf_(event, err) {
  var api = lineApiCause_(err);
  if (api) return api;
  if (err && err instanceof ConfigError) return CAUSE.CONFIG_MISSING;
  var e = String(event || '');
  if (/^config\./.test(e)) return CAUSE.CONFIG_MISSING;
  if (/^reservation/.test(e)) return CAUSE.RESERVATION_FAILED;
  if (/notify/.test(e)) return CAUSE.NOTIFY_FAILED;
  if (/^(inquiry|operator)\./.test(e)) return CAUSE.INQUIRY_FAILED;
  if (/^(webhook|doPost)\./.test(e)) return CAUSE.WEBHOOK_EXCEPTION;
  return CAUSE.INTERNAL_ERROR;
}

function resultOfSeverity_(severity) {
  if (severity === LOG_LEVEL.CONFIG_WARNING) return '設定により停止';
  if (severity === LOG_LEVEL.WARNING) return '要確認';
  return '失敗';
}

/**
 * 障害以外の事象（注意・設定による停止）をエラーログに記録する。実行ログにも出す。例外は投げない。
 * @param {string} level LOG_LEVEL.WARNING / LOG_LEVEL.CONFIG_WARNING
 * @param {string} event 発生箇所コード（例 'operator.auto_reply_suppressed'）
 * @param {string} message 管理者向けの日本語の説明（個人情報・本文を含めない）
 * @param {{cause:string, settingKeys?:string[], detail?:Object, dedupKey?:string, result?:string, functionName?:string}} o
 */
function logIncident_(level, event, message, o) {
  o = o || {};
  try {
    console.warn(JSON.stringify({ level: level, event: event, cause: o.cause, message: message, detail: scrubForLog_(o.detail || {}) }));
  } catch (e) { /* noop */ }
  try {
    recordErrorToSheet_(event, { message: message }, o.detail, { severity: level, cause: o.cause, settingKeys: o.settingKeys,
      dedupKey: o.dedupKey, result: o.result, functionName: o.functionName || event });
  } catch (e) {
    try { console.error('errorlog.write_failed: ' + sanitizeErrorText_(e && e.message)); } catch (e2) { /* noop */ }
  }
}

/** ログに残してよい短い識別用ハッシュ（LINE ユーザーID 等を平文で残さないため。照合用、復元不可） */
function hashForLog_(s) {
  if (!s) return '';
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'skylog|' + String(s), Utilities.Charset.UTF_8);
  return d.slice(0, 6).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

/* ---------- LINE操作ログ（Webhook イベントの追跡） ---------- */

/**
 * 「LINE操作ログ」シート。追記のみ（更新・削除しない）。個人情報・メッセージ本文・LINE ユーザーIDは保存しない。
 * 1イベントにつき「受信 → 開始 → 機能ごとの段階（0〜3行）→ 返信成功／失敗 → 最終結果」の3〜7行（通常4〜5行）を、
 * 終了時にまとめて1回で書き込む（行数の一覧は README「0-2」）。
 * URL を開くタイプのリッチメニューボタン（ご予約はこちら・よくある質問）は LINE から Webhook が来ないため記録されない。
 */
var OPLOG = {
  SHEET: 'LINE操作ログ',
  HEADERS: ['日時', '追跡ID', 'イベント種別', '操作名', '処理結果', '原因コード', '処理時間ms'],
  /** この行数を超えたら診断で「別ファイルへの退避」を案内する（自動削除はしない） */
  WARN_ROWS: 50000,
  RESULT: {
    RECEIVED: '受信', STARTED: '開始', REPLY_OK: '返信成功', REPLY_FAILED: '返信失敗', STOPPED: '設定により停止',
    DONE: '正常終了', NO_REPLY: '返信なし', FAILED: '異常終了', ERROR: '失敗', IGNORED: '対象外'
  }
};

/** 現在処理中のイベントの追跡情報（processLineEvents_ が1イベントごとに作成・破棄する） */
var __trace = null;

/** postback の a= → 操作名（日本語） */
var POSTBACK_OPERATIONS = {
  rsv_start: '予約確認の開始', rsv_cancel: '予約確認の入力取消', rsv_change: '予約変更ボタン', rsv_cancel_req: 'キャンセルボタン',
  inq_start: '問い合わせメニューの開始', inq_cat: '問い合わせ項目の選択', inq_cancel: '問い合わせ入力の取消',
  inq_handoff: '担当者への送信', inq_operator: 'オペレーターに相談', faq: 'FAQ回答', faq_list: 'FAQ一覧', menu_unset: '準備中ボタン'
};

/** イベントの操作名（本文・個人情報を含めない） */
function operationNameOf_(ev) {
  if (!ev) return '';
  if (ev.type === 'postback') {
    var data = String(ev.postback && ev.postback.data || '');
    var a = (data.match(/(?:^|&)a=([^&]*)/) || [])[1] || '';
    var item = (data.match(/(?:^|&)item=([^&]*)/) || [])[1] || '';
    var c = (data.match(/(?:^|&)c=([^&]*)/) || [])[1] || '';
    var name = POSTBACK_OPERATIONS[a];
    if (!name) return 'postback（未対応: ' + String(a).replace(/[^A-Za-z0-9_]/g, '').substring(0, 20) + '）';
    if (a === 'menu_unset' && item) name += '（' + String(item).replace(/[^A-Za-z0-9_]/g, '').substring(0, 20) + '）';
    if (a === 'inq_cat' && c) name += '（c=' + String(c).replace(/[^A-Za-z0-9_]/g, '').substring(0, 4) + '）';
    return 'postback：' + name;
  }
  if (ev.type === 'message') return ev.message && ev.message.type === 'text' ? 'テキスト受信' : 'メッセージ受信（' + String(ev.message && ev.message.type || '') + '）';
  return ev.type;
}

/** イベントの追跡を開始（受信を記録） */
function traceBegin_(ev) {
  var id = ev && ev.webhookEventId ? String(ev.webhookEventId).substring(0, 40) : 'T' + Utilities.getUuid().replace(/-/g, '').substring(0, 16).toUpperCase();
  __trace = { id: id, type: String(ev && ev.type || ''), start: Date.now(), rows: [], replied: false, replyFailed: false,
    stopped: '', cause: '', op: operationNameOf_(ev) };
  traceStage_(__trace.op, OPLOG.RESULT.RECEIVED, '');
  return __trace;
}

/** 処理の段階を記録（開始・設定による停止など）。追跡中でなければ何もしない */
function traceStage_(op, result, cause) {
  if (!__trace) return;
  if (result === OPLOG.RESULT.STOPPED) { __trace.stopped = cause || 'STOPPED'; __trace.cause = cause || ''; }
  if (result === OPLOG.RESULT.ERROR && cause && !__trace.cause) __trace.cause = cause;
  __trace.rows.push([nowString_(), __trace.id, __trace.type, String(op || '').substring(0, 60), result, cause || '', Date.now() - __trace.start]);
}

/** 返信 API の結果（02_LineApi.gs の replyMessage_ から呼ぶ） */
function traceReply_(ok, cause) {
  if (!__trace) return;
  if (ok) __trace.replied = true; else { __trace.replyFailed = true; __trace.cause = cause || ''; }
  traceStage_('LINE 返信 API', ok ? OPLOG.RESULT.REPLY_OK : OPLOG.RESULT.REPLY_FAILED, ok ? '' : cause);
}

/**
 * イベントの追跡を終了し、LINE操作ログに書き込む（書き込み失敗は無視。Webhook 処理を止めない）。
 * @param {Error=} err 処理中の例外
 */
function traceEnd_(err) {
  var t = __trace;
  __trace = null;
  if (!t) return;
  var R = OPLOG.RESULT;
  var result, cause = '';
  if (err) {
    result = R.FAILED;
    cause = lineApiCause_(err) || (err instanceof ConfigError ? CAUSE.CONFIG_MISSING : CAUSE.WEBHOOK_EXCEPTION);
  } else if (t.stopped && !t.replied) {
    result = R.STOPPED; cause = t.cause;
  } else if (t.stopped) {
    result = R.DONE; cause = t.cause; // 一部の処理を設定で止めたが、案内は返信した（例：RESERVATION_CHECK_MODE=OFF）
  } else if (t.type === 'message' || t.type === 'postback' || t.type === 'follow') {
    result = t.replied ? R.DONE : R.NO_REPLY;
    if (!t.replied) cause = t.cause || CAUSE.NO_REPLY;
  } else {
    result = t.type === 'unfollow' ? R.DONE : R.IGNORED;
  }
  t.rows.push([nowString_(), t.id, t.type, t.op, result, cause, Date.now() - t.start]);
  // 返信が必要なイベントに返信していない（設定による停止・例外以外）＝無反応。原因を調べられるようエラーログにも残す
  if (!err && !t.stopped && !t.reported && result === R.NO_REPLY) {
    __trace = t; // エラーログに追跡IDを入れるため一時的に戻す
    logIncident_(LOG_LEVEL.WARNING, 'webhook.no_reply', 'イベントに返信していません（' + t.op + '）。原因コード: ' + cause,
      { cause: cause, dedupKey: cause + '|' + t.op, result: '返信なし', detail: { type: t.type } });
    __trace = null;
  }
  if (!t.skip) writeOpLog_(t.rows);
}

/**
 * LINE操作ログに行を追記（追記のみ）。複数行は1回の書き込みにまとめる。
 * 同時実行で同じ行に書かないよう短時間のロックを使い、取れなければ1行ずつ appendRow する（appendRow は単独で原子的）。
 */
function writeOpLog_(rows) {
  if (!rows || !rows.length) return false;
  try {
    var sh = ensureOpLogSheet_(true).sheet;
    var width = OPLOG.HEADERS.length;
    var values = rows.map(function (r) { return r.slice(0, width).map(sanitizeCell_); });
    var lock = LockService.getScriptLock();
    if (lock.tryLock(3000)) {
      try {
        sh.getRange(sh.getLastRow() + 1, 1, values.length, width).setValues(values);
      } finally {
        lock.releaseLock();
      }
    } else {
      values.forEach(function (v) { sh.appendRow(v); });
    }
    return true;
  } catch (e) {
    try { console.error('oplog.write_failed: ' + sanitizeErrorText_(e && e.message)); } catch (e2) { /* noop */ }
    return false;
  }
}

