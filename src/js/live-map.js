import {
  buildCalibrationTransform,
  DEFAULT_CALIBRATION,
} from "./calibration.js";
import {
  buildPlayerIcon,
  buildPopupHtml,
  getColorForPlayer,
} from "./markers.js";
import { initMap } from "./map.js";

let MAX_TRAIL_POINTS = (() => {
  const p = new URLSearchParams(window.location.search).get("trail");
  if (p) {
    const n = parseInt(p, 10);
    if (n > 0) return n;
  }
  const s = localStorage.getItem("maxTrailPoints");
  if (s) {
    const n = parseInt(s, 10);
    if (n > 0) return n;
  }
  return 1000;
})();

let mapController = null;
let ws = null;
let wsReconnectTimer = null;
let activePlayer = null;
let following = false;
let latestCalibration = null;
let speedUnit = "mph";
let showLabels = false;
const playerMarkers = new Map();
const playerData = new Map();
const playerTrails = new Map();

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

function updateLabelsToggle() {
  const btn = document.getElementById("labelsBtn");
  if (btn) {
    btn.classList.toggle("active", showLabels);
    btn.setAttribute("aria-pressed", String(showLabels));
  }
}

function setLabelsVisibility(visible) {
  showLabels = visible;
  for (const [, marker] of playerMarkers) {
    if (visible) {
      marker.bindTooltip(marker._playerName || "", {
        permanent: true,
        direction: "top",
        className: "player-label",
      });
    } else {
      marker.unbindTooltip();
    }
  }
  updateLabelsToggle();
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

  if (clientId === activePlayer) {
    const player = playerData.get(clientId);
    const prevLatLng = playerMarkers.get(clientId)?.getLatLng();
    if (prevLatLng && prevLatLng.distanceTo(latLng) > 1) {
      let trail = playerTrails.get(clientId);
      if (!trail) {
        trail = { points: [], polyline: null };
        playerTrails.set(clientId, trail);
      }
      trail.points.push(latLng);
      if (trail.points.length > MAX_TRAIL_POINTS) trail.points.shift();
      if (trail.polyline) {
        trail.polyline.setLatLngs(trail.points);
      } else if (trail.points.length > 1) {
        const marker = playerMarkers.get(clientId);
        trail.polyline = mapController.L.polyline(trail.points, {
          color: marker?._color || "#fbbf24",
          opacity: 0.8,
          weight: 6,
          smoothFactor: 1,
        }).addTo(mapController.map);
      }
    }
  }

  let marker = playerMarkers.get(clientId);

  if (!marker) {
    marker = mapController.L.marker(latLng, {
      icon: buildPlayerIcon(mapController.L, headingDeg, color),
      title: `${playerName} - ${telemetry.carName || "Player"}`,
      interactive: true,
    }).addTo(mapController.map);

    marker._playerName = playerName;
    if (showLabels) {
      marker.bindTooltip(playerName, {
        permanent: true,
        direction: "top",
        className: "player-label",
      });
    }

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
    marker._color = color;
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

    marker._playerName = playerName;
    if (showLabels) {
      const tip = marker.getTooltip();
      if (tip) tip.setContent(playerName);
      else
        marker.bindTooltip(playerName, {
          permanent: true,
          direction: "top",
          className: "player-label",
        });
    }

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
    for (const [clientId, marker] of playerMarkers.entries()) {
      mapController.map.removeLayer(marker);
      playerMarkers.delete(clientId);
      playerData.delete(clientId);
    }
    for (const [, trail] of playerTrails) {
      if (trail.polyline) trail.polyline.remove();
    }
    playerTrails.clear();

    activePlayer = null;
    return;
  }

  const now = Date.now();
  const activePlayerIds = new Set();

  for (const player of players) {
    activePlayerIds.add(player.clientId);
    playerData.set(player.clientId, {
      ...player,
      lastUpdate: now,
    });

    if (player.telemetry) {
      updatePlayerMarker(
        player.clientId,
        player.telemetry,
        calibration,
        player.markerColor,
      );
    }
  }

  for (const [clientId, marker] of playerMarkers.entries()) {
    if (!activePlayerIds.has(clientId)) {
      mapController.map.removeLayer(marker);
      playerMarkers.delete(clientId);
      playerData.delete(clientId);
      const trail = playerTrails.get(clientId);
      if (trail?.polyline) trail.polyline.remove();
      playerTrails.delete(clientId);
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

function updatePlayerTrail(clientId, latLng, color) {
  if (!mapController) return;
  let trail = playerTrails.get(clientId);
  if (!trail) {
    trail = { points: [], polyline: null };
    playerTrails.set(clientId, trail);
  }
  trail.points.push(latLng);
  if (trail.points.length > MAX_TRAIL_POINTS) trail.points.shift();

  if (clientId === activePlayer) {
    if (trail.polyline) {
      trail.polyline.setLatLngs(trail.points);
    } else {
      trail.polyline = mapController.L.polyline(trail.points, {
        color,
        opacity: 0.8,
        weight: 6,
        smoothFactor: 1,
      }).addTo(mapController.map);
    }
  }
}

function setActivePlayer(clientId) {
  if (activePlayer && activePlayer !== clientId) {
    const prev = playerTrails.get(activePlayer);
    if (prev?.polyline) {
      prev.polyline.remove();
      prev.polyline = null;
    }
  }

  activePlayer = clientId;

  if (activePlayer) {
    const trail = playerTrails.get(activePlayer);
    if (trail?.points.length > 1) {
      if (trail.polyline) {
        trail.polyline.addTo(mapController.map);
      } else {
        const marker = playerMarkers.get(activePlayer);
        const color = marker?._color || "#fbbf24";
        trail.polyline = mapController.L.polyline(trail.points, {
          color,
          opacity: 0.8,
          weight: 6,
          smoothFactor: 1,
        }).addTo(mapController.map);
      }
    }
    focusOnPlayer(activePlayer, latestCalibration);
  }
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
          : buildCalibrationTransform(DEFAULT_CALIBRATION);

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
      if (activePlayer) {
        const prev = playerTrails.get(activePlayer);
        if (prev?.polyline) {
          prev.polyline.remove();
          prev.polyline = null;
        }
      }
      following = false;
      activePlayer = null;
    });

    mapController.map.on("dragstart", () => {
      if (activePlayer) {
        const prev = playerTrails.get(activePlayer);
        if (prev?.polyline) {
          prev.polyline.remove();
          prev.polyline = null;
        }
      }
      following = false;
      activePlayer = null;
    });

    document.getElementById("labelsBtn")?.addEventListener("click", () => {
      setLabelsVisibility(!showLabels);
    });

    const trailInput = document.getElementById("trailPoints");
    if (trailInput) {
      trailInput.value = String(MAX_TRAIL_POINTS);
      trailInput.addEventListener("change", () => {
        const n = parseInt(trailInput.value, 10);
        if (n > 0) {
          MAX_TRAIL_POINTS = n;
          localStorage.setItem("maxTrailPoints", String(n));
          for (const [, trail] of playerTrails) {
            if (trail.polyline) trail.polyline.remove();
          }
          playerTrails.clear();
        }
      });
    }

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

    const modal = document.getElementById("connectionModal");
    const infoBtn = document.getElementById("connectionInfoBtn");
    const closeBtn = document.getElementById("modalClose");
    infoBtn.addEventListener("click", () => {
      modal.style.display = "";
    });
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });

    const settingsBtn = document.getElementById("settingsBtn");
    const settingsList = document.getElementById("settingsList");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsList.classList.toggle("open");
      settingsBtn.classList.toggle("open");
    });
    settingsList.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => {
      settingsList.classList.remove("open");
      settingsBtn.classList.remove("open");
    });

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
