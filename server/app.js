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
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

if (!STRIPE_SECRET_KEY) {
  console.warn('[warn] STRIPE_SECRET_KEY is not set. Checkout will fail until you add it to .env');
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
      case 'checkout.session.completed': {
        const session = event.data.object;
        await db.markPaidBySessionId(session.id, {
          paymentIntentId: session.payment_intent,
          amountTotal: session.amount_total,
          currency: session.currency,
        });
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object;
        await db.markStatusBySessionId(session.id, 'expired');
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

  try {
    const orderId = await db.createOrder({
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
    });

    res.json({ orderId });
  } catch (err) {
    console.error('Failed to create order:', err.message);
    res.status(500).json({ error: 'Could not save your order. Please try again.' });
  }
});

app.post('/api/checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY in .env.' });
  }

  const orderId = Number(req.body?.orderId);
  if (!orderId) return res.status(400).json({ error: 'orderId is required.' });

  try {
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'paid') return res.status(400).json({ error: 'This order has already been paid.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: order.sender_email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: order.price_cents,
            product_data: {
              name: `Reconcilia — ${order.package_name}`,
              description: `Delivery to ${order.recipient_name}, ZIP ${order.recipient_zip}`,
            },
          },
        },
      ],
      metadata: { order_id: String(order.id) },
      success_url: `${PUBLIC_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/cancel.html`,
    });

    await db.attachStripeSession(orderId, session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Failed to create checkout session:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.get('/api/orders/session/:sessionId', async (req, res) => {
  try {
    const order = await db.getOrderBySessionId(req.params.sessionId);
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
