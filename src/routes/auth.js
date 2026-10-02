import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { flash, regenerate } from '../middleware.js';
import { clean, isEmail, isPhone, safeNext, tooManyAttempts, clearAttempts } from '../util.js';

const r = Router();
const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

r.get('/register', (req, res) => {
  if (res.locals.user) return res.redirect('/account');
  res.view('register', { title: 'Create account', form: {}, errors: [] });
});

r.post('/register', (req, res, next) => {
  const form = {
    username: clean(req.body.username, 30), email: clean(req.body.email, 254).toLowerCase(),
    phone: clean(req.body.phone, 20), address: clean(req.body.address, 255),
  };
  const password = String(req.body.password || '');
  const errors = [];
  if (!USERNAME_RE.test(form.username)) errors.push('Username must be 3–30 letters, numbers or underscores.');
  if (!isEmail(form.email)) errors.push('Enter a valid email address.');
  if (form.phone && !isPhone(form.phone)) errors.push('Enter a valid Kenyan phone number (e.g. 0712345678).');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password !== String(req.body.confirm || '')) errors.push('Passwords do not match.');
  if (!errors.length && db.prepare('SELECT 1 FROM users WHERE email = ? OR username = ? COLLATE NOCASE').get(form.email, form.username)) {
    errors.push('That email or username is already registered.');
  }
  if (errors.length) return res.status(400).view('register', { title: 'Create account', form, errors });

  const info = db.prepare('INSERT INTO users (username, email, password_hash, phone, address) VALUES (?,?,?,?,?)')
    .run(form.username, form.email, bcrypt.hashSync(password, 10), form.phone, form.address);
  regenerate(req, { userId: Number(info.lastInsertRowid), flash: { type: 'success', msg: `Welcome, ${form.username}!` } },
    (err) => (err ? next(err) : res.redirect(safeNext(req.query.next) === '/' ? '/products' : safeNext(req.query.next))));
});

r.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/account');
  res.view('login', { title: 'Log in', next: safeNext(req.query.next), error: null });
});

r.post('/login', (req, res, next) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const key = `u:${req.ip}:${email}`;
  const fail = (msg, code = 401) => res.status(code).view('login', { title: 'Log in', next: safeNext(req.body.next), error: msg });
  if (tooManyAttempts(key)) return fail('Too many attempts. Please wait a few minutes and try again.', 429);

  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  const ok = bcrypt.compareSync(String(req.body.password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return fail('Incorrect email or password.');
  clearAttempts(key);
  regenerate(req, { userId: user.id }, (err) => (err ? next(err) : res.redirect(safeNext(req.body.next))));
});

r.post('/logout', (req, res, next) => {
  regenerate(req, { flash: { type: 'info', msg: 'You have been logged out.' } }, (err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

export default r;
