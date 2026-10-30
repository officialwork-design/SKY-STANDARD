/**
 * GAS 実行環境のモック。src/gas/*.gs を vm コンテキストに読み込み、
 * SpreadsheetApp / UrlFetchApp / PropertiesService 等をインメモリで再現する。
 * ※ これはモックテストであり、実際の LINE / Google 環境での動作確認ではない。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const TEXT_COLS = ['予約ID', 'LINEユーザーID', 'プランID', '時間帯', '搭乗日', '受付ID', '送信ID', '冪等キー', 'イベントID', 'LINEイベントID', '電話番号', 'FAQ ID', 'テンプレートID', '最終イベント日時'];
const GAS_DIR = path.join(__dirname, '..', '..', 'src', 'gas');

/** 実スプレッドシート（2026-10-21 時点）のヘッダーと既存データ */
function seedSheets() {
  return {
    'はじめに': [['項目', '内容'], ['目的', 'SKY STANDARD公式LINEの予約導線・顧客・問い合わせ・通知の管理台帳']],
    'LINE設定': [['設定キー', '設定値', '説明'],
      ['予約サイトURL', '', '公開後に設定'], ['予約確認URL', '', '認証済みマイページのURL'], ['プラン一覧URL', '', ''],
      ['チャーターURL', '', ''], ['LIFF ID', '', '予約確認連携時に設定'], ['管理者通知先', '', 'アクセス制限に注意']],
    'リッチメニュー': [['表示名', 'アクション', '遷移先URL・送信テキスト', '実装状態', '備考'],
      ['フライト予約', 'URI', '[予約サイトURL]', '未設定', '予約サイトへ遷移'], ['予約確認', 'URI', '[予約確認URL]', '未設定', '本人認証が必要'],
      ['プラン一覧', 'URI', '[プラン一覧URL]', '未設定', ''], ['チャーター', 'URI', '[チャーターURL]', '未設定', ''],
      ['お問い合わせ', 'メッセージ', 'お問い合わせ', '未設定', 'Webhookで受付'], ['よくある質問', 'メッセージ', 'FAQ', '未設定', 'Webhookで回答']],
    '顧客管理': [['LINEユーザーID', '表示名', '氏名', '電話番号', 'メール', '言語', '登録日時', '顧客区分', '同意状況', '備考']],
    '予約管理': [['予約ID', 'LINEユーザーID', 'プランID', 'プラン名', '搭乗日', '時間帯', '人数', '金額', '予約状態', '決済状態', '予約サイト管理URL', '最終更新']],
    '問い合わせ管理': [['受付ID', 'LINEユーザーID', '受付日時', '種別', '内容', '対応状況', '担当者', '回答日時', '備考']],
    '通知テンプレート': [['テンプレートID', '用途', '送信タイミング', '本文', '有効', '備考'],
      ['WELCOME', '友だち追加', '友だち追加時', '友だち追加ありがとうございます。SKY STANDARD公式LINEです。フライト予約・予約確認・お問い合わせはメニューからご利用ください。', 'ON', ''],
      ['BOOKING_RECEIVED', '予約受付', '予約サイトで受付時', 'ご予約リクエストを受け付けました。予約ID：{{予約ID}}。確定のご連絡をお待ちください。', 'ON', '確定前と区別'],
      ['BOOKING_CONFIRMED', '予約確定', '事業者承認後', 'ご予約が確定しました。予約ID：{{予約ID}}／搭乗日時：{{搭乗日時}}。詳細は予約確認からご覧ください。', 'ON', ''],
      ['FLIGHT_REMINDER', '搭乗前案内', '搭乗前日', '明日はご搭乗予定日です。集合場所と注意事項を予約確認ページでご確認ください。', 'ON', '運航確定の保証ではない'],
      ['FLIGHT_CHANGE', '運航変更', '担当者承認後', '運航に関する重要なお知らせがあります。詳細は予約確認ページをご確認ください。', 'ON', '自動で欠航確定しない']],
    'FAQ': [['FAQ ID', 'カテゴリ', '質問・キーワード', '回答', '有効', '要有人確認'],
      ['F001', '予約', '予約方法', 'リッチメニューの「フライト予約」からプラン・日程をお選びください。', 'ON', 'NO'],
      ['F002', '予約', '予約確認', 'リッチメニューの「予約確認」から本人認証のうえご確認ください。', 'ON', 'NO'],
      ['F003', '運航', '雨天・悪天候', '天候等により運航内容が変更される場合があります。最新情報は担当者からご案内します。', 'ON', 'YES'],
      ['F004', 'キャンセル', 'キャンセル料', 'キャンセル条件はプラン・予約条件によって異なります。予約詳細をご確認ください。', 'ON', 'YES']],
    '送信ログ': [['送信ID', 'LINEユーザーID', '通知種別', '予約ID', '送信日時', '結果', 'エラー内容']],
    'ID管理': [['設定キー', '設定値', '分類', '保存先・取扱い', '説明'],
      ['SPREADSHEET_ID', '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', 'ID', 'GASスクリプトプロパティ（起動用）', ''],
      ['GAS_SCRIPT_ID', '1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff', 'ID', 'シート', ''],
      ['LINE_LOGIN_CHANNEL_ID', '', 'ID', '', ''], ['LIFF_ID', '', 'ID', '', ''], ['GAS_WEBAPP_URL', '', 'URL', 'シート', ''],
      ['BOOKING_SITE_URL', '', 'URL', 'シート', ''], ['BOOKING_CONFIRM_URL', '', 'URL', 'シート', ''], ['PLAN_LIST_URL', '', 'URL', 'シート', ''],
      ['CHARTER_URL', '', 'URL', 'シート', ''], ['ADMIN_NOTIFY_TARGET', '', 'ID', 'シート', ''], ['RICHMENU_IMAGE_FILE_ID', '', 'ID', '', ''],
      ['RESERVATION_API_BASE_URL', '', 'URL', '', ''],
      ['LINE_CHANNEL_ACCESS_TOKEN', '', '秘密情報', 'GASスクリプトプロパティのみ', 'このシートに入力しない'],
      ['LINE_CHANNEL_SECRET', '', '秘密情報', '', ''], ['RELAY_SHARED_SECRET', '', '秘密情報', '', ''],
      ['RESERVATION_WEBHOOK_SECRET', '', '秘密情報', '', ''], ['RESERVATION_API_KEY', '', '秘密情報', '', '']],
    '実装タスク': [['優先度', '機能', '実装内容', '担当システム', '状態', '備考'], ['高', '予約サイト遷移', 'リッチメニューURI設定', 'LINE', '未着手', 'URL確定後']]
  };
}

