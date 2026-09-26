/**
 * きになるカフェ バックエンド（Google Apps Script）
 *
 * スプレッドシートの「拡張機能 > Apps Script」にこのファイルの内容を貼り付けて使います。
 * 手順は README を参照してください。
 *
 * - データはこのスプレッドシートの rooms / members / cafes シートに保存
 * - 画面（GitHub Pages）からは doPost で JSON を受け取り JSON を返す
 * - リンク先の解析・Gemini による補完・写真のドライブ保存を行う
 */

const CONFIG = {
  GEMINI_MODEL_DEFAULT: 'gemini-3.8-flash',
  MAX_PHOTOS: 6,
  SAVE_PHOTOS_TO_DRIVE: true,
  PHOTO_FOLDER_NAME: 'きになるカフェ_写真',
  STALE_PENDING_MS: 2 * 60 * 1000,
  STALE_PROCESSING_MS: 7 * 60 * 1000,
};

const PALETTE = ['#E0694F', '#2F8F8B', '#7A5AC8', '#D39B1F', '#3F7FD1', '#C2527F'];

const SHEETS = {
  rooms: ['id', 'key_hash', 'created_at'],
  members: ['id', 'room_id', 'name', 'color', 'created_at'],
  cafes: [
    'id', 'room_id', 'member_id', 'source_url', 'status', 'error',
    'name', 'summary', 'genre', 'area', 'address', 'lat', 'lng',
    'hours', 'holidays', 'price', 'phone', 'access',
    'links', 'photos', 'memo', 'visited',
    'created_at', 'updated_at', 'processed_at',
  ],
};

const EDITABLE_FIELDS = [
  'name', 'summary', 'genre', 'area', 'address', 'hours', 'holidays', 'price', 'phone', 'access', 'memo',
];
const INFO_FIELDS = ['name', 'summary', 'genre', 'area', 'address', 'lat', 'lng', 'hours', 'holidays', 'price', 'phone', 'access'];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

// ===========================================================================
// 初期設定（エディタから一度だけ実行する）
// ===========================================================================
function setup() {
  Object.keys(SHEETS).forEach((name) => sheet_(name));
  if (CONFIG.SAVE_PHOTOS_TO_DRIVE) photoFolder_();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'processPending')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processPending').timeBased().everyMinutes(5).create();
  const hasKey = !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  console.log('セットアップ完了。' + (hasKey ? 'Gemini API キー設定済み。' : 'Gemini API キーは未設定です（任意）。'));
}

// ===========================================================================
// Web API
// ===========================================================================
function doGet() {
  return json_({ ok: true, app: 'kininaru-cafe' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'invalid json' });
  }
  try {
    return json_({ ok: true, data: handle_(req) });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const action = req.action;
  if (action === 'join_room') return joinRoom_(req.p_key, req.p_name);

  const room = findRoom_(req.p_key);
  if (!room) throw new Error('room not found');

  switch (action) {
    case 'load':
      return { members: listMembers_(room.id), cafes: listCafes_(room.id) };
    case 'list_members':
      return listMembers_(room.id);
    case 'list_cafes':
      return listCafes_(room.id);
    case 'update_member':
      return updateMember_(room.id, req.p_member_id, req.p_name, req.p_color);
    case 'add_cafe':
      return addCafe_(room.id, req.p_member_id, req.p_url, req.p_memo);
    case 'update_cafe':
      return updateCafe_(room.id, req.p_id, req.p_patch || {});
    case 'delete_cafe':
      return deleteCafe_(room.id, req.p_id);
    case 'reset_cafe':
      return patchCafe_(room.id, req.p_id, { status: 'pending', error: '' });
    case 'process':
      return processById_(room.id, req.p_id);
    case 'upload_photo':
      return uploadPhoto_(room.id, req.p_id, req.p_data);
    default:
      throw new Error('unknown action: ' + action);
  }
}

// ===========================================================================
// 部屋・メンバー
// ===========================================================================
function findRoom_(key) {
  if (!key) return null;
  return readAll_('rooms').find((r) => r.key_hash === key) || null;
}

function joinRoom_(key, name) {
  if (!key || String(key).length < 32) throw new Error('invalid key');
  name = String(name || '').trim();
  if (!name || name.length > 30) throw new Error('invalid name');

  return withLock_(() => {
    let room = findRoom_(key);
    if (!room) {
      room = { id: Utilities.getUuid(), key_hash: key, created_at: now_() };
      append_('rooms', room);
    }
    const members = readAll_('members').filter((m) => m.room_id === room.id);
    let member = members.find((m) => m.name === name);
    if (!member) {
      member = {
        id: Utilities.getUuid(),
        room_id: room.id,
        name: name,
        color: PALETTE[members.length % PALETTE.length],
        created_at: now_(),
      };
      append_('members', member);
    }
    return { room_id: room.id, member: memberOut_(member) };
  });
}

