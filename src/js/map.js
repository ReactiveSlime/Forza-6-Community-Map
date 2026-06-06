const STORAGE_KEY = 'fh6-dashboard-map-state-v1';

const DEFAULT_CALIBRATION = {
  calAWorld: [-921.8101806640625, -8571.4697265625],
  calAPix: [2089190, 2092051],
  calBWorld: [-7104.76953125, -1863.080322265625],
  calBPix: [2086888, 2089556],
  calCWorld: [5486.39013671875, 907.9600219726562],
  calCPix: [2091573, 2088525],
};

let leafletLoadPromise = null;

export async function findTileBounds() {
  try {
    const res = await fetch('/tiles-meta', { cache: 'no-store' });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fall through to defaults.
  }

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
  if (typeof window.L !== 'undefined') {
    return Promise.resolve(window.L);
  }

  if (leafletLoadPromise) {
    return leafletLoadPromise;
  }

  leafletLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.crossOrigin = '';
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
  } catch {
    // Ignore storage failures in private browsing or locked-down browsers.
  }
}

function toPointPair(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

export function normalizeCalibration(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const calAWorld = toPointPair(raw.calAWorld);
  const calAPix = toPointPair(raw.calAPix);
  const calBWorld = toPointPair(raw.calBWorld);
  const calBPix = toPointPair(raw.calBPix);
  const calCWorld = toPointPair(raw.calCWorld);
  const calCPix = toPointPair(raw.calCPix);

  if (!calAWorld || !calAPix || !calBWorld || !calBPix || !calCWorld || !calCPix) return null;

  return {
    calAWorld,
    calAPix,
    calBWorld,
    calBPix,
    calCWorld,
    calCPix,
  };
}

export function readMapState() {
  const raw = readStoredJson();
  if (!raw || typeof raw !== 'object') return null;

  const calibrationSource = raw.calibration && typeof raw.calibration === 'object' ? raw.calibration : raw;

  return {
    followPlayer: raw.followPlayer !== false,
    calibration: normalizeCalibration(calibrationSource),
    speedUnit: raw.speedUnit === 'km' ? 'km' : 'mph',
  };
}

export function buildCalibrationTransform(raw) {
  const calibration = normalizeCalibration(raw);
  if (!calibration) return null;

  // 3-point affine transformation: [px, py] = A * [wx, wz] + b
  // pix_x = a*world_x + b*world_z + e
  // pix_y = c*world_x + d*world_z + f
  // With 3 points we solve 6 equations for 6 unknowns.

  const wxA = calibration.calAWorld[0];
  const wzA = calibration.calAWorld[1];
  const pxA = calibration.calAPix[0];
  const pyA = calibration.calAPix[1];

  const wxB = calibration.calBWorld[0];
  const wzB = calibration.calBWorld[1];
  const pxB = calibration.calBPix[0];
  const pyB = calibration.calBPix[1];

  const wxC = calibration.calCWorld[0];
  const wzC = calibration.calCWorld[1];
  const pxC = calibration.calCPix[0];
  const pyC = calibration.calCPix[1];

  // Determinant of world point matrix (check that points are not collinear)
  const denom = wxA * (wzB - wzC) - wzA * (wxB - wxC) + (wxB * wzC - wxC * wzB);
  if (Math.abs(denom) < 1e-6) {
    return null; // Points are collinear, cannot solve affine
  }

  // Solve for X coefficients (pixel_x = a*world_x + b*world_z + e)
  const a = ((pxB - pxA) * (wzC - wzA) - (pxC - pxA) * (wzB - wzA)) / denom;
  const b = ((pxC - pxA) * (wxB - wxA) - (pxB - pxA) * (wxC - wxA)) / denom;
  const e = pxA - a * wxA - b * wzA;

  // Solve for Y coefficients (pixel_y = c*world_x + d*world_z + f)
  const c = ((pyB - pyA) * (wzC - wzA) - (pyC - pyA) * (wzB - wzA)) / denom;
  const d = ((pyC - pyA) * (wxB - wxA) - (pyB - pyA) * (wxC - wxA)) / denom;
  const f = pyA - c * wxA - d * wzA;

  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d) || !Number.isFinite(e) || !Number.isFinite(f)) {
    return null;
  }

  return {
    ...calibration,
    a, b, c, d, e, f,
    worldToPixel(worldX, worldZ) {
      return {
        x: a * worldX + b * worldZ + e,
        y: c * worldX + d * worldZ + f,
      };
    },
  };
}

