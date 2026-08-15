import express from 'express';
import { getMonitorByToken, addHeartbeat } from '../db.js';

const router = express.Router();

router.post('/agent', (req, res) => {
  const { token, load, ram_used, ram_total, disk_pct, php_memory, php_ver, os_info } = req.body || {};

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const monitor = getMonitorByToken(token);
  if (!monitor) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const metrics = {
    load: Array.isArray(load) ? load : [0, 0, 0],
    ram_used: Number(ram_used) || 0,
    ram_total: Number(ram_total) || 0,
    disk_pct: Number(disk_pct) || 0,
    php_memory: php_memory || null,
    php_ver: php_ver || null,
    os_info: os_info || null,
    timestamp: Date.now()
  };

  const msgJson = JSON.stringify(metrics);

  const heartbeat = addHeartbeat(monitor.id, 1, 0, msgJson);

  // Access Socket.IO instance attached to req.app
  const io = req.app.get('io');
  if (io) {
    io.emit('heartbeat', heartbeat);
    io.emit('agent_update', { monitor_id: monitor.id, metrics });
  }

  return res.json({ ok: true, status: 'acknowledged' });
});

export default router;