function toSigned(buf) { return Array.from(buf).map((b) => (b > 127 ? b - 256 : b)); }
function toBuf(v) { return Array.isArray(v) ? Buffer.from(v.map((b) => (b + 256) % 256)) : Buffer.from(String(v), 'utf8'); }

function fmtDate(date, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  if (parts.hour === '24') parts.hour = '00';
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

function createSheet(name, data, onRename) {
  const fmt = { frozenRows: 0, filter: null, rules: [], validations: [], widths: {}, headerStyle: {} };
  let curName = name;
  const sheet = {
    data,
    fmt,
    getName: () => curName,
    setName(n) { if (onRename) onRename(curName, n); curName = n; return sheet; },
    getMaxRows: () => 1000,
    setFrozenRows(n) { fmt.frozenRows = n; },
    getFilter: () => fmt.filter,
    getConditionalFormatRules: () => fmt.rules.slice(),
    setConditionalFormatRules(rs) { fmt.rules = rs.slice(); },
    setColumnWidth(c, w) { fmt.widths[c] = w; },
    activate() { fmt.activated = true; },
    setActiveRange() {},
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, nr = 1, nc = 1) {
      if (typeof row === 'string') {
        // A1 表記（例 'A2:H' / 'H2:H'）。行数を省略した列範囲は 1000 行として扱う
        const m = row.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/);
        const colNum = (L) => L.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
        const r1 = Number(m[2]); const c1 = colNum(m[1]); const c2 = m[3] ? colNum(m[3]) : c1;
        const r2 = m[4] ? Number(m[4]) : 1000;
        return sheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
      }
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const src = data[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nc; c++) {
              let v = src[col - 1 + c] === undefined ? '' : src[col - 1 + c];
              if (typeof v === 'string' && v.charAt(0) === "'") v = v.substring(1); // Sheets は先頭 ' を値に含めない
              line.push(v);
            }
            out.push(line);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; },
        setValue(v) {
          while (data.length < row) data.push([]);
          const r = data[row - 1];
          while (r.length < col) r.push('');
          r[col - 1] = v;
        },
        getRow: () => row,
        setValues(vals) {
          vals.forEach((line, i) => {
            while (data.length < row + i) data.push([]);
            const rr = data[row - 1 + i];
            line.forEach((v, j) => { while (rr.length < col + j) rr.push(''); rr[col - 1 + j] = v; });
          });
          return this;
        },
        setFontWeight(w) { if (row === 1) fmt.headerStyle.bold = w; return this; },
        setBackground(c) { if (row === 1) fmt.headerStyle.bg = c; return this; },
        setFontColor() { return this; },
        createFilter() { fmt.filter = { row, col, nr, nc, remove() { fmt.filter = null; }, getRange: () => ({ getNumColumns: () => nc }) }; return fmt.filter; },
        setDataValidation(v) { fmt.validations.push({ col, v }); return this; },
        __range: { row, col, nr, nc }
      };
    },
    appendRow(arr) { data.push(arr.slice()); }
  };
  return sheet;
}

