/**
 * テスト環境専用（本番の GAS には入れない）。
 *
 * テスト用 GAS プロジェクト（本番とは別のプロジェクト）に、src/gas の全ファイルと一緒に入れて使う。
 * tools/test-env/build.js が build/test-env/ にまとめて出力する。
 *
 * 安全のため、次の場合は何もせずに止まる：
 *   - このプロジェクトが本番 GAS（スクリプトID）である
 *   - 接続先スプレッドシートが本番のスプレッドシートである
 *   - LINE のチャネルアクセストークンが本番の公式アカウント（@686mdyho）のものである
 *
 * エディタの「実行」から、上から順に実行する：
 *   testSetup            … テスト用スプレッドシートの作成・初期設定（本番シートは読むだけ）
 *   testMakeRichMenuImage… リッチメニュー画像の確認（1MB 超の PNG の場合だけ JPEG を別名で作成。元画像は変更しない）
 *   testCheck            … 設定・LINE 接続・リッチメニュー定義の確認（LINE には登録しない）
 *   testDeployRichMenu   … テスト用チャネルにリッチメニューを登録
 *   testSeedReservations … 予約確認のテスト用予約（ダミー）を登録
 *   testStatus           … 問い合わせ・有人対応・エラーログの状態を表示
 *   testResumeAutoReply  … 最新の有人対応を終了（自動返信有効=TRUE）
 *   testClearSiteUrls    … BOOKING_SITE_URL・FAQ_PAGE_URL を空欄にする（「準備中」案内の確認用。再登録が必要）
 *   testDiagnose         … LINEシステム診断（読み取り専用。LINE には GET のみ。メッセージは送らない）
 */

var TEST_ENV = {
  PROD_SCRIPT_ID: '1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff',
  PROD_SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es',
  PROD_BASIC_ID: '@686mdyho',
  /** リッチメニュー画像（本番に登録済みの「SKY_STANDARD_LINE_2500x1686.jpg」）。変更しない */
  ORIGINAL_IMAGE_ID: '140_OGMEvGkWCUvlP3nbyfGUgx1c2hktA',
  /** テストサイト（予約・FAQ の両方。テスト環境の ID管理 にだけ設定する） */
  TEST_SITE_URL: 'https://sky-standard-test-677788669305.asia-northeast1.run.app/',
  SPREADSHEET_NAME: '【テスト】SKY STANDARD 公式LINE',
  /** 他人の予約として登録するダミーの LINE ユーザーID（実在しない） */
  OTHER_USER_ID: 'U00000000000000000000000000000000'
};

/* ---------- 安全確認 ---------- */

function testGuard_(opts) {
  opts = opts || {};
  if (ScriptApp.getScriptId() === TEST_ENV.PROD_SCRIPT_ID) {
    throw new Error('本番の GAS プロジェクトでは実行できません（テスト用プロジェクトで実行してください）。');
  }
  var ssId = getProp_(PROP_KEYS.SPREADSHEET_ID);
  if (ssId === TEST_ENV.PROD_SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID が本番のスプレッドシートです。テスト用プロジェクトでは testSetup で作成したスプレッドシートを使ってください。');
  }
  if (opts.needSheet && !ssId) throw new Error('先に testSetup を実行してください。');
  if (opts.needLine) {
    if (!getProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN)) {
      throw new Error('スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN（テスト用チャネル）を設定してください。');
    }
    var info = lineFetch_('get', '/v2/bot/info').body;
    if (String(info.basicId) === TEST_ENV.PROD_BASIC_ID) {
      throw new Error('このトークンは本番の公式アカウント（' + TEST_ENV.PROD_BASIC_ID + '）のものです。テスト用チャネルのトークンに替えてください。');
    }
    return info;
  }
  return null;
}

function testOut_(title, lines) {
  var text = '■ ' + title + '\n' + [].concat(lines).join('\n');
  Logger.log(text);
  return text;
}

/* ---------- 1. テスト用スプレッドシート ---------- */

/**
 * テスト用スプレッドシートを作成し、スクリプトプロパティを設定する（2回目以降は作成済みのものを使う）。
 * 通知テンプレートと FAQ は本番シートから読み取ってコピーする（本番シートは変更しない。顧客・予約・問い合わせはコピーしない）。
 */
