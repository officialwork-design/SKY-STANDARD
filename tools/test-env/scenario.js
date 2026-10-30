#!/usr/bin/env node
/**
 * 実機確認チェックリスト（docs/test-env.md）と同じ操作を、GAS のモック環境で順に実行し、
 * ボットの返信を記録する（LINE・Google には接続しない）。
 *
 *   node tools/test-env/scenario.js            … 結果を Markdown で表示
 *   node tools/test-env/scenario.js --out FILE … ファイルに保存
 *
 * ※ モック上の結果です。実機（テスト用チャネル）での確認の代わりにはなりません。
 */
'use strict';
const crypto = require('crypto');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createGasEnv } = require('../../tests/helpers/gas-env');

const BOT = 'U' + 'f'.repeat(32);
const ME = 'U' + 'a'.repeat(32);
const OTHER = 'U00000000000000000000000000000000';
const DAY = '20261106';
const RID_A = 'TEST-' + DAY + '-A1B2C3';
const RID_B = 'TEST-' + DAY + '-D4E5F6';
const RID_C = 'TEST-' + DAY + '-0C0C0C';

function runScenario() {
  const good = new Set();
  const tok = () => { const t = crypto.randomBytes(16).toString('hex'); good.add(t); return t; };
  const e = createGasEnv({
    props: { LINE_CHANNEL_ACCESS_TOKEN: 'tok', SPREADSHEET_ID: '1pzu1_-X8-Y7AhAq4ctwgfliYnImkPe6sa4d_TBth1Es',
      ADMIN_USERS: 'owner@example.com', ADMIN_EMAIL: 'owner@example.com' },
    fetch: (url, params) => {
      if (url.indexOf('/v2/bot/message/reply') !== -1) {
        const t = JSON.parse(params.payload).replyToken;
        if (!good.has(t)) return { code: 400, body: { message: 'Invalid reply token' } };
        good.delete(t);
        return { code: 200, body: {} };
      }
      if (url.indexOf('/v2/bot/profile/') !== -1) return { code: 200, body: { displayName: 'テスト太郎', language: 'ja' } };
      return { code: 200, body: {} };
    }
  });
  const run = (code) => vm.runInContext(code, e.ctx);
  [[RID_A, ME, '【テスト】東京夜景遊覧', 'CONFIRMED'], [RID_B, ME, '【テスト】横浜ベイ遊覧', 'CANCELLED'], [RID_C, OTHER, '【テスト】他人の予約', 'CONFIRMED']]
    .forEach((r) => run("appendRow_(SHEETS.RESERVATIONS, {'予約ID':'" + r[0] + "','LINEユーザーID':'" + r[1] + "','プランID':'TEST','プラン名':'" + r[2] +
      "','搭乗日':'2026-11-06','時間帯':'18:00','人数':2,'予約状態':'" + r[3] + "','注意事項':'テストデータ'})"));

  let lastEventId = null;
  const event = (type, fields, src) => {
    lastEventId = crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26);
    return Object.assign({ type, webhookEventId: lastEventId, timestamp: Date.now(), mode: 'active', replyToken: tok(),
      source: src || { type: 'user', userId: ME }, deliveryContext: { isRedelivery: false } }, fields);
  };
  const steps = [];
  let section = '';
  const send = (label, evt, checks) => {
    const before = e.linePosts('/v2/bot/message/reply').length;
    e.doPost({ destination: BOT, events: [evt] });
    const posted = e.linePosts('/v2/bot/message/reply').slice(before);
    const messages = posted.length ? posted[posted.length - 1].json.messages : [];
    const replied = posted.length > 0;
    const textOf = messages.map((m) => m.text || (m.template && (m.template.text || m.template.altText)) || m.altText || '').join('\n');
    const buttons = [];
    messages.forEach((m) => {
      (m.quickReply ? m.quickReply.items : []).forEach((i) => buttons.push(i.action.label));
      ((m.template && m.template.actions) || []).forEach((a) => buttons.push(a.label + (a.uri ? '（' + a.uri + '）' : '')));
    });
    const res = { section, label, replied, text: textOf, buttons, checks: [] };
    (checks || []).forEach(([name, fn]) => {
      let ok = false;
      try { ok = !!fn(res); } catch (err) { ok = false; }
      res.checks.push({ name, ok });
    });
    steps.push(res);
    return res;
  };
  const say = (t, src) => event('message', { message: { type: 'text', id: '1', text: t } }, src);
  const tap = (d, src) => event('postback', { postback: { data: d } }, src);
  const inq = () => e.rows('問い合わせ管理');
  const lastInq = () => inq()[inq().length - 1];
  const has = (re) => (r) => re.test(r.text);
  const btn = (name) => (r) => r.buttons.some((b) => b.indexOf(name) === 0);
  const silent = (r) => !r.replied;

  section = '1. 友だち追加';
  send('友だち追加', event('follow', {}), [['あいさつを返信', (r) => r.replied], ['顧客管理に登録', () => e.rows('顧客管理').some((x) => x['LINEユーザーID'] === ME)]]);

  section = '2. リッチメニュー（URL 未設定 → 準備中）';
  send('「ご予約はこちら」をタップ', tap('a=menu_unset&item=BOOKING'), [['準備中と案内', has(/準備中/)]]);
  send('「よくある質問」をタップ', tap('a=menu_unset&item=FAQ'), [['準備中と案内', has(/準備中/)]]);

  section = '3. 予約確認（LINE 連携済みの予約のみ）';
  send('「予約確認」をタップ', tap('a=rsv_start'), [['予約IDの入力を案内', has(/予約ID/)]]);
  send('形式違い「12345」を送信', say('12345'), [['再入力を案内', has(/予約ID/)], ['予約内容は出さない', (r) => !/ご予約内容/.test(r.text)]]);
  send('本人の予約 ' + RID_A + ' を送信', say(RID_A), [['予約内容を表示', has(/ご予約内容/)], ['プラン名を表示', has(/東京夜景遊覧/)],
    ['予約変更ボタン', btn('予約変更')], ['キャンセルボタン', btn('キャンセル')], ['オペレーターボタン', btn('オペレーター')],
    ['氏名・金額は出さない', (r) => !/金額|氏名|電話/.test(r.text)]]);
  send('「予約変更」をタップ', tap('a=rsv_change&rid=' + RID_A), [['担当者が承る案内', has(/担当者/)], ['予約は変更しない', () => e.rows('予約管理')[0]['予約状態'] === 'CONFIRMED']]);
  send('「キャンセル」をタップ', tap('a=rsv_cancel_req&rid=' + RID_A), [['キャンセル手続きの案内', has(/キャンセル/)],
    ['タップだけでは取り消さない', () => e.rows('予約管理')[0]['予約状態'] === 'CONFIRMED']]);
  send('「予約確認」→ キャンセル済み ' + RID_B, (send('「予約確認」をタップ', tap('a=rsv_start')), say(RID_B)), [['予約内容を表示', has(/横浜ベイ遊覧/)]]);
  send('キャンセル済みで「予約変更」', tap('a=rsv_change&rid=' + RID_B), [['変更できない旨を案内', (r) => r.replied && !/予約サイトにて承ります/.test(r.text)], ['オペレーター導線', btn('オペレーター')]]);
  send('「予約確認」→ 他人の予約 ' + RID_C, (send('「予約確認」をタップ', tap('a=rsv_start')), say(RID_C)),
    [['他人の予約は表示しない', (r) => !/他人の予約/.test(r.text) && !/ご予約内容/.test(r.text)], ['オペレーターへ案内', btn('オペレーター')]]);
  send('「予約確認」→ 存在しない予約ID', (send('「予約確認」をタップ', tap('a=rsv_start')), say('TEST-' + DAY + '-FFFFFF')),
    [['同じ文面で案内（存在の有無を答えない）', (r) => r.text === steps[steps.length - 2].text], ['オペレーターへ案内', btn('オペレーター')]]);

  section = '4. お問い合わせ（4項目）';
  send('「お問い合わせ」をタップ', tap('a=inq_start'), [['チャーター見積', btn('チャーター見積')], ['フライト予約について', btn('フライト予約')],
    ['その他', btn('その他')], ['オペレーターに相談', btn('オペレーター')]]);
  const nInq0 = inq().length;
  send('「フライト予約について」', tap('a=inq_cat&c=1'), [['予約ページ準備中の案内', has(/準備中|公式サイト/)], ['オペレーター導線', btn('オペレーター')],
    ['受付IDを発行しない', () => inq().length === nInq0]]);
  send('「チャーター見積」', tap('a=inq_cat&c=4'), [['入力項目を案内', has(/出発地|目的地|人数/)]]);
  const charterEvt = say('11/20 14時 東京ヘリポート→箱根 3名 記念日');
  const charter = send('見積内容を送信', charterEvt, [['受付IDを案内', has(/INQ-\d{8}-\d{4}/)],
    ['料金を確約しない', (r) => !/\d+円/.test(r.text)], ['問い合わせ管理に保存（未対応・自動返信有効=FALSE）', () => lastInq()['対応状況'] === '未対応' && lastInq()['自動返信有効'] === false],
    ['運営に通知（メール）', () => e.mails.length >= 1]]);

  section = '5. 有人対応中は自動返信しない';
  send('「こんにちは」を送信', say('こんにちは'), [['返信しない', silent]]);
  send('「FAQ」を送信', say('FAQ'), [['返信しない', silent]]);
  send('「予約確認」をタップ', tap('a=rsv_start'), [['返信しない', silent]]);
  send('「よくある質問」をタップ', tap('a=menu_unset&item=FAQ'), [['返信しない', silent]]);
  const n1 = inq().length;
  send('LINE が見積メッセージを再送（同じイベントID）', Object.assign({}, charterEvt, { replyToken: tok(), deliveryContext: { isRedelivery: true } }),
    [['受付IDを重複発行しない', () => inq().length === n1], ['返信しない', silent]]);

  section = '6. 自動返信の再開（担当者がシートで TRUE）';
  const id = (charter.text.match(/INQ-\d{8}-\d{4}/) || [''])[0];
  run("(function(){var r=findRow_(SHEETS.INQUIRIES,'受付ID','" + id + "');var p={};p[OPERATOR.COL]=true;updateRow_(SHEETS.INQUIRIES,r.__row,p);})()");
  send('TRUE にした後「FAQ」を送信', say('FAQ'), [['自動返信が再開', (r) => r.replied]]);

  section = '7. その他・オペレーターに相談';
  send('「お問い合わせ」→「その他」', (send('「お問い合わせ」をタップ', tap('a=inq_start')), tap('a=inq_cat&c=5')), [['内容の入力を案内', (r) => r.replied]]);
  send('内容を送信', say('団体での利用は可能ですか'), [['受付IDを案内', has(/INQ-\d{8}-\d{4}/)], ['自動返信停止', () => lastInq()['自動返信有効'] === false]]);
  run("(function(){readRows_(SHEETS.INQUIRIES).forEach(function(r){var p={};p[OPERATOR.COL]=true;updateRow_(SHEETS.INQUIRIES,r.__row,p);});})()");
  send('「オペレーターに相談」', (send('「お問い合わせ」をタップ', tap('a=inq_start')), tap('a=inq_operator')), [['相談内容の入力を案内', (r) => r.replied]]);
  send('相談内容を送信', say('担当の方と話したいです'), [['受付IDを案内', has(/INQ-\d{8}-\d{4}/)], ['自動返信停止', () => lastInq()['自動返信有効'] === false]]);
  run("(function(){readRows_(SHEETS.INQUIRIES).forEach(function(r){var p={};p[OPERATOR.COL]=true;updateRow_(SHEETS.INQUIRIES,r.__row,p);})})()");
  send('予約カードの「オペレーターに相談」', (send('「予約確認」をタップ', tap('a=rsv_start')), send(RID_A, say(RID_A), []), tap('a=inq_operator&rid=' + encodeURIComponent(RID_A))),
    [['相談内容の入力を案内', (r) => r.replied]]);
  send('相談内容を送信', say('日程を変えたいです'), [['受付IDを案内', has(/INQ-\d{8}-\d{4}/)], ['予約IDを添えて保存（本人確認済み）', () => /TEST-20261106-A1B2C3/.test(lastInq()['内容'] + lastInq()['備考']) && /本人確認済み/.test(lastInq()['内容'] + lastInq()['備考'])]]);
  run("(function(){readRows_(SHEETS.INQUIRIES).forEach(function(r){var p={};p[OPERATOR.COL]=true;updateRow_(SHEETS.INQUIRIES,r.__row,p);})})()");

  section = '8. グループでは予約内容を出さない';
  send('グループで「予約確認」をタップ', tap('a=rsv_start', { type: 'group', groupId: 'C' + '1'.repeat(32), userId: ME }), [['1:1 トークへ誘導', has(/1:1|トーク/)]]);

  const errors = e.sheets['エラーログ'] ? e.rows('エラーログ') : [];
  return { steps, errors, pushes: e.linePosts('/v2/bot/message/push').length };
}

