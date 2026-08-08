/**
 * Utility Formatters — pure display/number/date helpers.
 * Ported verbatim from js/utils/formatters.js (legacy).
 * No window / document / localStorage access — pure functions only.
 */

/** V3.15 — NaN-immunity for all aggregation math. */
export function toNumber(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** V3.16.1 — Unified money-rounding helper (banker-safe for EGP). */
export function round2(v) {
  const n = Number(v);
  if (isNaN(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatCurrency(amount) {
  const r = Math.round((Number(amount) || 0) * 100) / 100;
  const hasFraction = r % 1 !== 0;
  const nf = new Intl.NumberFormat('ar-EG', hasFraction
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
  return nf.format(r) + ' ج.م';
}

/** V3.15 — Unified ISO/Standard display timestamp: YYYY-MM-DD HH:mm */
export function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return String(isoString);
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  } catch {
    return String(isoString);
  }
}

/** Precise banking-style timestamp formatter: YYYY-MM-DD HH:mm:ss */
export function formatDateTime(isoString) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  } catch {
    return isoString;
  }
}

/** V3.15 — Composite phone display helper (Fallback). */
export function formatPhonePair(primary, secondary) {
  const p = String(primary || '').trim();
  const s = String(secondary || '').trim();
  if (p) return s ? p + ' / ' + s : p;
  return s || '—';
}

/** V3.15 — Full address display helper: never truncates, collapses empty to '—'. */
export function formatAddress(address) {
  const s = String(address || '').trim();
  return s || '—';
}

/** Cairo (Africa/Cairo) local timestamp formatter: YYYY-MM-DD HH:mm */
export function getCairoFormattedDate(date = new Date()) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(d);
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

export function generateAutoId(prefix = 'ID') {
  // Phase 2 — the compat bridge exposes this generator on window. The legacy
  // harnesses replace window.generateAutoId with a deterministic stub so stress
  // suites (60+ IDs) never collide. Delegate when a DIFFERENT function is
  // installed; otherwise (normal app / vitest / node) behave byte-identically.
  if (typeof window !== 'undefined' && typeof window.generateAutoId === 'function' && window.generateAutoId !== generateAutoId) {
    return window.generateAutoId(prefix);
  }
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${randomNum}`;
}
