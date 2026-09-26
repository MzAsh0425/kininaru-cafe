import { API_URL } from "./config.js";

const configured = /^https?:\/\//.test(API_URL) && !API_URL.includes("/XXXX/");

const SESSION_KEY = "cafe-share-session";
const FILTER_KEY = "cafe-share-filter";
const PALETTE = ["#E0694F", "#2F8F8B", "#7A5AC8", "#D39B1F", "#3F7FD1", "#C2527F"];
const STALE_PENDING_MS = 60 * 1000;
const STALE_PROCESSING_MS = 7 * 60 * 1000;

const LINK_STYLE = {
  hp: { abbr: "HP", color: "#5B6770", label: "公式サイト" },
  tabelog: { abbr: "食", color: "#F29A00", label: "食べログ" },
  instagram: { abbr: "IG", color: "#D6249F", label: "Instagram" },
  x: { abbr: "X", color: "#111111", label: "X" },
  facebook: { abbr: "f", color: "#1877F2", label: "Facebook" },
  tiktok: { abbr: "♪", color: "#111111", label: "TikTok" },
  threads: { abbr: "@", color: "#111111", label: "Threads" },
  line: { abbr: "L", color: "#06C755", label: "LINE" },
  retty: { abbr: "R", color: "#FF6D00", label: "Retty" },
  hotpepper: { abbr: "ホ", color: "#E4002B", label: "ホットペッパー" },
  gmap: { abbr: "M", color: "#34A853", label: "Googleマップ" },
  youtube: { abbr: "▶", color: "#FF0000", label: "YouTube" },
  note: { abbr: "n", color: "#2CB696", label: "note" },
  other: { abbr: "↗", color: "#8A7F76", label: "リンク" },
};

