/**
 * Supplier Returns (مرتجع المشتريات) domain — pure core + injected repository.
 * Ported VERBATIM from js/services/supplier-returns.js (legacy).
 */
import { round2, generateAutoId } from '../../utils/formatters.js';
import { getCairoFormattedDate } from '../../utils/formatters.js';
import { getSupplierById } from '../suppliers/suppliers.js';
import { getProductById } from './products.js';

/* ===================== pure query helpers ===================== */

export function getSupplierReturns(list) {
  return list;
}

export function getSupplierReturnsBySupplier(returns, supplierId) {
  return returns.filter(r => r.supplierId === supplierId);
}

export function getSupplierTransactions(list) {
  return list;
}

export function getSupplierTransactionsBySupplier(txns, supplierId) {
  return txns.filter(t => t.supplierId === supplierId);
}

/**
 * Unified Supplier Ledger Log
 * debit  = amount that increases our debt to the supplier
 * credit = amount that decreases our debt to the supplier
 */
export function logSupplierTransaction({ supplierId, supplierName, type, refId = '', debit = 0, credit = 0, note = '', date = null }, repo) {
  const txn = {
    id: generateAutoId('SUPLOG'),
    supplierId,
    supplierName: supplierName || '',
    type,
    refId,
    debit: Number(debit) || 0,
    credit: Number(credit) || 0,
    note: (note || '').trim(),
    createdAt: date || getCairoFormattedDate()
  };
  return repo.addFirestoreDoc(repo.storageKeys.SUPPLIER_TRANSACTIONS, txn);
}

/* ===================== orchestration ===================== */

export function createSupplierReturn({ supplierId, items, refundType = 'debt', notes = '', createdBy = 'المدير العام' }, repo) {
  if (!supplierId) throw new Error('يرجى اختيار المورد / المصنع أولاً');
  const supplier = getSupplierById(repo.getSuppliers(), supplierId);
  if (!supplier) throw new Error('المورد المحدد غير موجود في النظام');

  const selectedRefundType = refundType === 'cash' ? 'cash' : 'debt';

  const validItems = (items || []).filter(i => i && i.productId && Number(i.quantity) > 0);
  if (validItems.length === 0) throw new Error('يرجى إدخال منتج واحد على الأقل بكمية صحيحة أكبر من الصفر');

  // 1. Validate stock availability & prices
  validItems.forEach(i => {
    const product = getProductById(repo.getProducts(), i.productId);
    if (!product) throw new Error('أحد المنتجات المحددة غير موجود في المخزن');
    const qty = Number(i.quantity);
    const unitCost = Number(i.unitCost);
    if (isNaN(unitCost) || unitCost < 0) throw new Error(`يرجى إدخال سعر وحدة صحيح للمنتج ${product.name}`);
    if (qty > Number(product.stock)) {
      throw new Error(`لا يمكن إرجاع ${qty} قطعة من "${product.name}" لأن المخزون الحالي ${product.stock} قطعة فقط`);
    }
  });

  const processedItems = validItems.map(i => {
    const product = getProductById(repo.getProducts(), i.productId);
    const qty = Number(i.quantity);
    const unitCost = Number(i.unitCost);
    return {
      productId: product.id,
      productName: product.name,
      quantity: qty,
      unitCost,
      subtotal: round2(qty * unitCost)
    };
  });

  const totalValue = round2(processedItems.reduce((s, i) => s + i.subtotal, 0));
  if (totalValue <= 0) throw new Error('قيمة المرتجع يجب أن تكون أكبر من الصفر');

  const now = getCairoFormattedDate();
  const returnId = generateAutoId('SRET');

  // 2. Deduct returned quantities from inventory
  processedItems.forEach(i => {
    repo.decrementProductStock(i.productId, i.quantity);
  });

  // 3. Settle supplier debt
  const oldPurchases = Number(supplier.totalPurchases) || 0;
  const oldBalance = Number(supplier.remainingBalance) || 0;
  const newPurchases = round2(Math.max(0, oldPurchases - totalValue));
  const newBalance = round2(Math.max(0, oldBalance - totalValue));
  const newPaid = round2(Math.max(0, newPurchases - newBalance));

  repo.updateSupplier(supplierId, {
    totalPurchases: newPurchases,
    remainingBalance: newBalance,
    paid: newPaid
  });

  // 4. Persist the return record
  const returnRecord = {
    id: returnId,
    supplierId,
    supplierName: supplier.name,
    items: processedItems,
    totalValue,
    refundType: selectedRefundType,
    notes: (notes || '').trim(),
    createdBy,
    createdAt: now
  };
  repo.addFirestoreDoc(repo.storageKeys.SUPPLIER_RETURNS, returnRecord);

  // 5. Cash refund => record a treasury cash receipt (negative payment)
  if (selectedRefundType === 'cash') {
    repo.createPaymentRecord({
      entityType: 'supplier',
      entityId: supplierId,
      entityName: supplier.name,
      amount: -totalValue,
      date: now.slice(0, 10),
      paymentMethod: 'cash',
      notes: `استرداد نقدي - مرتجع مشتريات للمورد (${returnId}): ${processedItems.map(i => `${i.productName} x${i.quantity}`).join('، ')}`,
      createdBy
    });
  }

  // 6. Log the supplier ledger transaction (credit = debt decreased)
  repo.logSupplierTransaction({
    supplierId,
    supplierName: supplier.name,
    type: selectedRefundType === 'cash' ? 'مرتجع نقدي' : 'مرتجع مشتريات',
    refId: returnId,
    credit: totalValue,
    note: (notes || '').trim() || (selectedRefundType === 'cash' ? 'استرداد نقدي من المورد عن بضاعة مرتجعة' : 'إرجاع بضاعة للمورد وخصمها من المديونية'),
    date: now
  });

  return returnRecord;
}

