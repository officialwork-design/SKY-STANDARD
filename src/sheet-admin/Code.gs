/**
 * SKY STANDARD 管理メニュー（スプレッドシートに紐づく GAS）
 *
 * スプレッドシートを開くと上部メニューに「SKY STANDARD」を表示し、管理操作を実行できるようにする。
 *
 * ■ 仕組み
 *   業務処理は独立 GAS（src/gas、Web アプリ兼ライブラリ）にあり、この GAS は
 *   それをライブラリ「SkyStandard」として読み込み、SkyStandard.adminRun(action, params) を呼ぶだけ。
 *   - 公開 Web アプリへの無認証リクエストで管理操作を行うことはしない
 *   - 実行者が管理者か（ADMIN_USERS）はライブラリ側で毎回確認する
 *   - 通知の送信・却下・再送・リッチメニュー更新の前には確認ダイアログを表示する
 *   - ここには秘密情報を一切置かない（秘密情報は独立 GAS のスクリプトプロパティのみ）
 */

var MENU_NAME = 'SKY STANDARD';
var SEND_LOG_SHEET = '送信ログ';
var ID_SHEET = 'ID管理';
var ERROR_LOG_SHEET = 'エラーログ';
var INQUIRY_SHEET = '問い合わせ管理';

/* ---------- メニュー ---------- */

/** シンプルトリガー：開いたときにメニューを作る（1回の onOpen につき1回だけ作成） */
function onOpen(e) {
  buildMenu_();
}

function buildMenu_() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu(MENU_NAME)
    .addSubMenu(ui.createMenu('初期設定')
      .addItem('シート列・設定行の補完', 'skyMenuSetupSheets')
      .addItem('ID・URL設定チェック', 'skyMenuCheckIds')
      .addItem('LINE接続チェック', 'skyMenuCheckLine')
      .addItem('ID管理の変更を反映（再読込）', 'skyMenuReloadSettings'))
    .addSubMenu(ui.createMenu('LINE管理')
      .addItem('リッチメニュー登録・更新', 'skyMenuRichMenuDeploy')
      .addItem('リッチメニュー設定確認', 'skyMenuRichMenuCheck')
      .addItem('今月の配信数確認', 'skyMenuQuota'))
    .addSubMenu(ui.createMenu('予約・通知')
      .addItem('承認待ち通知を送信（選択中の行）', 'skyMenuApproveSelected')
      .addItem('選択中の通知を却下', 'skyMenuRejectSelected')
      .addItem('失敗した通知を再送', 'skyMenuRetry')
      .addItem('通知テンプレート確認', 'skyMenuTemplates'))
    .addSubMenu(ui.createMenu('お問い合わせ')
      .addItem('オペレーター対応状況', 'skyMenuOperatorStatus')
      .addItem('オペレーター対応を終了（選択中の行）', 'skyMenuOperatorRelease'))
    .addSubMenu(ui.createMenu('システム管理')
      .addItem('トリガー設定', 'skyMenuInstallTriggers')
      .addItem('トリガー状態確認', 'skyMenuTriggerStatus')
      .addItem('接続・設定診断', 'skyMenuDiagnose')
      .addSeparator()
      .addItem('エラーログを開く', 'skyMenuOpenErrorLog')
      .addItem('エラーログ設定・動作確認', 'skyMenuErrorLogCheck'))
    .addToUi();
}

/* ---------- 共通 ---------- */

/** ライブラリ呼び出し（未設定・例外でも必ず結果オブジェクトを返す） */
function call_(action, params) {
  if (typeof SkyStandard === 'undefined' || !SkyStandard || typeof SkyStandard.adminRun !== 'function') {
    return { ok: false, title: 'ライブラリ未設定',
      message: '業務処理のライブラリ「SkyStandard」が読み込まれていません。\n' +
        'README の「スプレッドシート管理メニュー」の手順で、独立GASをライブラリとして追加してください。' };
  }
  try {
    var res = SkyStandard.adminRun(action, params || {});
    return res || { ok: false, title: 'エラー', message: '結果が返りませんでした。' };
  } catch (e) {
    recordLocalError_('call_:' + action, e);
    return { ok: false, title: '実行エラー', message: (e && e.message ? e.message : String(e)) +
      '\n\nライブラリへのアクセス権（開発モードでは独立GASの編集権限が必要）と、初回認証が完了しているか確認してください。' };
  }
}

