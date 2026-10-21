/**
 * 11_Admin.gs
 * 管理者通知・管理操作（スプレッドシートの管理メニューから呼ばれる）。
 *
 * ■ 呼び出し経路
 *   スプレッドシートに紐づく GAS（src/sheet-admin/Code.gs）が、この独立 GAS を
 *   「ライブラリ」(識別子 SkyStandard) として読み込み、adminRun(action, params) を呼ぶ。
 *   - ライブラリ呼び出しはスプレッドシートを開いた本人の Google 認証で実行される
 *   - スクリプトプロパティ・キャッシュ・ロックはこの独立 GAS のもの（Web アプリと共有）
 *   - Web アプリ（doPost）からは adminRun に到達できない（公開 API にはしていない）
 *   - 実行者は assertAdmin_ で管理者か確認してから処理する
 *
 * ■ UI（ダイアログ・確認）は呼び出し側（sheet-admin）が担当し、ここでは結果オブジェクトのみ返す。
 *
 * ■ ライブラリ公開範囲
 *   末尾が _ でない関数はライブラリ利用者から呼び出せるため、公開関数は次に限定している。
 *     doGet / doPost（Web アプリ）、adminRun（管理者確認あり）、
 *     triggerFlightReminders / triggerRetryFailedSends（冪等な定期処理のみ）、
 *     installTriggers（独立GASのエディタ専用）、invalidateIdCacheFromEdit（キャッシュ破棄のみ）
 *
 * ■ トリガー
 *   定期処理のトリガーは独立GAS側に作成する（スプレッドシート側に作ると、シート編集者が
 *   スクリプトを書き換えて管理者権限で実行できてしまうため）。
 *   管理メニュー「トリガー設定」→ 管理者確認のうえ作成要求を記録 → Web アプリ（独立GAS・所有者権限）が
 *   要求を受けて作成する。Web アプリ未デプロイ時は独立GASのエディタで installTriggers を1回実行する。
 */

/* ---------- 運営通知 ---------- */

/**
 * 運営への通知。LINE（ID管理: ADMIN_NOTIFY_TARGET）とメール（ADMIN_EMAIL）のうち設定済みのものへ送る。
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

/* ---------- 権限確認 ---------- */

/** 管理者エラー（権限なし） */
function AdminAuthError(message) {
  this.name = 'AdminAuthError';
  this.message = message;
}
AdminAuthError.prototype = Object.create(Error.prototype);
AdminAuthError.prototype.constructor = AdminAuthError;

function currentUserEmail_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { /* noop */ }
  if (!email) {
    try { email = Session.getEffectiveUser().getEmail(); } catch (e) { /* noop */ }
  }
  return String(email || '').toLowerCase();
}

/**
 * 実行者が管理者か確認する。
 *   - 独立GASのスクリプトプロパティ ADMIN_USERS（カンマ区切りのメールアドレス）に含まれること（必須）
 * 管理者リストはシートに置かない（シート編集者が自分を追加できてしまうため）。
 * 「オーナーなら可」のような自動判定はしない（別のスプレッドシートから呼ばれた場合に誤判定するため）。
 */
function assertAdmin_() {
  var email = currentUserEmail_();
  if (!email) throw new AdminAuthError('実行者のメールアドレスを取得できないため、管理操作を実行できません。');
  var allowed = getProp_(PROP_KEYS.ADMIN_USERS).toLowerCase().split(/[,\s]+/).filter(String);
  if (!allowed.length) {
    throw new AdminAuthError('管理者が未登録です。独立GASの「プロジェクトの設定 → スクリプト プロパティ」に ADMIN_USERS を追加し、' +
      '管理者のメールアドレスを登録してください（例: ' + email + '）。');
  }
  if (allowed.indexOf(email) === -1) throw new AdminAuthError(email + ' は管理者として登録されていません（スクリプトプロパティ ADMIN_USERS）。');
  return email;
}

/* ---------- 管理 API（ライブラリ公開関数） ---------- */

/**
 * 管理メニューからの唯一の入口。
 * @param {string} action 操作名
 * @param {Object=} params 操作ごとのパラメータ
 * @return {{ok:boolean, title:string, message:string, data?:Object}}
 */
function adminRun(action, params) {
  params = params || {};
  var user;
  try {
    user = assertAdmin_();
  } catch (e) {
    logWarn_('admin.denied', { action: action });
    return { ok: false, title: '権限がありません', message: e.message, denied: true };
  }
  var handler = ADMIN_ACTIONS[action];
  if (!handler) return { ok: false, title: 'エラー', message: '不明な操作です: ' + action };
  try {
    invalidateIdCache_(); // 管理操作は常に最新の ID管理 を参照（共有キャッシュも破棄）
    var res = handler(params, user);
    logInfo_('admin.action', { action: action, ok: res.ok });
    return res;
  } catch (e) {
    logError_('admin.action_failed', e, { action: action });
    if (e instanceof ConfigError) {
      return { ok: false, title: '設定が不足しています', message: e.message + '\n\n不足しているキー: ' + e.missingKeys.join(', ') };
    }
    if (e instanceof LineApiError) {
      return { ok: false, title: 'LINE API エラー', message: lineErrorHint_(e) };
    }
    return { ok: false, title: 'エラー', message: e && e.message ? e.message : String(e) };
  }
}

