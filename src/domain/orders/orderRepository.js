/**
 * Order orchestration — domain layer with injected repository (100% pure).
 * Ported VERBATIM from js/services/orders.js (legacy). Every data access goes
 * through the injected `repo` (repository pattern); helpers come from the pure
 * sibling modules. See src/legacy/compat.js for the window-backed adapter.
 */
import { round2, generateAutoId, getCairoFormattedDate } from '../../utils/formatters.js';
import { validateEgyptianPhone } from '../../utils/phones.js';
import { DEFAULT_CUSTOMER_CATEGORY } from '../customers/customerRules.js';
import { computeShippingRevenueDeposit, getOrderRemainingAmount } from '../accounting/accounting.js';
import { canTransition, isFulfilledOrderStatus } from './orderMachine.js';
import { processItems, computeItemsSubtotal, computeTotalAmount, computePaymentSplit } from './invoice.js';

/* ===================== pure query helpers ===================== */

export function getOrders(list) {
  return list;
}

export function getOrderById(orders, id) {
  return orders.find(o => o.id === id) || null;
}

export function searchOrders(orders, query) {
  if (!query) return orders;
  const q = query.trim().toLowerCase();
  return orders.filter(o =>
    (o.id && o.id.toLowerCase().includes(q)) ||
    (o.customerName && o.customerName.toLowerCase().includes(q)) ||
    (o.customerPhone && o.customerPhone.includes(q)) ||
    (o.customerSecondaryPhone && o.customerSecondaryPhone.includes(q))
  );
}

export function getOpenOrdersCount(orders) {
  return orders.filter(o => o.status === 'new' || o.status === 'delivered').length;
}

export function getTotalSalesAmount(orders) {
  return orders
    .filter(o => isFulfilledOrderStatus(o.status))
    .reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);
}

/* ===================== orchestration ===================== */

