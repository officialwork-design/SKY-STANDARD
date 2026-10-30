/**
 * テスト環境キット（src/test-env/TestEnv.gs・tools/test-env/build.js）のモックテスト。
 * 本番の GAS・スプレッドシート・公式アカウントでは動かないこと、本番データ・元画像を変更しないことを確認する。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { createGasEnv, fakeImage } = require('./helpers/gas-env');

const TESTENV = path.join(__dirname, '..', 'src', 'test-env', 'TestEnv.gs');
const TEST_SCRIPT = '1TESTSCRIPT' + 'x'.repeat(40);
const PROD_SS = '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es';
const IMG = '17JrCm0unhRnSG2En65jmVSl116Sq4ipf';
const W = 1543, H = 1019;
const JPEG_NAME = '空と都市を巡るヘリチャーター案内_LINE用.jpg';

function env(o = {}) {
  const calls = [];
  const e = createGasEnv({
    scriptId: o.scriptId === undefined ? TEST_SCRIPT : o.scriptId,
    extraFiles: [TESTENV],
    props: Object.assign({}, o.props || {}),
    user: 'tester@kurumi.inc',
    webAppUrl: o.webAppUrl,
    driveFiles: { [IMG]: { name: '空と都市を巡るヘリチャーター案内.png', contentType: 'image/png', folder: 'SKY STANDARD',
      bytes: fakeImage('png', W, H, 2200 * 1024), asJpeg: o.jpeg || fakeImage('jpeg', W, H, 420 * 1024) } },
    fetch: (url, params) => {
      calls.push({ url, method: params.method });
      if (url.endsWith('/v2/bot/info')) return { code: 200, body: { basicId: o.basicId || '@999test', displayName: 'テスト', userId: 'U' + 'e'.repeat(32), chatMode: 'chat' } };
      return { code: 200, body: {} };
    }
  });
  e.calls = calls;
  return e;
}
const snapshot = (e) => JSON.stringify(Object.keys(e.sheets).map((k) => [k, e.sheets[k].data]));
const testSheet = (e) => Object.values(e.created)[0];
const rowsOf = (sh) => { const d = sh.data; return d.slice(1).map((r) => Object.fromEntries(d[0].map((h, i) => [h, String(r[i] === undefined ? '' : r[i]).replace(/^'/, '')]))); };

test('本番の GAS プロジェクトでは実行できない', () => {
  const e = env({ scriptId: '1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff' });
  for (const fn of ['testSetup', 'testMakeRichMenuImage', 'testCheck', 'testDeployRichMenu', 'testSeedReservations', 'testStatus', 'testResumeAutoReply']) {
    assert.throws(() => e.ctx[fn](), /本番の GAS プロジェクト/, fn);
  }
  assert.equal(Object.keys(e.created).length, 0);
});

test('SPREADSHEET_ID が本番のスプレッドシートなら止まる', () => {
  const e = env({ props: { SPREADSHEET_ID: PROD_SS } });
  assert.throws(() => e.ctx.testSetup(), /本番のスプレッドシート/);
  assert.throws(() => e.ctx.testSeedReservations(), /本番のスプレッドシート/);
});

test('testSetup：テスト用スプレッドシートを作成し、本番シートは読むだけ', () => {
  const e = env({ webAppUrl: 'https://script.google.com/macros/s/TESTDEPLOY/exec' });
  const before = snapshot(e);
  const out = e.ctx.testSetup();
  assert.equal(snapshot(e), before, '本番（シード）シートが変更されている');
  const ss = testSheet(e);
  assert.ok(ss, 'テスト用スプレッドシートが作成されていない');
  assert.equal(e.props.SPREADSHEET_ID, ss.getId());
  assert.equal(e.props.WEBHOOK_MODE, 'direct');
  assert.equal(e.props.ADMIN_USERS, 'tester@kurumi.inc');
  for (const [name, cols] of Object.entries(vm.runInContext('REQUIRED_COLUMNS', e.ctx))) {
    const sh = ss.getSheetByName(name);
    assert.ok(sh, name + ' がない');
    for (const c of cols) assert.ok(sh.data[0].includes(c), name + ' に ' + c + ' がない');
  }
  assert.ok(ss.getSheetByName('はじめに'));
  assert.equal(rowsOf(ss.getSheetByName('通知テンプレート')).filter((r) => r['テンプレートID'] === 'WELCOME').length, 1);
  assert.equal(rowsOf(ss.getSheetByName('FAQ')).length, 4);
  assert.equal(rowsOf(ss.getSheetByName('顧客管理')).length, 0, '顧客データはコピーしない');
  assert.equal(rowsOf(ss.getSheetByName('予約管理')).length, 0, '予約データはコピーしない');
  const ids = Object.fromEntries(rowsOf(ss.getSheetByName('ID管理')).map((r) => [r['設定キー'], r['設定値']]));
  assert.equal(ids.SPREADSHEET_ID, ss.getId());
  assert.equal(ids.GAS_SCRIPT_ID, TEST_SCRIPT);
  assert.equal(ids.GAS_WEBAPP_URL, 'https://script.google.com/macros/s/TESTDEPLOY/exec');
  assert.equal(ids.BOOKING_SITE_URL, '');
  assert.equal(ids.FAQ_PAGE_URL, '');
  assert.equal(ids.LINE_CHANNEL_ACCESS_TOKEN, '', '秘密情報はシートに書かない');
  assert.match(out, /スプレッドシート：https:\/\/docs\.google\.com/);
  // 2回目は作り直さない
  e.ctx.testSetup();
  assert.equal(Object.keys(e.created).length, 1);
});

test('testMakeRichMenuImage：1MB 以下の JPEG を同じフォルダに別名で作成し、元画像は変更しない', () => {
  const e = env();
  e.ctx.testSetup();
  const orig = Buffer.from(e.driveFiles[IMG].bytes);
  const out = e.ctx.testMakeRichMenuImage();
  assert.match(out, /【OK】空と都市を巡るヘリチャーター案内_LINE用\.jpg：420KB、image\/jpeg 1543×1019/);
  assert.match(out, /【OK】元画像は変更されていません/);
  assert.ok(orig.equals(Buffer.from(e.driveFiles[IMG].bytes)));
  const made = Object.entries(e.driveFiles).filter(([, f]) => f.name === JPEG_NAME);
  assert.equal(made.length, 1);
  assert.equal(made[0][1].folder, 'SKY STANDARD');
  const ids = Object.fromEntries(rowsOf(testSheet(e).getSheetByName('ID管理')).map((r) => [r['設定キー'], r['設定値']]));
  assert.equal(ids.RICHMENU_IMAGE_FILE_ID, made[0][0]);
  // 本番の ID管理 は変更しない
  assert.equal(e.rows('ID管理').find((r) => r['設定キー'] === 'RICHMENU_IMAGE_FILE_ID')['設定値'], '');
  // 2回目は作り直さない
  assert.match(e.ctx.testMakeRichMenuImage(), /作り直さずに検査/);
  assert.equal(Object.values(e.driveFiles).filter((f) => f.name === JPEG_NAME).length, 1);
  // 作成した JPEG で登録前の検査が通る
  assert.equal(e.ctx.validateRichMenuImage_().ok, true);
});

test('testMakeRichMenuImage：JPEG にしても 1MB を超える場合はドライブに保存しない', () => {
  const e = env({ jpeg: fakeImage('jpeg', W, H, 1100 * 1024) });
  e.ctx.testSetup();
  assert.match(e.ctx.testMakeRichMenuImage(), /NG：作成しませんでした/);
  assert.equal(Object.values(e.driveFiles).filter((f) => f.name === JPEG_NAME).length, 0);
});

test('本番の公式アカウントのトークンではリッチメニューを登録しない', () => {
  const e = env({ basicId: '@686mdyho', props: { LINE_CHANNEL_ACCESS_TOKEN: 'tok' } });
  e.ctx.testSetup();
  assert.throws(() => e.ctx.testDeployRichMenu(), /本番の公式アカウント/);
  assert.throws(() => e.ctx.testCheck(), /本番の公式アカウント/);
  assert.equal(e.calls.filter((c) => /richmenu/.test(c.url)).length, 0);
});

test('トークン未設定ならリッチメニュー登録・確認は止まる', () => {
  const e = env();
  e.ctx.testSetup();
  assert.throws(() => e.ctx.testDeployRichMenu(), /LINE_CHANNEL_ACCESS_TOKEN/);
});

test('testSeedReservations：友だち追加した本人の予約2件と他人の予約1件（テスト用シートのみ）', () => {
  const e = env();
  e.ctx.testSetup();
  assert.throws(() => e.ctx.testSeedReservations(), /友だち追加してから/);
  const me = 'U' + 'a'.repeat(32);
  vm.runInContext("appendRow_(SHEETS.CUSTOMERS, {'LINEユーザーID': '" + me + "', '友だち状態': '友だち'})", e.ctx);
  const before = snapshot(e);
  e.ctx.testSeedReservations();
  e.ctx.testSeedReservations(); // 2回目は追加しない
  assert.equal(snapshot(e), before, '本番（シード）シートが変更されている');
  const rows = rowsOf(testSheet(e).getSheetByName('予約管理'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r['LINEユーザーID'] === me), [true, true, false]);
  rows.forEach((r) => assert.match(r['予約ID'], /^TEST-\d{8}-[0-9A-F]{6}$/));
  assert.ok(vm.runInContext('RESERVATION_ID_PATTERN', e.ctx).test(rows[0]['予約ID']));
});

test('build.js：テスト用一式（drive スコープ・TestEnv 入り）を出力し、本番の manifest は変更しない', () => {
  const prodManifest = fs.readFileSync(path.join(__dirname, '..', 'src', 'gas', 'appsscript.json'), 'utf8');
  const { build } = require('../tools/test-env/build.js');
  const r = build();
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'src', 'gas', 'appsscript.json'), 'utf8'), prodManifest);
  const m = JSON.parse(fs.readFileSync(path.join(r.out, 'appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
  assert.ok(!m.oauthScopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(JSON.parse(prodManifest).oauthScopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  const all = fs.readFileSync(path.join(r.out, 'all-in-one.gs'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(all));
  assert.match(all, /function testSetup\(\)/);
  assert.ok(fs.existsSync(path.join(r.out, 'zz_TestEnv.gs')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'gas', 'TestEnv.gs')), 'TestEnv.gs は本番の src/gas に入れない');
});

test('testCheck：テスト用チャネルの接続・4領域のリッチメニュー定義を表示（LINE には登録しない）', () => {
  const e = env({ props: { LINE_CHANNEL_ACCESS_TOKEN: 'tok' } });
  e.ctx.testSetup();
  e.ctx.testMakeRichMenuImage();
  const out = e.ctx.testCheck();
  assert.match(out, /テスト用チャネル：テスト（@999test）/);
  assert.match(out, /x0 y0 1543×536 → postback a=menu_unset&item=BOOKING/);
  assert.match(out, /x0 y536 515×483 → postback a=rsv_start/);
  assert.match(out, /x515 y536 514×483 → postback a=inq_start/);
  assert.match(out, /x1029 y536 514×483 → postback a=menu_unset&item=FAQ/);
  assert.match(out, /【OK】空と都市を巡るヘリチャーター案内_LINE用\.jpg（image\/jpeg・1543×1019px/);
  assert.equal(e.calls.filter((c) => /\/v2\/bot\/richmenu/.test(c.url) && c.method === 'post').length, 0, 'リッチメニューを作成していない');
});