function testSetup() {
  testGuard_();
  var props = PropertiesService.getScriptProperties();
  var email = Session.getEffectiveUser().getEmail();
  var lines = [];
  var ss = null;
  var id = getProp_(PROP_KEYS.SPREADSHEET_ID);
  if (id) {
    try { ss = SpreadsheetApp.openById(id); lines.push('既存のテスト用スプレッドシートを使います'); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(TEST_ENV.SPREADSHEET_NAME);
    var first = ss.getSheets()[0];
    first.setName(SHEETS.INTRO);
    first.getRange(1, 1).setValue('公式LINE テスト環境（テスト用チャネル専用）。本番のデータではありません。');
    Object.keys(SHEETS).forEach(function (k) {
      var name = SHEETS[k];
      if (ss.getSheetByName(name)) return;
      var sh = ss.insertSheet(name);
      var cols = REQUIRED_COLUMNS[name];
      if (cols) sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
    });
    props.setProperty(PROP_KEYS.SPREADSHEET_ID, ss.getId());
    __ss = null;
    lines.push('テスト用スプレッドシートを作成しました');
    var copied = testCopyFromProduction_(ss);
    lines.push('本番シートから読み取ってコピー：通知テンプレート ' + copied.templates + ' 件／FAQ ' + copied.faq + ' 件');
  }
  if (!getProp_(PROP_KEYS.WEBHOOK_MODE)) props.setProperty(PROP_KEYS.WEBHOOK_MODE, 'direct');
  if (!getProp_(PROP_KEYS.ADMIN_USERS)) props.setProperty(PROP_KEYS.ADMIN_USERS, email);
  if (!getProp_(PROP_KEYS.ADMIN_EMAIL)) props.setProperty(PROP_KEYS.ADMIN_EMAIL, email);
  var r = setupSheets_();
  testSetId_('SPREADSHEET_ID', ss.getId());
  testSetId_('GAS_SCRIPT_ID', ScriptApp.getScriptId());
  // テスト環境の値（本番の ID管理 には書かない）
  if (!getIdRaw_(ID_KEYS.BOOKING_SITE_URL)) testSetId_('BOOKING_SITE_URL', TEST_ENV.TEST_SITE_URL);
  if (!getIdRaw_(ID_KEYS.FAQ_PAGE_URL)) testSetId_('FAQ_PAGE_URL', TEST_ENV.TEST_SITE_URL);
  if (!getIdRaw_(ID_KEYS.RESERVATION_CHECK_MODE)) testSetId_('RESERVATION_CHECK_MODE', 'LINE_LINKED');
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  if (/\/exec$/.test(url)) testSetId_('GAS_WEBAPP_URL', url);
  lines.push('ID管理に追加した設定キー：' + (r.idKeys.length ? r.idKeys.length + ' 件' : 'なし'));
  lines.push('WEBHOOK_MODE=' + getProp_(PROP_KEYS.WEBHOOK_MODE) + ' / ADMIN_USERS・ADMIN_EMAIL=' + email + '（運営通知はこのメールに届きます）');
  lines.push('GAS_WEBAPP_URL：' + (getSetting_(ID_KEYS.GAS_WEBAPP_URL) || '未設定（ウェブアプリをデプロイ後にもう一度 testSetup を実行）'));
  lines.push('BOOKING_SITE_URL・FAQ_PAGE_URL：' + (getUrlSetting_(ID_KEYS.BOOKING_SITE_URL) || '空欄') + ' ／ ' + (getUrlSetting_(ID_KEYS.FAQ_PAGE_URL) || '空欄'));
  lines.push('RESERVATION_CHECK_MODE：' + reservationCheckMode_() + '（テスト環境では LINE アカウント紐づけ照合を有効化）');
  lines.push('スプレッドシート：' + ss.getUrl());
  return testOut_('testSetup', lines);
}

/** 本番の「通知テンプレート」「FAQ」を読み取り、テスト用シートに書き込む（本番は読み取りのみ） */
function testCopyFromProduction_(ss) {
  var count = { templates: 0, faq: 0 };
  var prod;
  try { prod = SpreadsheetApp.openById(TEST_ENV.PROD_SPREADSHEET_ID); } catch (e) { return count; }
  [[SHEETS.TEMPLATES, 'templates'], [SHEETS.FAQ, 'faq']].forEach(function (pair) {
    var src = prod.getSheetByName(pair[0]);
    var dst = ss.getSheetByName(pair[0]);
    if (!src || !dst || src.getLastRow() < 2) return;
    var values = src.getRange(1, 1, src.getLastRow(), src.getLastColumn()).getValues();
    var head = values[0].map(String);
    var cols = REQUIRED_COLUMNS[pair[0]];
    var out = values.slice(1).filter(function (row) { return row.join('') !== ''; }).map(function (row) {
      return cols.map(function (c) { var i = head.indexOf(c); return i === -1 ? '' : row[i]; });
    });
    if (out.length) dst.getRange(2, 1, out.length, cols.length).setValues(out);
    count[pair[1]] = out.length;
  });
  return count;
}

/** テスト用シートの ID管理 に値を書く（行がなければ追加） */
function testSetId_(key, value) {
  testGuard_({ needSheet: true });
  var row = findRow_(SHEETS.ID_MANAGEMENT, '設定キー', key);
  if (row) updateRow_(SHEETS.ID_MANAGEMENT, row.__row, { '設定値': value });
  else appendRow_(SHEETS.ID_MANAGEMENT, { '設定キー': key, '設定値': value, '分類': 'ID', '保存先・取扱い': 'シート', '説明': 'テスト環境' });
  invalidateIdCache_();
}

/* ---------- 2. リッチメニュー画像 ---------- */

/**
 * リッチメニュー画像（ORIGINAL_IMAGE_ID）を確認し、テスト用 ID管理 の RICHMENU_IMAGE_FILE_ID に設定する。
 *   - PNG / JPEG・1MB 以下・2500×1686 ならそのまま使う
 *   - 1MB を超える PNG の場合だけ、同じ絵柄・同じサイズの JPEG を同じフォルダに別名（〜_LINE用.jpg）で作る
 * 元画像は変更しない（実行前後でサイズ・更新日時・ハッシュを比較して確認する）。
 */
function testMakeRichMenuImage() {
  testGuard_({ needSheet: true });
  var src = DriveApp.getFileById(TEST_ENV.ORIGINAL_IMAGE_ID);
  var before = testFileFingerprint_(src);
  var lines = ['元画像：' + src.getName() + '（' + Math.round(before.bytes / 1024) + 'KB、' + before.type + ' ' + before.width + '×' + before.height + '）'];
  var okSize = before.width === RICHMENU_SIZE.width && before.height === RICHMENU_SIZE.height;
  var file = src;
  if (okSize && before.bytes <= 1024 * 1024 && (before.type === 'image/jpeg' || before.type === 'image/png')) {
    lines.push('【OK】1MB 以下・' + RICHMENU_SIZE.width + '×' + RICHMENU_SIZE.height + ' のため、そのまま使います');
  } else if (okSize && before.type === 'image/png') {
    var folder = src.getParents().hasNext() ? src.getParents().next() : DriveApp.getRootFolder();
    var name = src.getName().replace(/\.[^.]+$/, '') + '_LINE用.jpg';
    var existing = folder.getFilesByName(name);
    if (existing.hasNext()) {
      file = existing.next();
      lines.push('同名の JPEG が既にあるため、作り直さずに使います：' + name);
    } else {
      var jpg = src.getBlob().getAs('image/jpeg').setName(name);
      var jb = jpg.getBytes();
      var js = imageSizeOf_(jb);
      if (!js || js.width !== RICHMENU_SIZE.width || js.height !== RICHMENU_SIZE.height || jb.length > 1024 * 1024) {
        return testOut_('testMakeRichMenuImage（NG：作成しませんでした）', lines.concat([
          'JPEG 変換結果：' + Math.round(jb.length / 1024) + 'KB、' + (js ? js.width + '×' + js.height : 'サイズ不明'),
          '1MB 以下・' + RICHMENU_SIZE.width + '×' + RICHMENU_SIZE.height + ' にできないため、ドライブには保存していません。']));
      }
      file = folder.createFile(jpg);
      lines.push('JPEG を作成しました：' + name + '（フォルダ ' + folder.getName() + '）');
    }
  } else {
    return testOut_('testMakeRichMenuImage（NG）', lines.concat(['画像サイズが ' + RICHMENU_SIZE.width + '×' + RICHMENU_SIZE.height + ' ではありません。']));
  }
  var fp = testFileFingerprint_(file);
  var ok = (fp.type === 'image/jpeg' || fp.type === 'image/png') && fp.width === RICHMENU_SIZE.width && fp.height === RICHMENU_SIZE.height && fp.bytes <= 1024 * 1024;
  lines.push((ok ? '【OK】' : '【NG】') + file.getName() + '：' + Math.round(fp.bytes / 1024) + 'KB、' + fp.type + ' ' + fp.width + '×' + fp.height + '、ファイルID ' + file.getId());
  var after = testFileFingerprint_(DriveApp.getFileById(TEST_ENV.ORIGINAL_IMAGE_ID));
  var same = before.bytes === after.bytes && before.updated === after.updated && before.md5 === after.md5;
  lines.push((same ? '【OK】元画像は変更されていません' : '【NG】元画像の内容・更新日時が変わっています（要確認）') + '（MD5 ' + after.md5 + '）');
  if (ok) {
    testSetId_('RICHMENU_IMAGE_FILE_ID', file.getId());
    lines.push('テスト用 ID管理 の RICHMENU_IMAGE_FILE_ID に設定しました（本番の ID管理 は変更していません）');
  }
  return testOut_('testMakeRichMenuImage', lines);
}

function testFileFingerprint_(file) {
  var bytes = file.getBlob().getBytes();
  var size = imageSizeOf_(bytes) || {};
  var md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes).map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
  return { bytes: bytes.length, type: size.type || '', width: size.width, height: size.height, updated: file.getLastUpdated().getTime(), md5: md5 };
}

