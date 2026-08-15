import nodemailer from 'nodemailer';
import { getSetting } from './db.js';

export async function sendEmailNotification({ title, message }) {
  const enabled = getSetting('smtp_enabled', 'false');
  if (enabled !== 'true') {
    console.log(`[Email Alert Skipped] SMTP disabled in settings. Alert was: ${title}`);
    return { ok: false, reason: 'disabled' };
  }

  const host = getSetting('smtp_host', '');
  const port = parseInt(getSetting('smtp_port', '587'), 10);
  const secure = getSetting('smtp_secure', 'false') === 'true';
  const user = getSetting('smtp_user', '');
  const pass = getSetting('smtp_pass', '');
  const from = getSetting('smtp_from', 'akmon@localhost');
  const to = getSetting('smtp_to', '');

  if (!host || !to) {
    console.log(`[Email Alert Skipped] Missing SMTP host or recipient address.`);
    return { ok: false, reason: 'unconfigured' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    tls: {
      rejectUnauthorized: false // Permissive for self-signed mail servers
    }
  });

  const mailOptions = {
    from,
    to,
    subject: title || 'akMon Status Alert',
    text: message,
    html: `
      <div style="font-family: monospace, sans-serif; background-color: #09090b; color: #f4f4f5; padding: 20px; border-radius: 8px;">
        <h2 style="color: #10b981; margin-top: 0;">${title}</h2>
        <pre style="background-color: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #27272a; color: #e4e4e7;">${message}</pre>
        <p style="font-size: 11px; color: #71717a;">Sent automatically by akMon Single-Process Monitor Engine.</p>
      </div>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Sent] Message ID: ${info.messageId} -> ${to}`);
    return { ok: true, info };
  } catch (err) {
    console.error('[Email Error]', err.message);
    return { ok: false, error: err.message };
  }
}
