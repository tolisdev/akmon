import express from 'express';
import { getMonitorByToken, insertHeartbeat, getLatestHeartbeat } from '../db.js';
import { createRateLimiter, BruteForceTracker, getClientIp } from '../rateLimiter.js';

const router = express.Router();

const agentRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many agent pushes from this IP, rate limit exceeded.'
});

const agentBruteForceTracker = new BruteForceTracker({
  maxFails: 15,
  windowMs: 15 * 60 * 1000,
  blockDurationMs: 15 * 60 * 1000
});

// Agent Telemetry Ingestion Endpoint
router.post('/agent', agentRateLimiter, async (req, res) => {
  const clientIp = getClientIp(req);
  if (agentBruteForceTracker.isBlocked(clientIp)) {
    const retrySec = agentBruteForceTracker.getBlockTimeRemainingSec(clientIp);
    res.setHeader('Retry-After', retrySec);
    return res.status(429).json({ error: `Access blocked due to invalid agent token brute-force detection. Retry in ${retrySec} seconds.` });
  }

  try {
    const {
      token,
      load,
      ram_used,
      ram_total,
      swap_used,
      swap_total,
      disk_pct,
      net_rx_kbps,
      net_tx_kbps,
      cpu_user,
      cpu_system,
      cpu_idle,
      cpu_iowait,
      cpu_steal,
      php_ver,
      php_memory,
      os_info
    } = req.body || {};

    if (!token) {
      agentBruteForceTracker.recordFail(clientIp);
      return res.status(400).json({ error: 'Token is required' });
    }

    const monitor = getMonitorByToken(token);
    if (!monitor) {
      agentBruteForceTracker.recordFail(clientIp);
      return res.status(404).json({ error: 'Invalid or unregistered agent token' });
    }

    agentBruteForceTracker.reset(clientIp);

    const previous = getLatestHeartbeat(monitor.id);
    const previousStatus = previous ? previous.status : null;

    // Validate and sanitize metrics
    const safeLoad = Array.isArray(load) ? load.slice(0, 3).map((n) => (typeof n === 'number' && isFinite(n) ? n : 0)) : [0, 0, 0];
    while (safeLoad.length < 3) safeLoad.push(0);

    const safeRamUsed = typeof ram_used === 'number' && isFinite(ram_used) ? Math.max(0, ram_used) : 0;
    const safeRamTotal = typeof ram_total === 'number' && isFinite(ram_total) ? Math.max(0, ram_total) : 0;
    const safeSwapUsed = typeof swap_used === 'number' && isFinite(swap_used) ? Math.max(0, swap_used) : 0;
    const safeSwapTotal = typeof swap_total === 'number' && isFinite(swap_total) ? Math.max(0, swap_total) : 0;
    const safeDiskPct = typeof disk_pct === 'number' && isFinite(disk_pct) ? Math.min(100, Math.max(0, disk_pct)) : 0;

    const safeNetRxKbps = typeof net_rx_kbps === 'number' && isFinite(net_rx_kbps) ? Math.max(0, net_rx_kbps) : 0;
    const safeNetTxKbps = typeof net_tx_kbps === 'number' && isFinite(net_tx_kbps) ? Math.max(0, net_tx_kbps) : 0;
    
    const safeCpuUser = typeof cpu_user === 'number' && isFinite(cpu_user) ? Math.min(100, Math.max(0, cpu_user)) : 0;
    const safeCpuSystem = typeof cpu_system === 'number' && isFinite(cpu_system) ? Math.min(100, Math.max(0, cpu_system)) : 0;
    const safeCpuIdle = typeof cpu_idle === 'number' && isFinite(cpu_idle) ? Math.min(100, Math.max(0, cpu_idle)) : 100;
    const safeCpuIowait = typeof cpu_iowait === 'number' && isFinite(cpu_iowait) ? Math.min(100, Math.max(0, cpu_iowait)) : 0;
    const safeCpuSteal = typeof cpu_steal === 'number' && isFinite(cpu_steal) ? Math.min(100, Math.max(0, cpu_steal)) : 0;

    const safeOsInfo = typeof os_info === 'string' ? os_info.substring(0, 200) : 'Linux Agent';
    const safePhpVer = typeof php_ver === 'string' ? php_ver.substring(0, 50) : null;
    const safePhpMemory = typeof php_memory === 'string' ? php_memory.substring(0, 50) : null;

    const metrics = {
      load: safeLoad,
      ram_used: safeRamUsed,
      ram_total: safeRamTotal,
      swap_used: safeSwapUsed,
      swap_total: safeSwapTotal,
      disk_pct: safeDiskPct,
      net_rx_kbps: safeNetRxKbps,
      net_tx_kbps: safeNetTxKbps,
      cpu_user: safeCpuUser,
      cpu_system: safeCpuSystem,
      cpu_idle: safeCpuIdle,
      cpu_iowait: safeCpuIowait,
      cpu_steal: safeCpuSteal,
      php_ver: safePhpVer,
      php_memory: safePhpMemory,
      os_info: safeOsInfo,
      timestamp: new Date().toISOString()
    };

    // Store UP Heartbeat
    insertHeartbeat({
      monitor_id: monitor.id,
      status: 1, // Agent push implies service is UP
      ping_ms: 0,
      msg: JSON.stringify(metrics)
    });

    // Check for Restoration Alert (if agent was previously DOWN / Stale)
    if (previousStatus === 0) {
      const alertTitle = `[akMon] ${monitor.name} is UP (Restored)`;
      const alertMsg = `Service: ${monitor.name}\nType: ${monitor.type}\nStatus: UP (Restored)\nDetails: Agent telemetry resumed successfully`;
      const priority = monitor.pushover_priority !== undefined ? monitor.pushover_priority : 2;

      sendPushoverNotification({
        title: alertTitle,
        message: alertMsg,
        priority
      }).catch((err) => console.error('[Pushover Dispatch Error]', err.message));

      sendEmailNotification({
        title: alertTitle,
        message: alertMsg
      }).catch((err) => console.error('[Email Dispatch Error]', err.message));
    }

    // Emit Socket.IO Event if attached
    const io = req.app.get('io');
    if (io) {
      io.emit('agent_update', {
        monitor_id: monitor.id,
        metrics
      });
      io.emit('heartbeat', {
        monitor_id: monitor.id,
        status: 1,
        ping_ms: 0,
        msg: JSON.stringify(metrics),
        created_at: new Date().toISOString()
      });
    }

    res.json({ ok: true, message: 'Telemetry received successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record telemetry' });
  }
});

export default router;
