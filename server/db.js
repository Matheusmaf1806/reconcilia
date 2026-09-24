const crypto = require('crypto');
const { Pool } = require('pg');

const rawConnectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!rawConnectionString) {
  console.warn('[warn] DATABASE_URL (or POSTGRES_URL) is not set. Database calls will fail until you add it to .env');
}

const isLocal = rawConnectionString && /localhost|127\.0\.0\.1/.test(rawConnectionString);

// Providers like Supabase append `?sslmode=require` to their connection
// string. `pg` also parses that query param itself, and depending on the
// installed version it can win over the `ssl` option below - silently
// re-enabling strict certificate validation and causing "self-signed
// certificate in certificate chain" even though we asked it not to verify.
// Stripping it here means our explicit `ssl` option is the only thing that
// decides how the connection is secured.
let connectionString = rawConnectionString;
if (rawConnectionString && !isLocal) {
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('ssl');
    connectionString = url.toString();
  } catch {
    // Not a parseable URL (e.g. already malformed) - fall back to it as-is.
  }
}

// A single pooled connection reused across warm serverless invocations.
// Keep the pool small - serverless functions run many short-lived instances,
// so a large per-instance pool can exhaust your database's connection limit.
// If your provider offers a "pooled" connection string (Neon, Vercel Postgres,
// Supabase's pgbouncer URL), use that here instead of the direct one.
const pool = new Pool({
  connectionString,
  ssl: connectionString && !isLocal ? { rejectUnauthorized: false } : false,
  max: 5,
});

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        package_name TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        note TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        recipient_phone TEXT,
        recipient_address TEXT NOT NULL,
        recipient_city TEXT,
        recipient_state TEXT,
        recipient_zip TEXT NOT NULL,
        delivery_date TEXT,
        delivery_window TEXT,
        sender_name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_phone TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        stripe_session_id TEXT,
        stripe_payment_intent_id TEXT,
        amount_total INTEGER,
        currency TEXT,
        client_token TEXT,
        fbp TEXT,
        fbc TEXT,
        client_ip TEXT,
        client_user_agent TEXT,
        fulfillment_status TEXT NOT NULL DEFAULT 'received',
        abandoned_email_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Safe to re-run: adds columns for databases created before they existed.
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_token TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fbp TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fbc TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_ip TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_user_agent TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'received';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS abandoned_email_sent_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

      -- Anonymous funnel tracking: one row per browser tab session, holding
      -- only the furthest checkout step reached and time on page - no name,
      -- email or address. Lets the admin panel show drop-off without waiting
      -- for an order (most visitors never create one) to exist.
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        furthest_step INTEGER NOT NULL DEFAULT 0,
        package_name TEXT,
        zip_checked TEXT,
        seconds_on_page INTEGER NOT NULL DEFAULT 0,
        order_id INTEGER,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS zip_checked TEXT;
      -- First-touch attribution: captured once from the landing URL (UTM
      -- params, or fbclid as a fallback for ad clicks that arrive without
      -- manual UTM tagging) and never overwritten by a later, source-less ping.
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_source TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_medium TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_content TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_term TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fbclid TEXT;
      -- Which page the visitor entered through ('home' or 'quiz'), plus the
      -- quiz's own anonymous answers (who it's for, why, desired feeling).
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS entry_page TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_recipient TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_reason TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_feeling TEXT;
      CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);
    `);
  }
  return schemaReady;
}

// Funnel steps, in order - shared with the client so both sides agree on
// what each number means:
// 0 landed (page loaded, modal never opened)   4 details filled in
// 1 box chosen                                 5 reached payment
// 2 delivery checked                           6 purchased
// 3 message written
const FUNNEL_STEPS = ['Landed', 'Box', 'Delivery', 'Message', 'Details', 'Pay', 'Purchased'];

// Upserted repeatedly as a visitor moves through the funnel (roughly every
// step change, plus a heartbeat while the tab stays open). GREATEST/COALESCE
// make it safe for pings to arrive out of order or restate stale values -
// progress and time on page only ever move forward.
async function upsertSession({
  id, furthestStep, packageName, zipChecked, secondsOnPage, orderId,
  utmSource, utmMedium, utmCampaign, utmContent, utmTerm, fbclid,
  entryPage, quizRecipient, quizReason, quizFeeling,
}) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO sessions (
       id, furthest_step, package_name, zip_checked, seconds_on_page, order_id,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
       entry_page, quiz_recipient, quiz_reason, quiz_feeling,
       first_seen_at, last_seen_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       furthest_step = GREATEST(sessions.furthest_step, EXCLUDED.furthest_step),
       package_name = COALESCE(EXCLUDED.package_name, sessions.package_name),
       zip_checked = COALESCE(EXCLUDED.zip_checked, sessions.zip_checked),
       seconds_on_page = GREATEST(sessions.seconds_on_page, EXCLUDED.seconds_on_page),
       order_id = COALESCE(EXCLUDED.order_id, sessions.order_id),
       utm_source = COALESCE(sessions.utm_source, EXCLUDED.utm_source),
       utm_medium = COALESCE(sessions.utm_medium, EXCLUDED.utm_medium),
       utm_campaign = COALESCE(sessions.utm_campaign, EXCLUDED.utm_campaign),
       utm_content = COALESCE(sessions.utm_content, EXCLUDED.utm_content),
       utm_term = COALESCE(sessions.utm_term, EXCLUDED.utm_term),
       fbclid = COALESCE(sessions.fbclid, EXCLUDED.fbclid),
       entry_page = COALESCE(sessions.entry_page, EXCLUDED.entry_page),
       quiz_recipient = COALESCE(EXCLUDED.quiz_recipient, sessions.quiz_recipient),
       quiz_reason = COALESCE(EXCLUDED.quiz_reason, sessions.quiz_reason),
       quiz_feeling = COALESCE(EXCLUDED.quiz_feeling, sessions.quiz_feeling),
       last_seen_at = now()`,
    [
      id, furthestStep, packageName || null, zipChecked || null, secondsOnPage, orderId || null,
      utmSource || null, utmMedium || null, utmCampaign || null, utmContent || null, utmTerm || null, fbclid || null,
      entryPage || null, quizRecipient || null, quizReason || null, quizFeeling || null,
    ]
  );
}

