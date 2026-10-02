// 地図表示（Leaflet + 国土地理院の淡色地図。APIキー不要）
// ピンは「写真を頭にした、投稿者の色のピン」を divIcon で描く。

const LEAFLET_BASE = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4";
const TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const DEFAULT_VIEW = { center: [35.681, 139.767], zoom: 12 }; // 東京駅

// ピンの大きさ（CSS の .pin と合わせる）
const HEAD = 38;
const TAIL = 11;
const PIN_HEIGHT = HEAD + TAIL - 2;

const CUP_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/></svg>`;

let leafletPromise = null;

// Leaflet は地図を開いたときだけ読み込む
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${LEAFLET_BASE}/leaflet.min.css`;
    document.head.append(css);
    const script = document.createElement("script");
    script.src = `${LEAFLET_BASE}/leaflet.min.js`;
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leafletPromise = null;
      reject(new Error("地図の読み込みに失敗しました"));
    };
    document.head.append(script);
  });
  return leafletPromise;
}

/**
 * @param {HTMLElement} el
 * @param {{ onSelect: (id: string) => void, onBackgroundTap: () => void, initialView?: {center: [number, number], zoom: number} }} opts
 */
export async function createCafeMap(el, { onSelect, onBackgroundTap, initialView }) {
  const L = await loadLeaflet();
  const map = L.map(el, { zoomControl: false, attributionControl: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, { maxZoom: 18, attribution: TILE_ATTRIBUTION }).addTo(map);
  const view = initialView ?? DEFAULT_VIEW;
  map.setView(view.center, view.zoom);
  map.on("click", () => onBackgroundTap());

  const layer = L.layerGroup().addTo(map);
  const markers = new Map(); // id -> { marker, item }
  let selectedId = null;
  let fitted = !!initialView;
  let meMarker = null;

  function icon(item) {
    const selected = item.id === selectedId;
    const head = item.photo
      ? `<img src="${esc(item.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : CUP_SVG;
    return L.divIcon({
      className: "pin-icon",
      html: `<div class="pin${selected ? " selected" : ""}${item.visited ? " visited" : ""}" style="--c:${esc(item.color)}">
        <div class="pin-head">${head}</div><div class="pin-tail"></div>
        ${item.visited ? `<span class="pin-check">✓</span>` : ""}
      </div>`,
      iconSize: [HEAD, PIN_HEIGHT],
      iconAnchor: [HEAD / 2, PIN_HEIGHT],
    });
  }

  function refreshIcon(id) {
    const m = markers.get(id);
    if (!m) return;
    m.marker.setIcon(icon(m.item));
    m.marker.setZIndexOffset(id === selectedId ? 1000 : 0);
  }

  function fit() {
    const points = [...markers.values()].map(({ item }) => [item.lat, item.lng]);
    if (points.length === 1) map.setView(points[0], 16);
    else if (points.length > 1) map.fitBounds(points, { padding: [48, 48], maxZoom: 16 });
  }

  return {
    /** @param {{id, lat, lng, color, photo, visited}[]} items */
    update(items) {
      const ids = new Set(items.map((i) => i.id));
      for (const [id, { marker }] of markers) {
        if (!ids.has(id)) {
          layer.removeLayer(marker);
          markers.delete(id);
        }
      }
      for (const item of items) {
        const existing = markers.get(item.id);
        if (existing) {
          const changed = JSON.stringify(existing.item) !== JSON.stringify(item);
          existing.item = item;
          existing.marker.setLatLng([item.lat, item.lng]);
          if (changed) refreshIcon(item.id);
          continue;
        }
        const marker = L.marker([item.lat, item.lng], { icon: icon(item), keyboard: false, riseOnHover: true });
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          onSelect(item.id);
        });
        marker.addTo(layer);
        markers.set(item.id, { marker, item });
      }
      if (selectedId && !markers.has(selectedId)) selectedId = null;
      if (!fitted && markers.size) {
        fit();
        fitted = true;
      }
    },

    /** ピンを選択状態にして、下のプレビューカードに隠れない位置へ寄せる */
    select(id, { bottomInset = 0 } = {}) {
      const prev = selectedId;
      selectedId = id;
      if (prev) refreshIcon(prev);
      if (!id) return;
      refreshIcon(id);
      const m = markers.get(id);
      if (!m) return;
      // 引いた表示のときは近くのピンと重ならないようズームする
      const zoom = Math.max(map.getZoom(), 14);
      const point = map.project(m.marker.getLatLng(), zoom).add([0, bottomInset / 2]);
      map.setView(map.unproject(point, zoom), zoom, { animate: true });
    },

    fit,

    showMe(lat, lng) {
      if (meMarker) meMarker.setLatLng([lat, lng]);
      else meMarker = L.circleMarker([lat, lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#2F80ED", fillOpacity: 1 }).addTo(map);
      map.setView([lat, lng], Math.max(map.getZoom(), 15));
    },

    getView() {
      const c = map.getCenter();
      return { center: [c.lat, c.lng], zoom: map.getZoom() };
    },

    invalidateSize() {
      map.invalidateSize();
    },

    destroy() {
      map.remove();
    },
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
