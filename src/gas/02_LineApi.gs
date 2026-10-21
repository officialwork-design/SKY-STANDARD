/**
 * 02_LineApi.gs
 * LINE Messaging API 呼び出し（返信・プッシュ・プロフィール・リッチメニュー）とエラー処理。
 */

/** LINE API エラー */
function LineApiError(status, body, retryable) {
  this.name = 'LineApiError';
  this.status = status;
  this.body = body;
  this.retryable = !!retryable;
  this.message = 'LINE API error ' + status + ': ' + summarizeLineError_(body);
}
LineApiError.prototype = Object.create(Error.prototype);
LineApiError.prototype.constructor = LineApiError;

function summarizeLineError_(body) {
  try {
    var j = JSON.parse(body);
    var s = j.message || '';
    if (j.details && j.details.length) s += ' / ' + j.details.map(function (d) { return d.property + ':' + d.message; }).join(', ');
    return s.substring(0, 300);
  } catch (e) {
    return String(body || '').substring(0, 200);
  }
}

/**
 * LINE API 呼び出し共通。
 * 429 / 5xx は retryable=true として LineApiError を投げる。
 */
function lineFetch_(method, path, payload, opts) {
  opts = opts || {};
  var token = requireProp_(PROP_KEYS.CHANNEL_ACCESS_TOKEN);
  var headers = { Authorization: 'Bearer ' + token };
  if (opts.retryKey) headers['X-Line-Retry-Key'] = opts.retryKey;
  var params = {
    method: method,
    headers: headers,
    muteHttpExceptions: true
  };
  if (opts.blob) {
    params.contentType = opts.blob.getContentType();
    params.payload = opts.blob.getBytes();
  } else if (payload !== undefined) {
    params.contentType = 'application/json; charset=UTF-8';
    params.payload = JSON.stringify(payload);
  }
  var base = opts.dataApi ? APP.LINE_DATA_API_BASE : APP.LINE_API_BASE;
  var res = UrlFetchApp.fetch(base + path, params);
  var code = res.getResponseCode();
  var text = res.getContentText();
  // X-Line-Retry-Key 重複時（409）は既に受理済み＝成功扱い
  if (code === 409 && opts.retryKey) return { status: 409, body: {}, duplicated: true };
  if (code < 200 || code >= 300) {
    throw new LineApiError(code, text, code === 429 || code >= 500);
  }
  var body = {};
  if (text) { try { body = JSON.parse(text); } catch (e) { body = {}; } }
  return { status: code, body: body };
}

/** メッセージ配列を正規化（文字列はテキストメッセージに、最大5件） */
function normalizeMessages_(messages) {
  if (!Array.isArray(messages)) messages = [messages];
  return messages.slice(0, 5).map(function (m) {
    if (typeof m === 'string') m = { type: 'text', text: m };
    if (m.type === 'text' && String(m.text).length > 5000) m.text = String(m.text).substring(0, 4990) + '…';
    return m;
  });
}

/** 現在処理中のイベントで応答済みか（Webhook 再処理可否の判定に使用） */
var __replySent = false;

/** 応答メッセージ（replyToken は1回限り・短時間有効） */
function replyMessage_(replyToken, messages) {
  if (!replyToken) return null;
  var res = lineFetch_('post', '/v2/bot/message/reply', {
    replyToken: replyToken,
    messages: normalizeMessages_(messages)
  });
  __replySent = true;
  return res;
}

/**
 * プッシュメッセージ。retryKey（UUID）を指定すると LINE 側でも重複送信が防止される。
 */
function pushMessage_(to, messages, retryKey) {
  if (!to) throw new Error('送信先が未指定です');
  return lineFetch_('post', '/v2/bot/message/push', {
    to: to,
    messages: normalizeMessages_(messages)
  }, { retryKey: retryKey });
}

/** プロフィール取得（失敗時 null） */
function getProfile_(userId) {
  try {
    return lineFetch_('get', '/v2/bot/profile/' + encodeURIComponent(userId)).body;
  } catch (e) {
    logWarn_('line.profile_failed', { userId: userId, status: e.status });
    return null;
  }
}

/** 月間配信上限と消費数（管理用） */
function getMessageQuota_() {
  var quota = lineFetch_('get', '/v2/bot/message/quota').body;
  var used = lineFetch_('get', '/v2/bot/message/quota/consumption').body;
  return { type: quota.type, limit: quota.value, used: used.totalUsage };
}

/** 文字列から決定的な UUID(v4 形式) を生成（X-Line-Retry-Key 用） */
function deterministicUuid_(seed) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
  var hex = bytes.slice(0, 16).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  // version 4 / variant 10xx を設定
  hex = hex.substring(0, 12) + '4' + hex.substring(13, 16) +
    ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16) + hex.substring(17);
  return hex.substring(0, 8) + '-' + hex.substring(8, 12) + '-' + hex.substring(12, 16) + '-' +
    hex.substring(16, 20) + '-' + hex.substring(20, 32);
}

/* ---------- メッセージ部品 ---------- */

/**
 * URI ボタン付きのテキスト（URL 未設定ならボタンを付けず「準備中」の案内のみ）。
 * ボタンテンプレートの本文上限(160字)を超える場合はテキスト＋ボタンの2通に分ける。
 * @return {Object[]} メッセージ配列
 */
function buildLinkMessage_(text, label, url) {
  if (!url) {
    return [{ type: 'text', text: text + '\n\n※ ' + label + 'のページは現在準備中です。お問い合わせはメニューの「お問い合わせ」からどうぞ。' }];
  }
  var short = text.length <= 160;
  var button = {
    type: 'template',
    altText: (label + ' ' + url).substring(0, 400),
    template: {
      type: 'buttons',
      text: short ? text : label + 'はこちらから',
      actions: [{ type: 'uri', label: label.substring(0, 20), uri: url }]
    }
  };
  return short ? [button] : [{ type: 'text', text: text }, button];
}

/** クイックリプライ付与 */
function withQuickReply_(message, items) {
  var m = typeof message === 'string' ? { type: 'text', text: message } : message;
  m.quickReply = {
    items: items.slice(0, 13).map(function (it) {
      return { type: 'action', action: it };
    })
  };
  return m;
}

/** postback アクション */
function postbackAction_(label, data, displayText) {
  var a = { type: 'postback', label: label.substring(0, 20), data: data };
  if (displayText) a.displayText = displayText;
  return a;
}

/** メッセージアクション */
function messageAction_(label, text) {
  return { type: 'message', label: label.substring(0, 20), text: text };
}