/** 結果を画面に表示（長文はスクロールできるダイアログ） */
function show_(res) {
  var ui = SpreadsheetApp.getUi();
  var title = (res.ok ? '' : '【要確認】') + (res.title || '結果');
  var msg = String(res.message || '');
  if (msg.length > 600 || msg.split('\n').length > 16) {
    var html = HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all">' +
      escapeHtml_(msg) + '</div>').setWidth(640).setHeight(520);
    ui.showModalDialog(html, title);
  } else {
    ui.alert(title, msg, ui.ButtonSet.OK);
  }
  return res;
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** はい／いいえ確認 */
function confirm_(title, message) {
  var ui = SpreadsheetApp.getUi();
  return ui.alert(title, message, ui.ButtonSet.YES_NO) === ui.Button.YES;
}

function run_(action, params) {
  return show_(call_(action, params));
}

/* ---------- 初期設定 ---------- */

function skyMenuSetupSheets() {
  if (!confirm_('シート列・設定行の補完', '不足している列・設定行・通知テンプレート（有効=OFF）を追加します。\n既存のデータは変更・削除しません。実行しますか？')) return;
  return run_('setupSheets');
}

function skyMenuCheckIds() { return run_('checkIds'); }

function skyMenuCheckLine() {
  var test = confirm_('LINE接続チェック', 'Webhook URL への疎通テストも実行しますか？\n' +
    'LINE から検証リクエストを送り、「LINE 側の判定（HTTP ステータス）」と「GAS 側で受信できたか」を分けて表示します。\n' +
    '「いいえ」の場合は接続確認のみ行います。');
  return run_('checkLine', { testWebhook: test });
}

function skyMenuReloadSettings() { return run_('invalidateCache'); }

/* ---------- LINE 管理 ---------- */

function skyMenuRichMenuDeploy() {
  var check = call_('richMenuCheck');
  if (check.denied) return show_(check);
  if (!confirm_('リッチメニュー登録・更新', String(check.message || '') +
    '\n\nこの内容で全利用者のリッチメニューを更新します。よろしいですか？')) return;
  return run_('richMenuDeploy');
}

function skyMenuRichMenuCheck() { return run_('richMenuCheck'); }

function skyMenuQuota() { return run_('quota'); }

/* ---------- 予約・通知 ---------- */

/** 送信ログで選択中の1行の送信IDを取得（エラー時は表示して null） */
function selectedSendId_() {
  return selectedRowValue_(SEND_LOG_SHEET, '送信ID');
}

/** 指定シートで選択中の1行から、指定列の値を取得（エラー時は表示して null） */
function selectedRowValue_(sheetName, colName) {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== sheetName) {
    show_({ ok: false, title: '行を選択してください', message: '「' + sheetName + '」シートで対象の行を1行だけ選択してから実行してください。' });
    return null;
  }
  var range = sheet.getActiveRange();
  if (!range || range.getNumRows() !== 1) {
    show_({ ok: false, title: '行を選択してください', message: '対象の行を1行だけ選択してください（複数行の一括送信はできません）。' });
    return null;
  }
  var row = range.getRow();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  var col = headers.indexOf(colName);
  if (row < 2 || col === -1) {
    show_({ ok: false, title: '行を選択してください', message: 'データ行（2行目以降）を選択してください。' });
    return null;
  }
  var id = String(sheet.getRange(row, col + 1).getValue() || '').trim();
  if (!id) {
    show_({ ok: false, title: colName + 'がありません', message: '選択した行に' + colName + 'がありません。' });
    return null;
  }
  return id;
}

function skyMenuApproveSelected() {
  var sendId = selectedSendId_();
  if (!sendId) return;
  var info = call_('sendInfo', { sendId: sendId });
  if (!info.ok) return show_(info);
  if (!info.data || !info.data.pending) {
    return show_({ ok: false, title: '承認待ちではありません', message: info.message + '\n\n「承認待ち」の行のみ送信できます。' });
  }
  if (!confirm_('通知を送信します', info.message + '\n\nこの内容を利用者の LINE に送信します。取り消しはできません。送信しますか？')) return;
  return run_('approve', { sendId: sendId });
}

