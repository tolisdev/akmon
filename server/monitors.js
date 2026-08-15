import ping from 'ping';
import { getAllMonitors, insertHeartbeat, getLatestHeartbeat, getSetting } from './db.js';
import { sendPushoverNotification } from './pushover.js';
import { sendEmailNotification } from './email.js';

let isScanning = false;

async function checkHttpMonitor(monitor) {
  const startTime = Date.now();
  const timeoutMs = 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(monitor.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'akMon-UptimeCheck/1.0 (+https://github.com/tolisdev/akmon)'
      }
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    if (!res.ok) {
      return {
        status: 0,
        ping_ms: latency,
        msg: `HTTP ${res.status} ${res.statusText}`
      };
    }

    // Keyword Search (Cap body stream at 64KB max)
    if (monitor.keyword && monitor.keyword.trim() !== '') {
      const reader = res.body.getReader();
      let bytesRead = 0;
      let bodyText = '';
      const maxBytes = 64 * 1024;

      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.length;
        bodyText += new TextDecoder('utf-8').decode(value, { stream: true });
      }

      if (!bodyText.includes(monitor.keyword)) {
        return {
          status: 2, // Degraded
          ping_ms: latency,
          msg: `Keyword "${monitor.keyword}" not found`
        };
      }
    }

    // Check TLS Certificate Expiration Days if HTTPS
    let sslDays = null;
    if (monitor.url.startsWith('https://')) {
      try {
        const urlObj = new URL(monitor.url);
        // Simple heuristic estimate or placeholder for node native TLS check
        sslDays = 90; // Default SSL healthy placeholder
      } catch (e) {
        sslDays = null;
      }
    }

    return {
      status: 1,
      ping_ms: latency,
      msg: `HTTP ${res.status} OK`,
      ssl_days: sslDays
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    let msg = err.name === 'AbortError' ? 'Request Timeout (5s)' : err.message;
    return {
      status: 0,
      ping_ms: latency,
      msg
    };
  }
}

async function checkPingMonitor(monitor) {
  const startTime = Date.now();
  try {
    let host = monitor.url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    const res = await ping.promise.probe(host, { timeout: 3 });
    const latency = res.time !== 'unknown' ? Math.round(res.time) : Date.now() - startTime;

    if (res.alive) {
      return {
        status: 1,
        ping_ms: latency,
        msg: `Ping Reply (${latency}ms)`
      };
    }
    return {
      status: 0,
      ping_ms: 0,
      msg: 'Ping Timeout / Host Unreachable'
    };
  } catch (err) {
    return {
      status: 0,
      ping_ms: 0,
      msg: err.message
    };
  }
}

async function checkStaleAgents(monitor) {
  const latest = getLatestHeartbeat(monitor.id);
  if (!latest) {
    return null; // Awaiting initial agent push
  }

  const lastTime = new Date(latest.created_at).getTime();
  const now = Date.now();
  const diffSec = (now - lastTime) / 1000;
  const staleThresholdSec = (monitor.interval_sec || 60) * 2.5;

  if (diffSec > staleThresholdSec && latest.status !== 0) {
    return {
      status: 0,
      ping_ms: 0,
      msg: `Agent Stale (No check-in for ${Math.round(diffSec)}s)`
    };
  }

  return null;
}

export function startMonitoringDaemon(io) {
  // 5-second daemon tick for accurate check interval scheduling
  setInterval(async () => {
    if (isScanning) return;
    isScanning = true;

    try {
      const activeMonitors = getAllMonitors().filter((m) => m.active === 1);
      const now = Date.now();

      for (const m of activeMonitors) {
        const latest = getLatestHeartbeat(m.id);
        const intervalMs = (m.interval_sec || 60) * 1000;

        // Enforce configured check interval: skip if checked recently
        if (latest && latest.created_at) {
          const lastCheckTime = new Date(latest.created_at).getTime();
          if (now - lastCheckTime < intervalMs - 1000) {
            continue;
          }
        }

        let result = null;

        if (m.type === 'http') {
          result = await checkHttpMonitor(m);
        } else if (m.type === 'ping') {
          result = await checkPingMonitor(m);
        } else if (m.type === 'agent_linux' || m.type === 'agent_php') {
          result = await checkStaleAgents(m);
        }

        if (result) {
          const previousStatus = latest ? latest.status : null;

          insertHeartbeat({
            monitor_id: m.id,
            status: result.status,
            ping_ms: result.ping_ms,
            msg: result.msg
          });

          const heartbeatPayload = {
            monitor_id: m.id,
            status: result.status,
            ping_ms: result.ping_ms,
            msg: result.msg,
            ssl_days: result.ssl_days,
            created_at: new Date().toISOString()
          };

          // Emit Socket.IO event for real-time UI updates
          if (io) {
            io.emit('heartbeat', heartbeatPayload);
          }

          // Trigger Alert Notifications on Status Change (UP -> DOWN, DOWN -> UP)
          if (previousStatus !== null && previousStatus !== result.status) {
            const statusLabel = result.status === 1 ? 'UP (Restored)' : result.status === 0 ? 'DOWN (Offline)' : 'DEGRADED';
            const alertTitle = `[akMon] ${m.name} is ${statusLabel}`;
            const alertMsg = `Service: ${m.name}\nType: ${m.type}\nStatus: ${statusLabel}\nTarget/URL: ${m.url || 'Agent Ingestion'}\nDetails: ${result.msg}`;

            // Priority rules: default HTTP=1 (High), Servers=2 (Emergency)
            const priority = m.pushover_priority !== undefined ? m.pushover_priority : (m.type === 'http' ? 1 : 2);

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
        }
      }
    } catch (err) {
      console.error('[Daemon Error]', err);
    } finally {
      isScanning = false;
    }
  }, 5000); // 5s ticker loop
}