export function createOrder({ customerInfo, items, downPayment = 0, shippingCost = 0, shippingPayer = 'customer', extraExpenses = 0, extraExpensesPayer = 'customer', status = 'delivered', createdBy = 'المدير العام', directShipping = false, depositType = 'custom', cashierMode = false }, repo) {
  // F4 — Cashier mode: phone is optional, order is completed + fully cash-paid.
  if (cashierMode) status = 'completed';
  const phoneVal = String(customerInfo.phone || '').trim();
  let primaryPhone = '';
  if (cashierMode) {
    if (phoneVal) {
      const phoneValidation = validateEgyptianPhone(phoneVal);
      if (!phoneValidation.isValid) throw new Error(phoneValidation.message);
      primaryPhone = phoneValidation.cleaned;
    }
  } else {
    const phoneValidation = validateEgyptianPhone(phoneVal);
    if (!phoneValidation.isValid) throw new Error(phoneValidation.message);
    primaryPhone = phoneValidation.cleaned;
  }

  const secondaryPhone = (customerInfo.secondaryPhone || '').trim();
  const customerCategory = customerInfo.category || DEFAULT_CUSTOMER_CATEGORY;

  let customer = primaryPhone ? repo.findCustomerByPhone(primaryPhone) : null;
  if (!customer && cashierMode && !primaryPhone) {
    const walkIn = repo.getCustomers().find(c =>
      String(c.name || '').trim() === 'عميل معرض' && !String(c.phone || '').trim()
    );
    if (walkIn) customer = walkIn;
  }
  if (!customer) {
    const walkInName = (cashierMode && !primaryPhone && !String(customerInfo.name || '').trim()) ? 'عميل معرض' : customerInfo.name;
    customer = repo.createCustomer({
      name: walkInName,
      phone: primaryPhone,
      secondaryPhone: secondaryPhone,
      category: customerCategory,
      address: customerInfo.address,
      notes: customerInfo.notes
    });
  } else {
    const syncUpdates = {};
    if (secondaryPhone && customer.secondaryPhone !== secondaryPhone) {
      syncUpdates.secondaryPhone = secondaryPhone;
    }
    if (customer.category !== customerCategory) {
      syncUpdates.category = customerCategory;
    }
    if (Object.keys(syncUpdates).length > 0) {
      repo.updateCustomer(customer.id, syncUpdates);
    }
  }

  const orderSecondaryPhone = secondaryPhone || customer.secondaryPhone || '';
  const orderCategory = customerCategory || customer.category || DEFAULT_CUSTOMER_CATEGORY;

  // V3.20: Resolve the shipping address for this order.
  let shippingAddress = '';
  let shippingAddressId = '';
  let shippingAddressLabel = '';
  const savedAddresses = (repo.getCustomerAddresses ? repo.getCustomerAddresses(customer.id) : []);
  if (customerInfo.addressId) {
    const saved = savedAddresses.find(a => a.id === customerInfo.addressId);
    if (saved) {
      shippingAddressId = saved.id;
      shippingAddressLabel = saved.label || '';
      shippingAddress = saved.address;
    }
  }
  if (!shippingAddress && customerInfo.address) {
    shippingAddress = String(customerInfo.address).trim();
  }
  if (!shippingAddress && savedAddresses.length) {
    const def = savedAddresses.find(a => a.isDefault) || savedAddresses[0];
    shippingAddressId = def.id;
    shippingAddressLabel = def.label || '';
    shippingAddress = def.address;
  }

  const processedItems = processItems(items);
  const itemsSubtotal = computeItemsSubtotal(processedItems);
  const shipCost = Number(shippingCost) || 0;
  const exExpenses = Number(extraExpenses) || 0;

  const totalAmount = computeTotalAmount({ itemsSubtotal, shippingCost: shipCost, shippingPayer, extraExpenses: exExpenses, extraExpensesPayer });
  const { dp, remainingBalance, paidInFull } = computePaymentSplit({ status, totalAmount, downPayment });

  // V3.11: deposit portion designated to shipping/packaging services.
  const shippingRevenueDeposit = computeShippingRevenueDeposit(depositType, dp, shipCost, exExpenses, shippingPayer, extraExpensesPayer);

  const orderId = generateAutoId('ORD');
  const now = getCairoFormattedDate();

  const newOrder = {
    id: orderId,
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerSecondaryPhone: orderSecondaryPhone,
    customerCategory: orderCategory,
    shippingAddress,
    shippingAddressId,
    shippingAddressLabel,
    items: processedItems,
    itemsSubtotal,
    shippingCost: shipCost,
    shippingPayer,
    extraExpenses: exExpenses,
    extraExpensesPayer,
    totalAmount,
    downPayment: dp,
    remainingBalance,
    paidInFull,
    status,
    depositType: depositType || 'custom',
    shippingRevenueDeposit,
    directShipping: !!directShipping,
    createdBy,
    createdAt: now,
    updatedAt: now
  };

  // 1. Add Order document to Cloud Firestore
  repo.addFirestoreDoc(repo.storageKeys.ORDERS, newOrder);

  // 2. Fulfill Order: Decrement Stock & Update Customer's Debt
  if (status === 'delivered' || status === 'completed') {
    applyOrderFulfillment(newOrder, repo);
  }

  // 3. Log Cash Treasury Receipt for Down Payment or Full Settlement
  if (dp > 0) {
    repo.createPaymentRecord({
      entityType: 'customer',
      entityId: customer.id,
      entityName: customer.name,
      amount: dp,
      date: now.slice(0, 10),
      paymentMethod: 'cash',
      notes: paidInFull ? `تحصيل كامل قيمة الفاتورة رقم ${newOrder.id}` : `دفعة مقدمة (عربون) للطلب رقم ${newOrder.id}`,
      isDownPayment: true,
      type: 'deposit',
      refOrderId: newOrder.id,
      cycleKey: 'deposit',
      createdBy
    });
  }

  return newOrder;
}

