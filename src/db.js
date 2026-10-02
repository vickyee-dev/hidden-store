import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { ROOT } from './config.js';
const dbPath = process.env.DB_PATH || path.join(ROOT, 'data', 'store.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image1 TEXT NOT NULL,
  image2 TEXT NOT NULL DEFAULT '',
  image3 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invoice TEXT NOT NULL UNIQUE,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  mpesa_code TEXT NOT NULL DEFAULT '',
  ship_name TEXT NOT NULL DEFAULT '',
  ship_phone TEXT NOT NULL,
  ship_address TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

/** Seed catalogue (from the original project's data) and the first admin account. */
export function seed() {
  if (!db.prepare('SELECT 1 FROM products LIMIT 1').get()) {
    const cat = db.prepare('INSERT INTO categories (title) VALUES (?)');
    const brand = db.prepare('INSERT INTO brands (title) VALUES (?)');
    ['New Arrivals', 'Casual Shoes', 'Formal Shoes', 'Boots', 'Sandals', 'Athletic'].forEach((t) => cat.run(t));
    ['Adidas', 'Nike', 'Puma', 'Fila', 'Vans', 'Timberland', 'Bata'].forEach((t) => brand.run(t));

    const P = '/img/products/';
    const ins = db.prepare(`INSERT INTO products
      (title, description, keywords, category_id, brand_id, price, stock, image1, image2, image3)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    // [title, description, keywords, category_id, brand_id, price (KES), stock, image]
    [
      ['Nike Air Force 1 Custom', 'Custom Air Force 1 sneakers with a blood-drip splatter finish in red, black and white.', 'casual wear sneakers nike', 2, 2, 1500, 12, 'Nike_air_force_1.jpg'],
      ['Nike Air Force 1 (Black)', 'Classic Air Force 1 in black with a white logo.', 'nike air force sneakers casual', 2, 2, 2200, 15, 'Nike_air_force_2.jpg'],
      ['Marco Paciotti City Walk', "Men's formal shoes, City Walk LB1192.", 'formal shoes office', 3, 7, 3000, 8, 'formal_shoe1.jpeg'],
      ['Timberland 6-Inch Premium Boot', "Men's 6-inch premium waterproof boot.", 'boots waterproof', 4, 6, 4000, 10, 'boots.jpg'],
      ['Timberland 6-Inch Premium Boot (Black)', "Men's 6-inch premium waterproof boot in black.", 'boots waterproof black', 4, 6, 5000, 6, 'boots1.jpg'],
      ['Cork Sandals', 'African print sandals in yellow with a cork footbed.', 'sandals african print', 5, 5, 1500, 20, 'sandals1.webp'],
      ["Women's Hiking Sandals NH100", "Women's hiking sandals for trails and travel.", 'sandals hiking women', 5, 4, 1500, 14, 'sandals2.avif'],
      ['Puma Run XX Nitro', 'Tried-and-tested running shoe from the Puma Run XX Nitro line.', 'athletic running puma', 6, 3, 3000, 9, 'athletic2.jpeg'],
      ['NikeCourt Air Zoom NXT', "Men's hard-court tennis shoe.", 'athletic tennis nike', 6, 2, 4500, 7, 'athletic1.jpeg'],
    ].forEach(([t, d, k, c, b, price, stock, img]) => ins.run(t, d, k, c, b, price, stock, P + img, '', ''));
  }

  if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      if (process.env.NODE_ENV === 'production') {
        console.warn('[seed] No admin created: set ADMIN_EMAIL and ADMIN_PASSWORD, then restart.');
        return;
      }
      password = 'admin12345';
      console.warn(`[seed] Dev admin created: ${email} / ${password}  (set ADMIN_PASSWORD to change)`);
    }
    db.prepare('INSERT INTO admins (username, email, password_hash) VALUES (?,?,?)')
      .run('admin', email.toLowerCase(), bcrypt.hashSync(password, 10));
  }
}
