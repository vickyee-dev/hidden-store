import { Router } from 'express';
import { db } from '../db.js';
import { toInt, clean } from '../util.js';

const r = Router();
const PAGE_SIZE = 9;
const SORTS = {
  newest: ['Newest', 'p.id DESC'],
  price_asc: ['Price: low to high', 'p.price ASC, p.id DESC'],
  price_desc: ['Price: high to low', 'p.price DESC, p.id DESC'],
  name: ['Name A–Z', 'p.title COLLATE NOCASE ASC'],
};
const BASE = `FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id`;

r.get('/', (req, res) => {
  const featured = db.prepare(`SELECT p.*, b.title AS brand ${BASE} ORDER BY p.id DESC LIMIT 6`).all();
  const categories = db.prepare(`SELECT c.*, COUNT(p.id) AS n FROM categories c
    LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id HAVING n > 0 ORDER BY c.title`).all();
  res.view('home', { featured, categories });
});

r.get('/products', (req, res) => {
  const q = clean(req.query.q, 80);
  const category = toInt(req.query.category);
  const brand = toInt(req.query.brand);
  const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';

  const where = [], args = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(`(p.title LIKE ? ESCAPE '\\' OR p.keywords LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`);
    args.push(like, like, like);
  }
  if (Number.isInteger(category)) { where.push('p.category_id = ?'); args.push(category); }
  if (Number.isInteger(brand)) { where.push('p.brand_id = ?'); args.push(brand); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n ${BASE} ${clause}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(toInt(req.query.page, 1), 1), pages);
  const products = db.prepare(`SELECT p.*, b.title AS brand, c.title AS category ${BASE} ${clause}
    ORDER BY ${SORTS[sort][1]} LIMIT ? OFFSET ?`).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (Number.isInteger(category)) params.set('category', category);
  if (Number.isInteger(brand)) params.set('brand', brand);
  if (sort !== 'newest') params.set('sort', sort);

  res.view('products', {
    title: q ? `Search: ${q}` : 'Shoes',
    products, total, page, pages, q, sort, sorts: SORTS,
    category: Number.isInteger(category) ? category : null,
    brand: Number.isInteger(brand) ? brand : null,
    categories: db.prepare('SELECT * FROM categories ORDER BY title').all(),
    brands: db.prepare('SELECT * FROM brands ORDER BY title').all(),
    qs: params.toString(),
  });
});

r.get('/products/:id', (req, res, next) => {
  const product = db.prepare(`SELECT p.*, b.title AS brand, c.title AS category ${BASE} WHERE p.id = ?`).get(toInt(req.params.id, -1));
  if (!product) return next();
  const related = db.prepare(`SELECT p.*, b.title AS brand ${BASE}
    WHERE p.id != ? AND (p.category_id = ? OR p.brand_id = ?) ORDER BY RANDOM() LIMIT 3`)
    .all(product.id, product.category_id ?? -1, product.brand_id ?? -1);
  res.view('product', { title: product.title, product, related, images: [product.image1, product.image2, product.image3].filter(Boolean) });
});

export default r;
