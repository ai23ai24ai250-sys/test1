/**
 * Google Sheets Two-Way Sync Module — → React (Phase 2 port)
 * =========================================================
 * Faithful ES-module port of js/services/google-sheets-sync.js. Sync engine
 * (transport-agnostic) + real Google Sheets API v4 transport.
 *
 * Architecture:
 *   - The ENGINE (export / import / upsert / conflict-resolution / audit) is
 *     pure business logic and never touches the network. It talks to a
 *     SyncTransport interface ({ readSheet(title), writeSheet(title, headers, rows) }).
 *   - The REAL transport (createGoogleSheetsTransport) targets Google Sheets
 *     API v4 (REST) using either an OAuth access token or an API key.
 *   - Tests inject an in-memory transport (createMemoryTransport) so the whole
 *     two-way cycle is verified locally with zero network.
 *
 * Security & accounting guardrails:
 *   - Employees sheet never exports passwords; password imports are rejected.
 *   - Import only touches a per-sheet whitelist of editable fields. Ledger /
 *     computed numbers (totals, balances, COGS, retained deposits...) are NEVER
 *     imported; the system's own formulas re-derive them instead.
 *   - NaN / null / negative prices & quantities are rejected.
 *   - Last-Write-Wins compares syncUpdatedAt (falls back to updatedAt/createdAt).
 *   - Any imported stock change writes a SYNC_STOCK_CHANGE audit record; sync
 *     results and field-level rejections are appended to a persistent audit log.
 *
 * Structural changes vs the legacy script (logic is otherwise byte-for-byte):
 *   1. ES module wrapper (IIFE removed) — `window.GoogleSheetsSync` is still
 *      assigned so the service self-installs on window exactly as before.
 *   2. `getCairoFormattedDate` / `generateAutoId` imported from utils/formatters
 *      instead of being read from window.
 * This is the SYNC service — touching window is its job; the pure-domain rule
 * applies to business logic modules, not here.
 */
import { generateAutoId, getCairoFormattedDate } from '../utils/formatters.js';

const NS = window.GoogleSheetsSync = window.GoogleSheetsSync || {};

// ----------------------------------------------------------------
// Persistence (local mirror keys; snapshotted/restored by the test suite
// because they share the bms_data_ prefix).
// ----------------------------------------------------------------
const CFG_KEY = 'bms_data_syncConfig';
const LOG_KEY = 'bms_data_syncLog';
const AUDIT_KEY = 'bms_data_syncAudit';

const DEFAULT_CONFIG = {
  spreadsheetId: '',
  direction: 'export', // 'export' | 'import' | 'both'
  frequency: 'manual', // '15m' | '1h' | 'every-op' | 'manual'
  enabled: false,
  debounceMs: 3000,
  clientId: '',
  clientSecret: '', // optional — required only for OAuth web-app clients
  accessToken: '',
  tokenExpiresAt: 0,
  refreshToken: '', // V3.14: long-lived token for silent background renewal
  apiKey: '',
  lastSyncAt: null,
  lastSyncDirection: '',
  lastSyncRows: 0,
  lastSyncStatus: 'none',
  lastSyncError: '',
  cfgUpdatedAt: 0 // V3.16.2: epoch-ms LWW timestamp for cross-browser config cloud sync
};

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function writeJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

