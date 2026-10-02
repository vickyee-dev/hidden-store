// End-to-end tests: boots the real app on a random port with an in-memory DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DB_PATH = ':memory:';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-uploads-'));
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ADMIN_PASSWORD = 'correct-horse-battery';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');

let server, base;
before(() => new Promise((res) => { server = createApp().listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; res(); }); }));
after(() => server.close());

/** Minimal cookie-jar client. */
function client() {
  let cookie = '';
  const req = async (method, url, { form, raw, headers = {} } = {}) => {
    const r = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(cookie && { cookie }), ...(form && { 'content-type': 'application/x-www-form-urlencoded' }), ...headers },
      body: raw ?? (form ? new URLSearchParams(form).toString() : undefined),
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text };
  };
  const c = {
    get: (u) => req('GET', u),
    post: (u, form, raw, headers) => req('POST', u, { form, raw, headers }),
    multipart: (u, fd) => req('POST', u, { raw: fd }),
    async token(u = '/products') { const { text } = await c.get(u); return text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1]; },
    async postWithToken(u, form = {}, page = '/products') { return c.post(u, { ...form, _csrf: await c.token(page) }); },
  };
  return c;
}

test('storefront lists seeded products and renders product pages', async () => {
  const c = client();
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Shoes for every step/);
  const list = await c.get('/products');
  assert.match(list.text, /Nike Air Force 1 \(Black\)/);
  assert.match((await c.get('/products/2')).text, /KES 2,200/);
  assert.equal((await c.get('/products/9999')).status, 404);
  assert.equal((await c.get('/products/abc')).status, 404);
});

test('filters, search and sorting work', async () => {
  const c = client();
  assert.match((await c.get('/products?category=4')).text, /Timberland/);
  assert.doesNotMatch((await c.get('/products?category=4')).text, /Puma Run/);
  assert.match((await c.get('/products?q=tennis')).text, /NikeCourt/);
  const asc = (await c.get('/products?sort=price_asc')).text;
  assert.ok(asc.indexOf('Cork Sandals') < asc.indexOf('Timberland 6-Inch Premium Boot (Black)'));
});

test('SQL injection and XSS attempts are neutralised', async () => {
  const c = client();
  const inj = await c.get(`/products?q=${encodeURIComponent("' OR 1=1; DROP TABLE products;--")}`);
  assert.equal(inj.status, 200);
  assert.match(inj.text, /No shoes match/);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM products').get().n >= 9, 'products table intact');
  const xss = await c.get(`/products?q=${encodeURIComponent('<script>alert(1)</script>')}`);
  assert.doesNotMatch(xss.text, /<script>alert\(1\)<\/script>/);
  assert.equal((await c.get('/products?category=1%20OR%201=1')).status, 200);
});

test('POSTs without a CSRF token are rejected', async () => {
  const c = client();
  const r = await c.post('/cart/add', { product_id: 1 });
  assert.equal(r.status, 403);
});

test('cart: add, update, remove; quantity is capped by stock', async () => {
  const c = client();
  await c.postWithToken('/cart/add', { product_id: 2, qty: 2 });
  assert.match((await c.get('/cart')).text, /KES 4,400/);
  await c.postWithToken('/cart/update', { 'qty[2]': '3' }, '/cart');
  assert.match((await c.get('/cart')).text, /KES 6,600/);
  await c.postWithToken('/cart/add', { product_id: 3, qty: 99 });   // stock is 8, max per item 10
  assert.match((await c.get('/cart')).text, /value="8"/);
  await c.postWithToken('/cart/remove', { product_id: 2 }, '/cart');
  assert.doesNotMatch((await c.get('/cart')).text, /Nike Air Force 1 \(Black\)/);
});