export function applyOrderFulfillment(order, repo) {
  // V3.16 — Always recompute the order's true outstanding debt at fulfillment.
  const remaining = getOrderRemainingAmount(order);
  const updateCustomerLedger = () => {
    const customer = repo.getCustomerById(order.customerId);
    if (!customer) return;
    const newCount = (Number(customer.ordersCount) || 0) + 1;
    const newPurchases = round2((Number(customer.totalPurchases) || 0) + order.totalAmount);
    const newBalance = round2((Number(customer.remainingBalance) || 0) + remaining);

    repo.updateCustomer(customer.id, {
      ordersCount: newCount,
      totalPurchases: newPurchases,
      remainingBalance: newBalance,
      lastOrderDate: getCairoFormattedDate()
    });
  };

  // DIRECT SHIPPING
  if (order.directShipping) {
    const supplierShipments = [];

    order.items.forEach(item => {
      const qty = Number(item.quantity) || 0;
      const costPerUnit = Number(item.purchasePrice) || 0;
      const supplierId = item.supplierId || '';
      const supplierName = item.supplierName || '';
      item.consumed = 0;

      const alreadyRecorded = Array.isArray(order.supplierShipments) && order.supplierShipments.length > 0;

      if (!alreadyRecorded && supplierId && costPerUnit > 0 && qty > 0) {
        const totalShipmentCost = round2(qty * costPerUnit);
        const supplier = repo.getSupplierById(supplierId);
        if (supplier) {
          repo.updateSupplier(supplierId, {
            totalPurchases: round2((Number(supplier.totalPurchases) || 0) + totalShipmentCost),
            remainingBalance: round2((Number(supplier.remainingBalance) || 0) + totalShipmentCost)
          });

          if (repo.logSupplierTransaction) {
            repo.logSupplierTransaction({
              supplierId,
              supplierName: supplier.name,
              type: 'شحنة توريد',
              refId: order.id,
              debit: totalShipmentCost,
              note: `شحن مباشر من المورد للطلب ${order.id}: "${item.productName}" (${qty} قطعة × ${costPerUnit}) بدون مرور المخزن`,
              date: getCairoFormattedDate()
            });
          }

          supplierShipments.push({
            supplierId,
            supplierName,
            productId: item.productId,
            productName: item.productName,
            units: qty,
            amount: totalShipmentCost
          });
        }
      }
    });

    const persistPayload = { items: order.items.map(item => ({ ...item })) };
    if (supplierShipments.length > 0) persistPayload.supplierShipments = supplierShipments;
    persistPayload.remainingBalance = remaining;
    persistPayload.paidInFull = remaining <= 0;
    repo.updateFirestoreDoc(repo.storageKeys.ORDERS, order.id, persistPayload);

    updateCustomerLedger();
    return;
  }

  // Stock consumed down to 0; shortfall becomes a Pending Supplier Payable.
  const deficits = [];

  order.items.forEach(item => {
    const { consumedQty, deficitQty } = repo.decrementProductStock(item.productId, item.quantity);
    item.consumed = consumedQty;
    const product = repo.getProductById(item.productId);

    if (deficitQty > 0 && product) {
      const costPerUnit = Number(item.purchasePrice) || Number(product.purchasePrice) || 0;
      const supplierId = item.supplierId || '';
      const supplierName = item.supplierName || '';

      if (supplierId && costPerUnit > 0) {
        const payableAmount = round2(deficitQty * costPerUnit);
        const supplier = repo.getSupplierById(supplierId);
        if (supplier) {
          repo.updateSupplier(supplierId, {
            totalPurchases: round2((Number(supplier.totalPurchases) || 0) + payableAmount),
            remainingBalance: round2((Number(supplier.remainingBalance) || 0) + payableAmount)
          });

          if (repo.logSupplierTransaction) {
            repo.logSupplierTransaction({
              supplierId,
              supplierName: supplier.name,
              type: 'مديونية عجز مخزون',
              refId: order.id,
              debit: payableAmount,
              note: `طلب مؤجل ${order.id}: عجز ${deficitQty} قطعة من "${product.name}" بسعر الشراء`,
              date: getCairoFormattedDate()
            });
          }

          deficits.push({
            supplierId,
            supplierName,
            productId: product.id,
            productName: product.name,
            units: deficitQty,
            amount: payableAmount
          });
        }
      }
    }
  });

  const persistPayload = { items: order.items.map(item => ({ ...item })) };
  if (deficits.length > 0) {
    persistPayload.supplierDeficits = deficits;
  }
  persistPayload.remainingBalance = remaining;
  persistPayload.paidInFull = remaining <= 0;
  repo.updateFirestoreDoc(repo.storageKeys.ORDERS, order.id, persistPayload);

  updateCustomerLedger();
}

