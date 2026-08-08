/**
 * General System Settings Module — V3.17 → React (Phase 2 port)
 * =============================================================
 * Faithful ES-module port of js/services/general-settings.js. Appearance +
 * identity settings available WITHOUT the admin password:
 *   - App name / logo / primary color (runtime brand-* re-theme via CSS vars)
 *   - Dark / Light mode (persisted in localStorage, mirrored to Firestore)
 *
 * Persistence:
 *   - localStorage key `bms_general_settings` (works even offline / file://)
 *   - Firestore doc `settings/appSettings` (LWW via `updatedAt`).
 */

const KEY = 'bms_general_settings';

const DEFAULT = {
  appName: 'علاء الدين',
  tagline: 'للبطاطين والمفروشات',
  logo: '2.jpg',
  primaryColor: '#0284c7',
  theme: 'dark',
  updatedAt: 0
};

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return v == null ? null : v;
  } catch {
    return null;
  }
}
// حفظ محمي ضد امتلاء سعة التخزين المحلي (مثل شعار ضخم): عند رفض الكتابة نعيد
// المحاولة دون الشعار كي لا يضيع بقية الإعدادات بصمت ويبدو الحفظ «راجعاً».
function writeLocal(o) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch (e) {
    if (o.logo && o.logo !== DEFAULT.logo) {
      writeLocal(Object.assign({}, o, { logo: DEFAULT.logo }));
      return;
    }
    console.warn('settings: localStorage write failed', e && e.message ? e.message : e);
  }
}

export function getSettings() {
  return Object.assign({}, DEFAULT, readLocal() || {});
}

// ---------------------------------------------------------------
// Color helpers — derive the full brand-* palette from one accent.
// ---------------------------------------------------------------
function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function blend(rgb, towardWhite, t) {
  const tgt = towardWhite ? [255, 255, 255] : [0, 0, 0];
  return '#' + rgb.map(function (v, i) {
    const x = Math.max(0, Math.min(255, Math.round(v + (tgt[i] - v) * t)));
    return x.toString(16).padStart(2, '0');
  }).join('');
}
function palette(primary) {
  const rgb = hexToRgb(primary) || hexToRgb('#0284c7');
  return {
    50: blend(rgb, true, 0.9),
    100: blend(rgb, true, 0.8),
    300: blend(rgb, true, 0.45),
    400: blend(rgb, true, 0.25),
    500: primary,
    600: blend(rgb, false, 0.1),
    700: blend(rgb, false, 0.2),
    800: blend(rgb, false, 0.3),
    900: blend(rgb, false, 0.45)
  };
}

const THEMES = ['dark', 'light', 'ocean', 'emerald', 'royal', 'coffee', 'luxury-gold', 'graphite'];

export function setTheme(theme) {
  const t = THEMES.indexOf(theme) !== -1 ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.classList.toggle('dark', t === 'dark');
}

export function applyPalette(primary) {
  const p = palette(primary);
  const style = document.documentElement.style;
  Object.keys(p).forEach(function (k) { style.setProperty('--brand-' + k, p[k]); });
}

function applyBranding(g) {
  const name = g.appName || DEFAULT.appName;
  const tag = g.tagline || DEFAULT.tagline;
  const logo = g.logo || DEFAULT.logo;

  document.title = name + ' — نظام الإدارة اليومية الذكي';

  const setEl = function (ids, value, isSrc) {
    ids.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (isSrc) {
        el.setAttribute('src', value);
        if (el.hasAttribute('alt')) el.setAttribute('alt', name);
      } else {
        el.textContent = value;
      }
    });
  };

  setEl(['header-brand-name', 'login-brand-name', 'mobile-brand-name'], name, false);
  setEl(['header-brand-tagline', 'login-brand-tagline', 'mobile-brand-tagline'], tag, false);
  setEl(['header-brand-logo', 'login-brand-logo', 'mobile-brand-logo'], logo, true);

  const foot = document.getElementById('footer-brand-text');
  if (foot) foot.textContent = name + ' — نظام الإدارة اليومية الذكي — جميع الحقوق محفوظة © 2026';

  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.setAttribute('href', logo);
}

export function applyTo(g) {
  const settings = Object.assign({}, DEFAULT, g || {});
  setTheme(settings.theme);
  applyPalette(settings.primaryColor);
  applyBranding(settings);
}

export function applySettings() {
  applyTo(getSettings());
}

export function saveSettings(partial) {
  const prev = getSettings();
  const next = Object.assign({}, prev, partial || {});
  if (THEMES.indexOf(next.theme) === -1) next.theme = 'dark';
  if (!hexToRgb(next.primaryColor)) next.primaryColor = prev.primaryColor || DEFAULT.primaryColor;
  const prevStamp = Number(prev.updatedAt) || 0;
  next.updatedAt = Math.max(Date.now(), prevStamp + 1);
  if (window.isSandboxMode) {
    // Sandbox: apply the look visually from the NEW values ONLY (session-wise) —
    // nothing is written to localStorage or mirrored to Firestore (وضع الاختبار
    // لا يمس البيانات). Previously this re-applied the OLD storage value, which
    // made saved settings appear to "revert" immediately in test mode.
    applyTo(next);
    return next;
  }
  writeLocal(next);
  applySettings();
  pushToCloud();
  return next;
}

export function pushToCloud() {
  if (window.isSandboxMode) return Promise.resolve(false);
  if (!window.db || !window._authUser) return Promise.resolve(false);
  const g = getSettings();
  try {
    const p = window.db.collection('settings').doc('appSettings').set({
      appName: g.appName,
      tagline: g.tagline,
      logo: g.logo,
      primaryColor: g.primaryColor,
      theme: g.theme,
      updatedAt: g.updatedAt
    }, { merge: true });
    p.catch(function (err) {
      window.dispatchEvent(new CustomEvent('bms-sync-error', {
        detail: { context: 'appSettings', message: err && err.message ? err.message : String(err) }
      }));
    });
    return p;
    } catch (pushErr) {
      return Promise.reject(pushErr);
    }
}

export function hydrateFromCloud() {
  if (window.isSandboxMode || !window.db || !window._authUser) return Promise.resolve(false);
  return window.db.collection('settings').doc('appSettings').get()
    .then(function (snap) {
      if (!snap.exists) return false;
      const cloud = snap.data() || {};
      const ct = Number(cloud.updatedAt) || 0;
      if (!ct) return false;
      const local = getSettings();
      const lt = Number(local.updatedAt) || 0;
      if (ct > lt) {
        writeLocal(Object.assign({}, local, cloud, { updatedAt: ct }));
        applySettings();
        return true;
      } else if (lt > ct) {
        pushToCloud();
      }
      return false;
    })
    .catch(function () { return false; });
}

const NS = {
  get: getSettings,
  setTheme,
  applyPalette,
  apply: applySettings,
  save: saveSettings,
  pushToCloud,
  hydrateFromCloud
};

// Public aliases used by other modules / views.
if (typeof window !== 'undefined') {
  window.applyGeneralSettings = applySettings;
  window.saveGeneralSettings = saveSettings;
  window.hydrateGeneralSettings = hydrateFromCloud;
  window.generalSettings = NS;
}

function boot() {
  applySettings();
  if (window._authUser) hydrateFromCloud();
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

export { NS as generalSettings };
