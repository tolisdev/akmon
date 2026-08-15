import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'uptime.db');
const db = new DatabaseSync(dbPath);

// Enable Write-Ahead Logging (WAL) & NORMAL synchronous mode for high performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'http', 'ping', 'agent_linux', 'agent_php'
    group_name TEXT DEFAULT 'Default',
    url TEXT,
    keyword TEXT,
    interval_sec INTEGER DEFAULT 60,
    token TEXT UNIQUE,
    active INTEGER DEFAULT 1,
    pushover_priority INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    status INTEGER NOT NULL, -- 1: UP, 0: DOWN, 2: DEGRADED
    ping_ms INTEGER DEFAULT 0,
    msg TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_hb_monitor_date ON heartbeats(monitor_id, created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('password_auth_enabled', 'true'),
    ('pushover_enabled', 'true'),
    ('smtp_enabled', 'false'),
    ('oidc_enabled', 'false');
`);

// Migration helper for existing DBs
try {
  const columns = db.prepare("PRAGMA table_info(monitors);").all();
  const hasGroup = columns.some((col) => col.name === 'group_name');
  if (!hasGroup) {
    db.exec("ALTER TABLE monitors ADD COLUMN group_name TEXT DEFAULT 'Default';");
  }
} catch (e) {
  // Ignore migration errors
}

// Prepared Statements for Monitors
const stmtGetAllMonitors = db.prepare('SELECT * FROM monitors ORDER BY name ASC');
const stmtGetMonitorById = db.prepare('SELECT * FROM monitors WHERE id = ?');
const stmtGetMonitorByToken = db.prepare('SELECT * FROM monitors WHERE token = ?');
const stmtInsertMonitor = db.prepare(`
  INSERT INTO monitors (id, name, type, group_name, url, keyword, interval_sec, token, active, pushover_priority)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateMonitor = db.prepare(`
  UPDATE monitors
  SET name = ?, type = ?, group_name = ?, url = ?, keyword = ?, interval_sec = ?, active = ?, pushover_priority = ?
  WHERE id = ?
`);
const stmtToggleMonitor = db.prepare(`
  UPDATE monitors SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?
`);
const stmtDeleteMonitor = db.prepare('DELETE FROM monitors WHERE id = ?');

// Prepared Statements for Heartbeats
const stmtInsertHeartbeat = db.prepare(`
  INSERT INTO heartbeats (monitor_id, status, ping_ms, msg)
  VALUES (?, ?, ?, ?)
`);
const stmtGetRecentHeartbeats = db.prepare(`
  SELECT id, monitor_id, status, ping_ms, msg, created_at
  FROM heartbeats
  WHERE monitor_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const stmtGetLatestHeartbeat = db.prepare(`
  SELECT id, monitor_id, status, ping_ms, msg, created_at
  FROM heartbeats
  WHERE monitor_id = ?
  ORDER BY created_at DESC
  LIMIT 1
`);
const stmtDeleteHeartbeatsByMonitor = db.prepare(`
  DELETE FROM heartbeats WHERE monitor_id = ?
`);
const stmtPruneOldHeartbeats = db.prepare(`
  DELETE FROM heartbeats WHERE created_at < datetime('now', '-90 days')
`);

const stmtStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as up_count,
    AVG(CASE WHEN ping_ms > 0 THEN ping_ms ELSE NULL END) as avg_ping
  FROM heartbeats
  WHERE monitor_id = ?
`);

// Prepared Statements for Settings
const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtGetAllSettings = db.prepare('SELECT key, value FROM settings');
const stmtSetSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// Exported Database Functions
export function getAllMonitors() {
  return stmtGetAllMonitors.all();
}

export function getMonitorById(id) {
  return stmtGetMonitorById.get(id);
}

export function getMonitorByToken(token) {
  return stmtGetMonitorByToken.get(token);
}

export function createMonitor(data) {
  stmtInsertMonitor.run(
    data.id,
    data.name,
    data.type,
    data.group_name || 'Default',
    data.url || '',
    data.keyword || '',
    data.interval_sec || 60,
    data.token || null,
    data.active !== undefined ? data.active : 1,
    data.pushover_priority !== undefined ? data.pushover_priority : 1
  );
  return getMonitorById(data.id);
}

export function updateMonitor(data) {
  stmtUpdateMonitor.run(
    data.name,
    data.type,
    data.group_name || 'Default',
    data.url || '',
    data.keyword || '',
    data.interval_sec || 60,
    data.active !== undefined ? data.active : 1,
    data.pushover_priority !== undefined ? data.pushover_priority : 1,
    data.id
  );
  return getMonitorById(data.id);
}

export function toggleMonitor(id) {
  stmtToggleMonitor.run(id);
  return getMonitorById(id);
}

export function deleteMonitor(id) {
  return stmtDeleteMonitor.run(id);
}

export function insertHeartbeat(data) {
  return stmtInsertHeartbeat.run(
    data.monitor_id,
    data.status,
    data.ping_ms || 0,
    data.msg || ''
  );
}

export function getRecentHeartbeats(monitorId, limit = 60) {
  return stmtGetRecentHeartbeats.all(monitorId, limit).reverse();
}

export function getLatestHeartbeat(monitorId) {
  return stmtGetLatestHeartbeat.get(monitorId);
}

export function deleteHeartbeatsForMonitor(monitorId) {
  return stmtDeleteHeartbeatsByMonitor.run(monitorId);
}

export function getMonitorStats(monitorId) {
  const row = stmtStats.get(monitorId);
  const total = row ? row.total : 0;
  const upCount = row ? row.up_count : 0;
  const uptimePct = total > 0 ? Number(Math.round((upCount / total) * 100 + 'e1') + 'e-1') : 100;
  const avgPing = row && row.avg_ping ? Math.round(row.avg_ping) : 0;

  return { uptimePct, avgPing };
}

export function cleanupOldHeartbeats() {
  const result = stmtPruneOldHeartbeats.run();
  if (result.changes > 0) {
    console.log(`[DB Cleanup] Pruned ${result.changes} old heartbeats (>90 days).`);
  }
}

export function getSetting(key, defaultValue = '') {
  const row = stmtGetSetting.get(key);
  return row ? row.value : defaultValue;
}

export function getAllSettings() {
  const rows = stmtGetAllSettings.all();
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

export function setSettings(settingsMap) {
  for (const [key, value] of Object.entries(settingsMap)) {
    stmtSetSetting.run(key, String(value));
  }
  return getAllSettings();
}
