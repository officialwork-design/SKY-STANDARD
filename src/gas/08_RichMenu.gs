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
 * URL・LIFF ID・画像ファイルID は「ID管理」シートから読み込む。
 * URL 未設定のボタンはダミー URL にせず postback（a=menu_unset）にし、
 * タップ時は「準備中」を返信してログに記録する。シート「リッチメニュー」の「実装状態」列にも反映する。
 *
 * 画像: assets/richmenu/richmenu.png を Google ドライブにアップロードし、
 *       そのファイル ID を「ID管理」シートの RICHMENU_IMAGE_FILE_ID に入力する。
 */

var RICHMENU_SIZE = { width: 2500, height: 1686 };

/** ボタン定義（表示名はシート「リッチメニュー」の表示名と一致させる） */
function richMenuButtons_() {
  return [
    { name: 'フライト予約', url: getUrlSetting_(SETTING_KEYS.BOOKING_URL) },
    { name: '予約確認', url: getBookingCheckUrl_() },
    { name: 'プラン一覧', url: getUrlSetting_(SETTING_KEYS.PLANS_URL) },
    { name: 'チャーター', url: getUrlSetting_(SETTING_KEYS.CHARTER_URL) },
    { name: 'お問い合わせ', text: 'お問い合わせ' },
    { name: 'よくある質問', text: 'FAQ' }
  ];
}

/** リッチメニュー定義 JSON を生成（未設定一覧も返す） */
function buildRichMenuDefinition_() {
  var w = Math.floor(RICHMENU_SIZE.width / 3);
  var h = Math.floor(RICHMENU_SIZE.height / 2);
  var unset = [];
  var areas = richMenuButtons_().map(function (b, i) {
    var col = i % 3, row = Math.floor(i / 3);
    var bounds = {
      x: col * w, y: row * h,
      width: col === 2 ? RICHMENU_SIZE.width - 2 * w : w,
      height: row === 1 ? RICHMENU_SIZE.height - h : h
    };
    var action;
    if (b.text) {
      action = { type: 'message', label: b.name, text: b.text };
    } else if (b.url) {
      action = { type: 'uri', label: b.name, uri: b.url };
    } else {
      unset.push(b.name);
      action = { type: 'postback', label: b.name, data: 'a=menu_unset&item=' + encodeURIComponent(b.name), displayText: b.name };
    }
    return { bounds: bounds, action: action };
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
 * リッチメニューを作成 → 画像アップロード → 既定に設定 → 旧メニュー削除。
 * スプレッドシートのメニューまたはエディタから実行する。
 */
function deployRichMenu_() {
  var fileId = requireSetting_(ID_KEYS.RICHMENU_IMAGE_FILE_ID);
  var built = buildRichMenuDefinition_();
  var oldDefault = null;
  try { oldDefault = lineFetch_('get', '/v2/bot/user/all/richmenu').body.richMenuId; } catch (e) { /* 既定なし */ }

  lineFetch_('post', '/v2/bot/richmenu/validate', built.definition);
  var richMenuId = lineFetch_('post', '/v2/bot/richmenu', built.definition).body.richMenuId;
  try {
    var blob = DriveApp.getFileById(fileId).getBlob();
    var type = blob.getContentType();
    if (type !== 'image/png' && type !== 'image/jpeg') throw new Error('リッチメニュー画像は PNG または JPEG にしてください: ' + type);
    if (blob.getBytes().length > 1024 * 1024) throw new Error('リッチメニュー画像は 1MB 以下にしてください');
    lineFetch_('post', '/v2/bot/richmenu/' + richMenuId + '/content', undefined, { blob: blob, dataApi: true });
    lineFetch_('post', '/v2/bot/user/all/richmenu/' + richMenuId);
  } catch (e) {
    // 途中失敗時は作成したメニューを削除して元の状態を維持
    try { lineFetch_('delete', '/v2/bot/richmenu/' + richMenuId); } catch (e2) { /* noop */ }
    throw e;
  }
  if (oldDefault && oldDefault !== richMenuId) {
    try { lineFetch_('delete', '/v2/bot/richmenu/' + oldDefault); } catch (e) { logWarn_('richmenu.delete_old_failed', {}); }
  }
  updateRichMenuSheetStatus_(built);
  PropertiesService.getScriptProperties().setProperty('CURRENT_RICHMENU_ID', richMenuId);
  logInfo_('richmenu.deployed', { richMenuId: richMenuId, unset: built.unset });
  return { richMenuId: richMenuId, unset: built.unset };
}

/** シート「リッチメニュー」の実装状態・遷移先を更新（表示名で突合。他列は保持） */
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
