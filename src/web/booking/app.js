/**
 * SKY STANDARD 予約確認（LIFF）
 *
 * - config.json（liffId, apiUrl）を読み込み、未設定なら明示的にエラー表示する。
 * - LINE ログイン後、ID トークンを GAS API へ送り、サーバー側で検証された本人の予約のみ表示する。
 * - LINE ユーザーIDを URL パラメータ等で送ることはしない。
 * - どの段階で失敗しても「起動中」のまま止まらないよう、タイムアウトとエラー表示を設ける。
 */
(function () {
  'use strict';

  var INIT_TIMEOUT_MS = 10000;
  var API_TIMEOUT_MS = 20000;
  var state = { config: null, reservations: [], current: null };

  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['view-loading', 'view-error', 'view-list', 'view-empty', 'view-detail'];

  function show(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    $('footer-actions').hidden = !(id === 'view-list' || id === 'view-detail' || id === 'view-empty');
    window.scrollTo(0, 0);
  }

  function loading(text) {
    $('loading-text').textContent = text || '読み込んでいます…';
    show('view-loading');
  }

  function fail(message, opts) {
    opts = opts || {};
    $('error-text').textContent = message;
    $('btn-relogin').hidden = !opts.relogin;
    show('view-error');
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(label + '_timeout')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function loadConfig() {
    return fetch('config.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('config_missing'); return r.json(); })
      .then(function (c) {
        if (!c || !c.liffId || !/^https:\/\//.test(c.apiUrl || '')) throw new Error('config_incomplete');
        return c;
      });
  }

  function waitForSdk() {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function check() {
        if (window.liff) return resolve(window.liff);
        if (Date.now() - start > INIT_TIMEOUT_MS) return reject(new Error('sdk_load_failed'));
        setTimeout(check, 100);
      })();
    });
  }

  function api(action, extra) {
    var idToken = window.liff.getIDToken();
    if (!idToken) return Promise.reject(new Error('no_id_token'));
    var body = Object.assign({ kind: 'liff_api', action: action, idToken: idToken }, extra || {});
    // text/plain にして CORS プリフライトを回避（GAS Web アプリの制約）
    return withTimeout(fetch(state.config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      credentials: 'omit'
    }), API_TIMEOUT_MS, 'api').then(function (r) {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    });
  }

  function handleApiError(res) {
    var code = res && res.error;
    if (code === 'auth_failed') {
      return fail('ログインの有効期限が切れたか、本人確認ができませんでした。LINEで再ログインしてください。', { relogin: true });
    }
    if (code === 'not_configured') return fail('予約確認機能は現在準備中です。お手数ですがLINEのトークからお問い合わせください。');
    return fail('ご予約情報を取得できませんでした。時間をおいて再度お試しください。');
  }

  /* ---------- 表示 ---------- */

  function fmtAmount(v) {
    if (v === '' || v == null) return '—';
    var n = Number(v);
    return isFinite(n) ? '¥' + n.toLocaleString('ja-JP') : String(v);
  }
  function txt(v) { return v === '' || v == null ? '—' : String(v); }

  function renderList(list) {
    state.reservations = list;
    if (!list.length) return show('view-empty');
    var ul = $('list');
    ul.textContent = '';
    list.forEach(function (r, i) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card';
      var date = document.createElement('span'); date.className = 'card__date'; date.textContent = txt(r.flightDate) + (r.timeSlot ? ' ' + r.timeSlot : '');
      var plan = document.createElement('span'); plan.className = 'card__plan'; plan.textContent = txt(r.planName);
      var meta = document.createElement('span'); meta.className = 'card__meta'; meta.textContent = '予約番号 ' + txt(r.reservationId);
      var st = document.createElement('span'); st.className = 'badge'; st.textContent = txt(r.status);
      btn.appendChild(date); btn.appendChild(plan); btn.appendChild(meta); btn.appendChild(st);
      btn.addEventListener('click', function () { renderDetail(i); });
      li.appendChild(btn);
      ul.appendChild(li);
    });
    show('view-list');
  }

  function renderDetail(i) {
    var r = state.reservations[i];
    state.current = r;
    $('d-plan').textContent = txt(r.planName);
    $('d-id').textContent = txt(r.reservationId);
    $('d-date').textContent = txt(r.flightDate);
    $('d-time').textContent = txt(r.timeSlot);
    $('d-pax').textContent = r.passengers === '' || r.passengers == null ? '—' : r.passengers + '名';
    $('d-amount').textContent = fmtAmount(r.amount);
    $('d-status').textContent = txt(r.status);
    $('d-payment').textContent = txt(r.paymentStatus);
    $('d-meeting').textContent = r.meetingPoint || 'ご予約確定後にご案内します';
    $('d-notes').textContent = r.notes || '特記事項はありません。運航は天候等により変更となる場合があります。';
    var badges = $('d-badges');
    badges.textContent = '';
    [r.status, r.paymentStatus].filter(Boolean).forEach(function (b) {
      var s = document.createElement('span'); s.className = 'badge'; s.textContent = b; badges.appendChild(s);
    });
    show('view-detail');
  }

  /* ---------- 操作 ---------- */

  function loadReservations() {
    loading('ご予約を確認しています…');
    return api('list').then(function (res) {
      if (!res.ok) return handleApiError(res);
      renderList(res.reservations || []);
    }).catch(function (e) {
      if (e.message === 'no_id_token') return fail('本人確認情報を取得できませんでした。LINEで再ログインしてください。', { relogin: true });
      fail('通信に失敗しました。電波の良い場所で再度お試しください。');
    });
  }

  function onLinkSubmit(ev) {
    ev.preventDefault();
    var id = $('link-id').value.trim();
    var contact = $('link-contact').value.trim();
    var msg = $('link-msg');
    if (!id || !contact) { msg.textContent = '予約番号と電話番号またはメールアドレスを入力してください。'; return; }
    msg.textContent = '確認しています…';
    api('link', { reservationId: id, contact: contact }).then(function (res) {
      if (res.ok) { msg.textContent = ''; return loadReservations(); }
      var map = {
        not_matched: '入力内容と一致するご予約が見つかりませんでした。',
        too_many_attempts: '確認の回数が上限に達しました。1時間ほどおいてお試しいただくか、お問い合わせください。',
        link_unavailable: '現在この画面から本人確認を行うことができません。お手数ですがお問い合わせください。',
        invalid_input: '入力内容をご確認ください。',
        auth_failed: 'ログインの有効期限が切れました。画面を再読み込みしてください。'
      };
      msg.textContent = map[res.error] || '確認できませんでした。時間をおいて再度お試しください。';
    }).catch(function () { msg.textContent = '通信に失敗しました。再度お試しください。'; });
  }

  function onInquiry() {
    var liff = window.liff;
    // 定型語「お問い合わせ」を送ると、トークで問い合わせ種別の選択が始まる
    var text = 'お問い合わせ';
    if (liff && liff.isInClient && liff.isInClient() && liff.isApiAvailable && liff.isApiAvailable('sendMessages') !== false) {
      liff.sendMessages([{ type: 'text', text: text }])
        .then(function () { liff.closeWindow(); })
        .catch(function () { $('inquiry-msg').hidden = false; });
    } else {
      $('inquiry-msg').hidden = false;
    }
  }

  function relogin() {
    try { window.liff.logout(); } catch (e) { /* noop */ }
    window.liff.login({ redirectUri: location.href.split('#')[0] });
  }

  function start() {
    loading('読み込んでいます…');
    loadConfig().then(function (c) {
      state.config = c;
      return waitForSdk();
    }).then(function (liff) {
      return withTimeout(liff.init({ liffId: state.config.liffId }), INIT_TIMEOUT_MS, 'liff_init').then(function () { return liff; });
    }).then(function (liff) {
      if (!liff.isLoggedIn()) {
        loading('LINEログイン画面へ移動しています…');
        liff.login({ redirectUri: location.href.split('#')[0] });
        // 遷移しなかった場合のフォールバック
        setTimeout(function () { fail('ログイン画面に移動できませんでした。', { relogin: true }); }, 8000);
        return;
      }
      return loadReservations();
    }).catch(function (e) {
      var m = String(e && e.message || '');
      if (m.indexOf('config_') === 0) return fail('予約確認機能は現在準備中です（設定未完了）。お手数ですがLINEのトークからお問い合わせください。');
      if (m === 'sdk_load_failed') return fail('LINEの読み込みに失敗しました。通信環境をご確認のうえ再度お試しください。');
      if (m === 'liff_init_timeout') return fail('LINEの起動に時間がかかっています。再度お試しください。');
      fail('LINEの初期化に失敗しました。LINEアプリから開き直してください。');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('btn-retry').addEventListener('click', start);
    $('btn-relogin').addEventListener('click', relogin);
    $('btn-back').addEventListener('click', function () { renderList(state.reservations); });
    $('btn-inquiry').addEventListener('click', onInquiry);
    $('link-form').addEventListener('submit', onLinkSubmit);
    start();
  });
})();