/**
 * V3.4 — Flexible Deposit Refund on Order Cancellation.
 */
function handleDepositRefund(order, refundAmount, note, repo) {
  const deposit = Number(order.downPayment) || 0;
  if (deposit <= 0) return;

  const refundAmt = Math.min(Math.max(0, Number(refundAmount) || 0), deposit);
  const retained = deposit - refundAmt;

  repo.updateFirestoreDoc(repo.storageKeys.ORDERS, order.id, {
    refundedAmount: refundAmt,
    retainedDeposit: retained
  });

  const customer = repo.getCustomerById(order.customerId);
  if (customer) {
    repo.updateCustomer(customer.id, {
      paid: Math.max(0, (Number(customer.paid) || 0) - retained)
    });
  }

  if (refundAmt > 0) {
    repo.createPaymentRecord({
      entityType: 'customer',
      entityId: order.customerId,
      entityName: order.customerName,
      amount: -refundAmt,
      date: getCairoFormattedDate().slice(0, 10),
      paymentMethod: 'cash',
      notes: note || `إرجاع عربون للعميل عن الطلب الملغي رقم ${order.id}`,
      type: 'refund',
      refOrderId: order.id,
      cycleKey: 'refund-' + refundAmt,
      createdBy: 'المدير العام'
    });
  }
}

/**
 * V3.15.2 — Order Status update with the state-machine guard (rejects illegal
 * transitions BEFORE any write) and all reversal/re-fulfillment side effects.
 */
