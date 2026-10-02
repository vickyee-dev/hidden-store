import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx } from '../db.js';
import { flash, requireUser, regenerate } from '../middleware.js';
import { clean, isPhone, toInt, PAYMENT_METHODS } from '../util.js';

const r = Router();
r.use(['/account', '/orders'], requireUser);

r.get('/account', (req, res) => {
  const recent = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 3').all(res.locals.user.id);
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status IN ('pending','processing','shipped')`).get(res.locals.user.id).n;
  res.view('account', { title: 'My account', recent, pending, errors: [] });
});

r.post('/account', (req, res) => {
  const phone = clean(req.body.phone, 20), address = clean(req.body.address, 255);
  if (phone && !isPhone(phone)) {
    flash(req, 'error', 'Enter a valid Kenyan phone number.');
  } else {
    db.prepare('UPDATE users SET phone = ?, address = ? WHERE id = ?').run(phone, address, res.locals.user.id);
    flash(req, 'success', 'Profile updated.');
  }
  res.redirect('/account');
});

r.post('/account/password', (req, res) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(res.locals.user.id);
  const next = String(req.body.new_password || '');
  if (!bcrypt.compareSync(String(req.body.current_password || ''), row.password_hash)) flash(req, 'error', 'Current password is incorrect.');
  else if (next.length < 8) flash(req, 'error', 'New password must be at least 8 characters.');
  else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), res.locals.user.id);
    flash(req, 'success', 'Password changed.');
  }
  res.redirect('/account');
});

r.post('/account/delete', (req, res, next) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(res.locals.user.id);
  if (!bcrypt.compareSync(String(req.body.password || ''), row.password_hash)) {
    flash(req, 'error', 'Password incorrect — account not deleted.');
    return res.redirect('/account');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(res.locals.user.id); // orders are kept, detached from the user
  regenerate(req, { flash: { type: 'info', msg: 'Your account has been deleted.' } }, (err) => (err ? next(err) : res.redirect('/')));
});

r.get('/orders', (req, res) => {
  const orders = db.prepare(`SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS items
    FROM orders o WHERE user_id = ? ORDER BY id DESC`).all(res.locals.user.id);
  res.view('orders', { title: 'My orders', orders });
});

function ownedOrder(req, res) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(toInt(req.params.id, -1), res.locals.user.id);
  return order && { order, items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) };
}

r.get('/orders/:id', (req, res, next) => {
  const found = ownedOrder(req, res);
  if (!found) return next();
  res.view('order', { title: `Order ${found.order.invoice}`, ...found, methods: PAYMENT_METHODS, till: process.env.MPESA_TILL || '' });
});

r.post('/orders/:id/cancel', (req, res, next) => {
  const found = ownedOrder(req, res);
  if (!found) return next();
  if (found.order.status !== 'pending') {
    flash(req, 'error', 'Only pending orders can be cancelled. Please contact us.');
  } else {
    tx(() => {
      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(found.order.id);
      for (const i of found.items) if (i.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(i.quantity, i.product_id);
    });
    flash(req, 'success', 'Order cancelled.');
  }
  res.redirect(`/orders/${found.order.id}`);
});

export default r;
