function esc(s){
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtMoney(cents, currency){
  if(cents === null || cents === undefined) return '—';
  return '$' + (cents/100).toFixed(2) + ' ' + (currency ? currency.toUpperCase() : '');
}
function fmtDate(iso){
  if(!iso) return '—';
  // Postgres (via `pg`) already returns full ISO 8601 timestamps (with a
  // trailing Z), so they parse directly - no reformatting needed.
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function fmtDuration(seconds){
  if(!seconds) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}
const FULFILLMENT_LABELS = { received: 'Recebido', preparing: 'Em preparação', in_transit: 'Em trânsito', delivered: 'Entregue' };
function fstatusLabel(v){ return FULFILLMENT_LABELS[v] || v; }
const FUNNEL_STEP_LABELS = ['Landed', 'Box', 'Delivery', 'Message', 'Details', 'Pay', 'Purchased'];
