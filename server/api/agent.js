import express from 'express';
import { getMonitorByToken, insertHeartbeat } from '../db.js';

const router = express.Router();

// Agent Telemetry Ingestion Endpoint
router.post('/agent', (req, res) => {
  try {
    const { token, load, ram_used, ram_total, disk_pct, php_ver, php_memory, os_info } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const monitor = getMonitorByToken(token);
    if (!monitor) {
      return res.status(404).json({ error: 'Invalid or unregistered agent token' });
    }

    const metrics = {
      load: load || [0, 0, 0],
      ram_used: ram_used || 0,
      ram_total: ram_total || 0,
      disk_pct: disk_pct || 0,
      php_ver: php_ver || null,
      php_memory: php_memory || null,
      os_info: os_info || 'Linux Agent',
      timestamp: new Date().toISOString()
    };

    // Store Heartbeat
    insertHeartbeat({
      monitor_id: monitor.id,
      status: 1, // Agent push implies service is UP
      ping_ms: 0,
      msg: JSON.stringify(metrics)
    });

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
    res.status(500).json({ error: err.message });
  }
});

export default router;