test('registration validation, login, and bad-credential handling', async () => {
  const c = client();
  const bad = await c.postWithToken('/register', { username: 'a', email: 'nope', password: 'short', confirm: 'x' }, '/register');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Username must be/);
  const ok = await c.postWithToken('/register', { username: 'wanjiku', email: 'W@Example.com', phone: '0712345678', address: 'Kilimani', password: 'password123', confirm: 'password123' }, '/register');
  assert.equal(ok.status, 302);
  assert.match((await c.get('/account')).text, /Hi, wanjiku/);
  const stored = db.prepare("SELECT password_hash, email FROM users WHERE username='wanjiku'").get();
  assert.match(stored.password_hash, /^\$2[aby]\$/); assert.equal(stored.email, 'w@example.com');

  const dup = await client().postWithToken('/register', { username: 'wanjiku2', email: 'w@example.com', password: 'password123', confirm: 'password123' }, '/register');
  assert.match(dup.text, /already registered/);

  const c2 = client();
  const wrong = await c2.postWithToken('/login', { email: 'w@example.com', password: 'wrong-pass' }, '/login');
  assert.equal(wrong.status, 401);
  const right = await c2.postWithToken('/login', { email: 'w@example.com', password: 'password123', next: '/orders' }, '/login');
  assert.equal(right.location, '/orders');
  const evil = await client().postWithToken('/login', { email: 'w@example.com', password: 'password123', next: '//evil.com' }, '/login');
  assert.equal(evil.location, '/', 'open redirect blocked');
});

test('account pages require login', async () => {
  const r = await client().get('/orders');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login\?next=/);
  assert.equal((await client().get('/checkout')).status, 302);
});

test('checkout: guest cart survives login, order is created, stock decrements, price comes from DB', async () => {
  const c = client();
  await c.postWithToken('/cart/add', { product_id: 4, qty: 2 });          // guest cart
  await c.postWithToken('/login', { email: 'w@example.com', password: 'password123' }, '/login');
  assert.match((await c.get('/cart')).text, /Timberland/, 'cart kept after login');
  const before = db.prepare('SELECT stock FROM products WHERE id=4').get().stock;

  const missing = await c.postWithToken('/checkout', { ship_name: 'W', ship_phone: '123', ship_address: 'x', payment_method: 'mpesa' }, '/checkout');
  assert.equal(missing.status, 400);

  const done = await c.postWithToken('/checkout', { ship_name: 'Wanjiku', ship_phone: '0712345678', ship_address: 'Kilimani, Nairobi', payment_method: 'mpesa', mpesa_code: 'qgh7abcd12' }, '/checkout');
  assert.equal(done.status, 302);
  const order = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
  assert.equal(order.total, 8000); assert.equal(order.mpesa_code, 'QGH7ABCD12'); assert.equal(order.payment_status, 'unpaid');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=4').get().stock, before - 2);
  assert.match((await c.get(done.location)).text, /KES 8,000/);
  assert.match((await c.get('/cart')).text, /empty/);

  // cancelling restores stock; another user can't see the order
  await c.postWithToken('/orders/' + order.id + '/cancel', {}, done.location);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=4').get().stock, before);
  const other = client();
  await other.postWithToken('/register', { username: 'other', email: 'o@example.com', password: 'password123', confirm: 'password123' }, '/register');
  assert.equal((await other.get('/orders/' + order.id)).status, 404, 'orders are private');
});

test('cannot oversell the last items', async () => {
  const c = client();
  await c.postWithToken('/login', { email: 'w@example.com', password: 'password123' }, '/login');
  await c.postWithToken('/cart/add', { product_id: 5, qty: 5 });
  db.prepare('UPDATE products SET stock = 1 WHERE id = 5').run();           // someone else bought most of them
  const r = await c.postWithToken('/checkout', { ship_name: 'W', ship_phone: '0712345678', ship_address: 'Nairobi CBD', payment_method: 'cod' }, '/cart');
  assert.ok(r.status === 302 && r.location === '/cart' || r.status === 400, 'blocked before ordering');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE total = 25000").get().n, 0);
});