function toMarkdown(r) {
  const out = ['# 公式LINE フロー確認（モック環境）', '',
    '`node tools/test-env/scenario.js` の出力。LINE・Google には接続せず、GAS のコードをモック上で実行した結果です。実機確認の代わりにはなりません。', ''];
  let sec = '';
  r.steps.forEach((s) => {
    if (s.section !== sec) { sec = s.section; out.push('## ' + sec, ''); }
    const mark = s.checks.length ? (s.checks.every((c) => c.ok) ? '✅' : '❌') : '・';
    out.push('### ' + mark + ' ' + s.label, '');
    out.push(s.replied ? '```text\n' + (s.text || '（テキストなし）') + '\n```' : '（返信なし）');
    if (s.buttons.length) out.push('ボタン：' + s.buttons.join(' ／ '));
    s.checks.forEach((c) => out.push('- ' + (c.ok ? '✅ ' : '❌ ') + c.name));
    out.push('');
  });
  const all = r.steps.reduce((a, s) => a.concat(s.checks), []);
  out.push('## 集計', '', '確認項目 ' + all.length + ' 件：成功 ' + all.filter((c) => c.ok).length + ' 件／失敗 ' + all.filter((c) => !c.ok).length + ' 件',
    'エラーログ ' + r.errors.length + ' 件／プッシュ送信 ' + r.pushes + ' 件（予約内容のプッシュ送信なし）', '');
  return out.join('\n');
}

if (require.main === module) {
  const md = toMarkdown(runScenario());
  const i = process.argv.indexOf('--out');
  if (i !== -1) { fs.writeFileSync(path.resolve(process.argv[i + 1]), md); console.log('保存: ' + process.argv[i + 1]); } else console.log(md);
}
module.exports = { runScenario, toMarkdown };
