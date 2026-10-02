import { Router } from 'express';
import { db, tx } from '../db.js';
import { flash, requireUser } from '../middleware.js';
import { loadCart, MAX_PER_ITEM } from '../cart.js';
import { clean, toInt, isPhone, invoiceNumber, PAYMENT_METHODS } from '../util.js';

const r = Router();
const MPESA_CODE_RE = /^[A-Z0-9]{10}$/;

r.get('/cart', (req, res) => {
  res.view('cart', { title: 'Your cart', cart: loadCart(req) });
});

r.post('/cart/add', (req, res) => {
  const id = toInt(req.body.product_id, -1);
  const qty = Math.min(Math.max(toInt(req.body.qty, 1), 1), MAX_PER_ITEM);
  const product = db.prepare('SELECT id, title, stock FROM products WHERE id = ?').get(id);
  let back = '/products';
  if (req.body.back === 'cart') back = '/cart';
  else if (req.get('referer')) { try { const u = new URL(req.get('referer')); back = u.pathname + u.search; } catch { /* keep default */ } }
  if (!product) { flash(req, 'error', 'That product no longer exists.'); return res.redirect('/products'); }
  if (product.stock < 1) { flash(req, 'error', `${product.title} is out of stock.`); return res.redirect(back); }
  const cart = (req.session.cart ||= {});
  cart[id] = Math.min((cart[id] || 0) + qty, MAX_PER_ITEM, product.stock);
  flash(req, 'success', `Added “${product.title}” to your cart.`);
  res.redirect(back);
});

r.post('/cart/update', (req, res) => {
  const cart = (req.session.cart ||= {});
  for (const [key, v] of Object.entries(req.body)) {
    const id = /^qty\[(\d+)\]$/.exec(key)?.[1]; // form fields are named qty[<productId>]
    if (!id || !(id in cart)) continue;
    const q = toInt(v, 0);
    if (q <= 0) delete cart[id]; else cart[id] = Math.min(q, MAX_PER_ITEM);
  }
  res.redirect('/cart');
});

r.post('/cart/remove', (req, res) => {
  delete (req.session.cart ||= {})[toInt(req.body.product_id, -1)];
  res.redirect('/cart');
});

r.get('/checkout', requireUser, (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) { flash(req, 'info', 'Your cart is empty.'); return res.redirect('/products'); }
  if (cart.problems) { flash(req, 'error', 'Some items exceed available stock. Please adjust your cart.'); return res.redirect('/cart'); }
  const u = res.locals.user;
  res.view('checkout', {
    title: 'Checkout', cart, errors: [], methods: PAYMENT_METHODS, till: process.env.MPESA_TILL || '',
    form: { ship_name: u.username, ship_phone: u.phone, ship_address: u.address, payment_method: 'cod', mpesa_code: '' },
  });
});

r.post('/checkout', requireUser, (req, res, next) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/products');
  const form = {
    ship_name: clean(req.body.ship_name, 80), ship_phone: clean(req.body.ship_phone, 20),
    ship_address: clean(req.body.ship_address, 255), payment_method: clean(req.body.payment_method, 10),
    mpesa_code: clean(req.body.mpesa_code, 10).toUpperCase(),
  };
  const errors = [];
  if (!form.ship_name) errors.push('Enter the recipient name.');
  if (!isPhone(form.ship_phone)) errors.push('Enter a valid Kenyan phone number.');
  if (form.ship_address.length < 5) errors.push('Enter a delivery address.');
  if (!PAYMENT_METHODS[form.payment_method]) errors.push('Choose a payment method.');
  if (form.payment_method === 'mpesa' && !MPESA_CODE_RE.test(form.mpesa_code)) errors.push('Enter the 10-character M-Pesa confirmation code.');
  const rerender = (list) => res.status(400).view('checkout', { title: 'Checkout', cart, errors: list, form, methods: PAYMENT_METHODS, till: process.env.MPESA_TILL || '' });
  if (errors.length) return rerender(errors);

  try {
    const orderId = tx(() => {
      let total = 0;
      for (const { product, qty } of cart.items) {
        // Atomic stock check + decrement, so two buyers can't both take the last pair.
        const done = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, product.id, qty);
        if (!done.changes) throw Object.assign(new Error(`Sorry, “${product.title}” just ran low on stock.`), { user: true });
        total += product.price * qty;
      }
      const info = db.prepare(`INSERT INTO orders (user_id, invoice, total, payment_method, mpesa_code, ship_name, ship_phone, ship_address)
        VALUES (?,?,?,?,?,?,?,?)`).run(res.locals.user.id, invoiceNumber(), total, form.payment_method, form.mpesa_code, form.ship_name, form.ship_phone, form.ship_address);
      const ins = db.prepare('INSERT INTO order_items (order_id, product_id, title, unit_price, quantity) VALUES (?,?,?,?,?)');
      for (const { product, qty } of cart.items) ins.run(info.lastInsertRowid, product.id, product.title, product.price, qty);
      return Number(info.lastInsertRowid);
    });
    req.session.cart = {};
    flash(req, 'success', 'Order placed. Thank you!');
    res.redirect(`/orders/${orderId}`);
  } catch (err) {
    if (err.user) return rerender([err.message]);
    next(err);
  }
});

export default r;
