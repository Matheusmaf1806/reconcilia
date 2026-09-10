const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  console.warn('[warn] DATABASE_URL (or POSTGRES_URL) is not set. Database calls will fail until you add it to .env');
}

// A single pooled connection reused across warm serverless invocations.
// Keep the pool small - serverless functions run many short-lived instances,
// so a large per-instance pool can exhaust your database's connection limit.
// If your provider offers a "pooled" connection string (Neon, Vercel Postgres,
// Supabase's pgbouncer URL), use that here instead of the direct one.
const pool = new Pool({
  connectionString,
  ssl: connectionString && !/localhost|127\.0\.0\.1/.test(connectionString)
    ? { rejectUnauthorized: false }
    : false,
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    `);
  }
  return schemaReady;
}

async function createOrder(order) {
  await ensureSchema();
  const result = await pool.query(
    `INSERT INTO orders (
      package_name, price_cents, note,
      recipient_name, recipient_phone, recipient_address, recipient_city, recipient_state, recipient_zip,
      delivery_date, delivery_window,
      sender_name, sender_email, sender_phone
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING id`,
    [
      order.package_name, order.price_cents, order.note,
      order.recipient_name, order.recipient_phone, order.recipient_address, order.recipient_city, order.recipient_state, order.recipient_zip,
      order.delivery_date, order.delivery_window,
      order.sender_name, order.sender_email, order.sender_phone,
    ]
  );
  return result.rows[0].id;
}

async function attachStripeSession(orderId, sessionId) {
  await ensureSchema();
  await pool.query(
    `UPDATE orders SET stripe_session_id = $1, updated_at = now() WHERE id = $2`,
    [sessionId, orderId]
  );
}

async function markPaidBySessionId(sessionId, { paymentIntentId, amountTotal, currency }) {
  await ensureSchema();
  await pool.query(
    `UPDATE orders
     SET status = 'paid', stripe_payment_intent_id = $1, amount_total = $2, currency = $3, updated_at = now()
     WHERE stripe_session_id = $4`,
    [paymentIntentId, amountTotal, currency, sessionId]
  );
}

async function markStatusBySessionId(sessionId, status) {
  await ensureSchema();
  await pool.query(
    `UPDATE orders SET status = $1, updated_at = now() WHERE stripe_session_id = $2`,
    [status, sessionId]
  );
}

async function getOrderById(id) {
  await ensureSchema();
  const result = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getOrderBySessionId(sessionId) {
  await ensureSchema();
  const result = await pool.query(`SELECT * FROM orders WHERE stripe_session_id = $1`, [sessionId]);
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
  attachStripeSession,
  markPaidBySessionId,
  markStatusBySessionId,
  getOrderById,
  getOrderBySessionId,
  listOrders,
};
