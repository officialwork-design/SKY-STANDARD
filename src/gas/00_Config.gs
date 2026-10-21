/**
 * 00_Config.gs
 * 設定値・スクリプトプロパティ取得・必須設定チェック
 *
 * 秘密情報（トークン・シークレット）は「スクリプトプロパティ」のみで管理する。
 * URL など非秘密の運用設定はスプレッドシート「LINE設定」シートで管理し、
 * 同名のスクリプトプロパティが設定されていればそちらを優先する。
 *
 * NOTE: GAS はファイルを順に評価するため、トップレベルでは
 *       他ファイルの関数を呼び出さない（定数定義のみ）。
 */

var APP = {
  NAME: 'SKY STANDARD',
  /**
   * コードの版。Web アプリの doGet が返し、管理メニューが「保存済みコード（ライブラリ）」と
   * 「デプロイ済み Web アプリ」の版を比較して、反映漏れ（clasp push 後に新バージョンを
   * デプロイしていない等）を検出する。コードを変更したら更新する。
   */
  BUILD: '2026-10-21.4-errorlog',
  TIMEZONE: 'Asia/Tokyo',
  LINE_API_BASE: 'https://api.line.me',
  LINE_DATA_API_BASE: 'https://api-data.line.me',
  LINE_VERIFY_ID_TOKEN_URL: 'https://api.line.me/oauth2/v2.1/verify',
  /** 署名付きリクエストの許容時刻ずれ（ミリ秒） */
  MAX_CLOCK_SKEW_MS: 5 * 60 * 1000,
  /** Webhook イベント重複排除の保持期間（秒, CacheService 上限 21600） */
  DEDUP_TTL_SEC: 21600,
  /** 問い合わせ入力待ち状態の保持期間（秒） */
  INQUIRY_STATE_TTL_SEC: 30 * 60,
  /** 通知送信の最大再試行回数 */
  MAX_SEND_RETRY: 3,
  /** 本人確認（予約紐付け）試行回数の上限（1時間あたり） */
  LINK_ATTEMPT_LIMIT_PER_HOUR: 5
};

/** スプレッドシートのシート名（既存10シート＋ID管理） */
var SHEETS = {
  INTRO: 'はじめに',
  SETTINGS: 'LINE設定',
  RICHMENU: 'リッチメニュー',
  CUSTOMERS: '顧客管理',
  RESERVATIONS: '予約管理',
  INQUIRIES: '問い合わせ管理',
  TEMPLATES: '通知テンプレート',
  FAQ: 'FAQ',
  SEND_LOG: '送信ログ',
  TASKS: '実装タスク',
  ID_MANAGEMENT: 'ID管理'
};

/**
 * 各シートで本システムが必要とする列。
 * 既存ヘッダーを優先し、不足列のみ末尾に追加する（削除・並べ替えはしない）。
 */
var REQUIRED_COLUMNS = {};
REQUIRED_COLUMNS[SHEETS.SETTINGS] = ['設定キー', '設定値', '説明'];
REQUIRED_COLUMNS[SHEETS.RICHMENU] = ['表示名', 'アクション', '遷移先URL・送信テキスト', '実装状態', '備考'];
REQUIRED_COLUMNS[SHEETS.CUSTOMERS] = ['LINEユーザーID', '表示名', '氏名', '電話番号', 'メール', '言語', '登録日時',
  '顧客区分', '同意状況', '備考', '友だち状態', '最終更新'];
REQUIRED_COLUMNS[SHEETS.RESERVATIONS] = ['予約ID', 'LINEユーザーID', 'プランID', 'プラン名', '搭乗日', '時間帯', '人数',
  '金額', '予約状態', '決済状態', '予約サイト管理URL', '最終更新', '集合場所', '注意事項', '最終イベント日時'];
REQUIRED_COLUMNS[SHEETS.INQUIRIES] = ['受付ID', 'LINEユーザーID', '受付日時', '種別', '内容', '対応状況', '担当者',
  '回答日時', '備考'];
