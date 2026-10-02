import crypto from 'node:crypto';
import { db } from './db.js';
import { money } from './util.js';

/** Per-request template locals: current user, cart size, flash message, CSRF token. */
export function locals(req, res, next) {
  const s = req.session;
  res.locals.user = null;
  if (s.userId) {
    res.locals.user = db.prepare('SELECT id, username, email, phone, address FROM users WHERE id = ?').get(s.userId) || null;
    if (!res.locals.user) delete s.userId;
  }
  res.locals.isAdmin = Boolean(s.adminId);
  res.locals.cartCount = Object.values(s.cart || {}).reduce((a, b) => a + b, 0);
  res.locals.flash = s.flash || null;
  delete s.flash;
  res.locals.title = null;
  res.locals.money = money;
  res.locals.currentPath = req.path;
  next();
}

export const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

/** Synchroniser-token CSRF protection. Multipart forms pass the token as ?_csrf=. */
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = String(req.body?._csrf || req.query._csrf || req.get('x-csrf-token') || '');
  const a = Buffer.from(sent), b = Buffer.from(req.session.csrf);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403).view('error', { title: 'Forbidden', code: 403, message: 'Your session expired or the form was invalid. Please go back and try again.' });
}

export function requireUser(req, res, next) {
  if (res.locals.user) return next();
  flash(req, 'info', 'Please log in to continue.');
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

export function requireAdmin(req, res, next) {
  if (req.session.adminId) return next();
  res.redirect('/admin/login');
}

/** Rotate the session id on login/logout (prevents session fixation) but keep the guest cart. */
export function regenerate(req, patch, cb) {
  const cart = req.session.cart;
  req.session.regenerate((err) => {
    if (err) return cb(err);
    if (cart) req.session.cart = cart;
    Object.assign(req.session, patch);
    req.session.save(cb);
  });
}

export function notFound(req, res) {
  res.status(404).view('error', { title: 'Not found', code: 404, message: "We couldn't find that page." });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).view('error', { title: 'Error', code: 500, message: 'Something went wrong on our side.' });
}
