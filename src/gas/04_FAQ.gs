/**
 * 04_FAQ.gs
 * キーワード応答・FAQ 検索・自動応答。
 *
 * 判定順（上から優先）:
 *   1. 定型キーワードの完全一致（表記揺れ正規化後）
 *   2. FAQ シートのキーワード完全一致
 *   3. 定型キーワードの部分一致（INTENTS の priority が小さいほど優先）
 *   4. FAQ シートのキーワード部分一致（長いキーワードほど優先）
 *   5. 一致なし → 問い合わせ受付・有人対応へ誘導
 *
 * 正規化: NFKC（全角/半角統一）→ 小文字化 → カタカナをひらがなに → 空白・記号除去
 */

var INTENTS = [
  { id: 'BOOKING_CHECK', priority: 1, words: ['予約確認', '予約の確認', '予約内容', '予約状況', 'よやくかくにん', 'マイページ', 'mybooking', 'checkbooking'] },
  { id: 'CANCEL', priority: 2, words: ['キャンセル', '取消', '取り消し', 'とりけし', '払い戻し', '返金', 'cancel'] },
  { id: 'INQUIRY', priority: 3, words: ['問い合わせ', 'お問い合わせ', '問合せ', 'お問合せ', '問合わせ', 'といあわせ', '相談', '担当者', 'contact'] },
  { id: 'FAQ', priority: 4, words: ['FAQ', 'よくある質問', 'よくあるしつもん', 'q&a', 'qa', 'ヘルプ', 'help'] },
  { id: 'CHARTER', priority: 5, words: ['チャーター', '貸切', '貸し切り', 'かしきり', 'charter'] },
  { id: 'WEATHER', priority: 6, words: ['天候', '天気', '雨', '雨天', '悪天候', '強風', '風', '雪', '欠航', '運航', '運休', 'weather'] },
  { id: 'MEETING_POINT', priority: 7, words: ['集合場所', '集合', '場所', 'アクセス', '行き方', '駐車場', 'ヘリポート', '住所', 'access'] },
  { id: 'PRICE', priority: 8, words: ['料金', '値段', '価格', '金額', '費用', 'いくら', '運賃', 'price'] },
  { id: 'PLAN', priority: 9, words: ['プラン', 'コース', 'プラン一覧', 'メニュー', 'plan'] },
  { id: 'BOOKING', priority: 10, words: ['予約', 'よやく', '申し込み', '申込', 'もうしこみ', '空き', '空席', 'book', 'booking', 'reserve', 'reservation'] }
];

