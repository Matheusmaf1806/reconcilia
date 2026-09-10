require('dotenv').config();

const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');
const Stripe = require('stripe');

const db = require('./db');
const { getPackage } = require('./packages');

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

if (!STRIPE_SECRET_KEY) {
  console.warn('[warn] STRIPE_SECRET_KEY is not set. Checkout will fail until you add it to .env');
}
if (!STRIPE_PUBLISHABLE_KEY) {
  console.warn('[warn] STRIPE_PUBLISHABLE_KEY is not set. The embedded card form will fail to load until you add it to .env');
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const app = express();
app.disable('x-powered-by');

// --- Stripe webhook needs the raw body for signature verification,
// so it must be registered BEFORE express.json(). ---
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error('Webhook received but Stripe is not configured.');
    return res.status(500).send('Stripe not configured');
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        await db.markPaidByPaymentIntentId(intent.id, {
          amountReceived: intent.amount_received,
          currency: intent.currency,
        });
        break;
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object;
        await db.markStatusByPaymentIntentId(intent.id, 'failed');
        break;
      }
      case 'payment_intent.canceled': {
        const intent = event.data.object;
        await db.markStatusByPaymentIntentId(intent.id, 'canceled');
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Failed to process webhook:', err.message);
    res.status(500).json({ error: 'Failed to process webhook.' });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/config', (req, res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY || null });
});

// ---------- Public order + checkout API ----------

function isNonEmptyString(v, maxLen = 500) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= maxLen;
}

app.post('/api/orders', async (req, res) => {
  const b = req.body || {};

  if (!isNonEmptyString(b.packageName, 100) || !getPackage(b.packageName.trim())) {
    return res.status(400).json({ error: 'Invalid package selected.' });
  }
  if (!isNonEmptyString(b.note, 180)) {
    return res.status(400).json({ error: 'Note must be between 1 and 180 characters.' });
  }
  if (!isNonEmptyString(b.recipientName, 120)) {
    return res.status(400).json({ error: 'Recipient name is required.' });
  }
  if (!isNonEmptyString(b.recipientAddress, 300)) {
    return res.status(400).json({ error: 'Recipient address is required.' });
  }
  const zipDigits = String(b.recipientZip || '').replace(/\D/g, '');
  if (!/^\d{5}$/.test(zipDigits)) {
    return res.status(400).json({ error: 'A valid 5-digit ZIP code is required.' });
  }
  if (!isNonEmptyString(b.senderName, 120)) {
    return res.status(400).json({ error: 'Your name is required.' });
  }
  const email = String(b.senderEmail || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required so we can send your receipt.' });
  }

  const pkg = getPackage(b.packageName.trim());
  const fields = {
    package_name: b.packageName.trim(),
    price_cents: pkg.priceCents,
    note: b.note.trim(),
    recipient_name: b.recipientName.trim(),
    recipient_phone: (b.recipientPhone || '').trim() || null,
    recipient_address: b.recipientAddress.trim(),
    recipient_city: (b.recipientCity || '').trim() || null,
    recipient_state: (b.recipientState || '').trim() || null,
    recipient_zip: zipDigits,
    delivery_date: (b.deliveryDate || '').trim() || null,
    delivery_window: (b.deliveryWindow || '').trim() || null,
    sender_name: b.senderName.trim(),
    sender_email: email,
    sender_phone: (b.senderPhone || '').trim() || null,
  };

  try {
    // If the customer already created a pending order earlier in this same
    // checkout attempt (e.g. they went back to fix a typo), update it in
    // place instead of leaving a duplicate row behind. The token proves this
    // request actually came from whoever created that order - without it, a
    // guessed/sequential id would let anyone overwrite someone else's order.
    const existingId = Number(b.orderId);
    const existingToken = typeof b.orderToken === 'string' ? b.orderToken : null;
    if (existingId && existingToken) {
      const updated = await db.updatePendingOrder(existingId, existingToken, fields);
      if (updated) return res.json({ orderId: existingId, orderToken: existingToken });
    }

    const { id: orderId, clientToken: orderToken } = await db.createOrder(fields);
    res.json({ orderId, orderToken });
  } catch (err) {
    console.error('Failed to save order:', err.message);
    res.status(500).json({ error: 'Could not save your order. Please try again.' });
  }
});

app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY in .env.' });
  }

  const orderId = Number(req.body?.orderId);
  const orderToken = typeof req.body?.orderToken === 'string' ? req.body.orderToken : null;
  if (!orderId) return res.status(400).json({ error: 'orderId is required.' });
  if (!orderToken) return res.status(400).json({ error: 'orderToken is required.' });

  try {
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    // Constant-time-ish check isn't critical here (this isn't a password),
    // but a plain mismatch is enough to stop a guessed id from being used to
    // pay someone else's order.
    if (order.client_token !== orderToken) return res.status(403).json({ error: 'Not authorized for this order.' });
    if (order.status === 'paid') return res.status(400).json({ error: 'This order has already been paid.' });

    let intent;
    if (order.stripe_payment_intent_id) {
      // Reusing an existing PaymentIntent (e.g. the customer went back and forth
      // between steps) avoids creating a new one - and a new client secret -
      // on every visit to the payment step.
      intent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      if (intent.status === 'canceled') {
        intent = null;
      } else if (intent.amount !== order.price_cents && intent.status === 'requires_payment_method') {
        // The customer went back and changed the box (a different price) after
        // this PaymentIntent was created - keep it in sync so they're never
        // charged a stale amount.
        intent = await stripe.paymentIntents.update(intent.id, { amount: order.price_cents });
      }
    }

    if (!intent) {
      intent = await stripe.paymentIntents.create({
        amount: order.price_cents,
        currency: 'usd',
        receipt_email: order.sender_email,
        description: `Reconcilia — ${order.package_name} — delivery to ${order.recipient_name}, ZIP ${order.recipient_zip}`,
        metadata: { order_id: String(order.id) },
        automatic_payment_methods: { enabled: true },
      });
      await db.attachPaymentIntent(orderId, intent.id);
    }

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('Failed to create payment intent:', err.message);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

app.get('/api/orders/by-payment-intent/:id', async (req, res) => {
  try {
    const order = await db.getOrderByPaymentIntentId(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    res.json({
      status: order.status,
      packageName: order.package_name,
      recipientName: order.recipient_name,
      deliveryDate: order.delivery_date,
      deliveryWindow: order.delivery_window,
      amountTotal: order.amount_total,
      currency: order.currency,
    });
  } catch (err) {
    console.error('Failed to load order:', err.message);
    res.status(500).json({ error: 'Could not load order.' });
  }
});

// ---------- Admin panel (protected) ----------

const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASSWORD || 'change-me-please' },
  challenge: true,
  realm: 'Reconcilia Admin',
});

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    res.json(await db.listOrders());
  } catch (err) {
    console.error('Failed to list orders:', err.message);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const order = await db.getOrderById(Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json(order);
  } catch (err) {
    console.error('Failed to load order:', err.message);
    res.status(500).json({ error: 'Could not load order.' });
  }
});

app.use('/admin', adminAuth, express.static(path.join(__dirname, '..', 'admin-panel')));

module.exports = app;