var ADMIN_ACTIONS = {
  /* 権限確認のみ */
  whoami: function (p, user) { return { ok: true, title: '管理者確認', message: user + ' は管理者です。' }; },
  /* 初期設定 */
  setupSheets: function () { return adminSetupSheets_(); },
  checkIds: function () { return adminCheckIds_(); },
  checkLine: function (p) { return adminCheckLine_(p); },
  /* LINE 管理 */
  richMenuDeploy: function () {
    var r = deployRichMenu_();
    return { ok: true, title: 'リッチメニューを登録しました',
      message: 'リッチメニューID: ' + r.richMenuId + '\n' +
        (r.unset.length ? 'URL未設定のため「準備中」と表示されるボタン: ' + r.unset.join('、') : 'すべてのボタンにURLが設定されています。') };
  },
  richMenuCheck: function () { return adminRichMenuCheck_(); },
  quota: function () {
    var q = getMessageQuota_();
    return { ok: true, title: '今月の配信数', message: '今月の配信数: ' + q.used + ' 通' +
      (q.type === 'limited' ? '\n月間上限: ' + q.limit + ' 通\n残り: ' + Math.max(0, q.limit - q.used) + ' 通' : '\n（上限なし）') };
  },
  /* 予約・通知 */
  sendInfo: function (p) { return adminSendInfo_(p.sendId); },
  approve: function (p, user) {
    var r = approvePendingNotification_(String(p.sendId || ''), user);
    return { ok: r.result === SEND_RESULT.SUCCESS, title: '承認・送信結果', message: '送信ID: ' + r.sendId + '\n結果: ' + r.result };
  },
  reject: function (p) {
    rejectPendingNotification_(String(p.sendId || ''));
    return { ok: true, title: '却下しました', message: '送信ID: ' + p.sendId + ' を「承認却下」にしました。利用者には送信されません。' };
  },
  retryCount: function () {
    var n = countRetryTargets_();
    return { ok: true, title: '再送対象', message: '再送対象: ' + n + ' 件', data: { count: n } };
  },
  retry: function () {
    var r = retryFailedSends_();
    var lines = Object.keys(r.results).map(function (k) { return '  ' + k + ': ' + r.results[k] + ' 件'; });
    return { ok: true, title: '再送結果', message: '対象 ' + r.targets + ' 件 / 処理 ' + r.processed + ' 件' + (lines.length ? '\n' + lines.join('\n') : '') +
      (r.expired ? '\n\n【要確認】処理中のまま24時間近く経過した ' + r.expired + ' 件は、重複送信を防ぐため「失敗」にしました。送信ログで確認してください。' : '') };
  },
  templates: function () { return adminTemplates_(); },
  /* システム管理 */
  diagnose: function (p) { return adminDiagnose_(p); },
  invalidateCache: function () {
    invalidateIdCache_();
    return { ok: true, title: '設定を再読込しました', message: '「ID管理」シートのキャッシュを破棄しました。次の処理から新しい値が使われます。' };
  },
  requestTriggerSync: function (p, user) {
    PropertiesService.getScriptProperties().setProperty(TRIGGER_PROPS.REQUEST, JSON.stringify({ at: Date.now(), by: user }));
    var url = getSetting_(ID_KEYS.GAS_WEBAPP_URL);
    return { ok: true, title: 'トリガー設定を受け付けました', data: { webAppUrl: url },
      message: url ? 'Web アプリでトリガーを作成します。' : 'GAS_WEBAPP_URL（ID管理シート）が未設定のため、Web アプリ経由で作成できません。' };
  },
  triggerStatus: function () { return adminTriggerStatus_(); },
  /* エラーログ */
  errorLogStatus: function () { return adminErrorLogStatus_(); },
  errorLogTest: function (p, user) { return adminErrorLogTest_(user); },
  /* オペレーター対応（12_Operator.gs） */
  operatorStatus: function () { return adminOperatorStatus_(); },
  operatorRelease: function (p) { return adminOperatorRelease_(p.inquiryId); },
  /* 手動実行 */
  runReminders: function () {
    var n = sendFlightReminders_();
    return { ok: true, title: '搭乗前日リマインド', message: '送信: ' + n + ' 件' };
  }
};

/** LINE API エラーの日本語ヒント */
function lineErrorHint_(e) {
  var hint = {
    400: 'リクエスト内容が不正です（ID・URLの形式を確認してください）。',
    401: 'チャネルアクセストークンが無効です。LINE_CHANNEL_ACCESS_TOKEN（スクリプトプロパティ）を確認してください。',
    403: 'この操作の権限がありません（プラン・チャネル設定を確認してください）。',
    404: '対象が見つかりません。',
    429: 'リクエスト上限・月間配信上限に達しています。',
  }[e.status] || 'LINE 側で一時的なエラーが発生しました。時間をおいて再実行してください。';
  return 'HTTP ' + e.status + '：' + hint + '\n詳細: ' + summarizeLineError_(e.body);
}

/* ---------- 初期設定 ---------- */

/**
 * 既存データを保持したまま不足分だけ補完する。
 *  - 各シートの不足列を末尾に追加
 *  - 「ID管理」に不足している設定キー行を追加（値は空）
 *  - 「通知テンプレート」に不足しているテンプレートを 有効=OFF で追加
 *  - SPREADSHEET_ID（起動用）が未設定なら、操作中のスプレッドシートIDをスクリプトプロパティに保存
 */
