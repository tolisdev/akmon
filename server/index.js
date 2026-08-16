import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  getAllMonitors,
  getMonitorById,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  toggleMonitor,
  toggleMaintenance,
  toggleVisibility,
  getRecentHeartbeats,
  getLatestHeartbeat,
  getMonitorStats,
  cleanupOldHeartbeats,
  getAllSettings,
  setSettings,
  getSetting,
  deleteHeartbeatsForMonitor,
  getStatusAccessToken,
  regenerateStatusAccessToken,
  getAllStatusPages,
  getStatusPageById,
  createStatusPage,
  deleteStatusPage
} from './db.js';

import { startMonitoringDaemon } from './monitors.js';
import agentRouter from './api/agent.js';
import { sendPushoverNotification } from './pushover.js';
import { getOidcAuthUrl, processOidcCallback } from './oidc.js';
import { createRateLimiter, BruteForceTracker, getClientIp } from './rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Security Rate Limiters & Token Brute-Force Trackers
const globalPublicRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many public status requests. Please slow down.'
});

const tokenBruteForceTracker = new BruteForceTracker({
  maxFails: 10,
  windowMs: 15 * 60 * 1000,
  blockDurationMs: 15 * 60 * 1000
});

const adminAuthBruteForceTracker = new BruteForceTracker({
  maxFails: 5,
  windowMs: 15 * 60 * 1000,
  blockDurationMs: 15 * 60 * 1000
});

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Attach Socket.IO instance to app for routes
app.set('io', io);

// Middleware & Security Headers
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Helper: Constant-time string/buffer comparison
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Serve Agent Scripts
app.get('/agents/agent.sh', (req, res) => {
  const filePath = path.join(__dirname, '../agents/agent.sh');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Agent script not found');
  }
});

app.get('/agents/agent.php', (req, res) => {
  const filePath = path.join(__dirname, '../agents/agent.php');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Agent script not found');
  }
});

// Ingest API
app.use('/api/v1', agentRouter);