/**
 * @param {{props?:Object, fetch?:Function, sheets?:Object}} opts
 */
function createGasEnv(opts = {}) {
  const sheetsData = opts.sheets || seedSheets();
  const sheets = {};
  Object.keys(sheetsData).forEach((n) => { sheets[n] = createSheet(n, sheetsData[n]); });
  const props = Object.assign({}, opts.props || {});
  const cache = new Map();
  const fetchCalls = [];
  const triggers = [];
  const logs = [];
  const mails = [];
  let fetchHandler = opts.fetch || (() => ({ code: 200, body: '{}' }));

  const env = { user: opts.user === undefined ? 'owner@example.com' : opts.user };
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { if (opts.failInsert) throw new Error('insert failed'); sheetsData[n] = []; sheets[n] = createSheet(n, sheetsData[n]); return sheets[n]; },
    getSpreadsheetTimeZone: () => 'Asia/Tokyo',
    getId: () => '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es/edit',
    getOwner: () => ({ getEmail: () => opts.owner || 'owner@example.com' })
  };
  /** SpreadsheetApp.create で作られたスプレッドシート（テスト環境キットの検証用） */
  const created = {};
  function newSpreadsheet(title) {
    const id = '1TEST' + crypto.randomBytes(20).toString('hex');
    const own = {};
    const rename = (from, to) => { own[to] = own[from]; delete own[from]; };
    own['シート1'] = createSheet('シート1', [], rename);
    const s2 = {
      title, sheets: own,
      getSheets: () => Object.values(own),
      getSheetByName: (n) => own[n] || null,
      insertSheet: (n) => { own[n] = createSheet(n, [], rename); return own[n]; },
      getSpreadsheetTimeZone: () => 'Asia/Tokyo',
      getId: () => id,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      getOwner: () => ({ getEmail: () => opts.owner || 'owner@example.com' })
    };
    created[id] = s2;
    return s2;
  }
  const driveFiles = Object.assign({}, opts.driveFiles || {});

  const ctx = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' '))
    },
    Date, JSON, Math, Object, Array, String, Number, Error, RegExp, Intl, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (opts.noActive ? null : ss), openById: (id) => created[id] || ss,
      create: (title) => newSpreadsheet(title), getUi: () => { throw new Error('no ui'); },
      newConditionalFormatRule: () => {
        const rule = {};
        const b = {
          whenFormulaSatisfied(f) { rule.formula = f; return b; }, setBackground(c) { rule.bg = c; return b; },
          setFontColor() { return b; }, setRanges(r) { rule.ranges = r; return b; },
          build() { return Object.assign({}, rule, { getBooleanCondition: () => ({ getCriteriaValues: () => [rule.formula] }) }); }
        };
        return b;
      },
      newDataValidation: () => {
        const v = {};
        const b = { requireValueInList(l) { v.list = l; return b; }, setAllowInvalid() { return b; }, build() { return v; } };
        return b;
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => Object.assign({}, props)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch(url, params) {
        const call = { url, params: params || {} };
        fetchCalls.push(call);
        const r = fetchHandler(url, params || {}, call) || { code: 200, body: '{}' };
        return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      }
    },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
      computeDigest: (alg, value) => toSigned(crypto.createHash(alg).update(toBuf(value)).digest()),
      base64Encode: (bytes) => toBuf(bytes).toString('base64'),
      getUuid: () => crypto.randomUUID(),
      formatDate: fmtDate
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return s; } })
    },
    HtmlService: { createHtmlOutput: (s) => ({ kind: 'html', content: s, getContent() { return s; } }) },
    MailApp: { sendEmail: (m) => mails.push(m) },
    Session: {
      getActiveUser: () => ({ getEmail: () => env.user }),
      getEffectiveUser: () => ({ getEmail: () => env.user })
    },
    ScriptApp: {
      getScriptId: () => opts.scriptId || '1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff',
      getService: () => ({ getUrl: () => opts.webAppUrl || null }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: (fn) => {
        const b = { timeBased: () => b, atHour: () => b, everyDays: () => b, inTimezone: () => b, everyMinutes: () => b,
          create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } };
        return b;
      }
    },
    DriveApp: {
      getRootFolder: () => folderOf('root'),
      getFileById: (id) => fileOf(id)
    },
    Logger: { log: (m) => { logs.push(String(m)); } }
  };
  /** Drive のモック。f = { name, bytes, contentType, asJpeg?, folder?, updated? } */
  function folderOf(fid) {
    const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
    return {
      getId: () => fid,
      getName: () => (fid === 'root' ? 'マイドライブ' : fid),
      getFilesByName: (n) => iter(Object.keys(driveFiles).filter((k) => driveFiles[k].name === n && (driveFiles[k].folder || 'root') === fid).map(fileOf)),
      createFile(blob) {
        const id = 'f' + crypto.randomBytes(16).toString('hex');
        driveFiles[id] = { name: blob.name, bytes: toBuf(blob.getBytes()), contentType: blob.getContentType(), folder: fid, updated: Date.now() };
        return fileOf(id);
      }
    };
  }
  function fileOf(id) {
    const f = driveFiles[id];
    if (!f) throw new Error('File not found: ' + id);
    return {
      getId: () => id,
      getName: () => f.name,
      getLastUpdated: () => new Date(f.updated || 1761000000000),
      getParents: () => { let done = false; return { hasNext: () => !done, next: () => { done = true; return folderOf(f.folder || 'root'); } }; },
      getBlob: () => {
        const mkBlob = (bytes, ct) => {
          const blob = {
            contentType: ct,
            name: f.name,
            getBytes: () => Array.from(bytes).map((b) => (b > 127 ? b - 256 : b)),
            getContentType: () => blob.contentType,
            setContentType(t) { blob.contentType = t; return blob; },
            setName(n) { blob.name = n; return blob; },
            // Blob.getAs（画像形式の変換）。f.asJpeg に変換後のバイト列を用意したときだけ成功する
            getAs(t) {
              if (t !== 'image/jpeg' || !f.asJpeg) throw new Error('conversion not supported in mock');
              return mkBlob(f.asJpeg, 'image/jpeg');
            }
          };
          return blob;
        };
        return mkBlob(f.bytes, f.contentType);
      }
    };
  }
  vm.createContext(ctx);
  fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), ctx, { filename: f });
  });
  (opts.extraFiles || []).forEach((f) => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: path.basename(f) }));

  return {
    ctx, sheets, props, cache, fetchCalls, logs, mails, env, triggers, created, driveFiles,
    setUser(u) { env.user = u; },
    setFetch(fn) { fetchHandler = fn; },
    /** シートの行をオブジェクト配列で取得 */
    rows(name) {
      const d = sheets[name].data;
      const h = d[0];
      // テキスト列の先頭 ' は表示値に含まれないため除去（数式エスケープ確認用に rawRows も用意）
      return d.slice(1).map((r) => Object.fromEntries(h.map((k, i) => {
        let v = r[i] === undefined ? '' : r[i];
        if (typeof v === 'string' && v.charAt(0) === "'" && TEXT_COLS.includes(k)) v = v.substring(1);
        return [k, v];
      })));
    },
    /** ID管理シートの値を変更（運営がシートを編集したのと同じ。キャッシュ無効化は呼び出し側の責務） */
    editIdSheet(key, value) {
      const d = sheets['ID管理'].data;
      const row = d.find((r) => r[0] === key);
      if (row) row[1] = value; else d.push([key, value, '', '', '']);
    },
    /** ID管理を変更し、設定キャッシュも破棄（＝onEdit トリガーで反映されたのと同じ状態） */
    setSetting(key, value) {
      this.editIdSheet(key, value);
      vm.runInContext('invalidateIdCache_(); __ss = null;', ctx);
    },
    resetRequestCache() { vm.runInContext('__settingsCache = null;', ctx); },
    /** doPost を呼ぶ。JSON 応答は解析して返し、HtmlService 応答（LINE 直接 Webhook）は { __html, content } を返す */
    doPost(obj) {
      const out = ctx.doPost({ postData: { contents: typeof obj === 'string' ? obj : JSON.stringify(obj) } });
      vm.runInContext('__settingsCache = null;', ctx);
      if (out && out.kind === 'html') return { __html: true, content: out.getContent() };
      return JSON.parse(out.getContent());
    },
    linePosts(pathPart) {
      return fetchCalls.filter((c) => c.url.indexOf(pathPart) !== -1).map((c) => ({ ...c, json: c.params.payload ? JSON.parse(c.params.payload) : null }));
    }
  };
}

/** テスト用の画像バイト列（ヘッダーのみ有効。PNG / JPEG のサイズ判定用） */
function fakeImage(type, width, height, totalBytes = 400 * 1024) {
  const buf = Buffer.alloc(totalBytes);
  if (type === 'png') {
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buf, 0);
    buf.writeUInt32BE(width, 16); buf.writeUInt32BE(height, 20);
  } else {
    // SOI + APP0(16byte) + DQT(短い) + SOF0
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00,
      0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03]).copy(buf, 0);
  }
  return buf;
}

/** リレーと同じ方式で封筒を作る */
function relayEnvelope(body, secret, ts = Date.now()) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(String(ts) + '.' + raw, 'utf8').digest('base64');
  return { kind: 'line_webhook', ts, body: raw, sig };
}

/** 予約サイトと同じ方式で予約イベントを署名 */
function reservationEnvelope(payload, secret, ts = Date.now()) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(String(ts) + '.' + raw, 'utf8').digest('hex');
  return { kind: 'reservation_event', ts, payload: raw, sig };
}

module.exports = { createGasEnv, seedSheets, relayEnvelope, reservationEnvelope, fakeImage };
