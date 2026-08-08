// =============================================================================
// ui/views/Dashboard.jsx — نسخة React من js/components/dashboard.js — Phase 3
// -----------------------------------------------------------------------------
// لوحة الرصد: 7 بطاقات KPI + إيراد الشحن + فواتير قيد الانتظار + إجراءات سريعة
// + أحدث الفواتير. الحسابات من الدومين النقي، والبيانات الخام عبر الجسر
// (window) بنفس قرّاءات النسخة القديمة. يتحدث تلقائياً مع bms-data-synced.
// =============================================================================
import { useState, useEffect } from 'react'
import {
  TrendingUp,
  Boxes,
  Coins,
  ArrowDownLeft,
  ArrowUpRight,
  ShoppingBag,
  AlertTriangle,
  Truck,
  Clock,
  PlusCircle,
  ShoppingCart,
  Wallet,
  CreditCard,
  History,
  ArrowLeft,
} from 'lucide-react'
import Badge from '../components/Badge.jsx'
import { useUiStore } from '../state/uiStore.js'
import { useAuthStore } from '@/state/authStore'
import { canSeeDashboard } from '@/services/permissions'
import { calculateNetProfit, getOrderStatusLabel, getOrderRemainingAmount } from '@/domain/accounting/accounting'
import { getTotalCustomerReceivables, getTotalSupplierPayables } from '@/domain/accounting/payments'
import { getOpenOrdersCount } from '@/domain/orders/orderRepository'
import { getLowStockProducts } from '@/domain/inventory/products'
import { formatCurrency, formatPhonePair, formatDate, toNumber } from '@/utils/formatters'

function readOrders() {
  return window.getOrders ? window.getOrders() : []
}

function computeStats() {
  const orders = readOrders()
  const products = window.getProducts ? window.getProducts() : []
  const suppliers = window.getCollection && window.STORAGE_KEYS ? window.getCollection(window.STORAGE_KEYS.SUPPLIERS) : []
  const calc = calculateNetProfit(orders, {
    getExpenses: () => (window.getExpenses ? window.getExpenses() : []),
    ...(window.getCurrentOperatingExpenses
      ? { getCurrentOperatingExpenses: () => window.getCurrentOperatingExpenses() }
      : {}),
    getSupplierReturns: () => (window.getSupplierReturns ? window.getSupplierReturns() : []),
  })

  const inventoryValuation = products.reduce((sum, p) => {
    const stock = Math.max(0, toNumber(p.stock))
    const buyPrice = toNumber(p.purchasePrice)
    return sum + stock * buyPrice
  }, 0)

  const pendingOrders = orders.filter(o => o.status === 'new')
  const pendingCollectedDeposits = pendingOrders.reduce((s, o) => s + toNumber(o.downPayment), 0)

  return {
    orders,
    grossSales: calc.grossSales,
    netProfit: calc.netProfit,
    shippingRevenueIncome: calc.shippingRevenueIncome || 0,
    inventoryValuation,
    customerReceivables: getTotalCustomerReceivables(orders),
    supplierPayables: getTotalSupplierPayables(suppliers),
    openOrdersCount: getOpenOrdersCount(orders),
    lowStockCount: getLowStockProducts(products).length,
    pendingCount: pendingOrders.length,
    pendingCollectedDeposits,
    recentOrders: orders.slice(0, 5),
  }
}

