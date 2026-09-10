const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'orders.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`);

function createOrder(order) {
  const stmt = db.prepare(`
    INSERT INTO orders (
      package_name, price_cents, note,
      recipient_name, recipient_phone, recipient_address, recipient_city, recipient_state, recipient_zip,
      delivery_date, delivery_window,
      sender_name, sender_email, sender_phone
    ) VALUES (
      @package_name, @price_cents, @note,
      @recipient_name, @recipient_phone, @recipient_address, @recipient_city, @recipient_state, @recipient_zip,
      @delivery_date, @delivery_window,
      @sender_name, @sender_email, @sender_phone
    )
  `);
  const info = stmt.run(order);
  return info.lastInsertRowid;
}

function attachStripeSession(orderId, sessionId) {
  db.prepare(`UPDATE orders SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(sessionId, orderId);
}

function markPaidBySessionId(sessionId, { paymentIntentId, amountTotal, currency }) {
  db.prepare(`
    UPDATE orders
    SET status = 'paid', stripe_payment_intent_id = ?, amount_total = ?, currency = ?, updated_at = datetime('now')
    WHERE stripe_session_id = ?
  `).run(paymentIntentId, amountTotal, currency, sessionId);
}

function markStatusBySessionId(sessionId, status) {
  db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE stripe_session_id = ?`)
    .run(status, sessionId);
}

function getOrderById(id) {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
}

function getOrderBySessionId(sessionId) {
  return db.prepare(`SELECT * FROM orders WHERE stripe_session_id = ?`).get(sessionId);
}

function listOrders() {
  return db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all();
}

module.exports = {
  db,
  createOrder,
  attachStripeSession,
  markPaidBySessionId,
  markStatusBySessionId,
  getOrderById,
  getOrderBySessionId,
  listOrders,
};
