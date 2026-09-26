// ページ取得・解析（HTML から店舗情報・関連リンク・写真候補を抽出する）

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export type Link = { type: string; label: string; url: string };

export type Info = {
  name?: string;
  summary?: string;
  genre?: string;
  area?: string;
  address?: string;
  lat?: number;
  lng?: number;
  hours?: string;
  holidays?: string;
  price?: string;
  phone?: string;
  access?: string;
};

export type PageData = {
  url: string;
  info: Info;
  links: Link[];
  images: string[];
};

// ---------------------------------------------------------------------------
// ページ取得・解析
// ---------------------------------------------------------------------------
async function fetchHtml(url: string, timeoutMs = 10000): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8", Accept: "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return { html: decodeHtml(buf, ct), finalUrl: res.url || url };
  } catch (e) {
    console.warn("fetch failed", url, String(e));
    return null;
  }
}

function decodeHtml(buf: Uint8Array, contentType: string) {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export async function scrapePage(url: string): Promise<PageData | null> {
  const res = await fetchHtml(url);
  if (!res) return null;
  const { html, finalUrl } = res;
  const info: Info = {};
  const images: string[] = [];
  const links: Link[] = [];

  // --- OGP / meta ---
  const meta = (prop: string) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
      "i",
    );
    const m = re.exec(html);
    return m ? decodeEntities(m[1] ?? m[2] ?? "").trim() : undefined;
  };
  const ogTitle = meta("og:title") ?? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const ogDesc = meta("og:description") ?? meta("description");
  const ogImage = meta("og:image") ?? meta("twitter:image");
  if (ogImage) images.push(absUrl(ogImage, finalUrl));

  // --- JSON-LD ---
  for (const node of extractJsonLd(html)) {
    const types = ([] as string[]).concat(node["@type"] ?? []);
    const isPlace = types.some((t) =>
      /Restaurant|Cafe|CafeOrCoffeeShop|FoodEstablishment|LocalBusiness|Bakery|Store/i.test(t)
    );
    if (!isPlace) continue;
    if (node.name && !info.name) info.name = String(node.name);
    if (node.description && !info.summary) info.summary = String(node.description);
    const addr = node.address;
    if (addr && !info.address) {
      info.address = typeof addr === "string"
        ? addr
        : [addr.postalCode ? `〒${addr.postalCode}` : "", addr.addressRegion, addr.addressLocality, addr.streetAddress]
          .filter(Boolean).join(" ").trim();
    }
    if (node.geo?.latitude && node.geo?.longitude) {
      info.lat = Number(node.geo.latitude);
      info.lng = Number(node.geo.longitude);
    }
    if (node.telephone && !info.phone) info.phone = String(node.telephone);
    if (node.priceRange && !info.price) info.price = String(node.priceRange);
    if (node.servesCuisine && !info.genre) info.genre = [].concat(node.servesCuisine).join("、");
    if (node.openingHours && !info.hours) info.hours = [].concat(node.openingHours).join("\n");
    if (Array.isArray(node.openingHoursSpecification) && !info.hours) {
      info.hours = node.openingHoursSpecification
        .map((s: any) => `${[].concat(s.dayOfWeek ?? []).map(dayJa).join("・")} ${s.opens ?? ""}〜${s.closes ?? ""}`)
        .join("\n");
    }
    for (const img of [].concat(node.image ?? [])) {
      const u = typeof img === "string" ? img : (img as any)?.url;
      if (u) images.push(absUrl(u, finalUrl));
    }
    for (const s of [].concat(node.sameAs ?? [])) if (typeof s === "string") links.push(classifyLink(s));
  }

  // --- 店舗情報の表 (th/td, dt/dd) ---
  const table = extractTableInfo(html);
  const fromTable = (keys: string[]) => {
    for (const k of keys) if (table[k]?.text) return table[k].text;
  };
  info.name ??= fromTable(["店名", "店舗名"]);
  info.genre ??= fromTable(["ジャンル"]);
  info.address ??= fromTable(["住所", "所在地"]);
  info.hours ??= fromTable(["営業時間"]);
  info.holidays ??= fromTable(["定休日", "休業日"]);
  info.price ??= fromTable(["予算", "平均予算"]);
  info.phone ??= fromTable(["電話番号", "TEL", "予約・お問い合わせ", "お問い合わせ"]);
  info.access ??= fromTable(["交通手段", "アクセス", "最寄り駅"]);
  // 食べログは「営業時間」欄に定休日や注意書きが混ざるので分離する
  if (info.hours) {
    const [h, rest] = info.hours.split(/■\s*定休日/);
    info.hours = h.replace(/^■\s*営業時間\s*/, "").trim();
    if (rest && !info.holidays) info.holidays = rest.replace(/営業時間・定休日は変更.*$/s, "").trim();
    info.hours = info.hours.replace(/営業時間・定休日は変更.*$/s, "").trim();
  }
  for (const k of ["ホームページ", "公式サイト", "HP", "公式アカウント", "SNS"]) {
    for (const href of table[k]?.hrefs ?? []) links.push(classifyLink(absUrl(href, finalUrl)));
  }

  // --- ページ内のSNSリンク（公式HPのときのみ。レビューサイトは運営会社のSNSが混ざるため）---
  const pageType = classifyLink(finalUrl).type;
  if (pageType === "hp") {
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
      const href = absUrl(decodeEntities(m[1]), finalUrl);
      const l = classifyLink(href);
      if (l.type !== "hp" && l.type !== "other" && !isShareLink(href)) links.push(l);
    }
  }

  // --- 写真候補 ---
  if (pageType === "tabelog") {
    // 食べログには周辺店舗の写真も載っているため、alt が「店名 - ○○写真」のものだけを使う
    const storeName = info.name ?? cleanTitle(ogTitle);
    let found = collectTabelogPhotos(html, storeName);
    if (found.length < 4) {
      const base = finalUrl.replace(/(\/\d{6,}\/).*$/, "$1");
      const photoPage = await fetchHtml(base + "dtlphotolst/");
      if (photoPage) found = [...found, ...collectTabelogPhotos(photoPage.html, storeName)];
    }
    images.push(...found);
  } else if (pageType === "hp") {
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const tag = m[0];
      const src = /(?:data-src|src)=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!src || src.startsWith("data:")) continue;
      if (/logo|icon|sprite|banner|btn|button|arrow|spacer|loading|\.svg|\.gif/i.test(src)) continue;
      const w = Number(/width=["']?(\d+)/i.exec(tag)?.[1] ?? "0");
      if (w && w < 300) continue;
      images.push(absUrl(decodeEntities(src), finalUrl));
    }
  }

  // --- 名前・説明のフォールバック ---
  if (!info.name && ogTitle) info.name = cleanTitle(ogTitle);
  if (!info.summary && ogDesc) {
    // 食べログの説明文にある評価・予算の定型部分を除く
    info.summary = ogDesc.replace(/^[★☆]+\s*[\d.]+\s*/, "").replace(/■\s*予算.*$/s, "").replace(/^■\s*/, "").slice(0, 200);
  }

  for (const k of Object.keys(info) as (keyof Info)[]) {
    const v = info[k];
    if (typeof v !== "string") continue;
    const clean = decodeEntities(v).replace(/[ \t\u00a0　]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (clean && clean !== "-") (info as any)[k] = clean;
    else delete info[k];
  }

  return {
    url: finalUrl,
    info,
    links,
    images: dedupeImages(
      images.filter((u) => /^https?:\/\//.test(u) && !/nophoto|no_photo|noimage|no_image|\/(?:1[05]0|200|100)x(?:1[05]0|200|100)_/i.test(u)),
    ).slice(0, 8),
  };
}

function collectTabelogPhotos(html: string, storeName: string | undefined): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = /(?:data-original|data-src|src)=["']([^"']*\/restaurant\/images\/Rvw\/[^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const alt = decodeEntities(/alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "");
    if (!storeName || !alt.startsWith(storeName)) continue;
    out.push(decodeEntities(src).split("?")[0].replace(/\/resize\/\d+x\d+c\//, "/").replace(/\/\d+x\d+_(?:rect|square)_/, "/640x640_rect_"));
  }
  return out;
}

function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const walk = (d: any) => {
        if (!d || typeof d !== "object") return;
        if (Array.isArray(d)) return d.forEach(walk);
        out.push(d);
        if (d["@graph"]) walk(d["@graph"]);
      };
      walk(data);
    } catch { /* 壊れた JSON-LD は無視 */ }
  }
  return out;
}

