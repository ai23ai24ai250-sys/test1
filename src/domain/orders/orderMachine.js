/**
 * Order State Machine — pure domain layer (100% pure).
 * Ported verbatim from js/services/orders.js (legacy): the transition matrix and
 * the status predicates/labels. No window/document/storage access.
 */

/**
 * V3.15.2 — Order Status State Machine (مصفوفة حالات الطلب).
 * Only these transitions are allowed when updating an order's status:
 *   new       → delivered, completed, cancelled     (قيد الانتظار → أي حالة لاحقة)
 *   delivered → completed, returned                 (تم التوصيل → تسوية أو مرتجع)
 *   completed → returned                            (مكتمل → مرتجع فقط)
 *   returned  → new, delivered                      (مرتجع → إعادة تفعيل أو إعادة شحن)
 *   cancelled → new                                 (ملغي → إعادة تفعيل فقط)
 */
export const ORDER_STATUS_TRANSITIONS = {
  new: ['delivered', 'completed', 'cancelled'],
  delivered: ['completed', 'returned'],
  completed: ['returned'],
  returned: ['new', 'delivered'],
  cancelled: ['new']
};

/** V3.15.2 — Pure matrix check used by updateOrderStatus before any write. */
export function canTransition(oldStatus, newStatus) {
  return (ORDER_STATUS_TRANSITIONS[oldStatus] || []).includes(newStatus);
}

export function getAllowedTransitions(status) {
  return (ORDER_STATUS_TRANSITIONS[status] || []).slice();
}

/** V3.8 — Fulfilled-status helper. */
export function isFulfilledOrderStatus(status) {
  return status === 'delivered' || status === 'completed';
}

/** V3.16 — An order is "active" when NOT cancelled or returned. */
export function isActiveOrderStatus(status) {
  return status !== 'cancelled' && status !== 'returned';
}

/** V3.8 — Shared human-readable status label. */
export function getOrderStatusLabel(status) {
  switch (status) {
    case 'delivered': return 'تم التوصيل';
    case 'completed': return 'مكتمل';
    case 'returned': return 'مرتجع';
    case 'cancelled': return 'ملغي';
    case 'new':
    default: return 'قيد الانتظار';
  }
}
