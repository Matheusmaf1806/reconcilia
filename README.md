# reconcilia

Landing page + checkout + admin panel for **reconcilia**, a same-day gift box
delivery service for the Orlando, FL area. Built on top of the original
marketing page design, wired to a real backend so it can actually take orders
and get paid — deployable on Vercel.

## What's included

- **Landing page** (`public/index.html`) — the original design, with a real
  guided checkout flow bolted on: pick a box → check delivery ZIP/day/time →
  write your note → fill in recipient + your details → pay with Stripe.
  A sticky bottom bar always shows the next step and the running total.
  Fully localized (EN/ES/PT).
- **Checkout** — Stripe Checkout (hosted, PCI-compliant). We never see or
  store card numbers; Stripe handles that entirely.
- **Backend** (`server/`) — Node.js + Express + Postgres. Validates orders,
  creates Stripe Checkout Sessions, and listens for the `checkout.session.completed`
  webhook to mark orders paid. Runs as a normal server locally (`server/index.js`)
  and as a Vercel serverless function in production (`api/index.js`) from the
  same Express app (`server/app.js`).
- **Admin panel** (`/admin`, protected by HTTP basic auth) — a list of every
  order (paid, pending, expired) with revenue stats, and a detail view per
  order showing the package, the recipient's address, the delivery window,
  the sender's contact info, and the gift note ("carta").

## Quick start (local development)

```bash
npm install
cp .env.example .env
```

You need a Postgres database to develop against — either a local Postgres
install, or a free hosted one (Neon, Supabase, or Vercel Postgres all work).
Edit `.env`:

```
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME
STRIPE_SECRET_KEY=sk_test_...       # from https://dashboard.stripe.com/test/apikeys
STRIPE_WEBHOOK_SECRET=whsec_...     # see below
ADMIN_USER=admin
ADMIN_PASSWORD=pick-a-real-password
```

The `orders` table is created automatically on first request — no migration
step needed.

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

## Deploying to Vercel

This repo is already set up for Vercel: `vercel.json` routes `/api/*` and
`/admin*` to a serverless function (`api/index.js`) that runs the same
Express app used locally, and everything in `public/` is served as static
files. You need to connect three things:

### 1. Import the repo into Vercel

In the Vercel dashboard: **Add New → Project**, import this GitHub repo.
No build command is needed (leave the framework preset as "Other" — Vercel
will detect `vercel.json`).

### 2. Add a Postgres database

Go to your project's **Storage** tab → **Create Database** → **Postgres**
(or connect an existing Neon/Supabase database via **Connect Store**). This
automatically sets a `POSTGRES_URL` environment variable on the project —
`server/db.js` picks it up with no extra config (it checks `DATABASE_URL`
first, then falls back to `POSTGRES_URL`).

If your provider gives you both a direct and a "pooled"/"pgbouncer"
connection string, use the **pooled** one. Serverless functions can spin up
many short-lived instances at once, and a pooled connection string avoids
exhausting your database's connection limit.

### 3. Add the rest of the environment variables

In **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Your live (or test) key from the Stripe Dashboard |
| `STRIPE_WEBHOOK_SECRET` | See step 4 below |
| `PUBLIC_BASE_URL` | `https://your-project.vercel.app` (or your custom domain) |
| `ADMIN_USER` | Whatever you want to log into `/admin` with |
| `ADMIN_PASSWORD` | A strong password — this protects real customer data |

Redeploy after adding these (Vercel doesn't apply new env vars to an
already-built deployment).

### 4. Point a Stripe webhook at your deployed URL

In the [Stripe Dashboard](https://dashboard.stripe.com/webhooks) → **Add
endpoint**:
- URL: `https://your-project.vercel.app/api/webhook`
- Events: `checkout.session.completed` (and optionally `checkout.session.expired`)

Stripe shows you a signing secret (`whsec_...`) — put that in the
`STRIPE_WEBHOOK_SECRET` env var on Vercel and redeploy.

### 5. Test it for real

Place a test order on your live URL with Stripe's test card
`4242 4242 4242 4242`, then check `https://your-project.vercel.app/admin` —
the order should show up as "paid" within a couple seconds of completing
checkout.

### Custom domain

Add it under **Settings → Domains** in Vercel, then update `PUBLIC_BASE_URL`
to match and redeploy (it's used to build the Stripe success/cancel links).

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
- The admin panel is behind HTTP Basic Auth. Use a strong password — Vercel
  serves everything over HTTPS by default, which is required for Basic Auth
  credentials to be sent safely.
- All user-supplied text (the gift note, addresses, names) is stored as-is
  and escaped wherever it's rendered back into HTML (admin panel, success
  page) to avoid XSS.

## Project structure

```
api/
  index.js       Vercel serverless entrypoint - just re-exports server/app.js
server/
  app.js         The Express app: routes, Stripe integration, webhook, admin auth
  index.js       Local dev entrypoint (calls app.listen())
  db.js          Postgres schema + queries (pg)
  packages.js    Source of truth for box names/prices
admin-panel/
  index.html     Admin UI (served only behind basic auth, not under public/)
public/
  index.html     The landing page + checkout flow
  success.html   Post-payment confirmation
  cancel.html    Shown if checkout is canceled
  images/        Product photos
vercel.json      Routes /api/* and /admin* to the serverless function
```
