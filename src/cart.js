import { db } from './db.js';

export const MAX_PER_ITEM = 10;

/** The cart lives in the session as { [productId]: quantity }. Prices always come from the DB. */
export function loadCart(req) {
  const cart = req.session.cart || {};
  const ids = Object.keys(cart).map(Number).filter(Number.isInteger);
  if (!ids.length) return { items: [], total: 0, count: 0, problems: 0 };
  const rows = db.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const found = new Set(rows.map((p) => p.id));
  for (const id of ids) if (!found.has(id)) delete cart[id]; // product was deleted
  const items = rows.map((product) => {
    const qty = cart[product.id];
    return { product, qty, line: product.price * qty, short: qty > product.stock };
  });
  return {
    items,
    total: items.reduce((s, i) => s + i.line, 0),
    count: items.reduce((s, i) => s + i.qty, 0),
    problems: items.filter((i) => i.short).length,
  };
}
