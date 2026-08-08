/**
 * Products & Stock domain — pure core + injected repository (100% pure).
 * Ported VERBATIM from js/services/products.js (legacy).
 */
import { round2, generateAutoId, formatCurrency } from '../../utils/formatters.js';
import { getCairoFormattedDate } from '../../utils/formatters.js';
import { getSupplierById } from '../suppliers/suppliers.js';

/* ===================== pure query helpers ===================== */

export function getProducts(list) {
  return list;
}

export function getProductById(products, id) {
  return products.find(p => p.id === id || p.code === id) || null;
}

export function findDuplicateProduct(products, { name, code, excludeId = '' }) {
  const cleanName = (name || '').trim().toLowerCase();
  const cleanCode = (code || '').trim().toLowerCase();
  return products.find(p =>
    p.id !== excludeId && (
      (cleanName && p.name && p.name.trim().toLowerCase() === cleanName) ||
      (cleanCode && p.code && p.code.trim().toLowerCase() === cleanCode)
    )
  ) || null;
}

export function searchProducts(products, query) {
  if (!query) return products;
  const q = query.trim().toLowerCase();
  return products.filter(p =>
    (p.name && p.name.toLowerCase().includes(q)) ||
    (p.code && p.code.toLowerCase().includes(q)) ||
    (p.id && p.id.toLowerCase().includes(q)) ||
    (p.category && p.category.toLowerCase().includes(q)) ||
    (p.supplierName && p.supplierName.toLowerCase().includes(q))
  );
}

export function getLowStockProducts(products) {
  return products.filter(p => {
    const minStock = Number(p.minStock);
    const threshold = (!isNaN(minStock) && minStock >= 0) ? minStock : 5;
    return Number(p.stock) <= threshold;
  });
}

/* ===================== orchestration ===================== */

export function createProduct({ code, name, category, purchasePrice, sellingPrice, stock, minStock, supplierId = '', supplierName = '' }, repo) {
  const numStock = Number(stock) || 0;

  if (findDuplicateProduct(repo.getProducts(), { name, code })) {
    throw new Error('يوجد منتج مسجل بالفعل بنفس الاسم أو الكود (SKU) — اختر اسماً أو كوداً مختلفاً');
  }

  const productId = generateAutoId('PRD');
  const now = getCairoFormattedDate();

  const newProduct = {
    id: productId,
    code: code ? code.trim() : productId,
    name: name.trim(),
    category: category ? category.trim() : 'عام',
    purchasePrice: Number(purchasePrice) || 0,
    sellingPrice: Number(sellingPrice) || 0,
    stock: numStock,
    minStock: Number(minStock) || 5,
    supplierId,
    supplierName,
    createdAt: now,
    updatedAt: now
  };

  // Add Product to Cloud Firestore
  repo.addFirestoreDoc(repo.storageKeys.PRODUCTS, newProduct);

  // If supplier provided with stock > 0, accumulate supplier debt
  if (supplierId && numStock > 0 && newProduct.purchasePrice > 0) {
    const totalCost = round2(numStock * newProduct.purchasePrice);
    const supplier = getSupplierById(repo.getSuppliers(), supplierId);
    if (supplier) {
      repo.updateSupplier(supplierId, {
        totalPurchases: round2((Number(supplier.totalPurchases) || 0) + totalCost),
        remainingBalance: round2((Number(supplier.remainingBalance) || 0) + totalCost)
      });

      if (repo.logSupplierTransaction) {
        repo.logSupplierTransaction({
          supplierId,
          supplierName: supplier.name,
          type: 'تسجيل منتج ومخزون',
          refId: productId,
          debit: totalCost,
          note: `إضافة منتج "${newProduct.name}" للمخزون (${numStock} قطعة × ${newProduct.purchasePrice})`,
          date: now
        });
      }
    }
  }

  return newProduct;
}

export function updateProduct(id, data, repo) {
  if (findDuplicateProduct(repo.getProducts(), { name: data.name, code: data.code, excludeId: id })) {
    throw new Error('يوجد منتج مسجل بالفعل بنفس الاسم أو الكود (SKU)');
  }
  repo.updateFirestoreDoc(repo.storageKeys.PRODUCTS, id, {
    ...data,
    updatedAt: getCairoFormattedDate()
  });
}

export async function deleteProduct(id, repo) {
  return repo.deleteFirestoreDoc(repo.storageKeys.PRODUCTS, id);
}

/**
 * Consume available stock for a sale, clamping stock at 0 (never negative).
 */