REQUIRED_COLUMNS[SHEETS.ID_MANAGEMENT] = ['設定キー', '設定値', '分類', '保存先・取扱い', '説明'];
REQUIRED_COLUMNS[SHEETS.TEMPLATES] = ['テンプレートID', '用途', '送信タイミング', '本文', '有効', '備考'];
REQUIRED_COLUMNS[SHEETS.FAQ] = ['FAQ ID', 'カテゴリ', '質問・キーワード', '回答', '有効', '要有人確認'];
REQUIRED_COLUMNS[SHEETS.SEND_LOG] = ['送信ID', 'LINEユーザーID', '通知種別', '予約ID', '送信日時', '結果', 'エラー内容',
  '冪等キー', 'イベントID', '再試行回数'];

/**
 * 「ID管理」シートで管理する公開可能な ID・URL（B列「設定値」から取得する）。
 *   key       : ID管理シート A列の設定キー
 *   label     : 日本語名（エラー表示用）
 *   pattern   : 形式チェック（不一致は未設定として扱い、ダミー遷移を防ぐ）
 *   usedBy    : 使用する機能（不足時の表示用）
 *   propFallback: シートが空のとき同名スクリプトプロパティを参照する（旧構成との互換用）
 */
var ID_KEYS = {
  SPREADSHEET_ID: { key: 'SPREADSHEET_ID', label: 'スプレッドシートID', pattern: /^[A-Za-z0-9_-]{30,}$/, usedBy: ['起動（スクリプトプロパティにも保持）'] },
  GAS_SCRIPT_ID: { key: 'GAS_SCRIPT_ID', label: 'GASスクリプトID', pattern: /^[A-Za-z0-9_-]{30,}$/, usedBy: ['管理用'] },
  LINE_LOGIN_CHANNEL_ID: { key: 'LINE_LOGIN_CHANNEL_ID', label: 'LINEログイン チャネルID', pattern: /^[0-9]{6,}$/, usedBy: ['予約確認(LIFF)'], propFallback: true },
  LIFF_ID: { key: 'LIFF_ID', label: '予約確認用 LIFF ID', pattern: /^[0-9]+-[A-Za-z0-9]+$/, usedBy: ['予約確認(LIFF)', 'リッチメニュー'] },
  GAS_WEBAPP_URL: { key: 'GAS_WEBAPP_URL', label: 'GAS WebアプリURL', pattern: /^https:\/\/script\.google\.com\/macros\/s\/[^\s/]+\/exec$/, usedBy: ['Webhook転送先・予約確認API'] },
  BOOKING_SITE_URL: { key: 'BOOKING_SITE_URL', label: 'フライト予約ページURL', pattern: /^https:\/\/[^\s]+$/i, usedBy: ['リッチメニュー', '自動応答'] },
  BOOKING_CONFIRM_URL: { key: 'BOOKING_CONFIRM_URL', label: '予約確認ページURL', pattern: /^https:\/\/[^\s]+$/i, usedBy: ['リッチメニュー（LIFF ID 未設定時）'] },
  PLAN_LIST_URL: { key: 'PLAN_LIST_URL', label: 'プラン一覧ページURL', pattern: /^https:\/\/[^\s]+$/i, usedBy: ['リッチメニュー', '自動応答'] },
  CHARTER_URL: { key: 'CHARTER_URL', label: 'チャーターページURL', pattern: /^https:\/\/[^\s]+$/i, usedBy: ['リッチメニュー', '自動応答'] },
  ADMIN_NOTIFY_TARGET: { key: 'ADMIN_NOTIFY_TARGET', label: '管理者LINE通知先ID', pattern: /^([UCR][0-9a-f]{32})([,、\s]+[UCR][0-9a-f]{32})*$/, usedBy: ['運営通知'] },
  RICHMENU_IMAGE_FILE_ID: { key: 'RICHMENU_IMAGE_FILE_ID', label: 'リッチメニュー画像ファイルID', pattern: /^[A-Za-z0-9_-]{20,}$/, usedBy: ['リッチメニュー登録'], propFallback: true },
  RESERVATION_API_BASE_URL: { key: 'RESERVATION_API_BASE_URL', label: '予約システムAPIのURL', pattern: /^https:\/\/[^\s]+$/i, usedBy: ['予約確認（API連携・任意）'], propFallback: true }
};

