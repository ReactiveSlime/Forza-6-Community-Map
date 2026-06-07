import { initMap, buildCalibrationTransform } from './map.js';

let mapController = null;
let ws = null;
let wsReconnectTimer = null;
let activePlayer = null;
let latestCalibration = null;
let speedUnit = 'mph';
const playerMarkers = new Map();
const playerData = new Map();

const RECONNECT_DELAY = 3000;
const WS_URL = (() => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
})();

function getColorForPlayer(clientId) {
  // Generate consistent color for each player based on clientId
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    const char = clientId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  const colors = [
    '#fbbf24', // amber
    '#10b981', // emerald
    '#3b82f6', // blue
    '#f87171', // red
    '#a78bfa', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f97316', // orange
  ];

  return colors[Math.abs(hash) % colors.length];
}

function buildPlayerIcon(headingDeg, color = '#fbbf24', size = 24) {
  if (!mapController?.L) return null;

  return mapController.L.divIcon({
    className: 'player-marker',
    html:
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">` +
      `<path transform="rotate(${headingDeg} 12 12)" ` +
      `d="M12 2 L19 21 L12 15 L5 21 Z" fill="${color}" ` +
      `stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function normalizeSpeedUnit(value) {
  return value === 'km' ? 'km' : 'mph';
}

function getSpeedLabel() {
  return speedUnit === 'km' ? 'km/h' : 'mph';
}

function getSpeedValue(telemetry) {
  if (speedUnit === 'km') {
    return Math.round(Number(telemetry.speedKph ?? 0));
  }

  return Math.round(Number(telemetry.speedMph ?? 0));
}

function updateSpeedUnitToggle() {
  const buttons = document.querySelectorAll('[data-speed-unit]');

  buttons.forEach((button) => {
    const isActive = button.dataset.speedUnit === speedUnit;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });

  const labelEl = document.getElementById('speedUnitLabel');
  if (labelEl) {
    labelEl.textContent = getSpeedLabel();
  }
}

function setSpeedUnit(nextUnit) {
  const normalized = normalizeSpeedUnit(nextUnit);
  speedUnit = normalized;

  if (mapController?.setSpeedUnit) {
    mapController.setSpeedUnit(normalized);
  }

  updateSpeedUnitToggle();
  updatePlayersList(Array.from(playerData.values()), latestCalibration);
}

function worldToLatLng(worldX, worldZ, calibration) {
  if (!calibration || !mapController?.map || !mapController?.L) {
    return null;
  }

  const point = calibration.worldToPixel(Number(worldX), Number(worldZ));
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }

  return mapController.map.unproject(mapController.L.point(point.x, point.y), mapController.map.getMaxZoom());
}

function renderPlayersList(players) {
  const listEl = document.getElementById('playersList');

  const playersHtml = players
    .map((player) => {
      const tel = player.telemetry || {};
      const isActive = activePlayer === player.clientId;
      const speedValue = getSpeedValue(tel);
      const className = `player-item${isActive ? ' active' : ''}`;

      return `
        <div class="${className}">
          <div class="player-header">
            <span class="player-name">${tel.carName || 'Unknown Car'}</span>
            <span class="player-speed">${speedValue} ${getSpeedLabel()}</span>
          </div>
          <div class="player-details">
            <div class="detail-row">
              <span class="detail-label">Class:</span>
              <span>${tel.carClassLabel || 'N/A'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Gear:</span>
              <span>${tel.gearLabel || 'N/A'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">RPM:</span>
              <span>${Math.round(Number(tel.currentEngineRpm ?? 0)).toLocaleString()}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  if (listEl) {
    try {
      listEl.innerHTML = playersHtml;
    } catch (e) {
      console.warn('Failed to render players list:', e);
    }
  }
}

function updatePlayerMarker(clientId, telemetry, calibration) {
  if (!mapController || !calibration) return;

  const worldX = Number(telemetry.positionX ?? 0);
  const worldZ = Number(telemetry.positionZ ?? 0);

  if ((worldX === 0 && worldZ === 0) || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) return;

  const latLng = worldToLatLng(worldX, worldZ, calibration);
  if (!latLng) return;

  const headingDeg = ((Number(telemetry.yaw || 0) * 180) / Math.PI) % 360;
  const color = getColorForPlayer(clientId);
  const popupHtml = buildPopupHtml({ clientId, telemetry });

  let marker = playerMarkers.get(clientId);

  if (!marker) {
    marker = mapController.L.marker(latLng, {
      icon: buildPlayerIcon(headingDeg, color),
      title: telemetry.carName || 'Player',
    }).addTo(mapController.map);

    marker.bindPopup(popupHtml, { maxWidth: 320 });

    playerMarkers.set(clientId, marker);
  } else {
    marker.setLatLng(latLng);

    // Only update the icon's rotation via the SVG directly — avoid setIcon()
    // because it recreates the DOM element and can break popup click listeners.
    const iconEl = marker.getElement?.();
    if (iconEl) {
      const path = iconEl.querySelector('path');
      if (path) {
        path.setAttribute('transform', `rotate(${headingDeg} 12 12)`);
      }
    } else {
      // Fallback: element not yet in DOM, safe to replace icon
      marker.setIcon(buildPlayerIcon(headingDeg, color));
    }

    // Always ensure popup exists and has fresh content
    const popup = marker.getPopup();
    if (popup) {
      popup.setContent(popupHtml);
    } else {
      marker.bindPopup(popupHtml, { maxWidth: 320 });
    }
  }
}


function buildPopupHtml({ clientId, telemetry }) {
  const tel = telemetry || {};
  const speedValue = getSpeedValue(tel);
  return `
    <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111;">
      <div style="font-weight:700; font-size:16px; margin-bottom:6px;">${tel.carName || 'Unknown Car'}</div>
      <div style="font-size:14px;"><strong>Speed:</strong> ${speedValue} ${getSpeedLabel()}</div>
    </div>
  `;
}
function updatePlayersList(players, calibration) {
  latestCalibration = calibration;
  const listEl = document.getElementById('playersList');

  if (players.length === 0) {
    // Remove any stale markers even if the panel is hidden
    for (const [clientId, marker] of playerMarkers.entries()) {
      mapController.map.removeLayer(marker);
      playerMarkers.delete(clientId);
      playerData.delete(clientId);
    }

    if (listEl) listEl.innerHTML = '<div class="empty-state">No active players</div>';
    return;
  }

  const now = Date.now();
  const activePlayerIds = new Set();

  // Update player data
  for (const player of players) {
    activePlayerIds.add(player.clientId);
    playerData.set(player.clientId, {
      ...player,
      lastUpdate: now,
    });

    // Update marker on map
    if (player.telemetry) {
      updatePlayerMarker(player.clientId, player.telemetry, calibration);
    }
  }

  // Remove stale markers
  for (const [clientId, marker] of playerMarkers.entries()) {
    if (!activePlayerIds.has(clientId)) {
      mapController.map.removeLayer(marker);
      playerMarkers.delete(clientId);
      playerData.delete(clientId);
    }
  }

  renderPlayersList(players);
}

function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected');
      updateConnectionStatus(true);
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const playerCount = payload.playerCount || 0;
        document.getElementById('playerCount').textContent = playerCount;

        // Get calibration from map
        const calibration = mapController?.getCalibration?.() ? 
          buildCalibrationTransform(mapController.getCalibration()) : 
          buildCalibrationTransform({
            calAWorld: [-921.8101806640625, -8571.4697265625],
            calAPix: [2089190, 2092051],
            calBWorld: [-7104.76953125, -1863.080322265625],
            calBPix: [2086888, 2089556],
            calCWorld: [5486.39013671875, 907.9600219726562],
            calCPix: [2091573, 2088525],
          });

        if (payload.players && Array.isArray(payload.players)) {
          updatePlayersList(payload.players, calibration);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      updateConnectionStatus(false);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      updateConnectionStatus(false);
      scheduleReconnect();
    };
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    updateConnectionStatus(false);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (wsReconnectTimer) {
    return;
  }

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    console.log('Attempting to reconnect...');
    connectWebSocket();
  }, RECONNECT_DELAY);
}

function updateConnectionStatus(connected) {
  const statusEl = document.getElementById('connectionStatus');
  const textEl = document.getElementById('connectionText');

  if (statusEl) {
    statusEl.className = `connection-status ${connected ? 'connected' : 'disconnected'}`;
  }

  if (textEl) {
    textEl.textContent = connected ? 'Connected' : 'Disconnected';
  }
}

async function start() {
  try {
    mapController = await initMap({
      host: document.getElementById('mapCanvas'),
      compact: false,
    });

    if (!mapController) {
      console.error('Failed to initialize map');
      return;
    }

    speedUnit = normalizeSpeedUnit(mapController.getSpeedUnit?.());
    updateSpeedUnitToggle();

    console.log('Map initialized');
    connectWebSocket();
  } catch (error) {
    console.error('Error starting live map:', error);
  }
}

// Global function for player selection
window.selectPlayer = (clientId) => {
  activePlayer = activePlayer === clientId ? null : clientId;
  renderPlayersList(Array.from(playerData.values()));
};

document.querySelectorAll('[data-speed-unit]').forEach((button) => {
  button.addEventListener('click', () => {
    setSpeedUnit(button.dataset.speedUnit);
  });
});

start();

window.addEventListener('beforeunload', () => {
  if (ws) {
    ws.close();
  }
  if (mapController?.destroy) {
    mapController.destroy();
  }
});