export function updateOrderStatus(orderId, newStatus, refundAmount, reactivationDeposit, repo) {
  const orders = repo.getOrders();
  const currentOrder = orders.find(o => o.id === orderId);
  if (!currentOrder) return null;

  const oldStatus = currentOrder.status;
  if (oldStatus === newStatus) return currentOrder;

  // V3.15.2 — State-machine guard: reject any transition outside the matrix.
  if (!canTransition(oldStatus, newStatus)) {
    throw new Error(
      `انتقال حالة غير مسموح (${oldStatus} → ${newStatus}): لا يمكن نقل الطلب مباشرة بين هاتين الحالتين — اتبع مسار مصفوفة الحالات (إعادة التفعيل تمر عبر حالة "جديد" أولاً).`
    );
  }

  const payload = {
    status: newStatus,
    updatedAt: getCairoFormattedDate()
  };

  if (newStatus === 'cancelled' || newStatus === 'returned') {
    payload.remainingBalance = 0;
  }

  repo.updateFirestoreDoc(repo.storageKeys.ORDERS, orderId, payload);

  // 1. Transition from New to Delivered/Completed: Fulfill order and decrement stock
  if (oldStatus === 'new' && (newStatus === 'delivered' || newStatus === 'completed')) {
    applyOrderFulfillment(currentOrder, repo);
  }

  // V3.4: Cancel a pending (new) order — deposit refund handling only.
  if (oldStatus === 'new' && newStatus === 'cancelled') {
    handleDepositRefund(currentOrder, refundAmount, '', repo);
  }

  // V3.15.2 — Reactivate a cancelled/returned order: back to "جديد".
  if ((oldStatus === 'cancelled' || oldStatus === 'returned') && newStatus === 'new') {
    const retainedDefault = round2(Math.max(0, (Number(currentOrder.downPayment) || 0) - (Number(currentOrder.refundedAmount) || 0)));
    const reCreditAmount = (Number(reactivationDeposit) > 0) ? round2(Number(reactivationDeposit)) : retainedDefault;
    if (reCreditAmount > 0) {
      repo.createPaymentRecord({
        entityType: 'customer',
        entityId: currentOrder.customerId,
        entityName: currentOrder.customerName,
        amount: reCreditAmount,
        date: getCairoFormattedDate().slice(0, 10),
        paymentMethod: 'cash',
        isDownPayment: true,
        notes: `إعادة تسجيل دفعة / رد مبلغ للطلب رقم ${currentOrder.id} بعد إعادة تفعيله`,
        type: 'deposit',
        refOrderId: currentOrder.id,
        cycleKey: 'recredit-' + reCreditAmount,
        createdBy: 'المدير العام'
      });
    }
  }

  // 3. Cancelled/Returned → Delivered/Completed: Re-fulfill order and decrement stock
  if ((oldStatus === 'returned' || oldStatus === 'cancelled') && (newStatus === 'delivered' || newStatus === 'completed')) {
    applyOrderFulfillment(currentOrder, repo);
    const reCreditAmount = round2(Math.max(0, (Number(currentOrder.downPayment) || 0) - (Number(currentOrder.refundedAmount) || 0)));
    if (reCreditAmount > 0) {
      repo.createPaymentRecord({
        entityType: 'customer',
        entityId: currentOrder.customerId,
        entityName: currentOrder.customerName,
        amount: reCreditAmount,
        date: getCairoFormattedDate().slice(0, 10),
        paymentMethod: 'cash',
        isDownPayment: true,
        notes: `إعادة تسجيل دفعة / رد مبلغ للطلب رقم ${currentOrder.id} بعد إعادة تفعيله`,
        type: 'deposit',
        refOrderId: currentOrder.id,
        cycleKey: 'recredit-' + reCreditAmount,
        createdBy: 'المدير العام'
      });
    }
  }

  // 2. Delivered/Completed → Returned/Cancelled: Revert Stock & Cancel Customer Debt
  if ((oldStatus === 'delivered' || oldStatus === 'completed') && (newStatus === 'returned' || newStatus === 'cancelled')) {
    if (newStatus === 'returned') {
      currentOrder.items.forEach(item => {
        const restoreQty = currentOrder.directShipping
          ? (Number(item.quantity) || 0)
          : (typeof item.consumed === 'number' && item.consumed >= 0 ? item.consumed : (Number(item.quantity) || 0));
        repo.incrementProductStock(item.productId, restoreQty);
      });
    } else if (!currentOrder.directShipping) {
      currentOrder.items.forEach(item => {
        const consumed = typeof item.consumed === 'number' && item.consumed >= 0 ? item.consumed : (Number(item.quantity) || 0);
        repo.incrementProductStock(item.productId, consumed);
      });
    }

    // Reverse the supplier debt for negative-stock deficits
    (currentOrder.supplierDeficits || []).forEach(d => {
      const supplier = repo.getSupplierById(d.supplierId);
      if (supplier) {
        repo.updateSupplier(d.supplierId, {
          totalPurchases: round2(Math.max(0, (Number(supplier.totalPurchases) || 0) - Number(d.amount))),
          remainingBalance: round2(Math.max(0, (Number(supplier.remainingBalance) || 0) - Number(d.amount)))
        });

        if (repo.logSupplierTransaction) {
          repo.logSupplierTransaction({
            supplierId: d.supplierId,
            supplierName: supplier.name,
            type: 'إلغاء مديونية عجز',
            refId: currentOrder.id,
            credit: Number(d.amount) || 0,
            note: `إلغاء مديونية عجز مخزون للطلب ${currentOrder.id} (${d.productName} x${d.units}) بعد الإرجاع/الإلغاء`,
            date: getCairoFormattedDate()
          });
        }
      }
    });

    // Reverse direct-supply shipments ONLY for CANCELLED orders (V3.10).
    if (newStatus === 'cancelled') {
      (currentOrder.supplierShipments || []).forEach(d => {
        const supplier = repo.getSupplierById(d.supplierId);
        if (supplier) {
          repo.updateSupplier(d.supplierId, {
            totalPurchases: round2(Math.max(0, (Number(supplier.totalPurchases) || 0) - Number(d.amount))),
            remainingBalance: round2(Math.max(0, (Number(supplier.remainingBalance) || 0) - Number(d.amount)))
          });

          if (repo.logSupplierTransaction) {
            repo.logSupplierTransaction({
              supplierId: d.supplierId,
              supplierName: supplier.name,
              type: 'إلغاء شحنة توريد مباشر',
              refId: currentOrder.id,
              credit: Number(d.amount) || 0,
              note: `إلغاء شحنة التوريد المباشر للطلب ${currentOrder.id} (${d.productName} x${d.units}) بعد الإرجاع/الإلغاء`,
              date: getCairoFormattedDate()
            });
          }
        }
      });
    }

    // Revert customer debt balance
    const customer = repo.getCustomerById(currentOrder.customerId);
    if (customer) {
      const oldPaid = Number(customer.paid) || 0;
      const oldPurchases = Number(customer.totalPurchases) || 0;
      const oldBalance = Number(customer.remainingBalance) || 0;

      const updatedPurchases = round2(Math.max(0, oldPurchases - currentOrder.totalAmount));
      const updatedBalance = round2(Math.max(0, oldBalance - currentOrder.remainingBalance));
      repo.updateCustomer(customer.id, {
        totalPurchases: updatedPurchases,
        remainingBalance: updatedBalance
      });

      if (newStatus === 'cancelled') {
        handleDepositRefund(currentOrder, refundAmount, '', repo);
      } else {
        const explicitRefund = (Number(refundAmount) || 0) > 0;
        if (explicitRefund) {
          handleDepositRefund(currentOrder, refundAmount, `رد مبلغ مسدد / تسوية مرتجع للطلب رقم ${currentOrder.id}`, repo);
        } else {
          const newOwed = round2(Math.max(0, updatedPurchases - updatedBalance));
          const autoRefund = round2(Math.max(0, oldPaid - newOwed));
          if (autoRefund > 0) {
            repo.createPaymentRecord({
              entityType: 'customer',
              entityId: currentOrder.customerId,
              entityName: currentOrder.customerName,
              amount: -autoRefund,
              date: getCairoFormattedDate().slice(0, 10),
              paymentMethod: 'cash',
              notes: `رد مبلغ مسدد / تسوية مرتجع للطلب رقم ${currentOrder.id}`,
              type: 'refund',
              refOrderId: currentOrder.id,
              cycleKey: 'autoRefund-' + autoRefund,
              createdBy: 'المدير العام'
            });
          }
        }
      }
    }
  }

  // 4. AUTO-SETTLE: "مكتمل نهائي" = تحصيل كامل للفاتورة.
  if (newStatus === 'completed') {
    const freshOrder = repo.getOrderById(orderId) || currentOrder;
    const remainingToSettle = getOrderRemainingAmount(freshOrder);
    if (remainingToSettle > 0) {
      currentOrder.downPayment = Number(currentOrder.totalAmount) || 0;
      currentOrder.remainingBalance = 0;
      currentOrder.paidInFull = true;

      repo.updateFirestoreDoc(repo.storageKeys.ORDERS, orderId, {
        downPayment: currentOrder.downPayment,
        remainingBalance: 0,
        paidInFull: true
      });

      repo.createPaymentRecord({
        entityType: 'customer',
        entityId: currentOrder.customerId,
        entityName: currentOrder.customerName,
        amount: remainingToSettle,
        date: getCairoFormattedDate().slice(0, 10),
        paymentMethod: 'cash',
        isDownPayment: true,
        notes: `تحصيل كامل المتبقي عند إتمام الفاتورة رقم ${currentOrder.id} (مكتمل نهائي)`,
        type: 'settle',
        refOrderId: currentOrder.id,
        cycleKey: 'settle',
        createdBy: 'المدير العام'
      });

      repo.recalculateCustomerBalance(currentOrder.customerId);
    }
  }

  return { ...currentOrder, ...payload };
}