/**
 * 既存コードが参照する設定名 → ID管理キーの対応（参照先は ID管理 に統一）。
 * 旧「LINE設定」シートは参照しない（診断で未移行の値があれば警告する）。
 */
var SETTING_KEYS = {
  BOOKING_URL: ID_KEYS.BOOKING_SITE_URL,
  BOOKING_CHECK_URL: ID_KEYS.BOOKING_CONFIRM_URL,
  PLANS_URL: ID_KEYS.PLAN_LIST_URL,
  CHARTER_URL: ID_KEYS.CHARTER_URL,
  LIFF_ID: ID_KEYS.LIFF_ID,
  ADMIN_TARGET: ID_KEYS.ADMIN_NOTIFY_TARGET
};

/** 旧「LINE設定」シートのキー → ID管理キー（移行チェック用） */
var LEGACY_SETTING_MAP = {
  '予約サイトURL': 'BOOKING_SITE_URL', '予約確認URL': 'BOOKING_CONFIRM_URL', 'プラン一覧URL': 'PLAN_LIST_URL',
  'チャーターURL': 'CHARTER_URL', 'LIFF ID': 'LIFF_ID', '管理者通知先': 'ADMIN_NOTIFY_TARGET'
};

/** 秘密情報：スクリプトプロパティ（またはリレーの Secret Manager）のみ。シートの値は絶対に使わない */
var SECRET_KEYS = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'RELAY_SHARED_SECRET', 'RESERVATION_WEBHOOK_SECRET',
  'RESERVATION_API_KEY'];

/** ID管理シートのキャッシュ（実行間で共有。値変更時は invalidateIdCache_ で無効化） */
var ID_CACHE_KEY = 'idcfg:v1';
var ID_CACHE_TTL_SEC = 300;

/** スクリプトプロパティ（秘密情報はここにのみ保存する） */
var PROP_KEYS = {
  CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN',
  CHANNEL_SECRET: 'LINE_CHANNEL_SECRET',
  LOGIN_CHANNEL_ID: 'LINE_LOGIN_CHANNEL_ID',
  RELAY_SHARED_SECRET: 'RELAY_SHARED_SECRET',
  RESERVATION_WEBHOOK_SECRET: 'RESERVATION_WEBHOOK_SECRET',
  RESERVATION_API_BASE_URL: 'RESERVATION_API_BASE_URL',
  RESERVATION_API_KEY: 'RESERVATION_API_KEY',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  ADMIN_EMAIL: 'ADMIN_EMAIL',
  RICHMENU_IMAGE_FILE_ID: 'RICHMENU_IMAGE_FILE_ID',
  ALLOW_UNSIGNED_WEBHOOK: 'ALLOW_UNSIGNED_WEBHOOK',
  ADMIN_USERS: 'ADMIN_USERS',
  RESERVATION_API_ALLOWED_HOST: 'RESERVATION_API_ALLOWED_HOST',
  /** Webhook 受信方式: direct（既定・GAS単体・署名検証なし）/ relay（署名検証リレー経由） */
  WEBHOOK_MODE: 'WEBHOOK_MODE',
  /** 自動保存: ボットのユーザーID（destination の照合用。秘密情報ではない） */
  BOT_USER_ID: 'BOT_USER_ID',
  /** 自動保存: 最終 Webhook 受信時刻・イベント数（診断用） */
  LAST_WEBHOOK_AT: 'LAST_WEBHOOK_AT',
  LAST_WEBHOOK_EVENTS: 'LAST_WEBHOOK_EVENTS'
};

/** 既定の友だち追加メッセージ（通知テンプレート WELCOME が有効ならそちらを優先） */
var DEFAULT_WELCOME_MESSAGE =
  'SKY STANDARD公式LINEへようこそ。\n\n' +
  'ヘリコプター遊覧飛行・チャーターサービスをご案内しています。\n\n' +
  'フライトのご予約、予約確認、お問い合わせは、画面下のメニューからご利用ください。';

/** 設定エラー（未設定時に安全停止させるための専用例外） */
function ConfigError(message, missingKeys) {
  this.name = 'ConfigError';
  this.message = message;
  this.missingKeys = missingKeys || [];
}
ConfigError.prototype = Object.create(Error.prototype);
ConfigError.prototype.constructor = ConfigError;

