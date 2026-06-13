import {
  buildCalibrationTransform,
  normalizeCalibration,
  DEFAULT_CALIBRATION,
} from "./calibration.js";

const STORAGE_KEY = "fh6-dashboard-map-state-v1";

let leafletLoadPromise = null;

export async function findTileBounds() {
  try {
    const res = await fetch("/tiles-meta", { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {}
  return {
    minZoom: 0,
    maxZoom: 22,
    centerZoom: 11,
    minX: 0,
    minY: 0,
    maxX: 2 ** 11,
    maxY: 2 ** 11,
  };
}

export function tileToLatLng(x, y, z) {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const mercatorY = Math.PI - (2 * Math.PI * (y + 0.5)) / n;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(mercatorY));
  return [lat, lng];
}

function loadLeafletScript() {
  if (typeof window.L !== "undefined") return Promise.resolve(window.L);
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.crossOrigin = "";
    script.onload = () => resolve(window.L);
    script.onerror = (error) => reject(error);
    document.head.appendChild(script);
  });

  return leafletLoadPromise;
}

function readStoredJson() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStoredJson(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {}
}

export function readMapState() {
  const raw = readStoredJson();
  if (!raw || typeof raw !== "object") return null;
  const calibrationSource =
    raw.calibration && typeof raw.calibration === "object"
      ? raw.calibration
      : raw;
  return {
    calibration: normalizeCalibration(calibrationSource),
    speedUnit: raw.speedUnit === "km" ? "km" : "mph",
  };
}

export async function createMapSurface(host, { zoomControl = true } = {}) {
  if (!host) throw new Error("Missing map host element");

  const L = await loadLeafletScript();
  const boundsMeta = await findTileBounds();

  const minZoom = Number.isFinite(boundsMeta.minZoom) ? boundsMeta.minZoom : 0;
  const maxZoom = Number.isFinite(boundsMeta.maxZoom) ? boundsMeta.maxZoom : 22;
  const midZoom = Number.isFinite(boundsMeta.centerZoom)
    ? boundsMeta.centerZoom
    : Math.floor((minZoom + maxZoom) / 2);
  const minX = Number.isFinite(boundsMeta.minX) ? boundsMeta.minX : 0;
  const minY = Number.isFinite(boundsMeta.minY) ? boundsMeta.minY : 0;
  const maxX = Number.isFinite(boundsMeta.maxX)
    ? boundsMeta.maxX
    : 2 ** midZoom;
  const maxY = Number.isFinite(boundsMeta.maxY)
    ? boundsMeta.maxY
    : 2 ** midZoom;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const center = tileToLatLng(centerX, centerY, midZoom);

  const map = L.map(host, {
    minZoom,
    maxZoom,
    zoomControl,
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

  return {
    L,
    map,
    minZoom,
    maxZoom,
    defaultZoom: midZoom,
    center,
    boundsMeta,
    destroy() {
      map.remove();
    },
  };
}

export async function initMap(options = {}) {
  const host = options.host || document.getElementById("mapCanvas");
  if (!host) return null;

  const surface = await createMapSurface(host, {
    zoomControl: !Boolean(options.compact),
  });
  const { L, map } = surface;
  const savedState = readMapState();
  let calibration = buildCalibrationTransform(
    options.calibration ?? savedState?.calibration ?? DEFAULT_CALIBRATION,
  );
  let speedUnit = savedState?.speedUnit === "km" ? "km" : "mph";

  function persistState() {
    writeStoredJson({
      speedUnit,
      calibration: calibration
        ? {
            calAWorld: calibration.calAWorld,
            calAPix: calibration.calAPix,
            calBWorld: calibration.calBWorld,
            calBPix: calibration.calBPix,
            calCWorld: calibration.calCWorld,
            calCPix: calibration.calCPix,
          }
        : null,
    });
  }

  function setCalibration(nextCalibration) {
    calibration = buildCalibrationTransform(nextCalibration);
    persistState();
    return getCalibration();
  }

  function setSpeedUnit(nextSpeedUnit) {
    speedUnit = nextSpeedUnit === "km" ? "km" : "mph";
    persistState();
    return speedUnit;
  }

  function getCalibration() {
    if (!calibration) return null;
    return {
      calAWorld: calibration.calAWorld,
      calAPix: calibration.calAPix,
      calBWorld: calibration.calBWorld,
      calBPix: calibration.calBPix,
      calCWorld: calibration.calCWorld,
      calCPix: calibration.calCPix,
    };
  }

  return {
    L,
    map,
    setCalibration,
    getCalibration,
    hasCalibration: () => Boolean(calibration),
    setSpeedUnit,
    getSpeedUnit: () => speedUnit,
    destroy: () => map.remove(),
  };
}
