import tls from 'tls';
import ping from 'ping';
import { getActiveMonitors, addHeartbeat, getLatestHeartbeat } from './db.js';
import { sendPushoverNotification } from './pushover.js';
import { sendEmailNotification } from './email.js';

const runningChecks = new Set();
const lastCheckMap = new Map();
const lastStatusMap = new Map();

/**
 * Check TLS Certificate Expiry in days
 */
function getSSLDaysRemaining(hostname, port = 443) {
  return new Promise((resolve) => {
    let cleanHost = hostname.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    const socket = tls.connect(port, cleanHost, { servername: cleanHost, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (cert && cert.valid_to) {
        const validTo = new Date(cert.valid_to);
        const days = Math.floor((validTo - new Date()) / (1000 * 60 * 60 * 24));
        resolve(days);
      } else {
        resolve(null);
      }
    });

    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * HTTP / HTTPS Monitor Check with stream limiting (max 64KB)
 */
async function checkHttp(monitor) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  let sslDays = null;
  if (monitor.url.startsWith('https://')) {
    sslDays = await getSSLDaysRemaining(monitor.url);
  }

  try {
    const response = await fetch(monitor.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'akMon-UptimeCheck/1.0' }
    });

    clearTimeout(timeoutId);
    const pingMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        status: 0,
        pingMs,
        msg: `HTTP ${response.status} ${response.statusText}`,
        sslDays
      };
    }

    if (monitor.keyword && monitor.keyword.trim() !== '') {
      const reader = response.body.getReader();
      let bytesRead = 0;
      let bodyText = '';
      const decoder = new TextDecoder();

      while (bytesRead < 64 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.length;
        bodyText += decoder.decode(value, { stream: true });
        if (bodyText.includes(monitor.keyword)) {
          break;
        }
      }
      reader.cancel().catch(() => {});

      if (!bodyText.includes(monitor.keyword)) {
        return {
          status: 2, // DEGRADED
          pingMs,
          msg: `Keyword "${monitor.keyword}" not found in response`,
          sslDays
        };
      }
    }

    let msg = `HTTP ${response.status}`;
    if (sslDays !== null) {
      msg += ` | SSL: ${sslDays}d left`;
    }

    return {
      status: 1,
      pingMs,
      msg,
      sslDays
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const pingMs = Date.now() - startTime;
    const isTimeout = err.name === 'AbortError';
    return {
      status: 0,
      pingMs: isTimeout ? 5000 : pingMs,
      msg: isTimeout ? 'Request Timeout (5s)' : (err.message || 'Connection Refused'),
      sslDays
    };
  }
}

/**
 * ICMP / Ping Monitor Check
 */
async function checkPing(monitor) {
  const host = monitor.url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  try {
    const res = await ping.promise.probe(host, { timeout: 3 });
    return {
      status: res.isAlive ? 1 : 0,
      pingMs: res.isAlive ? Math.round(res.time === 'unknown' ? 0 : parseFloat(res.time)) : 0,
      msg: res.isAlive ? `Ping OK (${res.time}ms)` : 'Host Unreachable'
    };
  } catch (err) {
    return {
      status: 0,
      pingMs: 0,
      msg: err.message || 'Ping Failed'
    };
  }
}

/**
 * Agent Staleness Check (for push agents)
 */
function checkAgentStaleness(monitor) {
  const latest = getLatestHeartbeat(monitor.id);
  if (!latest) {
    return {
      status: 0,
      pingMs: 0,
      msg: 'Waiting for first agent payload'
    };
  }

  const lastHbTime = new Date(latest.created_at + 'Z').getTime();
  const now = Date.now();
  const maxDelay = (monitor.interval_sec || 60) * 2000; // 2x interval

  if (now - lastHbTime > maxDelay) {
    return {
      status: 0,
      pingMs: 0,
      msg: `Agent Stale (last report ${Math.round((now - lastHbTime) / 1000)}s ago)`
    };
  }

  return null; // Silent/OK
}

/**
 * Execute single check for monitor and notify on status change
 */
async function executeCheck(monitor, io) {
  if (runningChecks.has(monitor.id)) return;
  runningChecks.add(monitor.id);

  try {
    let result = null;

    if (monitor.type === 'http') {
      result = await checkHttp(monitor);
    } else if (monitor.type === 'ping') {
      result = await checkPing(monitor);
    } else if (monitor.type === 'agent_linux' || monitor.type === 'agent_php') {
      result = checkAgentStaleness(monitor);
    }

    if (result) {
      const hb = addHeartbeat(monitor.id, result.status, result.pingMs, result.msg);
      if (result.sslDays !== undefined) {
        hb.ssl_days = result.sslDays;
      }
      io.emit('heartbeat', hb);

      // Status Change Notification Trigger (Pushover & Email)
      const prevStatus = lastStatusMap.get(monitor.id);
      if (prevStatus !== undefined && prevStatus !== result.status) {
        const statusLabel = result.status === 1 ? 'UP (Restored)' : result.status === 2 ? 'DEGRADED' : 'DOWN (Offline)';
        const title = `[akMon] ${monitor.name} is ${statusLabel}`;
        const message = `Service: ${monitor.name}\nGroup: ${monitor.group_name || 'Default'}\nType: ${monitor.type}\nStatus: ${statusLabel}\nTarget/URL: ${monitor.url || 'Agent Ingestion'}\nDetails: ${result.msg}`;
        const priority = monitor.pushover_priority !== undefined ? monitor.pushover_priority : (monitor.type === 'http' ? 1 : 2);

        // Send notifications asynchronously
        sendPushoverNotification({ title, message, priority });
        sendEmailNotification({ title, message });
      }
      lastStatusMap.set(monitor.id, result.status);
    }

    lastCheckMap.set(monitor.id, Date.now());
  } catch (err) {
    console.error(`[Monitor Error] ${monitor.name} (${monitor.id}):`, err);
  } finally {
    runningChecks.delete(monitor.id);
  }
}

/**
 * Start non-overlapping Daemon Scheduler Loop
 */
export function startMonitoringDaemon(io) {
  console.log('[Daemon] Monitoring daemon initialized (10s scan loop).');

  setInterval(async () => {
    try {
      const monitors = getActiveMonitors();
      const now = Date.now();

      for (const monitor of monitors) {
        const lastTime = lastCheckMap.get(monitor.id) || 0;
        const intervalMs = (monitor.interval_sec || 60) * 1000;

        if (now - lastTime >= intervalMs) {
          executeCheck(monitor, io);
        }
      }
    } catch (err) {
      console.error('[Daemon Error]', err);
    }
  }, 10000);
}