export function getTotalSupplierReturnsValue(returns) {
  return round2(returns.reduce((sum, r) => sum + (Number(r.totalValue) || 0), 0));
}

/**
 * V3.19 — إعادة احتساب الأرباح والتقارير (Recalculate Totals)
 * Non-destructive reconciliation of the supplier-returns ledger.
 * Returns the number of restated entries (0 means everything already consistent).
 */
export function recalculateTotals(repo) {
  const returns = repo.getSupplierReturns();
  const payments = repo.getPayments();
  let restated = 0;

  returns.forEach(r => {
    if (!r || !r.supplierId) return;
    const supplier = getSupplierById(repo.getSuppliers(), r.supplierId);
    const name = (supplier && supplier.name) || r.supplierName || '';
    const totalValue = round2(Number(r.totalValue) || 0);
    if (totalValue <= 0) return;

    if (r.refundType === 'cash') {
      const exists = payments.some(p =>
        p.entityType === 'supplier' && p.entityId === r.supplierId &&
        (Number(p.amount) || 0) < 0 && (p.notes || '').indexOf('(' + r.id + ')') !== -1
      );
      if (!exists && repo.createPaymentRecord) {
        repo.createPaymentRecord({
          entityType: 'supplier',
          entityId: r.supplierId,
          entityName: name,
          amount: -totalValue,
          date: (r.createdAt || '').slice(0, 10),
          paymentMethod: 'cash',
          notes: `استرداد نقدي - مرتجع مشتريات للمورد (${r.id}): إعادة احتساب`,
          createdBy: 'المدير العام'
        });
        restated++;
      }
    }

    const expectedType = r.refundType === 'cash' ? 'مرتجع نقدي' : 'مرتجع مشتريات';
    const txnExists = repo.getSupplierTransactions().some(t =>
      t.refId === r.id && (t.type === 'مرتجع نقدي' || t.type === 'مرتجع مشتريات')
    );
    if (!txnExists && repo.logSupplierTransaction) {
      repo.logSupplierTransaction({
        supplierId: r.supplierId,
        supplierName: name,
        type: expectedType,
        refId: r.id,
        credit: totalValue,
        note: (r.notes || '').trim() || (r.refundType === 'cash' ? 'استرداد نقدي من المورد عن بضاعة مرتجعة' : 'إرجاع بضاعة للمورد وخصمها من المديونية'),
        date: r.createdAt || null
      });
      restated++;
    }
  });

  // 3. Recompute derived supplier balances from the ledger
  repo.getSuppliers().forEach(sup => {
    const txns = getSupplierTransactionsBySupplier(repo.getSupplierTransactions(), sup.id);
    if (!txns || txns.length === 0) return;
    const totalDebit = txns.reduce((s, t) => s + (Number(t.debit) || 0), 0);
    const totalCredit = txns.reduce((s, t) => s + (Number(t.credit) || 0), 0);
    const purchases = round2(Number(sup.totalPurchases) || 0);
    const newBalance = round2(Math.max(0, totalDebit - totalCredit));
    const newPaid = round2(Math.max(0, purchases - newBalance));
    repo.updateSupplier(sup.id, { remainingBalance: newBalance, paid: newPaid });
  });

  return restated;
}
