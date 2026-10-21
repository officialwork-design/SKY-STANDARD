/**
 * assets/richmenu/richmenu.svg を LINE リッチメニュー用 PNG（2500x1686, 1MB以下）に変換する。
 * 使い方: node tools/render-richmenu.js   （playwright が必要: npm i -D playwright）
 */
'use strict';
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('playwright-core')); }

(async () => {
  const svgPath = path.join(__dirname, '..', 'assets', 'richmenu', 'richmenu.svg');
  const out = path.join(__dirname, '..', 'assets', 'richmenu', 'richmenu.png');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2500, height: 1686 } });
  await browser.close();
  const size = fs.statSync(out).size;
  console.log(`wrote ${out} (${size} bytes)`);
  if (size > 1024 * 1024) { console.error('1MB を超えています。JPEG 変換などで圧縮してください。'); process.exit(1); }
})();
