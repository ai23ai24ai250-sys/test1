/**
 * Phone helpers — Egyptian mobile validation & normalization.
 * Ported verbatim from js/utils/formatters.js (legacy).
 */

/** V3.21 — Phone Normalization for robust lookups. */
export function normalizePhone(phone) {
  if (!phone) return '';
  let s = String(phone).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('20') && s.length === 12) s = '0' + s.slice(2);
  return s;
}

/** Strict Phone Number Validation (Egyptian Mobile Format) */
export function validateEgyptianPhone(phone) {
  if (!phone) return { isValid: false, message: 'يرجى إدخال رقم الهاتف' };
  const cleaned = phone.trim();
  const isValid = /^01[0125]\d{8}$/.test(cleaned);
  if (!isValid) {
    return {
      isValid: false,
      message: 'يرجى إدخال رقم هاتف صحيح يتكون من 11 رقماً يبدأ بـ 01 (مثال: 01012345678)'
    };
  }
  return { isValid: true, cleaned };
}
