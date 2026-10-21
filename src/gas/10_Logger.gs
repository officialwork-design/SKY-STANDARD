/**
 * 10_Logger.gs
 * イベント・送信結果・エラーのログ。
 * エラー（logError_）だけを「エラーログ」シートにも記録する（INFO / WARN は実行ログのみ）。
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
  HEADERS: ['発生日時', '重要度', '発生元', '関数名', 'エラーメッセージ', 'エラー詳細・スタックトレース', '関連ID', '対応状況'],
  STATUSES: ['未対応', '対応中', '対応済み', '対象外'],
  /** 同一エラーの記録抑制時間（秒） */
  DEDUP_SEC: { ERROR: 600, FATAL: 60 },
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
    return !(vals.length && /^=\$[A-Z]+2="(FATAL|ERROR)"$/.test(String(vals[0])));
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + colLetter + '2="FATAL"')
    .setBackground('#F8D7DA').setFontColor('#842029').setRanges([rowRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + colLetter + '2="ERROR"')
    .setBackground('#FFF3CD').setFontColor('#664D03').setRanges([rowRange]).build());
  sh.setConditionalFormatRules(rules);

  var statusCol = headers.indexOf('対応状況') + 1;
  if (statusCol > 0) {
    var sl = columnLetter_(statusCol);
    sh.getRange(sl + '2:' + sl).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ERROR_LOG.STATUSES, true).setAllowInvalid(true).build());
  }
  var widths = { '発生日時': 150, '重要度': 70, '発生元': 170, '関数名': 160, 'エラーメッセージ': 320, 'エラー詳細・スタックトレース': 420, '関連ID': 160, '対応状況': 90 };
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
  var severity = opts.severity === 'FATAL' || FATAL_EVENTS.indexOf(event) !== -1 ? 'FATAL' : 'ERROR';
  var message = sanitizeErrorText_(err && err.message ? err.message : String(err)).substring(0, ERROR_LOG.MAX_MESSAGE);
  var dedup = opts.noDedup ? { write: true, suppressed: 0 } : errorDedup_(severity, event, message);
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
    '対応状況': '未対応'
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
