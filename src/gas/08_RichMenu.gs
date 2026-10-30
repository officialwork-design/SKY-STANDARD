/**
 * 08_RichMenu.gs
 * リッチメニューの登録・更新・既定設定。
 *
 * レイアウト（2026-10-30〜）: 画像「空と都市を巡るヘリチャーター案内.png」1543 x 1019 / 4領域
 *   ┌──────────────────────────────────────┐
 *   │          ご予約はこちら ❯❯❯❯           │  ← 上部全面
 *   ├────────────┬────────────┬────────────┤
 *   │  予約確認   │ お問い合わせ │ よくある質問 │
 *   └────────────┴────────────┴────────────┘
 *
 * ■ ボタンの動作
 *   - ご予約はこちら … 公式サイト（ID管理 BOOKING_SITE_URL）を開く。URL 未設定の間は postback で「準備中」を返信
 *   - 予約確認       … postback a=rsv_start（LINE トークで予約IDの入力を開始。06_Reservation.gs）
 *   - お問い合わせ   … postback a=inq_start（4項目のお問い合わせメニュー。05_Inquiry.gs）
 *   - よくある質問   … 公式サイトの FAQ（ID管理 FAQ_PAGE_URL）を開く。URL 未設定の間は postback で「準備中」を返信
 *   URL は「ID管理」に入力して管理メニュー「リッチメニュー登録・更新」を実行すると反映される（ダミー URL は使わない）。
 *   旧メニュー（6領域）のボタン（menu_unset の PLANS・CHARTER など、メッセージ「お問い合わせ」「FAQ」）にも引き続き応答する。
 *
 * ■ 画像
 *   「ID管理」の RICHMENU_IMAGE_FILE_ID（Google ドライブのファイルID）。1543 x 1019 px、PNG / JPEG。
 *   LINE の上限 1MB を超える PNG は、登録時に GAS で JPEG に変換して使う（ドライブの元画像は変更しない）。
 */

/** 画像サイズ（LINE のリッチメニューは画像と同じサイズで定義する。幅 800〜2500、幅/高さ 1.45 以上） */
var RICHMENU_SIZE = { width: 1543, height: 1019 };

/**
 * タップ領域の区切り位置（px）。2026-10-30 にドライブの画像（ID 17JrCm0unhRnSG2En65jmVSl116Sq4ipf）を実測:
 *   上段と下段の間の白い区切り線 y=535〜536、下段の縦の区切り線 x=514〜516 / 1028〜1030
 *   → 区切り y=536、x=515 / 1029（各ボタンの絵柄は1つの領域に収まり、領域は重ならず全面を覆う）
 * 画像のデザインを変えた場合は、区切り線の位置に合わせてこの値を更新する。
 */
var RICHMENU_GRID = { topHeight: 536, xs: [0, 515, 1029, 1543] };

/** ボタン定義（上段 → 下段の左から右。name はシート「リッチメニュー」の表示名） */
var RICHMENU_ITEMS = [
  { key: 'BOOKING', name: 'ご予約はこちら' },
  { key: 'BOOKING_CHECK', name: '予約確認', postback: 'a=rsv_start' },
  { key: 'INQUIRY', name: 'お問い合わせ', postback: 'a=inq_start' },
  { key: 'FAQ', name: 'よくある質問' }
];

/** 旧メニュー（6領域）だけにあったボタン。LINE 上のメニューを切り替えるまでの間も応答する */
var RICHMENU_LEGACY_ITEMS = [
  { key: 'PLANS', name: 'プラン一覧' },
  { key: 'CHARTER', name: 'チャーター' },
  { key: 'BOOKING', name: 'フライト予約' }
];