export async function createMapSurface(host, { zoomControl = true } = {}) {
  if (!host) {
    throw new Error('Missing map host element');
  }

  const L = await loadLeafletScript();
  const boundsMeta = await findTileBounds();

  const minZoom = Number.isFinite(boundsMeta.minZoom) ? boundsMeta.minZoom : 0;
  const maxZoom = Number.isFinite(boundsMeta.maxZoom) ? boundsMeta.maxZoom : 22;
  const midZoom = Number.isFinite(boundsMeta.centerZoom)
    ? boundsMeta.centerZoom
    : Math.floor((minZoom + maxZoom) / 2);

  const minX = Number.isFinite(boundsMeta.minX) ? boundsMeta.minX : 0;
  const minY = Number.isFinite(boundsMeta.minY) ? boundsMeta.minY : 0;
  const maxX = Number.isFinite(boundsMeta.maxX) ? boundsMeta.maxX : 2 ** midZoom;
  const maxY = Number.isFinite(boundsMeta.maxY) ? boundsMeta.maxY : 2 ** midZoom;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const center = tileToLatLng(centerX, centerY, midZoom);

  const map = L.map(host, {
    minZoom,
    maxZoom,
    zoomControl,
    attributionControl: false,
  });

  L.tileLayer('/static/maptiles/{z}/{y}/{x}.jpg', {
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
  const host = options.host || document.getElementById('mapCanvas');
  if (!host) return null;

  const compact = Boolean(options.compact);
  const surface = await createMapSurface(host, { zoomControl: !compact });
  const { L, map, maxZoom } = surface;

  const traceLayer = L.layerGroup().addTo(map);
  const savedState = readMapState();
  let followPlayer = savedState?.followPlayer !== false;
  let calibration = buildCalibrationTransform(options.calibration ?? savedState?.calibration ?? DEFAULT_CALIBRATION);
  let speedUnit = savedState?.speedUnit === 'km' ? 'km' : 'mph';
  let latestTelemetry = null;

  function persistState() {
    writeStoredJson({
      followPlayer,
      speedUnit,
      calibration: calibration ? {
        calAWorld: calibration.calAWorld,
        calAPix: calibration.calAPix,
        calBWorld: calibration.calBWorld,
        calBPix: calibration.calBPix,
        calCWorld: calibration.calCWorld,
        calCPix: calibration.calCPix,
      } : null,
    });
  }

  function buildPlayerIcon(headingDeg) {
    const size = compact ? 22 : 28;
    return L.divIcon({
      className: 'player-arrow',
      html:
        `<svg width="${size}" height="${size}" viewBox="0 0 24 24">` +
        `<path transform="rotate(${headingDeg} 12 12)" ` +
        `d="M12 2 L19 21 L12 15 L5 21 Z" fill="#fbbf24" ` +
        `stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function updateTelemetry(telemetry) {
    latestTelemetry = telemetry || null;
    traceLayer.clearLayers();

    if (!telemetry || !calibration) {
      return;
    }

    const worldX = Number(telemetry.positionX ?? 0);
    const worldZ = Number(telemetry.positionZ ?? 0);

    if ((worldX === 0 && worldZ === 0) || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
      return;
    }

    const point = calibration.worldToPixel(worldX, worldZ);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return;
    }

    const latLng = map.unproject(L.point(point.x, point.y), maxZoom);
    const headingDeg = ((Number(telemetry.yaw || 0) * 180) / Math.PI) % 360;

    L.marker(latLng, {
      icon: buildPlayerIcon(headingDeg),
      interactive: false,
    }).addTo(traceLayer);

    if (followPlayer) {
      map.setView(latLng, map.getZoom(), { animate: false });
    }
  }

  function setFollowPlayer(nextFollow) {
    followPlayer = Boolean(nextFollow);
    persistState();

    if (followPlayer && latestTelemetry) {
      updateTelemetry(latestTelemetry);
    }

    return followPlayer;
  }

  function getFollowPlayer() {
    return followPlayer;
  }

  function setCalibration(nextCalibration) {
    calibration = buildCalibrationTransform(nextCalibration);
    persistState();

    if (latestTelemetry) {
      updateTelemetry(latestTelemetry);
    }

    return getCalibration();
  }

  function setSpeedUnit(nextSpeedUnit) {
    speedUnit = nextSpeedUnit === 'km' ? 'km' : 'mph';
    persistState();
    return speedUnit;
  }

  function getSpeedUnit() {
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

  function hasCalibration() {
    return Boolean(calibration);
  }

  function destroy() {
    map.remove();
  }

  return {
    L,
    map,
    updateTelemetry,
    setFollowPlayer,
    getFollowPlayer,
    setCalibration,
    getCalibration,
    setSpeedUnit,
    getSpeedUnit,
    hasCalibration,
    destroy,
  };
}
