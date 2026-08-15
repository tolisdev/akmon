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
  getRecentHeartbeats,
  getLatestHeartbeat,
  getMonitorStats,
  cleanupOldHeartbeats,
  getAllSettings,
  setSettings,
  getSetting
} from './db.js';

import { startMonitoringDaemon } from './monitors.js';
import agentRouter from './api/agent.js';
import { sendPushoverNotification } from './pushover.js';
import { sendEmailNotification } from './email.js';
import { getOidcAuthUrl, processOidcCallback } from './oidc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Public Auth Configuration Options (Unprotected)
app.get('/api/v1/auth/options', (req, res) => {
  const pwdEnabled = getSetting('password_auth_enabled', process.env.DISABLE_PASSWORD_AUTH === 'true' ? 'false' : 'true') !== 'false';
  const oidcEnabled = getSetting('oidc_enabled', process.env.OIDC_ENABLED || 'false') === 'true';
  res.json({ password_auth_enabled: pwdEnabled, oidc_enabled: oidcEnabled });
});

// Authentication Route (Standard Password)
app.post('/api/v1/auth/login', (req, res) => {
  const pwdEnabled = getSetting('password_auth_enabled', process.env.DISABLE_PASSWORD_AUTH === 'true' ? 'false' : 'true') !== 'false';
  if (!pwdEnabled) {
    return res.status(403).json({ ok: false, error: 'Password authentication is disabled by the administrator. Log in with PocketID.' });
  }

  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const sessionToken = crypto.createHash('sha256').update(ADMIN_PASSWORD + '_akmon_salt').digest('hex');
    return res.json({ ok: true, token: sessionToken });
  }
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
          <body style="background:#09090b; color:#f4f4f5; font-family:monospace, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px;">
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
    return res.status(500).send('OIDC Error: ' + err.message);
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
    return res.status(500).send('OIDC Login Failed: ' + err.message);
  }
});

// Simple Auth Middleware for Admin APIs
function checkAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const expectedToken = crypto.createHash('sha256').update(ADMIN_PASSWORD + '_akmon_salt').digest('hex');
  if (authHeader === `Bearer ${expectedToken}`) {
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

// Public Status API (Sanitized & Grouped)
app.get('/api/v1/public/status', (req, res) => {
  try {
    const monitors = getAllMonitors().filter((m) => m.active === 1);
    const publicData = monitors.map((m) => {
      const latest = getLatestHeartbeat(m.id);
      const recent = getRecentHeartbeats(m.id, 60);
      const stats = getMonitorStats(m.id);

      const segments = [];
      const totalDesired = 60;
      for (let i = 0; i < totalDesired; i++) {
        if (i < recent.length) {
          segments.push({
            status: recent[i].status,
            ping_ms: recent[i].ping_ms,
            time: recent[i].created_at
          });
        } else {
          segments.push({ status: -1, ping_ms: 0, time: null });
        }
      }

      return {
        id: m.id,
        name: m.name,
        type: m.type,
        group_name: m.group_name || 'Default',
        status: latest ? latest.status : 1,
        ping_ms: latest ? latest.ping_ms : 0,
        last_check: latest ? latest.created_at : null,
        uptime_pct: stats.uptimePct,
        avg_ping: stats.avgPing,
        segments: segments.reverse()
      };
    });

    res.json({ monitors: publicData });
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

app.post('/api/v1/monitors', checkAdminAuth, (req, res) => {
  try {
    const { name, type, url, keyword, interval_sec, pushover_priority, group_name } = req.body;
    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }

    const id = crypto.randomUUID();
    let token = null;
    if (type === 'agent_linux' || type === 'agent_php') {
      token = crypto.randomBytes(16).toString('hex');
    }

    const newMonitor = createMonitor({
      id,
      name,
      type,
      url: url || '',
      keyword: keyword || '',
      interval_sec: parseInt(interval_sec, 10) || 60,
      token,
      active: 1,
      pushover_priority: pushover_priority !== undefined ? parseInt(pushover_priority, 10) : (type === 'http' ? 1 : 2),
      group_name: group_name || 'Default'
    });

    res.json({ monitor: newMonitor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/v1/monitors/:id', checkAdminAuth, (req, res) => {
  try {
    const { name, type, url, keyword, interval_sec, active, pushover_priority, group_name } = req.body;
    const updated = updateMonitor({
      id: req.params.id,
      name,
      type,
      url: url || '',
      keyword: keyword || '',
      interval_sec: parseInt(interval_sec, 10) || 60,
      active: active !== undefined ? (active ? 1 : 0) : 1,
      pushover_priority: pushover_priority !== undefined ? parseInt(pushover_priority, 10) : 0,
      group_name: group_name || 'Default'
    });
    res.json({ monitor: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