function setupSheets_() {
  var report = { columns: {}, idKeys: [], templates: [], spreadsheetIdSet: false, missingSheets: [] };
  if (!getProp_(PROP_KEYS.SPREADSHEET_ID)) {
    var active = null;
    try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
    if (!active) throw new ConfigError('SPREADSHEET_ID が未設定です。スクリプトプロパティに設定するか、スプレッドシートの管理メニューから実行してください。', [PROP_KEYS.SPREADSHEET_ID]);
    PropertiesService.getScriptProperties().setProperty(PROP_KEYS.SPREADSHEET_ID, active.getId());
    __ss = null;
    report.spreadsheetIdSet = true;
  }
  return withLock_(function () {
    var ss = getSpreadsheet_();
    Object.keys(SHEETS).forEach(function (k) {
      if (!ss.getSheetByName(SHEETS[k])) report.missingSheets.push(SHEETS[k]);
    });
    Object.keys(REQUIRED_COLUMNS).forEach(function (name) {
      if (report.missingSheets.indexOf(name) !== -1) return; // シートは勝手に作らない
      var added = ensureColumns_(name, REQUIRED_COLUMNS[name]);
      if (added.length) report.columns[name] = added;
    });
    if (report.missingSheets.indexOf(SHEETS.ID_MANAGEMENT) === -1) {
      var existingKeys = readRows_(SHEETS.ID_MANAGEMENT).map(function (r) { return String(r['設定キー']).trim(); });
      Object.keys(ID_KEYS).forEach(function (k) {
        var def = ID_KEYS[k];
        if (existingKeys.indexOf(def.key) === -1) {
          appendRow_(SHEETS.ID_MANAGEMENT, { '設定キー': def.key, '設定値': '', '分類': /URL/.test(def.key) ? 'URL' : 'ID',
            '保存先・取扱い': 'シート', '説明': def.label });
          report.idKeys.push(def.key);
        }
      });
      SECRET_KEYS.forEach(function (k) {
        if (existingKeys.indexOf(k) === -1) {
          appendRow_(SHEETS.ID_MANAGEMENT, { '設定キー': k, '設定値': '', '分類': '秘密情報', '保存先・取扱い': 'GASスクリプトプロパティのみ',
            '説明': 'このシートに入力しない' });
          report.idKeys.push(k);
        }
      });
    }
    report.errorLogCreated = ensureErrorLogSheet_().created;
    if (report.missingSheets.indexOf(SHEETS.INQUIRIES) === -1) report.inquiryStatusValidation = ensureInquiryStatusValidation_();
    var tplIds = readRows_(SHEETS.TEMPLATES).map(function (r) { return String(r['テンプレートID']); });
    DEFAULT_TEMPLATES.forEach(function (t) {
      if (tplIds.indexOf(t.id) === -1) {
        appendRow_(SHEETS.TEMPLATES, { 'テンプレートID': t.id, '用途': t.use, '送信タイミング': t.timing, '本文': t.body,
          '有効': 'OFF', '備考': '自動追加。文面確認後に ON にしてください' });
        report.templates.push(t.id);
      }
    });
    invalidateIdCache_();
    return report;
  });
}

function adminSetupSheets_() {
  var r = setupSheets_();
  var cols = Object.keys(r.columns).map(function (k) { return '  ' + k + '：' + r.columns[k].join('、'); });
  var msg = [
    r.spreadsheetIdSet ? '・SPREADSHEET_ID（起動用）をスクリプトプロパティに保存しました。' : '・SPREADSHEET_ID（起動用）：設定済み',
    '・追加した列：' + (cols.length ? '\n' + cols.join('\n') : 'なし'),
    '・ID管理に追加した設定キー：' + (r.idKeys.join('、') || 'なし'),
    '・追加した通知テンプレート（有効=OFF）：' + (r.templates.join('、') || 'なし'),
    '・エラーログシート：' + (r.errorLogCreated ? '新規作成しました' : '作成済み'),
    '・問い合わせ管理「対応状況」の選択肢（未対応／対応中／対応完了）：' + (r.inquiryStatusValidation ? '設定しました（既存の値はそのまま）' : '未設定（列またはシートがありません）'),
    '\n既存のデータ・行は変更していません。'
  ];
  if (r.missingSheets.length) msg.unshift('【注意】次のシートが見つかりません（自動作成はしません）：' + r.missingSheets.join('、'));
  return { ok: !r.missingSheets.length, title: 'シート列・設定行の補完', message: msg.join('\n') };
}

/** ID・URL 設定チェック（ID管理シートを再読込してキャッシュも更新） */
function adminCheckIds_() {
  var map = readIdSettings_(true);
  var raw = {};
  try { raw = readIdSheet_(); } catch (e) { throw new ConfigError('「ID管理」シートを読み込めません: ' + e.message, ['ID管理']); }
  var lines = [];
  Object.keys(ID_KEYS).forEach(function (k) {
    var def = ID_KEYS[k];
    var v = map[def.key] || (def.propFallback ? getProp_(def.key) : '');
    var state = !v ? '【未設定】' : (def.pattern && !def.pattern.test(v) ? '【形式エラー】' : '【OK】');
    var src = !map[def.key] && v ? '（スクリプトプロパティの旧設定を使用中。ID管理への移行を推奨）' : '';
    lines.push(state + ' ' + def.key + '（' + def.label + '）' + src + (state === '【OK】' ? '' : ' … 用途: ' + def.usedBy.join('、')));
  });
  var danger = SECRET_KEYS.filter(function (k) { return raw[k]; });
  var secretLines = SECRET_KEYS.map(function (k) {
    return (getProp_(k) ? '【OK】' : '【未設定】') + ' ' + k + '（スクリプトプロパティ' + (k === 'LINE_CHANNEL_SECRET' ? '／リレーは Secret Manager' : '') + '）';
  });
  var sid = getProp_(PROP_KEYS.SPREADSHEET_ID);
  var sheetSid = map['SPREADSHEET_ID'] || '';
  var sidLine = !sid ? '【未設定】SPREADSHEET_ID（スクリプトプロパティ・起動用）… 「シート列・設定行の補完」で自動設定できます'
    : (sheetSid && sheetSid !== sid ? '【不一致】スクリプトプロパティの SPREADSHEET_ID と ID管理シートの値が異なります' : '【OK】SPREADSHEET_ID（スクリプトプロパティ・起動用）');
  var legacy = legacySettingsNotMigrated_(map);
  var cfg = checkConfig_();
  var missingByFeature = Object.keys(cfg.missing).map(function (g) { return '■ ' + g + '\n  - ' + cfg.missing[g].join('\n  - '); });
  var msg = '◆ 起動設定\n' + sidLine +
    '\n\n◆ ID管理シート（公開可能な ID・URL）\n' + lines.join('\n') +
    '\n\n◆ 秘密情報（スクリプトプロパティ。値は表示しません）\n' + secretLines.join('\n') +
    (danger.length ? '\n\n【危険】ID管理シートに秘密情報が入力されています。値を削除し、スクリプトプロパティへ移してください：' + danger.join('、') +
      '\n（システムはシート上の秘密情報を読み込みません）' : '') +
    (legacy.length ? '\n\n【移行が必要】旧「LINE設定」シートに値があり、ID管理シートが空の項目：' + legacy.join('、') : '') +
    '\n\n◆ 機能ごとの不足設定\n' + (missingByFeature.length ? missingByFeature.join('\n') : 'すべての必須設定が入力済みです。') +
    (cfg.warnings.length ? '\n\n◆ 注意（障害ではありません）\n・' + cfg.warnings.join('\n・') : '') +
    '\n\n（ID管理シートの最新値を読み込み、設定キャッシュを更新しました）';
  return { ok: cfg.ok && !danger.length, title: 'ID・URL設定チェック', message: msg };
}