function listMembers_(roomId) {
  return readAll_('members')
    .filter((m) => m.room_id === roomId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map(memberOut_);
}

function updateMember_(roomId, memberId, name, color) {
  return withLock_(() => {
    const members = readAll_('members').filter((m) => m.room_id === roomId);
    const m = members.find((x) => x.id === memberId);
    if (!m) throw new Error('member not found');
    const newName = String(name || '').trim();
    if (newName && newName !== m.name) {
      if (members.some((x) => x.name === newName)) throw new Error('name already used');
      m.name = newName;
    }
    if (/^#[0-9A-Fa-f]{6}$/.test(color || '')) m.color = color;
    write_('members', m._row, m);
    return memberOut_(m);
  });
}

function memberOut_(m) {
  return { id: m.id, room_id: m.room_id, name: m.name, color: m.color, created_at: m.created_at };
}

// ===========================================================================
// カフェ
// ===========================================================================
function listCafes_(roomId) {
  return readAll_('cafes')
    .filter((c) => c.room_id === roomId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(cafeOut_);
}

function findCafe_(roomId, id) {
  return readAll_('cafes').find((c) => c.id === id && c.room_id === roomId) || null;
}

function addCafe_(roomId, memberId, url, memo) {
  if (!readAll_('members').some((m) => m.id === memberId && m.room_id === roomId)) {
    throw new Error('member not in room');
  }
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('invalid url');
  const t = now_();
  const cafe = {
    id: Utilities.getUuid(),
    room_id: roomId,
    member_id: memberId,
    source_url: url,
    status: 'pending',
    links: [],
    photos: [],
    memo: String(memo || '').trim(),
    visited: false,
    created_at: t,
    updated_at: t,
  };
  withLock_(() => append_('cafes', cafe));
  return cafeOut_(cafe);
}

function updateCafe_(roomId, id, patch) {
  const clean = {};
  EDITABLE_FIELDS.forEach((k) => {
    if (k in patch) clean[k] = patch[k] == null ? '' : String(patch[k]);
  });
  if (Array.isArray(patch.links)) {
    clean.links = patch.links
      .filter((l) => l && /^https?:\/\//.test(l.url || ''))
      .map((l) => ({ type: String(l.type || 'other'), label: String(l.label || ''), url: String(l.url) }));
  }
  if (Array.isArray(patch.photos)) clean.photos = patch.photos.filter((p) => /^https?:\/\//.test(p || ''));
  if ('visited' in patch) clean.visited = !!patch.visited;
  if ('lat' in patch) clean.lat = patch.lat === '' || patch.lat == null ? '' : Number(patch.lat);
  if ('lng' in patch) clean.lng = patch.lng === '' || patch.lng == null ? '' : Number(patch.lng);
  return patchCafe_(roomId, id, clean);
}

function patchCafe_(roomId, id, patch) {
  return withLock_(() => {
    const c = findCafe_(roomId, id);
    if (!c) throw new Error('cafe not found');
    Object.assign(c, patch, { updated_at: now_() });
    write_('cafes', c._row, c);
    return cafeOut_(c);
  });
}

function deleteCafe_(roomId, id) {
  withLock_(() => {
    const c = findCafe_(roomId, id);
    if (!c) return;
    sheet_('cafes').deleteRow(c._row);
  });
  // ドライブの写真もゴミ箱へ
  if (CONFIG.SAVE_PHOTOS_TO_DRIVE) {
    try {
      const files = photoFolder_().searchFiles(`title contains '${id}'`);
      while (files.hasNext()) files.next().setTrashed(true);
    } catch (err) {
      console.warn('photo cleanup failed', err);
    }
  }
  return null;
}

function uploadPhoto_(roomId, id, dataUrl) {
  if (!findCafe_(roomId, id)) throw new Error('cafe not found');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('invalid image');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 5000000) throw new Error('image too large');
  const blob = Utilities.newBlob(bytes, m[1], `${id}-u${Date.now()}.jpg`);
  return savePhotoBlob_(blob);
}

function cafeOut_(c) {
  const out = {};
  SHEETS.cafes.forEach((k) => {
    const v = c[k];
    out[k] = v === '' || v === undefined ? null : v;
  });
  out.links = parseJsonArray_(c.links);
  out.photos = parseJsonArray_(c.photos);
  out.visited = c.visited === true || String(c.visited).toUpperCase() === 'TRUE';
  out.lat = c.lat === '' || c.lat == null || isNaN(Number(c.lat)) ? null : Number(c.lat);
  out.lng = c.lng === '' || c.lng == null || isNaN(Number(c.lng)) ? null : Number(c.lng);
  return out;
}

function parseJsonArray_(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch (err) {
    return [];
  }
}

// ===========================================================================
// 情報収集
// ===========================================================================
function processById_(roomId, id) {
  const started = withLock_(() => {
    const c = findCafe_(roomId, id);
    if (!c) throw new Error('cafe not found');
    if (c.status === 'processing' && Date.now() - Date.parse(c.updated_at) < CONFIG.STALE_PROCESSING_MS) return null;
    c.status = 'processing';
    c.error = '';
    c.updated_at = now_();
    write_('cafes', c._row, c);
    return c;
  });
  if (started) processCafe_(started);
  const latest = findCafe_(roomId, id);
  return latest ? cafeOut_(latest) : null;
}

/** 時間主導トリガー: 放置された pending / processing を拾って処理する */
function processPending() {
  const deadline = Date.now() + 4 * 60 * 1000;
  const targets = readAll_('cafes').filter((c) => {
    const age = Date.now() - Date.parse(c.updated_at);
    return (c.status === 'pending' && age > CONFIG.STALE_PENDING_MS) ||
      (c.status === 'processing' && age > CONFIG.STALE_PROCESSING_MS);
  });
  for (const c of targets) {
    if (Date.now() > deadline) break;
    processById_(c.room_id, c.id);
  }
}

function processCafe_(cafe) {
  try {
    const sourceUrl = cafe.source_url;
    const source = scrapePage_(sourceUrl);
    const pages = source ? [source] : [];

    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    let ai = null;
    if (apiKey) {
      try {
        ai = researchWithGemini_(apiKey, sourceUrl, source);
      } catch (err) {
        console.error('gemini failed', err);
      }
    }

    // AIが見つけた公式アカウント等を優先（共有元URL自体は source_url として別途表示する）
    let links = dedupeLinks_([].concat(ai ? ai.links : [], [classifyLink_(sourceUrl)], source ? source.links : []));

    // 関連ページ（食べログ・公式HP）もスクレイピングして写真と情報を集める
    const scraped = pages.map((p) => normalizeUrl_(p.url));
    const extraTargets = links
      .filter((l) => ['tabelog', 'hp', 'retty', 'hotpepper'].indexOf(l.type) >= 0)
      .filter((l) => scraped.indexOf(normalizeUrl_(l.url)) < 0)
      .slice(0, 3);
    extraTargets.forEach((l) => {
      const p = scrapePage_(l.url);
      if (!p) return;
      pages.push(p);
      links = links.concat(p.links.filter((x) => x.type !== 'hp'));
    });
    links = dedupeLinks_(links);

    // 情報のマージ: Gemini > 食べログ > その他ページ の順に優先
    const ordered = pages.slice().sort((a, b) => pageRank_(a.url) - pageRank_(b.url));
    const info = {};
    [ai ? ai.info : {}].concat(ordered.map((p) => p.info)).forEach((src) => {
      Object.keys(src).forEach((k) => {
        const v = src[k];
        if (v === undefined || v === null || v === '') return;
        if (info[k] === undefined) info[k] = v;
      });
    });
    if (!info.area && info.address) info.area = guessArea_(info.address);

    // 写真: 食べログ → HP → 元ページ の順に集めて保存
    const candidates = dedupe_([].concat.apply([], ordered.map((p) => p.images)).concat(ai ? ai.imageUrls : []))
      .slice(0, CONFIG.MAX_PHOTOS * 2);
    const photos = storePhotos_(cafe.id, candidates);

    if (!info.name && !photos.length && links.length <= 1) throw new Error('ページから情報を取得できませんでした');

    // ユーザーが処理中に手で編集した項目は上書きしない
    withLock_(() => {
      const current = findCafe_(cafe.room_id, cafe.id);
      if (!current) return; // 処理中に削除された
      INFO_FIELDS.forEach((k) => {
        if (info[k] !== undefined && (current[k] === '' || current[k] == null)) current[k] = info[k];
      });
      current.links = dedupeLinks_(parseJsonArray_(current.links).concat(links));
      current.photos = dedupe_(parseJsonArray_(current.photos).concat(photos)).slice(0, 12);
      current.status = 'done';
      current.error = ai || !apiKey ? '' : 'AIによる補完に失敗したため、ページ解析結果のみです';
      current.processed_at = now_();
      current.updated_at = now_();
      write_('cafes', current._row, current);
    });
  } catch (err) {
    console.error('process failed', err);
    withLock_(() => {
      const current = findCafe_(cafe.room_id, cafe.id);
      if (!current) return;
      current.status = 'error';
      current.error = String((err && err.message) || err).slice(0, 300);
      current.updated_at = now_();
      write_('cafes', current._row, current);
    });
  }
}

function pageRank_(url) {
  const t = classifyLink_(url).type;
  return t === 'tabelog' ? 0 : t === 'hp' ? 1 : 2;
}

// ===========================================================================
// ページ取得・解析
// ===========================================================================
function fetchHtml_(url) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    let res;
    try {
      res = UrlFetchApp.fetch(current, {
        muteHttpExceptions: true,
        followRedirects: false,
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', Accept: 'text/html,*/*' },
      });
    } catch (err) {
      console.warn('fetch failed', current, String(err));
      return null;
    }
    const code = res.getResponseCode();
    if (code >= 300 && code < 400) {
      const loc = header_(res, 'Location');
      if (!loc) return null;
      current = absUrl_(loc, current);
      continue;
    }
    if (code !== 200) return null;
    const ct = header_(res, 'Content-Type') || '';
    if (!/html/i.test(ct)) return null;
    return { html: decodeResponse_(res, ct), finalUrl: current };
  }
  return null;
}

function header_(res, name) {
  const h = res.getHeaders();
  for (const k in h) {
    if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(h[k]) ? h[k][0] : h[k];
  }
  return undefined;
}

function decodeResponse_(res, contentType) {
  let charset = (/charset=([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset) {
    const head = res.getContentText('ISO-8859-1').slice(0, 4096);
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try {
    return res.getContentText(charset || 'UTF-8');
  } catch (err) {
    return res.getContentText('UTF-8');
  }
}

function scrapePage_(url) {
  const res = fetchHtml_(url);
  if (!res) return null;
  const html = res.html;
  const finalUrl = res.finalUrl;
  const info = {};
  const images = [];
  const links = [];

  // --- OGP / meta ---
  const meta = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
      'i',
    );
    const m = re.exec(html);
    return m ? decodeEntities_(m[1] || m[2] || '').trim() : undefined;
  };
  const ogTitle = meta('og:title') || decodeEntities_((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '').trim();
  const ogDesc = meta('og:description') || meta('description');
  const ogImage = meta('og:image') || meta('twitter:image');
  if (ogImage) images.push(absUrl_(ogImage, finalUrl));

  // --- JSON-LD ---
  extractJsonLd_(html).forEach((node) => {
    const types = [].concat(node['@type'] || []);
    const isPlace = types.some((t) => /Restaurant|Cafe|CafeOrCoffeeShop|FoodEstablishment|LocalBusiness|Bakery|Store/i.test(t));
    if (!isPlace) return;
    if (node.name && !info.name) info.name = String(node.name);
    if (node.description && !info.summary) info.summary = String(node.description);
    const addr = node.address;
    if (addr && !info.address) {
      info.address = typeof addr === 'string'
        ? addr
        : [addr.postalCode ? '〒' + addr.postalCode : '', addr.addressRegion, addr.addressLocality, addr.streetAddress]
          .filter(Boolean).join(' ').trim();
    }
    if (node.geo && node.geo.latitude && node.geo.longitude) {
      info.lat = Number(node.geo.latitude);
      info.lng = Number(node.geo.longitude);
    }
    if (node.telephone && !info.phone) info.phone = String(node.telephone);
    if (node.priceRange && !info.price) info.price = String(node.priceRange);
    if (node.servesCuisine && !info.genre) info.genre = [].concat(node.servesCuisine).join('、');
    if (node.openingHours && !info.hours) info.hours = [].concat(node.openingHours).join('\n');
    if (Array.isArray(node.openingHoursSpecification) && !info.hours) {
      info.hours = node.openingHoursSpecification
        .map((s) => `${[].concat(s.dayOfWeek || []).map(dayJa_).join('・')} ${s.opens || ''}〜${s.closes || ''}`)
        .join('\n');
    }
    [].concat(node.image || []).forEach((img) => {
      const u = typeof img === 'string' ? img : img && img.url;
      if (u) images.push(absUrl_(u, finalUrl));
    });
    [].concat(node.sameAs || []).forEach((s) => {
      if (typeof s === 'string') links.push(classifyLink_(s));
    });
  });

  // --- 店舗情報の表 (th/td, dt/dd) ---
  const table = extractTableInfo_(html);
  const fromTable = (keys) => {
    for (const k of keys) if (table[k] && table[k].text) return table[k].text;
    return undefined;
  };
  const setIfEmpty = (k, v) => {
    if (info[k] === undefined && v) info[k] = v;
  };
  setIfEmpty('name', fromTable(['店名', '店舗名']));
  setIfEmpty('genre', fromTable(['ジャンル']));
  setIfEmpty('address', fromTable(['住所', '所在地']));
  setIfEmpty('hours', fromTable(['営業時間']));
  setIfEmpty('holidays', fromTable(['定休日', '休業日']));
  setIfEmpty('price', fromTable(['予算', '平均予算']));
  setIfEmpty('phone', fromTable(['電話番号', 'TEL', '予約・お問い合わせ', 'お問い合わせ']));
  setIfEmpty('access', fromTable(['交通手段', 'アクセス', '最寄り駅']));
  // 食べログは「営業時間」欄に定休日や注意書きが混ざるので分離する
  if (info.hours) {
    const parts = info.hours.split(/■\s*定休日/);
    info.hours = parts[0].replace(/^■\s*営業時間\s*/, '').replace(/営業時間・定休日は変更[\s\S]*$/, '').trim();
    if (parts[1] && !info.holidays) info.holidays = parts[1].replace(/営業時間・定休日は変更[\s\S]*$/, '').trim();
  }
  ['ホームページ', '公式サイト', 'HP', '公式アカウント', 'SNS'].forEach((k) => {
    ((table[k] && table[k].hrefs) || []).forEach((href) => links.push(classifyLink_(absUrl_(href, finalUrl))));
  });

  // --- ページ内のSNSリンク（公式HPのときのみ。レビューサイトは運営会社のSNSが混ざるため）---
  const pageType = classifyLink_(finalUrl).type;
  if (pageType === 'hp') {
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
      const href = absUrl_(decodeEntities_(m[1]), finalUrl);
      const l = classifyLink_(href);
      if (l.type !== 'hp' && l.type !== 'other' && !isShareLink_(href)) links.push(l);
    }
  }

  // --- 写真候補 ---
  if (pageType === 'tabelog') {
    // 食べログには周辺店舗の写真も載っているため、alt が「店名 - ○○写真」のものだけを使う
    const storeName = info.name || cleanTitle_(ogTitle);
    let found = collectTabelogPhotos_(html, storeName);
    if (found.length < 4) {
      const base = finalUrl.replace(/(\/\d{6,}\/).*$/, '$1');
      const photoPage = fetchHtml_(base + 'dtlphotolst/');
      if (photoPage) found = found.concat(collectTabelogPhotos_(photoPage.html, storeName));
    }
    found.forEach((u) => images.push(u));
  } else if (pageType === 'hp') {
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const tag = m[0];
      const src = (/(?:data-src|src)=["']([^"']+)["']/i.exec(tag) || [])[1];
      if (!src || src.indexOf('data:') === 0) continue;
      if (/logo|icon|sprite|banner|btn|button|arrow|spacer|loading|\.svg|\.gif/i.test(src)) continue;
      const w = Number((/width=["']?(\d+)/i.exec(tag) || [])[1] || '0');
      if (w && w < 300) continue;
      images.push(absUrl_(decodeEntities_(src), finalUrl));
    }
  }

  // --- 名前・説明のフォールバック ---
  if (!info.name && ogTitle) info.name = cleanTitle_(ogTitle);
  // SNSのプロフィール説明（フォロワー数など）は紹介文として使わない
  if (!info.summary && ogDesc && !/フォロワー|Followers|投稿\d|posts/i.test(ogDesc)) {
    // 食べログの説明文にある評価・予算の定型部分を除く
    info.summary = ogDesc.replace(/^[★☆]+\s*[\d.]+\s*/, '').replace(/■\s*予算[\s\S]*$/, '').replace(/^■\s*/, '').slice(0, 200);
  }

  Object.keys(info).forEach((k) => {
    const v = info[k];
    if (typeof v !== 'string') return;
    const clean = decodeEntities_(v).replace(/[ \t 　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (clean && clean !== '-') info[k] = clean;
    else delete info[k];
  });

  return {
    url: finalUrl,
    info: info,
    links: links,
    images: dedupeImages_(
      images.filter((u) => /^https?:\/\//.test(u) && !/nophoto|no_photo|noimage|no_image|\/(?:1[05]0|200|100)x(?:1[05]0|200|100)_/i.test(u)),
    ).slice(0, 8),
  };
}

function collectTabelogPhotos_(html, storeName) {
  const out = [];
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = (/(?:data-original|data-src|src)=["']([^"']*\/restaurant\/images\/Rvw\/[^"']+)["']/i.exec(tag) || [])[1];
    if (!src) continue;
    const alt = decodeEntities_((/alt=["']([^"']*)["']/i.exec(tag) || [])[1] || '');
    if (!storeName || alt.indexOf(storeName) !== 0) continue;
    out.push(decodeEntities_(src).split('?')[0].replace(/\/resize\/\d+x\d+c\//, '/').replace(/\/\d+x\d+_(?:rect|square)_/, '/640x640_rect_'));
  }
  return out;
}

function extractJsonLd_(html) {
  const out = [];
  const walk = (d) => {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d)) return d.forEach(walk);
    out.push(d);
    if (d['@graph']) walk(d['@graph']);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch (err) {
      // 壊れた JSON-LD は無視
    }
  }
  return out;
}

function extractTableInfo_(html) {
  const out = {};
  const re = /<(th|dt)[^>]*>([\s\S]{1,200}?)<\/\1>\s*<(td|dd)[^>]*>([\s\S]{0,3000}?)<\/\3>/gi;
  for (const m of html.matchAll(re)) {
    const key = stripTags_(m[2]).replace(/\s/g, '');
    if (!key || key.length > 20 || out[key]) continue;
    const cell = m[4].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const hrefs = [];
    for (const h of cell.matchAll(/href=["']([^"']+)["']/gi)) hrefs.push(decodeEntities_(h[1]));
    const text = stripTags_(cell.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'))
      .split('\n').map((s) => s.trim()).filter(Boolean).join('\n')
      .replace(/大きな地図を見る[\s\S]*$/, '').replace(/周辺のお店[\s\S]*$/, '').trim();
    out[key] = { text: text.slice(0, 600), hrefs: hrefs };
  }
  return out;
}

function stripTags_(s) {
  return decodeEntities_(s.replace(/<[^>]+>/g, ' ')).replace(/[ \t　]+/g, ' ').trim();
}

function decodeEntities_(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanTitle_(t) {
  return String(t)
    .replace(/\s*[-|｜/／]\s*(食べログ|Retty|ホットペッパー.*|Instagram.*|Facebook.*)$/i, '')
    .replace(/\s*\(@[\w.]+\).*$/, '')
    .replace(/\s*[•・]\s*Instagram.*$/i, '')
    .replace(/on Instagram.*$/i, '')
    .trim()
    .slice(0, 80);
}

function dayJa_(d) {
  const map = {
    Monday: '月', Tuesday: '火', Wednesday: '水', Thursday: '木', Friday: '金', Saturday: '土', Sunday: '日',
    PublicHolidays: '祝',
  };
  const key = String(d).split('/').pop();
  return map[key] || key;
}

function guessArea_(address) {
  const m = /(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)?\s*([^\s\d０-９]{1,6}?[市区町村])/.exec(address);
  return m ? m[1] : undefined;
}

// Apps Script には URL クラスがないため簡易的に解析する
function parseUrl_(u) {
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(String(u || '').trim());
  if (!m) return null;
  return { protocol: m[1].toLowerCase(), host: m[2].toLowerCase().replace(/:\d+$/, ''), path: m[3] || '/', search: m[4] || '' };
}

function absUrl_(u, base) {
  u = String(u || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  const b = parseUrl_(base);
  if (!b) return u;
  if (u.indexOf('//') === 0) return b.protocol + ':' + u;
  const origin = b.protocol + '://' + (/^(https?):\/\/([^/?#]+)/i.exec(base) || [])[2];
  if (u.charAt(0) === '/') return origin + u;
  if (u.charAt(0) === '?' || u.charAt(0) === '#') return origin + b.path + u;
  return origin + b.path.replace(/[^/]*$/, '') + u;
}

// ===========================================================================
// リンク分類
// ===========================================================================
const LINK_TYPES = [
  { type: 'tabelog', label: '食べログ', test: /(^|\.)tabelog\.com$/ },
  { type: 'instagram', label: 'Instagram', test: /(^|\.)instagram\.com$/ },
  { type: 'x', label: 'X', test: /(^|\.)(x|twitter)\.com$/ },
  { type: 'facebook', label: 'Facebook', test: /(^|\.)facebook\.com$/ },
  { type: 'tiktok', label: 'TikTok', test: /(^|\.)tiktok\.com$/ },
  { type: 'threads', label: 'Threads', test: /(^|\.)threads\.(net|com)$/ },
  { type: 'line', label: 'LINE', test: /(^|\.)(line\.me|lin\.ee)$/ },
  { type: 'retty', label: 'Retty', test: /(^|\.)retty\.me$/ },
  { type: 'hotpepper', label: 'ホットペッパー', test: /(^|\.)hotpepper\.jp$/ },
  { type: 'gmap', label: 'Googleマップ', test: /^(maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$/ },
  { type: 'youtube', label: 'YouTube', test: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { type: 'note', label: 'note', test: /(^|\.)note\.com$/ },
];

function classifyLink_(url) {
  const u = parseUrl_(url);
  if (!u) return { type: 'other', label: 'リンク', url: url };
  if (/(^|\.)google\.com$/.test(u.host) && u.path.indexOf('/maps') === 0) return { type: 'gmap', label: 'Googleマップ', url: url };
  for (const t of LINK_TYPES) if (t.test.test(u.host)) return { type: t.type, label: t.label, url: url };
  if (/(^|\.)(google|yahoo|bing|amazon|apple)\./.test(u.host)) return { type: 'other', label: u.host, url: url };
  return { type: 'hp', label: '公式サイト', url: url };
}

function isShareLink_(url) {
  return /sharer|share\?|intent\/|\/share|dialog\/|plugins\/|\/hashtag\/|\/explore\//i.test(url);
}

function normalizeUrl_(url) {
  const u = parseUrl_(url);
  if (!u) return String(url);
  return (u.host.replace(/^www\./, '') + u.path.replace(/\/+$/, '')).toLowerCase();
}

function dedupeLinks_(links) {
  const seenUrl = {};
  const seenType = {};
  const out = [];
  links.forEach((l) => {
    if (!l || !/^https?:\/\//.test(l.url || '')) return;
    const n = normalizeUrl_(l.url);
    if (seenUrl[n]) return;
    // SNS・レビューサイトは1種類につき1つだけ（最初に見つかったものを優先）
    if (l.type !== 'other' && seenType[l.type]) return;
    seenUrl[n] = true;
    seenType[l.type] = true;
    out.push(l);
  });
  return out;
}

function dedupe_(arr) {
  return arr.filter((v, i) => arr.indexOf(v) === i);
}

function dedupeImages_(urls) {
  const seen = {};
  return urls.filter((u) => {
    // 食べログはサイズ違いの同一画像が多いので末尾のファイル名で判定
    const k = (u.split('?')[0].split('/').pop() || u).replace(/^\d+x\d+_(?:rect|square)_/, '');
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

// ===========================================================================
// Gemini による調査（Google検索グラウンディング + URL読み込み + JSON構造化出力）
// ===========================================================================
const CAFE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '店名。不明なら空文字' },
    summary: { type: 'string', description: 'どんな店かを伝える日本語の紹介文（60〜120字）。雰囲気・名物メニューなど' },
    genre: { type: 'string', description: '例: カフェ、喫茶店、ベーカリー、スイーツ' },
    area: { type: 'string', description: 'エリア名。例: 渋谷、代官山、京都・祇園' },
    address: { type: 'string', description: '住所（郵便番号付きが望ましい）' },
    hours: { type: 'string', description: '営業時間。曜日別に改行で区切る' },
    holidays: { type: 'string', description: '定休日' },
    price: { type: 'string', description: '予算の目安。例: ¥1,000〜¥1,999' },
    phone: { type: 'string' },
    access: { type: 'string', description: '最寄り駅からのアクセス' },
    official_url: { type: 'string', description: '公式サイトのURL（なければ空文字）' },
    tabelog_url: { type: 'string', description: '食べログの店舗ページURL（なければ空文字）' },
    instagram_url: { type: 'string', description: '店舗公式InstagramアカウントのURL（なければ空文字）' },
    x_url: { type: 'string', description: '店舗公式X(Twitter)アカウントのURL（なければ空文字）' },
    google_maps_url: { type: 'string', description: 'GoogleマップのURL（なければ空文字）' },
    other_urls: {
      type: 'array',
      description: 'その他の関連リンク（Retty、ホットペッパー、Facebook、TikTok、オンラインショップなど）',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        required: ['label', 'url'],
      },
    },
    image_urls: {
      type: 'array',
      description: '読み込んだページ内にあった、店内・外観・料理の写真の直接URL（jpg/png/webp）。確実なものだけ。なければ空配列',
      items: { type: 'string' },
    },
  },
  required: [
    'name', 'summary', 'genre', 'area', 'address', 'hours', 'holidays', 'price', 'phone', 'access',
    'official_url', 'tabelog_url', 'instagram_url', 'x_url', 'google_maps_url', 'other_urls', 'image_urls',
  ],
};

function researchWithGemini_(apiKey, sourceUrl, source) {
  const model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || CONFIG.GEMINI_MODEL_DEFAULT;
  const hints = source
    ? `\n\n参考: 共有URLを事前に解析した結果（不正確な場合あり）\n${JSON.stringify({ info: source.info, links: source.links }, null, 1).slice(0, 3000)}`
    : '\n\n（共有URLは直接取得できませんでした。SNSなどの可能性があります）';
  const prompt =
    `次のURLは友人が「気になるカフェ」として共有したものです。\n${sourceUrl}\n\n` +
    'このURLが指す店舗を特定し、Google検索とURLの読み込みで、公式サイト・食べログ・Instagram・X・Googleマップなどの関連リンクと、' +
    '住所・営業時間・定休日・予算・アクセスなどの基本情報を調べてください。' +
    '情報は日本語でまとめ、確認できなかった項目は空文字にしてください（推測で埋めないこと）。' +
    'URLは検索結果や読み込んだページで実在を確認できたものだけを、正規のURL（リダイレクト用URLではなく）で入れてください。' +
    `結果は指定のJSON形式で返してください。${hints}`;

  const body = (structured) => ({
    contents: [{
      role: 'user',
      parts: [{ text: structured ? prompt : `${prompt}\n\nJSONのキー: ${CAFE_SCHEMA.required.join(', ')}。JSON以外は出力しないこと。` }],
    }],
    tools: [{ google_search: {} }, { url_context: {} }],
    generationConfig: structured ? { responseMimeType: 'application/json', responseJsonSchema: CAFE_SCHEMA } : {},
  });
  const call = (payload) => UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    },
  );

  let res = call(body(true));
  // 構造化出力とツールの併用に対応していないモデルの場合は、テキストのJSONで受け取る
  if (res.getResponseCode() === 400) {
    console.warn('gemini structured output rejected, retrying without schema', res.getContentText().slice(0, 500));
    res = call(body(false));
  }
  if (res.getResponseCode() !== 200) {
    throw new Error(`gemini ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  }
  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  const parsed = parseJsonLoose_(text);
  if (!parsed) {
    console.warn('gemini returned no json', cand.finishReason, text.slice(0, 300));
    return null;
  }
  return toAiResult_(parsed);
}

function parseJsonLoose_(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (err2) {
      return null;
    }
  }
}

function toAiResult_(input) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const info = {};
  ['name', 'summary', 'genre', 'area', 'address', 'hours', 'holidays', 'price', 'phone', 'access'].forEach((k) => {
    if (s(input[k])) info[k] = s(input[k]);
  });

  const candidates = [];
  [input.official_url, input.tabelog_url, input.instagram_url, input.x_url, input.google_maps_url].forEach((u) => {
    if (/^https?:\/\//.test(s(u))) candidates.push(classifyLink_(s(u)));
  });
  (Array.isArray(input.other_urls) ? input.other_urls : []).forEach((o) => {
    const url = s(o && o.url);
    if (!/^https?:\/\//.test(url)) return;
    const l = classifyLink_(url);
    candidates.push(l.type === 'hp' || l.type === 'other' ? { type: 'other', label: s(o.label) || l.label, url: url } : l);
  });
  // AIが挙げたURLは実在確認してから採用する（存在しないURLを作ってしまうことがあるため）
  const links = candidates
    .filter((l) => !/grounding-api-redirect|vertexaisearch/.test(l.url))
    .filter((l) => urlExists_(l.url));
  const imageUrls = (Array.isArray(input.image_urls) ? input.image_urls : []).map(s).filter((u) => /^https?:\/\//.test(u));
  return { info: info, links: links, imageUrls: imageUrls };
}

function urlExists_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': UA } });
    // SNS はボット対策で 403 などを返すことがあるので、明確に存在しない場合だけ除外する
    const code = res.getResponseCode();
    return code !== 404 && code !== 410;
  } catch (err) {
    return false;
  }
}

// ===========================================================================
// 写真の保存
// ===========================================================================
function storePhotos_(cafeId, urls) {
  if (!urls.length) return [];
  const requests = urls.map((u) => ({
    url: u,
    muteHttpExceptions: true,
    headers: { 'User-Agent': UA, Referer: (/^(https?:\/\/[^/]+)/.exec(u) || [])[1] + '/' },
  }));
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    // 1件でも接続できないと fetchAll 全体が失敗するため、1件ずつ取り直す
    responses = requests.map((r) => {
      try {
        return UrlFetchApp.fetch(r.url, r);
      } catch (e) {
        return null;
      }
    });
  }
  const out = [];
  responses.forEach((res, i) => {
    if (out.length >= CONFIG.MAX_PHOTOS || !res || res.getResponseCode() !== 200) return;
    const type = String(header_(res, 'Content-Type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return;
    const blob = res.getBlob();
    const size = blob.getBytes().length;
    if (size < 8000 || size > 5000000) return; // アイコン等の小さすぎる画像は除外
    if (!CONFIG.SAVE_PHOTOS_TO_DRIVE) {
      out.push(urls[i]);
      return;
    }
    try {
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      blob.setName(`${cafeId}-${Date.now()}-${i}.${ext}`);
      out.push(savePhotoBlob_(blob));
    } catch (err) {
      console.warn('drive save failed', err);
      out.push(urls[i]);
    }
  });
  return out;
}

function savePhotoBlob_(blob) {
  const file = photoFolder_().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    console.warn('setSharing failed', err);
  }
  return `https://lh3.googleusercontent.com/d/${file.getId()}`;
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // 削除されていたら作り直す
    }
  }
  const folder = DriveApp.createFolder(CONFIG.PHOTO_FOLDER_NAME);
  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    console.warn('folder setSharing failed', err);
  }
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// ===========================================================================
// シート操作
// ===========================================================================
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    const cols = SHEETS[name];
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = SHEETS[name];
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const out = [];
  values.forEach((row, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => {
      const v = row[j];
      o[c] = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : v;
    });
    if (o.id) out.push(o);
  });
  return out;
}

function write_(name, rowIndex, obj) {
  const cols = SHEETS[name];
  const values = cols.map((c) => {
    const v = obj[c];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  });
  // 電話番号の先頭 0 や日付の自動変換を防ぐため書式を「書式なしテキスト」にする
  sheet_(name).getRange(rowIndex, 1, 1, cols.length).setNumberFormat('@').setValues([values]);
}

function append_(name, obj) {
  write_(name, sheet_(name).getLastRow() + 1, obj);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function now_() {
  return new Date().toISOString();
}
