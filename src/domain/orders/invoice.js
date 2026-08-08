/**
 * Invoice math — pure order/invoice computations (100% pure).
 * Ported verbatim from the calculation core of js/services/orders.js (legacy):
 * item processing, subtotal/total, down payment split, deposit designation.
 */
import { round2 } from '../../utils/formatters.js';
import { computeShippingRevenueDeposit } from '../accounting/accounting.js';

/** Pure item line → processed item (subtotal = round2(qty × sellPrice)). */
export function processItems(items) {
  return items.map(item => {
    const qty = Number(item.quantity) || 1;
    const sellPrice = Number(item.sellingPrice) || 0;
    const purPrice = Number(item.purchasePrice) || 0;
    return {
      productId: item.productId,
      productName: item.productName,
      quantity: qty,
      purchasePrice: purPrice,
      sellingPrice: sellPrice,
      supplierId: item.supplierId || '',
      supplierName: item.supplierName || '',
      subtotal: round2(qty * sellPrice)
    };
  });
}

export function computeItemsSubtotal(processedItems) {
  return round2(processedItems.reduce((sum, item) => sum + item.subtotal, 0));
}

/** Order Total = items + customer-paid shipping + customer-paid extra. */
export function computeTotalAmount({ itemsSubtotal, shippingCost, shippingPayer, extraExpenses, extraExpensesPayer }) {
  const shipCost = Number(shippingCost) || 0;
  const exExpenses = Number(extraExpenses) || 0;
  return round2(itemsSubtotal
    + (shippingPayer === 'customer' ? shipCost : 0)
    + (extraExpensesPayer === 'customer' ? exExpenses : 0));
}

/**
 * Down payment / remaining split. "مكتمل نهائي" auto-settles the full invoice;
 * cancelled/returned orders are always settled (remaining 0).
 */
export function computePaymentSplit({ status, totalAmount, downPayment }) {
  const dp = (status === 'completed') ? totalAmount : Math.min(totalAmount, round2(parseFloat(downPayment) || 0));
  const remainingBalance = (status === 'cancelled' || status === 'returned') ? 0 : round2(Math.max(0, totalAmount - dp));
  const paidInFull = (dp === totalAmount);
  return { dp, remainingBalance, paidInFull };
}

/** V3.11 — Deposit portion designated to shipping/packaging services. */
export function computeShippingRevenueDepositForOrder({ depositType, downPayment, shippingCost, extraExpenses, shippingPayer, extraExpensesPayer }) {
  return computeShippingRevenueDeposit(depositType, downPayment, shippingCost, extraExpenses, shippingPayer, extraExpensesPayer);
}