/** スクリプトプロパティ取得（未設定は空文字） */
function getProp_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v == null ? '' : String(v).trim();
}

/** 必須スクリプトプロパティ取得。未設定なら ConfigError を投げる */
function requireProp_(name) {
  var v = getProp_(name);
  if (!v) throw new ConfigError('必須設定が未設定です: ' + name, [name]);
  return v;
}

/** 実行内メモ（1実行内でシート読み込みを1回に抑える） */
var __settingsCache = null;

/**
 * 「ID管理」シートの設定値を {設定キー: 設定値} で取得する。
 *   - 秘密情報のキーは値が入っていても読み込まない（警告ログのみ）
 *   - CacheService に5分間キャッシュ。fresh=true でシートから再読込してキャッシュを更新
 */
function readIdSettings_(fresh) {
  if (__settingsCache && !fresh) return __settingsCache;
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var hit = cache.get(ID_CACHE_KEY);
    if (hit) {
      try { __settingsCache = JSON.parse(hit); return __settingsCache; } catch (e) { /* 再読込 */ }
    }
  }
  var map = {};
  try {
    map = readIdSheet_();
  } catch (e) {
    logError_('idsheet.read', e);
    __settingsCache = {};
    return __settingsCache; // キャッシュしない（次回再試行）
  }
  SECRET_KEYS.forEach(function (k) {
    if (map[k]) logWarn_('idsheet.secret_in_sheet', { key: k });
    delete map[k];
  });
  __settingsCache = map;
  cache.put(ID_CACHE_KEY, JSON.stringify(map), ID_CACHE_TTL_SEC);
  return map;
}

/** ID管理シートのキャッシュを無効化（値変更時・管理メニューから） */
function invalidateIdCache_() {
  CacheService.getScriptCache().remove(ID_CACHE_KEY);
  __settingsCache = null;
}

/** ID管理の生の値（形式チェック前） */
function getIdRaw_(def) {
  var v = readIdSettings_()[def.key] || '';
  if (!v && def.propFallback) v = getProp_(def.key);
  return String(v).trim();
}

/**
 * 公開設定の取得（ID管理シート → 互換用プロパティ）。形式が不正なら空文字。
 * @param {Object} def ID_KEYS / SETTING_KEYS の要素
 */
function getSetting_(def) {
  var v = getIdRaw_(def);
  if (!v) return '';
  if (def.pattern && !def.pattern.test(v)) {
    logWarn_('config.invalid_format', { key: def.key });
    return '';
  }
  return v;
}

/** URL 設定（https のみ。未設定・不正は空文字＝ダミー遷移を防ぐ） */
function getUrlSetting_(def) {
  var v = getSetting_(def);
  return /^https:\/\//i.test(v) ? v : '';
}

/** 必須の公開設定。未設定・形式不正なら ConfigError（日本語でキー名を表示） */
function requireSetting_(def) {
  var v = getSetting_(def);
  if (!v) {
    var raw = getIdRaw_(def);
    throw new ConfigError((raw ? '形式が正しくありません' : '未設定です') + ': 「ID管理」シートの ' + def.key + '（' + def.label + '）', [def.key]);
  }
  return v;
}

/** 予約確認ページの URL（LIFF ID があれば LIFF URL を優先） */
function getBookingCheckUrl_() {
  var liffId = getSetting_(SETTING_KEYS.LIFF_ID);
  if (liffId) return 'https://liff.line.me/' + liffId;
  return getUrlSetting_(SETTING_KEYS.BOOKING_CHECK_URL);
}

/**
 * 設定チェック。機能ごとの不足項目を日本語で返す（秘密値そのものは返さない）。
 * @return {{ok:boolean, missing:Object<string,string[]>}}
 */
