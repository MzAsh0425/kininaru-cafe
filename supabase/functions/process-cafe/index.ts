// カフェ情報の収集処理
// POST { key, id } を受け取ったら即 202 を返し、バックグラウンドで
//   1. 貼られたURLを取得して JSON-LD / OGP / 店舗情報表 / SNSリンクを抽出
//   2. ANTHROPIC_API_KEY があれば Claude の Web検索で公式HP・食べログ・SNS・基本情報を補完
//   3. 見つかった関連ページ（食べログ・HP）も取得して写真と情報を追加
//   4. 写真を Storage に保存し、cafes テーブルを更新
// を行う。

import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.128";
import {
  classifyLink, dedupe, dedupeLinks, guessArea, normalizeUrl, scrapePage, UA,
  type Info, type Link, type PageData,
} from "./scrape.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PHOTOS = 6;
const STALE_PROCESSING_MS = 4 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP エントリポイント
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { key?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.key || !body.id) return json({ error: "key and id are required" }, 400);

  const { data: room } = await db.from("rooms").select("id").eq("key_hash", body.key).maybeSingle();
  if (!room) return json({ error: "room not found" }, 404);

  const { data: cafe } = await db
    .from("cafes")
    .select("*")
    .eq("id", body.id)
    .eq("room_id", room.id)
    .maybeSingle();
  if (!cafe) return json({ error: "cafe not found" }, 404);

  const busy =
    cafe.status === "processing" &&
    Date.now() - new Date(cafe.updated_at).getTime() < STALE_PROCESSING_MS;
  if (busy) return json({ status: "processing" }, 202);

  await db
    .from("cafes")
    .update({ status: "processing", error: null, updated_at: new Date().toISOString() })
    .eq("id", cafe.id);

  // @ts-ignore EdgeRuntime は Supabase Edge Runtime のグローバル
  EdgeRuntime.waitUntil(processCafe(cafe));
  return json({ status: "processing" }, 202);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------
async function processCafe(cafe: Record<string, any>) {
  try {
    const sourceUrl: string = cafe.source_url;
    const source = await scrapePage(sourceUrl);
    const pages: PageData[] = source ? [source] : [];

    // Claude による補完（キーがあるときのみ）
    let ai: AiResult | null = null;
    if (ANTHROPIC_API_KEY) {
      try {
        ai = await researchWithClaude(sourceUrl, source);
      } catch (e) {
        console.error("claude failed", e);
      }
    }
    // AIが見つけた公式アカウント等を優先（共有元URL自体は source_url として別途表示する）
    let links = dedupeLinks([...(ai?.links ?? []), classifyLink(sourceUrl), ...(source?.links ?? [])]);

    // 関連ページ（食べログ・公式HP）もスクレイピングして写真と情報を集める
    const scraped = new Set(pages.map((p) => normalizeUrl(p.url)));
    const extraTargets = links
      .filter((l) => ["tabelog", "hp", "retty", "hotpepper"].includes(l.type))
      .filter((l) => !scraped.has(normalizeUrl(l.url)))
      .slice(0, 3);
    const extra = await Promise.all(extraTargets.map((l) => scrapePage(l.url)));
    for (const p of extra) {
      if (!p) continue;
      pages.push(p);
      links.push(...p.links.filter((l) => l.type !== "hp"));
    }
    links = dedupeLinks(links);

    // 情報のマージ: Claude > 食べログ > その他ページ の順に優先
    const ordered = [...pages].sort((a, b) => pageRank(a.url) - pageRank(b.url));
    const info: Info = {};
    for (const src of [ai?.info ?? {}, ...ordered.map((p) => p.info)]) {
      for (const [k, v] of Object.entries(src)) {
        if (v === undefined || v === null || v === "") continue;
        if ((info as any)[k] === undefined) (info as any)[k] = v;
      }
    }
    if (!info.area && info.address) info.area = guessArea(info.address);

    // 写真: 食べログ → HP → 元ページ の順に集めて保存
    const imageCandidates = dedupe([
      ...ordered.flatMap((p) => p.images),
      ...(ai?.imageUrls ?? []),
    ]).slice(0, MAX_PHOTOS * 2);
    const photos = await storePhotos(cafe.room_id, cafe.id, imageCandidates);

    const hasAnything = info.name || photos.length || links.length > 1;
    if (!hasAnything) throw new Error("ページから情報を取得できませんでした");

    // ユーザーが処理中に手で編集した項目は上書きしない
    const { data: current } = await db.from("cafes").select("*").eq("id", cafe.id).maybeSingle();
    if (!current) return; // 処理中に削除された
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(info)) {
      if (current[k] === null || current[k] === "") patch[k] = v;
    }
    const existingLinks: Link[] = Array.isArray(current.links) ? current.links : [];
    patch.links = dedupeLinks([...existingLinks, ...links]);
    const existingPhotos: string[] = Array.isArray(current.photos) ? current.photos : [];
    patch.photos = dedupe([...existingPhotos, ...photos]).slice(0, 12);
    patch.status = "done";
    patch.error = ai || !ANTHROPIC_API_KEY ? null : "AIによる補完に失敗したため、ページ解析結果のみです";
    patch.processed_at = new Date().toISOString();
    patch.updated_at = new Date().toISOString();

    await db.from("cafes").update(patch).eq("id", cafe.id);
  } catch (e) {
    console.error("process failed", e);
    await db
      .from("cafes")
      .update({
        status: "error",
        error: String((e as Error)?.message ?? e).slice(0, 300),
        updated_at: new Date().toISOString(),
      })
      .eq("id", cafe.id);
  }
}