/** 旧「LINE設定」に値が残っていて ID管理が空の項目 */
function legacySettingsNotMigrated_(idMap) {
  var out = [];
  try {
    readRows_(SHEETS.SETTINGS).forEach(function (r) {
      var to = LEGACY_SETTING_MAP[String(r['設定キー']).trim()];
      if (to && String(r['設定値'] || '').trim() && !idMap[to]) out.push(r['設定キー'] + ' → ' + to);
    });
  } catch (e) { /* LINE設定シートがなければ対象外 */ }
  return out;
}

/**
 * LINE 接続チェック。
 *   - トークン有効性・アカウント情報（ボットのユーザーIDを BOT_USER_ID に保存）
 *   - Webhook 設定（LINE 側に登録された URL と、受信方式に応じた期待値の比較）
 *   - 任意：Webhook 疎通テスト。LINE が報告した HTTP ステータスと、GAS 側で実際に受信できたか
 *     （受信記録の更新）を分けて表示する。302 は「GAS は実行されたが LINE は失敗扱い」。
 */
function adminCheckLine_(p) {
  if (!getProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN)) {
    throw new ConfigError('LINE_CHANNEL_ACCESS_TOKEN（スクリプトプロパティ）が未設定のため、LINE に接続できません。', ['LINE_CHANNEL_ACCESS_TOKEN']);
  }
  var lines = [];
  var mode = getWebhookMode_();
  var info = lineFetch_('get', '/v2/bot/info').body;
  lines.push('【OK】チャネルアクセストークン有効');
  lines.push('  アカウント名: ' + (info.displayName || '-') + ' / ベーシックID: ' + (info.basicId || '-'));
  if (info.userId && /^U[0-9a-f]{32}$/.test(info.userId)) {
    PropertiesService.getScriptProperties().setProperty(PROP_KEYS.BOT_USER_ID, info.userId);
  }
  lines.push('【情報】Webhook 受信方式: ' + (mode === WEBHOOK_MODES.DIRECT ? 'GAS単体（direct・署名検証なし）' : 'リレー経由（relay・署名検証あり）'));
  if (info.chatMode === 'chat') lines.push('【OK】チャット: オン（オペレーター対応で、担当者がチャット画面から返信できます）');
  else if (info.chatMode === 'bot') lines.push('【要確認】チャット: オフ。オペレーター対応（「オペレーターに相談」）を使う場合は、LINE Official Account Manager → 応答設定で「チャット」をオンにしてください（Webhook はオンのまま）');
  lines.push(deployedBuildLine_());

  var gasUrl = getSetting_(ID_KEYS.GAS_WEBAPP_URL);
  var wh = null;
  try {
    wh = lineFetch_('get', '/v2/bot/channel/webhook/endpoint').body;
  } catch (e) {
    lines.push('【要確認】LINE 側の Webhook 設定を取得できません: ' + (e.message || e));
  }
  if (wh) {
    lines.push((wh.active ? '【OK】' : '【NG】') + 'Webhook の利用: ' + (wh.active ? 'オン' : 'オフ（LINE Developers で「Webhookの利用」をオンにしてください）'));
    var endpoint = wh.endpoint || '';
    if (!endpoint) {
      lines.push('【未設定】Webhook URL が LINE 側に登録されていません');
    } else if (mode === WEBHOOK_MODES.DIRECT) {
      var same = gasUrl && endpoint === gasUrl;
      lines.push((same ? '【OK】' : '【要確認】') + 'Webhook URL: ' + endpoint +
        (same ? '（ID管理の GAS_WEBAPP_URL と一致）' : gasUrl ? '\n  ※ ID管理の GAS_WEBAPP_URL（' + gasUrl + '）と一致しません' : '\n  ※ ID管理の GAS_WEBAPP_URL が未設定です'));
    } else {
      lines.push((/script\.google\.com/.test(endpoint) ? '【要確認】' : '【OK】') + 'Webhook URL: ' + endpoint +
        (/script\.google\.com/.test(endpoint) ? '\n  ※ relay モードでは LINE の Webhook URL にリレーの /webhook を指定します' : ''));
    }
    if (p && p.testWebhook && endpoint) {
      var before = Number(getProp_(PROP_KEYS.LAST_WEBHOOK_AT) || 0);
      var t = lineFetch_('post', '/v2/bot/channel/webhook/test', { endpoint: endpoint }).body;
      var after = Number(PropertiesService.getScriptProperties().getProperty(PROP_KEYS.LAST_WEBHOOK_AT) || 0);
      var received = after > before;
      lines.push((t.success ? '【OK】' : '【NG】') + 'LINE 側の疎通テスト結果: ' + (t.success ? '成功' : '失敗') +
        (t.statusCode ? '（HTTP ' + t.statusCode + (t.reason ? ' ' + t.reason : '') + '）' : ''));
      lines.push((received ? '【OK】' : '【NG】') + 'GAS 側の受信記録: ' + (received ? 'テスト中に受信を確認' : '受信を確認できません'));
      if (Number(t.statusCode) === 302) {
        lines.push('  ※ 302 は GAS の応答がリダイレクトになったことを示します。デプロイされている GAS が古い（ContentService で応答）可能性があります。' +
          '最新のコードを反映し、ウェブアプリを「新バージョン」で更新してください。');
      }
      if (!t.success && received) lines.push('  → GAS は受信・処理していますが、LINE は失敗として扱っています（エラー統計・再送の対象になります）。');
      if (t.success && !received) lines.push('  → LINE は成功と報告しましたが、この GAS の受信記録は更新されていません（別の URL・別のデプロイに届いている可能性）。');
    } else if (!(p && p.testWebhook)) {
      lines.push('【情報】疎通テストは実行していません');
    }
  }
  var last = Number(getProp_(PROP_KEYS.LAST_WEBHOOK_AT) || 0);
  lines.push('【情報】最終 Webhook 受信: ' + (last ? Utilities.formatDate(new Date(last), APP.TIMEZONE, 'yyyy/MM/dd HH:mm:ss') : '記録なし') +
    '（受信記録は送信元を検証しないため、偽装リクエストでも更新されます）');
  try {
    var q = getMessageQuota_();
    lines.push('【情報】今月の配信数: ' + q.used + (q.type === 'limited' ? ' / ' + q.limit : '（上限なし）'));
  } catch (e) { /* 任意 */ }
  if (mode === WEBHOOK_MODES.DIRECT) {
    lines.push('\n◆ GAS単体構成の制約\n' + configWarnings_()[0]);
  }
  return { ok: !lines.some(function (l) { return l.indexOf('【NG】') === 0; }), title: 'LINE接続チェック', message: lines.join('\n') };
}