function KpiCard({ label, value, icon: Icon, iconClass, valueClass, hint, onClick }) {
  return (
    <button
      onClick={onClick}
      className={[
        'bg-slate-900/90 border border-slate-800 p-4 rounded-2xl shadow-lg relative overflow-hidden text-right',
        'hover:border-slate-700 transition-all',
        onClick ? 'cursor-pointer' : 'cursor-default',
      ].join(' ')}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-400">{label}</span>
        <div className={`p-2 rounded-xl border ${iconClass}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className={`text-lg font-extrabold num-font mb-1 ${valueClass || 'text-white'}`}>{value}</div>
      {hint ? <span className="text-[10px] text-slate-400">{hint}</span> : null}
    </button>
  )
}

function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState(() => computeStats())

  // 🔒 V3.43 — لوحة التحكم مالية: لا تصلح للكاشير/أمين المخزن ولو فُتحت مباشرة.
  const role = useAuthStore(s => s.role)
  if (role && !canSeeDashboard(role)) {
    return (
      <div className="grid place-items-center min-h-[60vh] animate-fadeIn">
        <div className="text-center bg-slate-900/60 p-8 rounded-2xl border border-slate-800 max-w-md">
          <h2 className="text-lg font-bold text-white mb-2">لوحة التحكم غير متاحة لهذا الحساب</h2>
          <p className="text-sm text-slate-400">الأرقام المالية (المبيعات، التكلفة، الأرباح، المصروفات، الديون) متاحة لمدير المتجر والمحاسب فقط.</p>
        </div>
      </div>
    )
  }

  useEffect(() => {
    const handler = () => setStats(computeStats())
    window.addEventListener('bms-data-synced', handler)
    return () => window.removeEventListener('bms-data-synced', handler)
  }, [])

  const s = stats
  const openNewOrder = () => useUiStore.getState().openOrderModal()
  const openPayment = () => useUiStore.getState().openPaymentModal()

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Welcome header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/60 p-6 rounded-2xl border border-slate-800 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1 flex items-center gap-2">
            <span>لوحة التحكم والرصد اليومي</span>
          </h1>
          <p className="text-sm text-slate-400">متابعة المبيعات الحية، تكلفة المخزون، الأرباح، المصروفات، والديون الآجلة</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 bg-slate-800/80 px-4 py-2.5 rounded-xl border border-slate-700/80">
          <Clock className="w-4 h-4 text-brand-400" />
          <span>التحديث الآلي: مباشر</span>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-4">
        <KpiCard
          label="إجمالي المبيعات"
          icon={TrendingUp}
          iconClass="bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
          value={formatCurrency(s.grossSales)}
          hint="إجمالي الفواتير المؤكدة (شامل شحن ومصاريف العميل)"
        />
        <KpiCard
          label="إجمالي التكلفة بالمخزن"
          icon={Boxes}
          iconClass="bg-amber-500/10 text-amber-400 border-amber-500/20"
          value={formatCurrency(s.inventoryValuation)}
          hint="محسوبة بسعر الشراء من المورد"
          onClick={() => onNavigate && onNavigate('products')}
        />
        <KpiCard
          label="صافي الربح"
          icon={Coins}
          iconClass="bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
          value={formatCurrency(s.netProfit)}
          valueClass={s.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          hint="ربح البضاعة فقط بعد التكلفة ومصاريف التاجر"
          onClick={() => onNavigate && onNavigate('reports')}
        />
        <KpiCard
          label="ديون على العملاء (آجل)"
          icon={ArrowDownLeft}
          iconClass="bg-brand-500/10 text-brand-400 border-brand-500/20"
          value={formatCurrency(s.customerReceivables)}
          hint="أموال متبقية للتحصيل"
          onClick={() => onNavigate && onNavigate('customers')}
        />
        <KpiCard
          label="ديون للموردين (مستحقة)"
          icon={ArrowUpRight}
          iconClass="bg-purple-500/10 text-purple-400 border-purple-500/20"
          value={formatCurrency(s.supplierPayables)}
          hint="مبالغ واجبة السداد للمصانع"
          onClick={() => onNavigate && onNavigate('suppliers')}
        />
        <KpiCard
          label="الطلبات الفعالة"
          icon={ShoppingBag}
          iconClass="bg-sky-500/10 text-sky-400 border-sky-500/20"
          value={`${s.openOrdersCount} طلبات`}
          hint="قيد التنفيذ"
          onClick={() => onNavigate && onNavigate('orders')}
        />
        <KpiCard
          label="نواقص المخزون"
          icon={AlertTriangle}
          iconClass="bg-rose-500/10 text-rose-400 border-rose-500/20"
          value={`${s.lowStockCount} أصناف`}
          valueClass={s.lowStockCount > 0 ? 'text-rose-400' : 'text-slate-200'}
          hint="تحتاج توريد"
          onClick={() => onNavigate && onNavigate('products')}
        />
      </div>

      {/* Shipping revenue */}
      <div className="bg-sky-950/30 border border-sky-800/40 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/30">
            <Truck className="w-5 h-5" />
          </div>
          <div>
            <span className="text-sm font-bold text-sky-300 block">إيراد خدمات شحن ونقل</span>
            <span className="text-[11px] text-slate-500">عربون الشحن/التغليف المحصَّل بجميع الحالات — لا يُحتسب ضمن مبيعات البضاعة ولا صافي ربح المنتجات</span>
          </div>
        </div>
        <span className="text-xl font-extrabold text-sky-400 num-font">{formatCurrency(s.shippingRevenueIncome)}</span>
      </div>

      {/* Pending orders */}
      <div className="bg-amber-950/25 border border-amber-800/40 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <span className="text-sm font-bold text-amber-300 block">فواتير قيد الانتظار (غير مؤكدة البيع)</span>
            <span className="text-[11px] text-slate-500">لم تُشحن بعد — لا تدخل في مبيعات البضاعة المؤكدة، والعربون المحصَّل منها يظهر فوراً في وارد الخزينة</span>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <div className="text-left">
            <span className="text-[11px] text-slate-400 block">عدد الفواتير</span>
            <span className="text-lg font-extrabold text-amber-300 num-font">{s.pendingCount}</span>
          </div>
          <div className="text-left">
            <span className="text-[11px] text-slate-400 block">العربون المحصَّل</span>
            <span className="text-lg font-extrabold text-emerald-400 num-font">{formatCurrency(s.pendingCollectedDeposits)}</span>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-gradient-to-br from-brand-900/40 to-slate-900 border border-brand-500/30 p-6 rounded-2xl shadow-lg flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 bg-brand-600/20 text-brand-400 rounded-xl border border-brand-500/30">
                <PlusCircle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">إنشاء طلب جديد / فاتورة بيع</h3>
                <p className="text-xs text-slate-400">إضافة طلب للعميل وتخصيم المخزون وحساب الآجل آلياً</p>
              </div>
            </div>
          </div>
          <button onClick={openNewOrder} className="mt-4 w-full py-3 px-4 bg-brand-600 hover:bg-brand-500 text-white font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2">
            <ShoppingCart className="w-5 h-5" />
            <span>فتح نافذة فاتورة البيع</span>
          </button>
        </div>

        <div className="bg-gradient-to-br from-emerald-950/40 to-slate-900 border border-emerald-500/30 p-6 rounded-2xl shadow-lg flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 bg-emerald-600/20 text-emerald-400 rounded-xl border border-emerald-500/30">
                <Wallet className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">تسديد / تحصيل دفعة مالية</h3>
                <p className="text-xs text-slate-400">تسجيل مقبوضات نقدية من عميل أو دفعات صادرة لمورد</p>
              </div>
            </div>
          </div>
          <button onClick={openPayment} className="mt-4 w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2">
            <CreditCard className="w-5 h-5" />
            <span>تسجيل إيصال جديد</span>
          </button>
        </div>
      </div>

      {/* Recent orders */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <History className="w-5 h-5 text-brand-400" />
            <span>أحدث الطلبات والفواتير المسجلة</span>
          </h3>
          <button onClick={() => onNavigate && onNavigate('orders')} className="text-xs text-brand-400 hover:text-brand-300 font-bold flex items-center gap-1">
            <span>عرض كافة الفواتير</span>
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th>رقم الطلب</th>
                <th>اسم العميل</th>
                <th>رقم الهاتف</th>
                <th>إجمالي الفاتورة</th>
                <th>المقدم</th>
                <th>المتبقي</th>
                <th>الحالة</th>
                <th>التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {s.recentOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-6 text-slate-500">لا توجد طلبات مسجلة حتى الآن</td>
                </tr>
              ) : (
                s.recentOrders.map(o => {
                  const remaining = getOrderRemainingAmount(o)
                  return (
                    <tr key={o.id}>
                      <td className="font-bold text-brand-400 num-font">{o.id}</td>
                      <td className="font-bold text-white">{o.customerName}</td>
                      <td className="num-font text-slate-300">{formatPhonePair(o.customerPhone, o.customerSecondaryPhone)}</td>
                      <td className="num-font font-bold text-white">{formatCurrency(o.totalAmount)}</td>
                      <td className="num-font text-emerald-400">{formatCurrency(o.downPayment)}</td>
                      <td className={`num-font font-bold ${remaining > 0 ? 'text-rose-400' : 'text-slate-400'}`}>{formatCurrency(remaining)}</td>
                      <td><Badge variant={o.status === 'delivered' || o.status === 'completed' ? 'success' : o.status === 'returned' ? 'error' : o.status === 'cancelled' ? 'neutral' : 'warning'}>{getOrderStatusLabel(o.status)}</Badge></td>
                      <td className="text-xs text-slate-400 num-font">{formatDate(o.createdAt)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
