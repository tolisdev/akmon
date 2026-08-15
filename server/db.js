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

// Initialize Tables with explicit ISO 8601 UTC timestamp format
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
    is_public INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    status INTEGER NOT NULL, -- 1: UP, 0: DOWN, 2: DEGRADED
    ping_ms INTEGER DEFAULT 0,
    msg TEXT,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
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
    ('pushover_sound_down', 'siren'),
    ('pushover_sound_up', 'magic'),
    ('smtp_enabled', 'false'),
    ('oidc_enabled', 'false'),
    ('logo_url', '');
`);

// Migration helper for existing DBs
try {
  const columns = db.prepare("PRAGMA table_info(monitors);").all();
  const hasGroup = columns.some((col) => col.name === 'group_name');
  if (!hasGroup) {
    db.exec("ALTER TABLE monitors ADD COLUMN group_name TEXT DEFAULT 'Default';");
  }
  const hasIsPublic = columns.some((col) => col.name === 'is_public');
  if (!hasIsPublic) {
    db.exec("ALTER TABLE monitors ADD COLUMN is_public INTEGER DEFAULT 1;");
  }
  const hasSslDays = columns.some((col) => col.name === 'ssl_days');
  if (!hasSslDays) {
    db.exec("ALTER TABLE monitors ADD COLUMN ssl_days INTEGER;");
  }
  const hasSslIssuer = columns.some((col) => col.name === 'ssl_issuer');
  if (!hasSslIssuer) {
    db.exec("ALTER TABLE monitors ADD COLUMN ssl_issuer TEXT;");
  }
} catch (e) {
  // Ignore migration errors
}

// Helper to format any SQLite timestamp as clean ISO 8601 UTC string
export function formatUtcIso(dateStr) {
  if (!dateStr) return null;
  let str = String(dateStr).trim();
  if (str.endsWith('Z') || str.includes('+')) {
    return new Date(str).toISOString();
  }
  // Convert SQLite "YYYY-MM-DD HH:MM:SS" to ISO UTC "YYYY-MM-DDTHH:MM:SS.000Z"
  str = str.replace(' ', 'T') + 'Z';
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date(dateStr).toISOString() : d.toISOString();
}

// Prepared Statements for Monitors
const stmtGetAllMonitors = db.prepare('SELECT * FROM monitors ORDER BY name ASC');
const stmtGetMonitorById = db.prepare('SELECT * FROM monitors WHERE id = ?');
const stmtGetMonitorByToken = db.prepare('SELECT * FROM monitors WHERE token = ?');
const stmtInsertMonitor = db.prepare(`
  INSERT INTO monitors (id, name, type, group_name, url, keyword, interval_sec, token, active, pushover_priority, is_public, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
`);
const stmtUpdateMonitor = db.prepare(`
  UPDATE monitors
  SET name = ?, type = ?, group_name = ?, url = ?, keyword = ?, interval_sec = ?, active = ?, pushover_priority = ?, is_public = ?
  WHERE id = ?
`);
const stmtToggleMonitor = db.prepare(`
  UPDATE monitors SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?
`);
const stmtToggleMaintenance = db.prepare(`
  UPDATE monitors SET active = CASE WHEN active = 2 THEN 1 ELSE 2 END WHERE id = ?
`);
const stmtToggleVisibility = db.prepare(`
  UPDATE monitors SET is_public = CASE WHEN is_public = 1 THEN 0 ELSE 1 END WHERE id = ?
`);
const stmtUpdateMonitorSsl = db.prepare(`
  UPDATE monitors SET ssl_days = ?, ssl_issuer = ? WHERE id = ?
`);
const stmtDeleteMonitor = db.prepare('DELETE FROM monitors WHERE id = ?');

// Prepared Statements for Heartbeats
const stmtInsertHeartbeat = db.prepare(`
  INSERT INTO heartbeats (monitor_id, status, ping_ms, msg, created_at)
  VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
`);
const stmtGetRecentHeartbeats = db.prepare(`
  SELECT * FROM (
    SELECT * FROM heartbeats
    WHERE monitor_id = ?
    ORDER BY id DESC
    LIMIT ?
  ) ORDER BY id ASC
`);
const stmtGetLatestHeartbeat = db.prepare(`
  SELECT * FROM heartbeats
  WHERE monitor_id = ?
  ORDER BY id DESC
  LIMIT 1
`);
const stmtGetMonitorStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as up_count,
    AVG(CASE WHEN status = 1 THEN ping_ms ELSE NULL END) as avg_ping
  FROM heartbeats
  WHERE monitor_id = ?
`);
const stmtCleanupOldHeartbeats = db.prepare(`
  DELETE FROM heartbeats
  WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')
`);
const stmtDeleteHeartbeatsForMonitor = db.prepare(`
  DELETE FROM heartbeats
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
  return stmtGetAllMonitors.all().map((m) => ({
    ...m,
    created_at: formatUtcIso(m.created_at)
  }));
}

export function getMonitorById(id) {
  const m = stmtGetMonitorById.get(id);
  return m ? { ...m, created_at: formatUtcIso(m.created_at) } : null;
}

export function getMonitorByToken(token) {
  const m = stmtGetMonitorByToken.get(token);
  return m ? { ...m, created_at: formatUtcIso(m.created_at) } : null;
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
    data.pushover_priority !== undefined ? data.pushover_priority : 1,
    data.is_public !== undefined ? (data.is_public ? 1 : 0) : 1
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
    data.is_public !== undefined ? (data.is_public ? 1 : 0) : 1,
    data.id
  );
  return getMonitorById(data.id);
}

export function toggleMonitor(id) {
  stmtToggleMonitor.run(id);
  return getMonitorById(id);
}

export function toggleMaintenance(id) {
  stmtToggleMaintenance.run(id);
  return getMonitorById(id);
}

export function toggleVisibility(id) {
  stmtToggleVisibility.run(id);
  return getMonitorById(id);
}

export function updateMonitorSsl(id, sslDays, sslIssuer) {
  stmtUpdateMonitorSsl.run(sslDays !== undefined ? sslDays : null, sslIssuer || null, id);
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
  return stmtGetRecentHeartbeats.all(monitorId, limit).map((hb) => ({
    ...hb,
    created_at: formatUtcIso(hb.created_at)
  }));
}

export function getLatestHeartbeat(monitorId) {
  const hb = stmtGetLatestHeartbeat.get(monitorId);
  return hb ? { ...hb, created_at: formatUtcIso(hb.created_at) } : null;
}

export function getMonitorStats(monitorId) {
  const row = stmtGetMonitorStats.get(monitorId);
  if (!row || row.total === 0) {
    return { uptimePct: 100, avgPing: 0 };
  }
  const uptimePct = Math.round((row.up_count / row.total) * 1000) / 10;
  const avgPing = Math.round(row.avg_ping || 0);
  return { uptimePct, avgPing };
}

export function cleanupOldHeartbeats() {
  return stmtCleanupOldHeartbeats.run();
}

export function deleteHeartbeatsForMonitor(monitorId) {
  return stmtDeleteHeartbeatsForMonitor.run(monitorId);
}

export function getSetting(key, defaultValue = '') {
  const row = stmtGetSetting.get(key);
  return row ? row.value : defaultValue;
}

export function getAllSettings() {
  const rows = stmtGetAllSettings.all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

export function setSettings(settingsObj) {
  for (const [key, value] of Object.entries(settingsObj)) {
    stmtSetSetting.run(key, String(value));
  }
}

export function getStatusAccessToken() {
  let token = getSetting('status_access_token');
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    setSettings({ status_access_token: token });
  }
  return token;
}

export function regenerateStatusAccessToken() {
  const newToken = crypto.randomBytes(32).toString('hex');
  setSettings({ status_access_token: newToken });
  return newToken;
}