/** 表記揺れ正規化 */
function normalizeText_(s) {
  var t = String(s || '');
  if (t.normalize) t = t.normalize('NFKC');
  t = t.toLowerCase();
  // カタカナ → ひらがな
  t = t.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
  // 空白・句読点・記号を除去
  t = t.replace(/[\s　、。，．,.!！?？・「」『』()（）\[\]【】~〜ー\-_:：;；'"`]/g, '');
  return t;
}

/** 正規化済みのインテント辞書（実行内キャッシュ） */
var __intentIndex = null;
function intentIndex_() {
  if (__intentIndex) return __intentIndex;
  __intentIndex = INTENTS.map(function (it) {
    return { id: it.id, priority: it.priority, words: it.words.map(normalizeText_).filter(String) };
  });
  return __intentIndex;
}

/** 完全一致インテント */
function matchIntentExact_(norm) {
  var idx = intentIndex_();
  for (var i = 0; i < idx.length; i++) {
    if (idx[i].words.indexOf(norm) !== -1) return idx[i].id;
  }
  return null;
}

/**
 * 部分一致インテント（最優先のもの）。
 * 1文字キーワード（「雨」「風」など）は短文（6文字以下）のときのみ有効にし誤爆を抑える。
 */
function matchIntentPartial_(norm) {
  var best = null;
  intentIndex_().forEach(function (it) {
    var hit = it.words.some(function (w) {
      if (w.length === 1 && norm.length > 6) return false;
      return norm.indexOf(w) !== -1;
    });
    if (hit && (!best || it.priority < best.priority)) best = it;
  });
  return best ? best.id : null;
}

/** 有効な FAQ 一覧（キーワードを分割・正規化して保持） */
function loadFaqs_() {
  var rows;
  try { rows = readRows_(SHEETS.FAQ); } catch (e) { logError_('faq.read', e); return []; }
  return rows.filter(function (r) {
    return String(r['有効']).toUpperCase() === 'ON' && r['回答'];
  }).map(function (r) {
    var raw = String(r['質問・キーワード'] || '');
    var kws = raw.split(/[,，、\/／|｜\n]|・/).map(normalizeText_).filter(function (k) { return k.length > 0; });
    var whole = normalizeText_(raw);
    if (whole && kws.indexOf(whole) === -1) kws.push(whole);
    return {
      id: String(r['FAQ ID']),
      category: String(r['カテゴリ'] || ''),
      question: raw,
      answer: String(r['回答']),
      needsHuman: String(r['要有人確認']).toUpperCase() === 'YES',
      keywords: kws
    };
  });
}

/** FAQ 検索。exactOnly=true なら完全一致のみ */
function searchFaq_(norm, faqs, exactOnly) {
  var best = null, bestScore = 0;
  faqs.forEach(function (f) {
    f.keywords.forEach(function (k) {
      var score = 0;
      if (k === norm) score = 1000 + k.length;
      else if (!exactOnly && k.length >= 2 && norm.indexOf(k) !== -1) score = 100 + k.length;
      else if (!exactOnly && norm.length >= 2 && k.indexOf(norm) !== -1) score = 50 + norm.length;
      if (score > bestScore) { bestScore = score; best = f; }
    });
  });
  return best;
}

/** カテゴリ／キーワード群に該当する FAQ */
function findFaqByTopic_(faqs, words) {
  var nw = words.map(normalizeText_);
  for (var i = 0; i < faqs.length; i++) {
    var cat = normalizeText_(faqs[i].category);
    var hit = nw.some(function (w) {
      return cat === w || faqs[i].keywords.some(function (k) { return k.indexOf(w) !== -1 || (k.length >= 2 && w.indexOf(k) !== -1); });
    });
    if (hit) return faqs[i];
  }
  return null;
}

/** FAQ 回答メッセージ（要有人確認なら問い合わせ導線を付ける） */
function faqAnswerMessage_(faq) {
  var text = faq.answer;
  if (faq.needsHuman) {
    text += '\n\n個別の状況は担当者が確認してご案内します。必要な場合は「お問い合わせ」からご連絡ください。';
    return withQuickReply_(text, [postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ'), messageAction_('よくある質問', 'FAQ')]);
  }
  return withQuickReply_(text, [messageAction_('よくある質問', 'FAQ'), postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ')]);
}

/**
 * 受信テキストへの自動応答メッセージを組み立てる。
 * @return {Object[]} メッセージ配列（最大5件）
 */
function buildAutoReply_(text, userId) {
  var norm = normalizeText_(text);
  var faqs = loadFaqs_();

  var intent = matchIntentExact_(norm);
  if (!intent) {
    var exactFaq = searchFaq_(norm, faqs, true);
    if (exactFaq) return [faqAnswerMessage_(exactFaq)];
    intent = matchIntentPartial_(norm);
  }
  if (intent) return buildIntentReply_(intent, faqs);

  var faq = searchFaq_(norm, faqs, false);
  if (faq) return [faqAnswerMessage_(faq)];

  return buildUnmatchedReply_(text, userId);
}

/** インテント別の応答 */
function buildIntentReply_(intent, faqs) {
  switch (intent) {
    case 'BOOKING':
      return buildLinkMessage_('フライトのご予約は予約ページから、プラン・日程をお選びください。お支払いまで予約ページで完結します。',
        'フライト予約', getUrlSetting_(SETTING_KEYS.BOOKING_URL));
    case 'BOOKING_CHECK':
      return buildLinkMessage_('ご予約内容は予約確認ページでご確認いただけます。LINEでの本人確認後、ご本人のご予約のみ表示されます。',
        '予約確認', getBookingCheckUrl_());
    case 'PLAN':
      return buildLinkMessage_('遊覧飛行プランの一覧はこちらからご覧いただけます。', 'プラン一覧', getUrlSetting_(SETTING_KEYS.PLANS_URL));
    case 'PRICE': {
      var f = findFaqByTopic_(faqs, ['料金', '価格']);
      if (f) return [faqAnswerMessage_(f)];
      return buildLinkMessage_('料金はプラン・人数・日程により異なります。各プランの料金はプラン一覧でご確認ください。',
        'プラン一覧', getUrlSetting_(SETTING_KEYS.PLANS_URL));
    }
    case 'CHARTER': {
      var msgs = buildLinkMessage_('チャーター（貸切）フライトのご案内です。詳細・お見積りはチャーターページ、またはお問い合わせからご依頼ください。',
        'チャーター', getUrlSetting_(SETTING_KEYS.CHARTER_URL));
      msgs.push(withQuickReply_('お見積りをご希望の場合は下のボタンからどうぞ。', [postbackAction_('見積を依頼', 'a=inq_cat&c=4', 'チャーター見積')]));
      return msgs;
    }
    case 'WEATHER':
      return [topicReply_(faqs, ['運航', '天候', '雨天', '悪天候', '天気'],
        '天候等により運航内容が変更となる場合があります。運航可否は担当者が判断し、必要に応じてLINEでご案内します。')];
    case 'CANCEL':
      return [topicReply_(faqs, ['キャンセル', '取消'],
        'キャンセル条件はプラン・予約条件によって異なります。予約確認ページで内容をご確認いただくか、お問い合わせください。')];
    case 'MEETING_POINT':
      return [topicReply_(faqs, ['集合場所', '集合', 'アクセス'],
        '集合場所はご予約のプランによって異なります。予約確認ページのご予約詳細でご確認ください。')];
    case 'INQUIRY':
      return [buildInquiryCategoryMessage_()];
    case 'FAQ':
      return [buildFaqMenu_(faqs)];
  }
  return buildUnmatchedReply_('', null);
}

/** トピック応答：FAQ にあればそれを、なければ既定文＋問い合わせ導線 */
function topicReply_(faqs, words, fallback) {
  var f = findFaqByTopic_(faqs, words);
  if (f) return faqAnswerMessage_(f);
  return withQuickReply_(fallback, [
    messageAction_('予約確認', '予約確認'),
    postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ')
  ]);
}

/** FAQ メニュー（クイックリプライで質問を選択） */
function buildFaqMenu_(faqs) {
  faqs = faqs || loadFaqs_();
  if (!faqs.length) {
    return withQuickReply_('よくある質問は現在準備中です。お手数ですが「お問い合わせ」からご連絡ください。',
      [postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ')]);
  }
  var items = faqs.slice(0, 12).map(function (f) {
    var label = f.question.split(/[,，、]/)[0];
    return postbackAction_(label, 'a=faq&id=' + encodeURIComponent(f.id), label);
  });
  items.push(postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ'));
  return withQuickReply_('よくある質問です。知りたい項目を下から選ぶか、キーワード（例：料金、キャンセル、集合場所）を送信してください。', items);
}

/** FAQ ID 指定で回答 */
function buildFaqAnswerById_(id) {
  var faqs = loadFaqs_();
  for (var i = 0; i < faqs.length; i++) if (faqs[i].id === id) return faqAnswerMessage_(faqs[i]);
  return buildFaqMenu_(faqs);
}

/** 一致なし：担当者へ送るか選択してもらう */
function buildUnmatchedReply_(text, userId) {
  if (userId && text) {
    // 「担当者に送る」用に直前のメッセージを保持。未検証イベントでは応答成功後にのみ保存する
    __pendingAfterReply = function () {
      CacheService.getScriptCache().put('last:' + userId, String(text).substring(0, 2000), APP.INQUIRY_STATE_TTL_SEC);
    };
  }
  var items = [];
  if (userId && text) items.push(postbackAction_('担当者に送る', 'a=inq_handoff', '担当者に送る'));
  items.push(messageAction_('よくある質問', 'FAQ'));
  items.push(postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ'));
  items.push(messageAction_('予約', '予約'));
  return [withQuickReply_('メッセージありがとうございます。自動でお答えできる内容が見つかりませんでした。\n' +
    'このメッセージを担当者に送る場合は「担当者に送る」を選択してください。', items)];
}
