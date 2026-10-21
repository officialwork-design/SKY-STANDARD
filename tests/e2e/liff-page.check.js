/**
 * 予約確認画面のブラウザ確認（Playwright・LIFF SDK と GAS API をモック）。
 * 実行: node tests/e2e/liff-page.check.js   ※ playwright が必要
 */
'use strict';
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('playwright-core')); }
const ROOT = path.join(__dirname, '..', '..', 'src', 'web', 'booking');
const fs = require('fs');

const fakeLiff = (loggedIn) => `window.liff = {
  init: () => Promise.resolve(), isLoggedIn: () => ${loggedIn}, login: () => { window.__login = true; },
  logout: () => {}, getIDToken: () => 'tok', isInClient: () => false, isApiAvailable: () => true };`;

async function run(page, { config, api, loggedIn = true, blockSdk = false }) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('static.line-scdn.net')) {
      return blockSdk ? route.abort() : route.fulfill({ contentType: 'application/javascript', body: fakeLiff(loggedIn) });
    }
    if (url.endsWith('/config.json')) return config ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(config) }) : route.fulfill({ status: 404, body: '' });
    if (url.startsWith('https://script.google.com/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(api(JSON.parse(route.request().postData()))) });
    const file = path.join(ROOT, new URL(url).pathname.replace(/^\/+/, '') || 'index.html');
    if (fs.existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://liff.test/index.html');
  await page.waitForFunction(() => document.getElementById('view-loading').hidden, null, { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, opts, fn) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    try { await run(page, opts); await fn(page); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message); }
    await ctx.close();
  };
  const cfg = { liffId: '1234567890-AbCdEfGh', apiUrl: 'https://script.google.com/macros/s/x/exec' };
  const sample = { reservationId: 'R-001', planName: '東京ナイトクルーズ', flightDate: '2026-12-01', timeSlot: '18:00', passengers: 2, amount: 98000, status: '予約確定', paymentStatus: '決済完了', meetingPoint: '東京ヘリポート', notes: '<b>集合15分前</b>' };

  await check('設定未完了は準備中エラー', { config: null, api: () => ({}) }, async (p) => {
    if (await p.isHidden('#view-error')) throw new Error('error view hidden');
    if (!(await p.textContent('#error-text')).includes('設定未完了')) throw new Error('message');
  });
  await check('SDK 読込失敗でも停止しない', { config: cfg, blockSdk: true, api: () => ({}) }, async (p) => {
    if (await p.isHidden('#view-error')) throw new Error('error view hidden');
  });
  await check('一覧と詳細の表示（HTML はエスケープ）', { config: cfg, api: (b) => (b.idToken === 'tok' && b.action === 'list' ? { ok: true, reservations: [sample] } : { ok: false }) }, async (p) => {
    await p.click('.card');
    if ((await p.textContent('#d-amount')) !== '¥98,000') throw new Error('amount');
    if ((await p.textContent('#d-notes')) !== '<b>集合15分前</b>') throw new Error('escape');
    await p.screenshot({ path: path.join(__dirname, 'liff-detail.png'), fullPage: true });
  });
  await check('予約なしで本人確認フォーム', { config: cfg, api: () => ({ ok: true, reservations: [] }) }, async (p) => {
    if (await p.isHidden('#view-empty')) throw new Error('empty hidden');
  });
  await check('認証失敗で再ログイン案内', { config: cfg, api: () => ({ ok: false, error: 'auth_failed' }) }, async (p) => {
    if (await p.isHidden('#btn-relogin')) throw new Error('relogin hidden');
  });
  await browser.close();
  console.log(results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
})();