// Public Authentication options endpoint for frontend (login page options)
app.get('/api/v1/auth/options', (req, res) => {
  try {
    const passwordAuthEnabled = getSetting('password_auth_enabled', 'true') === 'true';
    const oidcEnabled = getSetting('oidc_enabled', 'true') === 'true';
    const logoUrl = getSetting('logo_url', '');
    res.json({
      password_auth_enabled: passwordAuthEnabled,
      oidc_enabled: oidcEnabled,
      logo_url: logoUrl
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch auth options' });
  }
});

// Authentication Route (Standard Password with 5-Fail Brute-Force Lock)
app.post('/api/v1/auth/login', (req, res) => {
  const clientIp = getClientIp(req);
  if (adminAuthBruteForceTracker.isBlocked(clientIp)) {
    const retrySec = adminAuthBruteForceTracker.getBlockTimeRemainingSec(clientIp);
    res.setHeader('Retry-After', retrySec);
    return res.status(429).json({ ok: false, error: `Account login temporarily blocked due to 5 consecutive failed attempts. Retry in ${retrySec} seconds.` });
  }

  const pwdEnabled = getSetting('password_auth_enabled', process.env.DISABLE_PASSWORD_AUTH === 'true' ? 'false' : 'true') !== 'false';
  if (!pwdEnabled) {
    return res.status(403).json({ ok: false, error: 'Password authentication is disabled by the administrator. Log in with PocketID.' });
  }

  const { password } = req.body || {};
  if (timingSafeEqualStr(password, ADMIN_PASSWORD)) {
    adminAuthBruteForceTracker.reset(clientIp);
    const sessionToken = crypto.createHash('sha256').update(ADMIN_PASSWORD + '_akmon_salt').digest('hex');
    return res.json({ ok: true, token: sessionToken });
  }

  adminAuthBruteForceTracker.recordFail(clientIp);
  return res.status(401).json({ ok: false, error: 'Invalid password' });
});

// OIDC Authentication Routes (PocketID)
app.get('/api/v1/auth/oidc/login', async (req, res) => {
  try {
    const hostHeader = req.headers.host;
    const result = await getOidcAuthUrl(hostHeader);
    if (result.error) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head><title>OIDC Configuration Required</title></head>
          <body style="background:#09090b; color:#f4f4f5; font-family:monospace, sans-serif; display:flex; align-items:center; justify-center; min-height:100vh; margin:0; padding:20px;">
            <div style="max-width:480px; width:100%; background:#18181b; border:1px solid #27272a; padding:24px; border-radius:12px; margin:auto; text-align:center;">
              <h2 style="color:#f43f5e; margin-top:0;">OIDC Not Configured</h2>
              <p style="color:#a1a1aa; font-size:13px; line-height:1.5;">${result.error}</p>
              <a href="/admin" style="display:inline-block; margin-top:16px; padding:8px 16px; background:#10b981; color:#000; font-weight:bold; text-decoration:none; border-radius:6px; font-size:12px;">← Return to Admin Login</a>
            </div>
          </body>
        </html>
      `);
    }
    return res.redirect(result.url);
  } catch (err) {
    return res.status(500).send('OIDC Error');
  }
});

app.get('/api/v1/auth/oidc/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`PocketID OIDC Error: ${error}`);
  }

  try {
    const hostHeader = req.headers.host;
    const { user } = await processOidcCallback(code, hostHeader);

    // Generate valid session token for Admin Dashboard
    const sessionToken = crypto.createHash('sha256').update(ADMIN_PASSWORD + '_akmon_salt').digest('hex');

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>OIDC Login Success</title></head>
        <body style="background:#09090b; color:#fff; font-family:sans-serif; text-align:center; padding-top:50px;">
          <h2>Authenticated via PocketID!</h2>
          <p>Redirecting to Admin Dashboard...</p>
          <script>
            localStorage.setItem('akmon_auth_token', '${sessionToken}');
            window.location.href = '/admin';
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[OIDC Callback Error]', err);
    return res.status(500).send('OIDC Login Failed');
  }
});

// Simple Auth Middleware for Admin APIs with Timing-Safe Token Check
function checkAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const expectedToken = crypto.createHash('sha256').update(ADMIN_PASSWORD + '_akmon_salt').digest('hex');
  const expectedHeader = `Bearer ${expectedToken}`;

  if (timingSafeEqualStr(authHeader, expectedHeader)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// Admin Settings APIs
app.get('/api/v1/settings', checkAdminAuth, (req, res) => {
  try {
    const settings = getAllSettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/settings', checkAdminAuth, (req, res) => {
  try {
    const updated = setSettings(req.body);
    res.json({ settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/notifications/test', checkAdminAuth, async (req, res) => {
  const { type } = req.body;
  const title = `[akMon Test] Alert Notification Check`;
  const message = `This is a test notification triggered from the akMon Admin Dashboard. System working normally.`;

  if (type === 'pushover') {
    const result = await sendPushoverNotification({ title, message, priority: 1 });
    return res.json(result);
  } else if (type === 'email') {
    const result = await sendEmailNotification({ title, message });
    return res.json(result);
  }

  return res.status(400).json({ error: 'Invalid notification type' });
});

// Secret Share Token Endpoints for Private Monitors
app.get('/api/v1/settings/share-token', checkAdminAuth, (req, res) => {
  try {
    const token = getStatusAccessToken();
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch share token' });
  }
});

app.post('/api/v1/settings/share-token/regenerate', checkAdminAuth, (req, res) => {
  try {
    const token = regenerateStatusAccessToken();
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to regenerate share token' });
  }
});

// Admin Custom Status Pages APIs
app.get('/api/v1/status-pages', checkAdminAuth, (req, res) => {
  try {
    const pages = getAllStatusPages();
    res.json({ pages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status pages' });
  }
});

app.post('/api/v1/status-pages', checkAdminAuth, (req, res) => {
  try {
    const { title, monitor_ids } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Page title is required' });
    }
    if (!Array.isArray(monitor_ids) || monitor_ids.length === 0) {
      return res.status(400).json({ error: 'At least one monitor must be selected' });
    }

    const id = crypto.randomBytes(32).toString('hex'); // 64-character token!
    const page = createStatusPage({
      id,
      title: title.trim().substring(0, 100),
      monitor_ids
    });

    res.json({ ok: true, page });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create custom status page' });
  }
});

app.delete('/api/v1/status-pages/:id', checkAdminAuth, (req, res) => {
  try {
    deleteStatusPage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete status page' });
  }
});

// Public Custom Status Page API
app.get('/api/v1/public/status-page/:id', globalPublicRateLimiter, (req, res) => {
  const clientIp = getClientIp(req);
  if (tokenBruteForceTracker.isBlocked(clientIp)) {
    const retrySec = tokenBruteForceTracker.getBlockTimeRemainingSec(clientIp);
    res.setHeader('Retry-After', retrySec);
    return res.status(429).json({ error: `Access blocked due to token brute-force detection. Retry in ${retrySec} seconds.` });
  }

  try {
    const pageToken = req.params.id || '';
    const page = getStatusPageById(pageToken);
    if (!page) {
      tokenBruteForceTracker.recordFail(clientIp);
      return res.status(404).json({ error: 'Custom status page not found or link expired' });
    }

    tokenBruteForceTracker.reset(clientIp);

    const allowedIds = new Set(page.monitor_ids || []);
    const monitors = getAllMonitors().filter((m) => (m.active === 1 || m.active === 2) && allowedIds.has(m.id));

    const publicData = monitors.map((m) => {
      const isMaintenance = m.active === 2;
      const latest = getLatestHeartbeat(m.id);
      const recent = getRecentHeartbeats(m.id, 60);
      const stats = getMonitorStats(m.id);

      const segments = [];
      const totalDesired = 60;
      const missingCount = totalDesired - recent.length;

      for (let i = 0; i < missingCount; i++) {
        segments.push({ status: -1, ping_ms: 0, time: null });
      }

      for (let i = 0; i < recent.length; i++) {
        segments.push({
          status: recent[i].status,
          ping_ms: recent[i].ping_ms,
          time: recent[i].created_at
        });
      }

      return {
        id: m.id,
        name: m.name,
        type: m.type,
        group_name: m.group_name || 'Default',
        url: m.url,
        ssl_days: m.ssl_days,
        ssl_issuer: m.ssl_issuer,
        in_maintenance: isMaintenance,
        status: isMaintenance ? 3 : (latest ? latest.status : 0),
        ping_ms: latest ? latest.ping_ms : 0,
        last_check: latest ? latest.created_at : null,
        uptime_pct: stats.uptimePct,
        segments
      };
    });

    const logoUrl = getSetting('logo_url', '');
    res.json({
      id: page.id,
      title: page.title,
      logo_url: logoUrl,
      monitors: publicData
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status page data' });
  }
});

// Public Status API (Sanitized & Grouped - 60 segment chronological order)
app.get('/api/v1/public/status', globalPublicRateLimiter, (req, res) => {
  const clientIp = getClientIp(req);
  if (tokenBruteForceTracker.isBlocked(clientIp)) {
    const retrySec = tokenBruteForceTracker.getBlockTimeRemainingSec(clientIp);
    res.setHeader('Retry-After', retrySec);
    return res.status(429).json({ error: `Access blocked due to secret token brute-force detection. Retry in ${retrySec} seconds.` });
  }

  try {
    const requestToken = req.query.token || '';
    const statusAccessToken = getStatusAccessToken();
    const isSecretTokenValid = timingSafeEqualStr(requestToken, statusAccessToken);

    if (requestToken && !isSecretTokenValid) {
      tokenBruteForceTracker.recordFail(clientIp);
    } else if (requestToken && isSecretTokenValid) {
      tokenBruteForceTracker.reset(clientIp);
    }

    const monitors = getAllMonitors().filter((m) => {
      if (m.active !== 1 && m.active !== 2) return false;
      if (isSecretTokenValid) return true; // Secret token unlocks private monitors!
      return m.is_public !== 0;
    });
    const publicData = monitors.map((m) => {
      const isMaintenance = m.active === 2;
      const latest = getLatestHeartbeat(m.id);
      const recent = getRecentHeartbeats(m.id, 60); // returns oldest first (chronological)
      const stats = getMonitorStats(m.id);

      const segments = [];
      const totalDesired = 60;
      const missingCount = totalDesired - recent.length;

      // Fill missing slots on the left with gray placeholders
      for (let i = 0; i < missingCount; i++) {
        segments.push({ status: -1, ping_ms: 0, time: null });
      }

      // Append actual heartbeats in chronological order (oldest to newest on the right)
      for (let i = 0; i < recent.length; i++) {
        segments.push({
          status: recent[i].status,
          ping_ms: recent[i].ping_ms,
          time: recent[i].created_at
        });
      }

      return {
        id: m.id,
        name: m.name,
        type: m.type,
        group_name: m.group_name || 'Default',
        status: isMaintenance ? 3 : (latest ? latest.status : 1),
        in_maintenance: isMaintenance,
        ping_ms: isMaintenance ? 0 : (latest ? latest.ping_ms : 0),
        last_check: latest ? latest.created_at : null,
        uptime_pct: stats.uptimePct,
        avg_ping: stats.avgPing,
        ssl_days: m.ssl_days,
        ssl_issuer: m.ssl_issuer,
        segments
      };
    });

    const logoUrl = getSetting('logo_url', '');
    res.json({ monitors: publicData, logo_url: logoUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin REST APIs
app.get('/api/v1/monitors', checkAdminAuth, (req, res) => {
  try {
    const monitors = getAllMonitors();
    const result = monitors.map((m) => {
      const latest = getLatestHeartbeat(m.id);
      const recent = getRecentHeartbeats(m.id, 60);
      const stats = getMonitorStats(m.id);

      let agentMetrics = null;
      if (latest && (m.type === 'agent_linux' || m.type === 'agent_php')) {
        try {
          agentMetrics = JSON.parse(latest.msg);
        } catch (e) {
          agentMetrics = null;
        }
      }

      return {
        ...m,
        latest_status: latest ? latest.status : null,
        latest_ping: latest ? latest.ping_ms : null,
        latest_msg: latest ? latest.msg : null,
        last_check: latest ? latest.created_at : null,
        uptime_pct: stats.uptimePct,
        avg_ping: stats.avgPing,
        agent_metrics: agentMetrics,
        recent_heartbeats: recent
      };
    });
    res.json({ monitors: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VALID_MONITOR_TYPES = ['http', 'ping', 'agent_linux', 'agent_php'];

function validateMonitorInput({ name, type, url, interval_sec, max_retries }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return 'Name is required';
  }
  if (name.length > 100) {
    return 'Name must not exceed 100 characters';
  }
  if (!type || !VALID_MONITOR_TYPES.includes(type)) {
    return `Invalid monitor type. Allowed: ${VALID_MONITOR_TYPES.join(', ')}`;
  }
  if (type === 'http' || type === 'ping') {
    if (!url || typeof url !== 'string' || !url.trim()) {
      return 'URL or hostname is required for HTTP/Ping monitors';
    }
    if (type === 'http') {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return 'HTTP monitor URL must start with http:// or https://';
        }
      } catch (e) {
        return 'Invalid HTTP URL format';
      }
    }
  }
  if (interval_sec !== undefined && interval_sec !== null) {
    const parsedInterval = parseInt(interval_sec, 10);
    if (isNaN(parsedInterval) || parsedInterval < 5 || parsedInterval > 86400) {
      return 'Interval must be between 5 and 86400 seconds';
    }
  }
  if (max_retries !== undefined && max_retries !== null) {
    const parsedRetries = parseInt(max_retries, 10);
    if (isNaN(parsedRetries) || parsedRetries < 1 || parsedRetries > 20) {
      return 'Max retries must be between 1 and 20';
    }
  }
  return null;
}

app.post('/api/v1/monitors', checkAdminAuth, (req, res) => {
  try {
    const { name, type, url, keyword, interval_sec, max_retries, pushover_priority, group_name, is_public } = req.body || {};
    
    const validationError = validateMonitorInput({ name, type, url, interval_sec, max_retries });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const id = crypto.randomUUID();
    let token = null;
    if (type === 'agent_linux' || type === 'agent_php') {
      token = crypto.randomBytes(16).toString('hex');
    }

    const cleanName = name.trim();
    const cleanGroup = typeof group_name === 'string' && group_name.trim() ? group_name.trim().substring(0, 50) : 'Default';
    const cleanKeyword = typeof keyword === 'string' ? keyword.substring(0, 100) : '';

    const newMonitor = createMonitor({
      id,
      name: cleanName,
      type,
      url: (url || '').trim(),
      keyword: cleanKeyword,
      interval_sec: parseInt(interval_sec, 10) || 60,
      max_retries: max_retries !== undefined ? parseInt(max_retries, 10) : 3,
      token,
      active: 1,
      pushover_priority: pushover_priority !== undefined ? parseInt(pushover_priority, 10) : (type === 'http' ? 1 : 2),
      group_name: cleanGroup,
      is_public: is_public !== undefined ? (is_public ? 1 : 0) : 1
    });

    res.json({ monitor: newMonitor });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create monitor' });
  }
});

app.put('/api/v1/monitors/:id', checkAdminAuth, (req, res) => {
  try {
    const { name, type, url, keyword, interval_sec, max_retries, active, pushover_priority, group_name, is_public } = req.body || {};
    
    const validationError = validateMonitorInput({ name, type, url, interval_sec, max_retries });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const cleanName = name.trim();
    const cleanGroup = typeof group_name === 'string' && group_name.trim() ? group_name.trim().substring(0, 50) : 'Default';
    const cleanKeyword = typeof keyword === 'string' ? keyword.substring(0, 100) : '';

    const updated = updateMonitor({
      id: req.params.id,
      name: cleanName,
      type,
      url: (url || '').trim(),
      keyword: cleanKeyword,
      interval_sec: parseInt(interval_sec, 10) || 60,
      max_retries: max_retries !== undefined ? parseInt(max_retries, 10) : 3,
      active: active !== undefined ? (active ? 1 : 0) : 1,
      pushover_priority: pushover_priority !== undefined ? parseInt(pushover_priority, 10) : 0,
      group_name: cleanGroup,
      is_public: is_public !== undefined ? (is_public ? 1 : 0) : 1
    });
    res.json({ monitor: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update monitor' });
  }
});

app.post('/api/v1/monitors/:id/toggle', checkAdminAuth, (req, res) => {
  try {
    const updated = toggleMonitor(req.params.id);
    res.json({ monitor: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/monitors/:id/maintenance', checkAdminAuth, (req, res) => {
  try {
    const updated = toggleMaintenance(req.params.id);
    res.json({ monitor: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/monitors/:id/visibility', checkAdminAuth, (req, res) => {
  try {
    const updated = toggleVisibility(req.params.id);
    res.json({ monitor: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/v1/monitors/:id/history', checkAdminAuth, (req, res) => {
  try {
    deleteHeartbeatsForMonitor(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/v1/monitors/:id', checkAdminAuth, (req, res) => {
  try {
    deleteMonitor(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO Real-time Connection Setup
io.on('connection', (socket) => {
  try {
    const activeMonitors = getAllMonitors().filter((m) => m.active === 1);
    const initialList = activeMonitors.map((m) => {
      const latest = getLatestHeartbeat(m.id);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        group_name: m.group_name || 'Default',
        status: latest ? latest.status : 1,
        ping_ms: latest ? latest.ping_ms : 0
      };
    });
    socket.emit('init', { monitors: initialList });
  } catch (e) {
    console.error('Socket init error:', e);
  }
});

// SvelteKit Handler Integration for Production Build
const buildHandlerPath = path.join(__dirname, '../build/handler.js');
if (fs.existsSync(buildHandlerPath)) {
  console.log('[Server] Loading SvelteKit production build handler...');
  const { handler } = await import(pathToFileURL(buildHandlerPath).href);
  app.use(handler);
} else {
  console.log('[Server] SvelteKit build handler not found. Run `npm run build` for production frontend.');
}

// Start HTTP Server
httpServer.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`  akMon Uptime & Agent Monitoring System`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  Admin Password default: ${ADMIN_PASSWORD}`);
  console.log(`=================================================`);

  // Start Daemon and Daily Cleanup
  startMonitoringDaemon(io);
  cleanupOldHeartbeats();
  setInterval(cleanupOldHeartbeats, 24 * 60 * 60 * 1000);
});