const ICONS = {
  back: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  plus: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  clock: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  cup: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/></svg>`,
  close: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  left: `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>`,
};

const state = {
  session: loadSession(), // { key, roomId, memberId }
  members: [],
  cafes: [],
  filter: safeGet(FILTER_KEY) ?? "all",
  loaded: false,
  listScroll: 0,
  lastSnapshot: "",
};

let pollTimer = null;
const app = document.getElementById("app");

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
window.addEventListener("hashchange", () => render(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.session) refresh();
});
window.addEventListener("scroll", () => {
  document.querySelector(".topbar")?.classList.toggle("scrolled", window.scrollY > 4);
}, { passive: true });

start();

async function start() {
  if (!state.session) return render(true);
  app.innerHTML = `<div class="loading-screen"><div class="spinner"></div></div>`;
  try {
    await refresh({ silent: true });
    state.loaded = true;
    render(true);
    handleSharedUrlParam();
  } catch (e) {
    console.error(e);
    if (String(e.message).includes("room not found")) logout();
    else {
      state.loaded = true;
      render(true);
      toast("読み込みに失敗しました");
    }
  }
}

async function refresh({ silent = false } = {}) {
  if (!state.session) return;
  const { members, cafes } = await rpc("load", { p_key: state.session.key });
  state.members = members ?? [];
  state.cafes = cafes ?? [];
  schedulePoll();
  const snapshot = JSON.stringify([state.members, state.cafes]);
  if (!silent && snapshot !== state.lastSnapshot) render(false);
  state.lastSnapshot = snapshot;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state.cafes.some((c) => c.status === "pending" || c.status === "processing");
  pollTimer = setTimeout(() => {
    if (document.visibilityState === "visible") refresh().catch(console.error);
    else schedulePoll();
  }, busy ? 4000 : 30000);
}

// iOS ショートカット等から ?add=URL で開かれたら追加シートを開く
function handleSharedUrlParam() {
  const params = new URLSearchParams(location.search);
  const shared = params.get("add") || params.get("url") || params.get("text");
  if (!shared) return;
  history.replaceState(null, "", location.pathname + location.hash);
  openAddSheet(shared);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
// GAS はプリフライト(CORS)に対応しないため text/plain で送る
async function rpc(action, args = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...args }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

// 情報収集は完了まで数十秒かかるので待たずに進める。
// 通信が途切れてもサーバー側の定期処理（5分おき）が拾い直す。
function triggerProcess(id) {
  rpc("process", { p_key: state.session.key, p_id: id })
    .then(() => refresh())
    .catch((e) => console.warn("process request ended", e));
}

async function hashPassphrase(pass) {
  const norm = pass.normalize("NFKC").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kininaru-cafe:v1:" + norm));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
function route() {
  const m = location.hash.match(/^#\/c\/([0-9a-f-]+)(\/edit)?$/);
  if (m) return { name: m[2] ? "edit" : "detail", id: m[1] };
  return { name: "list" };
}

let currentRoute = null;
let detailFromList = false;

function render(navigated) {
  if (!state.session) return renderLogin();
  const r = route();
  const prev = currentRoute;
  currentRoute = r;

  if (prev?.name === "list" && r.name !== "list") state.listScroll = window.scrollY;
  if (navigated && r.name === "detail" && prev?.name !== "detail") detailFromList = prev?.name === "list";

  if (r.name === "list") {
    renderList();
    if (navigated) window.scrollTo(0, prev && prev.name !== "list" ? state.listScroll : 0);
  } else if (r.name === "detail") {
    renderDetail(r.id);
    if (navigated) window.scrollTo(0, 0);
  } else if (r.name === "edit") {
    // 編集中はポーリングで再描画しない
    if (!navigated && prev?.name === "edit" && prev.id === r.id) return;
    renderEdit(r.id);
    window.scrollTo(0, 0);
  }
}

function go(hash) {
  if (location.hash === hash) render(true);
  else location.hash = hash;
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------
function renderLogin() {
  app.innerHTML = `
    <form class="login" id="login-form" autocomplete="off">
      <div class="logo">${logoSvg()}</div>
      <h1>きになるカフェ</h1>
      <p class="lead">気になったカフェを、リンクを貼るだけで共有</p>
      ${configured ? "" : `<div class="config-warning">js/config.js に Apps Script の URL が設定されていません。README の手順に沿って設定してください。</div>`}
      <label class="field"><span>合言葉</span>
        <input type="password" name="pass" required minlength="4" placeholder="ふたりで決めた合言葉" autocomplete="current-password">
      </label>
      <label class="field"><span>あなたの名前</span>
        <input type="text" name="name" required maxlength="20" placeholder="例: ゆう" value="${h(safeGet("cafe-share-last-name") ?? "")}">
      </label>
      <button class="btn block" type="submit" ${configured ? "" : "disabled"}>部屋に入る</button>
      <p class="hint">同じ合言葉を入れた人と同じ部屋になります。<br>次回以降は同じ名前で入ると、自分の投稿として表示されます。</p>
    </form>`;
  const form = document.getElementById("login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "入室中…";
    try {
      const key = await hashPassphrase(String(fd.get("pass")));
      const name = String(fd.get("name")).trim();
      const res = await rpc("join_room", { p_key: key, p_name: name });
      state.session = { key, roomId: res.room_id, memberId: res.member.id };
      safeSet(SESSION_KEY, JSON.stringify(state.session));
      safeSet("cafe-share-last-name", name);
      start();
    } catch (err) {
      console.error(err);
      toast("入室できませんでした");
      btn.disabled = false;
      btn.textContent = "部屋に入る";
    }
  });
}

function logout() {
  state.session = null;
  state.cafes = [];
  state.members = [];
  safeRemove(SESSION_KEY);
  clearTimeout(pollTimer);
  history.replaceState(null, "", location.pathname);
  render(true);
}

// ---------------------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------------------
function renderList() {
  const me = member(state.session.memberId);
  const others = state.members.filter((m) => m.id !== state.session.memberId);

  let cafes = state.cafes;
  if (state.filter === "visited") cafes = cafes.filter((c) => c.visited);
  else if (state.filter === "todo") cafes = cafes.filter((c) => !c.visited);
  else if (state.filter !== "all") cafes = cafes.filter((c) => c.member_id === state.filter);

  const seg = (id, label, color) =>
    `<button class="seg ${state.filter === id ? "active" : ""}" data-filter="${h(id)}">${color ? `<span class="dot" style="background:${h(color)}"></span>` : ""}${h(label)}</button>`;

  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-row">
        <h1>きになるカフェ</h1>
        <button class="me-chip" id="me-chip"><span class="dot" style="background:${h(me?.color ?? "#999")}"></span>${h(me?.name ?? "")}</button>
      </div>
      <nav class="segments">
        ${seg("all", `すべて ${state.cafes.length}`)}
        ${me ? seg(me.id, "自分", me.color) : ""}
        ${others.map((o) => seg(o.id, o.name, o.color)).join("")}
        ${seg("todo", "まだ行ってない")}
        ${seg("visited", "行った")}
      </nav>
    </header>
    <main class="list">
      ${cafes.length ? cafes.map(cardHtml).join("") : emptyHtml()}
    </main>
    <button class="fab" id="fab">${ICONS.plus}カフェを追加</button>`;

  app.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      safeSet(FILTER_KEY, state.filter);
      renderList();
    })
  );
  app.querySelectorAll(".card[data-id]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      go(`#/c/${el.dataset.id}`);
    })
  );
  app.querySelectorAll("[data-action=retry]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      retry(b.dataset.id);
    })
  );
  app.querySelectorAll("[data-action=edit]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      go(`#/c/${b.dataset.id}/edit`);
    })
  );
  app.querySelectorAll("[data-action=delete]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCafe(b.dataset.id);
    })
  );
  document.getElementById("fab").addEventListener("click", () => openAddSheet());
  document.getElementById("me-chip").addEventListener("click", openProfileSheet);
}

