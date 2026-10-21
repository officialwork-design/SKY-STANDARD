/**
 * 08_RichMenu.gs
 * リッチメニューの登録・更新・既定設定。
 *
 * レイアウト: 2500 x 1686（大）/ 3列 x 2行
 *   ┌────────────┬────────────┬────────────┐
 *   │ フライト予約 │  予約確認   │ プラン一覧  │
 *   ├────────────┼────────────┼────────────┤
 *   │ チャーター  │ お問い合わせ │ よくある質問 │
 *   └────────────┴────────────┴────────────┘
 *
 * ■ ボタンの動作
 *   - フライト予約・予約確認・プラン一覧・チャーター
 *       URL 設定済み → uri（タップでページを開く）
 *       URL 未設定   → postback（a=menu_unset&item=KEY）。タップすると項目ごとの「現在準備中です」を返信
 *     予約サイト完成後は「ID管理」シートに URL を入力し、管理メニュー「リッチメニュー登録・更新」を
 *     実行するだけでリンク方式に切り替わる（コード変更は不要）。
 *     再登録するまでの間に準備中ボタンがタップされた場合も、URL が設定済みならリンクを案内する。
 *   - お問い合わせ → メッセージ「お問い合わせ」（既存の問い合わせフロー）
 *   - よくある質問 → メッセージ「FAQ」（既存の FAQ）
 *
 * ■ 画像
 *   「ID管理」シートの RICHMENU_IMAGE_FILE_ID（Google ドライブのファイルID）。
 *   PNG / JPEG、1MB 以下、2500 x 1686 px であることを登録前に検査する。
 */

var RICHMENU_SIZE = { width: 2500, height: 1686 };

/**
 * タップ領域の区切り位置（px）。画像の3列×2行のセルの間にある白い余白（区切り線）の中央に合わせている。
 * 2026-10-21 に提供画像（ドライブ ID 1eeeCZj8…、SKY_STANDARD_RICHMENU_2500x1686.jpg）を実測:
 *   縦の余白 x=830〜843 / 1659〜1672、横の余白 y=833〜843
 *   → 区切り x=837 / 1666、y=838（各セルの絵柄は必ず1つのタップ領域に収まり、領域は重ならず全面を覆う）
 * 画像のデザインを変更した場合は、余白の位置に合わせてこの値を更新する。
 */
var RICHMENU_GRID = { xs: [0, 837, 1666, 2500], ys: [0, 838, 1686] };

/** ボタン定義（左上から右へ、上段→下段。name はシート「リッチメニュー」の表示名と一致させる） */
var RICHMENU_ITEMS = [
  { key: 'BOOKING', name: 'フライト予約' },
  { key: 'BOOKING_CHECK', name: '予約確認' },
  { key: 'PLANS', name: 'プラン一覧' },
  { key: 'CHARTER', name: 'チャーター' },
  { key: 'INQUIRY', name: 'お問い合わせ', text: 'お問い合わせ' },
  { key: 'FAQ', name: 'よくある質問', text: 'FAQ' }
];

/** 準備中ボタンの既定の返信（通知テンプレート MENU_PENDING_<KEY> が有効ならそちらを優先） */
var RICHMENU_PENDING_TEXT = {
  BOOKING: '「フライト予約」は現在準備中です。\nオンライン予約の受付開始まで、今しばらくお待ちください。\nご予約のご相談は「お問い合わせ」から承ります。',
  BOOKING_CHECK: '「予約確認」は現在準備中です。\nご予約内容の確認・変更のご相談は「お問い合わせ」から承ります。',
  PLANS: '「プラン一覧」は現在準備中です。\nプランの詳細は公開まで今しばらくお待ちください。ご不明な点は「お問い合わせ」からどうぞ。',
  CHARTER: '「チャーター」は現在準備中です。\nチャーターのご相談・お見積りは「お問い合わせ」→「チャーター見積」から承ります。'
};

/** 各ボタンの現在の URL（未設定は ''） */
function richMenuUrlOf_(key) {
  switch (key) {
    case 'BOOKING': return getUrlSetting_(SETTING_KEYS.BOOKING_URL);
    case 'BOOKING_CHECK': return getBookingCheckUrl_();
    case 'PLANS': return getUrlSetting_(SETTING_KEYS.PLANS_URL);
    case 'CHARTER': return getUrlSetting_(SETTING_KEYS.CHARTER_URL);
    default: return '';
  }
}

/** ボタン定義（URL を解決済み） */
function richMenuButtons_() {
  return RICHMENU_ITEMS.map(function (it) {
    return { key: it.key, name: it.name, text: it.text, url: it.text ? '' : richMenuUrlOf_(it.key) };
  });
}

/** 名前・キーから項目を探す（旧形式 item=表示名 にも対応） */
function richMenuItemOf_(item) {
  var s = String(item || '');
  for (var i = 0; i < RICHMENU_ITEMS.length; i++) {
    if (RICHMENU_ITEMS[i].key === s || RICHMENU_ITEMS[i].name === s) return RICHMENU_ITEMS[i];
  }
  return null;
}