// ----------------------------------------------------------------
// Sheet definitions — the 6 connected sheets (headers / editable / protected).
// ----------------------------------------------------------------
const SHEETS = [
  {
    title: 'Orders_Sales',
    entityKey: 'orders',
    label: 'المبيعات والفواتير',
    idField: 'id',
    editable: ['shippingCost', 'shippingPayer', 'extraExpenses', 'extraExpensesPayer', 'depositType'],
    protected: ['status', 'downPayment', 'refundedAmount', 'retainedDeposit', 'items', 'itemsSubtotal', 'totalAmount', 'remainingBalance', 'paidInFull', 'directShipping', 'shippingRevenueDeposit', 'supplierShipments', 'supplierDeficits', 'customerSecondaryPhone', 'customerAddresses', 'shippingAddress', 'shippingAddressLabel', 'shippingAddressId'],
    headers: [
      { key: 'id', label: 'رقم الطلب (ID)' },
      { key: 'status', label: 'الحالة' },
      { key: 'customerId', label: 'رقم العميل' },
      { key: 'customerName', label: 'اسم العميل' },
      { key: 'customerPhone', label: 'هاتف العميل' },
      // V3.26 — dedicated columns so the secondary phone, the shipping address
      // chosen for THIS order, and the customer's full address list are never
      // lost on export/sync (previously only the legacy address text survived).
      { key: 'customerSecondaryPhone', label: 'هاتف ثانوي (العميل)' },
      { key: 'customerAddresses', label: 'عناوين العميل (قائمة)' },
      { key: 'shippingAddress', label: 'عنوان الشحن لهذا الطلب' },
      { key: 'shippingAddressLabel', label: 'اسم عنوان الشحن' },
      { key: 'shippingAddressId', label: 'معرّف عنوان الشحن' },
      { key: 'itemsSummary', label: 'الأصناف' },
      { key: 'items', label: 'الأصناف (JSON)' },
      // V3.40 — dedicated JSON columns so supplier shipments (شحن مباشر من
      // المورد) and deficits (عجز مخزون) survive export/import — previously
      // they were only written locally and silently lost on any Sheets round-trip.
      { key: 'supplierShipments', label: 'شحنات المورد (JSON)' },
      { key: 'supplierDeficits', label: 'عجز المورد (JSON)' },
      { key: 'itemsSubtotal', label: 'قيمة البضاعة' },
      { key: 'shippingCost', label: 'الشحن' },
      { key: 'shippingPayer', label: 'الدافع للشحن' },
      { key: 'extraExpenses', label: 'مصروفات إضافية' },
      { key: 'extraExpensesPayer', label: 'دافع المصروفات' },
      { key: 'totalAmount', label: 'إجمالي الفاتورة' },
      { key: 'downPayment', label: 'المدفوع' },
      { key: 'remainingBalance', label: 'المتبقي' },
      { key: 'shippingRevenueDeposit', label: 'حجز إيراد الشحن' },
      { key: 'refundedAmount', label: 'المرتد' },
      { key: 'retainedDeposit', label: 'المحتفظ به' },
      { key: 'depositType', label: 'نوع العربون' },
      { key: 'directShipping', label: 'شحن مباشر' },
      { key: 'createdBy', label: 'المسؤول' },
      // V3.40 — createdAt exported/imported so an order's true creation date
      // survives a Sheets restore (previously it fell back to sync time).
      { key: 'createdAt', label: 'تاريخ الإنشاء' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  },
  {
    title: 'Treasury_Payments',
    entityKey: 'payments',
    label: 'الخزينة والدفعات',
    idField: 'id',
    editable: ['notes', 'paymentMethod', 'date'],
    protected: ['amount', 'isDownPayment', 'entityId', 'entityName', 'entityType', 'allocatedToOrders'],
    headers: [
      { key: 'id', label: 'رقم الدفعة (ID)' },
      { key: 'entityType', label: 'نوع الطرف' },
      { key: 'entityId', label: 'رقم الطرف' },
      { key: 'entityName', label: 'اسم الطرف' },
      { key: 'amount', label: 'المبلغ' },
      { key: 'date', label: 'التاريخ' },
      { key: 'paymentMethod', label: 'طريقة الدفع' },
      { key: 'isDownPayment', label: 'عربون' },
      { key: 'allocatedToOrders', label: 'مخصص لسداد الطلبات' },
      { key: 'notes', label: 'الملاحظات' },
      { key: 'createdAt', label: 'تاريخ الإنشاء' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  },
  {
    title: 'Customers_Balances',
    entityKey: 'customers',
    label: 'العملاء والأرصدة',
    idField: 'id',
    editable: ['name', 'phone', 'secondaryPhone', 'category', 'address', 'notes', 'addresses'],
    protected: ['ordersCount', 'totalPurchases', 'paid', 'remainingBalance'],
    headers: [
      { key: 'id', label: 'رقم العميل (ID)' },
      { key: 'name', label: 'اسم العميل' },
      { key: 'phone', label: 'الهاتف الرئيسي' },
      { key: 'secondaryPhone', label: 'هاتف ثانوي' },
      { key: 'category', label: 'التصنيف' },
      { key: 'address', label: 'العنوان' },
      { key: 'addresses', label: 'قائمة العناوين' },
      { key: 'notes', label: 'ملاحظات' },
      { key: 'ordersCount', label: 'عدد الطلبات' },
      { key: 'totalPurchases', label: 'إجمالي المشتريات' },
      { key: 'paid', label: 'المسدد' },
      { key: 'remainingBalance', label: 'الرصيد المتبقي' },
      // V3.40 — customer createdAt exported/imported so the true registration
      // date survives a Sheets restore.
      { key: 'createdAt', label: 'تاريخ الإنشاء' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  },
  {
    title: 'Suppliers_Accounts',
    entityKey: 'suppliers',
    label: 'الموردين والحسابات',
    idField: 'id',
    editable: ['name', 'phone', 'secondaryPhone', 'address', 'notes'],
    protected: ['totalPurchases', 'paid', 'remainingBalance'],
    headers: [
      { key: 'id', label: 'رقم المورد (ID)' },
      { key: 'name', label: 'اسم المورد' },
      { key: 'phone', label: 'الهاتف الرئيسي' },
      { key: 'secondaryPhone', label: 'هاتف ثانوي' },
      { key: 'address', label: 'العنوان' },
      { key: 'notes', label: 'ملاحظات' },
      { key: 'totalPurchases', label: 'إجمالي التوريدات' },
      { key: 'paid', label: 'المسدد' },
      { key: 'remainingBalance', label: 'الرصيد المتبقي' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  },
  {
    title: 'Products_Inventory',
    entityKey: 'products',
    label: 'المنتجات والمخزون',
    idField: 'id',
    editable: ['name', 'code', 'category', 'purchasePrice', 'sellingPrice', 'stock', 'minStock', 'supplierId', 'supplierName'],
    protected: [],
    headers: [
      { key: 'id', label: 'رقم المنتج (ID)' },
      { key: 'code', label: 'الكود (SKU)' },
      { key: 'name', label: 'اسم المنتج' },
      { key: 'category', label: 'التصنيف' },
      { key: 'purchasePrice', label: 'سعر الشراء' },
      { key: 'sellingPrice', label: 'سعر البيع' },
      { key: 'stock', label: 'المخزون' },
      { key: 'minStock', label: 'حد إعادة الطلب' },
      { key: 'supplierId', label: 'رقم المورد' },
      { key: 'supplierName', label: 'اسم المورد' },
      // V3.40 — product createdAt exported/imported so the true creation date
      // survives a Sheets restore.
      { key: 'createdAt', label: 'تاريخ الإنشاء' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  },
  {
    title: 'Employees_Roles',
    entityKey: 'users',
    label: 'حسابات الموظفين',
    idField: 'id',
    editable: ['name', 'email', 'role'],
    protected: ['password'],
    headers: [
      { key: 'id', label: 'رقم المستخدم (ID)' },
      { key: 'name', label: 'اسم الموظف' },
      { key: 'email', label: 'البريد الإلكتروني' },
      { key: 'role', label: 'الصلاحية / الرتبة' },
      { key: 'createdAt', label: 'تاريخ الإنشاء' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  },
  {
    title: 'Supplier_Returns',
    entityKey: 'supplierReturns',
    label: 'مرتجع المشتريات',
    idField: 'id',
    editable: ['notes', 'refundType'],
    protected: ['items', 'totalValue'],
    headers: [
      { key: 'id', label: 'رقم المرتجع (ID)' },
      { key: 'supplierId', label: 'رقم المورد' },
      { key: 'supplierName', label: 'اسم المورد' },
      { key: 'items', label: 'الأصناف (JSON)' },
      { key: 'totalValue', label: 'قيمة المرتجع' },
      { key: 'refundType', label: 'نوع الاسترداد' },
      { key: 'notes', label: 'الملاحظات' },
      { key: 'createdBy', label: 'المسؤول' },
      { key: 'createdAt', label: 'تاريخ الإنشاء' },
      { key: 'syncUpdatedAt', label: 'آخر تحديث Sync' }
    ]
  }
];

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function collection(key) {
  if (key === 'orders') return window.getOrders();
  if (key === 'payments') return window.getPayments();
  if (key === 'customers') return window.getCustomers();
  if (key === 'suppliers') return window.getSuppliers();
  if (key === 'products') return window.getProducts();
  if (key === 'supplierReturns') return window.getSupplierReturns ? window.getSupplierReturns() : [];
  if (key === 'users') return window.getUsers ? window.getUsers() : (window.getCollection ? window.getCollection(window.STORAGE_KEYS.USER) : []);
  return [];
}
function findEntity(key, id) {
  return collection(key).find(e => String(e.id) === String(id)) || null;
}
function rowTime(row) {
  return parseTime(row && row.syncUpdatedAt);
}
function entityTime(entity) {
  return parseTime(entity && (entity.syncUpdatedAt || entity.updatedAt || entity.createdAt));
}
// Parse ISO ("2026-08-01T15:13:27.050Z") AND our formatted export form
// ("2026-08-01 15:13") deterministically as UTC.
function parseTime(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
// Last-Write-Wins: the sheet wins unless the local copy is strictly newer.
function lwwAllows(sheetTime, localTime) {
  if (sheetTime && localTime && sheetTime < localTime) return false;
  return true;
}
function num(v, field, allowNegative) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  if (isNaN(n)) throw new Error('قيمة غير رقمية في الحقل: ' + field);
  if (!allowNegative && n < 0) throw new Error('لا يُسمح بقيمة سالبة في الحقل: ' + field);
  return n;
}
function truthy(v) { return v === true || v === 'true' || v === 'نعم'; }
function boolCell(v) { return v ? 'نعم' : 'لا'; }
function strCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return boolCell(v);
  return String(v);
}
function timeCell(entity) {
  return entity.syncUpdatedAt || entity.updatedAt || entity.createdAt || '';
}

// ----------------------------------------------------------------
// Cell formatting (readable + machine-friendly in the sheet)
// ----------------------------------------------------------------
// Columns that hold timestamps.
const DATE_KEY_RE = /^(syncUpdatedAt|updatedAt|createdAt|date|.*[Dd]ate)$/;
// Columns that must be sent as real Numbers (not text) so Google Sheets can
// format/sum them.
const NUMERIC_KEYS = new Set([
  'itemsSubtotal', 'shippingCost', 'extraExpenses', 'totalAmount', 'downPayment',
  'remainingBalance', 'shippingRevenueDeposit', 'refundedAmount', 'retainedDeposit',
  'amount', 'ordersCount', 'totalPurchases', 'paid', 'purchasePrice', 'sellingPrice',
  'stock', 'minStock', 'totalValue'
]);
// Identifier/text columns that look numeric (phones, codes, ids) — with
// USER_ENTERED, Google would otherwise turn "01012345678" into 1012345678.
const TEXT_KEYS = new Set([
  'id', 'phone', 'secondaryPhone', 'customerSecondaryPhone', 'code', 'customerPhone',
  'customerId', 'supplierId', 'entityId', 'productId', 'shippingAddressId'
]);

// "2026-08-01T15:13:27.050Z" -> "2026-08-01 15:13" (UTC, no timezone shift).
function formatDateStr(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const p = n => (n < 10 ? '0' + n : '' + n);
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  return s;
}

// Reverse: "2026-08-01 15:13" (or "2026-08-01") -> normalized Cairo wall-clock
// string so imported values keep the same format the app now stores locally.
function unformatDateStr(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    const p2 = n => (String(n).length < 2 ? '0' + n : '' + n);
    return m[1] + '-' + p2(m[2]) + '-' + p2(m[3]) +
      (m[4] !== undefined ? ' ' + p2(m[4]) + ':' + p2(m[5]) + (m[6] !== undefined ? ':' + p2(m[6]) : '') : '');
  }
  return s;
}

// Google Sheets date serial number -> Cairo wall-clock "YYYY-MM-DD HH:mm"
// (serial 1 = 1899-12-30; serials carry no explicit timezone, so the instant is
// rendered in Africa/Cairo to match the app's stored format).
function serialToCairo(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400000);
  return getCairoFormattedDate(new Date(ms));
}

// Pick the best cell representation for a column when exporting.
// V3.15 — NaN-immunity: a numeric column NEVER exports "NaN"/null as text; it
// degrades to 0 (or 0 for strings that failed to parse). Prevents aggregate
// garbage from corrupting sheet totals when an order/customer has bad data.
function formatExportCell(key, value) {
  if (value === undefined || value === null || value === '') return '';
  if (DATE_KEY_RE.test(key)) return formatDateStr(value);
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(String(value).replace(/,/g, '').trim());
    // V3.16.1 — round to 2dp so a float drift (2000.0000000001) can never be
    // written into the sheet's aggregate columns.
    return isNaN(n) ? 0 : window.round2(n);
  }
  if (TEXT_KEYS.has(key)) {
    const s = String(value).trim();
    if (s === 'NaN' || s === 'null' || s === 'undefined') return '';
    return /^[0-9]+$/.test(s) ? "'" + s : s;
  }
  return value;
}

// ----------------------------------------------------------------
// Export: System ➔ Sheets  (per sheet, upsert by unique id)
// ----------------------------------------------------------------
function toRow(sheet, entity) {
  const row = {};
  sheet.headers.forEach(h => {
    const key = h.key;
    if (key === 'itemsSummary') {
      row[key] = (entity.items || []).map(it => (it.productName || it.productId || '') + ' x' + (Number(it.quantity) || 0)).join('، ');
    } else if (key === 'items') {
      row[key] = Array.isArray(entity.items) ? JSON.stringify(entity.items) : '';
    } else if (key === 'supplierShipments') {
      // V3.40 — supplier shipments/deficits are arrays: serialize losslessly
      // (strCell would flatten them into a comma-joined string and destroy data).
      row[key] = Array.isArray(entity.supplierShipments) ? JSON.stringify(entity.supplierShipments) : '';
    } else if (key === 'supplierDeficits') {
      row[key] = Array.isArray(entity.supplierDeficits) ? JSON.stringify(entity.supplierDeficits) : '';
    } else if (key === 'customerAddresses') {
      // V3.26 — the customer's full address list (as a lossless JSON array) so
      // the addresses survive export/sync even though the order itself only
      // stores the one selected for this invoice.
      const addrs = (window.getCustomerAddresses ? window.getCustomerAddresses(entity.customerId) : []);
      row[key] = addrs.length ? JSON.stringify(addrs) : '';
    } else if (key === 'addresses') {
      // Customers_Balances — same list, stored on the customer doc itself.
      const list = Array.isArray(entity.addresses) && entity.addresses.length
        ? entity.addresses
        : (window.getCustomerAddresses ? window.getCustomerAddresses(entity.id) : []);
      row[key] = list.length ? JSON.stringify(list) : '';
    } else if (key === 'syncUpdatedAt') {
      row[key] = timeCell(entity);
    } else {
      row[key] = strCell(entity[key]);
    }
  });
  return row;
}

NS.exportAll = async function (transport) {
  if (!transport) throw new Error('SyncTransport غير محقون — استخدم NS.setTransport أو مرر transport');
  // V3.14: reconcile every customer balance from the real ledger (orders +
  // payments) BEFORE exporting, so the aggregate columns written to the sheet
  // always reflect the system's truth — never a stale/wrong cached number.
  if (window.recalculateAllCustomerBalances) {
    window.recalculateAllCustomerBalances();
  }
  const report = { sheets: [], rowsTotal: 0 };
  for (const sheet of SHEETS) {
    const entities = collection(sheet.entityKey);
    const headers = sheet.headers.map(h => h.label);
    const keys = sheet.headers.map(h => h.key);
    const rows = entities.map(e => toRow(sheet, e));
    const res = await transport.writeSheet(sheet.title, headers, rows, keys);
    report.sheets.push({ title: sheet.title, label: sheet.label, rows: rows.length, rowsWritten: res ? res.rowsWritten : rows.length });
    report.rowsTotal += rows.length;
  }
  return report;
};

// ----------------------------------------------------------------
// Import: Sheets ➔ System  (upsert/merge with validation guardrails)
// ----------------------------------------------------------------
// Normalize a raw sheet row into canonical internal keys. The real Google
// transport stores rows keyed by header LABELS (Arabic), while the in-memory
// transport and the export step write canonical keys — accept both. Unknown
// internal keys present in the sheet (e.g. a malicious 'password' column) are
// carried through so the security guardrails still fire.
function normalizeRow(sheet, rawRow) {
  const row = {};
  if (!rawRow || typeof rawRow !== 'object') return row;
  sheet.headers.forEach(h => {
    let v = rawRow[h.key] !== undefined ? rawRow[h.key] : rawRow[h.label];
    if (v !== undefined && v !== null && v !== '') {
      // V3.26 — text-protected cells (phones/ids) carry a leading apostrophe
      // added on export so Google does not coerce them to numbers; strip it on
      // read-back so the in-memory round-trip (tests) stays lossless. The real
      // transport reads UNFORMATTED_VALUE and never produces the apostrophe.
      if (TEXT_KEYS.has(h.key) && typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);
      row[h.key] = DATE_KEY_RE.test(h.key) ? unformatDateStr(v) : v;
    }
  });
  Object.keys(rawRow).forEach(k => {
    if (row[k] === undefined && rawRow[k] !== undefined && rawRow[k] !== null && rawRow[k] !== '') row[k] = rawRow[k];
  });
  return row;
}

// Restore helper: every restored user gets this default password (the sheet
// never contains passwords). The user must change it after first login.
const RESTORE_DEFAULT_PASSWORD = '123456';

// Restore helper: parse a JSON array column ('items', 'supplierShipments', ...)
// that may arrive as a JSON string (Google sheet) or as a native array
// (in-memory transport). Returns an array, never throws.
function parseJSONField(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// V3.26 — Restore helper: parse the customer's 'addresses' column (JSON array
// string in the sheet, native array in the memory transport). Every entry must
// carry a non-empty address; the default flag is normalized (first = default).
// Throws on a malformed non-empty value so addresses are never silently lost.
function parseAddressesField(value) {
  if (value === undefined || value === null || value === '') return [];
  let arr;
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      throw new Error('قائمة العناوين في الشيت غير صالحة (يُتوقع JSON مصفوفة)');
    }
  }
  if (!Array.isArray(arr)) throw new Error('قائمة العناوين في الشيت غير صالحة (يُتوقع JSON مصفوفة)');
  const list = arr
    .filter(a => a && String(a.address || '').trim())
    .map(a => ({
      id: String(a.id || '').trim() || generateAutoId('ADDR'),
      label: String(a.label || '').trim(),
      address: String(a.address).trim(),
      isDefault: !!a.isDefault
    }));
  if (list.length && !list.some(a => a.isDefault)) list[0] = { ...list[0], isDefault: true };
  return list;
}

// Restore helper: guarantee a customer record exists for a referenced id.
// If the reference is missing locally a fallback record is created instead of
// dropping the row — the referenced number is preserved for a 100% match.
function ensureCustomer(row) {
  const id = String(row.customerId || '').trim();
  if (!id) return null;
  const existing = window.getCustomerById ? window.getCustomerById(id) : null;
  if (existing) return { created: false, entity: existing };
  const doc = {
    id,
    name: String(row.customerName || '').trim() || 'عميل غير معروف',
    phone: String(row.customerPhone || '').trim(),
    secondaryPhone: '',
    category: (window.DEFAULT_CUSTOMER_CATEGORY || 'عميل قطاعي / فردي'),
    address: '',
    notes: '',
    ordersCount: 0,
    totalPurchases: 0,
    paid: 0,
    remainingBalance: 0,
    lastOrderDate: null,
    createdAt: getCairoFormattedDate(),
    updatedAt: getCairoFormattedDate()
  };
  window.addFirestoreDoc(window.STORAGE_KEYS.CUSTOMERS, doc);
  return { created: true, entity: doc };
}

// Restore helper: same fallback semantics for suppliers.
function ensureSupplier(id, name) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  const existing = window.getSupplierById ? window.getSupplierById(sid) : null;
  if (existing) return { created: false, entity: existing };
  const doc = {
    id: sid,
    name: String(name || '').trim() || 'مورد غير معروف',
    phone: '',
    secondaryPhone: '',
    address: '',
    notes: '',
    totalPurchases: 0,
    paid: 0,
    remainingBalance: 0,
    createdAt: getCairoFormattedDate(),
    updatedAt: getCairoFormattedDate()
  };
  window.addFirestoreDoc(window.STORAGE_KEYS.SUPPLIERS, doc);
  return { created: true, entity: doc };
}

function applyCustomer(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    const phone = String(row.phone || '').trim();
    if (!phone) throw new Error('هاتف العميل مطلوب لإنشاء عميل جديد');
    if (window.validateEgyptianPhone) {
      const pv = window.validateEgyptianPhone(phone);
      if (!pv.isValid) throw new Error(pv.message || 'رقم هاتف غير صالح');
    }
    // V3.25 — same uniqueness rule as the live screens: primary AND secondary.
    if (window.assertCustomerPhoneAvailable) {
      window.assertCustomerPhoneAvailable(phone, String(row.secondaryPhone || '').trim(), '');
    }
    const name = String(row.name || '').trim();
    if (!name) throw new Error('اسم العميل مطلوب');
    // V3.26 — restore the full address list (JSON column) when present; the
    // legacy primary `address` stays in sync with the default address.
    const importedAddresses = parseAddressesField(row.addresses);
    const addressText = String(row.address || '').trim();
    const defaultAddr = importedAddresses.find(a => a.isDefault) || importedAddresses[0] || null;
    const doc = {
      id,
      name,
      phone,
      secondaryPhone: String(row.secondaryPhone || '').trim(),
      category: String(row.category || '').trim() || (window.DEFAULT_CUSTOMER_CATEGORY || 'عميل قطاعي / فردي'),
      address: defaultAddr ? String(defaultAddr.address).trim() : addressText,
      addresses: importedAddresses,
      notes: String(row.notes || '').trim(),
      ordersCount: 0,
      totalPurchases: 0,
      paid: 0,
      remainingBalance: 0,
      lastOrderDate: null,
      createdAt: getCairoFormattedDate(),
      updatedAt: getCairoFormattedDate(),
      syncUpdatedAt: timeCell(row) || getCairoFormattedDate()
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.CUSTOMERS, doc);
    // V3.14: when a NEW customer row carries computed aggregate columns (e.g.
    // remainingBalance/totalPurchases/paid/ordersCount) they are NEVER
    // imported — the ledger re-derives them. Record the rejection so the
    // audit trail shows exactly why a hand-typed aggregate was ignored.
    const notes = [];
    for (const f of sheetOf('customers').protected) {
      if (row[f] !== undefined && row[f] !== null && row[f] !== '') {
        notes.push('حقل محاسب محسوب ' + f + ' (' + strCell(row[f]) + ') لم يُستورد — يُحسب من الفواتير والدفعات فقط');
      }
    }
    return { created: true, entityId: id, entityName: name, audits: ['SYNC_CREATE عميل ' + id], notes };
  }
  const payload = {};
  const notes = [];
  for (const f of sheetOf('customers').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (f === 'phone') {
      const phone = String(row[f]).trim();
      if (window.validateEgyptianPhone) {
        const pv = window.validateEgyptianPhone(phone);
        if (!pv.isValid) throw new Error(pv.message || 'رقم هاتف غير صالح');
      }
      if (window.findCustomerByPhone && phone && window.findCustomerByPhone(phone, id)) throw new Error('رقم هاتف مسجل بالفعل لعميل آخر');
      payload.phone = phone;
    } else if (f === 'addresses') {
      // V3.26 — restore the full address list; the primary `address` is derived
      // from the default address so the two never drift apart.
      const list = parseAddressesField(row[f]);
      const defaultAddr = list.find(a => a.isDefault) || list[0] || null;
      payload.addresses = list;
      if (defaultAddr) payload.address = String(defaultAddr.address).trim();
    } else {
      payload[f] = String(row[f]).trim();
    }
  }
  for (const f of sheetOf('customers').protected) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (strCell(row[f]) !== strCell(existing[f])) notes.push('حقل محاسب محسوب ' + f + ' (يُحسب من السيستم فقط)');
  }
  if (Object.keys(payload).length) {
    // V3.25 — the final merged primary + secondary must stay unique against
    // every OTHER customer before the edit is persisted.
    if ((payload.phone !== undefined || payload.secondaryPhone !== undefined) && window.assertCustomerPhoneAvailable) {
      const finalPhone = payload.phone !== undefined ? String(payload.phone).trim() : String(existing.phone || '');
      const finalSecondary = payload.secondaryPhone !== undefined ? String(payload.secondaryPhone).trim() : String(existing.secondaryPhone || '');
      window.assertCustomerPhoneAvailable(finalPhone, finalSecondary, id);
    }
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.CUSTOMERS, id, payload);
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: payload.name || existing.name || '', notes };
}

function applySupplier(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    const phone = String(row.phone || '').trim();
    const name = String(row.name || '').trim();
    if (!name) throw new Error('اسم المورد مطلوب');
    // V3.25 — same uniqueness rule as the live screens: the imported primary
    // AND secondary phone must not collide with any existing supplier number.
    if (window.assertSupplierPhoneAvailable) {
      window.assertSupplierPhoneAvailable(phone, String(row.secondaryPhone || '').trim(), '');
    }
    const doc = {
      id,
      name,
      phone,
      secondaryPhone: String(row.secondaryPhone || '').trim(),
      address: String(row.address || '').trim(),
      notes: String(row.notes || '').trim(),
      // Restore: trust the exported balance snapshot (the app has no
      // recalculate-everything equivalent for suppliers).
      totalPurchases: num(row.totalPurchases, 'totalPurchases', false) || 0,
      paid: num(row.paid, 'paid', false) || 0,
      remainingBalance: num(row.remainingBalance, 'remainingBalance', false) || 0,
      createdAt: getCairoFormattedDate(),
      updatedAt: getCairoFormattedDate(),
      syncUpdatedAt: timeCell(row) || getCairoFormattedDate()
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.SUPPLIERS, doc);
    return { created: true, entityId: id, entityName: name, audits: ['SYNC_CREATE مورد ' + id] };
  }
  const payload = {};
  const notes = [];
  for (const f of sheetOf('suppliers').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (f === 'phone') {
      const phone = String(row[f]).trim();
      if (window.findSupplierByPhone && phone && window.findSupplierByPhone(phone, id)) throw new Error('رقم هاتف مسجل بالفعل لمورد آخر');
      payload.phone = phone;
    } else {
      payload[f] = String(row[f]).trim();
    }
  }
  for (const f of sheetOf('suppliers').protected) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (strCell(row[f]) !== strCell(existing[f])) notes.push('حقل محاسب محسوب ' + f + ' (يُحسب من السيستم فقط)');
  }
  if (Object.keys(payload).length) {
    // V3.25 — the final merged primary + secondary must stay unique against
    // every OTHER supplier before the edit is persisted.
    if ((payload.phone !== undefined || payload.secondaryPhone !== undefined) && window.assertSupplierPhoneAvailable) {
      const finalPhone = payload.phone !== undefined ? String(payload.phone).trim() : String(existing.phone || '');
      const finalSecondary = payload.secondaryPhone !== undefined ? String(payload.secondaryPhone).trim() : String(existing.secondaryPhone || '');
      window.assertSupplierPhoneAvailable(finalPhone, finalSecondary, id);
    }
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.SUPPLIERS, id, payload);
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: payload.name || existing.name || '', notes };
}

