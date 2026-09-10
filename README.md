# reconcilia

Landing page + checkout + admin panel for **reconcilia**, a same-day gift box
delivery service for the Orlando, FL area. Built on top of the original
marketing page design, wired to a real backend so it can actually take orders
and get paid — deployable on Vercel.

## What's included

- **Landing page** (`public/index.html`) — the original design, with a
  4-step checkout modal bolted on: **Box → Delivery → Message → Pay**. Every
  "buy" entry point on the page opens it; no scrolling around the page is
  needed to complete an order. A sticky bottom button always resumes exactly
  where the customer left off. Fully localized (EN/ES/PT).
- **Checkout** — the card form (Stripe Elements' Payment Element) is embedded
  directly in the last step, styled to match the site. There is no redirect
  to a separate Stripe-hosted page; the only time the browser leaves is the
  rare case where a card requires 3D Secure authentication, and it returns
  right back to `success.html`. We never see or store card numbers — Stripe's
  iframe handles that entirely.
- **Backend** (`server/`) — Node.js + Express + Postgres. Validates orders,
  creates a Stripe PaymentIntent per order, and listens for the
  `payment_intent.succeeded` webhook to mark it paid. Runs as a normal server
  locally (`server/index.js`) and as a Vercel serverless function in
  production (`api/index.js`) from the same Express app (`server/app.js`).
- **Admin panel** (`/admin`, protected by HTTP basic auth) — a list of every
  order (paid, pending, expired) with revenue stats, and a detail view per
  order showing the package, the recipient's address, the delivery window,
  the sender's contact info, and the gift note ("carta").
- **Meta Pixel + Conversions API** — tracks ViewContent, InitiateCheckout,
  AddPaymentInfo and Purchase, each fired from the browser (Pixel) and, for
  the two events ad platforms weight most, mirrored server-side (Conversions
  API) so a blocked pixel or a lost connection doesn't lose the conversion.
  See [Meta Pixel + Conversions API](#meta-pixel--conversions-api) below.

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
STRIPE_SECRET_KEY=sk_test_...          # from https://dashboard.stripe.com/test/apikeys
STRIPE_PUBLISHABLE_KEY=pk_test_...     # same page - this one is safe to expose to the browser
STRIPE_WEBHOOK_SECRET=whsec_...        # see below
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

1. Open `http://localhost:3000` and click any "buy" button — the checkout
   modal opens. Step through: pick a box, check ZIP `32801` and pick a
   day/time, write a message, fill in the delivery + your details.
2. On the last step, the card form is right there in the modal. Use Stripe's
   test card `4242 4242 4242 4242`, any future expiry, any CVC, then click
   Pay — you'll see the confirmation right in the modal, no redirect.
3. Open `http://localhost:3000/admin` (login with `ADMIN_USER`/`ADMIN_PASSWORD`)
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
| `STRIPE_SECRET_KEY` | Your live (or test) secret key from the Stripe Dashboard |
| `STRIPE_PUBLISHABLE_KEY` | The matching publishable key (same page) — powers the embedded card form |
| `STRIPE_WEBHOOK_SECRET` | See step 4 below |
| `PUBLIC_BASE_URL` | `https://your-project.vercel.app` (or your custom domain) |
| `ADMIN_USER` | Whatever you want to log into `/admin` with |
| `ADMIN_PASSWORD` | A strong password — this protects real customer data |
| `META_PIXEL_ID` | Optional — your Meta Pixel ID, to enable ad tracking |
| `META_ACCESS_TOKEN` | Optional — Conversions API access token (required alongside `META_PIXEL_ID`) |
| `META_TEST_EVENT_CODE` | Optional — only while verifying events in the Test Events tool |

Redeploy after adding these (Vercel doesn't apply new env vars to an
already-built deployment).

### 4. Point a Stripe webhook at your deployed URL

In the [Stripe Dashboard](https://dashboard.stripe.com/webhooks) → **Add
endpoint**:
- URL: `https://your-project.vercel.app/api/webhook`
- Events: `payment_intent.succeeded` (optionally also `payment_intent.payment_failed`
  and `payment_intent.canceled` to track those states)

Stripe shows you a signing secret (`whsec_...`) — put that in the
`STRIPE_WEBHOOK_SECRET` env var on Vercel and redeploy.

### 5. Test it for real

Place a test order on your live URL with Stripe's test card
`4242 4242 4242 4242` right in the embedded card form, then check
`https://your-project.vercel.app/admin` — the order should show up as
"paid" within a couple seconds of completing checkout.

### Custom domain

Add it under **Settings → Domains** in Vercel, then update `PUBLIC_BASE_URL`
to match and redeploy (it's used to build the Stripe success/cancel links).

## Meta Pixel + Conversions API

Both the browser Pixel and the server-side Conversions API (CAPI) are wired
up, sharing the same event IDs so Meta deduplicates each conversion down to
one — this is what Meta calls "dual tracking" and it's the recommended setup:
the Pixel alone loses events to ad blockers, Safari's tracking prevention,
and customers who close the tab before the confirmation page loads; CAPI
alone has worse match quality without the Pixel's first-party cookie. Nothing
is tracked, and no code changes are needed, unless `META_PIXEL_ID` is set —
leaving it unset is a complete no-op.

| Event | Fired from the browser (Pixel) when… | Also fired server-side (CAPI)? |
|---|---|---|
| `PageView` | Every page loads | No |
| `ViewContent` | A box is selected (landing page or step 1) | No |
| `InitiateCheckout` | The checkout modal opens | No |
| `AddPaymentInfo` | The order is saved and the card form loads (step 5) | Yes — from `POST /api/create-payment-intent` |
| `Purchase` | Payment confirms with no redirect, or on `success.html` after a 3D Secure redirect | Yes — from the `payment_intent.succeeded` webhook (the authoritative copy) |

`AddPaymentInfo` and `Purchase` use a deterministic `event_id`
(`addpayinfo_<orderId>` / `purchase_<orderId>`) on both the Pixel call and the
CAPI call, which is how Meta knows they're the same event rather than two
separate conversions. `ViewContent`/`InitiateCheckout` are Pixel-only — for
top-of-funnel events, browser-side loss is an acceptable trade-off and Meta's
own guidance prioritizes CAPI coverage for `AddPaymentInfo`/`Purchase`.

The CAPI request includes whatever it can for match quality: the sender's
email and phone (SHA-256 hashed, never sent in plaintext), the `_fbp`/`_fbc`
ad-attribution cookies the Pixel already set on the customer's browser, and
their IP/user-agent captured at order-creation time (`server/meta-capi.js`,
`server/db.js`'s `fbp`/`fbc`/`client_ip`/`client_user_agent` columns). A
failed or skipped Meta API call never breaks checkout — it's fire-and-forget,
wrapped in its own `try`/`catch`.

### Setup

1. In [Meta Events Manager](https://business.facebook.com/events_manager2) →
   **Data Sources** → your pixel → **Settings**, copy the **Pixel ID**.
2. Same page → **Conversions API** → **Generate access token**, copy it.
3. Add both as `META_PIXEL_ID` and `META_ACCESS_TOKEN` (see the env var table
   above for Vercel, or `.env` locally) and redeploy/restart.
4. Optional: Events Manager → **Test Events** shows a code — set it as
   `META_TEST_EVENT_CODE` to watch events arrive live while you test a
   checkout, then remove it so real traffic isn't tagged as a test.
5. Events Manager → **Diagnostics** will flag any event with match-quality or
   deduplication issues if something isn't wired up right.

## How pricing works

Prices are defined **server-side only**, in `server/packages.js`. The
client never gets to set a price — `POST /api/create-payment-intent` always
looks up the price from the order's package name before creating the
PaymentIntent. To change prices or add a box, edit `server/packages.js`, the
`PRICES` map inside `public/index.html`'s checkout script, and the package
cards' / modal box-choice markup in the same file.

## Security notes

- Card data never touches this server — the Payment Element is Stripe's own
  iframe, embedded in the page but isolated from it (PCI SAQ A eligible),
  even though it's styled to match the site.
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
  meta-capi.js   Meta Conversions API client (server-side event tracking)
  packages.js    Source of truth for box names/prices
admin-panel/
  index.html     Admin UI (served only behind basic auth, not under public/)
public/
  index.html     The landing page + checkout modal
  success.html   Fallback confirmation page for the rare 3D Secure redirect
  images/        Product photos
vercel.json      Routes /api/* and /admin* to the serverless function
```
