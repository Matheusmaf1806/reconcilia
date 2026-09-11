const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'reconcilia <onboarding@resend.dev>';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

if (!RESEND_API_KEY) {
  console.warn('[warn] RESEND_API_KEY is not set. Order confirmation and delivery-status emails will be skipped.');
}

// Used by /api/health so deployment issues (bad key, unverified domain) show
// up without having to trigger a real order and wait for an email to land.
async function getStatus() {
  if (!RESEND_API_KEY) return { configured: false };

  const fromMatch = RESEND_FROM_EMAIL.match(/@([^\s>]+)/);
  const fromDomain = fromMatch ? fromMatch[1].toLowerCase() : null;

  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { configured: true, apiKey: 'error: ' + (data.message || `HTTP ${res.status}`) };
    }
    const domains = Array.isArray(data.data) ? data.data : [];
    const match = fromDomain ? domains.find(d => d.name?.toLowerCase() === fromDomain) : null;
    return {
      configured: true,
      apiKey: 'valid',
      fromEmail: RESEND_FROM_EMAIL,
      fromDomain: fromDomain || 'unknown',
      domainStatus: fromDomain === 'resend.dev' ? 'shared_test_domain' : (match ? match.status : 'not_found_in_account'),
    };
  } catch (err) {
    return { configured: true, apiKey: 'error: ' + err.message };
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function trackingUrl(order) {
  return `${PUBLIC_BASE_URL}/track?id=${order.id}&token=${order.client_token}`;
}

function layout({ title, bodyHtml, order }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f7f2e9;padding:32px 16px">
      <div style="max-width:520px;margin:0 auto;background:#fffaf2;border-radius:8px;padding:32px;border:1px solid rgba(23,18,15,.1)">
        <div style="font-size:20px;font-weight:700;color:#17120f;margin-bottom:20px">reconcilia <span style="color:#b93632">&hearts;</span></div>
        <h1 style="font-size:21px;color:#17120f;margin:0 0 14px">${escapeHtml(title)}</h1>
        ${bodyHtml}
        <p style="margin-top:26px">
          <a href="${trackingUrl(order)}" style="background:#b93632;color:#fff4ea;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:13px;display:inline-block">Track your order &rarr;</a>
        </p>
        <p style="color:#7e7064;font-size:11px;margin-top:26px">Order #${order.id} &middot; ${escapeHtml(order.package_name)}</p>
      </div>
    </div>
  `;
}

// Fire-and-forget: an email provider hiccup should never break checkout or
// an admin's status update. Every caller already runs this inside its own
// try/catch, but errors are swallowed here too as a second layer of safety.
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Resend email failed:', res.status, body);
    }
  } catch (err) {
    console.error('Resend email request error:', err.message);
  }
}

async function sendOrderConfirmation(order) {
  const html = layout({
    title: 'Your gesture is on its way.',
    order,
    bodyHtml: `
      <p style="color:#3d332c;line-height:1.6">Thanks, ${escapeHtml(order.sender_name)} — payment confirmed and we're hand-packing
      <b>${escapeHtml(order.package_name)}</b> now, heading to ${escapeHtml(order.recipient_name)}.</p>
      <p style="color:#3d332c;line-height:1.6">Delivery: ${escapeHtml(order.delivery_date || 'as soon as possible')} &middot; ${escapeHtml(order.delivery_window || '')}</p>
      <p style="color:#7e7064;line-height:1.6;font-size:13px">Use the link below any time to check where things stand — no account needed.</p>
    `,
  });
  await sendEmail({ to: order.sender_email, subject: 'Your reconcilia order is confirmed', html });
}

// "received" isn't emailed on its own - the order-confirmation email already
// covers that moment. Only the three stages after it get a status email.
const STATUS_COPY = {
  preparing: { subject: 'We’re preparing your gift', body: 'Your box is being hand-packed right now.' },
  in_transit: { subject: 'Your gift is on its way!', body: 'Your box just left for delivery.' },
  delivered: { subject: 'Delivered!', body: 'Your gift has arrived. We hope it made their day a little better.' },
};

async function sendStatusUpdate(order, fulfillmentStatus) {
  const copy = STATUS_COPY[fulfillmentStatus];
  if (!copy) return;
  const html = layout({
    title: copy.subject,
    order,
    bodyHtml: `
      <p style="color:#3d332c;line-height:1.6">${escapeHtml(copy.body)}</p>
      <p style="color:#3d332c;line-height:1.6">Box: <b>${escapeHtml(order.package_name)}</b> for ${escapeHtml(order.recipient_name)}</p>
    `,
  });
  await sendEmail({ to: order.sender_email, subject: `reconcilia — ${copy.subject}`, html });
}

module.exports = { sendOrderConfirmation, sendStatusUpdate, getStatus };