function checkConfig_() {
  var missing = {};
  function need(group, ok, label) {
    if (!ok) (missing[group] = missing[group] || []).push(label);
  }
  function idLabel(def) {
    return def.key + '（' + def.label + '・ID管理シート' + (getIdRaw_(def) ? '／形式が正しくありません' : '') + '）';
  }
  need('起動', !!getProp_(PROP_KEYS.SPREADSHEET_ID), 'SPREADSHEET_ID（スクリプトプロパティ）');
  need('管理メニュー', !!getProp_(PROP_KEYS.ADMIN_USERS), 'ADMIN_USERS（スクリプトプロパティ。管理者のメールアドレス）');
  need('Messaging API', !!getProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN), 'LINE_CHANNEL_ACCESS_TOKEN（スクリプトプロパティ）');
  // Webhook：GAS単体（direct・既定）は追加設定不要。relay を選んだ場合のみ共有シークレットが必要
  if (getWebhookMode_() === WEBHOOK_MODES.RELAY) {
    need('Webhook（リレー経由）', !!getProp_(PROP_KEYS.RELAY_SHARED_SECRET), 'RELAY_SHARED_SECRET（スクリプトプロパティ。WEBHOOK_MODE=relay のとき必須）');
  }
  need('予約確認(LIFF)', !!getSetting_(ID_KEYS.LINE_LOGIN_CHANNEL_ID), idLabel(ID_KEYS.LINE_LOGIN_CHANNEL_ID));
  need('予約確認(LIFF)', !!getSetting_(ID_KEYS.LIFF_ID), idLabel(ID_KEYS.LIFF_ID));
  need('予約確認(LIFF)', !!getSetting_(ID_KEYS.GAS_WEBAPP_URL), idLabel(ID_KEYS.GAS_WEBAPP_URL));
  need('予約通知', !!getProp_(PROP_KEYS.RESERVATION_WEBHOOK_SECRET), 'RESERVATION_WEBHOOK_SECRET（スクリプトプロパティ）');
  need('リッチメニュー', !!getUrlSetting_(ID_KEYS.BOOKING_SITE_URL), idLabel(ID_KEYS.BOOKING_SITE_URL));
  need('リッチメニュー', !!getUrlSetting_(ID_KEYS.PLAN_LIST_URL), idLabel(ID_KEYS.PLAN_LIST_URL));
  need('リッチメニュー', !!getUrlSetting_(ID_KEYS.CHARTER_URL), idLabel(ID_KEYS.CHARTER_URL));
  need('リッチメニュー', !!getBookingCheckUrl_(), 'LIFF_ID または BOOKING_CONFIRM_URL（ID管理シート）');
  need('リッチメニュー', !!getSetting_(ID_KEYS.RICHMENU_IMAGE_FILE_ID), idLabel(ID_KEYS.RICHMENU_IMAGE_FILE_ID));
  need('運営通知', !!getSetting_(ID_KEYS.ADMIN_NOTIFY_TARGET) || !!getProp_(PROP_KEYS.ADMIN_EMAIL),
    'ADMIN_NOTIFY_TARGET（管理者LINE通知先ID・ID管理シート）または ADMIN_EMAIL（スクリプトプロパティ）');
  if (getSetting_(ID_KEYS.RESERVATION_API_BASE_URL)) {
    need('予約システムAPI', !!getProp_(PROP_KEYS.RESERVATION_API_KEY), 'RESERVATION_API_KEY（スクリプトプロパティ）');
    need('予約システムAPI', !!getProp_(PROP_KEYS.RESERVATION_API_ALLOWED_HOST),
      'RESERVATION_API_ALLOWED_HOST（スクリプトプロパティ。API キーを送ってよいホスト名）');
  }
  return { ok: Object.keys(missing).length === 0, missing: missing, warnings: configWarnings_() };
}

/**
 * 不足ではないが運用上知っておくべき注意（障害扱いにしない）。
 */
function configWarnings_() {
  var w = [];
  if (getWebhookMode_() === WEBHOOK_MODES.DIRECT) {
    w.push('Webhook は GAS単体（direct）で受信しています。GAS はリクエストヘッダーを読めないため LINE の署名（X-Line-Signature）を検証できません。' +
      '受信イベントは「未検証」として扱い、記録・通知は応答トークン確認後のみ、予約状態の変更・個人情報の開示・管理操作は Webhook からは行いません。');
  }
  if (getProp_(PROP_KEYS.ALLOW_UNSIGNED_WEBHOOK)) {
    w.push('ALLOW_UNSIGNED_WEBHOOK は廃止しました（WEBHOOK_MODE で制御）。スクリプトプロパティから削除してください。');
  }
  return w;
}
