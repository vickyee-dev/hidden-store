# Hidden Store

A shoe e-commerce site for the Kenyan market: browse and search a catalogue, build a cart, check out with **Pay on delivery** or **M-Pesa**, and manage everything from an admin panel. Prices are in Kenyan shillings (KES).

This is a ground-up rebuild of the original PHP/MySQL project. The features are the same; the code is not. See [What changed](#what-changed-from-the-php-version).

- **Stack:** Node.js 22+, Express 4, EJS templates, SQLite (built into Node — no database server to install)
- **Dependencies:** `express`, `express-session`, `ejs`, `bcryptjs`, `multer` — five in total
- **Front end:** server-rendered HTML with one hand-written stylesheet; no build step, no CDN, works offline

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>. The first start creates `data/store.db`, loads the catalogue (9 shoes, 6 categories, 7 brands) and creates an admin account:

| | |
|---|---|
| Admin panel | <http://localhost:3000/admin> |
| Dev login | `admin@example.com` / `admin12345` |

To choose your own admin credentials, set them before the **first** start (the admin is only created if none exists):

```bash
ADMIN_EMAIL=you@yourshop.co.ke ADMIN_PASSWORDD='a-strong-password' npm start
```

Requires **Node 22.13 or newer** (for the built-in `node:sqlite` module). Node prints an "experimental" warning for it; that is expected.

## Features

**Shop**
- Home page with featured products and category shortcuts
- Product listing with search (title, keywords, description), category and brand filters, sorting, and pagination
- Product page with image gallery, stock status and related products
- Cart stored in the session (works for guests; survives logging in), with quantity limits based on stock
- Checkout with delivery details and a choice of **Pay on delivery** or **M-Pesa** (customer enters their confirmation code)
- Customer accounts: register, log in, edit profile, change password, delete account
- Order history and order detail pages; customers can cancel an order while it is still *pending*

**Admin** (`/admin`)
- Dashboard: paid revenue, order and customer counts, recent orders, low-stock alerts
- Products: create, edit, delete, up to 3 images each, stock levels
- Categories and brands: add, rename, delete
- Orders: filter by status, view details, update order status and mark as paid
- Customers: list and delete

**Order rules**
- Totals are always calculated on the server from current prices. Order lines store a price snapshot, so later price changes or deleted products never alter past orders.
- Stock is reserved atomically when an order is placed, so two shoppers cannot buy the last pair. Cancelling an order (by the customer or an admin) returns the stock.
- Order statuses: `pending → processing → shipped → delivered`, or `cancelled` (final).

## Configuration

Set via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | — | Set to `production` when deploying (see below) |
| `SESSION_SECRET` | random per start | Signs session cookies. **Required in production.** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORDD` | `admin@example.com` / `admin12345` (dev only) | First admin account. **Required in production.** |
| `MPESA_TILL` | — | Till/paybill number shown to customers who choose M-Pesa |
| `DB_PATH` | `./data/store.db` | SQLite file location |
| `UPLOAD_DIR` | `./data/uploads` | Where admin-uploaded product images are stored |

## Project layout

```
server.js               Entry point
src/
  app.js                Express app: middleware, sessions, routes
  config.js             Paths
  db.js                 Schema, seed data, transaction helper
  session-store.js      SQLite-backed session store
  middleware.js         Template locals, CSRF, auth guards, error pages
  cart.js               Cart loading/pricing
  upload.js             Image upload rules (type, size, random filenames)
  util.js               Validation, formatting, rate limiting
  routes/               shop, auth, cart (+checkout), account (+orders), admin
views/                  EJS templates (admin/ for the admin panel)
public/                 CSS and the seeded product images
test/e2e.test.js        End-to-end tests
data/                   Created at runtime: database + uploaded images (git-ignored)
```

## Testing

```bash
npm test
```

The suite boots the real app against an in-memory database and drives it over HTTP: browsing, search/injection attempts, CSRF, cart rules, registration and login, checkout and stock, order privacy, admin access control, image upload validation, order management, and login rate limiting.

## Deploying

1. Set `NODE_ENV=production`, `SESSION_SECRET` (a long random string), `ADMIN_EMAIL` and `ADMIN_PASSWORDD`. The app refuses to start in production without a session secret.
2. Serve it over **HTTPS** (session cookies are marked `Secure` in production). If you're behind a reverse proxy such as Nginx or Caddy, it is already configured to trust one proxy hop.
3. Put `data/` on persistent storage and back it up — it holds the database and uploaded images.
4. Run it with a process manager (systemd, PM2, Docker, …) and `npm start`.

SQLite comfortably handles a small shop on a single server. If you later need multiple servers, the queries are plain SQL in `src/routes/` and `src/db.js`, so moving to PostgreSQL is a contained change.

## What changed from the PHP version

**Security fixes** (the original had these problems throughout):

| Original | Now |
|---|---|
| SQL built by string concatenation (`...where product_id=$id`) — injectable on nearly every page | Every query is parameterised |
| Output echoed unescaped (stored and reflected XSS) | All output is HTML-escaped by the template engine |
| Cart, "who is the user" at payment, and order lookup all keyed on **IP address** — shoppers behind the same Wi-Fi shared a cart, and payment could be attached to the wrong account | Sessions identify the cart and the user |
| `confirm_payment` and `order.php?user_id=` trusted IDs in the URL; anyone could confirm payment or place orders as someone else | Orders are tied to the logged-in session; only admins can mark payment received; customers see only their own orders |
| No CSRF protection; GET links performed actions (add to cart, delete) | Every state-changing action is a POST with a CSRF token |
| Unrestricted file upload names and types | Images only, 3 MB max, random server-generated filenames |
| No login throttling; session id kept across login | Login rate limiting; session id rotated on login/logout |
| A real admin email and password hash, and real customer details, were committed in `mystore.sql` | Not carried over; the admin is created from environment variables |

**Correctness fixes:**
- Quantity was read from an arbitrary row of the cart table, so the order total and quantity were often wrong. Each cart line now has its own quantity.
- Only the *last* cart item was written to the pending-orders table. Orders now store every line.
- Some products had category/brand `0` and two pointed at a category that didn't exist; seed data is repaired (a new **Athletic** category was added).
- Prices were stored as text; they are now integers.

**Added:** stock tracking, real order line items, order status workflow, admin dashboard, pagination and sorting, input validation, responsive layout, accessibility basics (labels, focus states, semantic markup), automated tests.

**Not carried over:** the user profile photo upload, the PayPal button (it only linked to paypal.com and processed nothing), and the Word report in the original repo.

## Extending it

- **M-Pesa STK Push (Daraja):** today the customer pays manually and enters the confirmation code, and an admin marks the order paid after checking. To automate it, add a route that calls Daraja's STK Push when an M-Pesa order is created and a callback route that sets `payment_status = 'paid'`. This needs Safaricom Daraja credentials, which are not included.
- **Email/SMS notifications:** send from the checkout route after the order is created, and from the admin order-update route.
- **Delivery fees:** add a `delivery_fee` column to `orders` and include it in the total in `src/routes/cart.js`.

## Licence

MIT