function applyProduct(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    const name = String(row.name || '').trim();
    const code = String(row.code || '').trim();
    if (!name) throw new Error('اسم المنتج مطلوب');
    if (window.findDuplicateProduct && window.findDuplicateProduct({ name, code })) throw new Error('منتج مكرر بنفس الاسم أو الكود (SKU)');
    const purchasePrice = num(row.purchasePrice, 'سعر الشراء', false) || 0;
    const sellingPrice = num(row.sellingPrice, 'سعر البيع', false) || 0;
    const stock = num(row.stock, 'المخزون', false);
    const minStock = num(row.minStock, 'حد إعادة الطلب', false);
    const doc = {
      id,
      code: code || id,
      name,
      category: String(row.category || '').trim() || 'عام',
      purchasePrice,
      sellingPrice,
      stock: stock == null ? 0 : stock,
      minStock: minStock == null ? 5 : minStock,
      supplierId: String(row.supplierId || '').trim(),
      supplierName: String(row.supplierName || '').trim(),
      createdAt: getCairoFormattedDate(),
      updatedAt: getCairoFormattedDate(),
      syncUpdatedAt: timeCell(row) || getCairoFormattedDate()
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.PRODUCTS, doc);
    const audits = ['SYNC_CREATE منتج ' + id];
    if (doc.stock > 0) audits.push('SYNC_STOCK_CHANGE ' + id + ' 0→' + doc.stock);
    return { created: true, entityId: id, entityName: name, audits };
  }
  const payload = {};
  const notes = [];
  const oldStock = Number(existing.stock) || 0;
  for (const f of sheetOf('products').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (f === 'purchasePrice' || f === 'sellingPrice' || f === 'stock' || f === 'minStock') {
      const n = num(row[f], f, false);
      if (n == null) continue;
      payload[f] = n;
    } else {
      payload[f] = String(row[f]).trim();
    }
  }
  if (window.findDuplicateProduct && (payload.name !== undefined || payload.code !== undefined)) {
    if (window.findDuplicateProduct({ name: payload.name || existing.name, code: payload.code || existing.code, excludeId: id })) {
      throw new Error('منتج مكرر بنفس الاسم أو الكود (SKU)');
    }
  }
  const audits = [];
  if (payload.stock !== undefined && Number(payload.stock) !== oldStock) {
    audits.push('SYNC_STOCK_CHANGE ' + id + ' ' + oldStock + '→' + Number(payload.stock));
  }
  if (Object.keys(payload).length) {
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.PRODUCTS, id, payload);
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: payload.name || existing.name || '', notes, audits };
}

function applyOrder(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    // Full restore: rebuild the order document directly from the sheet row.
    // No stock movement and no treasury receipt are re-created here — stock is
    // restored by Products_Inventory and receipts by Treasury_Payments; the
    // customer balance is recomputed once after the whole import finishes.
    const customerId = String(row.customerId || '').trim();
    if (!customerId) throw new Error('صف الطلب ' + id + ' بلا رقم عميل (customerId)');
    const custRes = ensureCustomer(row);
    if (!custRes) throw new Error('صف الطلب ' + id + ' غير قادر على إنشاء/إيجاد العميل');
    const items = parseJSONField(row.items);
    const computedSubtotal = window.round2(items.reduce((s, it) => s + (Number(it.subtotal) || (Number(it.quantity || 0) * Number(it.sellingPrice || 0)) || 0), 0));
    // V3.14: when the items JSON is present and computable the sheet's own
    // aggregate columns (itemsSubtotal / totalAmount / remainingBalance) are
    // NEVER trusted — the system's formulas re-derive them from the items, so
    // a hand-typed aggregate (e.g. 78000 in the إجمالي الفاتورة column) can
    // never inflate an order or, through it, the customer's balance.
    const hasUsableItems = Array.isArray(items) && items.length > 0 && computedSubtotal > 0;
    const shipCost = row.shippingCost === undefined || row.shippingCost === null || row.shippingCost === '' ? 0 : num(row.shippingCost, 'الشحن', false);
    const shipPayer = String(row.shippingPayer || '').trim() || 'customer';
    const exCost = row.extraExpenses === undefined || row.extraExpenses === null || row.extraExpenses === '' ? 0 : num(row.extraExpenses, 'مصروفات إضافية', false);
    const exPayer = String(row.extraExpensesPayer || '').trim() || 'customer';
    const itemsSubtotal = window.round2(hasUsableItems
      ? computedSubtotal
      : (row.itemsSubtotal === undefined || row.itemsSubtotal === null || row.itemsSubtotal === '' ? computedSubtotal : num(row.itemsSubtotal, 'قيمة البضاعة', false)));
    const recomputedTotal = window.round2(itemsSubtotal + (shipPayer === 'customer' ? shipCost : 0) + (exPayer === 'customer' ? exCost : 0));
    const sheetTotal = row.totalAmount === undefined || row.totalAmount === null || row.totalAmount === '' ? null : num(row.totalAmount, 'إجمالي الفاتورة', false);
    const totalAmount = window.round2(hasUsableItems ? recomputedTotal : (sheetTotal === null ? recomputedTotal : sheetTotal));
    const downPayment = window.round2(row.downPayment === undefined || row.downPayment === null || row.downPayment === '' ? 0 : num(row.downPayment, 'المدفوع', false));
    const status = String(row.status || '').trim() || 'new';
    // V3.16 — cancelled/returned orders are settled invoices: المتبقي 0 دائماً
    // (they can never carry debt), active orders use the standard total − paid.
    const remainingBalance = (status === 'cancelled' || status === 'returned')
      ? 0
      : window.round2(Math.max(0, totalAmount - downPayment));
    const now = getCairoFormattedDate();
    const createdAt = String(row.createdAt || '').trim() || timeCell(row) || now;
    const doc = {
      id,
      customerId,
      customerName: String(row.customerName || '').trim() || custRes.entity.name,
      customerPhone: String(row.customerPhone || '').trim() || (custRes.entity.phone || ''),
      customerSecondaryPhone: String(row.customerSecondaryPhone || '').trim() || (custRes.entity.secondaryPhone || ''),
      customerCategory: String(row.customerCategory || '').trim() || (custRes.entity.category || window.DEFAULT_CUSTOMER_CATEGORY || 'عميل قطاعي / فردي'),
      // V3.26 — restore the shipping address chosen for THIS order (plus its
      // label/id) so the invoice keeps its exact delivery info after a restore.
      shippingAddress: String(row.shippingAddress || '').trim(),
      shippingAddressLabel: String(row.shippingAddressLabel || '').trim(),
      shippingAddressId: String(row.shippingAddressId || '').trim(),
      items,
      itemsSubtotal,
      shippingCost: shipCost,
      shippingPayer: shipPayer,
      extraExpenses: exCost,
      extraExpensesPayer: exPayer,
      totalAmount,
      downPayment,
      remainingBalance,
      paidInFull: totalAmount <= downPayment,
      status,
      depositType: String(row.depositType || '').trim() || 'custom',
      shippingRevenueDeposit: row.shippingRevenueDeposit === undefined || row.shippingRevenueDeposit === null || row.shippingRevenueDeposit === '' ? 0 : num(row.shippingRevenueDeposit, 'حجز إيراد الشحن', false),
      refundedAmount: row.refundedAmount === undefined || row.refundedAmount === null || row.refundedAmount === '' ? 0 : num(row.refundedAmount, 'المرتد', false),
      retainedDeposit: row.retainedDeposit === undefined || row.retainedDeposit === null || row.retainedDeposit === '' ? 0 : num(row.retainedDeposit, 'المحتفظ به', false),
      directShipping: truthy(row.directShipping),
      supplierShipments: parseJSONField(row.supplierShipments),
      supplierDeficits: parseJSONField(row.supplierDeficits),
      createdBy: String(row.createdBy || '').trim() || 'المدير العام',
      createdAt,
      updatedAt: timeCell(row) || createdAt,
      syncUpdatedAt: timeCell(row) || createdAt
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.ORDERS, doc);
    const audits = ['SYNC_CREATE طلب ' + id];
    const notes = [];
    if (custRes.created) audits.push('SYNC_FALLBACK_CREATE عميل ' + customerId + ' (مرجع غير موجود محلياً — أُنشئ احتياطياً)');
    if (hasUsableItems && sheetTotal !== null && sheetTotal !== recomputedTotal) {
      notes.push('إجمالي الفاتورة في الشيت (' + sheetTotal + ') لم يُعتمد — أُعيد حسابه من الأصناف (' + recomputedTotal + ') لمنع وصول مبالغ مجمعة إلى الأرصدة');
    }
    return { created: true, entityId: id, entityName: doc.customerName, audits, notes };
  }
  const notes = [];
  const payload = {};
  // Protected / computed fields are never imported.
  for (const f of sheetOf('orders').protected) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (strCell(row[f]) !== strCell(existing[f])) notes.push('حقل محمي/محسوب ' + f + ' لم يُعدل (قيمة السيستم باقية)');
  }
  for (const f of sheetOf('orders').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (f === 'shippingCost' || f === 'extraExpenses') {
      payload[f] = num(row[f], f, false) || 0;
    } else {
      payload[f] = String(row[f]).trim();
    }
  }
  if (payload.shippingCost !== undefined || payload.shippingPayer !== undefined ||
      payload.extraExpenses !== undefined || payload.extraExpensesPayer !== undefined ||
      payload.depositType !== undefined) {
    // Re-run the system's approved accounting formulas instead of trusting
    // any imported computed number.
    const shipCost = payload.shippingCost !== undefined ? payload.shippingCost : (Number(existing.shippingCost) || 0);
    const shipPayer = payload.shippingPayer !== undefined ? payload.shippingPayer : (existing.shippingPayer || 'customer');
    const exCost = payload.extraExpenses !== undefined ? payload.extraExpenses : (Number(existing.extraExpenses) || 0);
    const exPayer = payload.extraExpensesPayer !== undefined ? payload.extraExpensesPayer : (existing.extraExpensesPayer || 'customer');
    const depType = payload.depositType !== undefined ? payload.depositType : (existing.depositType || 'custom');
    const itemsSubtotal = Number(existing.itemsSubtotal) || 0;
    const totalAmount = window.round2(itemsSubtotal + (shipPayer === 'customer' ? shipCost : 0) + (exPayer === 'customer' ? exCost : 0));
    const downPayment = Number(existing.downPayment) || 0;
    const srd = window.computeShippingRevenueDeposit ? window.computeShippingRevenueDeposit(depType, downPayment, shipCost, exCost, shipPayer, exPayer) : 0;
    payload.totalAmount = totalAmount;
    // V3.16 — cancelled/returned orders are settled invoices: المتبقي 0 دائماً.
    payload.remainingBalance = (existing.status === 'cancelled' || existing.status === 'returned')
      ? 0
      : window.round2(Math.max(0, totalAmount - downPayment));
    payload.paidInFull = totalAmount <= downPayment;
    payload.shippingRevenueDeposit = srd;
    // Keep persisted payer fields in sync with the computed totals.
    payload.shippingPayer = shipPayer;
    payload.extraExpensesPayer = exPayer;
    payload.depositType = depType;
  }
  if (Object.keys(payload).length) {
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.ORDERS, id, payload);
    if (existing.customerId && window.recalculateCustomerBalance) {
      window.recalculateCustomerBalance(existing.customerId);
    }
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: existing.customerName || '', notes };
}