async function listSessions(limit = 200) {
  await ensureSchema();
  const result = await pool.query(
    `SELECT sessions.*, orders.status AS order_status
     FROM sessions
     LEFT JOIN orders ON orders.id = sessions.order_id
     ORDER BY sessions.last_seen_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getFunnelStats() {
  await ensureSchema();
  const [countsResult, avgResult, packagesResult] = await Promise.all([
    pool.query(`SELECT furthest_step, COUNT(*)::int AS count FROM sessions GROUP BY furthest_step`),
    pool.query(`SELECT ROUND(AVG(seconds_on_page))::int AS avg_seconds, COUNT(*)::int AS total FROM sessions`),
    // Per-package view: of everyone who ever had this box selected (however
    // briefly - package_name reflects whichever box they most recently had
    // picked), how many went on to buy it. Separate from the step funnel
    // above, which lumps every box together.
    pool.query(`
      SELECT package_name,
        COUNT(*)::int AS chosen,
        COUNT(*) FILTER (WHERE furthest_step = 6)::int AS purchased
      FROM sessions
      WHERE package_name IS NOT NULL
      GROUP BY package_name
      ORDER BY chosen DESC
    `),
  ]);
  const countByStep = {};
  countsResult.rows.forEach(r => { countByStep[r.furthest_step] = r.count; });
  // A visitor who reached step N also passed through every step before it,
  // so each step's total is its own count plus everyone who went further.
  const steps = FUNNEL_STEPS.map((label, i) => {
    const reachedOrPast = FUNNEL_STEPS.reduce((sum, _, j) => (j >= i ? sum + (countByStep[j] || 0) : sum), 0);
    return { step: i, label, count: reachedOrPast };
  });
  return {
    steps,
    totalSessions: avgResult.rows[0].total || 0,
    avgSecondsOnPage: avgResult.rows[0].avg_seconds || 0,
    packages: packagesResult.rows.map(r => ({ packageName: r.package_name, chosen: r.chosen, purchased: r.purchased })),
  };
}

async function createOrder(order) {
  await ensureSchema();
  const clientToken = crypto.randomBytes(20).toString('hex');
  const result = await pool.query(
    `INSERT INTO orders (
      package_name, price_cents, note,
      recipient_name, recipient_phone, recipient_address, recipient_city, recipient_state, recipient_zip,
      delivery_date, delivery_window,
      sender_name, sender_email, sender_phone,
      client_token, fbp, fbc, client_ip, client_user_agent
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING id`,
    [
      order.package_name, order.price_cents, order.note,
      order.recipient_name, order.recipient_phone, order.recipient_address, order.recipient_city, order.recipient_state, order.recipient_zip,
      order.delivery_date, order.delivery_window,
      order.sender_name, order.sender_email, order.sender_phone,
      clientToken, order.fbp, order.fbc, order.client_ip, order.client_user_agent,
    ]
  );
  return { id: result.rows[0].id, clientToken };
}

// Used when a customer goes back and re-submits the details step (e.g. to
// fix a typo before paying) - updates the same pending order in place
// instead of leaving a duplicate row behind. Requires the token handed back
// when the order was created, so a guessed/sequential id alone can't be used
// to overwrite someone else's order. Returns false if the order doesn't
// exist, the token doesn't match, or it's no longer pending (already paid).
async function updatePendingOrder(id, clientToken, order) {
  await ensureSchema();
  const result = await pool.query(
    `UPDATE orders SET
      package_name = $1, price_cents = $2, note = $3,
      recipient_name = $4, recipient_phone = $5, recipient_address = $6, recipient_city = $7, recipient_state = $8, recipient_zip = $9,
      delivery_date = $10, delivery_window = $11,
      sender_name = $12, sender_email = $13, sender_phone = $14,
      fbp = $15, fbc = $16, client_ip = $17, client_user_agent = $18,
      updated_at = now()
    WHERE id = $19 AND client_token = $20 AND status = 'pending'
    RETURNING id`,
    [
      order.package_name, order.price_cents, order.note,
      order.recipient_name, order.recipient_phone, order.recipient_address, order.recipient_city, order.recipient_state, order.recipient_zip,
      order.delivery_date, order.delivery_window,
      order.sender_name, order.sender_email, order.sender_phone,
      order.fbp, order.fbc, order.client_ip, order.client_user_agent,
      id, clientToken,
    ]
  );
  return result.rows.length > 0;
}

// The fulfillment lifecycle an order moves through after payment - separate
// from `status` (which only tracks payment: pending/paid/failed/canceled).
const FULFILLMENT_STATUSES = ['received', 'preparing', 'in_transit', 'delivered'];

async function updateFulfillmentStatus(id, fulfillmentStatus) {
  await ensureSchema();
  const result = await pool.query(
    `UPDATE orders SET fulfillment_status = $1, updated_at = now() WHERE id = $2 RETURNING id`,
    [fulfillmentStatus, id]
  );
  return result.rows.length > 0;
}

// Orders left pending (or failed) long enough that the customer probably
// isn't coming right back, who haven't already gotten a reminder. Capped so
// one cron run can't try to send an unbounded number of emails.
async function getAbandonedOrders(minMinutesOld, limit = 50) {
  await ensureSchema();
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE status IN ('pending', 'failed')
       AND abandoned_email_sent_at IS NULL
       AND created_at <= now() - ($1 || ' minutes')::interval
     ORDER BY created_at ASC
     LIMIT $2`,
    [minMinutesOld, limit]
  );
  return result.rows;
}

async function markAbandonedCartEmailSent(id) {
  await ensureSchema();
  await pool.query(`UPDATE orders SET abandoned_email_sent_at = now() WHERE id = $1`, [id]);
}

async function attachPaymentIntent(orderId, paymentIntentId) {
  await ensureSchema();
  await pool.query(
    `UPDATE orders SET stripe_payment_intent_id = $1, updated_at = now() WHERE id = $2`,
    [paymentIntentId, orderId]
  );
}

async function markPaidByPaymentIntentId(paymentIntentId, { amountReceived, currency }) {
  await ensureSchema();
  await pool.query(
    `UPDATE orders
     SET status = 'paid', amount_total = $1, currency = $2, updated_at = now()
     WHERE stripe_payment_intent_id = $3`,
    [amountReceived, currency, paymentIntentId]
  );
}

async function markStatusByPaymentIntentId(paymentIntentId, status) {
  await ensureSchema();
  await pool.query(
    `UPDATE orders SET status = $1, updated_at = now() WHERE stripe_payment_intent_id = $2`,
    [status, paymentIntentId]
  );
}

async function getOrderById(id) {
  await ensureSchema();
  const result = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getOrderByPaymentIntentId(paymentIntentId) {
  await ensureSchema();
  const result = await pool.query(`SELECT * FROM orders WHERE stripe_payment_intent_id = $1`, [paymentIntentId]);
  return result.rows[0] || null;
}

async function listOrders() {
  await ensureSchema();
  const result = await pool.query(`SELECT * FROM orders ORDER BY created_at DESC`);
  return result.rows;
}

module.exports = {
  pool,
  createOrder,
  updatePendingOrder,
  attachPaymentIntent,
  markPaidByPaymentIntentId,
  markStatusByPaymentIntentId,
  getOrderById,
  getOrderByPaymentIntentId,
  listOrders,
  upsertSession,
  listSessions,
  getFunnelStats,
  FULFILLMENT_STATUSES,
  updateFulfillmentStatus,
  getAbandonedOrders,
  markAbandonedCartEmailSent,
};