export function decrementProductStock(productId, qty, repo) {
  const product = getProductById(repo.getProducts(), productId);
  if (!product) return { consumedQty: 0, deficitQty: Number(qty) || 0 };

  const currentStock = Number(product.stock) || 0;
  const requestedQty = Number(qty) || 0;
  const consumedQty = Math.min(currentStock, requestedQty);
  const newStock = currentStock - consumedQty;
  const deficitQty = requestedQty - consumedQty;

  repo.updateFirestoreDoc(repo.storageKeys.PRODUCTS, productId, {
    stock: newStock,
    updatedAt: getCairoFormattedDate()
  });

  return { consumedQty, deficitQty };
}

export function incrementProductStock(productId, qty, repo) {
  const product = getProductById(repo.getProducts(), productId);
  if (!product) return;

  const currentStock = Number(product.stock) || 0;
  const newStock = currentStock + Number(qty);

  repo.updateFirestoreDoc(repo.storageKeys.PRODUCTS, productId, {
    stock: newStock,
    updatedAt: getCairoFormattedDate()
  });
}

/**
 * Add Stock Supply Shipment & Update Supplier Debt
 *
 * F3 — Shipment logistics costs (شحن + نسريات/مستلزمات) are NOT added to the
 * supplier's debt; instead they are distributed into COGS, raising the product's
 * weighted-average cost per unit.
 */
export function addStockShipment(productId, addedQty, supplierId = '', unitPurchasePrice = 0, notes = '', extras = {}, repo) {
  const product = getProductById(repo.getProducts(), productId);
  if (!product) throw new Error('المنتج غير موجود');

  const qty = Number(addedQty);
  if (isNaN(qty) || qty <= 0) throw new Error('يرجى إدخال كمية شحنة صحيحة أكبر من الصفر');

  const currentStock = Number(product.stock) || 0;
  const newStock = currentStock + qty;

  const shipCost = round2(Number(extras && extras.shippingCost) || 0);
  const suppliesCost = round2(Number(extras && extras.suppliesCost) || 0);
  const extrasTotal = round2(shipCost + suppliesCost);
  if (extrasTotal < 0) throw new Error('قيمة مصاريف الشحن/النسريات غير صالحة');

  const updatePayload = {
    stock: newStock,
    updatedAt: getCairoFormattedDate()
  };

  const purPrice = Number(unitPurchasePrice);
  const oldPurchasePrice = Number(product.purchasePrice) || 0;

  // F3 — COGS split: new unit cost = weighted average of (old stock cost +
  // goods cost + shipment logistics costs) across the new total stock.
  if ((!isNaN(purPrice) && purPrice >= 0) || extrasTotal > 0) {
    const goodsCost = (purPrice > 0 ? purPrice : oldPurchasePrice) * qty;
    const totalCost = (currentStock * oldPurchasePrice) + goodsCost + extrasTotal;
    updatePayload.purchasePrice = newStock > 0 ? round2(totalCost / newStock) : 0;
  }
  if (extrasTotal > 0) {
    updatePayload.shipmentExtrasTotal = round2((Number(product.shipmentExtrasTotal) || 0) + extrasTotal);
    updatePayload.lastShipmentExtras = { shippingCost: shipCost, suppliesCost, total: extrasTotal, date: getCairoFormattedDate() };
  }

  repo.updateFirestoreDoc(repo.storageKeys.PRODUCTS, productId, updatePayload);

  // 📦 Accumulate Supplier Debt if Supplier selected — goods value ONLY
  if (supplierId) {
    const costPerUnit = purPrice > 0 ? purPrice : oldPurchasePrice;
    const totalShipmentCost = round2(qty * costPerUnit);

    const supplier = getSupplierById(repo.getSuppliers(), supplierId);
    if (supplier && totalShipmentCost > 0) {
      repo.updateSupplier(supplierId, {
        totalPurchases: round2((Number(supplier.totalPurchases) || 0) + totalShipmentCost),
        remainingBalance: round2((Number(supplier.remainingBalance) || 0) + totalShipmentCost)
      });

      if (repo.logSupplierTransaction) {
        const extrasNote = extrasTotal > 0
          ? ` + مصاريف شحن/نسريات ${formatCurrency(extrasTotal)} موزعة على تكلفة القطعة (لا تُضاف لمديونية المورد)`
          : '';
        repo.logSupplierTransaction({
          supplierId,
          supplierName: supplier.name,
          type: 'شحنة توريد',
          refId: product.id,
          debit: totalShipmentCost,
          note: (notes || '').trim() || `توريد شحنة "${product.name}" (${qty} قطعة × ${formatCurrency(costPerUnit)}) للمخزن${extrasNote}`,
          date: getCairoFormattedDate()
        });
      }
    }
  }
}
