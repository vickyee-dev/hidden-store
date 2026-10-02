import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx } from '../db.js';
import { flash, requireAdmin, regenerate } from '../middleware.js';
import { uploadImages, removeUpload, uploadUrl } from '../upload.js';
import { clean, toInt, ORDER_STATUSES, PAYMENT_METHODS, tooManyAttempts, clearAttempts } from '../util.js';

const r = Router();
const view = (res, name, data = {}) => res.view('admin/' + name, { admin: true, ...data }, 'admin/layout');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/* ---------- auth ---------- */
r.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.view('admin/login', { title: 'Admin login', error: null }, 'admin/layout');
});
r.post('/login', (req, res, next) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const key = `a:${req.ip}:${email}`;
  const fail = (msg, code = 401) => res.status(code).view('admin/login', { title: 'Admin login', error: msg }, 'admin/layout');
  if (tooManyAttempts(key, 5)) return fail('Too many attempts. Please wait and try again.', 429);
  const a = db.prepare('SELECT id, password_hash FROM admins WHERE email = ?').get(email);
  if (!bcrypt.compareSync(String(req.body.password || ''), a ? a.password_hash : DUMMY_HASH) || !a) return fail('Incorrect email or password.');
  clearAttempts(key);
  regenerate(req, { adminId: a.id }, (err) => (err ? next(err) : res.redirect('/admin')));
});
r.post('/logout', (req, res, next) => regenerate(req, {}, (err) => (err ? next(err) : res.redirect('/admin/login'))));

r.use(requireAdmin);

/* ---------- dashboard ---------- */
r.get('/', (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  view(res, 'dashboard', {
    title: 'Dashboard',
    stats: {
      products: one('SELECT COUNT(*) n FROM products').n,
      users: one('SELECT COUNT(*) n FROM users').n,
      orders: one('SELECT COUNT(*) n FROM orders').n,
      pending: one("SELECT COUNT(*) n FROM orders WHERE status = 'pending'").n,
      revenue: one("SELECT COALESCE(SUM(total),0) n FROM orders WHERE payment_status = 'paid' AND status != 'cancelled'").n,
    },
    low: db.prepare('SELECT id, title, stock FROM products WHERE stock <= 3 ORDER BY stock, title LIMIT 8').all(),
    recent: db.prepare('SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 6').all(),
  });
});

/* ---------- categories & brands (identical CRUD) ---------- */
for (const [slug, table, label] of [['categories', 'categories', 'Category'], ['brands', 'brands', 'Brand']]) {
  const col = table === 'categories' ? 'category_id' : 'brand_id';
  r.get(`/${slug}`, (req, res) => {
    const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM products WHERE ${col} = t.id) AS n FROM ${table} t ORDER BY title`).all();
    view(res, 'taxonomy', { title: slug === 'brands' ? 'Brands' : 'Categories', slug, label, rows });
  });
  r.post(`/${slug}`, (req, res) => {
    const title = clean(req.body.title, 100);
    if (!title) flash(req, 'error', `${label} name is required.`);
    else try { db.prepare(`INSERT INTO ${table} (title) VALUES (?)`).run(title); flash(req, 'success', `${label} added.`); }
    catch { flash(req, 'error', `That ${label.toLowerCase()} already exists.`); }
    res.redirect(`/admin/${slug}`);
  });
  r.post(`/${slug}/:id`, (req, res) => {
    const title = clean(req.body.title, 100);
    if (!title) flash(req, 'error', `${label} name is required.`);
    else try { db.prepare(`UPDATE ${table} SET title = ? WHERE id = ?`).run(title, toInt(req.params.id, -1)); flash(req, 'success', `${label} updated.`); }
    catch { flash(req, 'error', `That ${label.toLowerCase()} already exists.`); }
    res.redirect(`/admin/${slug}`);
  });
  r.post(`/${slug}/:id/delete`, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(toInt(req.params.id, -1)); // products keep existing, uncategorised
    flash(req, 'success', `${label} deleted.`);
    res.redirect(`/admin/${slug}`);
  });
}

/* ---------- products ---------- */
const lookups = () => ({
  categories: db.prepare('SELECT * FROM categories ORDER BY title').all(),
  brands: db.prepare('SELECT * FROM brands ORDER BY title').all(),
});

r.get('/products', (req, res) => {
  const q = clean(req.query.q, 80);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const products = db.prepare(`SELECT p.*, c.title AS category, b.title AS brand FROM products p
    LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.title LIKE ? ESCAPE '\\' ORDER BY p.id DESC`).all(like);
  view(res, 'products', { title: 'Products', products, q });
});

r.get('/products/new', (req, res) => view(res, 'product-form', { title: 'New product', product: { price: '', stock: 10 }, errors: [], ...lookups() }));

function readProduct(req) {
  const b = req.body;
  const p = {
    title: clean(b.title, 150), description: clean(b.description, 1000), keywords: clean(b.keywords, 255),
    category_id: toInt(b.category_id, null), brand_id: toInt(b.brand_id, null),
    price: toInt(b.price), stock: toInt(b.stock),
  };
  const errors = [];
  if (!p.title) errors.push('Title is required.');
  if (!Number.isInteger(p.price) || p.price < 0) errors.push('Price must be a whole number of KES (0 or more).');
  if (!Number.isInteger(p.stock) || p.stock < 0) errors.push('Stock must be a whole number (0 or more).');
  return { p, errors };
}

r.post('/products', uploadImages, (req, res) => {
  const { p, errors } = readProduct(req);
  const f = req.files || {};
  if (!f.image1) errors.push('A main image is required.');
  if (errors.length) {
    Object.values(f).flat().forEach((x) => removeUpload(uploadUrl(x)));
    return res.status(400).view('admin/product-form', { admin: true, title: 'New product', product: p, errors, ...lookups() }, 'admin/layout');
  }
  const info = db.prepare(`INSERT INTO products (title, description, keywords, category_id, brand_id, price, stock, image1, image2, image3)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(p.title, p.description, p.keywords, p.category_id, p.brand_id, p.price, p.stock,
    uploadUrl(f.image1?.[0]), uploadUrl(f.image2?.[0]), uploadUrl(f.image3?.[0]));
  flash(req, 'success', 'Product created.');
  res.redirect(`/admin/products/${info.lastInsertRowid}/edit`);
});