function applyPayment(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    // Full restore: rebuild the treasury record directly from the sheet row.
    // The amount is trusted as exported (refunds are negative); the balance
    // guards in createPaymentRecord intentionally don't apply to a restore.
    const entityType = String(row.entityType || '').trim();
    const entityId = String(row.entityId || '').trim();
    if (!entityType || !entityId) throw new Error('صف الدفعة ' + id + ' بلا طرف (entityType/entityId)');
    const amount = row.amount === undefined || row.amount === null || row.amount === '' ? null : num(row.amount, 'المبلغ', true);
    if (amount === null) throw new Error('مبلغ الدفعة ' + id + ' غير صالح');
    let entityName = String(row.entityName || '').trim();
    let fallbackCreated = false;
    if (entityType === 'customer') {
      const c = ensureCustomer({ customerId: entityId, customerName: entityName });
      if (c && c.created) fallbackCreated = true;
      if (c && !entityName) entityName = c.entity.name;
    } else if (entityType === 'supplier') {
      const s = ensureSupplier(entityId, entityName);
      if (s && s.created) fallbackCreated = true;
      if (s && !entityName) entityName = s.entity.name;
    }
    const now = getCairoFormattedDate();
    const createdAt = String(row.createdAt || '').trim() || timeCell(row) || now;
    const doc = {
      id,
      entityType,
      entityId,
      entityName: entityName || (entityType === 'supplier' ? 'مورد غير معروف' : 'عميل غير معروف'),
      amount,
      date: String(row.date || '').trim() || timeCell(row) || String(createdAt).replace('T', ' ').split(' ')[0],
      paymentMethod: String(row.paymentMethod || '').trim() || 'cash',
      notes: String(row.notes || '').trim(),
      isDownPayment: truthy(row.isDownPayment),
      allocatedToOrders: truthy(row.allocatedToOrders),
      createdBy: String(row.createdBy || '').trim() || 'المدير العام',
      createdAt,
      updatedAt: timeCell(row) || createdAt,
      syncUpdatedAt: timeCell(row) || createdAt
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.PAYMENTS, doc);
    const audits = ['SYNC_CREATE دفعة ' + id];
    if (fallbackCreated) audits.push('SYNC_FALLBACK_CREATE ' + entityType + ' ' + entityId + ' (مرجع غير موجود محلياً — أُنشئ احتياطياً)');
    return { created: true, entityId: id, entityName: doc.entityName, audits };
  }
  const notes = [];
  for (const f of sheetOf('payments').protected) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (strCell(row[f]) !== strCell(existing[f])) notes.push('حقل خزينة محمي ' + f + ' (لم يُعدل)');
  }
  const payload = {};
  for (const f of sheetOf('payments').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    payload[f] = String(row[f]).trim();
  }
  if (Object.keys(payload).length) {
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.PAYMENTS, id, payload);
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: existing.entityName || '', notes };
}

function applyUser(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    // Full restore: recreate the account. The sheet never carries passwords,
    // so a fixed default password is assigned and must be changed afterwards.
    const name = String(row.name || '').trim();
    const email = String(row.email || '').trim();
    if (!name) throw new Error('اسم الموظف مطلوب لإنشاء حساب ' + id);
    if (!email) throw new Error('البريد الإلكتروني مطلوب لإنشاء حساب ' + id);
    const norm = email.trim().toLowerCase();
    const dup = window.getUsers().find(u => u.email && String(u.email).trim().toLowerCase() === norm);
    if (dup) throw new Error('بريد إلكتروني مسجل بالفعل لمستخدم آخر');
    const role = String(row.role || '').trim() || 'employee';
    const now = getCairoFormattedDate();
    const createdAt = String(row.createdAt || '').trim() || timeCell(row) || now;
    const doc = {
      id,
      name,
      email: email.trim(),
      password: RESTORE_DEFAULT_PASSWORD,
      role,
      createdAt,
      updatedAt: timeCell(row) || createdAt,
      syncUpdatedAt: timeCell(row) || createdAt
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.USER, doc);
    return {
      created: true,
      entityId: id,
      entityName: name,
      audits: ['SYNC_CREATE مستخدم ' + id],
      notes: ['كلمة مرور افتراضية ' + RESTORE_DEFAULT_PASSWORD + ' (لم تُستورد من الشيت) — غيّرها بعد أول دخول']
    };
  }
  const notes = [];
  if (row.password !== undefined && row.password !== null && String(row.password).trim() !== '') {
    notes.push('كلمة المرور محمية ولا تُستورد');
  }
  const payload = {};
  for (const f of sheetOf('users').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    payload[f] = String(row[f]).trim();
  }
  if (payload.email) {
    const norm = payload.email.trim().toLowerCase();
    const dup = window.getUsers().find(u => u.id !== id && u.email && String(u.email).trim().toLowerCase() === norm);
    if (dup) throw new Error('بريد إلكتروني مسجل بالفعل لمستخدم آخر');
  }
  if (id === 'USR-1001' && payload.role && payload.role !== (existing.role || 'admin')) {
    notes.push('صلاحية المدير العام الرئيسي محمية');
    delete payload.role;
  }
  if (Object.keys(payload).length) {
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.USER, id, payload);
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: payload.name || existing.name || '', notes };
}

function applySupplierReturn(row, existing) {
  const id = String(row.id).trim();
  if (!existing) {
    // Full restore: rebuild the purchase-return record directly from the row.
    // Supplier balances were restored from Suppliers_Accounts; the return is
    // recreated for the ledger/history and its items are kept as exported.
    const supplierId = String(row.supplierId || '').trim();
    if (!supplierId) throw new Error('صف المرتجع ' + id + ' بلا رقم مورد (supplierId)');
    const supRes = ensureSupplier(supplierId, String(row.supplierName || '').trim());
    if (!supRes) throw new Error('صف المرتجع ' + id + ' غير قادر على إنشاء/إيجاد المورد');
    const items = parseJSONField(row.items);
    const totalValue = row.totalValue === undefined || row.totalValue === null || row.totalValue === '' ? null : window.round2(num(row.totalValue, 'قيمة المرتجع', false));
    if (totalValue === null) throw new Error('قيمة المرتجع ' + id + ' غير صالحة');
    const now = getCairoFormattedDate();
    const createdAt = String(row.createdAt || '').trim() || timeCell(row) || now;
    const doc = {
      id,
      supplierId,
      supplierName: supRes.entity.name,
      items,
      totalValue,
      refundType: String(row.refundType || '').trim() === 'cash' ? 'cash' : 'debt',
      notes: String(row.notes || '').trim(),
      createdBy: String(row.createdBy || '').trim() || 'المدير العام',
      createdAt,
      updatedAt: timeCell(row) || createdAt,
      syncUpdatedAt: timeCell(row) || createdAt
    };
    window.addFirestoreDoc(window.STORAGE_KEYS.SUPPLIER_RETURNS, doc);
    const audits = ['SYNC_CREATE مرتجع مشتريات ' + id];
    if (supRes.created) audits.push('SYNC_FALLBACK_CREATE مورد ' + supplierId + ' (مرجع غير موجود محلياً — أُنشئ احتياطياً)');
    return { created: true, entityId: id, entityName: doc.supplierName, audits };
  }
  const notes = [];
  const payload = {};
  for (const f of sheetOf('supplierReturns').editable) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    if (f === 'refundType') {
      payload[f] = String(row[f]).trim() === 'cash' ? 'cash' : 'debt';
    } else {
      payload[f] = String(row[f]).trim();
    }
  }
  for (const f of sheetOf('supplierReturns').protected) {
    if (row[f] === undefined || row[f] === null || row[f] === '') continue;
    const compareVal = f === 'items' ? JSON.stringify(parseJSONField(row[f])) : strCell(row[f]);
    const existingVal = f === 'items' ? JSON.stringify(existing[f] || []) : strCell(existing[f]);
    if (compareVal !== existingVal) notes.push('حقل محمي/محسوب ' + f + ' لم يُعدل (قيمة السيستم باقية)');
  }
  if (Object.keys(payload).length) {
    payload.updatedAt = getCairoFormattedDate();
    payload.syncUpdatedAt = timeCell(row) || getCairoFormattedDate();
    window.updateFirestoreDoc(window.STORAGE_KEYS.SUPPLIER_RETURNS, id, payload);
  }
  return { updated: Object.keys(payload).length > 0, entityId: id, entityName: existing.supplierName || '', notes };
}

function applyRow(row, existing) {
  const key = String(row._sheetEntity || '');
  if (key === 'customers') return applyCustomer(row, existing);
  if (key === 'suppliers') return applySupplier(row, existing);
  if (key === 'products') return applyProduct(row, existing);
  if (key === 'orders') return applyOrder(row, existing);
  if (key === 'payments') return applyPayment(row, existing);
  if (key === 'supplierReturns') return applySupplierReturn(row, existing);
  if (key === 'users') return applyUser(row, existing);
  return { skipped: true, reason: 'كيان غير معروف' };
}

let _sheetIndex = null;
function sheetOf(key) {
  if (!_sheetIndex) {
    _sheetIndex = {};
    SHEETS.forEach(s => { _sheetIndex[s.entityKey] = s; });
  }
  return _sheetIndex[key];
}

NS.importAll = async function (transport) {
  if (!transport) throw new Error('SyncTransport غير محقون — استخدم NS.setTransport أو مرر transport');
  const report = { sheets: [], rowsImported: 0, rowsSkipped: 0, errors: [] };
  // Snapshot of the local version of every entity at the moment the sync
  // started. LWW must compare the sheet rows against this snapshot, not the
  // live updatedAt: recalculations the sync itself triggers mid-import
  // (e.g. applyOrder -> recalculateCustomerBalance) bump updatedAt and would
  // otherwise make unchanged sibling rows look stale and drop real sheet edits.
  const snapTimes = {};
  SHEETS.forEach(function (sheet) {
    collection(sheet.entityKey).forEach(function (e) {
      snapTimes[sheet.entityKey + '\u0001' + String(e.id)] = entityTime(e);
    });
  });
  // Import must resolve references before they are used, so the sheets are
  // read in dependency order (export order is preserved by SHEETS above).
  const IMPORT_ORDER = ['products', 'customers', 'suppliers', 'orders', 'payments', 'supplierReturns', 'users'];
  for (const key of IMPORT_ORDER) {
    const sheet = sheetOf(key);
    if (!sheet) continue;
    const data = await transport.readSheet(sheet.title);
    const rows = (data && data.rows) || [];
    const sReport = { title: sheet.title, label: sheet.label, rows: rows.length, imported: 0, skipped: 0 };
    for (const rawRow of rows) {
      const row = normalizeRow(sheet, rawRow);
      const id = row && row[sheet.idField];
      if (!id || String(id).trim() === '') {
        sReport.skipped++;
        continue;
      }
      row._sheetEntity = sheet.entityKey;
      const existing = findEntity(sheet.entityKey, String(id).trim());
      const snapKey = sheet.entityKey + '\u0001' + String(id).trim();
      const localTime = Object.prototype.hasOwnProperty.call(snapTimes, snapKey) ? snapTimes[snapKey] : entityTime(existing);
      if (existing && !lwwAllows(rowTime(row), localTime)) {
        sReport.skipped++;
        recordAudit({ type: 'SYNC_SKIP_LWW', sheet: sheet.title, entityId: String(id).trim(), detail: 'الصف أقدم من النسخة المحلية (آخر تعديل يفوز)' });
        continue;
      }
      try {
        const res = applyRow(row, existing);
        if (res.skipped) {
          sReport.skipped++;
          recordAudit({ type: 'SYNC_SKIP', sheet: sheet.title, entityId: String(id).trim(), detail: res.reason });
        } else {
          sReport.imported++;
          report.rowsImported++;
          (res.audits || []).forEach(a => {
            const parts = a.split(' ');
            recordAudit({ type: parts[0], sheet: sheet.title, entityId: String(id).trim(), detail: a });
          });
          (res.notes || []).forEach(n => recordAudit({ type: 'SYNC_REJECT_FIELD', sheet: sheet.title, entityId: String(id).trim(), detail: n }));
        }
      } catch (e) {
        sReport.skipped++;
        const msg = e && e.message ? e.message : String(e);
        report.errors.push({ sheet: sheet.title, entityId: String(id).trim(), error: msg });
        recordAudit({ type: 'SYNC_ERROR', sheet: sheet.title, entityId: String(id).trim(), detail: msg });
      }
    }
    report.rowsSkipped += sReport.skipped;
    report.sheets.push(sReport);
  }
  // Full restore: rebuild every customer balance from the imported orders and
  // payments so the accounting identity holds without trusting sheet numbers.
  if (window.recalculateAllCustomerBalances) {
    window.recalculateAllCustomerBalances();
    recordAudit({ type: 'SYNC_RECALC', sheet: 'Customers_Balances', entityId: '*', detail: 'إعادة حساب أرصدة العملاء بعد الاستيراد' });
  }
  return report;
};