/** タップ領域（3列×2行。RICHMENU_GRID の区切りで全面を重なりなく分割） */
function richMenuBounds_(index) {
  var col = index % 3, row = Math.floor(index / 3);
  var xs = RICHMENU_GRID.xs, ys = RICHMENU_GRID.ys;
  return { x: xs[col], y: ys[row], width: xs[col + 1] - xs[col], height: ys[row + 1] - ys[row] };
}

/** リッチメニュー定義 JSON を生成（準備中のボタン一覧も返す） */
function buildRichMenuDefinition_() {
  var unset = [];
  var areas = richMenuButtons_().map(function (b, i) {
    var action;
    if (b.text) {
      action = { type: 'message', label: b.name, text: b.text };
    } else if (b.url) {
      action = { type: 'uri', label: b.name, uri: b.url };
    } else {
      unset.push(b.name);
      action = { type: 'postback', label: b.name, data: 'a=menu_unset&item=' + b.key, displayText: b.name };
    }
    return { bounds: richMenuBounds_(i), action: action };
  });
  return {
    definition: {
      size: RICHMENU_SIZE,
      selected: true,
      name: 'SKY STANDARD main ' + Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd-HHmm'),
      chatBarText: 'メニュー',
      areas: areas
    },
    unset: unset
  };
}

/**
 * 準備中ボタンがタップされたときの返信。
 * URL が設定済み（LINE 側の再登録前）ならリンクを案内し、未設定なら項目ごとの「現在準備中です」を返す。
 * item は利用者が改変できる値のため、既知の項目以外は文面に反映しない。
 */
