/**
 * スプレッドシート管理メニュー（src/sheet-admin/Code.gs）のモックテスト。
 * ライブラリ SkyStandard には src/gas を読み込んだモック環境の adminRun を接続する（結合テスト）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGasEnv, reservationEnvelope } = require('./helpers/gas-env');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'sheet-admin', 'Code.gs'), 'utf8');
const USER = 'U' + 'a'.repeat(32);
const RESV = 'resv';

function lineOk(url) {
  if (url.indexOf('/v2/bot/info') !== -1) return { code: 200, body: { displayName: 'SKY STANDARD', basicId: '@sky' } };
  if (url.indexOf('/user/all/richmenu') !== -1) return { code: 404, body: {} };
  return { code: 200, body: {} };
}

/**
 * @param {{answers?: string[], withLibrary?: boolean, user?: string, activeSheet?: string, activeRow?: number, numRows?: number}} o
 */
function setup(o = {}) {
  const lib = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: 't', RELAY_SHARED_SECRET: 'r', RESERVATION_WEBHOOK_SECRET: RESV,
    SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es', ADMIN_USERS: 'owner@example.com' }, fetch: lineOk, user: o.user });
  const shown = [];
  const answers = (o.answers || []).slice();
  const menus = [];
  const triggers = [];
  let added = 0;
  function menuBuilder(name) {
    const m = { name, items: [] };
    const b = {
      addItem(label, fn) { m.items.push({ label, fn }); return b; },
      addSubMenu(sub) { m.items.push({ sub: sub.__m }); return b; },
      addSeparator() { return b; },
      addToUi() { menus.push(m); added++; return b; },
      __m: m
    };
    return b;
  }
  const ui = {
    createMenu: menuBuilder,
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' },
    Button: { YES: 'YES', NO: 'NO' },
    alert(title, msg, buttons) {
      shown.push({ title, msg, buttons });
      if (buttons === 'YES_NO') return answers.length ? answers.shift() : 'NO';
      return 'OK';
    },
    showModalDialog(html, title) { shown.push({ title, msg: html.content, modal: true }); }
  };
  const sendLog = lib.sheets['送信ログ'];
  const activeSheet = { name: o.activeSheet || 'FAQ' };
  const ctx = {
    console,
    SpreadsheetApp: {
      getUi: () => ui,
      getActive: () => ({ getSheetByName: (n) => lib.sheets[n] || null }),
      getActiveSheet: () => {
        const sh = activeSheet.name === '送信ログ' ? sendLog : lib.sheets[activeSheet.name];
        return Object.assign({}, sh, {
          getName: () => activeSheet.name,
          getActiveRange: () => ({ getRow: () => activeSheet.row || 2, getNumRows: () => activeSheet.numRows || 1 }),
          getRange: sh.getRange, getLastColumn: sh.getLastColumn
        });
      }
    },
    HtmlService: { createHtmlOutput: (c) => ({ content: c, setWidth() { return this; }, setHeight() { return this; } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: (fn) => {
        const b = { timeBased: () => b, atHour: () => b, everyDays: () => b, inTimezone: () => b, everyMinutes: () => b,
          forSpreadsheet: () => b, onEdit: () => b, create: () => { triggers.push({ getHandlerFunction: () => fn }); } };
        return b;
      }
    }
  };
  // 管理メニューから Web アプリ（独立GAS）への GET を模擬
  const webCalls = [];
  ctx.UrlFetchApp = { fetch: (url) => {
    webCalls.push(url);
    if (/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\?sync=triggers$/.test(url)) {
      const out = lib.ctx.doGet({ parameter: { sync: 'triggers' } }).getContent();
      return { getContentText: () => out, getResponseCode: () => 200 };
    }
    return { getContentText: () => '', getResponseCode: () => 404 };
  } };
  ctx.Utilities = lib.ctx.Utilities;
  if (o.withLibrary !== false) {
    ctx.SkyStandard = { adminRun: (a, p) => lib.ctx.adminRun(a, p), invalidateIdCacheFromEdit: () => lib.ctx.invalidateIdCacheFromEdit() };
  }
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  return { ctx, lib, shown, menus, triggers, activeSheet, answers, webCalls, get added() { return added; },
    last: () => shown[shown.length - 1] };
}

function flatten(menu) {
  return menu.items.map((i) => (i.sub ? { name: i.sub.name, items: i.sub.items.map((x) => x.label) } : i.label));
}

test('開くと「SKY STANDARD」メニューが1つだけ表示され、指定の構成になっている', () => {
  const s = setup();
  s.ctx.onOpen({});
  assert.equal(s.menus.length, 1);
  assert.equal(s.menus[0].name, 'SKY STANDARD');
  assert.deepEqual(JSON.parse(JSON.stringify(flatten(s.menus[0]))), [
    { name: '初期設定', items: ['シート列・設定行の補完', 'ID・URL設定チェック', 'LINE接続チェック', 'ID管理の変更を反映（再読込）'] },
    { name: 'LINE管理', items: ['リッチメニュー登録・更新', 'リッチメニュー設定確認', '今月の配信数確認'] },
    { name: '予約・通知', items: ['承認待ち通知を送信（選択中の行）', '選択中の通知を却下', '失敗した通知を再送', '通知テンプレート確認'] },
    { name: 'お問い合わせ', items: ['オペレーター対応状況', 'オペレーター対応を終了（選択中の行）'] },
    { name: 'システム管理', items: ['トリガー設定', 'トリガー状態確認', '接続・設定診断', 'エラーログを開く', 'エラーログ設定・動作確認'] }
  ]);
});

test('すべてのメニュー項目に対応する関数が存在する', () => {
  const s = setup();
  s.ctx.onOpen({});
  s.menus[0].items.forEach((g) => g.sub.items.forEach((i) => assert.equal(typeof s.ctx[i.fn], 'function', i.fn)));
});

test('ライブラリ未設定でも例外にならず手順を表示', () => {
  const s = setup({ withLibrary: false });
  s.ctx.skyMenuCheckIds();
  assert.match(s.last().title, /ライブラリ未設定/);
});

test('ID・URL設定チェック: 不足キーを日本語で画面に表示', () => {
  const s = setup();
  s.ctx.skyMenuCheckIds();
  const m = s.last();
  assert.match(m.title, /【要確認】ID・URL設定チェック/);
  assert.match(m.msg, /【未設定】 BOOKING_SITE_URL（フライト予約ページURL）/);
});

test('シート補完: 確認で「いいえ」なら実行しない、「はい」で実行', () => {
  const s = setup({ answers: ['NO'] });
  const before = JSON.stringify(s.lib.sheets['送信ログ'].data[0]);
  s.ctx.skyMenuSetupSheets();
  assert.equal(JSON.stringify(s.lib.sheets['送信ログ'].data[0]), before);
  s.answers.push('YES');
  s.ctx.skyMenuSetupSheets();
  assert.match(s.last().msg, /既存のデータ・行は変更していません/);
  assert.ok(s.lib.sheets['送信ログ'].data[0].includes('冪等キー'));
});

test('権限のない利用者は操作できず、理由が表示される', () => {
  const s = setup({ user: 'editor@example.com', answers: ['YES'] });
  s.ctx.skyMenuSetupSheets();
  assert.match(s.last().title, /権限がありません/);
  assert.ok(!s.lib.sheets['送信ログ'].data[0].includes('冪等キー'));
  s.ctx.skyMenuInstallTriggers();
  assert.equal(s.triggers.length, 0);
});

function pendingFlightChange(s) {
  s.lib.doPost(reservationEnvelope({ eventId: 'fc', eventType: 'FLIGHT_CHANGE', occurredAt: new Date().toISOString(),
    reservation: { reservationId: 'R1', lineUserId: USER } }, RESV));
  s.activeSheet.name = '送信ログ';
  s.activeSheet.row = 2;
}

test('承認待ち通知: 文面を確認ダイアログに表示し、「いいえ」なら送信しない', () => {
  const s = setup({ answers: ['NO'] });
  pendingFlightChange(s);
  s.ctx.skyMenuApproveSelected();
  assert.match(s.last().msg, /運航に関する重要なお知らせ/);
  assert.match(s.last().msg, /送信しますか/);
  assert.equal(s.lib.linePosts('/push').filter((p) => p.json.to === USER).length, 0);
});

test('承認待ち通知: 「はい」で1回だけ送信。もう一度実行しても二重送信しない', () => {
  const s = setup({ answers: ['YES', 'YES'] });
  pendingFlightChange(s);
  s.ctx.skyMenuApproveSelected();
  assert.match(s.last().msg, /結果: 成功/);
  s.ctx.skyMenuApproveSelected();
  assert.match(s.last().title, /承認待ちではありません/);
  assert.equal(s.lib.linePosts('/push').filter((p) => p.json.to === USER).length, 1);
});

test('送信ログ以外・複数行選択では送信しない', () => {
  const s = setup({ answers: ['YES'] });
  pendingFlightChange(s);
  s.activeSheet.name = 'FAQ';
  s.ctx.skyMenuApproveSelected();
  assert.match(s.last().msg, /「送信ログ」シートで/);
  s.activeSheet.name = '送信ログ';
  s.activeSheet.numRows = 3;
  s.ctx.skyMenuApproveSelected();
  assert.match(s.last().msg, /1行だけ/);
  assert.equal(s.lib.linePosts('/push').filter((p) => p.json.to === USER).length, 0);
});

test('選択中の通知を却下（確認あり）', () => {
  const s = setup({ answers: ['YES'] });
  pendingFlightChange(s);
  s.ctx.skyMenuRejectSelected();
  assert.match(s.last().title, /却下しました/);
  assert.equal(s.lib.rows('送信ログ')[0]['結果'], '承認却下');
});

test('失敗した通知を再送: 対象なしなら確認せず案内のみ', () => {
  const s = setup();
  s.ctx.skyMenuRetry();
  assert.match(s.last().title, /再送対象なし/);
});

test('リッチメニュー登録: 内容確認で「いいえ」なら LINE を更新しない', () => {
  const s = setup({ answers: ['NO'] });
  s.ctx.skyMenuRichMenuDeploy();
  assert.match(s.last().msg, /全利用者のリッチメニューを更新します/);
  assert.equal(s.lib.fetchCalls.filter((c) => /\/v2\/bot\/richmenu$/.test(c.url)).length, 0);
});

test('トリガー設定: 独立GAS（Web アプリ経由）に作成し、スプレッドシート側の旧トリガーは削除', () => {
  const s = setup({ answers: ['YES', 'YES'] });
  s.lib.setSetting('GAS_WEBAPP_URL', 'https://script.google.com/macros/s/AKfy123/exec');
  s.triggers.push({ getHandlerFunction: () => 'onOpen' }, { getHandlerFunction: () => 'skyTriggerRetry' });
  s.ctx.skyMenuInstallTriggers();
  assert.match(s.last().msg, /トリガーを設定しました/);
  assert.match(s.last().msg, /旧トリガー 2 件を削除/);
  assert.equal(s.triggers.length, 0); // スプレッドシート側には作らない
  s.ctx.skyMenuInstallTriggers();
  assert.deepEqual(s.lib.triggers.map((t) => t.getHandlerFunction()).sort(), ['triggerFlightReminders', 'triggerRetryFailedSends']);
  // Web アプリへのリクエストに認証情報・秘密情報を含めない
  s.webCalls.forEach((u) => assert.match(u, /\?sync=triggers$/));
  s.ctx.skyMenuTriggerStatus();
  assert.match(s.last().msg, /【OK】搭乗前日リマインド/);
});

test('トリガー設定: GAS_WEBAPP_URL 未設定なら作成せず手順を表示', () => {
  const s = setup({ answers: ['YES'] });
  s.ctx.skyMenuInstallTriggers();
  assert.match(s.last().msg, /GAS_WEBAPP_URL/);
  assert.equal(s.lib.triggers.length, 0);
});

test('ID管理シートの編集でキャッシュを破棄（他シートの編集では何もしない）', () => {
  const s = setup();
  s.lib.setSetting('BOOKING_SITE_URL', 'https://a.example.jp/');
  assert.equal(s.lib.ctx.getUrlSetting_(s.lib.ctx.ID_KEYS.BOOKING_SITE_URL), 'https://a.example.jp/');
  s.lib.editIdSheet('BOOKING_SITE_URL', 'https://b.example.jp/');
  s.ctx.onEdit({ range: { getSheet: () => ({ getName: () => 'FAQ' }) } });
  s.lib.ctx.__settingsCache = null;
  assert.equal(s.lib.ctx.getUrlSetting_(s.lib.ctx.ID_KEYS.BOOKING_SITE_URL), 'https://a.example.jp/');
  s.ctx.onEdit({ range: { getSheet: () => ({ getName: () => 'ID管理' }) } });
  s.lib.ctx.__settingsCache = null;
  assert.equal(s.lib.ctx.getUrlSetting_(s.lib.ctx.ID_KEYS.BOOKING_SITE_URL), 'https://b.example.jp/');
});

test('スプレッドシート側の GAS にはインストール型トリガー用の関数を置かない', () => {
  const s = setup();
  assert.equal(typeof s.ctx.skyTriggerRetry, 'undefined');
  assert.equal(typeof s.ctx.skyTriggerFlightReminders, 'undefined');
  assert.doesNotMatch(CODE, /newTrigger/);
});

test('長い結果はスクロール可能なダイアログで表示し、HTML をエスケープ', () => {
  const s = setup();
  s.ctx.skyMenuDiagnose();
  const m = s.last();
  assert.equal(m.modal, true);
  assert.match(m.msg, /接続・設定診断|◆ スプレッドシート/);
  assert.doesNotMatch(m.msg, /<script/);
});

test('LINE接続チェック（疎通テストなし）', () => {
  const s = setup({ answers: ['NO'] });
  s.ctx.skyMenuCheckLine();
  assert.match(s.last().msg, /アカウント名: SKY STANDARD/);
  assert.equal(s.lib.fetchCalls.filter((c) => /webhook\/test/.test(c.url)).length, 0);
});

/* ---------- エラーログ ---------- */

test('エラーログを開く：未作成なら作成方法を案内、作成済みなら開く', () => {
  const s = setup();
  s.ctx.skyMenuOpenErrorLog();
  assert.match(s.last().msg, /エラーログ設定・動作確認/);
  s.lib.ctx.logError_('faq.read', new Error('x'));
  s.ctx.skyMenuOpenErrorLog();
  assert.equal(s.lib.sheets['エラーログ'].fmt.activated, true);
});

test('エラーログ設定・動作確認：「いいえ」ならテスト行を書かない、「はい」で1件だけ記録', () => {
  const s = setup({ answers: ['NO'] });
  s.ctx.skyMenuErrorLogCheck();
  assert.ok(s.shown.some((m) => /エラーログ設定・動作確認/.test(m.title)));
  assert.equal(s.lib.rows('エラーログ').length, 0);
  s.answers.push('YES');
  s.ctx.skyMenuErrorLogCheck();
  const rows = s.lib.rows('エラーログ');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['発生元'], '管理メニュー（動作確認）');
  assert.equal(s.lib.sheets['エラーログ'].fmt.activated, true);
});

test('ライブラリ呼び出し自体が失敗したら、管理メニュー側でエラーログに記録（シートがある場合のみ）', () => {
  const s = setup();
  s.lib.ctx.adminRun('errorLogStatus'); // シート作成
  s.ctx.SkyStandard = { adminRun: () => { throw new Error('Library not found for user taro@example.com'); } };
  s.ctx.skyMenuCheckIds();
  assert.match(s.last().title, /実行エラー/);
  const rows = s.lib.rows('エラーログ');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['発生元'], '管理メニュー（ライブラリ呼び出し）');
  assert.equal(rows[0]['関数名'], 'call_:checkIds');
  assert.doesNotMatch(rows[0]['エラーメッセージ'], /taro@example\.com/);
});

