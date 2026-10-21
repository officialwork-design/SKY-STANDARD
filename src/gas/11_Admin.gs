/**
 * 11_Admin.gs
 * 管理者通知・運用補助関数・スプレッドシートのカスタムメニュー。
 */

/**
 * 運営への通知。LINE（管理者通知先）とメール（ADMIN_EMAIL）のうち設定済みのものへ送る。
 * 通知失敗で本処理を止めないよう、例外は投げない。
 */
function notifyAdmin_(subject, body) {
  var sent = false;
  var targets = String(getSetting_(SETTING_KEYS.ADMIN_TARGET) || '').split(/[,\s、]+/).filter(function (t) {
    return /^[UCR][0-9a-f]{32}$/.test(t);
  });
  targets.forEach(function (to) {
    try {
      pushMessage_(to, String(body).substring(0, 4900));
      sent = true;
    } catch (e) {
      logError_('admin.notify_line_failed', e, { to: to });
    }
  });
  var email = getProp_(PROP_KEYS.ADMIN_EMAIL);
  if (email) {
    try {
      MailApp.sendEmail({ to: email, subject: '[' + APP.NAME + '] ' + subject, body: body });
      sent = true;
    } catch (e) {
      logError_('admin.notify_mail_failed', e);
    }
  }
  if (!sent) logWarn_('admin.notify_unconfigured', { subject: subject });
  return sent;
}

/* ---------- カスタムメニュー ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('SKY STANDARD')
    .addItem('設定チェック', 'menuCheckConfig')
    .addItem('シート列・設定行の補完（既存データは変更しません）', 'menuSetupSheets')
    .addSeparator()
    .addItem('選択中の通知を承認して送信（送信ログ）', 'menuApproveSelected')
    .addItem('選択中の通知を却下（送信ログ）', 'menuRejectSelected')
    .addItem('再試行待ちの通知を今すぐ再送', 'retryFailedSends')
    .addSeparator()
    .addItem('リッチメニューを登録・更新', 'menuDeployRichMenu')
    .addItem('トリガーを設定（リマインド・再送）', 'installTriggers')
    .addItem('今月の配信数を確認', 'menuShowQuota')
    .addToUi();
}

function alert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

function menuCheckConfig() {
  var r = checkConfig_();
  if (r.ok) return alert_('必要な設定はすべて入力済みです。');
  var lines = Object.keys(r.missing).map(function (g) { return '■ ' + g + '\n  - ' + r.missing[g].join('\n  - '); });
  alert_('未設定の項目があります（該当機能は安全に停止します）。\n\n' + lines.join('\n\n'));
}

/**
 * 既存データを保持したまま不足分だけ補完する。
 *  - 各シートの不足列を末尾に追加
 *  - 「LINE設定」に不足している設定キー行を追加（値は空）
 *  - 「通知テンプレート」に不足しているテンプレートを 有効=OFF で追加
 */
function setupSheets() {
  return withLock_(function () {
    var report = { columns: {}, settings: [], templates: [] };
    Object.keys(REQUIRED_COLUMNS).forEach(function (name) {
      var added = ensureColumns_(name, REQUIRED_COLUMNS[name]);
      if (added.length) report.columns[name] = added;
    });
    var existingKeys = readRows_(SHEETS.SETTINGS).map(function (r) { return String(r['設定キー']).trim(); });
    Object.keys(SETTING_KEYS).forEach(function (k) {
      var def = SETTING_KEYS[k];
      if (existingKeys.indexOf(def.key) === -1) {
        appendRow_(SHEETS.SETTINGS, { '設定キー': def.key, '設定値': '', '説明': def.desc });
        report.settings.push(def.key);
      }
    });
    var tplIds = readRows_(SHEETS.TEMPLATES).map(function (r) { return String(r['テンプレートID']); });
    DEFAULT_TEMPLATES.forEach(function (t) {
      if (tplIds.indexOf(t.id) === -1) {
        appendRow_(SHEETS.TEMPLATES, { 'テンプレートID': t.id, '用途': t.use, '送信タイミング': t.timing, '本文': t.body,
          '有効': 'OFF', '備考': '自動追加。文面確認後に ON にしてください' });
        report.templates.push(t.id);
      }
    });
    __settingsCache = null;
    return report;
  });
}

function menuSetupSheets() {
  var r = setupSheets();
  alert_('補完が完了しました。\n\n追加した列: ' + JSON.stringify(r.columns) +
    '\n追加した設定行: ' + (r.settings.join(', ') || 'なし') +
    '\n追加したテンプレート(OFF): ' + (r.templates.join(', ') || 'なし'));
}

/** 送信ログで選択中の行の送信IDを取得 */
function selectedSendId_() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.SEND_LOG) throw new Error('「送信ログ」シートで対象の行を選択してください');
  var row = sh.getActiveRange().getRow();
  if (row < 2) throw new Error('データ行を選択してください');
  var headers = getHeaders_(sh);
  return String(sh.getRange(row, headers.indexOf('送信ID') + 1).getValue());
}

function menuApproveSelected() {
  try {
    var sendId = selectedSendId_();
    var ui = SpreadsheetApp.getUi();
    if (ui.alert('送信ID ' + sendId + ' の運航案内を利用者へ送信します。よろしいですか？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    var r = approvePendingNotification_(sendId, Session.getActiveUser().getEmail());
    alert_('結果: ' + r.result);
  } catch (e) {
    alert_('承認できませんでした: ' + e.message);
  }
}

function menuRejectSelected() {
  try {
    var sendId = selectedSendId_();
    rejectPendingNotification_(sendId);
    alert_('却下しました: ' + sendId);
  } catch (e) {
    alert_('却下できませんでした: ' + e.message);
  }
}

function menuDeployRichMenu() {
  try {
    var r = deployRichMenu();
    alert_('リッチメニューを登録しました。\n' + (r.unset.length ? 'URL未設定（準備中表示）: ' + r.unset.join(', ') : 'すべてのボタンが設定済みです。'));
  } catch (e) {
    alert_('リッチメニューを登録できませんでした: ' + e.message);
  }
}

function menuShowQuota() {
  try {
    var q = getMessageQuota_();
    alert_('今月の配信数: ' + q.used + (q.type === 'limited' ? ' / 上限 ' + q.limit : '（上限なし）'));
  } catch (e) {
    alert_('取得できませんでした: ' + e.message);
  }
}

/** 時間主導トリガーを設定（重複作成しない） */
function installTriggers() {
  var existing = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (existing.indexOf('sendFlightReminders') === -1) {
    ScriptApp.newTrigger('sendFlightReminders').timeBased().atHour(10).everyDays(1).inTimezone(APP.TIMEZONE).create();
  }
  if (existing.indexOf('retryFailedSends') === -1) {
    ScriptApp.newTrigger('retryFailedSends').timeBased().everyMinutes(10).create();
  }
  alert_('トリガーを設定しました（搭乗前日リマインド: 毎日10時台 / 再送: 10分おき）。');
}