function extractTableInfo(html: string): Record<string, { text: string; hrefs: string[] }> {
  const out: Record<string, { text: string; hrefs: string[] }> = {};
  const re = /<(th|dt)[^>]*>([\s\S]{1,200}?)<\/\1>\s*<(td|dd)[^>]*>([\s\S]{0,3000}?)<\/\3>/gi;
  for (const m of html.matchAll(re)) {
    const key = stripTags(m[2]).replace(/\s/g, "");
    if (!key || key.length > 20 || out[key]) continue;
    const cell = m[4]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");
    const hrefs = [...cell.matchAll(/href=["']([^"']+)["']/gi)].map((h) => decodeEntities(h[1]));
    const text = stripTags(cell.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n"))
      .split("\n").map((s) => s.trim()).filter(Boolean).join("\n")
      .replace(/大きな地図を見る.*$/s, "").replace(/周辺のお店.*$/s, "").trim();
    out[key] = { text: text.slice(0, 600), hrefs };
  }
  return out;
}

function stripTags(s: string) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/[ \t　]+/g, " ").trim();
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanTitle(t: string) {
  return t
    .replace(/\s*[-|｜/／]\s*(食べログ|Retty|ホットペッパー.*|Instagram.*|Facebook.*)$/i, "")
    .replace(/\s*\(@[\w.]+\).*$/, "")
    .replace(/\s*[•・]\s*Instagram.*$/i, "")
    .replace(/on Instagram.*$/i, "")
    .trim()
    .slice(0, 80);
}

