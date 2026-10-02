export const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-US');

export const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
export const PAYMENT_METHODS = { cod: 'Pay on delivery', mpesa: 'M-Pesa' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(?:\+?254|0)\d{9}$/; // Kenyan numbers: 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX
export const isEmail = (s) => EMAIL_RE.test(s) && s.length <= 254;
export const isPhone = (s) => PHONE_RE.test(s.replace(/[\s-]/g, ''));
export const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
export const toInt = (v, fallback = NaN) => (/^-?\d+$/.test(String(v ?? '').trim()) ? parseInt(v, 10) : fallback);

/** Only allow same-site relative redirects. */
export const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export function invoiceNumber() {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `HS-${d}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/** Tiny in-memory limiter for login attempts: max N per window per key. */
const hits = new Map();
export function tooManyAttempts(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return recent.length > max;
}
export const clearAttempts = (key) => hits.delete(key);