function emptyHtml() {
  if (state.cafes.length) return `<div class="empty"><p>該当するカフェはありません</p></div>`;
  return `<div class="empty">
    <div class="big">☕️</div>
    <p><b>まだカフェがありません</b></p>
    <p>右下の「カフェを追加」から、<br>気になるお店のリンクを貼ってみましょう。<br>HP・食べログ・Instagram など何でもOKです。</p>
  </div>`;
}

function cardHtml(c) {
  const m = member(c.member_id);
  const style = `--member:${h(m?.color ?? "#999")}`;
  const who = `<div class="who"><span class="dot"></span>${h(m?.name ?? "")}</div>`;

  if (c.status === "pending" || c.status === "processing" || (c.status === "error" && !c.name)) {
    const isError = c.status === "error";
    const stale = isStale(c);
    return `
      <article class="card pending ${isError ? "error" : ""}" style="${style}" data-id="${h(c.id)}">
        ${isError ? `<div class="no-photo">${ICONS.cup}</div>` : `<div class="shimmer"></div>`}
        <div class="body">
          ${isError || stale ? "" : `<div class="spinner"></div>`}
          <div style="min-width:0;flex:1">
            ${who}
            <div class="state">${isError ? "情報を取得できませんでした" : stale ? "処理が止まっているようです" : "情報を収集中…"}</div>
            <div class="url">${h(c.source_url)}</div>
            ${isError || stale ? `<div class="actions">
              <button class="btn small ghost" data-action="retry" data-id="${h(c.id)}">再試行</button>
              <button class="btn small ghost" data-action="edit" data-id="${h(c.id)}">手動で入力</button>
              <button class="btn small danger" data-action="delete" data-id="${h(c.id)}">削除</button>
            </div>` : ""}
          </div>
        </div>
      </article>`;
  }

  const photos = (c.photos ?? []).slice(0, 3);
  const thumbs = photos.length
    ? `<div class="thumbs n${photos.length}">${photos.map((p) => `<img src="${h(p)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`).join("")}</div>`
    : `<div class="no-photo">${ICONS.cup}</div>`;
  const meta = [c.area, c.genre].filter(Boolean).join("・");
  // 曜日だけの行ではなく、時刻を含む最初の行を表示する
  const hourLines = (c.hours ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const firstHours = hourLines.find((l) => /\d{1,2}[:：]\d{2}/.test(l)) ?? hourLines[0];
  const links = (c.links ?? []).filter((l) => l.type !== "other").slice(0, 5);

  return `
    <article class="card" style="${style}" data-id="${h(c.id)}">
      ${thumbs}
      ${c.visited ? `<span class="visited-badge">✓ 行った</span>` : ""}
      <div class="body">
        ${who}
        <h2>${h(c.name || "名称未設定")}</h2>
        ${meta ? `<div class="meta">${h(meta)}</div>` : ""}
        ${c.summary ? `<p class="summary">${h(c.summary)}</p>` : ""}
        <div class="foot">
          <div class="hours-line">${firstHours ? `${ICONS.clock}<span>${h(firstHours)}${c.holidays ? `／休 ${h(c.holidays.split("\n")[0])}` : ""}</span>` : ""}</div>
          <div class="link-dots">${links.map((l) => linkDot(l.type)).join("")}</div>
        </div>
      </div>
    </article>`;
}

function isStale(c) {
  const age = Date.now() - new Date(c.updated_at).getTime();
  return (c.status === "pending" && age > STALE_PENDING_MS) || (c.status === "processing" && age > STALE_PROCESSING_MS);
}

function linkDot(type) {
  const s = LINK_STYLE[type] ?? LINK_STYLE.other;
  return `<span class="link-dot" style="background:${s.color}" aria-label="${h(s.label)}">${h(s.abbr)}</span>`;
}

// ---------------------------------------------------------------------------
// 追加シート
// ---------------------------------------------------------------------------
function openAddSheet(prefill = "") {
  const { close, el } = openSheet(`
    <h2>カフェを追加</h2>
    <p class="sub">HP・食べログ・Instagram・Googleマップなど、お店のリンクを貼ってください。関連情報は自動で集めます。</p>
    <form id="add-form">
      <label class="field"><span>リンク</span>
        <div class="row">
          <input type="url" name="url" required placeholder="https://..." inputmode="url" autocapitalize="off" autocorrect="off" value="${h(extractUrl(prefill) ?? "")}">
          <button type="button" class="btn ghost" id="paste-btn">ペースト</button>
        </div>
      </label>
      <label class="field"><span>ひとことメモ（任意）</span>
        <textarea name="memo" rows="2" placeholder="例: モーニングが気になる"></textarea>
      </label>
      <button class="btn block" type="submit">追加して情報を集める</button>
    </form>`);

  const form = el.querySelector("#add-form");
  const input = form.querySelector("input[name=url]");
  if (!prefill) setTimeout(() => input.focus(), 300);

  // 「店名 https://...」のような共有テキストを貼った場合も URL だけ取り出す
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    const url = extractUrl(text);
    if (url) {
      e.preventDefault();
      input.value = url;
    }
  });
  el.querySelector("#paste-btn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const url = extractUrl(text);
      if (url) input.value = url;
      else toast("クリップボードにURLがありません");
    } catch {
      toast("入力欄を長押ししてペーストしてください");
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = extractUrl(input.value);
    if (!url) return toast("URLを入力してください");
    const memo = String(new FormData(form).get("memo") ?? "");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const cafe = await rpc("add_cafe", { p_key: state.session.key, p_member_id: state.session.memberId, p_url: url, p_memo: memo });
      state.cafes.unshift(cafe);
      close();
      if (route().name !== "list") go("#");
      else renderList();
      window.scrollTo({ top: 0, behavior: "smooth" });
      toast("追加しました。情報を収集中です");
      triggerProcess(cafe.id);
      schedulePoll();
    } catch (err) {
      console.error(err);
      toast("追加に失敗しました");
      btn.disabled = false;
    }
  });
}

