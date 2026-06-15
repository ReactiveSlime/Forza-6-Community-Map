import dgram from "node:dgram";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import {
  dirname as pathDirname,
  extname,
  normalize,
  dirname,
  join,
} from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { readTelemetryPacket } from "./telemetry.js";
import { initDb } from "./db.js";

// Load settings from settings.json with environment variable overrides
function loadSettings() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const settingsPath = `${__dirname}/settings.json`;

  let settings = {
    server: { port: 3001, host: "0.0.0.0", cacheControl: "no-store" },
    telemetry: {
      udpPort: 20441,
      connectionTimeoutMs: 2000,
      broadcastIntervalMs: 250,
    },
    logging: { enabled: true, level: "info" },
    tiles: { autoDetect: true },
  };

  if (existsSync(settingsPath)) {
    try {
      const fileContent = readFileSync(settingsPath, "utf-8");
      const loaded = JSON.parse(fileContent);
      settings = { ...settings, ...loaded };
    } catch (error) {
      console.warn(`Could not load settings.json: ${error.message}`);
    }
  }

  // Environment variables override file settings
  if (process.env.HTTP_PORT)
    settings.server.port = Number(process.env.HTTP_PORT);
  if (process.env.UDP_PORT)
    settings.telemetry.udpPort = Number(process.env.UDP_PORT);
  if (process.env.HOST) settings.server.host = process.env.HOST;
  if (process.env.CONNECTION_TIMEOUT_MS)
    settings.telemetry.connectionTimeoutMs = Number(
      process.env.CONNECTION_TIMEOUT_MS,
    );

  return settings;
}

const settings = loadSettings();
const PORT = settings.server.port;
const UDP_PORT = settings.telemetry.udpPort;
const HOST = settings.server.host;
const CONNECTION_TIMEOUT_MS = settings.telemetry.connectionTimeoutMs;

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const db = initDb(join(DATA_DIR, "positions.db"));

let recordCounter = 0;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

// Utility for logging with settings support
function log(...args) {
  if (settings.logging.enabled) {
    console.log(...args);
  }
}

function buildTileMeta() {
  const base = new URL("./src/static/maptiles", import.meta.url);
  if (!existsSync(base)) {
    return {
      minZoom: 0,
      maxZoom: 22,
      minX: 0,
      minY: 0,
      maxX: 2 ** 13,
      maxY: 2 ** 13,
    };
  }

  const zoomDirs = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);

  if (zoomDirs.length === 0) {
    return {
      minZoom: 0,
      maxZoom: 22,
      minX: 0,
      minY: 0,
      maxX: 2 ** 13,
      maxY: 2 ** 13,
    };
  }

  const midZoom = zoomDirs[Math.floor(zoomDirs.length / 2)];
  const midPath = new URL(`./src/static/maptiles/${midZoom}/`, import.meta.url);
  const xDirs = readdirSync(midPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);

  let minX = 0;
  let maxX = 2 ** midZoom;
  let minY = 0;
  let maxY = 2 ** midZoom;

  if (xDirs.length > 0) {
    minX = xDirs[0];
    maxX = xDirs[xDirs.length - 1];

    const yValues = [];
    for (const x of xDirs) {
      const yPath = new URL(
        `./src/static/maptiles/${midZoom}/${x}/`,
        import.meta.url,
      );
      const files = readdirSync(yPath, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && /^\d+\.(jpg|jpeg|png|webp)$/i.test(entry.name),
        )
        .map((entry) => Number(entry.name.split(".")[0]));
      yValues.push(...files);
    }

    if (yValues.length > 0) {
      yValues.sort((a, b) => a - b);
      minY = yValues[0];
      maxY = yValues[yValues.length - 1];
    }
  }

  return {
    minZoom: zoomDirs[0],
    maxZoom: zoomDirs[zoomDirs.length - 1],
    centerZoom: midZoom,
    minX,
    maxX,
    minY,
    maxY,
  };
}

let tileMeta = buildTileMeta();

function resolveFileUrl(urlPath) {
  const requestPath = urlPath === "/" ? "/index.html" : urlPath;
  const normalizedPath = normalize(requestPath)
    .replace(/^\\+/, "")
    .replace(/^\/+/, "");

  if (normalizedPath.includes("..")) {
    return null;
  }

  const fileUrl = new URL(`./src/${normalizedPath}`, import.meta.url);

  // If the path has no extension and the file doesn't exist, try appending .html
  if (!extname(normalizedPath) && !existsSync(fileUrl)) {
    return new URL(`./src/${normalizedPath}.html`, import.meta.url);
  }

  return fileUrl;
}

const PPS_WINDOW = 5000;
const packetTimes = [];

function recordPacket() {
  const now = Date.now();
  state.packetCount += 1;
  packetTimes.push(now);
  const cutoff = now - PPS_WINDOW;
  while (packetTimes.length > 0 && packetTimes[0] < cutoff) packetTimes.shift();
}

