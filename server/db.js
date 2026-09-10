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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Safe to re-run: adds columns for databases created before they existed.
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_token TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fbp TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fbc TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_ip TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_user_agent TEXT;

      CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    `);
  }
  return schemaReady;
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
};