function extractUrl(text) {
  const m = String(text ?? "").match(/https?:\/\/[^\s<>"'「」）)]+/);
  return m ? m[0] : null;
}

async function retry(id) {
  try {
    const c = await rpc("reset_cafe", { p_key: state.session.key, p_id: id });
    replaceCafe(c);
    render(false);
    toast("情報を再取得しています");
    triggerProcess(id);
    schedulePoll();
  } catch (e) {
    console.error(e);
    toast("再取得に失敗しました");
  }
}

async function removeCafe(id) {
  const c = cafe(id);
  if (!confirm(`「${c?.name || "このカフェ"}」を削除しますか？`)) return;
  try {
    await rpc("delete_cafe", { p_key: state.session.key, p_id: id });
    state.cafes = state.cafes.filter((x) => x.id !== id);
    if (route().name !== "list") go("#");
    else renderList();
    toast("削除しました");
  } catch (e) {
    console.error(e);
    toast("削除に失敗しました");
  }
}

// ---------------------------------------------------------------------------
// プロフィール
// ---------------------------------------------------------------------------
function openProfileSheet() {
  const me = member(state.session.memberId);
  const { close, el } = openSheet(`
    <h2>あなたの設定</h2>
    <p class="sub">部屋のメンバー: ${state.members.map((m) => `<span style="color:${h(m.color)};font-weight:700">● ${h(m.name)}</span>`).join("　")}</p>
    <form id="profile-form">
      <label class="field"><span>名前</span><input type="text" name="name" maxlength="20" value="${h(me?.name ?? "")}"></label>
      <div class="field"><span style="display:block;font-size:13px;color:var(--text-2);margin:0 0 8px 4px;font-weight:600">色</span>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${PALETTE.map((c) => `<label style="cursor:pointer"><input type="radio" name="color" value="${c}" ${c === me?.color ? "checked" : ""} style="display:none"><span class="dot swatch" style="display:block;width:36px;height:36px;background:${c};${c === me?.color ? "box-shadow:0 0 0 3px var(--bg),0 0 0 5px " + c : ""}"></span></label>`).join("")}
        </div>
      </div>
      <button class="btn block" type="submit" style="margin-top:8px">保存</button>
      <button class="btn block danger" type="button" id="logout-btn" style="margin-top:8px">部屋から出る</button>
    </form>`);
  const form = el.querySelector("#profile-form");
  form.querySelectorAll("input[name=color]").forEach((r) =>
    r.addEventListener("change", () => {
      form.querySelectorAll(".swatch").forEach((s) => (s.style.boxShadow = ""));
      r.nextElementSibling.style.boxShadow = `0 0 0 3px var(--bg),0 0 0 5px ${r.value}`;
    })
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await rpc("update_member", {
        p_key: state.session.key,
        p_member_id: state.session.memberId,
        p_name: String(fd.get("name") ?? ""),
        p_color: String(fd.get("color") ?? ""),
      });
      safeSet("cafe-share-last-name", String(fd.get("name") ?? ""));
      close();
      await refresh();
      render(false);
    } catch (err) {
      console.error(err);
      toast("保存できませんでした（同じ名前のメンバーがいるかもしれません）");
    }
  });
  el.querySelector("#logout-btn").addEventListener("click", () => {
    if (!confirm("部屋から出ますか？（データは消えません）")) return;
    close();
    logout();
  });
}