function skyMenuRejectSelected() {
  var sendId = selectedSendId_();
  if (!sendId) return;
  var info = call_('sendInfo', { sendId: sendId });
  if (!info.ok) return show_(info);
  if (!info.data || !info.data.pending) {
    return show_({ ok: false, title: '承認待ちではありません', message: info.message + '\n\n「承認待ち」の行のみ却下できます。' });
  }
  if (!confirm_('通知を却下します', info.message + '\n\nこの通知を送信せずに却下します。よろしいですか？')) return;
  return run_('reject', { sendId: sendId });
}

function skyMenuRetry() {
  var c = call_('retryCount');
  if (!c.ok) return show_(c);
  var n = c.data ? c.data.count : 0;
  if (!n) return show_({ ok: true, title: '再送対象なし', message: '再送が必要な通知（失敗(再試行待ち)・処理中のまま停止）はありません。' });
  if (!confirm_('失敗した通知を再送', n + ' 件の通知を再送します。\n（同じ通知が二重に届かないよう、LINE 側でも重複防止キーを使って送信します）\n実行しますか？')) return;
  return run_('retry');
}

function skyMenuTemplates() { return run_('templates'); }

/* ---------- お問い合わせ（オペレーター対応） ---------- */

function skyMenuOperatorStatus() { return run_('operatorStatus'); }

/**
 * 選択中の問い合わせのオペレーター対応を終了し、自動応答を再開する。
 * 通常は「対応状況」を「対応完了」にするだけでよい（次の受信時に自動で解除）。
 * こちらは行が見つからない等で自動解除されない場合や、すぐに解除したい場合に使う。
 */
function skyMenuOperatorRelease() {
  var id = selectedRowValue_(INQUIRY_SHEET, '受付ID');
  if (!id) return;
  if (!confirm_('オペレーター対応を終了', id + ' のオペレーター対応を終了し、この利用者への自動応答を再開します。\n' +
    '対応状況が「対応完了」でない場合は「対応完了」に更新します（利用者へのメッセージ送信は行いません）。\nよろしいですか？')) return;
  return run_('operatorRelease', { inquiryId: id });
}

/* ---------- システム管理・トリガー ---------- */

/**
 * トリガー設定。
 * 定期処理のトリガーは「独立GAS」に作成する（このスプレッドシートの GAS に作ると、シート編集者が
 * スクリプトを書き換えて管理者の権限で実行できてしまうため）。
 *   1. 管理者確認のうえ、ライブラリに作成要求を記録（adminRun('requestTriggerSync')）
 *   2. 独立GASの Web アプリ（所有者権限）に ?sync=triggers を送り、要求があれば作成させる
 *      （このリクエストには認証情報・秘密情報を含めない。要求がなければ Web アプリは何も作成しない）
 */
function skyMenuInstallTriggers() {
  var who = call_('whoami');
  if (!who.ok) return show_(who);
  if (!confirm_('トリガー設定', '独立GASに次の定期処理を設定します（作成済みのものは作らず、重複は整理します）。\n' +
    '・搭乗前日リマインド（毎日10時台）\n・失敗した通知の再送（10分おき）\n\nよろしいですか？')) return;
  var removed = cleanupLocalTriggers_();
  var req = call_('requestTriggerSync');
  if (!req.ok) return show_(req);
  var url = req.data && req.data.webAppUrl;
  if (!url) {
    return show_({ ok: false, title: 'トリガーを作成できません',
      message: req.message + '\n\nGAS をウェブアプリとしてデプロイし、URL を ID管理シートの GAS_WEBAPP_URL に入力してから再実行してください。' +
        '\n（Web アプリを使わない場合は、独立GASのエディタで関数 installTriggers を1回実行してください）' });
  }
  var synced = null;
  try {
    var res = UrlFetchApp.fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'sync=triggers', { muteHttpExceptions: true, followRedirects: true });
    synced = JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    synced = { ok: false, error: e.message };
  }
  var status = call_('triggerStatus');
  var head = synced && synced.installed ? 'トリガーを設定しました。' :
    'Web アプリからの応答を確認できませんでした（' + ((synced && synced.error) || '不明') + '）。GAS_WEBAPP_URL と Web アプリのデプロイを確認してください。';
  return show_({ ok: !!(synced && synced.installed) && status.ok, title: 'トリガー設定',
    message: head + (removed ? '\nこのスプレッドシートの GAS にあった旧トリガー ' + removed + ' 件を削除しました。' : '') + '\n\n' + status.message });
}