function packetsPerSecond() {
  if (packetTimes.length < 2) return 0;
  const elapsed = (packetTimes[packetTimes.length - 1] - packetTimes[0]) / 1000;
  return elapsed > 0 ? Math.round((packetTimes.length / elapsed) * 10) / 10 : 0;
}

// Track multiple players: Map<clientId, {telemetry, lastPacketAt}>
const state = {
  players: new Map(),
  packetCount: 0,
  serverStartTime: Date.now(),
};

function isZeroLikeTelemetry(telemetry) {
  if (!telemetry) return true;
  return (
    (telemetry.speedMs ?? 0) === 0 && (telemetry.currentEngineRpm ?? 0) === 0
  );
}

function getClientId(remote) {
  return `${remote.address}:${remote.port}`;
}

// Map internal client address:port -> opaque public id to avoid exposing IPs
const publicIdMap = new Map();
let nextPublicId = 1;
function getPublicId(internalId) {
  if (publicIdMap.has(internalId)) return publicIdMap.get(internalId);
  const id = `c${nextPublicId++}`;
  publicIdMap.set(internalId, id);
  return id;
}

// Map internal client IDs to auto-generated usernames
const autoGeneratedNames = new Map();
let nextAutoUsername = 1;
const nameAdjectives = [
  "Speedy",
  "Quick",
  "Swift",
  "Bold",
  "Brave",
  "Daring",
  "Racing",
  "Pro",
  "Elite",
];
const nameNouns = [
  "Racer",
  "Driver",
  "Pilot",
  "Ace",
  "Champion",
  "Legend",
  "Rider",
  "Star",
];

function generateAutoUsername(clientId) {
  if (autoGeneratedNames.has(clientId)) return autoGeneratedNames.get(clientId);
  const adjective =
    nameAdjectives[Math.floor(Math.random() * nameAdjectives.length)];
  const noun = nameNouns[Math.floor(Math.random() * nameNouns.length)];
  const name = `${adjective}${noun}${nextAutoUsername++}`;
  autoGeneratedNames.set(clientId, name);
  return name;
}

function getPlayerDisplayName(playerData, clientId) {
  return playerData?.username?.trim() || generateAutoUsername(clientId);
}

function setPlayerUsername(clientId, username, markerColor, now) {
  const existing = state.players.get(clientId) || {};
  const finalUsername =
    username?.trim() || existing.username || generateAutoUsername(clientId);
  state.players.set(clientId, {
    ...existing,
    lastPacketAt: now,
    username: finalUsername,
    markerColor:
      typeof markerColor === "string" && markerColor.trim().startsWith("#")
        ? markerColor.trim()
        : existing.markerColor || null,
  });
}

function upsertPlayer(clientId, telemetry, now, username = null) {
  const existing = state.players.get(clientId) || {};
  const finalUsername =
    username?.trim() || existing.username || generateAutoUsername(clientId);
  state.players.set(clientId, {
    ...existing,
    telemetry,
    lastPacketAt: now,
    username: finalUsername,
  });
}

function buildPayload() {
  const now = Date.now();
  const players = [];

  // Build active players list
  for (const [clientId, playerData] of state.players) {
    const connected = now - playerData.lastPacketAt <= CONNECTION_TIMEOUT_MS;
    if (connected) {
      const publicId = getPublicId(clientId);
      players.push({
        clientId: publicId,
        username: getPlayerDisplayName(playerData, clientId),
        markerColor: playerData.markerColor || null,
        telemetry: playerData.telemetry,
        lastPacketAt: playerData.lastPacketAt,
      });
    }
  }

  return {
    players,
    playerCount: players.length,
    packetCount: state.packetCount,
    serverTime: now,
    serverUptime: now - state.serverStartTime,
    udpPort: UDP_PORT,
  };
}