// ----------------------------------------------------------------
// Orchestration
// ----------------------------------------------------------------
let _activeTransport = null;
NS.setTransport = function (t) { _activeTransport = t; return NS; };
NS.getTransport = function () { return _activeTransport; };

NS.syncNow = async function (opts) {
  if (window.isSandboxMode) {
    // Sandbox: Google Sheets must never be touched (no export, no import).
    return { direction: (opts && opts.direction) || 'export', startedAt: getCairoFormattedDate(), exported: null, imported: null, sandboxBlocked: true };
  }
  opts = opts || {};
  const cfg = NS.getConfig();
  const transport = opts.transport || _activeTransport;
  if (!transport) throw new Error('لم يتم حقن SyncTransport — استخدم NS.setTransport أو مرر transport في opts');
  const direction = (opts.direction || cfg.direction || 'export');
  const result = { direction, startedAt: getCairoFormattedDate(), exported: null, imported: null };
  let totalRows = 0;
  _syncing = true;
  try {
    if (direction === 'export' || direction === 'both') {
      result.exported = await NS.exportAll(transport);
      totalRows += result.exported.rowsTotal;
    }
    if (direction === 'import' || direction === 'both') {
      result.imported = await NS.importAll(transport);
      totalRows += result.imported.rowsImported;
    }
    recordLog({
      direction,
      status: 'success',
      rowsUpdated: totalRows,
      exportedSheets: result.exported ? result.exported.sheets.length : 0,
      importedRows: result.imported ? result.imported.rowsImported : 0,
      importedSheets: result.imported ? result.imported.sheets.length : 0
    });
    NS.saveConfig({ lastSyncAt: getCairoFormattedDate(), lastSyncDirection: direction, lastSyncRows: totalRows, lastSyncStatus: 'success', lastSyncError: '' });
    return result;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    recordLog({ direction, status: 'failed', rowsUpdated: totalRows, error: msg });
    NS.saveConfig({ lastSyncAt: getCairoFormattedDate(), lastSyncDirection: direction, lastSyncRows: totalRows, lastSyncStatus: 'failed', lastSyncError: msg });
    throw e;
  } finally {
    _syncing = false;
  }
};

// ----------------------------------------------------------------
// Auto-sync triggers (debounced "مع كل عملية" + periodic 15m/1h)
// ----------------------------------------------------------------
let _syncTimer = null;
let _dirty = false;
let _periodicTimer = null;
let _syncing = false;

NS.scheduleSync = function () {
  if (window.isSandboxMode) return;
  const cfg = NS.getConfig();
  if (!cfg.enabled || cfg.frequency !== 'every-op') return;
  if (cfg.direction === 'import') return;
  if (_syncing) return; // don't re-schedule while a sync itself is writing
  _dirty = true;
  if (_syncTimer) return; // coalesce pending ops into one batch
  const debounceMs = Number(cfg.debounceMs) > 0 ? Number(cfg.debounceMs) : 3000;
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    const run = _dirty;
    _dirty = false;
    if (run) {
      NS.syncNow({ direction: cfg.direction === 'both' ? 'both' : 'export' }).catch(() => {});
    }
  }, debounceMs);
};
NS.isSyncPending = function () { return !!_syncTimer; };
NS.flushSync = function () {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
  const run = _dirty;
  _dirty = false;
  if (!run) return Promise.resolve(null);
  const cfg = NS.getConfig();
  return NS.syncNow({ direction: cfg.direction === 'both' ? 'both' : 'export' });
};

NS.startAutoSync = function () {
  NS.stopAutoSync();
  const cfg = NS.getConfig();
  if (!cfg.enabled) return;
  let ms = null;
  if (cfg.frequency === '15m') ms = 15 * 60 * 1000;
  else if (cfg.frequency === '1h') ms = 60 * 60 * 1000;
  if (!ms) return;
  _periodicTimer = setInterval(() => {
    NS.syncNow().catch(() => {});
  }, ms);
};
NS.stopAutoSync = function () {
  if (_periodicTimer) {
    clearInterval(_periodicTimer);
    _periodicTimer = null;
  }
};

// ----------------------------------------------------------------
// Config & audit surfaces
// ----------------------------------------------------------------
NS.getConfig = function () {
  return Object.assign({}, DEFAULT_CONFIG, readJSON(CFG_KEY, {}));
};
NS.saveConfig = function (partial) {
  const cfg = Object.assign({}, NS.getConfig(), partial || {});
  cfg.spreadsheetId = String(cfg.spreadsheetId || '').trim();
  if (['export', 'import', 'both'].indexOf(cfg.direction) === -1) cfg.direction = 'export';
  if (['15m', '1h', 'every-op', 'manual'].indexOf(cfg.frequency) === -1) cfg.frequency = 'manual';
  cfg.enabled = !!cfg.enabled;
  if (window.isSandboxMode) return cfg; // sandbox: never persist sync config
  // V3.16.2/4 — LWW cloud-sync stamp. Strictly monotonic: max(now, prev+1)
  // so two saves in the same millisecond (coarse clocks, virtual time, two
  // devices writing within 1ms) can never tie and stall the cloud merge.
  const _prevStamp = Number((readJSON(CFG_KEY, {}) || {}).cfgUpdatedAt) || 0;
  cfg.cfgUpdatedAt = Math.max(Date.now(), _prevStamp + 1);
  writeJSON(CFG_KEY, cfg);
  _persistConfig(cfg);
  NS.startAutoSync();
  return cfg;
};

// ----------------------------------------------------------------
// V3.16.2 — cross-browser config sync (Firestore settings/syncConfig)
// The connection settings (spreadsheetId, clientId, clientSecret,
// refreshToken...) used to live ONLY in localStorage, so every new
// browser started empty. Now they mirror to Firestore when signed in,
// and `hydrateConfigFromCloud` pulls them back after login. Requires
// `firestore.rules` (signed-in read + admin write) to be deployed.
// ----------------------------------------------------------------
// V3.16.4 — last cloud-write outcome, so the save button can toast the exact
// Firestore error instead of the old fully-silent failure (the old `.catch`
// swallowed the reason, so a denied rules write looked like "not saved").
NS._lastConfigCloudError = null;

function _persistConfig(cfg) {
  if (window.isSandboxMode) return Promise.resolve(false);
  if (!window.db || !window._authUser) {
    NS._lastConfigCloudError = new Error('غير مسجّل الدخول إلى السحابة');
    return Promise.resolve(false);
  }
  try {
    const p = window.db.collection('settings').doc('syncConfig').set({
      spreadsheetId: cfg.spreadsheetId || '',
      direction: cfg.direction || 'export',
      frequency: cfg.frequency || 'manual',
      enabled: !!cfg.enabled,
      clientId: cfg.clientId || '',
      clientSecret: cfg.clientSecret || '',
      refreshToken: cfg.refreshToken || '',
      apiKey: cfg.apiKey || '',
      cfgUpdatedAt: cfg.cfgUpdatedAt || Date.now()
    }, { merge: true });
    p.then(() => { NS._lastConfigCloudError = null; }).catch((err) => {
      NS._lastConfigCloudError = err;
      window.dispatchEvent(new CustomEvent('bms-sync-error', {
        detail: { context: 'syncConfig', message: err && err.message ? err.message : String(err) }
      }));
    });
    return p;
  } catch (e) {
    NS._lastConfigCloudError = e;
    return Promise.reject(e);
  }
}

// V3.16.4 — explicit cloud push for the save button: exact success/failure
// feedback instead of a swallowed exception. Keeps the settings mirrored to
// Firestore so every other browser restores them after login.
NS.pushConfigToCloud = function () {
  if (window.isSandboxMode) return Promise.resolve(false);
  if (!window.db || !window._authUser) {
    const err = new Error('سجّل الدخول أولاً ليُحفظ رابط المزامنة في السحابة');
    if (window.showToast) window.showToast('⚠️ ' + err.message, 'warning');
    return Promise.reject(err);
  }
  return _persistConfig(NS.getConfig()).then(() => {
    if (window.showToast) window.showToast('☁️ تم حفظ الإعدادات ومزامنتها مع السحابة ✓', 'success');
    return true;
  }).catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    if (window.showToast) window.showToast('⚠️ حُفظت محلياً فقط — تعذر الرفع للسحابة: ' + msg, 'error');
    window.dispatchEvent(new CustomEvent('bms-sync-error', {
      detail: { context: 'syncConfig', message: msg }
    }));
    return false;
  });
};

function _clearConfigCloud() {
  if (!window.db) return;
  try {
    window.db.collection('settings').doc('syncConfig').delete().catch(function () { /* silent */ });
  } catch { /* silent */ }
}

NS.hydrateConfigFromCloud = async function () {
  if (window.isSandboxMode || !window.db || !window.auth || !window._authUser) return;
  try {
    const snap = await window.db.collection('settings').doc('syncConfig').get();
    if (!snap.exists) return;
    const cloud = snap.data() || {};
    const cloudTs = Number(cloud.cfgUpdatedAt) || 0;
    if (!cloudTs) return;
    const local = NS.getConfig();
    const localTs = Number(local.cfgUpdatedAt) || 0;
    if (cloudTs > localTs) {
      // Another browser has newer link settings — adopt them locally.
      NS.saveConfig({
        spreadsheetId: cloud.spreadsheetId,
        direction: cloud.direction,
        frequency: cloud.frequency,
        enabled: !!cloud.enabled,
        clientId: cloud.clientId,
        clientSecret: cloud.clientSecret,
        refreshToken: cloud.refreshToken,
        apiKey: cloud.apiKey,
        cfgUpdatedAt: cloudTs
      });
    } else if (localTs > cloudTs && (local.spreadsheetId || local.clientId)) {
      // Local config is newer — push it up so other browsers see it.
      _persistConfig(local);
    }
    // V3.16.4 — tell the UI the cloud config was checked (and possibly adopted),
    // so an already-open settings panel can refresh itself from the merged value.
    window.dispatchEvent(new CustomEvent('bms-config-hydrated', { detail: { from: cloudTs > localTs ? 'cloud' : 'local' } }));
    // V3.17.1 — resume periodic Google sync after hydration: on a fresh browser
    // the config is restored from Firestore here, so the auto-sync interval must
    // restart too (startAutoSync is idempotent — it stops any prior timer first).
    NS.startAutoSync();
  } catch {
    // Rules may deny before the fail-closed rules are deployed: fall back to
    // local config. The error is surfaced through _persistConfig / bms-sync-error
    // when a write is attempted, never swallowed silently.
  }
};
NS.resetSyncState = function () {
  NS.stopAutoSync();
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
  _dirty = false;
  _activeTransport = null;
  localStorage.removeItem(CFG_KEY);
  localStorage.removeItem(LOG_KEY);
  localStorage.removeItem(AUDIT_KEY);
  _clearConfigCloud();
};
NS.getSyncLog = function () { return readJSON(LOG_KEY, []); };
NS.getSyncAuditRecords = function () { return readJSON(AUDIT_KEY, []); };
NS.getSheetDefinitions = function () {
  return SHEETS.map(s => ({ title: s.title, label: s.label, entityKey: s.entityKey, idField: s.idField, headers: s.headers.map(h => h.label), editable: s.editable.slice(), protected: s.protected.slice() }));
};

function recordLog(entry) {
  const log = NS.getSyncLog();
  log.unshift(Object.assign({ timestamp: getCairoFormattedDate() }, entry));
  writeJSON(LOG_KEY, log.slice(0, 200));
}
function recordAudit(entry) {
  const recs = NS.getSyncAuditRecords();
  recs.unshift(Object.assign({ timestamp: getCairoFormattedDate() }, entry));
  writeJSON(AUDIT_KEY, recs.slice(0, 1000));
}

// ----------------------------------------------------------------
// Transports
// ----------------------------------------------------------------
/**
 * In-memory transport for tests / offline dev. Sheets are keyed by title;
 * writeSheet upserts rows by their unique id (no duplicates).
 */
NS.createMemoryTransport = function (initialSheets) {
  const sheets = initialSheets || {};
  return {
    sheets,
    readSheet(title) {
      const s = sheets[title];
      if (!s) return Promise.resolve({ headers: [], rows: [] });
      return Promise.resolve({ headers: s.headers.slice(), rows: s.rows.map(r => Object.assign({}, r)) });
    },
    writeSheet(title, headers, rows) {
      const existing = sheets[title] || { headers, rows: [] };
      const map = {};
      existing.rows.forEach(r => { if (r.id != null && r.id !== '') map[r.id] = r; });
      rows.forEach(r => { if (r.id != null && r.id !== '') map[r.id] = r; });
      sheets[title] = { headers: headers.slice(), rows: Object.keys(map).map(k => map[k]) };
      return Promise.resolve({ rowsWritten: rows.length });
    }
  };
};