function pageRank(url: string) {
  const t = classifyLink(url).type;
  return t === "tabelog" ? 0 : t === "hp" ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Claude による調査
// ---------------------------------------------------------------------------
type AiResult = { info: Info; links: Link[]; imageUrls: string[] };

const SAVE_TOOL = {
  name: "save_cafe_info",
  description: "調査したカフェの情報を保存する。調査が終わったら必ず1回だけ呼び出す。",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "name", "summary", "genre", "area", "address", "hours", "holidays", "price", "phone", "access",
      "official_url", "tabelog_url", "instagram_url", "x_url", "google_maps_url", "other_urls", "image_urls",
    ],
    properties: {
      name: { type: "string", description: "店名。不明なら空文字" },
      summary: { type: "string", description: "どんな店かを伝える日本語の紹介文（60〜120字）。雰囲気・名物メニューなど" },
      genre: { type: "string", description: "例: カフェ、喫茶店、ベーカリー、スイーツ" },
      area: { type: "string", description: "エリア名。例: 渋谷、代官山、京都・祇園" },
      address: { type: "string", description: "住所（郵便番号付きが望ましい）" },
      hours: { type: "string", description: "営業時間。曜日別に改行で区切る" },
      holidays: { type: "string", description: "定休日" },
      price: { type: "string", description: "予算の目安。例: ¥1,000〜¥1,999" },
      phone: { type: "string" },
      access: { type: "string", description: "最寄り駅からのアクセス" },
      official_url: { type: "string", description: "公式サイトのURL（なければ空文字）" },
      tabelog_url: { type: "string", description: "食べログの店舗ページURL（なければ空文字）" },
      instagram_url: { type: "string", description: "店舗公式InstagramアカウントのURL（なければ空文字）" },
      x_url: { type: "string", description: "店舗公式X(Twitter)アカウントのURL（なければ空文字）" },
      google_maps_url: { type: "string", description: "GoogleマップのURL（なければ空文字）" },
      other_urls: {
        type: "array",
        description: "その他の関連リンク（Retty、ホットペッパー、Facebook、TikTok、オンラインショップなど）",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "url"],
          properties: { label: { type: "string" }, url: { type: "string" } },
        },
      },
      image_urls: {
        type: "array",
        description: "取得したページ内で見つけた、店内・外観・料理の写真の直接URL（jpg/png/webp）。確実なものだけ。なければ空配列",
        items: { type: "string" },
      },
    },
  },
} as const;

