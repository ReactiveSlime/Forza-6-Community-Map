import { buildCalibrationTransform } from "./calibration.js";
import {
  buildPlayerIcon,
  buildPopupHtml,
  getColorForPlayer,
} from "./markers.js";
import { initMap } from "./map.js";

let mapController = null;
let ws = null;
let wsReconnectTimer = null;
let activePlayer = null;
let following = false;
let latestCalibration = null;
let speedUnit = "mph";
const playerMarkers = new Map();
const playerData = new Map();

const RECONNECT_DELAY = 3000;
const WS_URL = (() => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
})();

function normalizeSpeedUnit(value) {
  return value === "km" ? "km" : "mph";
}

function getSpeedLabel() {
  return speedUnit === "km" ? "km/h" : "mph";
}

function getSpeedValue(telemetry) {
  if (speedUnit === "km") {
    return Math.round(Number(telemetry.speedKph ?? 0));
  }

  return Math.round(Number(telemetry.speedMph ?? 0));
}

function updateSpeedUnitToggle() {
  const buttons = document.querySelectorAll("[data-speed-unit]");

  buttons.forEach((button) => {
    const isActive = button.dataset.speedUnit === speedUnit;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  const labelEl = document.getElementById("speedUnitLabel");
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
}

function getPlayerLatLng(clientId, calibration) {
  const player = playerData.get(clientId);
  if (!player?.telemetry) return null;

  const tel = player.telemetry;
  const worldX = Number(tel.positionX ?? 0);
  const worldZ = Number(tel.positionZ ?? 0);

  if (
    (worldX === 0 && worldZ === 0) ||
    !Number.isFinite(worldX) ||
    !Number.isFinite(worldZ)
  )
    return null;

  return worldToLatLng(worldX, worldZ, calibration);
}

function focusOnPlayer(clientId, calibration, { animate = false } = {}) {
  if (!mapController?.map) return false;

  const latLng = getPlayerLatLng(clientId, calibration);
  if (!latLng) return false;

  mapController.map.setView(latLng, mapController.map.getZoom(), { animate });
  return true;
}

function setActivePlayer(clientId) {
  activePlayer = clientId;

  if (activePlayer) {
    focusOnPlayer(activePlayer, latestCalibration);
  }
}

function worldToLatLng(worldX, worldZ, calibration) {
  if (!calibration || !mapController?.map || !mapController?.L) {
    return null;
  }

  const point = calibration.worldToPixel(Number(worldX), Number(worldZ));
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }

  return mapController.map.unproject(
    mapController.L.point(point.x, point.y),
    mapController.map.getMaxZoom(),
  );
}

function updatePlayerMarker(
  clientId,
  telemetry,
  calibration,
  markerColor = null,
) {
  if (!mapController || !calibration) return;
  const player = playerData.get(clientId) || {};
  const playerName = player.username || clientId;

  const worldX = Number(telemetry.positionX ?? 0);
  const worldZ = Number(telemetry.positionZ ?? 0);

  if (
    (worldX === 0 && worldZ === 0) ||
    !Number.isFinite(worldX) ||
    !Number.isFinite(worldZ)
  )
    return;

  const latLng = worldToLatLng(worldX, worldZ, calibration);
  if (!latLng) return;

  const headingDeg = ((Number(telemetry.yaw || 0) * 180) / Math.PI) % 360;
  const color = markerColor || getColorForPlayer(playerName);
  const popupHtml = buildPopupHtml({
    playerName,
    telemetry,
    speedValue: getSpeedValue(telemetry),
    speedLabel: getSpeedLabel(),
  });

  let marker = playerMarkers.get(clientId);

  if (!marker) {
    marker = mapController.L.marker(latLng, {
      icon: buildPlayerIcon(mapController.L, headingDeg, color),
      title: `${playerName} - ${telemetry.carName || "Player"}`,
      interactive: true,
    }).addTo(mapController.map);

    marker.bindPopup(popupHtml, { maxWidth: 320 });
    marker.on("click", () => {
      following = true;
      setActivePlayer(clientId);
      marker.openPopup();
      focusOnPlayer(clientId, latestCalibration || calibration, {
        animate: true,
      });
    });

    playerMarkers.set(clientId, marker);
  } else {
    marker.setLatLng(latLng);

    // Only update the icon's rotation via the SVG directly — avoid setIcon()
    // because it recreates the DOM element and can break popup click listeners.
    const iconEl = marker.getElement?.();
    if (iconEl) {
      const path = iconEl.querySelector("path");
      if (path) {
        path.setAttribute("transform", `rotate(${headingDeg} 12 12)`);
      }
    } else {
      // Fallback: element not yet in DOM, safe to replace icon
      marker.setIcon(buildPlayerIcon(mapController.L, headingDeg, color));
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

function updatePlayersList(players, calibration) {
  latestCalibration = calibration;

  if (players.length === 0) {
    // Remove any stale markers even if the panel is hidden
    for (const [clientId, marker] of playerMarkers.entries()) {
      mapController.map.removeLayer(marker);
      playerMarkers.delete(clientId);
      playerData.delete(clientId);
    }

    activePlayer = null;
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
      updatePlayerMarker(
        player.clientId,
        player.telemetry,
        calibration,
        player.markerColor,
      );
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

  if (activePlayer && !activePlayerIds.has(activePlayer)) {
    activePlayer = null;
  }

  if (following && !activePlayer && players.length === 1) {
    activePlayer = players[0].clientId;
  }

  if (following && activePlayer) {
    focusOnPlayer(activePlayer, calibration);
  }

  updatePlayerDropdown();
}

function updatePlayerDropdown() {
  const list = document.getElementById("playerDropdownList");
  if (!list || list.classList.contains("open")) return;

  if (playerData.size === 0) {
    list.innerHTML =
      '<div class="player-dropdown__empty">No players connected</div>';
    return;
  }

  let html = "";
  for (const [clientId, player] of playerData) {
    const name = player.username || clientId;
    const car = player.telemetry?.carName || "Unknown";
    const color = player.markerColor || getColorForPlayer(name);
    const active = clientId === activePlayer ? " active" : "";
    html += `<div class="player-dropdown__item${active}" onclick="window.selectPlayer('${clientId}');this.closest('.player-dropdown__list').classList.remove('open');document.getElementById('playerListBtn').classList.remove('open')">
      <span class="player-dropdown__dot" style="background:${color}"></span>
      <span class="player-dropdown__name">${name}</span>
      <span class="player-dropdown__car">${car}</span>
    </div>`;
  }
  list.innerHTML = html;
}

function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("WebSocket connected");
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
        document.getElementById("playerCount").textContent = playerCount;

        // Get calibration from map
        const calibration = mapController?.getCalibration?.()
          ? buildCalibrationTransform(mapController.getCalibration())
          : buildCalibrationTransform({
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
        console.error("Error processing WebSocket message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      updateConnectionStatus(false);
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
      updateConnectionStatus(false);
      scheduleReconnect();
    };
  } catch (error) {
    console.error("Failed to create WebSocket:", error);
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
    console.log("Attempting to reconnect...");
    connectWebSocket();
  }, RECONNECT_DELAY);
}

function updateConnectionStatus(connected) {
  const statusEl = document.getElementById("connectionStatus");
  const textEl = document.getElementById("connectionText");

  if (statusEl) {
    statusEl.className = `connection-status ${connected ? "connected" : "disconnected"}`;
  }

  if (textEl) {
    textEl.textContent = connected ? "Connected" : "Disconnected";
  }
}

async function start() {
  try {
    mapController = await initMap({
      host: document.getElementById("mapCanvas"),
      compact: false,
    });

    if (!mapController) {
      console.error("Failed to initialize map");
      return;
    }

    speedUnit = normalizeSpeedUnit(mapController.getSpeedUnit?.());
    updateSpeedUnitToggle();

    mapController.map.on("click", () => {
      following = false;
      activePlayer = null;
    });

    mapController.map.on("dragstart", () => {
      following = false;
      activePlayer = null;
    });

    const playerBtn = document.getElementById("playerListBtn");
    const playerList = document.getElementById("playerDropdownList");
    playerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = playerList.classList.toggle("open");
      playerBtn.classList.toggle("open", open);
    });
    document.addEventListener("click", () => {
      playerList.classList.remove("open");
      playerBtn.classList.remove("open");
    });
    playerList.addEventListener("click", (e) => e.stopPropagation());

    console.log("Map initialized");
    connectWebSocket();
  } catch (error) {
    console.error("Error starting live map:", error);
  }
}

// Global function for player selection
window.selectPlayer = (clientId) => {
  following = true;
  setActivePlayer(clientId);
};

document.querySelectorAll("[data-speed-unit]").forEach((button) => {
  button.addEventListener("click", () => {
    setSpeedUnit(button.dataset.speedUnit);
  });
});

start();

window.addEventListener("beforeunload", () => {
  if (ws) {
    ws.close();
  }
  if (mapController?.destroy) {
    mapController.destroy();
  }
});
