/** GAS ソースの構文チェック（V8 相当の JavaScript としてコンパイルできるか） */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = [
  ...fs.readdirSync(path.join(__dirname, '..', 'src', 'gas')).filter((f) => f.endsWith('.gs')).map((f) => path.join('src', 'gas', f)),
  path.join('src', 'sheet-admin', 'Code.gs')
];

for (const f of files) {
  test('構文チェック: ' + f, () => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: f }));
  });
}

test('appsscript.json が正しい JSON で、本体は Web アプリ（全員・自分として実行）', () => {
  const main = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'gas', 'appsscript.json'), 'utf8'));
  assert.equal(main.webapp.access, 'ANYONE_ANONYMOUS');
  assert.equal(main.webapp.executeAs, 'USER_DEPLOYING');
  const admin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'sheet-admin', 'appsscript.json'), 'utf8'));
  assert.equal(admin.dependencies.libraries[0].libraryId, '1zlkPtaZlrSOfKUVKw4rxDmaGB42-niVZtYdDlwSNusnmnn50BB1axmff');
  assert.equal(admin.dependencies.libraries[0].userSymbol, 'SkyStandard');
});

test('ソースに認証情報らしき値をハードコードしていない', () => {
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(code, /['"][A-Za-z0-9+/]{100,}={0,2}['"]/, f + ' に長いトークン状の文字列があります');
    assert.doesNotMatch(code, /Bearer [A-Za-z0-9]{20,}/, f);
  }
});
