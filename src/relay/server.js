/**
 * LINE Webhook 署名検証リレー（Cloud Run 等で稼働）
 *
 * GAS Web アプリは HTTP ヘッダー（X-Line-Signature）を参照できないため、
 * このリレーで LINE の署名を検証し、共有シークレットで HMAC 署名した封筒に包んで GAS へ転送する。
 *
 * 環境変数（秘密情報は Secret Manager 等で注入すること）
 *   LINE_CHANNEL_SECRET   … LINE Messaging API チャネルシークレット
 *   RELAY_SHARED_SECRET   … GAS スクリプトプロパティ RELAY_SHARED_SECRET と同じ値
 *   GAS_WEBAPP_URL        … GAS Web アプリ URL（https://script.google.com/macros/s/.../exec）
 *   PORT                  … 待受ポート（Cloud Run が設定）
 *
 * 依存パッケージなし（Node.js 18 以上）
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 1024 * 1024;

/** X-Line-Signature 検証（base64(HMAC-SHA256(channelSecret, rawBody))） */
function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(String(signature), 'base64');
  } catch (e) {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** GAS へ渡す封筒を作成 */
function buildEnvelope(rawBody, relaySecret, now = Date.now()) {
  const body = rawBody.toString('utf8');
  const ts = String(now);
  const sig = crypto.createHmac('sha256', relaySecret).update(ts + '.' + body, 'utf8').digest('base64');
  return { kind: 'line_webhook', ts: Number(ts), body, sig };
}

/**
 * GAS へ転送し { status, ok } を返す。
 * GAS は常に HTTP 200 を返すため、本文の ok を見て成否を判断する。
 * ok:false（一時失敗・設定不足など）の場合、呼び出し側は 500 を返し LINE の再送に委ねる
 * （LINE の再送には回数・期間の上限がある。処理済みイベントは GAS 側で重複排除される）。
 */
async function forwardToGas(envelope, gasUrl, fetchImpl = fetch, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      redirect: 'follow',
      signal: ctrl.signal
    });
    let body = {};
    try { body = await res.json(); } catch (e) { body = {}; }
    return { status: res.status, ok: res.status === 200 && body.ok === true, error: body.error };
  } finally {
    clearTimeout(timer);
  }
}

function createServer(config, fetchImpl = fetch) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method !== 'POST' || !req.url.startsWith('/webhook')) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks);
      if (!verifyLineSignature(raw, req.headers['x-line-signature'], config.channelSecret)) {
        console.warn(JSON.stringify({ level: 'WARN', event: 'relay.bad_signature' }));
        res.writeHead(401);
        return res.end();
      }
      // GAS の処理結果を待って応答する。GAS が一時的な失敗（ok:false）を返した場合は 500 を返し、
      // LINE の「Webhookの再送」で再配信させる（処理済みイベントは GAS 側で重複排除される）。
      const envelope = buildEnvelope(raw, config.relaySecret);
      forwardToGas(envelope, config.gasUrl, fetchImpl, config.timeoutMs)
        .then((result) => {
          console.info(JSON.stringify({ level: 'INFO', event: 'relay.forwarded', status: result.status, ok: result.ok }));
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end('{}');
        })
        .catch((err) => {
          console.error(JSON.stringify({ level: 'ERROR', event: 'relay.forward_failed', message: err.message }));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
    });
  });
}

function loadConfig(env = process.env) {
  const cfg = {
    channelSecret: env.LINE_CHANNEL_SECRET || '',
    relaySecret: env.RELAY_SHARED_SECRET || '',
    gasUrl: env.GAS_WEBAPP_URL || '',
    timeoutMs: Number(env.GAS_TIMEOUT_MS || 25000)
  };
  const missing = Object.entries({ LINE_CHANNEL_SECRET: cfg.channelSecret, RELAY_SHARED_SECRET: cfg.relaySecret, GAS_WEBAPP_URL: cfg.gasUrl })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error('必須の環境変数が未設定です: ' + missing.join(', '));
  if (!/^https:\/\/script\.google\.com\//.test(cfg.gasUrl)) throw new Error('GAS_WEBAPP_URL は https://script.google.com/ で始まる URL を指定してください');
  return cfg;
}

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // 設定不足時は起動しない（安全停止）
    console.error(e.message);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8080);
  createServer(config).listen(port, () => console.log('relay listening on ' + port));
}

module.exports = { verifyLineSignature, buildEnvelope, forwardToGas, createServer, loadConfig };