const findProduct = (req) => db.prepare('SELECT * FROM products WHERE id = ?').get(toInt(req.params.id, -1));

r.get('/products/:id/edit', (req, res, next) => {
  const product = findProduct(req);
  if (!product) return next();
  view(res, 'product-form', { title: 'Edit product', product, errors: [], ...lookups() });
});

r.post('/products/:id', uploadImages, (req, res, next) => {
  const old = findProduct(req);
  if (!old) return next();
  const { p, errors } = readProduct(req);
  const f = req.files || {};
  if (errors.length) {
    Object.values(f).flat().forEach((x) => removeUpload(uploadUrl(x)));
    return res.status(400).view('admin/product-form', { admin: true, title: 'Edit product', product: { ...old, ...p }, errors, ...lookups() }, 'admin/layout');
  }
  const imgs = {};
  for (const k of ['image1', 'image2', 'image3']) {
    if (f[k]) { imgs[k] = uploadUrl(f[k][0]); removeUpload(old[k]); }
    else if (k !== 'image1' && req.body['remove_' + k]) { imgs[k] = ''; removeUpload(old[k]); }
    else imgs[k] = old[k];
  }
  db.prepare(`UPDATE products SET title=?, description=?, keywords=?, category_id=?, brand_id=?, price=?, stock=?, image1=?, image2=?, image3=? WHERE id=?`)
    .run(p.title, p.description, p.keywords, p.category_id, p.brand_id, p.price, p.stock, imgs.image1, imgs.image2, imgs.image3, old.id);
  flash(req, 'success', 'Product saved.');
  res.redirect(`/admin/products/${old.id}/edit`);
});

r.post('/products/:id/delete', (req, res, next) => {
  const p = findProduct(req);
  if (!p) return next();
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id); // past order lines keep their title/price snapshot
  [p.image1, p.image2, p.image3].forEach(removeUpload);
  flash(req, 'success', 'Product deleted.');
  res.redirect('/admin/products');
});

/* ---------- orders ---------- */
r.get('/orders', (req, res) => {
  const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
  const orders = db.prepare(`SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
    ${status ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC`).all(...(status ? [status] : []));
  view(res, 'orders', { title: 'Orders', orders, status, statuses: ORDER_STATUSES });
});

const findOrder = (req) => db.prepare(`SELECT o.*, u.username, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(toInt(req.params.id, -1));

r.get('/orders/:id', (req, res, next) => {
  const order = findOrder(req);
  if (!order) return next();
  view(res, 'order', { title: `Order ${order.invoice}`, order, items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id), statuses: ORDER_STATUSES, methods: PAYMENT_METHODS });
});

r.post('/orders/:id', (req, res, next) => {
  const order = findOrder(req);
  if (!order) return next();
  const status = ORDER_STATUSES.includes(req.body.status) ? req.body.status : order.status;
  const paid = req.body.payment_status === 'paid' ? 'paid' : 'unpaid';
  if (order.status === 'cancelled' && status !== 'cancelled') {
    flash(req, 'error', 'Cancelled orders cannot be reopened; ask the customer to place a new order.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  tx(() => {
    if (status === 'cancelled' && order.status !== 'cancelled') {
      for (const i of db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(order.id)) {
        if (i.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(i.quantity, i.product_id);
      }
    }
    db.prepare('UPDATE orders SET status = ?, payment_status = ? WHERE id = ?').run(status, paid, order.id);
  });
  flash(req, 'success', 'Order updated.');
  res.redirect(`/admin/orders/${order.id}`);
});

/* ---------- users ---------- */
r.get('/users', (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS orders FROM users u ORDER BY u.id DESC`).all();
  view(res, 'users', { title: 'Customers', users });
});
r.post('/users/:id/delete', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(toInt(req.params.id, -1));
  flash(req, 'success', 'Customer deleted. Their past orders were kept.');
  res.redirect('/admin/users');
});

export default r;
