import { DatabaseSync } from "node:sqlite";

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
  const countStmt = db.prepare("SELECT COUNT(*) AS total FROM positions");
  const queryStmt = db.prepare(
    "SELECT id, player, ts, x, z, weight FROM positions ORDER BY id LIMIT ? OFFSET ?",
  );

  flushTimer = setInterval(() => flush(insertPos), FLUSH_INTERVAL);

  return {
    record(player, x, z, ts) {
      buffers.push([player, ts, x, z, 1]);
    },
    query(offset, limit) {
      const { total } = countStmt.get();
      const rows = queryStmt.all(limit, offset);
      return { total, rows, hasMore: offset + rows.length < total };
    },
    stats() {
      const r = countStmt.get();
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