function buildRichMenuPendingReply_(item) {
  var it = richMenuItemOf_(item);
  var quick = [postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ'), messageAction_('よくある質問', 'FAQ')];
  if (!it || it.text) {
    return [withQuickReply_('このメニューは現在準備中です。お手数ですが「お問い合わせ」からご連絡ください。', quick)];
  }
  var url = richMenuUrlOf_(it.key);
  if (url) return buildLinkMessage_('「' + it.name + '」はこちらからご利用いただけます。', it.name, url);
  var text = getTemplate_('MENU_PENDING_' + it.key) || RICHMENU_PENDING_TEXT[it.key];
  if (it.key === 'CHARTER') quick.unshift(postbackAction_('チャーター見積', 'a=inq_cat&c=4', 'チャーター見積'));
  return [withQuickReply_(text, quick)];
}

/* ---------- 画像の検査 ---------- */

/** PNG / JPEG のヘッダーから画像サイズを読む（読めなければ null） */
function imageSizeOf_(bytes) {
  var b = function (i) { return (bytes[i] + 256) % 256; };
  if (bytes.length > 24 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) {
    return { type: 'image/png', width: (b(16) << 24 | b(17) << 16 | b(18) << 8 | b(19)) >>> 0, height: (b(20) << 24 | b(21) << 16 | b(22) << 8 | b(23)) >>> 0 };
  }
  if (bytes.length > 4 && b(0) === 0xFF && b(1) === 0xD8) {
    var i = 2;
    while (i + 9 < bytes.length) {
      if (b(i) !== 0xFF) { i++; continue; }
      var marker = b(i + 1);
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      var len = b(i + 2) << 8 | b(i + 3);
      // SOF0〜SOF15（DHT=C4, JPG=C8, DAC=CC を除く）に高さ・幅がある
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { type: 'image/jpeg', height: b(i + 5) << 8 | b(i + 6), width: b(i + 7) << 8 | b(i + 8) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * リッチメニュー画像を検査する（LINE には何も送らない）。
 * @return {{ok:boolean, problems:string[], blob?:Blob, name?:string, bytes?:number, width?:number, height?:number, type?:string}}
 */
function validateRichMenuImage_() {
  var fileId = requireSetting_(ID_KEYS.RICHMENU_IMAGE_FILE_ID);
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    return { ok: false, problems: ['Google ドライブの画像を開けません（ファイルID・共有設定・権限を確認）: ' + sanitizeErrorText_(e && e.message)] };
  }
  var blob = file.getBlob();
  var bytes = blob.getBytes();
  var size = imageSizeOf_(bytes);
  var problems = [];
  var type = size ? size.type : blob.getContentType();
  if (type !== 'image/png' && type !== 'image/jpeg') problems.push('PNG または JPEG にしてください（現在: ' + type + '）');
  if (bytes.length > 1024 * 1024) problems.push('ファイルサイズを 1MB 以下にしてください（現在: ' + Math.round(bytes.length / 1024) + 'KB）');
  if (!size) problems.push('画像サイズを読み取れません');
  else if (size.width !== RICHMENU_SIZE.width || size.height !== RICHMENU_SIZE.height) {
    problems.push('画像サイズを ' + RICHMENU_SIZE.width + '×' + RICHMENU_SIZE.height + 'px にしてください（現在: ' + size.width + '×' + size.height + 'px）');
  }
  return { ok: !problems.length, problems: problems, blob: blob.setContentType(type), name: file.getName(), bytes: bytes.length,
    width: size && size.width, height: size && size.height, type: type };
}

/* ---------- 登録 ---------- */

/**
 * リッチメニューを登録する：画像の検査 → 定義の検証 → 作成 → 画像アップロード → 既定に設定 → 旧メニュー削除。
 * 画像に問題があれば LINE には何も作らずに止める。管理メニューから実行する（Webhook からは実行できない）。
 */
function deployRichMenu_() {
  var img = validateRichMenuImage_();
  if (!img.ok) throw new ConfigError('リッチメニュー画像に問題があります: ' + img.problems.join(' / '), ['RICHMENU_IMAGE_FILE_ID']);
  var built = buildRichMenuDefinition_();
  var oldDefault = null;
  try { oldDefault = lineFetch_('get', '/v2/bot/user/all/richmenu').body.richMenuId; } catch (e) { /* 既定なし（404） */ }

  lineFetch_('post', '/v2/bot/richmenu/validate', built.definition);
  var richMenuId = lineFetch_('post', '/v2/bot/richmenu', built.definition).body.richMenuId;
  try {
    lineFetch_('post', '/v2/bot/richmenu/' + richMenuId + '/content', undefined, { blob: img.blob, dataApi: true });
    lineFetch_('post', '/v2/bot/user/all/richmenu/' + richMenuId);
  } catch (e) {
    // 途中失敗時は作成したメニューを削除して元の状態を維持
    try { lineFetch_('delete', '/v2/bot/richmenu/' + richMenuId); } catch (e2) {
      // 作成途中のリッチメニューが LINE 側に残る（管理者の確認が必要）
      logError_('richmenu.rollback_failed', e2, { id: richMenuId });
    }
    throw e;
  }
  if (oldDefault && oldDefault !== richMenuId) {
    try { lineFetch_('delete', '/v2/bot/richmenu/' + oldDefault); } catch (e) { logWarn_('richmenu.delete_old_failed', {}); }
  }
  updateRichMenuSheetStatus_(built);
  PropertiesService.getScriptProperties().setProperty('CURRENT_RICHMENU_ID', richMenuId);
  logInfo_('richmenu.deployed', { id: richMenuId, unset: built.unset.length });
  return { richMenuId: richMenuId, unset: built.unset };
}

/**
 * LINE 側の既定リッチメニューと、現在の設定から作る定義を比較する（LINE には何も登録しない）。
 * @return {{registered:boolean, richMenuId?:string, needsUpdate:boolean, diffs:string[], error?:string}}
 */
function compareRegisteredRichMenu_() {
  var id;
  try {
    id = lineFetch_('get', '/v2/bot/user/all/richmenu').body.richMenuId;
  } catch (e) {
    if (e.status === 404) return { registered: false, needsUpdate: true, diffs: ['既定のリッチメニューが未登録です'] };
    return { registered: false, needsUpdate: false, diffs: [], error: sanitizeErrorText_(e.message) };
  }
  var current = lineFetch_('get', '/v2/bot/richmenu/' + encodeURIComponent(id)).body;
  var want = buildRichMenuDefinition_().definition.areas;
  var have = current.areas || [];
  var diffs = [];
  want.forEach(function (a, i) {
    var h = have[i];
    var label = a.action.label;
    if (!h) { diffs.push(label + ': LINE 側にボタンがありません'); return; }
    var hb = h.bounds || {}, wb = a.bounds;
    if (hb.x !== wb.x || hb.y !== wb.y || hb.width !== wb.width || hb.height !== wb.height) diffs.push(label + ': タップ領域が異なります');
    var ha = h.action || {};
    if (ha.type !== a.action.type) {
      diffs.push(label + ': ' + actionTypeLabel_(ha.type) + ' → ' + actionTypeLabel_(a.action.type) + ' に切り替えが必要');
    } else if (a.action.type === 'uri' && ha.uri !== a.action.uri) {
      diffs.push(label + ': リンク先 URL が異なります');
    }
  });
  return { registered: true, richMenuId: id, needsUpdate: diffs.length > 0, diffs: diffs };
}

function actionTypeLabel_(t) {
  return { uri: 'リンク', postback: '準備中表示', message: 'メッセージ送信' }[t] || String(t || '不明');
}

/** シート「リッチメニュー」の実装状態を更新（表示名で突合。他列は保持） */
function updateRichMenuSheetStatus_(built) {
  withLock_(function () {
    var rows = readRows_(SHEETS.RICHMENU);
    built.definition.areas.forEach(function (a) {
      var name = a.action.label;
      var row = rows.filter(function (r) { return String(r['表示名']) === name; })[0];
      if (!row) return;
      var isUnset = built.unset.indexOf(name) !== -1;
      // 遷移先列（[予約サイトURL] 等の参照表記）は運営の記載を尊重し変更しない
      updateRow_(SHEETS.RICHMENU, row.__row, { '実装状態': isUnset ? '未設定（準備中表示）' : '登録済み ' + nowString_() });
    });
  });
}

/** 登録済みリッチメニュー一覧（管理用） */
function listRichMenus_() {
  var list = lineFetch_('get', '/v2/bot/richmenu/list').body.richmenus || [];
  return list.map(function (m) { return { id: m.richMenuId, name: m.name, areas: m.areas.length }; });
}