/** 準備中ボタンの既定の返信（通知テンプレート MENU_PENDING_<KEY> が有効ならそちらを優先） */
var RICHMENU_PENDING_TEXT = {
  // 返信にはクイックリプライ（お問い合わせ・よくある質問、チャーターは見積も）が付くため、本文ではボタン名を繰り返さない
  BOOKING: '🚁 フライトのご予約は、現在準備中でございます。\nオンライン予約の開始まで、今しばらくお待ちくださいませ。ご予約のご相談は、下記より承ります。',
  FAQ: '📋 よくある質問のページは、現在準備中でございます。\nご不明な点は、下記よりお気軽にご相談くださいませ。',
  PLANS: '✨ プラン一覧は、現在準備中でございます。\n公開まで今しばらくお待ちくださいませ。ご不明な点は、下記よりお気軽にどうぞ。',
  CHARTER: '🚁 チャーターのご案内ページは、現在準備中でございます。\nご相談・お見積りは、下記より承ります。'
};

/** 各ボタンの現在の URL（未設定は ''） */
function richMenuUrlOf_(key) {
  switch (key) {
    case 'BOOKING': return getUrlSetting_(SETTING_KEYS.BOOKING_URL);
    case 'FAQ': return getUrlSetting_(SETTING_KEYS.FAQ_URL);
    case 'PLANS': return getUrlSetting_(SETTING_KEYS.PLANS_URL);
    case 'CHARTER': return getUrlSetting_(SETTING_KEYS.CHARTER_URL);
    default: return '';
  }
}

/** ボタン定義（URL を解決済み） */
function richMenuButtons_() {
  return RICHMENU_ITEMS.map(function (it) {
    return { key: it.key, name: it.name, postback: it.postback || '', url: it.postback ? '' : richMenuUrlOf_(it.key) };
  });
}

/** 名前・キーから項目を探す（旧メニューの項目・旧形式 item=表示名 にも対応） */
function richMenuItemOf_(item) {
  var s = String(item || '');
  var all = RICHMENU_ITEMS.concat(RICHMENU_LEGACY_ITEMS);
  for (var i = 0; i < all.length; i++) {
    if (all[i].key === s || all[i].name === s) return all[i];
  }
  if (s === '予約確認') return RICHMENU_ITEMS[1];
  return null;
}

/** タップ領域（0=上部全面、1〜3=下段の左・中央・右。全面を重なりなく分割） */
function richMenuBounds_(index) {
  var g = RICHMENU_GRID;
  if (index === 0) return { x: 0, y: 0, width: RICHMENU_SIZE.width, height: g.topHeight };
  var col = index - 1;
  return { x: g.xs[col], y: g.topHeight, width: g.xs[col + 1] - g.xs[col], height: RICHMENU_SIZE.height - g.topHeight };
}