/**
 * リッチメニュー設定確認（LINE には何も登録しない）。
 *   - 各ボタンの動作（リンク／準備中表示／メッセージ送信）とタップ領域
 *   - 画像の検査（形式・1MB 以下・2500×1686px）
 *   - LINE 側の既定メニューとの差分（URL を設定した後に再登録が必要か）
 */
function adminRichMenuCheck_() {
  var built = buildRichMenuDefinition_();
  var lines = built.definition.areas.map(function (a) {
    var act = a.action, b = a.bounds;
    var to = act.type === 'uri' ? 'リンク ' + act.uri : act.type === 'message' ? 'メッセージ「' + act.text + '」を送信' : '「現在準備中です」を返信（URL 未設定）';
    return (act.type === 'postback' ? '【準備中】' : '【OK】') + act.label + ' → ' + to +
      '\n    タップ領域 x:' + b.x + '〜' + (b.x + b.width - 1) + ' / y:' + b.y + '〜' + (b.y + b.height - 1);
  });
  var problems = [];
  var imageLines;
  if (!getSetting_(ID_KEYS.RICHMENU_IMAGE_FILE_ID)) {
    imageLines = ['【未設定】RICHMENU_IMAGE_FILE_ID（ID管理シート）'];
    problems.push('image');
  } else {
    var img = validateRichMenuImage_();
    imageLines = img.ok
      ? ['【OK】' + img.name + '（' + img.type + '・' + img.width + '×' + img.height + 'px・' + Math.round(img.bytes / 1024) + 'KB）']
      : img.problems.map(function (p) { return '【NG】' + p; });
    if (!img.ok) problems.push('image');
  }
  var lineLines;
  if (!getProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN)) {
    lineLines = ['（LINE_CHANNEL_ACCESS_TOKEN 未設定のため LINE 側は未確認）'];
  } else {
    var cmp = compareRegisteredRichMenu_();
    if (cmp.error) lineLines = ['【要確認】LINE 側の状態を取得できませんでした: ' + cmp.error];
    else if (!cmp.registered) lineLines = ['【未登録】既定のリッチメニューはまだ登録されていません'];
    else if (cmp.needsUpdate) lineLines = ['【要再登録】既定リッチメニューID: ' + cmp.richMenuId].concat(cmp.diffs.map(function (d) { return '  ・' + d; }))
      .concat(['  → 「リッチメニュー登録・更新」を実行すると反映されます']);
    else lineLines = ['【OK】登録済みの内容は現在の設定と一致しています（ID: ' + cmp.richMenuId + '）'];
  }
  var pendingNote = built.unset.length
    ? '\n準備中のボタン: ' + built.unset.join('、') + '\n予約サイト完成後は「ID管理」シートに URL を入力し、「リッチメニュー登録・更新」を実行するとリンク方式に切り替わります。'
    : '';
  return { ok: !problems.length, title: 'リッチメニュー設定確認',
    message: '◆ 登録内容（ID管理シートの現在値）\n' + lines.join('\n') + pendingNote +
      '\n\n◆ 画像\n' + imageLines.join('\n') + '\n\n◆ LINE 側\n' + lineLines.join('\n') };
}

/** 選択行の通知情報（確認ダイアログ用） */
function adminSendInfo_(sendId) {
  var row = findRow_(SHEETS.SEND_LOG, '送信ID', String(sendId || ''));
  if (!row) return { ok: false, title: '通知が見つかりません', message: '送信ID: ' + sendId };
  var payload = loadPendingPayload_(String(sendId));
  var preview = '';
  if (payload) {
    var body = getTemplate_(payload.templateId);
    preview = body ? renderTemplate_(body, payload.vars) : '（テンプレート「' + payload.templateId + '」が無効または未登録のため送信されません）';
  }
  return { ok: true, title: '通知の確認', data: { status: String(row['結果']), pending: row['結果'] === SEND_RESULT.PENDING_APPROVAL },
    message: '送信ID: ' + sendId + '\n通知種別: ' + row['通知種別'] + '\n予約ID: ' + row['予約ID'] + '\n現在の状態: ' + row['結果'] +
      (preview ? '\n\n送信される文面:\n' + preview : '') };
}

