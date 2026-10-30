#!/usr/bin/env node
/**
 * テスト用 GAS プロジェクトの一式を build/test-env/ に出力する（本番の src/gas・.clasp.json は変更しない）。
 *
 *   node tools/test-env/build.js
 *
 * 出力：
 *   build/test-env/*.gs            src/gas の全ファイル＋ TestEnv.gs（clasp で push する場合）
 *   build/test-env/appsscript.json drive.readonly → drive（JPEG を別名で保存するため。テスト用のみ）
 *   build/test-env/all-in-one.gs   上記 .gs を1ファイルに連結（Apps Script エディタに貼り付ける場合）
 *   build/test-env/.clasp.json.example  テスト用プロジェクトのスクリプトIDを書いて .clasp.json に改名
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src', 'gas');
const OUT = path.join(ROOT, 'build', 'test-env');
const PROD_SCRIPT_ID = '1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff';

function build() {
  fs.mkdirSync(OUT, { recursive: true });
  // .clasp.json（テスト用スクリプトID）は残し、生成物だけ作り直す
  fs.readdirSync(OUT).filter((f) => f.endsWith('.gs')).forEach((f) => fs.unlinkSync(path.join(OUT, f)));
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
  files.forEach((f) => fs.copyFileSync(path.join(SRC, f), path.join(OUT, f)));
  fs.copyFileSync(path.join(ROOT, 'src', 'test-env', 'TestEnv.gs'), path.join(OUT, 'zz_TestEnv.gs'));

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  manifest.oauthScopes = manifest.oauthScopes.map((s) =>
    s === 'https://www.googleapis.com/auth/drive.readonly' ? 'https://www.googleapis.com/auth/drive' : s);
  fs.writeFileSync(path.join(OUT, 'appsscript.json'), JSON.stringify(manifest, null, 2) + '\n');

  const all = files.concat(['zz_TestEnv.gs']).map((f) =>
    '/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(OUT, f), 'utf8').replace(/\s*$/, '\n')).join('\n');
  fs.writeFileSync(path.join(OUT, 'all-in-one.gs'),
    '/* SKY STANDARD 公式LINE テスト環境用（自動生成：tools/test-env/build.js）。本番の GAS には貼り付けないでください。 */\n\n' + all);

  fs.writeFileSync(path.join(OUT, '.clasp.json.example'),
    JSON.stringify({ scriptId: '<テスト用GASプロジェクトのスクリプトID>', rootDir: '.' }, null, 2) + '\n');

  const clasp = path.join(OUT, '.clasp.json');
  if (fs.existsSync(clasp) && JSON.parse(fs.readFileSync(clasp, 'utf8')).scriptId === PROD_SCRIPT_ID) {
    throw new Error('build/test-env/.clasp.json が本番のスクリプトIDです');
  }
  return { out: OUT, files: files.length + 1, manifest };
}

if (require.main === module) {
  const r = build();
  console.log('出力: ' + path.relative(ROOT, r.out) + '（.gs ' + r.files + ' 件＋ all-in-one.gs）');
  console.log('スコープ: ' + r.manifest.oauthScopes.map((s) => s.split('/').pop()).join(', '));
}
module.exports = { build };
