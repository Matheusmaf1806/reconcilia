-- reconcilia — orders table
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).
-- The app also creates this automatically on first request if it's missing,
-- but running it here up front removes any doubt.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