/* ---------- 3. 確認・登録 ---------- */

/** 設定・LINE 接続・リッチメニュー定義を確認する（LINE には何も登録しない） */
function testCheck() {
  var info = testGuard_({ needSheet: true, needLine: true });
  var lines = ['テスト用チャネル：' + (info.displayName || '-') + '（' + (info.basicId || '-') + '）'];
  ['checkIds', 'checkLine', 'richMenuCheck'].forEach(function (a) {
    var r = adminRun(a, a === 'checkLine' ? { testWebhook: true } : {});
    lines.push('', '— ' + r.title + (r.ok ? '' : '（要確認）') + ' —', r.message);
  });
  var def = buildRichMenuDefinition_().definition;
  lines.push('', '— 登録するリッチメニューの領域 —');
  def.areas.forEach(function (a) {
    var b = a.bounds, act = a.action;
    lines.push('  x' + b.x + ' y' + b.y + ' ' + b.width + '×' + b.height + ' → ' + act.type + ' ' + (act.uri || act.data || act.text || ''));
  });
  return testOut_('testCheck', lines);
}

/** テスト用チャネルにリッチメニューを登録する（本番の公式アカウントでは止まる） */
function testDeployRichMenu() {
  var info = testGuard_({ needSheet: true, needLine: true });
  var r = adminRun('richMenuDeploy');
  return testOut_('testDeployRichMenu（' + info.basicId + '）', [r.title, r.message]);
}