/** 通知テンプレート確認 */
function adminTemplates_() {
  var rows = readRows_(SHEETS.TEMPLATES);
  var known = ['予約ID', 'プラン名', '搭乗日', '時間帯', '搭乗日時', '人数', '集合場所'];
  var required = ['WELCOME', 'BOOKING_RECEIVED', 'BOOKING_CONFIRMED', 'BOOKING_CHANGED', 'BOOKING_CANCELLED', 'PAYMENT_COMPLETED',
    'FLIGHT_REMINDER', 'FLIGHT_CHANGE'];
  var ids = rows.map(function (r) { return String(r['テンプレートID']); });
  var lines = rows.map(function (r) {
    var on = String(r['有効']).toUpperCase() === 'ON';
    var vars = (String(r['本文']).match(/\{\{\s*[^}]+?\s*\}\}/g) || []).map(function (v) { return v.replace(/[{}\s]/g, ''); });
    var unknown = vars.filter(function (v) { return known.indexOf(v) === -1; });
    return (on ? '【ON 】' : '【OFF】') + r['テンプレートID'] + '（' + r['用途'] + '）' +
      (unknown.length ? ' ※使用できない変数: ' + unknown.join('、') : '') + (r['本文'] ? '' : ' ※本文が空');
  });
  var missing = required.filter(function (id) { return ids.indexOf(id) === -1; });
  return { ok: !missing.length, title: '通知テンプレート確認',
    message: lines.join('\n') + (missing.length ? '\n\n【未登録】' + missing.join('、') + '（「シート列・設定行の補完」で OFF の状態で追加できます）' : '') +
      '\n\n使用できる変数: ' + known.map(function (v) { return '{{' + v + '}}'; }).join(' ') +
      '\nOFF のテンプレートの通知は送信されず、送信ログに「テンプレート無効」と記録されます。' };
}

/**
 * 接続・設定診断。
 * @param {{triggers?: string[]}} p 呼び出し側（sheet-admin）で取得したトリガー一覧（関数名）
 */
function adminDiagnose_(p) {
  var out = [];
  function sec(title, fn) {
    try { out.push('◆ ' + title + '\n' + fn()); } catch (e) { out.push('◆ ' + title + '\n【NG】' + (e.message || e)); }
  }
  sec('スプレッドシート', function () {
    var ss = getSpreadsheet_();
    var missing = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; }).filter(function (n) { return !ss.getSheetByName(n); });
    return (getProp_(PROP_KEYS.SPREADSHEET_ID) ? '【OK】SPREADSHEET_ID（起動用）設定済み' : '【未設定】SPREADSHEET_ID（起動用）… Webアプリ・トリガーが動作しません') +
      '\n' + (missing.length ? '【NG】見つからないシート: ' + missing.join('、') : '【OK】必要な ' + Object.keys(SHEETS).length + ' シートあり');
  });
  sec('ID・URL・秘密情報', function () {
    readIdSettings_(true);
    var cfg = checkConfig_();
    var raw = readIdSheet_();
    var danger = SECRET_KEYS.filter(function (k) { return raw[k]; });
    var lines = Object.keys(cfg.missing).map(function (g) { return '【不足】' + g + '：' + cfg.missing[g].join('、'); });
    if (danger.length) lines.unshift('【危険】ID管理シートに秘密情報の値があります：' + danger.join('、'));
    return lines.length ? lines.join('\n') : '【OK】必須設定はすべて入力済み';
  });
  sec('管理者', function () {
    var list = getProp_(PROP_KEYS.ADMIN_USERS);
    return list ? '【OK】ADMIN_USERS 登録済み（' + list.split(/[,\s]+/).filter(String).length + ' 名）' : '【要設定】ADMIN_USERS 未登録（誰も管理操作できません）';
  });
  sec('Web アプリの反映状況', function () { return deployedBuildLine_(); });
  sec('LINE 接続', function () {
    if (!getProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN)) return '【未設定】LINE_CHANNEL_ACCESS_TOKEN（スクリプトプロパティ）';
    return adminCheckLine_({}).message;
  });
  sec('トリガー（独立GAS）', function () { return adminTriggerStatus_().message; });
  sec('エラーログ', function () { return errorLogSummary_(); });
  sec('送信ログ', function () {
    var rows = readRows_(SHEETS.SEND_LOG);
    var count = {};
    rows.forEach(function (r) { count[r['結果']] = (count[r['結果']] || 0) + 1; });
    var keys = Object.keys(count);
    return keys.length ? keys.map(function (k) { return '  ' + k + ': ' + count[k] + ' 件'; }).join('\n') : '  記録なし';
  });
  return { ok: true, title: '接続・設定診断', message: out.join('\n\n') };
}

/* ---------- トリガー（独立GAS側に作成） ---------- */

var TRIGGER_PROPS = {
  REQUEST: 'TRIGGER_SYNC_REQUEST',
  STATUS: 'TRIGGER_STATUS',
  LAST_REMINDERS: 'LAST_RUN_FLIGHT_REMINDERS',
  LAST_RETRY: 'LAST_RUN_RETRY'
};
var TRIGGER_DEFS = [
  { fn: 'triggerFlightReminders', label: '搭乗前日リマインド（毎日10時台）', heartbeat: 'LAST_RUN_FLIGHT_REMINDERS', maxGapMs: 26 * 3600 * 1000 },
  { fn: 'triggerRetryFailedSends', label: '失敗した通知の再送（10分おき）', heartbeat: 'LAST_RUN_RETRY', maxGapMs: 30 * 60 * 1000 }
];
/** 管理者の作成要求の有効期間 */
var TRIGGER_REQUEST_TTL_MS = 10 * 60 * 1000;

