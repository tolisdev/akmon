import ping from 'ping';
import tls from 'tls';
import { URL } from 'url';
import { getAllMonitors, insertHeartbeat, getLatestHeartbeat, getSetting, updateMonitorSsl, updateMonitorFailState } from './db.js';
import { sendPushoverNotification } from './pushover.js';
import { sendEmailNotification } from './email.js';

let isScanning = false;

export function checkSslCertificate(urlStr) {
  return new Promise((resolve) => {
    try {
      if (!urlStr || !urlStr.startsWith('https://')) {
        return resolve(null);
      }

      const parsedUrl = new URL(urlStr);
      const hostname = parsedUrl.hostname;
      const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;

      const socket = tls.connect(
        {
          host: hostname,
          port: port,
          servername: hostname,
          timeout: 5000,
          rejectUnauthorized: false
        },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();

          if (!cert || !cert.valid_to || Object.keys(cert).length === 0) {
            return resolve({ valid: false, daysRemaining: 0, issuer: 'Unknown', error: 'No certificate data' });
          }

          const validTo = new Date(cert.valid_to);
          const now = new Date();
          const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          const valid = socket.authorized && daysRemaining > 0;
          const issuerName = cert.issuer ? (cert.issuer.O || cert.issuer.CN || 'Unknown') : 'Unknown';

          resolve({
            valid,
            daysRemaining,
            validTo: validTo.toISOString(),
            issuer: issuerName
          });
        }
      );

      socket.on('error', (err) => {
        socket.destroy();
        resolve({ valid: false, daysRemaining: 0, issuer: 'Unknown', error: err.message });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ valid: false, daysRemaining: 0, issuer: 'Unknown', error: 'TLS Timeout' });
      });
    } catch (err) {
      resolve(null);
    }
  });
}

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

    // Real TLS Certificate Expiration Days Check if HTTPS
    let sslDays = null;
    let sslIssuer = null;
    if (monitor.url.startsWith('https://')) {
      const sslInfo = await checkSslCertificate(monitor.url);
      if (sslInfo) {
        sslDays = sslInfo.daysRemaining;
        sslIssuer = sslInfo.issuer;
        updateMonitorSsl(monitor.id, sslDays, sslIssuer);
      }
    }

    return {
      status: 1,
      ping_ms: latency,
      msg: `HTTP ${res.status} OK`,
      ssl_days: sslDays,
      ssl_issuer: sslIssuer
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
  // Stale threshold: 2x check interval (minimum 90s)
  const staleThresholdSec = Math.max((monitor.interval_sec || 60) * 2, 90);

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
          const rawStatus = result.status; // 1 = OK, 0 = FAIL, 2 = DEGRADED
          const maxRetries = m.max_retries !== undefined && m.max_retries !== null ? parseInt(m.max_retries, 10) : 3;
          let currentFails = m.consecutive_fails || 0;
          let lastAlertedStatus = m.last_alerted_status !== undefined && m.last_alerted_status !== null ? m.last_alerted_status : 1;
          let finalStatus = rawStatus;

          if (rawStatus === 1) {
            // A single OKAY ping / check is enough for full recovery!
            currentFails = 0;
            finalStatus = 1;

            // Trigger recovery notification if monitor was previously alerted as DOWN (0)
            if (lastAlertedStatus === 0) {
              const prio = m.pushover_priority !== undefined ? m.pushover_priority : 1;
              const title = `✅ [RESTORED] ${m.name} is UP!`;
              const msg = `Service "${m.name}" (${m.url}) has recovered.\nLatency: ${result.ping_ms}ms\nTime: ${new Date().toLocaleString()}`;
              sendPushoverNotification({ title, message: msg, priority: prio });
              sendEmailNotification({ title, message: msg });
              lastAlertedStatus = 1;
            }
          } else {
            // Check failed (HTTP error, ping timeout, or stale agent)
            currentFails += 1;

            if (currentFails <= maxRetries) {
              // Status set to DEGRADED (2) with NO notification sent!
              finalStatus = 2;
            } else {
              // Failed checks > maxRetries: Status set to DOWN (0) and send alert notification!
              finalStatus = 0;

              if (lastAlertedStatus !== 0) {
                const prio = m.pushover_priority !== undefined ? m.pushover_priority : 1;
                const title = `🚨 [DOWN] ${m.name} is OFFLINE!`;
                const msg = `Service "${m.name}" (${m.url}) check failed ${currentFails} times consecutively (Max retries: ${maxRetries}).\nError: ${result.msg}\nTime: ${new Date().toLocaleString()}`;
                sendPushoverNotification({ title, message: msg, priority: prio });
                sendEmailNotification({ title, message: msg });
                lastAlertedStatus = 0;
              }
            }
          }

          // Persist failure count and alerted state to DB
          updateMonitorFailState(m.id, currentFails, lastAlertedStatus);

          insertHeartbeat({
            monitor_id: m.id,
            status: finalStatus,
            ping_ms: result.ping_ms,
            msg: currentFails > 0 && finalStatus === 2 ? `[Degraded Check ${currentFails}/${maxRetries}] ${result.msg}` : result.msg
          });

          const heartbeatPayload = {
            monitor_id: m.id,
            status: finalStatus,
            ping_ms: result.ping_ms,
            msg: result.msg,
            created_at: new Date().toISOString(),
            ssl_days: result.ssl_days,
            ssl_issuer: result.ssl_issuer
          };

          io.emit('heartbeat', heartbeatPayload);
        }
      }
    } catch (err) {
      console.error('[Daemon Error]', err);
    } finally {
      isScanning = false;
    }
  }, 5000);
}
