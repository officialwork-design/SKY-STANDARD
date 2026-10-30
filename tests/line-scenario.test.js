/**
 * 実機確認チェックリストと同じ操作をモック環境で通しで実行する（tools/test-env/scenario.js）。
 * ※ モックの結果であり、テスト用チャネルでの実機確認の代わりにはならない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScenario } = require('../tools/test-env/scenario.js');

test('公式LINE の一連の操作（リッチメニュー・予約確認・お問い合わせ4項目・有人対応・再開）', () => {
  const r = runScenario();
  const failed = [];
  r.steps.forEach((s) => s.checks.forEach((c) => { if (!c.ok) failed.push(s.section + ' / ' + s.label + ' / ' + c.name); }));
  assert.deepEqual(failed, []);
  assert.ok(r.steps.reduce((n, s) => n + s.checks.length, 0) >= 50);
  assert.equal(r.errors.length, 0, 'エラーログが出ていない');
  assert.equal(r.pushes, 0, 'プッシュ送信していない');
});
