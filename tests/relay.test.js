'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { verifyLineSignature, buildEnvelope, createServer, loadConfig } = require('../src/relay/server');
const { createGasEnv } = require('./helpers/gas-env');

const SECRET = 'channel-secret';
const RELAY = 'relay-secret';
const sign = (body, s = SECRET) => crypto.createHmac('sha256', s).update(body).digest('base64');

test('X-Line-Signature の検証', () => {
  const body = Buffer.from('{"events":[]}');
  assert.equal(verifyLineSignature(body, sign(body), SECRET), true);
  assert.equal(verifyLineSignature(body, sign(body, 'other'), SECRET), false);
  assert.equal(verifyLineSignature(body, '', SECRET), false);
  assert.equal(verifyLineSignature(body, 'short', SECRET), false);
});

test('リレーの封筒を GAS 側が検証して受け付ける（相互互換）', () => {
  const env = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: 't', RELAY_SHARED_SECRET: RELAY } });
  const raw = Buffer.from(JSON.stringify({ destination: 'U', events: [] }), 'utf8');
  assert.equal(env.doPost(buildEnvelope(raw, RELAY)).ok, true);
  assert.equal(env.doPost(buildEnvelope(raw, 'wrong')).error, 'bad_signature');
});

test('日本語を含む本文でも GAS 側の HMAC と一致', () => {
  const env = createGasEnv({ props: { LINE_CHANNEL_ACCESS_TOKEN: 't', RELAY_SHARED_SECRET: RELAY } });
  const raw = Buffer.from(JSON.stringify({ destination: 'U', events: [], note: '予約確認・テスト' }), 'utf8');
  assert.equal(env.doPost(buildEnvelope(raw, RELAY)).ok, true);
});

test('設定不足では起動しない', () => {
  assert.throws(() => loadConfig({}), /LINE_CHANNEL_SECRET/);
  assert.throws(() => loadConfig({ LINE_CHANNEL_SECRET: 'a', RELAY_SHARED_SECRET: 'b', GAS_WEBAPP_URL: 'https://evil.example/' }), /GAS_WEBAPP_URL/);
});

function request(server, { method = 'POST', path = '/webhook', body = '', headers = {} }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ port, method, path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP: 署名不正は 401・転送しない、正しい署名は 200・GAS へ転送', async () => {
  const forwarded = [];
  let gasOk = true;
  const fakeFetch = async (url, opts) => { forwarded.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({ ok: gasOk }) }; };
  const server = createServer({ channelSecret: SECRET, relaySecret: RELAY, gasUrl: 'https://script.google.com/macros/s/x/exec' }, fakeFetch);
  await new Promise((r) => server.listen(0, r));
  try {
    const body = JSON.stringify({ destination: 'U', events: [] });
    assert.equal(await request(server, { body, headers: { 'x-line-signature': sign(body, 'bad') } }), 401);
    assert.equal(forwarded.length, 0);
    assert.equal(await request(server, { body, headers: { 'x-line-signature': sign(body) } }), 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].body.kind, 'line_webhook');
    assert.equal(forwarded[0].body.body, body);
    gasOk = false; // GAS 側の一時失敗 → 500 で LINE に再送させる
    assert.equal(await request(server, { body, headers: { 'x-line-signature': sign(body) } }), 500);
    assert.equal(await request(server, { method: 'GET', path: '/healthz' }), 200);
  } finally {
    server.close();
  }
});
