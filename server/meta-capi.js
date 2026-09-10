const crypto = require('crypto');

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE;
const GRAPH_VERSION = 'v21.0';

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.warn('[warn] META_PIXEL_ID / META_ACCESS_TOKEN are not set. Server-side conversion events (Conversions API) will be skipped.');
}

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

// Meta expects phone numbers as digits only, with country code and no
// leading '+'. This service only ships in the US, so a bare 10-digit
// number gets the '1' country code prefixed before hashing.
function normalizePhone(value) {
  if (!value) return undefined;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.length === 10 ? `1${digits}` : digits;
}

// Fire-and-forget: a Meta API hiccup should never break checkout. Every
// caller already wraps this in the surrounding request's own try/catch,
// but we swallow errors here too so a rejected promise can't surface as
// an unhandled rejection if a caller forgets to await it.
async function sendEvent({ eventName, eventId, order, customData }) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return;

  const userData = {
    em: sha256(order.sender_email),
    ph: sha256(normalizePhone(order.sender_phone)),
    client_ip_address: order.client_ip || undefined,
    client_user_agent: order.client_user_agent || undefined,
    fbp: order.fbp || undefined,
    fbc: order.fbc || undefined,
  };
  Object.keys(userData).forEach(key => userData[key] === undefined && delete userData[key]);

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: `${process.env.PUBLIC_BASE_URL || ''}/`,
      user_data: userData,
      custom_data: customData,
    }],
  };
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Meta CAPI ${eventName} failed:`, res.status, body);
    }
  } catch (err) {
    console.error(`Meta CAPI ${eventName} request error:`, err.message);
  }
}

function packageCustomData(order) {
  const amountCents = order.amount_total || order.price_cents;
  return {
    currency: (order.currency || 'usd').toLowerCase(),
    value: amountCents / 100,
    content_type: 'product',
    content_ids: [order.package_name],
    contents: [{ id: order.package_name, quantity: 1, item_price: order.price_cents / 100 }],
  };
}

module.exports = { sendEvent, packageCustomData };
