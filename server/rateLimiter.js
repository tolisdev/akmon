/**
 * Lightweight, high-performance in-memory Rate Limiter & Brute-Force Protection
 * for akMon Express server endpoints.
 */

// Helper to extract client IP address accurately behind reverse proxies (Nginx, Traefik, Caddy, Cloudflare)
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

/**
 * Creates an Express rate-limiting middleware for general endpoints.
 */
export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute default
  const max = options.max || 60;
  const message = options.message || 'Too many requests, please try again later.';
  const hits = new Map();

  // Periodically clean up expired entries
  setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, valid);
      }
    }
  }, 2 * 60 * 1000);

  return function rateLimiterMiddleware(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();

    let timestamps = hits.get(ip) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= max) {
      const oldestHit = timestamps[0];
      const retryAfterSec = Math.ceil((windowMs - (now - oldestHit)) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      return res.status(429).json({ error: message, retryAfterSec });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - timestamps.length));

    next();
  };
}

/**
 * Dedicated Brute-Force Tracker for Secret Tokens and Passwords.
 */
export class BruteForceTracker {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 15 * 60 * 1000; // 15 mins window
    this.maxFails = options.maxFails || 10; // Max failed attempts allowed
    this.blockDurationMs = options.blockDurationMs || 15 * 60 * 1000; // 15 mins IP lock
    this.failMap = new Map();

    setInterval(() => {
      const now = Date.now();
      for (const [ip, data] of this.failMap.entries()) {
        if (data.blockedUntil && now > data.blockedUntil) {
          this.failMap.delete(ip);
        } else if (now - data.firstFail > this.windowMs) {
          this.failMap.delete(ip);
        }
      }
    }, 5 * 60 * 1000);
  }

  isBlocked(ip) {
    const data = this.failMap.get(ip);
    if (!data) return false;
    if (data.blockedUntil) {
      if (Date.now() < data.blockedUntil) {
        return true;
      }
      this.failMap.delete(ip);
      return false;
    }
    return false;
  }

  getBlockTimeRemainingSec(ip) {
    const data = this.failMap.get(ip);
    if (!data || !data.blockedUntil) return 0;
    const remainingMs = data.blockedUntil - Date.now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  recordFail(ip) {
    const now = Date.now();
    let data = this.failMap.get(ip);
    if (!data || now - data.firstFail > this.windowMs) {
      data = { count: 1, firstFail: now, blockedUntil: null };
    } else {
      data.count += 1;
    }

    if (data.count >= this.maxFails) {
      data.blockedUntil = now + this.blockDurationMs;
    }

    this.failMap.set(ip, data);
    return data;
  }

  reset(ip) {
    this.failMap.delete(ip);
  }
}
