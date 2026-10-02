import express from 'express';
import session from 'express-session';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, seed } from './db.js';
import { ROOT, UPLOAD_DIR } from './config.js';
import { SqliteStore } from './session-store.js';
import { locals, csrf, notFound, errorHandler } from './middleware.js';
import shop from './routes/shop.js';
import auth from './routes/auth.js';
import account from './routes/account.js';
import cartRoutes from './routes/cart.js';
import admin from './routes/admin.js';

export function createApp() {
  seed();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const app = express();
  const prod = process.env.NODE_ENV === 'production';
  app.disable('x-powered-by');
  if (prod) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: prod ? '7d' : 0 }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: prod ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (prod) throw new Error('SESSION_SECRET must be set in production');
    secret = crypto.randomBytes(32).toString('hex');
  }
  app.use(session({
    name: 'hs.sid',
    secret,
    store: new SqliteStore(db),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 1000 * 60 * 60 * 24 * 14 },
  }));

  // res.view(name, data, layout): render a view inside the site (or admin) layout.
  app.use((req, res, next) => {
    res.view = (name, data = {}, layout = 'layout') => {
      app.render(name, { ...res.locals, ...data }, (err, body) => {
        if (err) return next(err);
        res.render(layout, { ...data, body });
      });
    };
    next();
  });
  app.use(locals);
  app.use(csrf);

  app.use('/', shop);
  app.use('/', auth);
  app.use('/', cartRoutes);
  app.use('/', account);
  app.use('/admin', admin);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
