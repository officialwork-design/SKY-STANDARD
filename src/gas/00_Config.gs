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

/** スプレッドシートのシート名（既存10シート） */
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
  TASKS: '実装タスク'
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
REQUIRED_COLUMNS[SHEETS.TEMPLATES] = ['テンプレートID', '用途', '送信タイミング', '本文', '有効', '備考'];
REQUIRED_COLUMNS[SHEETS.FAQ] = ['FAQ ID', 'カテゴリ', '質問・キーワード', '回答', '有効', '要有人確認'];
REQUIRED_COLUMNS[SHEETS.SEND_LOG] = ['送信ID', 'LINEユーザーID', '通知種別', '予約ID', '送信日時', '結果', 'エラー内容',
  '冪等キー', 'イベントID', '再試行回数'];

/**
 * 「LINE設定」シートの設定キー（不足していれば行を追加する。既存値は上書きしない）。
 * key: シートの設定キー / prop: 優先されるスクリプトプロパティ名
 */
var SETTING_KEYS = {
  BOOKING_URL: { key: '予約サイトURL', prop: 'BOOKING_SITE_URL', desc: '公開後に設定' },
  BOOKING_CHECK_URL: { key: '予約確認URL', prop: 'BOOKING_CHECK_URL', desc: '認証済みマイページのURL（LIFF ID 設定時は LIFF URL を優先）' },
  PLANS_URL: { key: 'プラン一覧URL', prop: 'PLANS_URL', desc: '' },
  CHARTER_URL: { key: 'チャーターURL', prop: 'CHARTER_URL', desc: '' },
  LIFF_ID: { key: 'LIFF ID', prop: 'LIFF_ID', desc: '予約確認連携時に設定' },
  ADMIN_TARGET: { key: '管理者通知先', prop: 'ADMIN_LINE_TO', desc: '運営通知を送る LINE ユーザーID / グループID（アクセス制限に注意）' }
};

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
  ALLOW_UNSIGNED_WEBHOOK: 'ALLOW_UNSIGNED_WEBHOOK'
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

/** リクエスト内キャッシュ（1実行内でシート読み込みを1回に抑える） */
var __settingsCache = null;

/** 「LINE設定」シートを {設定キー: 設定値} で取得 */
function readSettingsSheet_() {
  if (__settingsCache) return __settingsCache;
  var map = {};
  try {
    var rows = readRows_(SHEETS.SETTINGS);
    rows.forEach(function (r) {
      var k = String(r['設定キー'] || '').trim();
      if (k) map[k] = String(r['設定値'] == null ? '' : r['設定値']).trim();
    });
  } catch (e) {
    logError_('settings.read', e);
  }
  __settingsCache = map;
  return map;
}

/**
 * 運用設定の取得（スクリプトプロパティ → LINE設定シートの順）。
 * @param {{key:string, prop:string}} def SETTING_KEYS の要素
 */
function getSetting_(def) {
  var p = getProp_(def.prop);
  if (p) return p;
  var sheet = readSettingsSheet_();
  return sheet[def.key] || '';
}

/** URL 設定を取得。https 以外・未設定は空文字（ダミー遷移を防ぐ） */
function getUrlSetting_(def) {
  var v = getSetting_(def);
  if (!v) return '';
  if (!/^https:\/\/[^\s]+$/i.test(v)) {
    logWarn_('config.invalid_url', { key: def.key });
    return '';
  }
  return v;
}

/** 予約確認ページの URL（LIFF ID があれば LIFF URL を優先） */
function getBookingCheckUrl_() {
  var liffId = getSetting_(SETTING_KEYS.LIFF_ID);
  if (liffId && /^[0-9]+-[A-Za-z0-9]+$/.test(liffId)) return 'https://liff.line.me/' + liffId;
  return getUrlSetting_(SETTING_KEYS.BOOKING_CHECK_URL);
}

/**
 * 設定チェック。機能ごとの不足項目を返す（秘密値そのものは返さない）。
 * @return {{ok:boolean, missing:Object<string,string[]>}}
 */
function checkConfig_() {
  var missing = {};
  function need(group, ok, label) {
    if (!ok) (missing[group] = missing[group] || []).push(label);
  }
  need('Messaging API', !!getProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN), PROP_KEYS.CHANNEL_ACCESS_TOKEN + '（スクリプトプロパティ）');
  need('Webhook署名検証', !!getProp_(PROP_KEYS.RELAY_SHARED_SECRET), PROP_KEYS.RELAY_SHARED_SECRET + '（スクリプトプロパティ）');
  need('【警告】本番では無効にする設定', getProp_(PROP_KEYS.ALLOW_UNSIGNED_WEBHOOK) !== 'true',
    PROP_KEYS.ALLOW_UNSIGNED_WEBHOOK + ' が true です（署名なし Webhook を受け付けています）。削除してください');
  need('予約確認(LIFF)', !!getProp_(PROP_KEYS.LOGIN_CHANNEL_ID), PROP_KEYS.LOGIN_CHANNEL_ID + '（スクリプトプロパティ）');
  need('予約確認(LIFF)', !!getSetting_(SETTING_KEYS.LIFF_ID), 'LIFF ID（LINE設定）');
  need('予約通知', !!getProp_(PROP_KEYS.RESERVATION_WEBHOOK_SECRET), PROP_KEYS.RESERVATION_WEBHOOK_SECRET + '（スクリプトプロパティ）');
  need('リッチメニュー', !!getUrlSetting_(SETTING_KEYS.BOOKING_URL), '予約サイトURL（LINE設定）');
  need('リッチメニュー', !!getUrlSetting_(SETTING_KEYS.PLANS_URL), 'プラン一覧URL（LINE設定）');
  need('リッチメニュー', !!getUrlSetting_(SETTING_KEYS.CHARTER_URL), 'チャーターURL（LINE設定）');
  need('リッチメニュー', !!getBookingCheckUrl_(), 'LIFF ID または 予約確認URL（LINE設定）');
  need('運営通知', !!getSetting_(SETTING_KEYS.ADMIN_TARGET) || !!getProp_(PROP_KEYS.ADMIN_EMAIL), '管理者通知先（LINE設定）または ADMIN_EMAIL');
  return { ok: Object.keys(missing).length === 0, missing: missing };
}
