import {
  buildCalibrationTransform,
  DEFAULT_CALIBRATION,
} from "./calibration.js";

let heatLayer = null;
let records = [];
let cellLatLng = null;
let minTs = 0;
let maxTs = 0;

function fmt(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateHeatmap(fromTs, toTs, map, L, maxZoom, cal) {
  if (heatLayer) map.removeLayer(heatLayer);

  const weights = new Map();
  let maxW = 0;

  for (const r of records) {
    if (r.ts < fromTs || r.ts > toTs) continue;
    const k = Math.round(r.x * 2) / 2 + "," + Math.round(r.z * 2) / 2;
    const w = (weights.get(k) || 0) + 1;
    weights.set(k, w);
    if (w > maxW) maxW = w;
  }

  if (maxW === 0) return;

  const pts = [];
  for (const [k, w] of weights) {
    const ll = cellLatLng.get(k);
    if (!ll) continue;
    pts.push([ll.lat, ll.lng, w / maxW]);
  }

  heatLayer = L.heatLayer(pts, {
    radius: 25,
    blur: 15,
    maxZoom: 18,
    max: 1,
    gradient: { 0.4: "blue", 0.6: "lime", 0.8: "yellow", 1: "red" },
  }).addTo(map);
}

async function load() {
  const loading = document.getElementById("loading");
  const progress = document.getElementById("progress");
  const bar = document.getElementById("progress__bar");
  const timeline = document.getElementById("timeline");
  const label = document.getElementById("timeline__label");

  const meta = await fetch("/tiles-meta").then((r) => r.json());
  const L = window.L;

  const minZoom = meta.minZoom ?? 0;
  const maxZoom = meta.maxZoom ?? 22;
  const midZoom = meta.centerZoom ?? Math.floor((minZoom + maxZoom) / 2);
  const minX = meta.minX ?? 0;
  const maxX = meta.maxX ?? 1 << midZoom;
  const minY = meta.minY ?? 0;
  const maxY = meta.maxY ?? 1 << midZoom;

  function tileToLatLng(x, y, z) {
    const n = 1 << z;
    return [
      (180 / Math.PI) *
        Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (y + 0.5)) / n)),
      ((x + 0.5) / n) * 360 - 180,
    ];
  }

  const center = tileToLatLng((minX + maxX) / 2, (minY + maxY) / 2, midZoom);

  const map = L.map("map", {
    minZoom,
    maxZoom,
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer("/static/maptiles/{z}/{y}/{x}.jpg", {
    minZoom,
    maxZoom,
    tileSize: 256,
    noWrap: true,
    bounds: [
      tileToLatLng(maxX, maxY, midZoom),
      tileToLatLng(minX, minY, midZoom),
    ],
  }).addTo(map);

  map.setView(center, midZoom);

  const cal = buildCalibrationTransform(DEFAULT_CALIBRATION);
  if (!cal) {
    loading.textContent = "Calibration error";
    return;
  }

  const res = await fetch("/api/heatmap/records");
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 1) {
    loading.textContent = "No heatmap data yet";
    return;
  }

  const m = JSON.parse(lines[0]);
  if (m.total === 0) {
    loading.textContent = "No heatmap data yet";
    return;
  }

  loading.classList.add("hidden");

  minTs = m.minTs;
  maxTs = m.maxTs;

  records = [];
  for (let i = 1; i < lines.length; i++) {
    records.push(JSON.parse(lines[i]));
    if (i % 1000 === 0) {
      bar.style.width = Math.round((i / lines.length) * 100) + "%";
    }
  }

  cellLatLng = new Map();
  for (const r of records) {
    const k = Math.round(r.x * 2) / 2 + "," + Math.round(r.z * 2) / 2;
    if (cellLatLng.has(k)) continue;
    const px = cal.worldToPixel(Number(r.x), Number(r.z));
    if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) {
      cellLatLng.set(k, null);
      continue;
    }
    const ll = map.unproject(L.point(px.x, px.y), maxZoom);
    cellLatLng.set(k, { lat: ll.lat, lng: ll.lng });
  }

  bar.style.width = "100%";
  setTimeout(() => progress.classList.add("hidden"), 400);

  timeline.classList.remove("hidden");
  label.textContent = "All time";

  const fromSlider = document.getElementById("slider-from");
  const toSlider = document.getElementById("slider-to");
  const fill = document.getElementById("timeline__fill");

  function update() {
    const fromPct = Number(fromSlider.value) / 100;
    const toPct = Number(toSlider.value) / 100;
    const fromTs = minTs + (maxTs - minTs) * fromPct;
    const toTs = minTs + (maxTs - minTs) * toPct;

    const left = Math.min(fromPct, toPct) * 100;
    const right = Math.max(fromPct, toPct) * 100;
    fill.style.marginLeft = left + "%";
    fill.style.width = right - left + "%";

    if (fromPct <= 0 && toPct >= 1) {
      label.textContent = "All time";
    } else if (fromPct === toPct) {
      label.textContent = fmt(toTs);
    } else {
      label.textContent = fmt(fromTs) + " \u2014 " + fmt(toTs);
    }

    updateHeatmap(fromTs, toTs, map, L, maxZoom, cal);
  }

  fromSlider.addEventListener("input", () => {
    if (Number(fromSlider.value) > Number(toSlider.value)) {
      fromSlider.value = toSlider.value;
    }
    update();
  });

  toSlider.addEventListener("input", () => {
    if (Number(toSlider.value) < Number(fromSlider.value)) {
      toSlider.value = fromSlider.value;
    }
    update();
  });

  update();
}

load().catch((err) => {
  const el = document.getElementById("loading");
  if (el) el.textContent = "Failed to load: " + err.message;
});
