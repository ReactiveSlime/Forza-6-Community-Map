import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const FLUSH_INTERVAL = 3000;
let db = null;
let flushTimer = null;
const buffers = [];

export function initDb(path) {
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player TEXT NOT NULL,
    ts INTEGER NOT NULL,
    x REAL NOT NULL,
    z REAL NOT NULL,
    weight REAL NOT NULL DEFAULT 1
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_ts ON positions(ts)`);

  const insertPos = db.prepare(
    "INSERT INTO positions (player, ts, x, z, weight) VALUES (?, ?, ?, ?, ?)",
  );

  flushTimer = setInterval(() => flush(insertPos), FLUSH_INTERVAL);

  return {
    record(player, x, z, ts) {
      buffers.push([player, ts, x, z, 1]);
    },
    getHeatmap(from, to) {
      return db
        .prepare(
          `SELECT ROUND(x * 2, 0) / 2 AS x, ROUND(z * 2, 0) / 2 AS z, COUNT(*) AS weight
           FROM positions WHERE ts >= ? AND ts <= ?
           GROUP BY ROUND(x * 2, 0) / 2, ROUND(z * 2, 0) / 2
           ORDER BY weight DESC`,
        )
        .all(from, to);
    },

    getAllRecords() {
      return db.prepare("SELECT x, z, ts FROM positions ORDER BY ts").all();
    },

    stats() {
      const r = db.prepare("SELECT COUNT(*) AS total FROM positions").get();
      return { total: r.total, bufferSize: buffers.length };
    },
    close() {
      clearInterval(flushTimer);
      flush(insertPos);
      db.close();
    },
  };
}

function flush(insertPos) {
  if (buffers.length === 0) return;
  const tx = db.prepare("BEGIN");
  tx.run();
  try {
    for (const row of buffers) insertPos.run(...row);
    db.prepare("COMMIT").run();
  } catch {
    db.prepare("ROLLBACK").run();
  }
  buffers.length = 0;
}