/** 旧版でこのスプレッドシートの GAS に作成したトリガー（自分のもの）を削除 */
function cleanupLocalTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onOpen' || fn.indexOf('skyTrigger') === 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function skyMenuTriggerStatus() { return run_('triggerStatus'); }

function skyMenuDiagnose() { return run_('diagnose'); }

/* ---------- エラーログ ---------- */

/** エラーログシートを開く（なければ作成を案内） */
function skyMenuOpenErrorLog() {
  var sh = SpreadsheetApp.getActive().getSheetByName(ERROR_LOG_SHEET);
  if (!sh) {
    return show_({ ok: false, title: 'エラーログがありません',
      message: '「' + ERROR_LOG_SHEET + '」シートはまだ作成されていません。\n「システム管理 → エラーログ設定・動作確認」を実行すると作成されます。' });
  }
  sh.activate();
  var last = sh.getLastRow();
  if (last > 1) sh.setActiveRange(sh.getRange(last, 1));
}

/** エラーログの設定確認（シート作成・書式）と、任意でテストエラーを1件記録 */
function skyMenuErrorLogCheck() {
  var st = call_('errorLogStatus');
  if (!st.ok) return show_(st);
  show_(st);
  if (!confirm_('動作確認', '動作確認用のテストエラーを1件、「' + ERROR_LOG_SHEET + '」シートに記録しますか？\n（重要度 ERROR・発生元「管理メニュー（動作確認）」として記録されます）')) return;
  var r = call_('errorLogTest');
  show_(r);
  if (r.ok) skyMenuOpenErrorLog();
}

/**
 * ライブラリ（本体GAS）自体を呼び出せなかった場合のエラーを、このスプレッドシートのエラーログに直接記録する。
 * （ライブラリ側の logError_ が使えないため。シートがなければ作成せず、記録失敗は無視）
 */
function recordLocalError_(where, e) {
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(ERROR_LOG_SHEET);
    if (!sh) return;
    var msg = String(e && e.message ? e.message : e)
      .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [REDACTED]')
      .replace(/[UCR][0-9a-f]{32}/g, '[LINE_ID]')
      .replace(/([?&](?:token|id_token|access_token|key|code|lineUserId)=)[^&\s"']+/gi, '$1[REDACTED]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
      .replace(/(?<![\w-])(\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}(?![\w-])/g, '[PHONE]')
      .substring(0, 500);
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var v = {
      '発生日時': Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
      '重要度': 'ERROR', '発生元': '管理メニュー（ライブラリ呼び出し）', '関数名': where,
      'エラーメッセージ': msg, 'エラー詳細・スタックトレース': 'ライブラリ SkyStandard の呼び出しに失敗（権限・ライブラリ設定・初回認証を確認）',
      '関連ID': '', '対応状況': '未対応'
    };
    sh.appendRow(headers.map(function (h) { var x = v.hasOwnProperty(h) ? v[h] : ''; return /^[=+\-@]/.test(x) ? "'" + x : x; }));
  } catch (err) { /* 記録失敗は無視 */ }
}

/* ---------- 編集検知（シンプルトリガー） ---------- */

/**
 * ID管理シートが編集されたら、独立GASの設定キャッシュを破棄する（次の処理から新しい値を使う）。
 * シンプルトリガーのため編集した本人の権限で動き、管理者権限は使わない。
 * 失敗してもキャッシュは最大5分で自動更新される。
 */
function onEdit(e) {
  try {
    var sheet = e && e.range ? e.range.getSheet() : null;
    if (!sheet || sheet.getName() !== ID_SHEET) return;
    if (typeof SkyStandard !== 'undefined' && SkyStandard.invalidateIdCacheFromEdit) SkyStandard.invalidateIdCacheFromEdit();
  } catch (err) {
    // シンプルトリガーで実行できない場合は無視（「ID管理の変更を反映」または5分後に反映）
  }
}
