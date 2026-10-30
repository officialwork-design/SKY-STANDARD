/**
 * 09_Spreadsheet.gs
 * スプレッドシート読み書きの共通処理。
 *
 * 方針:
 *  - 列はヘッダー名で参照する（列位置に依存しない）。
 *  - 既存シート・既存データは削除／初期化しない。
 *  - 不足列は末尾へ追加のみ行う（ensureColumns_）。
 *  - 書き込みはスクリプトロック内で行う（withLock_）。
 */

var __ss = null;

/**
 * 対象スプレッドシートを取得。
 *   1. スクリプトプロパティ SPREADSHEET_ID（起動用。独立 GAS の Web アプリ・トリガーはこれが必須）
 *   2. 管理メニュー（ライブラリ呼び出し）からの実行時は呼び出し元のスプレッドシート
 * 「ID管理」シートの SPREADSHEET_ID は確認用の写しで、起動には使わない（自己参照になるため）。
 */
function getSpreadsheet_() {
  if (__ss) return __ss;
  var id = getProp_(PROP_KEYS.SPREADSHEET_ID);
  if (id) {
    __ss = SpreadsheetApp.openById(id);
  } else {
    try { __ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { __ss = null; }
  }
  if (!__ss) {
    throw new ConfigError('スプレッドシートを特定できません。独立GASのスクリプトプロパティに SPREADSHEET_ID を設定してください' +
      '（管理メニュー「初期設定 → シート列・設定行の補完」でも自動設定できます）。', [PROP_KEYS.SPREADSHEET_ID]);
  }
  return __ss;
}

/**
 * 「ID管理」シート（A列: 設定キー / B列: 設定値）を {キー: 値} で読む。
 * 「LINE設定」シートとは別物で、公開可能な ID・URL の参照先はこちらに統一している。
 */
function readIdSheet_() {
  var map = {};
  readRows_(SHEETS.ID_MANAGEMENT).forEach(function (r) {
    var k = String(r['設定キー'] || '').trim();
    if (k) map[k] = String(r['設定値'] == null ? '' : r['設定値']).trim();
  });
  return map;
}

/** シート取得。存在しなければエラー（勝手に作成しない） */
function getSheet_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
}

/** ヘッダー行（1行目）を配列で取得 */
function getHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/**
 * 不足列を末尾に追加する（既存列・データは変更しない）。
 * @return {string[]} 追加した列名
 */
function ensureColumns_(sheetName, required) {
  var sh = getSheet_(sheetName);
  var headers = getHeaders_(sh);
  var added = [];
  required.forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      headers.push(col);
      added.push(col);
      sh.getRange(1, headers.length).setValue(col);
    }
  });
  return added;
}

/** 全行をヘッダー名キーのオブジェクト配列で取得（__row に行番号を付与） */
function readRows_(sheetName) {
  var sh = getSheet_(sheetName);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var empty = row.every(function (v) { return v === '' || v === null; });
    if (empty) continue;
    var obj = { __row: i + 1 };
    headers.forEach(function (h, j) { if (h) obj[h] = row[j]; });
    out.push(obj);
  }
  return out;
}

/** 実行内で1回だけ、REQUIRED_COLUMNS の不足列を補完する（書き込み前に自動実行） */
var __ensuredSheets = {};
function ensureColumnsOnce_(sheetName) {
  if (__ensuredSheets[sheetName] || !REQUIRED_COLUMNS[sheetName]) return;
  var added = ensureColumns_(sheetName, REQUIRED_COLUMNS[sheetName]);
  if (added.length) logInfo_('sheet.columns_added', { sheet: sheetName, columns: added.join(',') });
  __ensuredSheets[sheetName] = true;
}

/** オブジェクトを1行追記（存在しない列名のキーは無視） */
function appendRow_(sheetName, obj) {
  ensureColumnsOnce_(sheetName);
  var sh = getSheet_(sheetName);
  var headers = getHeaders_(sh);
  var row = headers.map(function (h) { return obj.hasOwnProperty(h) ? cellValue_(h, obj[h]) : ''; });
  sh.appendRow(row);
  return sh.getLastRow();
}

/** 指定行の指定列のみ更新（他列は保持） */
function updateRow_(sheetName, rowNumber, patch) {
  ensureColumnsOnce_(sheetName);
  var sh = getSheet_(sheetName);
  var headers = getHeaders_(sh);
  Object.keys(patch).forEach(function (k) {
    var idx = headers.indexOf(k);
    if (idx >= 0) sh.getRange(rowNumber, idx + 1).setValue(cellValue_(k, patch[k]));
  });
}

/** キー列の値で1行検索 */
function findRow_(sheetName, keyCol, keyValue) {
  if (keyValue === '' || keyValue == null) return null;
  var rows = readRows_(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) === String(keyValue)) return rows[i];
  }
  return null;
}

/** キー列で upsert。新規なら追記、既存なら patch のみ更新 */
function upsertRow_(sheetName, keyCol, obj) {
  var existing = findRow_(sheetName, keyCol, obj[keyCol]);
  if (existing) {
    updateRow_(sheetName, existing.__row, obj);
    return { created: false, row: existing.__row };
  }
  return { created: true, row: appendRow_(sheetName, obj) };
}

/**
 * スプレッドシートの自動変換（"00123"→123、"10:00"→時刻、"2026-12-01"→日付）を防ぐため、
 * 文字列として保存する列。先頭に ' を付けて書き込む（表示・getValues では ' は付かない）。
 */
var TEXT_COLUMNS = ['予約ID', 'LINEユーザーID', 'プランID', '時間帯', '搭乗日', '受付ID', '送信ID', '冪等キー', 'イベントID', 'LINEイベントID',
  '電話番号', 'FAQ ID', 'テンプレートID', '最終イベント日時'];

/** 列に応じて書き込み値を整える */
function cellValue_(col, v) {
  if (TEXT_COLUMNS.indexOf(col) !== -1 && typeof v === 'string' && v !== '' && v.charAt(0) !== "'") return "'" + v;
  return sanitizeCell_(v);
}

/**
 * 数式インジェクション対策：利用者入力が = + - @ で始まる場合は先頭に ' を付与。
 * 数値・日付はそのまま。
 */
function sanitizeCell_(v) {
  if (v == null) return '';
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** スクリプトロック内で処理（同時実行対策） */
function withLock_(fn, timeoutMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || 20000)) throw new Error('ロックを取得できませんでした（同時実行が集中しています）');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** スプレッドシートのタイムゾーン（日付セルの解釈に使用） */
function sheetTimeZone_() {
  try { return getSpreadsheet_().getSpreadsheetTimeZone() || APP.TIMEZONE; } catch (e) { return APP.TIMEZONE; }
}

/** セル値（Date の可能性あり）を文字列に。日付/時刻セルはスプレッドシートのタイムゾーンで整形 */
function cellToString_(v, pattern) {
  if (v instanceof Date) return Utilities.formatDate(v, sheetTimeZone_(), pattern);
  return v == null ? '' : String(v);
}

/** 日時を Asia/Tokyo の文字列に */
function nowString_() {
  return Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

/** 接頭辞付き連番 ID（例 INQ-20261021-0001）。ロック内で呼ぶこと */
function nextId_(prefix, sheetName, idCol) {
  var day = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd');
  var head = prefix + '-' + day + '-';
  var max = 0;
  readRows_(sheetName).forEach(function (r) {
    var id = String(r[idCol] || '');
    if (id.indexOf(head) === 0) {
      var n = parseInt(id.substring(head.length), 10);
      if (n > max) max = n;
    }
  });
  return head + ('000' + (max + 1)).slice(-4);
}