/** 時間主導トリガー：搭乗前日リマインド（冪等。何度実行されても1予約1回のみ送信） */
function triggerFlightReminders() {
  PropertiesService.getScriptProperties().setProperty(TRIGGER_PROPS.LAST_REMINDERS, String(Date.now()));
  try {
    return sendFlightReminders_();
  } catch (e) {
    logError_('trigger.failed', e, { action: 'triggerFlightReminders' });
    throw e; // 実行履歴にも失敗として残す
  }
}

/** 時間主導トリガー：再試行待ち通知の再送（冪等。X-Line-Retry-Key で重複防止） */
function triggerRetryFailedSends() {
  PropertiesService.getScriptProperties().setProperty(TRIGGER_PROPS.LAST_RETRY, String(Date.now()));
  try {
    return retryFailedSends_();
  } catch (e) {
    logError_('trigger.failed', e, { action: 'triggerRetryFailedSends' });
    throw e;
  }
}

/** ID管理シート編集時のキャッシュ破棄（管理メニュー用GAS の onEdit から呼ばれる。値は返さない） */
function invalidateIdCacheFromEdit() {
  invalidateIdCache_();
}

/** 独立GASのプロジェクトにトリガーを作成（不足分のみ。重複は1件に整理） */
function installStandaloneTriggers_() {
  var created = [], removed = 0, seen = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    // 旧版の関数名（sendFlightReminders / retryFailedSends）は非公開化したため削除
    if (fn === 'sendFlightReminders' || fn === 'retryFailedSends' || seen[fn]) { ScriptApp.deleteTrigger(t); removed++; return; }
    seen[fn] = true;
  });
  TRIGGER_DEFS.forEach(function (d) {
    if (seen[d.fn]) return;
    if (d.fn === 'triggerFlightReminders') {
      ScriptApp.newTrigger(d.fn).timeBased().atHour(10).everyDays(1).inTimezone(APP.TIMEZONE).create();
    } else {
      ScriptApp.newTrigger(d.fn).timeBased().everyMinutes(10).create();
    }
    created.push(d.label);
  });
  return { created: created, removed: removed };
}

/** 独立GASのトリガー状況を記録（管理メニューから参照するため） */
function recordTriggerStatus_(extra) {
  var counts = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    counts[fn] = (counts[fn] || 0) + 1;
  });
  var status = { at: Date.now(), counts: counts };
  if (extra) Object.keys(extra).forEach(function (k) { status[k] = extra[k]; });
  PropertiesService.getScriptProperties().setProperty(TRIGGER_PROPS.STATUS, JSON.stringify(status));
  return status;
}

/**
 * Web アプリ（doGet ?sync=triggers）から呼ばれる。独立GAS・所有者権限で実行される。
 * 管理者が adminRun('requestTriggerSync') で記録した有効な要求がある場合のみトリガーを作成する。
 * 要求がなければ状況の記録だけを行う（無認証で呼ばれても作成・削除はしない）。
 */
function handleTriggerSync_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(TRIGGER_PROPS.REQUEST);
  var req = null;
  try { req = raw ? JSON.parse(raw) : null; } catch (e) { req = null; }
  var res = { ok: true, installed: false };
  if (req && Date.now() - Number(req.at) < TRIGGER_REQUEST_TTL_MS) {
    props.deleteProperty(TRIGGER_PROPS.REQUEST);
    var r = withLock_(function () { return installStandaloneTriggers_(); });
    res.installed = true;
    res.created = r.created.length;
    res.removed = r.removed;
    logInfo_('triggers.installed', { created: r.created.length, removed: r.removed });
  } else if (req) {
    props.deleteProperty(TRIGGER_PROPS.REQUEST);
  }
  recordTriggerStatus_({ lastSyncInstalled: res.installed });
  return res;
}

/**
 * 独立GASのエディタから1回だけ実行する代替手段（Web アプリ未デプロイ時）。
 * 管理メニュー（ライブラリ）経由では実行しない（呼び出し元のプロジェクトにトリガーができてしまうため）。
 */
function installTriggers() {
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active) throw new Error('この関数は独立GASのエディタから実行してください（管理メニューからは「トリガー設定」を使用）。');
  var r = installStandaloneTriggers_();
  recordTriggerStatus_({ lastSyncInstalled: true });
  console.log('作成: ' + (r.created.join('、') || 'なし') + ' / 重複削除: ' + r.removed);
  return r;
}

/** トリガー状態（記録された状況と、最終実行時刻から判定） */
function adminTriggerStatus_() {
  var props = PropertiesService.getScriptProperties();
  var status = null;
  try { status = JSON.parse(props.getProperty(TRIGGER_PROPS.STATUS) || 'null'); } catch (e) { status = null; }
  var lines = TRIGGER_DEFS.map(function (d) {
    var n = status && status.counts ? (status.counts[d.fn] || 0) : null;
    var last = Number(props.getProperty(d.heartbeat) || 0);
    var state = n === null ? '【不明】' : n === 1 ? '【OK】' : n > 1 ? '【重複 ' + n + '件】' : '【未設定】';
    var run = last ? '最終実行 ' + Utilities.formatDate(new Date(last), APP.TIMEZONE, 'MM/dd HH:mm') +
      (Date.now() - last > d.maxGapMs ? '（想定より長く実行されていません）' : '') : '実行記録なし';
    return state + d.label + ' … ' + run;
  });
  var ok = !!status && TRIGGER_DEFS.every(function (d) { return status.counts[d.fn] === 1; });
  var legacy = status && status.counts ? ['sendFlightReminders', 'retryFailedSends'].filter(function (fn) { return status.counts[fn]; }) : [];
  return { ok: ok, title: 'トリガー状態確認',
    message: lines.join('\n') +
      (status ? '\n\n状況の記録: ' + Utilities.formatDate(new Date(status.at), APP.TIMEZONE, 'yyyy/MM/dd HH:mm') : '\n\n状況が未記録です。「トリガー設定」を実行してください。') +
      (legacy.length ? '\n【要整理】旧版のトリガー: ' + legacy.join('、') + '（「トリガー設定」で削除されます）' : '') +
      '\n\n※ トリガーは独立GAS（所有者の権限）で動作します。' };
}