// ---------------------------------------------------------------------------
// 詳細
// ---------------------------------------------------------------------------
function renderDetail(id) {
  const c = cafe(id);
  if (!c) {
    app.innerHTML = `${navbar("", "")}<div class="empty"><p>見つかりませんでした</p></div>`;
    bindBack();
    return;
  }
  const m = member(c.member_id);
  const busy = c.status === "pending" || c.status === "processing";
  const photos = c.photos ?? [];
  const meta = [c.area, c.genre].filter(Boolean).join("・");
  const mapQuery = [c.name, c.address].filter(Boolean).join(" ");
  const links = c.links ?? [];

  const infoRows = [
    ["住所", c.address],
    ["営業時間", c.hours],
    ["定休日", c.holidays],
    ["予算", c.price],
    ["アクセス", c.access],
    ["電話", c.phone ? `<a href="tel:${h(c.phone.replace(/[^\d+]/g, ""))}">${h(c.phone)}</a>` : "", true],
    ["ジャンル", c.genre],
  ].filter(([, v]) => v);

  app.innerHTML = `
    <div class="page" style="--member:${h(m?.color ?? "#999")}">
      ${navbar(c.name ?? "", `<button class="text-btn" id="edit-btn">編集</button>`)}
      <div class="detail">
        ${busy ? `<div class="notice info-notice"><div class="spinner" style="width:18px;height:18px;border-width:2px"></div>情報を収集中です。まとまり次第表示されます。</div>` : ""}
        ${c.status === "error" ? `<div class="notice">情報の取得に失敗しました: ${h(c.error ?? "")}</div>` : ""}
        ${c.status === "done" && c.error ? `<div class="notice info-notice">${h(c.error)}</div>` : ""}
        ${photos.length ? `<div class="gallery ${photos.length === 1 ? "single" : ""}">${photos.map((p) => `<img src="${h(p)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`).join("")}</div>` : ""}
        <div class="head">
          <span class="who"><span class="dot"></span>${h(m?.name ?? "")} が共有</span>
          <h1>${h(c.name || "名称未設定")}</h1>
          ${meta ? `<div class="meta">${h(meta)}</div>` : ""}
          ${c.summary ? `<p class="summary">${h(c.summary)}</p>` : ""}
        </div>

        <div class="section">
          <div class="toggle-row">
            <span>行った！</span>
            <label class="switch"><input type="checkbox" id="visited" ${c.visited ? "checked" : ""}><span class="track"></span></label>
          </div>
        </div>

        ${links.length ? `<div class="section"><h3>リンク</h3><div class="links">
          ${links.map((l) => `<a class="link-btn" href="${h(l.url)}" target="_blank" rel="noopener noreferrer">${linkDot(l.type)}<span class="label">${h(l.label || LINK_STYLE[l.type]?.label || "リンク")}</span></a>`).join("")}
        </div></div>` : ""}

        ${infoRows.length ? `<div class="section"><h3>基本情報</h3><div class="info">
          ${infoRows.map(([k, v, raw]) => `<div class="info-row"><div class="k">${k}</div><div class="v">${raw ? v : h(v)}</div></div>`).join("")}
        </div></div>` : ""}

        ${mapQuery ? `<div class="section"><h3>地図</h3>
          <div class="map"><iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${encodeURIComponent(c.address || mapQuery)}&z=16&hl=ja&output=embed" title="地図"></iframe></div>
          <div class="map-actions">
            <a class="btn ghost small" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}" target="_blank" rel="noopener">Googleマップで開く</a>
            <a class="btn ghost small" href="https://maps.apple.com/?q=${encodeURIComponent(c.name || mapQuery)}${c.address ? `&address=${encodeURIComponent(c.address)}` : ""}" target="_blank" rel="noopener">Appleマップで開く</a>
          </div>
        </div>` : ""}

        <div class="section"><h3>メモ</h3>
          <div class="memo-box ${c.memo ? "" : "empty-memo"}">${c.memo ? h(c.memo) : "メモはまだありません"}</div>
        </div>

        <div class="section"><h3>共有元</h3>
          <div class="source"><a href="${h(c.source_url)}" target="_blank" rel="noopener noreferrer">${h(c.source_url)}</a><br>${h(formatDate(c.created_at))} 追加</div>
        </div>

        <div class="bottom-actions">
          <button class="btn ghost block" id="refetch-btn" ${busy ? "disabled" : ""}>情報を再取得（空欄を補完）</button>
          <button class="btn danger block" id="delete-btn">このカフェを削除</button>
        </div>
      </div>
    </div>`;

  bindBack();
  document.getElementById("edit-btn").addEventListener("click", () => go(`#/c/${id}/edit`));
  document.getElementById("refetch-btn").addEventListener("click", () => retry(id));
  document.getElementById("delete-btn").addEventListener("click", () => removeCafe(id));
  document.getElementById("visited").addEventListener("change", async (e) => {
    try {
      const updated = await rpc("update_cafe", { p_key: state.session.key, p_id: id, p_patch: { visited: e.target.checked } });
      replaceCafe(updated);
      if (e.target.checked) toast("行ったリストに入れました");
    } catch {
      e.target.checked = !e.target.checked;
      toast("更新に失敗しました");
    }
  });
}