// ----------------------------------------------------------------
// V3.15 — Live ArrayFormula for the invoice-total column.
// Mirrors the app's invoice-total identity:
//   totalAmount = itemsSubtotal
//               + IF(shippingPayer='customer', shippingCost, 0)
//               + IF(extraExpensesPayer='customer', extraExpenses, 0)
// so that a manual edit of shipping/extra in Sheets recomputes
// "إجمالي الفاتورة" live. ONLY the real Google transport applies it: the
// in-memory transport stays value-based so tests/offline dev keep exact
// round-trips. Because the real transport reads back with
// valueRenderOption=UNFORMATTED_VALUE, imports receive the computed numbers —
// never the formula string — and applyOrder still ignores them whenever the
// order carries its items JSON (recomputed from the line items instead).
// ----------------------------------------------------------------
function colLetter(idx) {
  let n = idx + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function arrayFormulaFor(sheetTitle, cols) {
  if (sheetTitle !== 'Orders_Sales') return null;
  const keyAt = function (k) { const i = cols.indexOf(k); return i === -1 ? null : colLetter(i); };
  const guard = colLetter(0);
  const sub = keyAt('itemsSubtotal');
  const shipCost = keyAt('shippingCost');
  const shipPayer = keyAt('shippingPayer');
  const exCost = keyAt('extraExpenses');
  const exPayer = keyAt('extraExpensesPayer');
  if (!sub || !shipCost || !shipPayer || !exCost || !exPayer) return null;
  return '=ARRAYFORMULA(IF(' + guard + '2:' + guard + '="",,' + sub + '2:' + sub
    + '+IF(' + shipPayer + '2:' + shipPayer + '="customer",' + shipCost + '2:' + shipCost + ',0)'
    + '+IF(' + exPayer + '2:' + exPayer + '="customer",' + exCost + '2:' + exCost + ',0)))';
}

// ----------------------------------------------------------------
// OAuth silent renewal (V3.14)
// A long-lived refresh_token + client_id/client_secret exchange for a fresh
// access_token via the standard Google OAuth2 token endpoint. Never touches
// the sheets API; the transport calls it on 401/403 and retries once.
// ----------------------------------------------------------------
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

async function refreshOAuthToken(params) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken
  }).toString();
  let res;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
  } catch (e) {
    throw new Error('فشل الوصول إلى Google للتوكن: ' + (e && e.message ? e.message : String(e)));
  }
  let j = null;
  try { j = await res.json(); } catch { /* ignore non-JSON */ }
  if (!res.ok) {
    const detail = (j && (j.error_description || j.error)) || ('HTTP ' + res.status);
    let hint = '';
    if (/invalid_grant|expired or revoked|revoked|deleted|disabled user/i.test(detail)) {
      hint = ' (السبب الأرجح: الـ Refresh Token ملغى — غالباً لأن التطبيق ما زال في وضع Testing حيث تُلغى التوكنات كل 7 أيام. انقله إلى In production في Google Cloud Console ثم ولّد Refresh Token جديداً)';
    } else if (/invalid_client|client was not found|unauthorized_client/i.test(detail)) {
      hint = ' (السبب الأرجح: Client ID / Client Secret غير مطابقين للـ Refresh Token المحفوظ — راجع بيانات التطبيق في Google Cloud Console)';
    }
    throw new Error('رفض Google تجديد التوكن: ' + detail + hint);
  }
  if (!j || !j.access_token) throw new Error('لم يُرجع Google توكن Access جديد (استجابة غير مكتملة)');
  return j;
}

/**
 * Exchange the saved refresh_token for a fresh access token and persist it.
 * Throws a clear Arabic error when the required fields are missing.
 */
NS.refreshAccessToken = async function (overrides) {
  const cfg = Object.assign({}, NS.getConfig(), overrides || {});
  if (!cfg.refreshToken) throw new Error('لا يوجد Refresh Token محفوظ — أضفه في الإعدادات لتجديد التوكن تلقائياً');
  if (!cfg.clientId) throw new Error('أدخل Client ID أولاً (مطلوب مع Client Secret لتجديد التوكن)');
  if (!cfg.clientSecret) throw new Error('أدخل Client Secret أولاً (مطلوب مع Refresh Token لتجديد التوكن)');
  const j = await refreshOAuthToken({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken });
  const expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  NS.saveConfig({ accessToken: j.access_token, tokenExpiresAt: expiresAt });
  return j.access_token;
};

/**
 * Real Google Sheets API v4 transport (REST). Uses an OAuth access token
 * (config.accessToken) or an API key (config.apiKey) for a public sheet.
 * Read/merge/rewrite gives upsert semantics so rows are never duplicated.
 */
NS.createGoogleSheetsTransport = function (config) {
  config = config || {};
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(config.spreadsheetId || '');

  function authHeaders() {
    if (config.accessToken) return { Authorization: 'Bearer ' + config.accessToken };
    return {};
  }
  function authQuery() {
    return config.apiKey ? '&key=' + encodeURIComponent(config.apiKey) : '';
  }
  async function request(url, options, _retried) {
    options = options || {};
    const headers = Object.assign({}, authHeaders(), options.headers || {});
    const q = (url.indexOf('?') === -1 ? '?' : '&') + 'key=' + encodeURIComponent(config.apiKey || '');
    const finalUrl = config.apiKey ? (url + q) : url;
    const res = await fetch(finalUrl, Object.assign({}, options, { headers }));
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch { /* ignore */ }
      if (res.status === 401 || res.status === 403) {
        // V3.14: silent background renewal — if a refresh_token + client
        // credentials are configured, exchange them for a fresh access token
        // and retry the failed request exactly once before surfacing an error.
        const canRefresh = !_retried && config.refreshToken && config.clientId && config.clientSecret;
        if (canRefresh) {
          try {
            const t = await refreshOAuthToken({ clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: config.refreshToken });
            config.accessToken = t.access_token;
            const expiresAt = Date.now() + (Number(t.expires_in) || 3600) * 1000;
            config.tokenExpiresAt = expiresAt;
            if (config.onTokenRefreshed) config.onTokenRefreshed(t.access_token, expiresAt);
            return request(url, options, true);
          } catch (e2) {
            msg += ' — فشل التجديد التلقائي عبر Refresh Token: ' + (e2 && e2.message ? e2.message : String(e2));
          }
        } else {
          const expired = Number(config.tokenExpiresAt) > 0 && Date.now() > Number(config.tokenExpiresAt);
          if (expired && config.refreshToken) {
            msg += ' — انتهت صلاحية التوكن المحفوظ ولم ينجح التجديد التلقائي. تحقق من Client ID / Client Secret / Refresh Token أو أعد الربط بحساب Google';
          } else if (expired) {
            msg += ' — انتهت صلاحية التوكن المحفوظ. أعد الربط بحساب Google أو ألصق توكن Access جديد';
          } else {
            msg += ' — التوكن غير صالح أو لم يُفوَّض لهذا الشيت. ألصق توكن Access جديد من نوع OAuth (scope: https://www.googleapis.com/auth/spreadsheets) وأكّد أن حساب Google يملك صلاحية الوصول لهذا الشيت';
          }
        }
      }
      const err = new Error('فشل الاتصال بـ Google Sheets: ' + msg);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Auto-create any connected tab (e.g. the 7th Supplier_Returns) that is
  // missing from the spreadsheet, so a fresh export never fails with 404.
  let _tabsChecked = false;
  let _tabsPromise = null;
  function ensureTabs() {
    if (_tabsChecked) return _tabsPromise || Promise.resolve();
    _tabsChecked = true;
    _tabsPromise = request(base + '?fields=sheets.properties(title)', { method: 'GET' })
      .then(function (meta) {
        const existing = new Set((meta.sheets || []).map(function (s) { return s.properties && s.properties.title; }).filter(Boolean));
        const missing = SHEETS.map(function (s) { return s.title; }).filter(function (t) { return !existing.has(t); });
        if (!missing.length) return null;
        return request(base + ':batchUpdate', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ requests: missing.map(function (title) { return { addSheet: { properties: { title: title } } }; }) })
        });
      })
      .catch(function (err) {
        // Best-effort: a read-only API key or restricted scope shouldn't hard-fail
        // reads of existing tabs — let the per-tab request surface real errors.
        _tabsChecked = false;
        _tabsPromise = null;
        if (err && err.status === 404) throw err;
        return null;
      });
    return _tabsPromise;
  }

  return {
    readSheet(title) {
      const range = encodeURIComponent(title + '!A1:ZZ10000');
      // UNFORMATTED_VALUE: dates come back as serial numbers (deterministic
      // round-trip regardless of the spreadsheet locale), numbers as numbers.
      return ensureTabs().catch(function () {}).then(function () {
        return request(base + '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE' + authQuery());
      }).catch(function (err) {
        // A missing tab reads as an empty sheet instead of a hard error.
        if (err && err.status === 404) return { values: [] };
        throw err;
      }).then(function (json) {
        const values = (json && json.values) || [];
        const headers = values[0] || [];
        const sheetDef = SHEETS.find(s => s.title === title);
        const dateCols = {};
        if (sheetDef) {
          sheetDef.headers.forEach((h, idx) => { if (DATE_KEY_RE.test(h.key)) dateCols[idx] = true; });
        }
        const rows = [];
        for (let i = 1; i < values.length; i++) {
          const rec = {};
          headers.forEach((h, c) => {
            const v = values[i][c];
            if (v !== undefined && v !== '') {
              rec[h] = (dateCols[c] && typeof v === 'number') ? serialToCairo(v) : v;
            }
          });
          if (Object.keys(rec).length) rows.push(rec);
        }
        return { headers, rows };
      });
    },
    writeSheet(title, headers, rows, keys) {
      // Upsert by unique id: read existing, replace matching rows by id,
      // append the rest, then rewrite the sheet in one batch.
      return this.readSheet(title).then(() => {
        const cols = (keys && keys.length) ? keys : headers;
        const values = [headers];
        rows.forEach(r => {
          values.push(cols.map(k => formatExportCell(k, (r[k] !== undefined && r[k] !== null ? r[k] : ''))));
        });
        // V3.15 — live ArrayFormula for "إجمالي الفاتورة": only the REAL
        // transport applies it. The column's data cells are left blank and the
        // formula (entered in the first data row) fills the whole column, so
        // the array never collides with pre-written values. Google returns the
        // computed numbers when read (UNFORMATTED_VALUE), keeping import safe.
        if (values.length > 1) {
          const f = arrayFormulaFor(title, cols);
          if (f) {
            const idx = cols.indexOf('totalAmount');
            if (idx !== -1) {
              for (let r = 1; r < values.length; r++) values[r][idx] = '';
              values[1][idx] = f;
            }
          }
        }
        const body = { values };
        const range = title + '!A1';
        // NOTE: values.clear does NOT accept valueInputOption (unknown query
        // parameter) — only values.update/append do. Clear runs without it.
        // USER_ENTERED lets Google parse "2026-08-01 15:13" as a real date and
        // numeric cells as numbers (ph/ids are apostrophe-protected in toRow).
        return request(base + '/values/' + encodeURIComponent(range) + ':clear' + authQuery(), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()) })
          .then(() => request(base + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED' + authQuery(), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(body) }))
          .then(json => ({ rowsWritten: rows.length, updatedCells: json && json.totalUpdatedCells }));
      });
    }
  };
};

/**
 * Build the real Google Sheets transport from the saved config and inject it
 * as the active transport, so NS.syncNow() can run without extra arguments.
 * Throws a clear Arabic error when the spreadsheet is not configured.
 */
NS.connectGoogleSheets = function (cfg) {
  const merged = Object.assign({}, NS.getConfig(), cfg || {});
  const id = String(merged.spreadsheetId || '').trim();
  if (!id) throw new Error('أدخل Spreadsheet ID أولاً ثم احفظ الإعدادات');
  const transport = NS.createGoogleSheetsTransport({
    spreadsheetId: id,
    accessToken: merged.accessToken,
    apiKey: merged.apiKey,
    tokenExpiresAt: merged.tokenExpiresAt,
    clientId: merged.clientId,
    clientSecret: merged.clientSecret,
    refreshToken: merged.refreshToken,
    onTokenRefreshed: function (token, expiresAt) {
      // Persist the silently-renewed token so every future request uses it.
      NS.saveConfig({ accessToken: token, tokenExpiresAt: expiresAt });
    }
  });
  NS.setTransport(transport);
  return transport;
};

/**
 * V3.16 — Manual Google Sheets sync from the navbar "مزامنة الآن" button
 * (window.syncWithGoogleSheets). The direction is taken from the type saved in
 * the sync settings (تصدير فقط / استيراد فقط / بالاتجاهين) — the button never
 * guesses, it follows the configured external sync type. Refreshes an expired
 * access token proactively (when a refresh token is configured) and (re)builds
 * the real transport from the saved config before syncing.
 */
NS.syncWithGoogleSheets = async function () {
  if (window.isSandboxMode) {
    if (window.showToast) window.showToast('⚠️ وضع الاختبار نشط — مزامنة Google Sheets معطّلة حفاظاً على البيانات الحقيقية', 'warning');
    return null;
  }
  const cfg = NS.getConfig();
  const exp = Number(cfg.tokenExpiresAt) || 0;
  // V3.16.4 — refresh whenever the access token is missing OR expired (a missing
  // token was previously sent as an unauthenticated request → "Method doesn't
  // allow unregistered callers").
  const tokenMissingOrExpired = !cfg.accessToken || (exp > 0 && Date.now() > exp);
  if (tokenMissingOrExpired && cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
    await NS.refreshAccessToken();
  }
  NS.connectGoogleSheets();
  return NS.syncNow({ direction: cfg.direction });
};
window.syncWithGoogleSheets = NS.syncWithGoogleSheets;