test('admin: protected, login, manage taxonomy/products with image upload, update orders', async () => {
  assert.equal((await client().get('/admin')).status, 302);
  assert.equal((await client().get('/admin/products')).status, 302);

  const a = client();
  assert.equal((await a.postWithToken('/admin/login', { email: 'boss@example.com', password: 'nope' }, '/admin/login')).status, 401);
  assert.equal((await a.postWithToken('/admin/login', { email: 'boss@example.com', password: 'correct-horse-battery' }, '/admin/login')).location, '/admin');
  assert.match((await a.get('/admin')).text, /Paid revenue/);

  // a normal customer session is not an admin session
  const cust = client();
  await cust.postWithToken('/login', { email: 'w@example.com', password: 'password123' }, '/login');
  assert.equal((await cust.get('/admin')).status, 302);

  await a.postWithToken('/admin/brands', { title: 'Veja' }, '/admin/brands');
  assert.match((await a.get('/admin/brands')).text, /value="Veja"/);

  // multipart upload (CSRF token travels in the query string)
  const tok = await a.token('/admin/products/new');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const build = (type = 'image/png', name = 'x.png') => {
    const fd = new FormData();
    fd.set('title', 'Test Loafer <b>'); fd.set('description', 'desc'); fd.set('price', '1800'); fd.set('stock', '4'); fd.set('category_id', '3'); fd.set('brand_id', '7');
    fd.set('image1', new Blob([png], { type }), name);
    return fd;
  };
  assert.equal((await a.multipart('/admin/products', build())).status, 403, 'upload without CSRF token rejected');
  const bad = await a.multipart('/admin/products?_csrf=' + tok, build('text/html', 'evil.html'));
  assert.equal(bad.status, 302); assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE title LIKE 'Test Loafer%'").get().n, 0, 'non-image rejected');
  const made = await a.multipart('/admin/products?_csrf=' + tok, build());
  assert.match(made.location, /^\/admin\/products\/\d+\/edit$/);
  const prod = db.prepare("SELECT * FROM products WHERE title LIKE 'Test Loafer%'").get();
  assert.match(prod.image1, /^\/uploads\/[a-f0-9]{24}\.png$/);
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(prod.image1))), 'file saved');
  assert.equal((await client().get(prod.image1)).status, 200, 'uploaded image is served');
  assert.match((await client().get('/products/' + prod.id)).text, /Test Loafer &lt;b&gt;/, 'title is HTML-escaped');

  // validation: negative price
  const neg = build(); neg.set('price', '-5');
  assert.equal((await a.multipart('/admin/products?_csrf=' + tok, neg)).status, 400);

  // order management: mark paid + cancel restores stock
  const c = client();
  await c.postWithToken('/login', { email: 'w@example.com', password: 'password123' }, '/login');
  await c.postWithToken('/cart/add', { product_id: 6, qty: 2 });
  const placed = await c.postWithToken('/checkout', { ship_name: 'W', ship_phone: '0712345678', ship_address: 'Nairobi CBD', payment_method: 'cod' }, '/checkout');
  const oid = Number(placed.location.split('/').pop());
  const stockAfter = db.prepare('SELECT stock FROM products WHERE id=6').get().stock;
  await a.postWithToken(`/admin/orders/${oid}`, { status: 'delivered', payment_status: 'paid' }, `/admin/orders/${oid}`);
  assert.deepEqual({ ...db.prepare('SELECT status, payment_status FROM orders WHERE id=?').get(oid) }, { status: 'delivered', payment_status: 'paid' });
  assert.match((await a.get('/admin')).text, /KES 3,000/, 'revenue counts paid orders');

  await c.postWithToken('/cart/add', { product_id: 6, qty: 1 });
  const o2 = await c.postWithToken('/checkout', { ship_name: 'W', ship_phone: '0712345678', ship_address: 'Nairobi CBD', payment_method: 'cod' }, '/checkout');
  const oid2 = Number(o2.location.split('/').pop());
  await a.postWithToken(`/admin/orders/${oid2}`, { status: 'cancelled', payment_status: 'unpaid' }, `/admin/orders/${oid2}`);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=6').get().stock, stockAfter, 'admin cancel restores stock');
  await a.postWithToken(`/admin/orders/${oid2}`, { status: 'pending', payment_status: 'unpaid' }, `/admin/orders/${oid2}`);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(oid2).status, 'cancelled', 'cancelled stays cancelled');

  // deleting a product keeps order history; deleting the uploaded product removes its file
  await a.postWithToken(`/admin/products/${prod.id}/delete`, {}, '/admin/products');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products WHERE id=?').get(prod.id).n, 0);
  await a.postWithToken('/admin/products/6/delete', {}, '/admin/products');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM order_items WHERE title = ?').get('Cork Sandals').n >= 1, 'order lines survive product deletion');
  assert.match((await c.get('/orders/' + oid)).text, /Cork Sandals/);

  // admin logout
  await a.postWithToken('/admin/logout', {}, '/admin');
  assert.equal((await a.get('/admin')).status, 302);
});

test('login is rate limited', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 12; i++) last = await c.postWithToken('/login', { email: 'ratelimit@example.com', password: 'x' + i }, '/login');
  assert.equal(last.status, 429);
});