function broadcastPayload() {
  const payload = JSON.stringify(buildPayload());

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

const clients = new Set();
const ingestClients = new Map();

const udpServer = dgram.createSocket("udp4");

udpServer.on("message", (message, remote) => {
  const now = Date.now();
  const clientId = getClientId(remote);
  recordPacket();

  const messageText = message.toString("utf8").trim();
  if (messageText.startsWith("{") && messageText.endsWith("}")) {
    try {
      const parsedMessage = JSON.parse(messageText);

      if (
        parsedMessage?.type === "hello" &&
        typeof parsedMessage.username === "string"
      ) {
        const username = parsedMessage.username.trim();
        const markerColor = parsedMessage.markerColor;
        const existing = state.players.get(clientId);

        setPlayerUsername(clientId, username, markerColor, now);

        const finalUsername = state.players.get(clientId)?.username;
        if (!existing?.username) {
          console.info(
            `UDP client connected from ${remote.address}:${remote.port} as "${finalUsername}"${!username ? " (auto-generated)" : ""}`,
          );
        }

        broadcastPayload();
        return;
      }
    } catch {
      // Fall through to telemetry decoding for any non-JSON packet.
    }
  }

  try {
    const decodedTelemetry = readTelemetryPacket(message);

    // FH can emit all-zero packets while paused/loading. Keep the last valid snapshot.
    if (!isZeroLikeTelemetry(decodedTelemetry)) {
      const existing = state.players.get(clientId);

      if (!existing?.telemetry) {
        const username = existing?.username?.trim() || getPublicId(clientId);
        console.info(
          `Telemetry streaming from ${remote.address}:${remote.port} for "${username}"`,
        );
      }

      upsertPlayer(clientId, decodedTelemetry, now);

      recordCounter++;
      if (recordCounter % 2 === 0) {
        const existing = state.players.get(clientId);
        const name = getPlayerDisplayName(existing, clientId);
        db.record(
          name,
          Number(decodedTelemetry.positionX ?? 0),
          Number(decodedTelemetry.positionZ ?? 0),
          now,
        );
      }
    } else {
      // Update lastPacketAt even for zero-like packets to keep connection alive
      const existing = state.players.get(clientId);
      if (existing) {
        existing.lastPacketAt = now;
      }
    }
  } catch (error) {
    // Keep the previous valid telemetry when a packet cannot be decoded.
    const existing = state.players.get(clientId);
    if (existing) {
      existing.lastPacketAt = now;
    }
  }

  broadcastPayload();
});

udpServer.on("error", (error) => {
  console.error("UDP server error:", error);
});

udpServer.bind(UDP_PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;

  log(`Listening for FH6 telemetry on udp://${HOST}:${UDP_PORT}`);
  log(`Web interface: http://localhost:${PORT}`);
  log("Forza settings -> HUD & Gameplay -> Telemetry:");
  log('  • Enable "Data Out"');
  log(`  • Data Out IP Address: ${displayHost}`);
  log(`  • Data Out Port: ${UDP_PORT}`);
});

const wss = new WebSocketServer({ noServer: true });
const ingestWss = new WebSocketServer({ noServer: true });

const server = http.createServer((request, response) => {
  if (request.url === "/tiles-meta") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": settings.server.cacheControl,
    });
    response.end(JSON.stringify(tileMeta));
    return;
  }

  if (request.url === "/health") {
    const now = Date.now();
    let active = 0;
    for (const p of state.players.values()) {
      if (now - p.lastPacketAt <= CONNECTION_TIMEOUT_MS) active++;
    }
    const uptime = now - state.serverStartTime;
    const health = {
      status: "ok",
      uptime,
      uptimeHuman: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,
      players: {
        total: state.players.size,
        active,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      },
      connections: { ws: clients.size, ingest: ingestClients.size },
      packets: { total: state.packetCount, perSecond: packetsPerSecond() },
      database: db.stats(),
      server: {
        udpPort: UDP_PORT,
        httpPort: PORT,
        startTime: state.serverStartTime,
      },
    };
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(health, null, 2));
    return;
  }

  if (request.url === "/live-data") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": settings.server.cacheControl,
    });
    response.end(JSON.stringify(buildPayload()));
    return;
  }

  if (request.url.startsWith("/api/positions")) {
    const url = new URL(request.url, "http://localhost");
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "10000", 10),
      10000,
    );
    const result = db.query(offset, limit);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(result));
    return;
  }

  const fileUrl = resolveFileUrl(request.url || "/");

  if (!fileUrl || !existsSync(fileUrl)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const extension = extname(fileUrl.pathname).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    const content = readFileSync(fileUrl);

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": settings.server.cacheControl,
    });
    response.end(content);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Server error");
  }
});

server.on("upgrade", (request, socket, head) => {
  if (
    !request.url ||
    (!request.url.startsWith("/ws") && !request.url.startsWith("/client-ws"))
  ) {
    socket.destroy();
    return;
  }

  if (request.url.startsWith("/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }

  ingestWss.handleUpgrade(request, socket, head, (ws) => {
    ingestWss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(buildPayload()));

  ws.on("close", () => {
    clients.delete(ws);
  });
});

ingestWss.on("connection", (ws, request) => {
  const requestUrl = new URL(request.url, "http://localhost");
  const username =
    requestUrl.searchParams.get("username")?.trim() || "Anonymous";
  const clientId = `ingest:${randomUUID()}`;

  ingestClients.set(ws, { clientId, username });
  ws.send(JSON.stringify({ type: "ready", username }));

  ws.on("message", (message) => {
    const now = Date.now();

    try {
      const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
      const decodedTelemetry = readTelemetryPacket(buffer);
      upsertPlayer(clientId, decodedTelemetry, now, username);
      broadcastPayload();
    } catch (error) {
      const existing = state.players.get(clientId);
      if (existing) {
        existing.lastPacketAt = now;
      }
    }
  });

  ws.on("close", () => {
    ingestClients.delete(ws);
    state.players.delete(clientId);
    broadcastPayload();
  });
});

server.listen(PORT, HOST, () => {
  log(`FH6 Live Map Server running on http://${HOST}:${PORT}`);
});

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
