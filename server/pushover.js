/**
 * Pushover Notification Helper for akMon
 * Reads credentials dynamically from SQLite settings table (or env fallback)
 */
import { getSetting } from './db.js';

export async function sendPushoverNotification({ title, message, priority = 0 }) {
  const enabled = getSetting('pushover_enabled', 'true');
  if (enabled === 'false') {
    console.log(`[Pushover Skipped] Disabled in settings.`);
    return { ok: false, reason: 'disabled' };
  }

  const userKey = getSetting('pushover_user_key', process.env.PUSHOVER_USER_KEY || '');
  const apiToken = getSetting('pushover_api_token', process.env.PUSHOVER_API_TOKEN || '');

  if (!userKey || !apiToken) {
    console.log(`[Pushover Skipped] Missing User Key or API Token in settings/env.`);
    return { ok: false, reason: 'unconfigured' };
  }

  const payload = {
    token: apiToken,
    user: userKey,
    title: title || 'akMon Alert',
    message: message || 'Monitor status change detected',
    priority: Number(priority)
  };

  // Priority 2 (Emergency) requires retry and expire parameters
  if (payload.priority === 2) {
    payload.retry = 60;   // Re-send alert every 60 seconds
    payload.expire = 3600; // Stop retrying after 1 hour (3600s)
  }

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.status === 1) {
      console.log(`[Pushover Sent] Priority ${priority} -> ${title}`);
      return { ok: true, data };
    } else {
      console.error('[Pushover Error Response]', data);
      return { ok: false, error: data };
    }
  } catch (err) {
    console.error('[Pushover Exception]', err.message);
    return { ok: false, error: err.message };
  }
}