test('お問い合わせ: 選択中の行のオペレーター対応を終了（確認ダイアログ「いいえ」なら何もしない／「はい」で終了）', () => {
  const s = setup({ answers: ['NO', 'YES'] });
  const id = 'INQ-20261021-0001';
  s.lib.sheets['問い合わせ管理'].data.push([id, USER, '2026-10-21 10:00:00', 'オペレーター相談', '依頼', '対応中', '', '', '']);
  s.lib.ctx.setOperatorState_(USER, { id, since: Date.now(), n: 0 });
  s.activeSheet.name = 'FAQ';
  s.ctx.skyMenuOperatorRelease();
  assert.match(s.last().msg, /「問い合わせ管理」シートで対象の行を1行だけ選択/);
  s.activeSheet.name = '問い合わせ管理';
  s.activeSheet.row = 2;
  s.ctx.skyMenuOperatorRelease();
  assert.match(s.last().msg, /自動応答を再開します/);
  assert.ok(s.lib.props['OPERATOR_MODE:' + USER], '「いいえ」では解除しない');
  s.ctx.skyMenuOperatorRelease();
  assert.match(s.last().msg, /オペレーター対応を終了し、自動応答を再開しました/);
  assert.equal(s.lib.props['OPERATOR_MODE:' + USER], undefined);
  assert.equal(s.lib.rows('問い合わせ管理')[0]['対応状況'], '対応完了');
  s.ctx.skyMenuOperatorStatus();
  assert.match(s.last().msg, /オペレーター対応中の利用者はいません/);
});