/** リッチメニュー定義 JSON を生成（準備中のボタン一覧も返す） */
function buildRichMenuDefinition_() {
  var unset = [];
  var areas = richMenuButtons_().map(function (b, i) {
    var action;
    if (b.postback) {
      action = { type: 'postback', label: b.name, data: b.postback, displayText: b.name };
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
 * 準備中ボタン（postback a=menu_unset）がタップされたときの返信。
 * URL が設定済み（LINE 側の再登録前）ならリンクを案内し、未設定なら項目ごとの「現在準備中です」を返す。
 * 旧メニューの「予約確認」は LINE トークでの予約確認を始める。
 * item は利用者が改変できる値のため、既知の項目以外は文面に反映しない。
 */
function buildRichMenuPendingReply_(item) {
  var it = richMenuItemOf_(item);
  var quick = [postbackAction_('お問い合わせ', 'a=inq_start', 'お問い合わせ'), messageAction_('よくある質問', 'FAQ')];
  if (!it || it.postback || !RICHMENU_PENDING_TEXT[it.key]) {
    return [withQuickReply_('🚁 このメニューは、現在準備中でございます。\nご不明な点は、下記よりお気軽にご相談くださいませ。', quick)];
  }
  var url = richMenuUrlOf_(it.key);
  if (url) return buildLinkMessage_('✨ 「' + it.name + '」は、下記よりご利用いただけます。', it.name, url);
  var text = getTemplate_('MENU_PENDING_' + it.key) || RICHMENU_PENDING_TEXT[it.key];
  if (it.key === 'CHARTER') quick.unshift(postbackAction_('チャーター見積', 'a=inq_cat&c=4', 'チャーター見積'));
  if (it.key === 'FAQ') quick = [quick[0]];
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
  var converted = '', triedConvert = false;
  // LINE の上限（1MB）を超える PNG は JPEG に変換して使う（サイズ・絵柄は同じ。ドライブの元画像は変更しない）
  if (bytes.length > 1024 * 1024 && size && size.type === 'image/png') {
    triedConvert = true;
    try {
      var jpg = blob.getAs('image/jpeg');
      var jb = jpg.getBytes();
      var js = imageSizeOf_(jb);
      if (js && js.width === size.width && js.height === size.height && jb.length <= 1024 * 1024) {
        converted = 'PNG（' + Math.round(bytes.length / 1024) + 'KB）を JPEG（' + Math.round(jb.length / 1024) + 'KB）に変換して使用';
        blob = jpg; bytes = jb; size = js;
      }
    } catch (e) { logWarn_('richmenu.convert_failed', { message: sanitizeErrorText_(e && e.message) }); }
  }
  var type = size ? size.type : blob.getContentType();
  if (type !== 'image/png' && type !== 'image/jpeg') problems.push('PNG または JPEG にしてください（現在: ' + type + '）');
  if (bytes.length > 1024 * 1024) {
    problems.push('ファイルサイズを 1MB 以下にしてください（現在: ' + Math.round(bytes.length / 1024) + 'KB' +
      (triedConvert ? '。JPEG への自動変換でも 1MB 以下・同じサイズにできませんでした' : '') + '）');
  }
  if (!size) problems.push('画像サイズを読み取れません');
  else if (size.width !== RICHMENU_SIZE.width || size.height !== RICHMENU_SIZE.height) {
    problems.push('画像サイズを ' + RICHMENU_SIZE.width + '×' + RICHMENU_SIZE.height + 'px にしてください（現在: ' + size.width + '×' + size.height + 'px）');
  }
  return { ok: !problems.length, problems: problems, blob: blob.setContentType(type), name: file.getName(), bytes: bytes.length,
    width: size && size.width, height: size && size.height, type: type, converted: converted };
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
  var cs = current.size || {};
  if (cs.width !== RICHMENU_SIZE.width || cs.height !== RICHMENU_SIZE.height || have.length !== want.length) {
    diffs.push('メニューの構成が異なります（LINE 側: ' + (cs.width || '?') + '×' + (cs.height || '?') + '・' + have.length + '領域 → 新: ' +
      RICHMENU_SIZE.width + '×' + RICHMENU_SIZE.height + '・' + want.length + '領域）');
  }
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
    } else if (a.action.type === 'postback' && ha.data !== a.action.data) {
      diffs.push(label + ': ボタンの動作が異なります');
    }
  });
  return { registered: true, richMenuId: id, needsUpdate: diffs.length > 0, diffs: diffs };
}

function actionTypeLabel_(t) {
  return { uri: 'リンク', postback: 'postback（準備中表示・LINE内の操作）', message: 'メッセージ送信' }[t] || String(t || '不明');
}

/** シート「リッチメニュー」の実装状態を更新（表示名で突合。他列は保持） */
function updateRichMenuSheetStatus_(built) {
  withLock_(function () {
    var rows = readRows_(SHEETS.RICHMENU);
    built.definition.areas.forEach(function (a) {
      var name = a.action.label;
      var row = rows.filter(function (r) { return String(r['表示名']) === name; })[0];
      if (!row) {
        // 新しいボタン（例：ご予約はこちら）は行を追加する（既存の行は削除しない）
        appendRow_(SHEETS.RICHMENU, { '表示名': name, 'アクション': a.action.type === 'uri' ? 'URI' : 'postback',
          '遷移先URL・送信テキスト': a.action.type === 'uri' ? a.action.uri : a.action.data,
          '実装状態': built.unset.indexOf(name) !== -1 ? '未設定（準備中表示）' : '登録済み ' + nowString_(), '備考': '4領域メニュー' });
        return;
      }
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