function navbar(title, right) {
  return `<nav class="navbar">
    <button class="icon-btn back" id="back-btn">${ICONS.back}一覧</button>
    <div class="title">${h(title)}</div>
    <div style="min-width:60px;text-align:right">${right}</div>
  </nav>`;
}

function bindBack() {
  document.getElementById("back-btn")?.addEventListener("click", () => {
    // 一覧から来た場合は履歴を戻る（スワイプバックと挙動を揃える）
    if (detailFromList) history.back();
    else go("#");
  });
}

// ---------------------------------------------------------------------------
// 編集
// ---------------------------------------------------------------------------
function renderEdit(id) {
  const c = cafe(id);
  if (!c) return go("#");
  const draft = {
    links: structuredClone(c.links ?? []),
    photos: [...(c.photos ?? [])],
  };

  const field = (name, label, value, opts = {}) => opts.multiline
    ? `<label class="field"><span>${label}</span><textarea name="${name}" rows="${opts.rows ?? 3}">${h(value ?? "")}</textarea></label>`
    : `<label class="field"><span>${label}</span><input type="${opts.type ?? "text"}" name="${name}" value="${h(value ?? "")}" placeholder="${h(opts.placeholder ?? "")}"></label>`;

  app.innerHTML = `
    <div class="page">
      <nav class="navbar">
        <button class="text-btn" id="cancel-btn" style="font-weight:400">キャンセル</button>
        <div class="title">編集</div>
        <button class="text-btn" id="save-btn">保存</button>
      </nav>
      <form class="edit" id="edit-form">
        <h3>写真</h3>
        <div class="edit-photos" id="photos"></div>
        <input type="file" id="photo-file" accept="image/*" multiple hidden>

        <h3>基本情報</h3>
        ${field("name", "店名", c.name)}
        ${field("area", "エリア", c.area, { placeholder: "例: 代官山" })}
        ${field("genre", "ジャンル", c.genre, { placeholder: "例: カフェ・ベーカリー" })}
        ${field("summary", "どんなお店？", c.summary, { multiline: true })}
        ${field("address", "住所", c.address)}
        ${field("hours", "営業時間", c.hours, { multiline: true })}
        ${field("holidays", "定休日", c.holidays)}
        ${field("price", "予算", c.price)}
        ${field("access", "アクセス", c.access, { multiline: true, rows: 2 })}
        ${field("phone", "電話番号", c.phone, { type: "tel" })}

        <h3>リンク</h3>
        <div id="links"></div>
        <button type="button" class="btn ghost small" id="add-link">＋ リンクを追加</button>

        <h3>メモ</h3>
        ${field("memo", "メモ", c.memo, { multiline: true })}
      </form>
    </div>`;

  const photosEl = document.getElementById("photos");
  const linksEl = document.getElementById("links");
  const fileInput = document.getElementById("photo-file");

  const renderPhotos = () => {
    photosEl.innerHTML = draft.photos.map((p, i) => `
      <div class="edit-photo">
        <img src="${h(p)}" alt="" referrerpolicy="no-referrer">
        <button type="button" class="remove" data-remove="${i}" aria-label="削除">${ICONS.close}</button>
        ${i > 0 ? `<div class="order"><button type="button" data-first="${i}" aria-label="先頭へ">${ICONS.left}</button></div>` : ""}
      </div>`).join("") + `
      <button type="button" class="add-photo" id="upload-photo">＋<br>写真を追加</button>
      <button type="button" class="add-photo" id="url-photo">＋<br>URLで追加</button>`;
    photosEl.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
      draft.photos.splice(Number(b.dataset.remove), 1);
      renderPhotos();
    }));
    photosEl.querySelectorAll("[data-first]").forEach((b) => b.addEventListener("click", () => {
      const [p] = draft.photos.splice(Number(b.dataset.first), 1);
      draft.photos.unshift(p);
      renderPhotos();
    }));
    document.getElementById("upload-photo").addEventListener("click", () => fileInput.click());
    document.getElementById("url-photo").addEventListener("click", () => {
      const u = extractUrl(prompt("画像のURLを入力してください") ?? "");
      if (u) {
        draft.photos.push(u);
        renderPhotos();
      }
    });
  };

  const renderLinks = () => {
    linksEl.innerHTML = draft.links.map((l, i) => `
      <div class="link-edit">
        <input class="label-input" data-i="${i}" data-k="label" value="${h(l.label ?? "")}" placeholder="表示名（例: Instagram）">
        <input class="url-input" data-i="${i}" data-k="url" type="url" value="${h(l.url ?? "")}" placeholder="https://..." autocapitalize="off">
        <button type="button" class="icon-btn remove" data-remove-link="${i}" aria-label="削除">${ICONS.close}</button>
      </div>`).join("");
    linksEl.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
      const l = draft.links[Number(inp.dataset.i)];
      l[inp.dataset.k] = inp.value;
      if (inp.dataset.k === "url") {
        const t = classifyLink(inp.value);
        l.type = t;
        const known = Object.values(LINK_STYLE).map((s) => s.label);
        if (!l.label || known.includes(l.label)) {
          l.label = LINK_STYLE[t].label;
          linksEl.querySelector(`input[data-i="${inp.dataset.i}"][data-k=label]`).value = l.label;
        }
      }
    }));
    linksEl.querySelectorAll("[data-remove-link]").forEach((b) => b.addEventListener("click", () => {
      draft.links.splice(Number(b.dataset.removeLink), 1);
      renderLinks();
    }));
  };

  renderPhotos();
  renderLinks();

  document.getElementById("add-link").addEventListener("click", () => {
    draft.links.push({ type: "other", label: "", url: "" });
    renderLinks();
    linksEl.querySelector(".link-edit:last-child .url-input")?.focus();
  });

  fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    if (!files.length) return;
    toast("写真をアップロード中…");
    for (const f of files) {
      try {
        const url = await uploadPhoto(c, f);
        draft.photos.push(url);
        renderPhotos();
      } catch (e) {
        console.error(e);
        toast("アップロードに失敗しました");
      }
    }
    toast("写真を追加しました");
  });

  document.getElementById("cancel-btn").addEventListener("click", () => go(`#/c/${id}`));
  document.getElementById("save-btn").addEventListener("click", async () => {
    const fd = new FormData(document.getElementById("edit-form"));
    const patch = {};
    for (const k of ["name", "area", "genre", "summary", "address", "hours", "holidays", "price", "access", "phone", "memo"]) {
      patch[k] = String(fd.get(k) ?? "").trim() || null;
    }
    patch.links = draft.links
      .map((l) => ({ ...l, url: (l.url ?? "").trim(), label: (l.label ?? "").trim() }))
      .filter((l) => /^https?:\/\//.test(l.url))
      .map((l) => ({ type: l.type ?? classifyLink(l.url), label: l.label || LINK_STYLE[l.type ?? "other"]?.label || "リンク", url: l.url }));
    patch.photos = draft.photos;
    // 住所を変えたら古い座標は捨てる
    if ((patch.address ?? null) !== (c.address ?? null)) {
      patch.lat = null;
      patch.lng = null;
    }
    const btn = document.getElementById("save-btn");
    btn.disabled = true;
    try {
      const updated = await rpc("update_cafe", { p_key: state.session.key, p_id: id, p_patch: patch });
      replaceCafe(updated);
      toast("保存しました");
      go(`#/c/${id}`);
    } catch (e) {
      console.error(e);
      toast("保存に失敗しました");
      btn.disabled = false;
    }
  });
}

