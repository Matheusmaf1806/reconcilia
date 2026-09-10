# reconcilia

Landing page + checkout + admin panel for **reconcilia**, a same-day gift box
delivery service for the Orlando, FL area. Built on top of the original
marketing page design, wired to a real backend so it can actually take orders
and get paid.

## What's included

- **Landing page** (`public/index.html`) — the original design, with a real
  guided checkout flow bolted on: pick a box → check delivery ZIP/day/time →
  write your note → fill in recipient + your details → pay with Stripe.
  A sticky bottom bar always shows the next step and the running total.
  Fully localized (EN/ES/PT).
- **Checkout** — Stripe Checkout (hosted, PCI-compliant). We never see or
  store card numbers; Stripe handles that entirely.
- **Backend** (`server/`) — Node.js + Express + SQLite. Validates orders,
  creates Stripe Checkout Sessions, and listens for the `checkout.session.completed`
  webhook to mark orders paid.
- **Admin panel** (`/admin`, protected by HTTP basic auth) — a list of every
  order (paid, pending, expired) with revenue stats, and a detail view per
  order showing the package, the recipient's address, the delivery window,
  the sender's contact info, and the gift note ("carta").

## Quick start

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
STRIPE_SECRET_KEY=sk_test_...       # from https://dashboard.stripe.com/test/apikeys
STRIPE_WEBHOOK_SECRET=whsec_...     # see below
ADMIN_USER=admin
ADMIN_PASSWORD=pick-a-real-password
```

Run the server:

```bash
npm start
# → http://localhost:3000
```

### Wire up the Stripe webhook (local dev)

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then in a
second terminal:

```bash
npm run stripe:listen
```

This prints a `whsec_...` value — put it in `.env` as `STRIPE_WEBHOOK_SECRET`
and restart `npm start`. Now when a test payment completes, Stripe calls your
local server and the order flips to "paid" automatically.

### Try it

1. Open `http://localhost:3000`, pick a box, check ZIP `32801`, pick a day/time,
   fill in the delivery + payment form, click Pay.
2. On Stripe's checkout page use test card `4242 4242 4242 4242`, any future
   expiry, any CVC.
3. You'll land on `/success.html` with your order confirmed.
4. Open `http://localhost:3000/admin` (login with `ADMIN_USER`/`ADMIN_PASSWORD`)
   to see the order, its note, address and delivery window.

## Deploying to production

1. Host the Node app anywhere that runs a long-lived Node process (Render,
   Railway, Fly.io, a VPS, etc.) — this app is not built for serverless
   platforms as-is because it uses a local SQLite file for storage. If you
   deploy to something serverless (Vercel, etc.), swap `server/db.js` for a
   hosted database (e.g. Postgres) first, since serverless filesystems are
   ephemeral.
2. Set real environment variables: `STRIPE_SECRET_KEY` (live key),
   `STRIPE_WEBHOOK_SECRET` (from a webhook endpoint you create in the Stripe
   Dashboard pointing at `https://yourdomain.com/api/webhook`),
   `PUBLIC_BASE_URL=https://yourdomain.com`, and a strong `ADMIN_PASSWORD`.
3. In the Stripe Dashboard, add a webhook endpoint for
   `checkout.session.completed` (and optionally `checkout.session.expired`)
   pointing at `/api/webhook`.
4. Put the app behind HTTPS (required for Stripe and for basic auth to be
   safe).

## How pricing works

Prices are defined **server-side only**, in `server/packages.js`. The
client never gets to set a price — `POST /api/checkout-session` always looks
up the price from the order's package name before creating the Stripe
session. To change prices or add a box, edit `server/packages.js`, the
`PRICES` map inside `public/index.html`'s checkout script, and the package
cards' markup/prices in the same file.

## Security notes

- Card data never touches this server — Stripe Checkout collects it on
  Stripe's own hosted page.
- The webhook endpoint verifies Stripe's signature before trusting any
  "payment completed" event.
- The admin panel is behind HTTP Basic Auth. Use a strong password and only
  serve the site over HTTPS in production (Basic Auth credentials are sent
  on every request).
- All user-supplied text (the gift note, addresses, names) is stored as-is
  and escaped wherever it's rendered back into HTML (admin panel, success
  page) to avoid XSS.

## Project structure

```
server/
  index.js       Express app: routes, Stripe integration, webhook, admin auth
  db.js          SQLite schema + queries
  packages.js    Source of truth for box names/prices
admin-panel/
  index.html     Admin UI (served only behind basic auth, not under public/)
public/
  index.html     The landing page + checkout flow
  success.html   Post-payment confirmation
  cancel.html    Shown if checkout is canceled
data/
  orders.db      SQLite database (created automatically, gitignored)
```