/* ---------- 4. 予約確認のテストデータ ---------- */

/**
 * 予約確認のテスト用に、ダミーの予約を「予約管理」（テスト用シート）に登録する。
 * テスト用アカウントを友だち追加した後に実行する（顧客管理の最新の友だちを本人として使う）。
 *   A：本人・予約確定（表示 → 変更・キャンセル・オペレーター）
 *   B：本人・キャンセル済み（表示されるが変更・キャンセルは不可の案内）
 *   C：他人の予約（本人には表示されない → オペレーター案内）
 */
function testSeedReservations() {
  testGuard_({ needSheet: true });
  var friends = readRows_(SHEETS.CUSTOMERS).filter(function (r) { return String(r['友だち状態']) === '友だち'; });
  if (!friends.length) throw new Error('顧客管理に友だちがいません。テスト用アカウントを友だち追加してから実行してください。');
  var me = String(friends[friends.length - 1]['LINEユーザーID']);
  var d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  var ymd = Utilities.formatDate(d, APP.TIMEZONE, 'yyyyMMdd');
  var day = Utilities.formatDate(d, APP.TIMEZONE, 'yyyy-MM-dd');
  var seeds = [
    { id: 'TEST-' + ymd + '-A1B2C3', uid: me, plan: '【テスト】東京夜景遊覧', status: 'CONFIRMED', note: '本人・予約確定' },
    { id: 'TEST-' + ymd + '-D4E5F6', uid: me, plan: '【テスト】横浜ベイ遊覧', status: 'CANCELLED', note: '本人・キャンセル済み' },
    { id: 'TEST-' + ymd + '-0C0C0C', uid: TEST_ENV.OTHER_USER_ID, plan: '【テスト】他人の予約', status: 'CONFIRMED', note: '他人（表示されないこと）' },
    { id: 'TEST-' + ymd + '-DDDDDD', uid: me, plan: '【テスト】重複A', status: 'CONFIRMED', note: '予約ID重複1行目（表示されないこと）', dup: true },
    { id: 'TEST-' + ymd + '-DDDDDD', uid: me, plan: '【テスト】重複B', status: 'CONFIRMED', note: '予約ID重複2行目', dup: true }
  ];
  var lines = ['本人として使う LINE ユーザーID：' + maskId_(me)];
  withLock_(function () {
    seeds.forEach(function (s) {
      var exists = readRows_(SHEETS.RESERVATIONS).filter(function (r) { return String(r['予約ID']) === s.id && String(r['プラン名']) === s.plan; }).length;
      if (exists) { lines.push('登録済み：' + s.id + '（' + s.note + '）'); return; }
      appendRow_(SHEETS.RESERVATIONS, { '予約ID': s.id, 'LINEユーザーID': s.uid, 'プランID': 'TEST', 'プラン名': s.plan,
        '搭乗日': day, '時間帯': '18:00', '人数': 2, '予約状態': s.status, '最終更新': nowString_(), '注意事項': 'テストデータ' });
      lines.push('登録：' + s.id + '（' + s.note + '）');
    });
  });
  lines.push('存在しない予約ID の例：TEST-' + ymd + '-FFFFFF ／ 形式違いの例：12345');
  lines.push('（ダミーデータです。テスト用スプレッドシートだけに登録し、本番の予約管理には登録しません）');
  return testOut_('testSeedReservations', lines);
}

