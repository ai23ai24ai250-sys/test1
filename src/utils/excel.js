/**
 * Excel Export utility using SheetJS (xlsx) — → React (Phase 2 port)
 * ==================================================================
 * Faithful ES-module port of js/utils/excel.js: single-table exports plus the
 * full 5-sheet unified workbook export. Pure module — reads `window.XLSX` and
 * the live data-access helpers at call time, exactly like the legacy script.
 */

import { getCairoFormattedDate } from './formatters.js';

export function exportToExcel(dataArray, filename = 'report.xlsx', sheetName = 'التقرير') {
  if (!window.XLSX) {
    console.error('SheetJS library is not loaded');
    alert('تعذر تحميل مكتبة التصدير إلى Excel');
    return;
  }

  try {
    const worksheet = window.XLSX.utils.json_to_sheet(dataArray);

    if (!worksheet['!views']) worksheet['!views'] = [];
    worksheet['!views'].push({ RTL: true });

    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    window.XLSX.writeFile(workbook, filename);
  } catch (error) {
    console.error('Error exporting to Excel:', error);
    alert('حدث خطأ أثناء تصدير ملف Excel');
  }
}

export function exportTableToExcel(tableId, filename = 'table_export.xlsx') {
  if (!window.XLSX) {
    console.error('SheetJS library is not loaded');
    return;
  }

  const table = document.getElementById(tableId);
  if (!table) return;

  const workbook = window.XLSX.utils.table_to_book(table, { sheet: 'التقرير' });
  window.XLSX.writeFile(workbook, filename);
}

/**
 * Full Database Export into a Single Unified Excel Workbook with 5 Worksheets
 */
