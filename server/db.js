import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'uptime.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode & synchronous = NORMAL
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
} catch (e) {
  console.warn('[DB Pragma Warning]', e.message);
}

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('http', 'ping', 'agent_linux', 'agent_php')) NOT NULL,
    url TEXT,
    keyword TEXT,
    interval_sec INTEGER DEFAULT 60,
    token TEXT UNIQUE,
    active INTEGER DEFAULT 1,
    pushover_priority INTEGER DEFAULT 0,
    group_name TEXT DEFAULT 'Default',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    status INTEGER NOT NULL,
    ping_ms INTEGER DEFAULT 0,
    msg TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hb_monitor_date ON heartbeats(monitor_id, created_at DESC);
`);

// Migrations for existing database instances
try {
  db.exec('ALTER TABLE monitors ADD COLUMN pushover_priority INTEGER DEFAULT 0;');
} catch (e) {}

try {
  db.exec("ALTER TABLE monitors ADD COLUMN group_name TEXT DEFAULT 'Default';");
} catch (e) {}

// Prepared Statements for Monitors
const stmtGetAllMonitors = db.prepare('SELECT * FROM monitors ORDER BY group_name ASC, name ASC');
const stmtGetActiveMonitors = db.prepare('SELECT * FROM monitors WHERE active = 1');
const stmtGetMonitorById = db.prepare('SELECT * FROM monitors WHERE id = ?');
const stmtGetMonitorByToken = db.prepare('SELECT * FROM monitors WHERE token = ?');

const stmtInsertMonitor = db.prepare(`
  INSERT INTO monitors (id, name, type, url, keyword, interval_sec, token, active, pushover_priority, group_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateMonitor = db.prepare(`
  UPDATE monitors
  SET name = ?, type = ?, url = ?, keyword = ?, interval_sec = ?, active = ?, pushover_priority = ?, group_name = ?
  WHERE id = ?
`);

const stmtDeleteMonitor = db.prepare('DELETE FROM monitors WHERE id = ?');
const stmtToggleMonitor = db.prepare('UPDATE monitors SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?');

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

const stmtGetStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as up_count,
    AVG(ping_ms) as avg_ping
  FROM heartbeats
  WHERE monitor_id = ? AND created_at >= datetime('now', '-24 hours')
`);

const stmtCleanupOldHeartbeats = db.prepare(`
  DELETE FROM heartbeats
  WHERE created_at < datetime('now', '-90 days')
`);

// Prepared Statements for Settings
const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtGetAllSettings = db.prepare('SELECT key, value FROM settings');
const stmtSetSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// Settings Helper Functions
export function getSetting(key, defaultValue = '') {
  try {
    const row = stmtGetSetting.get(key);
    return row ? row.value : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

export function getAllSettings() {
  try {
    const rows = stmtGetAllSettings.all();
    const result = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  } catch (e) {
    return {};
  }
}

export function setSetting(key, value) {
  return stmtSetSetting.run(key, String(value));
}

export function setSettings(settingsObj = {}) {
  for (const [k, v] of Object.entries(settingsObj)) {
    setSetting(k, v);
  }
  return getAllSettings();
}

// Monitor Helper Functions
export function getAllMonitors() {
  return stmtGetAllMonitors.all();
}

export function getActiveMonitors() {
  return stmtGetActiveMonitors.all();
}

export function getMonitorById(id) {
  return stmtGetMonitorById.get(id);
}

export function getMonitorByToken(token) {
  if (!token) return null;
  return stmtGetMonitorByToken.get(token);
}

export function createMonitor(data) {
  let priority = data.pushover_priority !== undefined && data.pushover_priority !== null ? Number(data.pushover_priority) : 0;
  if (data.pushover_priority === undefined || data.pushover_priority === null) {
    if (data.type === 'http') priority = 1;
    if (data.type === 'ping' || data.type === 'agent_linux' || data.type === 'agent_php') priority = 2;
  }

  const groupName = data.group_name && data.group_name.trim() ? data.group_name.trim() : 'Default';

  stmtInsertMonitor.run(
    data.id,
    data.name,
    data.type,
    data.url || '',
    data.keyword || '',
    data.interval_sec || 60,
    data.token || null,
    data.active !== undefined ? data.active : 1,
    priority,
    groupName
  );
  return getMonitorById(data.id);
}

export function updateMonitor(data) {
  const groupName = data.group_name && data.group_name.trim() ? data.group_name.trim() : 'Default';

  stmtUpdateMonitor.run(
    data.name,
    data.type,
    data.url || '',
    data.keyword || '',
    data.interval_sec || 60,
    data.active !== undefined ? data.active : 1,
    data.pushover_priority !== undefined ? Number(data.pushover_priority) : 0,
    groupName,
    data.id
  );
  return getMonitorById(data.id);
}

export function deleteMonitor(id) {
  return stmtDeleteMonitor.run(id);
}

export function toggleMonitor(id) {
  stmtToggleMonitor.run(id);
  return getMonitorById(id);
}

export function addHeartbeat(monitorId, status, pingMs = 0, msg = '') {
  const result = stmtInsertHeartbeat.run(monitorId, status, pingMs, msg);
  return {
    id: result.lastInsertRowid,
    monitor_id: monitorId,
    status,
    ping_ms: pingMs,
    msg,
    created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
  };
}

export function getRecentHeartbeats(monitorId, limit = 60) {
  return stmtGetRecentHeartbeats.all(monitorId, limit).reverse();
}

export function getLatestHeartbeat(monitorId) {
  return stmtGetLatestHeartbeat.get(monitorId);
}

export function getMonitorStats(monitorId) {
  const stats = stmtGetStats.get(monitorId);
  const total = stats ? stats.total || 0 : 0;
  const up = stats ? stats.up_count || 0 : 0;
  const uptimePct = total > 0 ? ((up / total) * 100).toFixed(1) : '100.0';
  const avgPing = stats ? Math.round(stats.avg_ping || 0) : 0;
  return { uptimePct, avgPing };
}

export function cleanupOldHeartbeats() {
  try {
    const result = stmtCleanupOldHeartbeats.run();
    console.log(`[DB Cleanup] Pruned ${result.changes} old heartbeats (>90 days).`);
  } catch (err) {
    console.error('[DB Cleanup Error]', err);
  }
}

export default db;