/* ---------- 5. 状態の確認 ---------- */

/** 最新の問い合わせ・有人対応・エラーログ・Webhook 受信を表示する */
function testStatus() {
  testGuard_({ needSheet: true });
  var rows = readRows_(SHEETS.INQUIRIES).slice(-8);
  var lines = ['— 問い合わせ管理（最新 ' + rows.length + ' 件）—'];
  rows.forEach(function (r) {
    lines.push('  ' + r['受付ID'] + ' / ' + r['種別'] + ' / ' + r['対応状況'] + ' / 自動返信有効=' + r[OPERATOR.COL] +
      ' / ' + String(r['内容'] || '').replace(/\s+/g, ' ').substring(0, 30));
  });
  var r = adminRun('operatorStatus');
  lines.push('', '— ' + r.title + ' —', r.message);
  lines.push('', '— エラーログ —', errorLogSummary_());
  var last = Number(getProp_(PROP_KEYS.LAST_WEBHOOK_AT) || 0);
  lines.push('', '最終 Webhook 受信：' + (last ? Utilities.formatDate(new Date(last), APP.TIMEZONE, 'yyyy/MM/dd HH:mm:ss') : '記録なし'));
  return testOut_('testStatus', lines);
}

/** 最新の有人対応（自動返信有効=FALSE の行）を終了し、自動返信を再開する（管理メニューの「自動返信の再開」と同じ処理） */
function testResumeAutoReply() {
  testGuard_({ needSheet: true });
  var rows = readRows_(SHEETS.INQUIRIES).filter(function (r) { return parseAutoReplyFlag_(r[OPERATOR.COL]) === false; });
  if (!rows.length) return testOut_('testResumeAutoReply', ['有人対応中（自動返信有効=FALSE）の行はありません。']);
  var r = adminRun('operatorRelease', { inquiryId: String(rows[rows.length - 1]['受付ID']) });
  return testOut_('testResumeAutoReply', [r.title, r.message]);
}

/** BOOKING_SITE_URL・FAQ_PAGE_URL を空欄にする（「準備中」案内の確認用。リッチメニューは testDeployRichMenu で再登録） */
function testClearSiteUrls() {
  testGuard_({ needSheet: true });
  testSetId_('BOOKING_SITE_URL', '');
  testSetId_('FAQ_PAGE_URL', '');
  return testOut_('testClearSiteUrls', ['BOOKING_SITE_URL・FAQ_PAGE_URL を空欄にしました（テスト用 ID管理）。testDeployRichMenu で再登録すると「準備中」表示になります。',
    '戻すときは testSetup を再実行してください（空欄の項目だけテストサイトの URL を入れます）。']);
}

/**
 * LINEシステム診断（管理メニューと同じ処理。読み取り専用）。テスト用チャネルでのみ実行する。
 * 自動返信の停止・設定警告・LINE操作ログの集計を、テスト用スプレッドシートで確認できる。
 */
function testDiagnose() {
  testGuard_({ needSheet: true, needLine: true });
  var r = adminRun('lineDiagnose');
  return testOut_('testDiagnose', [r.title + (r.ok ? '' : '（要対応あり）'), r.message]);
}