function dayJa(d: string) {
  const map: Record<string, string> = {
    Monday: "月", Tuesday: "火", Wednesday: "水", Thursday: "木", Friday: "金", Saturday: "土", Sunday: "日",
    PublicHolidays: "祝",
  };
  const key = String(d).split("/").pop() ?? "";
  return map[key] ?? key;
}

export function guessArea(address: string) {
  const m = /(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)?\s*([^\s\d０-９]{1,6}?[市区町村])/.exec(address);
  return m?.[1];
}

function absUrl(u: string, base: string) {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

// ---------------------------------------------------------------------------
// リンク分類
// ---------------------------------------------------------------------------
const LINK_TYPES: { type: string; label: string; test: RegExp }[] = [
  { type: "tabelog", label: "食べログ", test: /(^|\.)tabelog\.com$/ },
  { type: "instagram", label: "Instagram", test: /(^|\.)instagram\.com$/ },
  { type: "x", label: "X", test: /(^|\.)(x|twitter)\.com$/ },
  { type: "facebook", label: "Facebook", test: /(^|\.)facebook\.com$/ },
  { type: "tiktok", label: "TikTok", test: /(^|\.)tiktok\.com$/ },
  { type: "threads", label: "Threads", test: /(^|\.)threads\.(net|com)$/ },
  { type: "line", label: "LINE", test: /(^|\.)(line\.me|lin\.ee)$/ },
  { type: "retty", label: "Retty", test: /(^|\.)retty\.me$/ },
  { type: "hotpepper", label: "ホットペッパー", test: /(^|\.)hotpepper\.jp$/ },
  { type: "gmap", label: "Googleマップ", test: /^(maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$/ },
  { type: "youtube", label: "YouTube", test: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { type: "note", label: "note", test: /(^|\.)note\.com$/ },
];

export function classifyLink(url: string): Link {
  let host = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    if (host.endsWith("google.com") && u.pathname.startsWith("/maps")) return { type: "gmap", label: "Googleマップ", url };
  } catch {
    return { type: "other", label: "リンク", url };
  }
  for (const t of LINK_TYPES) if (t.test.test(host)) return { type: t.type, label: t.label, url };
  if (/(^|\.)(google|yahoo|bing|amazon|apple)\./.test(host)) return { type: "other", label: host, url };
  return { type: "hp", label: "公式サイト", url };
}

function isShareLink(url: string) {
  return /sharer|share\?|intent\/|\/share|dialog\/|plugins\/|\/hashtag\/|\/explore\//i.test(url);
}

export function normalizeUrl(u: string) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return u;
  }
}

export function dedupeLinks(links: Link[]): Link[] {
  const seenUrl = new Set<string>();
  const seenType = new Set<string>();
  const out: Link[] = [];
  for (const l of links) {
    if (!l?.url || !/^https?:\/\//.test(l.url)) continue;
    const n = normalizeUrl(l.url);
    if (seenUrl.has(n)) continue;
    // SNS・レビューサイトは1種類につき1つだけ（最初に見つかったものを優先）
    if (l.type !== "other" && seenType.has(l.type)) continue;
    seenUrl.add(n);
    seenType.add(l.type);
    out.push(l);
  }
  return out;
}

export function dedupe<T>(arr: T[]) {
  return [...new Set(arr)];
}

function dedupeImages(urls: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    // 食べログはサイズ違いの同一画像が多いので末尾のファイル名で判定
    const k = (u.split("?")[0].split("/").pop() ?? u).replace(/^\d+x\d+_(?:rect|square)_/, "");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