export function exportFullDatabaseToExcel() {
  if (!window.XLSX) {
    alert('مكتبة SheetJS غير محملة');
    return;
  }

  try {
    const workbook = window.XLSX.utils.book_new();
    const todayStr = getCairoFormattedDate().slice(0, 10);

    // 1. Sheet: Orders & Sales (المبيعات والفواتير)
    const orders = window.getOrders();
    const ordersData = orders.map(o => ({
      'رقم الفاتورة': o.id,
      'اسم العميل': o.customerName,
      'رقم الهاتف': o.customerPhone,
      'الهاتف الثانوي': o.customerSecondaryPhone || '',
      'تصنيف العميل': o.customerCategory || '',
      // V3.26 — dedicated columns so the shipping address chosen for this order
      // and the customer's full address list are exported (never lost).
      'عنوان الشحن لهذا الطلب': o.shippingAddress || '—',
      'اسم عنوان الشحن': o.shippingAddressLabel || '',
      'معرّف عنوان الشحن': o.shippingAddressId || '',
      'عناوين العميل (قائمة)': (window.getCustomerAddresses ? window.getCustomerAddresses(o.customerId).map(a => (a.label ? a.label + ': ' : '') + a.address).join(' | ') : (o.customerAddresses || '')),
      'نوع التنفيذ': o.directShipping ? 'شحن مباشر من المورد' : 'من المخزون',
      'نوع العربون': o.depositType === 'shipping' ? 'عربون بقيمة الشحن' : o.depositType === 'shipping_extra' ? 'عربون الشحن + المصروفات' : 'عربون عادي',
      'إيراد خدمات شحن ونقل (ج.م)': window.getOrderShippingRevenue ? window.getOrderShippingRevenue(o) : 0,
      'إجمالي الفاتورة (ج.م)': o.totalAmount,
      'المدفوع مقدماً (ج.م)': o.downPayment,
      'عربون محتفظ به (إيراد)': (o.status === 'cancelled' || o.status === 'returned') ? (Number(o.retainedDeposit) || 0) : 0,
      'إرجاع عربون (خصم)': (o.status === 'cancelled' || o.status === 'returned') ? (Number(o.refundedAmount) || 0) : 0,
      'المتبقي (ج.م)': window.getOrderRemainingAmount(o),
      'حالة الطلب': window.getOrderStatusLabel(o.status),
      'المسجل': o.createdBy || 'المدير العام',
      'التاريخ': window.formatDate(o.createdAt)
    }));
    const wsOrders = window.XLSX.utils.json_to_sheet(ordersData);
    wsOrders['!views'] = [{ RTL: true }];
    window.XLSX.utils.book_append_sheet(workbook, wsOrders, 'المبيعات والفواتير');

    // 2. Sheet: Payments & Treasury (الخزينة والدفعات) — receipts (inflow) and
    //    refunds/refunded deposits (outflow) so net treasury reconciles exactly.
    const payments = window.getPayments();
    const paymentsData = payments.map(p => {
      const amt = Number(p.amount) || 0;
      const isRefund = amt < 0;
      return {
        'كود العملية': p.id,
        'نوع العملية': isRefund
          ? 'استرداد / رد عربون (صادر)'
          : p.entityType === 'customer' ? 'تحصيل من عميل (وارد)' : 'تسديد لمورد (صادر)',
        'الطرف': p.entityName,
        'المبلغ (ج.م)': amt,
        'وسيلة الدفع': p.paymentMethod === 'cash' ? 'نقدي (كاش)' : p.paymentMethod === 'transfer' ? 'تحويل بنكي / فودافون كاش' : p.paymentMethod === 'check' ? 'شيك بنكي' : 'أخرى',
        'التاريخ': p.date,
        'البيان': p.notes || '—',
        'المسجل': p.createdBy || 'المدير العام'
      };
    });
    const wsPayments = window.XLSX.utils.json_to_sheet(paymentsData);
    wsPayments['!views'] = [{ RTL: true }];
    window.XLSX.utils.book_append_sheet(workbook, wsPayments, 'الخزينة والدفعات');

    // 3. Sheet: Customers (العملاء وأرصدتهم)
    const customers = window.getCustomers();
    const customersData = customers.map(c => ({
      'كود العميل': c.id,
      'اسم العميل': c.name,
      'رقم الهاتف': c.phone,
      'الهاتف الثانوي': c.secondaryPhone || '',
      'تصنيف العميل': c.category || '',
      'العنوان': c.address || '—',
      // V3.26 — export the customer's full saved address list (labels + addresses).
      'قائمة العناوين': (Array.isArray(c.addresses) && c.addresses.length ? c.addresses : (window.getCustomerAddresses ? window.getCustomerAddresses(c.id) : [])).map(a => (a.label ? a.label + ': ' : '') + a.address).join(' | '),
      'عدد الطلبات': c.ordersCount || 0,
      'إجمالي المشتريات (ج.م)': c.totalPurchases || 0,
      'إجمالي المسدد (ج.م)': c.paid || 0,
      'الرصيد المتبقي عليه (ج.م)': c.remainingBalance || 0,
      'تاريخ آخر طلب': window.formatDate(c.lastOrderDate)
    }));
    const wsCustomers = window.XLSX.utils.json_to_sheet(customersData);
    wsCustomers['!views'] = [{ RTL: true }];
    window.XLSX.utils.book_append_sheet(workbook, wsCustomers, 'العملاء والأرصدة');

    // 4. Sheet: Suppliers & Payments (الموردين والدفعات)
    const suppliers = window.getSuppliers();
    const suppliersData = suppliers.map(s => ({
      'كود المورد': s.id,
      'اسم المورد / المصنع': s.name,
      'رقم الهاتف': s.phone || '—',
      'الهاتف الثانوي': s.secondaryPhone || '',
      'العنوان': s.address || '—',
      'إجمالي التعاملات (ج.م)': s.totalPurchases || 0,
      'المبلغ المسدد (ج.م)': s.paid || 0,
      'الرصيد المستحق للمورد (ج.م)': s.remainingBalance || 0
    }));
    const wsSuppliers = window.XLSX.utils.json_to_sheet(suppliersData);
    wsSuppliers['!views'] = [{ RTL: true }];
    window.XLSX.utils.book_append_sheet(workbook, wsSuppliers, 'الموردين والحسابات');

    // 5. Sheet: Products & Inventory (المنتجات والمخزون)
    const products = window.getProducts();
    const productsData = products.map(p => ({
      'كود المنتج': p.id,
      'اسم المنتج': p.name,
      'المخزون الحالي': p.stock,
      'سعر الشراء (ج.م)': p.purchasePrice,
      'سعر البيع (ج.م)': p.sellingPrice,
      'الحد الأدنى للتنبيه': p.minStock,
      'الحالة': p.stock <= p.minStock ? (p.stock < 0 ? `عجز (${p.stock})` : 'مخزون منخفض') : 'متوفر',
      'ملاحظات': p.notes || '—'
    }));
    const wsProducts = window.XLSX.utils.json_to_sheet(productsData);
    wsProducts['!views'] = [{ RTL: true }];
    window.XLSX.utils.book_append_sheet(workbook, wsProducts, 'المنتجات والمخزون');

    // 6. Sheet: Users & Accounts (حسابات الموظفين)
    const users = window.getUsers();
    const usersData = users.map(u => ({
      'كود المستخدم': u.id,
      'الاسم': u.name,
      'البريد الإلكتروني': u.email,
      'الصلاحية / الرتبة': u.role === 'admin' ? 'مدير نظام' : u.role === 'storekeeper' ? 'أمين مخزن' : 'موظف مبيعات',
      'تاريخ الإنشاء': window.formatDate(u.createdAt)
    }));
    const wsUsers = window.XLSX.utils.json_to_sheet(usersData);
    wsUsers['!views'] = [{ RTL: true }];
    window.XLSX.utils.book_append_sheet(workbook, wsUsers, 'حسابات الموظفين');

    // Write file
    window.XLSX.writeFile(workbook, `تصدير_قاعدة_البيانات_الشاملة_${todayStr}.xlsx`);
    window.showToast('تم تصدير قاعدة البيانات بالكامل إلى ملف Excel موحد بنجاح', 'success');

  } catch (err) {
    console.error('Unified Export Error:', err);
    alert('حدث خطأ أثناء تصدير كافة بيانات النظام إلى Excel');
  }
}