// ----------------------------------------------------------------
// V3.17 — Open the linked Google Sheet in a new browser tab.
// ----------------------------------------------------------------
NS.openSheetUrl = function () {
  const id = (NS.getConfig() || {}).spreadsheetId || '';
  if (!id) {
    if (window.showToast) window.showToast('⚠️ لم يتم إدخال Spreadsheet ID في إعدادات الربط بعد', 'warning');
    return false;
  }
  window.open('https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id), '_blank', 'noopener,noreferrer');
  return true;
};
window.openSpreadsheet = NS.openSheetUrl;

// ----------------------------------------------------------------
// V3.17 — Quick sync-type switch from the navbar (بدون كلمة سر).
// Maps the dropdown value (both/export/import/off) onto the config
// `direction` + `enabled` pair, persists locally AND mirrors to
// Firestore settings/syncConfig immediately.
// ----------------------------------------------------------------
NS.setQuickDirection = function (value) {
  const v = value === 'both' ? 'both' : (value === 'import' ? 'import' : (value === 'export' ? 'export' : 'off'));
  const patch = { enabled: v !== 'off' };
  if (v !== 'off') patch.direction = v;
  NS.saveConfig(patch);
  NS.startAutoSync();
  if (typeof NS.pushConfigToCloud === 'function') NS.pushConfigToCloud();
  return NS.getConfig();
};

// ----------------------------------------------------------------
// Lightweight settings panel renderer (used by the app UI)
// ----------------------------------------------------------------
NS.renderSyncPanel = function (el, opts) {
  if (!el) return null;
  opts = opts || {};
  const cfg = NS.getConfig();
  const wrap = document.createElement('div');
  wrap.dir = 'rtl';
  const inputStyle = 'width:100%;padding:6px;border-radius:8px;border:1px solid var(--ui-border);background:var(--ui-bg);color:var(--ui-text)';
  const btnStyle = 'padding:8px 14px;border-radius:8px;border:none;color:#fff;cursor:pointer;font-weight:bold';
  const sensitiveDisabled = opts.unlocked ? '' : ' disabled';
  const lockRowHtml = opts.unlocked ? '' : (
    '  <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:-2px 0 2px">' +
    '    <button id="gs-unlock" style="' + btnStyle + ';background:#b45309">🔓 تعديل البيانات الحساسة</button>' +
    '    <button id="gs-lock" style="' + btnStyle + ';background:#334155;display:none">🔒 قفل البيانات الحساسة</button>' +
    '    <span id="gs-lock-note" style="color:var(--ui-dim);font-size:11px">الحقول الحساسة مقفلة — أدخل كلمة سر المدير لتعديلها</span>' +
    '  </div>'
  );
  wrap.innerHTML = [
    '<div style="display:flex;flex-direction:column;gap:10px;font-size:13px">',
    '  <label>Spreadsheet ID' +
    '    <input id="gs-sheet-id" type="text" placeholder="مثال: 1986eZQKcjK..." style="' + inputStyle + '" value="' + (cfg.spreadsheetId || '') + '"' + sensitiveDisabled + '>' +
    '  </label>',
    '  <label>Client ID (لتسجيل الدخول عبر حساب Google — اختياري)' +
    '    <input id="gs-client-id" type="text" placeholder="xxxx.apps.googleusercontent.com" style="' + inputStyle + '" value="' + (cfg.clientId || '') + '"' + sensitiveDisabled + '>' +
    '  </label>',
    '  <label>Client Secret (مطلوب مع Refresh Token للتجديد التلقائي — اختياري)' +
    '    <input id="gs-client-secret" type="password" placeholder="GOCSPX-..." style="' + inputStyle + '" value="' + (cfg.clientSecret || '') + '"' + sensitiveDisabled + '>' +
    '  </label>',
    lockRowHtml,
    '  <label>OAuth Access Token (أو ربط بحساب Google)' +
    '    <input id="gs-token" type="password" placeholder="ألصق التوكن هنا أو اضغط زر الربط" style="' + inputStyle + '" value="' + (cfg.accessToken || '') + '">' +
    '  </label>',
    '  <div id="gs-token-meta" style="color:var(--ui-dim);font-size:11px"></div>',
    '  <label>Refresh Token (طويل الأمد — يجدد Access Token تلقائياً عند انتهائه)' +
    '    <input id="gs-refresh-token" type="password" placeholder="1//0g..." style="' + inputStyle + '" value="' + (cfg.refreshToken || '') + '">' +
    '  </label>',
    '  <label>API Key (بديل للشيت العام — اختياري)' +
    '    <input id="gs-api-key" type="password" placeholder="AIza..." style="' + inputStyle + '" value="' + (cfg.apiKey || '') + '">' +
    '  </label>',
    '  <div style="display:flex;flex-wrap:wrap;gap:8px">' +
    '    <button id="gs-connect" style="' + btnStyle + ';background:#7c3aed">🔗 الربط / تسجيل الدخول بـ Google</button>' +
    '    <button id="gs-clear" style="' + btnStyle + ';background:#b91c1c">✖ مسح التوكن</button>' +
    '    <button id="gs-test" style="' + btnStyle + ';background:#0891b2">🔌 اختبار الاتصال</button>' +
    '  </div>',
    '  <label>اتجاه المزامنة' +
    '    <select id="gs-direction" style="' + inputStyle + '">' +
    '      <option value="export"' + (cfg.direction === 'export' ? ' selected' : '') + '>📤 تصدير فقط</option>' +
    '      <option value="import"' + (cfg.direction === 'import' ? ' selected' : '') + '>📥 استيراد فقط</option>' +
    '      <option value="both"' + (cfg.direction === 'both' ? ' selected' : '') + '>🔄 مزامنة بالاتجاهين</option>' +
    '    </select>' +
    '  </label>',
    '  <label>التكرار الدوري' +
    '    <select id="gs-frequency" style="' + inputStyle + '">' +
    '      <option value="15m"' + (cfg.frequency === '15m' ? ' selected' : '') + '>كل 15 دقيقة</option>' +
    '      <option value="1h"' + (cfg.frequency === '1h' ? ' selected' : '') + '>كل ساعة</option>' +
    '      <option value="every-op"' + (cfg.frequency === 'every-op' ? ' selected' : '') + '>مع كل عملية</option>' +
    '      <option value="manual"' + (cfg.frequency === 'manual' ? ' selected' : '') + '>يدوياً</option>' +
    '    </select>' +
    '  </label>',
    '  <label><input id="gs-enabled" type="checkbox"' + (cfg.enabled ? ' checked' : '') + '> تفعيل المزامنة التلقائية</label>',
    '  <div style="display:flex;flex-wrap:wrap;gap:8px">' +
    '    <button id="gs-save" style="' + btnStyle + ';background:#1d4ed8">حفظ الإعدادات</button>' +
    '    <button id="gs-syncnow" style="' + btnStyle + ';background:#059669">🔄 مزامنة الآن</button>' +
    '    <button id="gs-pushpending" style="' + btnStyle + ';background:#7c3aed">☁️ رفع السجلات المعلقة</button>' +
    '  </div>',
    '  <div id="gs-status" style="color:var(--ui-text);font-size:12px;background:var(--ui-bg);border:1px solid var(--ui-border);border-radius:8px;padding:8px"></div>',
    '  <div id="gs-last" style="color:var(--ui-dim);font-size:12px">آخر مزامنة: ' + (cfg.lastSyncStatus || 'لا توجد') + (cfg.lastSyncAt ? ' — ' + cfg.lastSyncAt : '') + (cfg.lastSyncRows ? ' (' + cfg.lastSyncRows + ' صف)' : '') + '</div>',
    '  <div style="font-size:11px;color:#64748b">سجل آخر 10 عمليات مزامنة:</div>',
    '  <div id="gs-audit" style="color:var(--ui-dim);font-size:11px;max-height:160px;overflow:auto"></div>',
    '</div>'
  ].join('');
  el.innerHTML = '';
  el.appendChild(wrap);

  let _tokenClient = null;
  const mask = (t) => {
    const s = String(t || '');
    return s.length > 8 ? s.slice(0, 4) + '••••' + s.slice(-4) : '••••';
  };

  const updateStatus = (msg, ok) => {
    const box = wrap.querySelector('#gs-status');
    if (!box) return;
    box.style.color = ok ? '#4ade80' : '#f87171';
    box.textContent = msg;
  };

  const renderTokenMeta = () => {
    const c = NS.getConfig();
    const meta = wrap.querySelector('#gs-token-meta');
    if (!meta) return;
    const parts = [];
    if (c.accessToken) {
      parts.push('توكن محفوظ: ' + mask(c.accessToken));
      const exp = Number(c.tokenExpiresAt) || 0;
      if (exp) {
        parts.push(c.refreshToken && exp <= Date.now()
          ? 'منتهي — سيُجدد تلقائياً في أول عملية (Refresh Token)'
          : (exp > Date.now() ? 'صالح حتى ' + new Date(exp).toLocaleString('ar-EG') : 'منتهي الصلاحية — أعد الربط'));
      }
    } else {
      parts.push(c.refreshToken ? 'لا يوجد Access حالياً — سيُستعاد تلقائياً من Refresh Token' : 'لا يوجد توكن بعد');
    }
    if (c.refreshToken) parts.push('Refresh Token محفوظ ✓');
    if (c.clientSecret) parts.push('Client Secret محفوظ ✓');
    if (c.apiKey) parts.push('API Key محفوظ');
    meta.textContent = parts.join(' • ');
  };

  const renderLog = () => {
    const log = NS.getSyncLog();
    const box = wrap.querySelector('#gs-audit');
    if (!box) return;
    box.innerHTML = log.slice(0, 10).map(e => '<div>' + (e.timestamp || '') + ' — ' + (e.direction || '') + ' — ' + (e.status || '') + (e.rowsUpdated != null ? ' — ' + e.rowsUpdated + ' صف' : '') + (e.error ? ' — ' + e.error : '') + '</div>').join('')
      || '<div>لا يوجد سجل مزامنة بعد</div>';
  };

  const syncInputs = () => {
    const saved = NS.saveConfig({
      spreadsheetId: wrap.querySelector('#gs-sheet-id').value,
      clientId: wrap.querySelector('#gs-client-id').value.trim(),
      clientSecret: wrap.querySelector('#gs-client-secret').value.trim(),
      refreshToken: wrap.querySelector('#gs-refresh-token').value.trim(),
      accessToken: wrap.querySelector('#gs-token').value.trim(),
      apiKey: wrap.querySelector('#gs-api-key').value.trim(),
      direction: wrap.querySelector('#gs-direction').value,
      frequency: wrap.querySelector('#gs-frequency').value,
      enabled: wrap.querySelector('#gs-enabled').checked
    });
    renderTokenMeta();
    return saved;
  };

  // V3.40 — تحميل مكتبة Google Identity Services عند الحاجة: إن لم تكن
  // window.google.accounts جاهزة بعد (السكربت خارجي بطيء/غير محمّل) نحمّله
  // ديناميكياً وننتظر اكتماله قبل فتح نافذة تسجيل الدخول — بدل الوقوع فوراً
  // لمسار لصق التوكن اليدوي.
  const ensureGoogleIdentityLoaded = () => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) resolve();
        else reject(new Error('تحميل مكتبة Google Identity فشل — استخدم لصق التوكن يدوياً أو Refresh Token'));
      };
      script.onerror = () => reject(new Error('تعذّر تحميل مكتبة Google Identity (تحقق من الإنترنت/الحجب) — استخدم لصق التوكن يدوياً'));
      document.head.appendChild(script);
    });
  };

  // Silent re-auth when the stored OAuth token is known-expired. V3.14: the
  // preferred path is the long-lived Refresh Token (a plain HTTPS exchange
  // that works on https:// AND file://); Google Identity Services (popup) is
  // only the fallback when no Refresh Token is configured.
  // V3.16.4 — mint a fresh access token whenever a refresh token is configured
  // and the stored access token is MISSING or EXPIRED. The old guard only
  // refreshed an existing-expired token, so an empty access token was sent to
  // the Sheets API with no credentials → "Method doesn't allow unregistered
  // callers". GIS popup remains the fallback when no refresh token exists.
  const refreshExpiredToken = () => {
    const c = NS.getConfig();
    const exp = Number(c.tokenExpiresAt) || 0;
    const tokenMissingOrExpired = !c.accessToken || (exp > 0 && Date.now() > exp);
    if (c.refreshToken && c.clientId && c.clientSecret) {
      if (!tokenMissingOrExpired) return Promise.resolve();
      return NS.refreshAccessToken().then(function (tok) { renderTokenMeta(); return tok; });
    }
    if (!tokenMissingOrExpired) return Promise.resolve();
    if (!c.clientId) {
      return Promise.reject(new Error('أدخل Client ID لتسجيل الدخول عبر Google أو ألصق توكن Access يدوياً'));
    }
    // V3.40 — تحميل GIS أولاً ثم فتح نافذة تسجيل الدخول (بدل فشل فوري).
    return ensureGoogleIdentityLoaded().then(function () {
      if (window.location && window.location.protocol === 'file:') {
        throw new Error('لا يوجد Access Token صالح — ألصق توكن Access جديد (تسجيل الدخول عبر Google يحتاج تشغيل النظام عبر https)');
      }
      return new Promise((resolve, reject) => {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: c.clientId,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          callback: (resp) => {
            if (resp && resp.access_token) {
              const patch = { accessToken: resp.access_token, tokenExpiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
              // V3.16.4 — also persist a refresh token pasted into the field.
              const rtIn = wrap.querySelector('#gs-refresh-token');
              if (rtIn && rtIn.value.trim()) patch.refreshToken = rtIn.value.trim();
              NS.saveConfig(patch);
              renderTokenMeta();
              resolve();
            } else {
              reject(new Error('فشل تجديد التوكن تلقائياً — ' + ((resp && resp.error) || 'أُلغي الطلب')));
            }
          }
        });
        client.requestAccessToken({ prompt: '' });
      });
    });
  };

  const saveFields = () => {
    const saved = syncInputs();
    try {
      NS.connectGoogleSheets();
      updateStatus('✓ تم الربط بالشيت ' + (saved.spreadsheetId ? saved.spreadsheetId.slice(0, 12) + '…' : ''), true);
    } catch {
      updateStatus('⚠️ حُفظت الإعدادات، لكن اكتمال الربط يحتاج Spreadsheet ID + توكن (أو API Key)');
    }
    return saved;
  };

  wrap.querySelector('#gs-save').addEventListener('click', () => {
    const saved = saveFields();
    // V3.16.4 — mirror the settings to Firestore with exact success/failure
    // feedback, so "settings not saved on other devices" is either fixed or
    // the real Firestore error is shown instead of being swallowed.
    if (typeof NS.pushConfigToCloud === 'function') NS.pushConfigToCloud();
    if (opts.onSaved) opts.onSaved(saved);
  });

  // V3.16.4 — manual force-push of pending local records to Firestore.
  const pushBtn = wrap.querySelector('#gs-pushpending');
  if (pushBtn) pushBtn.addEventListener('click', async () => {
    pushBtn.disabled = true;
    try {
      if (typeof window.forcePushPendingToCloud !== 'function') {
        updateStatus('⚠️ هذه الصفحة لا تدعم الرفع المباشر — راجع وحدة قاعدة البيانات');
        return;
      }
      await window.forcePushPendingToCloud();
    } catch (e) {
      updateStatus('✗ ' + (e && e.message ? e.message : String(e)));
    } finally {
      pushBtn.disabled = false;
    }
  });

  // ----------------------------------------------------------------
  // V3.16.3 — admin-password lock on the sensitive connection fields.
  // Spreadsheet ID / Client ID / Client Secret stay disabled until the
  // current user's admin password is verified. NOTE: this is a UI
  // guardrail, not a real security boundary — anything a client-side
  // page can display can be read/written by anyone with DevTools. The
  // real protection is `firestore.rules` (signed-in read + admin write).
  // ----------------------------------------------------------------
  if (!opts.unlocked) {
    const sensitiveIds = ['#gs-sheet-id', '#gs-client-id', '#gs-client-secret'];
    const unlockBtn = wrap.querySelector('#gs-unlock');
    const lockBtn = wrap.querySelector('#gs-lock');
    const lockNote = wrap.querySelector('#gs-lock-note');
    const setLocked = (locked) => {
      sensitiveIds.forEach(id => {
        const f = wrap.querySelector(id);
        if (f) f.disabled = locked;
      });
      if (unlockBtn) unlockBtn.style.display = locked ? 'inline-block' : 'none';
      if (lockBtn) lockBtn.style.display = locked ? 'none' : 'inline-block';
      if (lockNote) lockNote.textContent = locked
        ? 'الحقول الحساسة مقفلة — أدخل كلمة سر المدير لتعديلها'
        : 'الحقول الحساسة مفتوحة للتعديل — احفظ ثم أقفلها مجدداً';
    };
    const requestUnlock = () => {
      if (!window.openModal) return;
      window.openModal({
        title: 'فتح تعديل البيانات الحساسة',
        icon: 'shield-check',
        maxWidth: 'max-w-md',
        contentHTML:
          '<p style="color:var(--ui-dim);font-size:13px">أدخل كلمة سر المدير لتعديل Spreadsheet ID و Client ID و Client Secret.</p>' +
          '<label style="display:block;margin-top:12px;font-size:13px">كلمة سر المدير' +
          '  <input id="unlock-admin-pass" type="password" placeholder="••••••••" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--ui-border);background:var(--ui-bg);color:var(--ui-text);margin-top:4px">' +
          '</label>' +
          '<p id="unlock-err" style="color:#f87171;font-size:12px;margin-top:8px;display:none">عفواً، كلمة السر غير صحيحة!</p>' +
          '<div style="display:flex;gap:8px;margin-top:16px">' +
          '  <button id="unlock-go" style="padding:8px 16px;border-radius:8px;border:none;background:#b45309;color:#fff;font-weight:bold;cursor:pointer">🔓 تأكيد الفتح</button>' +
          '  <button id="unlock-cancel" style="padding:8px 16px;border-radius:8px;border:none;background:#334155;color:#fff;font-weight:bold;cursor:pointer">إلغاء</button>' +
          '</div>',
        onRender: (wrapper, close) => {
          const input = wrapper.querySelector('#unlock-admin-pass');
          const err = wrapper.querySelector('#unlock-err');
          const submit = () => {
            if (window.verifyAdminPassword(input.value)) {
              setLocked(false);
              close();
              if (window.showToast) window.showToast('تم فتح تعديل البيانات الحساسة', 'success');
            } else {
              if (err) err.style.display = 'block';
              if (!window.adminPasswordConfigured()) {
                if (err) err.textContent = 'لا توجد كلمة سر مسجلة للمدير — سجّلها أولاً من (القائمة ▾ ← تغيير كلمة السر)';
                if (window.showToast) window.showToast('لا توجد كلمة سر مسجلة للمدير — سجّلها أولاً من (القائمة ▾ ← تغيير كلمة السر)', 'error');
              } else {
                if (window.showToast) window.showToast('عفواً، كلمة السر غير صحيحة!', 'error');
              }
              input.select();
            }
          };
          const go = wrapper.querySelector('#unlock-go');
          const cancel = wrapper.querySelector('#unlock-cancel');
          if (go) go.addEventListener('click', submit);
          if (cancel) cancel.addEventListener('click', close);
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
          setTimeout(() => input.focus(), 50);
        }
      });
    };
    if (unlockBtn) unlockBtn.addEventListener('click', requestUnlock);
    if (lockBtn) lockBtn.addEventListener('click', () => {
      setLocked(true);
      if (window.showToast) window.showToast('تم قفل البيانات الحساسة', 'success');
    });
    setLocked(true);
  }

  wrap.querySelector('#gs-connect').addEventListener('click', async () => {
    const clientId = wrap.querySelector('#gs-client-id').value.trim();
    if (clientId) {
      // V3.40 — ربط بحساب Google: تحميل GIS عند الحاجة ثم فتح نافذة الدخول.
      NS.saveConfig({ clientId: clientId });
      if (window.location && window.location.protocol === 'file:') {
        updateStatus('⚠️ نافذة تسجيل الدخول من Google تتطلب تشغيل النظام عبر https:// — استخدم لصق التوكن يدوياً');
      }
      try {
        await ensureGoogleIdentityLoaded();
      } catch (e) {
        updateStatus('✗ ' + (e && e.message ? e.message : String(e)));
        return;
      }
      try {
        _tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          callback: (resp) => {
            if (resp && resp.access_token) {
              const exp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
              // V3.16.4 — capture a pasted refresh token (if any) and save BOTH
              // tokens immediately, then mirror to Firestore without a manual save.
              const rtIn = wrap.querySelector('#gs-refresh-token');
              const rtVal = rtIn ? rtIn.value.trim() : '';
              const patch = { accessToken: resp.access_token, tokenExpiresAt: exp };
              if (rtVal) patch.refreshToken = rtVal;
              NS.saveConfig(patch);
              if (typeof NS.pushConfigToCloud === 'function') NS.pushConfigToCloud();
              try {
                NS.connectGoogleSheets();
                updateStatus('✓ تم تسجيل الدخول بحساب Google والربط بالشيت (قراءة وكتابة)', true);
              } catch (e) { updateStatus('✗ ' + e.message); }
              renderTokenMeta();
              if (opts.onSaved) opts.onSaved(NS.getConfig());
            } else {
              updateStatus('✗ فشل تسجيل الدخول: ' + ((resp && resp.error) || 'خطأ غير معروف'));
            }
          }
        });
        _tokenClient.requestAccessToken();
        updateStatus('⏳ جارٍ فتح نافذة تسجيل الدخول من Google…');
      } catch (e) {
        updateStatus('✗ تعذّر تشغيل Google OAuth: ' + (e && e.message ? e.message : String(e)));
      }
      return;
    }
    // Fallback: manual token paste
    const token = wrap.querySelector('#gs-token').value.trim();
    if (!token) {
      updateStatus('✗ ألصق Access Token أولاً، أو أدخل Client ID لعمل تسجيل الدخول عبر Google');
      return;
    }
    // V3.16.4 — save a pasted refresh token alongside the access token and
    // mirror to Firestore immediately (no manual save button needed).
    const rtIn2 = wrap.querySelector('#gs-refresh-token');
    const rtVal2 = rtIn2 ? rtIn2.value.trim() : '';
    const patch2 = { accessToken: token, tokenExpiresAt: 0 };
    if (rtVal2) patch2.refreshToken = rtVal2;
    NS.saveConfig(patch2);
    if (typeof NS.pushConfigToCloud === 'function') NS.pushConfigToCloud();
    try {
      NS.connectGoogleSheets();
      updateStatus('✓ تم حفظ التوكن وربط الشيت بنجاح', true);
      if (opts.onSaved) opts.onSaved(NS.getConfig());
    } catch (e) {
      updateStatus('✗ ' + e.message);
    }
    renderTokenMeta();
  });

  wrap.querySelector('#gs-clear').addEventListener('click', () => {
    NS.saveConfig({ accessToken: '', tokenExpiresAt: 0, apiKey: '' });
    NS.setTransport(null);
    renderTokenMeta();
    const c = NS.getConfig();
    updateStatus(c.refreshToken
      ? 'تم مسح Access Token — سيُستعاد تلقائياً من Refresh Token عند أول مزامنة'
      : 'تم مسح التوكن — لن تعمل المزامنة حتى تعيد الربط');
  });

  wrap.querySelector('#gs-test').addEventListener('click', async () => {
    const btn = wrap.querySelector('#gs-test');
    btn.disabled = true;
    syncInputs();
    const c0 = NS.getConfig();
    // V3.16: explicit Refresh Token check — verifies the long-lived token still
    // works AND heals the saved access token in one step. Surfaces Google's raw
    // reason (invalid_grant / invalid_client …) when the refresh token is dead.
    if (c0.refreshToken && c0.clientId && c0.clientSecret) {
      try {
        await NS.refreshAccessToken();
      } catch (e) {
        updateStatus('✗ الـ Refresh Token مرفوض: ' + (e && e.message ? e.message : String(e)));
        btn.disabled = false;
        return;
      }
    }
    try {
      await refreshExpiredToken();
      NS.connectGoogleSheets();
    } catch (e) {
      updateStatus('✗ ' + e.message);
      btn.disabled = false;
      return;
    }
    try {
      const t = NS.getTransport();
      const data = await t.readSheet('Orders_Sales');
      updateStatus('✓ الاتصال ناجح — ورقة Orders_Sales: ' + (data.headers ? data.headers.length : 0) + ' عمود / ' + (data.rows ? data.rows.length : 0) + ' صف', true);
    } catch (e) {
      updateStatus('✗ فشل الاتصال: ' + (e && e.message ? e.message : String(e)));
    } finally {
      btn.disabled = false;
    }
  });

  wrap.querySelector('#gs-syncnow').addEventListener('click', async () => {
    const btn = wrap.querySelector('#gs-syncnow');
    btn.disabled = true;
    try {
      syncInputs();
      await refreshExpiredToken();
      NS.connectGoogleSheets();
    } catch (e) {
      btn.disabled = false;
      updateStatus('✗ ' + e.message);
      if (opts.onError) opts.onError(e);
      return;
    }
    NS.syncNow().then(() => {
      renderLog();
      renderTokenMeta();
      const c = NS.getConfig();
      const last = wrap.querySelector('#gs-last');
      if (last) last.textContent = 'آخر مزامنة: ' + c.lastSyncStatus + (c.lastSyncAt ? ' — ' + c.lastSyncAt : '') + (c.lastSyncRows ? ' (' + c.lastSyncRows + ' صف)' : '');
      updateStatus('✓ تمت المزامنة بنجاح', true);
      if (opts.onSynced) opts.onSynced(c);
    })
      .catch(err => {
        renderLog();
        updateStatus('✗ ' + (err && err.message ? err.message : String(err)));
        if (opts.onError) opts.onError(err);
      })
      .finally(() => { btn.disabled = false; });
  });

  renderLog();
  renderTokenMeta();

  // V3.16.4 — on a fresh browser the link settings are restored from Firestore
  // (settings/syncConfig), NOT from a per-browser localStorage that starts
  // empty. Hydrate them into the just-rendered fields, guarded by a dirty flag
  // so nothing the user already typed is ever clobbered.
  let _panelDirty = false;
  ['#gs-sheet-id', '#gs-client-id', '#gs-client-secret', '#gs-refresh-token', '#gs-token', '#gs-api-key', '#gs-direction', '#gs-frequency', '#gs-enabled']
    .forEach(sel => {
      const f = wrap.querySelector(sel);
      if (!f) return;
      if (f.tagName === 'INPUT' && f.type === 'checkbox') f.addEventListener('change', () => { _panelDirty = true; });
      else if (f.tagName === 'SELECT') f.addEventListener('change', () => { _panelDirty = true; });
      else f.addEventListener('input', () => { _panelDirty = true; });
    });
  if (window._authUser && typeof NS.hydrateConfigFromCloud === 'function') {
    NS.hydrateConfigFromCloud().then(() => {
      if (_panelDirty || !wrap.isConnected) return;
      const c = NS.getConfig();
      const setVal = (sel, v) => { const el = wrap.querySelector(sel); if (el) el.value = v; };
      setVal('#gs-sheet-id', c.spreadsheetId || '');
      setVal('#gs-client-id', c.clientId || '');
      setVal('#gs-client-secret', c.clientSecret || '');
      setVal('#gs-refresh-token', c.refreshToken || '');
      setVal('#gs-token', c.accessToken || '');
      setVal('#gs-api-key', c.apiKey || '');
      const dir = wrap.querySelector('#gs-direction'); if (dir) dir.value = c.direction || 'export';
      const freq = wrap.querySelector('#gs-frequency'); if (freq) freq.value = c.frequency || 'manual';
      const en = wrap.querySelector('#gs-enabled'); if (en) en.checked = !!c.enabled;
      renderTokenMeta();
    }).catch(() => { /* hydrate errors are surfaced via bms-sync-error, not swallowed here */ });
  }

  return wrap;
};