/* ---------- デプロイ反映チェック ---------- */

/**
 * デプロイ済み Web アプリの版を取得（doGet の build）。
 * @return {{build:string|null, error?:string}}
 */
function fetchDeployedBuild_() {
  var url = getSetting_(ID_KEYS.GAS_WEBAPP_URL);
  if (!url) return { build: null, error: 'GAS_WEBAPP_URL（ID管理シート）が未設定' };
  try {
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return { build: null, error: 'HTTP ' + res.getResponseCode() };
    var body = JSON.parse(res.getContentText() || '{}');
    return { build: body.build || '' };
  } catch (e) {
    return { build: null, error: String(e && e.message || e).substring(0, 120) };
  }
}

/**
 * 保存済みコード（管理メニューが参照するライブラリ＝HEAD）とデプロイ済み Web アプリの版の比較結果（1行）。
 * Webhook を受けるのはデプロイ済みの版なので、不一致なら「新バージョン」でのデプロイが必要。
 */
function deployedBuildLine_() {
  var r = fetchDeployedBuild_();
  if (r.build === null) return '【要確認】Web アプリの版を取得できません（' + r.error + '）';
  if (r.build === APP.BUILD) return '【OK】Web アプリは保存済みコードと同じ版です（' + APP.BUILD + '）';
  return '【NG】Web アプリが古い版です（デプロイ済み: ' + (r.build || '版情報なし＝旧コード') + ' / 保存済み: ' + APP.BUILD + '）\n' +
    '  → 本体GASで「デプロイ → デプロイを管理 → 編集 → バージョン: 新バージョン → デプロイ」を実行してください（URL は変わりません）。';
}

/* ---------- エラーログ（管理メニュー） ---------- */

/** エラーログの件数要約（診断用） */
function errorLogSummary_() {
  var sh = getSpreadsheet_().getSheetByName(ERROR_LOG.SHEET);
  if (!sh) return '【未作成】エラーログシート（「エラーログ設定・動作確認」または「シート列・設定行の補完」で作成）';
  var rows = readRows_(ERROR_LOG.SHEET);
  var open = rows.filter(function (r) { return String(r['対応状況'] || '未対応') === '未対応'; });
  var fatal = open.filter(function (r) { return r['重要度'] === 'FATAL'; }).length;
  var last = rows.length ? rows[rows.length - 1]['発生日時'] : '';
  return (open.length ? (fatal ? '【要対応】' : '【確認】') : '【OK】') + '未対応 ' + open.length + ' 件（うち FATAL ' + fatal + ' 件）／全 ' + rows.length + ' 件' +
    (last ? '\n  最新: ' + cellToString_(last, 'yyyy-MM-dd HH:mm:ss') : '');
}

/** エラーログの設定確認（シートがなければ作成し、書式を整える。既存の行は変更しない） */
function adminErrorLogStatus_() {
  var r = ensureErrorLogSheet_();
  formatErrorLogSheet_(r.sheet);
  var lines = [
    r.created ? '【作成】エラーログシートを新規作成しました' : '【OK】エラーログシートあり',
    r.addedColumns.length ? '【補完】不足していた列を追加: ' + r.addedColumns.join('、') : '【OK】列構成: ' + ERROR_LOG.HEADERS.join(' / '),
    '【OK】ヘッダー固定・フィルター・重要度の色分け（FATAL=赤 / ERROR=橙）・対応状況の選択肢を設定',
    errorLogSummary_(),
    '',
    '◆ 記録の仕組み',
    '・記録するのは logError_（ERROR / FATAL）だけです。INFO・WARN、正常な Webhook 受信・LINE 送信は記録しません。',
    '・同じエラーは ERROR 10分 / FATAL 1分に1件だけ記録し、省略した件数は次の行に残します。',
    '・トークン・シークレット・メッセージ本文・LINE ユーザーID・メール・電話番号は記録しません。',
    '・記録に失敗しても本来の処理（Webhook の HTTP 200 応答など）は止まりません。',
    '・GAS の実行履歴にある過去のエラーは自動取得できません（Apps Script API はエラー内容を返さないため）。記録対象は今後発生するエラーです。'
  ];
  return { ok: true, title: 'エラーログ設定・動作確認', message: lines.join('\n'), data: { sheet: ERROR_LOG.SHEET } };
}

/** 動作確認用のテストエラーを1件記録（管理者がメニューから明示的に実行したときのみ） */
function adminErrorLogTest_(user) {
  var err = new Error('テストエラー（管理メニューの動作確認。対応不要）');
  var ok = false;
  try {
    ok = recordErrorToSheet_('errorlog.test', err, { action: 'errorLogTest' },
      { noDedup: true, functionName: 'adminErrorLogTest_', sourceSuffix: '動作確認' });
  } catch (e) {
    return { ok: false, title: 'テストエラーを記録できませんでした', message: sanitizeErrorText_(e && e.message) };
  }
  logInfo_('errorlog.test_written', { by: user ? 'admin' : '' });
  return { ok: ok, title: 'テストエラーを記録しました',
    message: '「' + ERROR_LOG.SHEET + '」シートの最終行に、重要度 ERROR・発生元「管理メニュー（動作確認）」の行を1件追加しました。\n' +
      '確認後は「対応状況」を「対象外」にするか、行を削除してください。' };
}