async function researchWithClaude(sourceUrl: string, source: PageData | null): Promise<AiResult | null> {
  // Edge Function の実行時間上限（無料枠 150 秒）に収まるよう、調査全体の締め切りを設ける
  const deadline = Date.now() + 95_000;
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 0 });

  const hints = source
    ? `\n\n参考: 共有URLを事前に解析した結果（不正確な場合あり）\n${JSON.stringify({ info: source.info, links: source.links }, null, 1).slice(0, 3000)}`
    : "\n\n（共有URLは直接取得できませんでした。SNSなどの可能性があります）";

  const messages: any[] = [{
    role: "user",
    content:
      `次のURLは友人が「気になるカフェ」として共有したものです。\n${sourceUrl}\n\n` +
      `このURLが指す店舗を特定し、Web検索とページ取得で、公式サイト・食べログ・Instagram・X・Googleマップなどの関連リンクと、` +
      `住所・営業時間・定休日・予算・アクセスなどの基本情報を調べてください。` +
      `情報は日本語でまとめ、確認できなかった項目は空文字にしてください（推測で埋めないこと）。` +
      `URLは実在を確認できたものだけを入れてください。` +
      `調べ終わったら save_cafe_info ツールを1回呼び出して結果を保存してください。${hints}`,
  }];

  const tools: any[] = [
    { type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" } },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
    SAVE_TOOL,
  ];

  for (let i = 0; i < 4; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 10_000) break;
    const res: any = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      tools,
      messages,
      // ポリシー判定で断られた場合はサーバー側で別モデルに切り替えて継続する
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as any, { timeout: remaining });

    const toolUse = res.content.find((b: any) => b.type === "tool_use" && b.name === SAVE_TOOL.name);
    if (toolUse) return toAiResult(toolUse.input);

    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (res.stop_reason === "refusal") return null;
    // ツールを呼ばずに終わった場合は保存を促す
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: "調査結果を save_cafe_info ツールで保存してください。" });
  }
  return null;
}

function toAiResult(input: any): AiResult {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const info: Info = {
    name: s(input.name), summary: s(input.summary), genre: s(input.genre), area: s(input.area),
    address: s(input.address), hours: s(input.hours), holidays: s(input.holidays), price: s(input.price),
    phone: s(input.phone), access: s(input.access),
  };
  for (const k of Object.keys(info) as (keyof Info)[]) if (!info[k]) delete info[k];

  const links: Link[] = [];
  const push = (url: string) => {
    if (/^https?:\/\//.test(url)) links.push(classifyLink(url));
  };
  push(s(input.official_url));
  push(s(input.tabelog_url));
  push(s(input.instagram_url));
  push(s(input.x_url));
  push(s(input.google_maps_url));
  for (const o of input.other_urls ?? []) {
    const url = s(o?.url);
    if (!/^https?:\/\//.test(url)) continue;
    const l = classifyLink(url);
    links.push(l.type === "hp" || l.type === "other" ? { type: "other", label: s(o.label) || l.label, url } : l);
  }
  const imageUrls = (input.image_urls ?? []).map(s).filter((u: string) => /^https?:\/\//.test(u));
  return { info, links, imageUrls };
}

// ---------------------------------------------------------------------------
// 写真の保存
// ---------------------------------------------------------------------------
async function storePhotos(roomId: string, cafeId: string, urls: string[]): Promise<string[]> {
  const results = await Promise.all(urls.map(async (url, i) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Referer: new URL(url).origin + "/" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 8_000 || buf.byteLength > 5_000_000) return null; // アイコン等の小さすぎる画像は除外
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      const path = `${roomId}/${cafeId}/${Date.now()}-${i}.${ext}`;
      const { error } = await db.storage.from("photos").upload(path, buf, { contentType: type, upsert: true });
      if (error) return null;
      return db.storage.from("photos").getPublicUrl(path).data.publicUrl;
    } catch {
      return null;
    }
  }));
  return results.filter((u): u is string => !!u).slice(0, MAX_PHOTOS);
}