// Export the public surface so the compat bridge can re-assert the bindings
// (importing this module is what installs window.GoogleSheetsSync).
const {
  exportAll,
  importAll,
  syncNow,
  scheduleSync,
  isSyncPending,
  flushSync,
  startAutoSync,
  stopAutoSync,
  getConfig,
  saveConfig,
  pushConfigToCloud,
  hydrateConfigFromCloud,
  resetSyncState,
  getSyncLog,
  getSyncAuditRecords,
  getSheetDefinitions,
  createMemoryTransport,
  refreshAccessToken,
  createGoogleSheetsTransport,
  connectGoogleSheets,
  syncWithGoogleSheets,
  openSheetUrl,
  setQuickDirection,
  renderSyncPanel,
  setTransport,
  getTransport
} = NS;

export {
  exportAll,
  importAll,
  syncNow,
  scheduleSync,
  isSyncPending,
  flushSync,
  startAutoSync,
  stopAutoSync,
  getConfig,
  saveConfig,
  pushConfigToCloud,
  hydrateConfigFromCloud,
  resetSyncState,
  getSyncLog,
  getSyncAuditRecords,
  getSheetDefinitions,
  createMemoryTransport,
  refreshAccessToken,
  createGoogleSheetsTransport,
  connectGoogleSheets,
  syncWithGoogleSheets,
  openSheetUrl,
  setQuickDirection,
  renderSyncPanel,
  setTransport,
  getTransport
};
