import {
  buildCalibrationTransform,
  DEFAULT_CALIBRATION,
} from "./calibration.js";
import { createMapSurface } from "./map.js";

const BATCH_SIZE = 10000;
const HEAT_RADIUS = 20;
const HEAT_BLUR = 18;
const HEAT_MAX = 1000.0;
const HEAT_GRADIENT = {
  0.0: "rgba(0,0,0,0)",
  0.2: "#00ff00",
  0.4: "#55ff00",
  0.6: "#ffff00",
  0.8: "#ffaa00",
  0.9: "#ff6600",
  1.0: "#ff0000",
};

let L = null;
let map = null;
let heatLayer = null;
let calibration = null;
let allPoints = [];
let totalPoints = 0;
let isLoading = false;

function updateStats(loaded, total) {
  document.getElementById("pointsLoaded").textContent = loaded.toLocaleString();
  document.getElementById("pointsTotal").textContent = total.toLocaleString();
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  document.getElementById("progressFill").style.width = `${pct}%`;
  if (loaded >= total && total > 0) {
    document.getElementById("loadStatus").textContent = "Complete";
  }
}

function worldToLatLng(worldX, worldZ) {
  if (!calibration || !map || !L) return null;
  const point = calibration.worldToPixel(Number(worldX), Number(worldZ));
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const ll = map.unproject(L.point(point.x, point.y), map.getMaxZoom());
  return [ll.lat, ll.lng];
}

function addPointsToHeatmap(points) {
  if (!heatLayer) return;
  const latlngs = [];
  for (const p of points) {
    const ll = worldToLatLng(p.x, p.z);
    if (ll) latlngs.push(ll);
  }
  allPoints.push(...latlngs);
  heatLayer.setLatLngs(allPoints);
}

async function loadBatch(offset) {
  try {
    const res = await fetch(
      `/api/positions?offset=${offset}&limit=${BATCH_SIZE}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Failed to load batch:", err);
    return null;
  }
}

async function loadAll() {
  if (isLoading) return;
  isLoading = true;

  const first = await loadBatch(0);
  if (!first) {
    document.getElementById("loadStatus").textContent = "Failed to load data";
    isLoading = false;
    return;
  }

  totalPoints = first.total;
  updateStats(first.rows.length, totalPoints);
  addPointsToHeatmap(first.rows);

  let loaded = first.rows.length;
  const totalBatches = Math.ceil(totalPoints / BATCH_SIZE);

  for (let batch = 1; batch < totalBatches; batch++) {
    const data = await loadBatch(batch * BATCH_SIZE);
    if (!data) break;
    loaded += data.rows.length;
    updateStats(loaded, totalPoints);
    addPointsToHeatmap(data.rows);
    await new Promise((r) => setTimeout(r, 0));
  }

  isLoading = false;
}

async function init() {
  const host = document.getElementById("mapCanvas");
  if (!host) return;

  const surface = await createMapSurface(host);
  L = surface.L;
  map = surface.map;
  calibration = buildCalibrationTransform(DEFAULT_CALIBRATION);

  if (!L.heatLayer) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://cdn.jsdelivr.net/npm/leaflet.heat@0.2.0/dist/leaflet-heat.js";
      script.crossOrigin = "";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  heatLayer = L.heatLayer([], {
    radius: HEAT_RADIUS,
    blur: HEAT_BLUR,
    maxZoom: map.getMaxZoom(),
    max: HEAT_MAX,
    gradient: HEAT_GRADIENT,
  }).addTo(map);

  loadAll();
}

init();
