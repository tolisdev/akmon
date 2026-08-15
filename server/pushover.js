import { getSetting } from './db.js';

/**
 * Pushover Alert Notification Handler
 * Dynamic credentials from SQLite settings table or process.env
 */

export async function sendPushoverNotification({ title, message, priority = 1, sound = 'pushover' }) {
  const enabled = getSetting('pushover_enabled', 'true');
  if (enabled !== 'true' && enabled !== true && enabled !== '1') {
    console.log('[Pushover Skipped] Disabled in settings.');
    return { ok: false, reason: 'Pushover notifications disabled in settings' };
  }

  const userKey = getSetting('pushover_user_key', process.env.PUSHOVER_USER_KEY || '');
  const apiToken = getSetting('pushover_api_token', process.env.PUSHOVER_API_TOKEN || '');

  if (!userKey || !apiToken) {
    console.log(`[Pushover Skipped] Missing User Key or API Token in settings/env.`);
    return { ok: false, reason: 'Missing User Key or API Token' };
  }

  const params = new URLSearchParams({
    token: apiToken,
    user: userKey,
    title,
    message,
    priority: String(priority),
    sound
  });

  if (Number(priority) === 2) {
    params.set('retry', '60');
    params.set('expire', '3600');
  }

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await res.json();
    if (res.ok && data.status === 1) {
      console.log(`[Pushover Sent] Priority ${priority} -> ${title}`);
      return { ok: true, data };
    }
    console.warn(`[Pushover Error] API Response (${res.status}):`, data);
    return { ok: false, reason: data.errors ? data.errors.join(', ') : 'API error', data };
  } catch (err) {
    console.error('[Pushover Network Error]', err.message);
    return { ok: false, reason: err.message };
  }
}