async function uploadPhoto(c, file) {
  const dataUrl = await resizeImage(file, 1600, 0.85);
  return rpc("upload_photo", { p_key: state.session.key, p_id: c.id, p_data: dataUrl });
}

// 端末で縮小して JPEG の data URL にする（iPhone の HEIC もここで JPEG になる）
async function resizeImage(file, maxSize, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function classifyLink(url) {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return "other";
  }
  const rules = [
    ["tabelog", /(^|\.)tabelog\.com$/],
    ["instagram", /(^|\.)instagram\.com$/],
    ["x", /(^|\.)(x|twitter)\.com$/],
    ["facebook", /(^|\.)facebook\.com$/],
    ["tiktok", /(^|\.)tiktok\.com$/],
    ["threads", /(^|\.)threads\.(net|com)$/],
    ["line", /(^|\.)(line\.me|lin\.ee)$/],
    ["retty", /(^|\.)retty\.me$/],
    ["hotpepper", /(^|\.)hotpepper\.jp$/],
    ["gmap", /^(maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$/],
    ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
    ["note", /(^|\.)note\.com$/],
  ];
  if (host.endsWith("google.com") && path.startsWith("/maps")) return "gmap";
  for (const [t, re] of rules) if (re.test(host)) return t;
  return "hp";
}

// ---------------------------------------------------------------------------
// シート・トースト
// ---------------------------------------------------------------------------
function openSheet(inner) {
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  const el = document.createElement("div");
  el.className = "sheet";
  el.setAttribute("role", "dialog");
  el.innerHTML = `<div class="grabber"></div>${inner}`;
  document.body.append(backdrop, el);
  document.body.style.overflow = "hidden";
  const close = () => {
    backdrop.remove();
    el.remove();
    document.body.style.overflow = "";
  };
  backdrop.addEventListener("click", close);

  // つまみを下にスワイプで閉じる
  let startY = null;
  el.addEventListener("touchstart", (e) => {
    if (el.scrollTop <= 0 && e.target.closest(".grabber, h2, .sub")) startY = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    el.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 100) close();
    else el.style.transform = "";
  });
  return { close, el };
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
function member(id) {
  return state.members.find((m) => m.id === id);
}

function cafe(id) {
  return state.cafes.find((c) => c.id === id);
}

function replaceCafe(c) {
  if (!c) return;
  const i = state.cafes.findIndex((x) => x.id === c.id);
  if (i >= 0) state.cafes[i] = c;
  else state.cafes.unshift(c);
}

function h(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function loadSession() {
  try {
    const s = JSON.parse(safeGet(SESSION_KEY) ?? "null");
    return s?.key && s?.memberId ? s : null;
  } catch {
    return null;
  }
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* プライベートモード等 */ }
}
function safeRemove(k) {
  try { localStorage.removeItem(k); } catch { /* noop */ }
}

function logoSvg() {
  return `<svg viewBox="0 0 72 72" width="72" height="72"><rect width="72" height="72" rx="18" fill="#7B4B2A"/><path d="M18 30h28v10a12 12 0 0 1-12 12h-4a12 12 0 0 1-12-12V30z" fill="#F6F1EA"/><path d="M46 33h3a5 5 0 0 1 0 10h-3" fill="none" stroke="#F6F1EA" stroke-width="3.5"/><path d="M27 17c0 3 2.5 3 2.5 6M35 17c0 3 2.5 3 2.5 6" fill="none" stroke="#E9B98E" stroke-width="3" stroke-linecap="round"/></svg>`;
}
