// =============================================================================
// ui/layout/AppShell.jsx — هيكل التطبيق (شريط جانبي + رأس + منطقة محتوى) — Phase 3
// -----------------------------------------------------------------------------
// تنقّل بسيط بدون راوتر (حالة محلية): شاشة «سجل الطلبات» جاهزة الآن، وباقي
// الشاشات تظهر كعناصر معلّقة حتى تُنقل. المظهر والمستخدم يأتيان من المخازن.
// =============================================================================
import { useState } from 'react'
import {
  ShoppingBag,
  Sun,
  Moon,
  LogOut,
  LayoutDashboard,
  ReceiptText,
  Users,
  Package,
  Truck,
  Wallet,
  TrendingUp,
  HandCoins,
  UserCog,
  Settings,
  ChevronDown,
  CloudCog,
  KeyRound,
  RefreshCw,
  FlaskConical,
  ExternalLink,
  Plus,
  Store,
  Sparkles,
  Menu,
  X,
} from 'lucide-react'
import OrdersView from '../views/OrdersView.jsx'
import Dashboard from '../views/Dashboard.jsx'
import CustomersView from '../views/CustomersView.jsx'
import ProductsView from '../views/ProductsView.jsx'
import SuppliersView from '../views/SuppliersView.jsx'
import ExpensesView from '../views/ExpensesView.jsx'
import ReportsView from '../views/ReportsView.jsx'
import PaymentsView from '../views/PaymentsView.jsx'
import UsersView from '../views/UsersView.jsx'
import SettingsView from '../views/SettingsView.jsx'
import OrderModal from '../modals/OrderModal.jsx'
import PosModal from '../modals/PosModal.jsx'
import AiAssistantModal from '../modals/AiAssistantModal.jsx'
import OrderDetailsModal from '../modals/OrderDetailsModal.jsx'
import OrderStatusModal from '../modals/OrderStatusModal.jsx'
import AddCustomerModal from '../modals/AddCustomerModal.jsx'
import AddProductModal from '../modals/AddProductModal.jsx'
import ShipmentModal from '../modals/ShipmentModal.jsx'
import AddSupplierModal from '../modals/AddSupplierModal.jsx'
import SupplierReturnModal from '../modals/SupplierReturnModal.jsx'
import AddExpenseModal from '../modals/AddExpenseModal.jsx'
import WipeDatabaseModal from '../modals/WipeDatabaseModal.jsx'
import PaymentModal from '../modals/PaymentModal.jsx'
import UserModal from '../modals/UserModal.jsx'
import AdminPasswordModal from '../modals/AdminPasswordModal.jsx'
import ChangePasswordModal from '../modals/ChangePasswordModal.jsx'
import CloudSyncModal from '../modals/CloudSyncModal.jsx'
import StatementModal from '../modals/StatementModal.jsx'
import Card from '../components/Card.jsx'
import Badge from '../components/Badge.jsx'
import { useSettingsStore } from '@/state/settingsStore'
import { useAuthStore } from '@/state/authStore'
import { useSandboxStore } from '@/state/sandboxStore'
import { useUiStore } from '@/ui/state/uiStore'
import { showToast } from '../components/toastStore.js'
import { visibleNavItems, canCreateOrder, canUsePos, canSyncOrTest, canUseAi, canSeeDashboard } from '@/services/permissions'

const NAV = [
  { id: 'dashboard', label: 'لوحة التحكم', icon: LayoutDashboard, ready: true },
  { id: 'orders', label: 'سجل الطلبات', icon: ReceiptText, ready: true },
  { id: 'customers', label: 'العملاء', icon: Users, ready: true },
  { id: 'products', label: 'المنتجات', icon: Package, ready: true },
  { id: 'suppliers', label: 'الموردون', icon: Truck, ready: true },
  { id: 'expenses', label: 'المصروفات', icon: Wallet, ready: true },
  { id: 'payments', label: 'إدارة المدفوعات', icon: HandCoins, ready: true },
  { id: 'reports', label: 'التقارير', icon: TrendingUp, ready: true },
  { id: 'users', label: 'المستخدمون', icon: UserCog, ready: true },
  { id: 'settings', label: 'الإعدادات', icon: Settings, ready: true },
]

// 🔒 RBAC (V3.43): قائمة الشاشات لكل دور محددة في services/permissions:
//   admin → الكل، employee (كاشير) → طلبات/عملاء/منتجات،
//   storekeeper → منتجات فقط، accountant → لوحة/طلبات/عملاء/منتجات/موردون/مصروفات/مدفوعات/تقارير.
function visibleNav(role) {
  return visibleNavItems(role)
    .map(id => NAV.find(item => item.id === id))
    .filter(Boolean)
}

function ComingSoon() {
  return (
    <Card>
      <div className="py-20 text-center">
        <div className="text-4xl mb-3">🚧</div>
        <h2 className="text-lg font-bold text-white mb-1">هذه الشاشة قيد النقل إلى React</h2>
        <p className="text-sm text-slate-500">ستُتاح فور اكتمال تحويلها في مرحلة لاحقة</p>
      </div>
    </Card>
  )
}

function AppShell() {
  const role = useAuthStore(s => s.role)
  const [active, setActive] = useState(() => {
    if (role === 'storekeeper') return 'products'
    if (role === 'employee') return 'orders'
    return 'dashboard'
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [syncMenuOpen, setSyncMenuOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncDir, setSyncDir] = useState(() => {
    if (typeof window !== 'undefined' && window.GoogleSheetsSync && typeof window.GoogleSheetsSync.getConfig === 'function') {
      try {
        const c = window.GoogleSheetsSync.getConfig()
        if (c) {
          return c.enabled
            ? ['both', 'export', 'import'].indexOf(c.direction) >= 0
              ? c.direction
              : 'export'
            : 'off'
        }
      } catch { /* ignore malformed config */ }
    }
    return 'off'
  })
  const appName = useSettingsStore(s => s.appName)
  const logo = useSettingsStore(s => s.logo)
  const theme = useSettingsStore(s => s.theme)
  const setTheme = useSettingsStore(s => s.setTheme)
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const sandboxActive = useSandboxStore(s => s.active)
  const toggleSandbox = useSandboxStore(s => s.toggle)
  const openAdminPasswordModal = useUiStore(s => s.openAdminPasswordModal)
  const openChangePasswordModal = useUiStore(s => s.openChangePasswordModal)

  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const View =
    active === 'dashboard'
      ? Dashboard
      : active === 'orders'
        ? OrdersView
        : active === 'customers'
          ? CustomersView
          : active === 'products'
            ? ProductsView
            : active === 'suppliers'
              ? SuppliersView
            : active === 'expenses'
              ? ExpensesView
              : active === 'payments'
                ? PaymentsView
                : active === 'reports'
                  ? ReportsView
                  : active === 'users'
                    ? UsersView
                    : active === 'settings'
                      ? SettingsView
                      : ComingSoon
  const ThemeIcon = theme === 'dark' ? Sun : Moon
  const items = visibleNav(user ? role : null)

  // 🔒 V3.43 — زر الشعار لا يمرّ الكاشير/أمين المخزن إلى لوحة التحكم المالية:
  // يوجّههما لشاشتهما الافتراضية بدلاً من dashboard.
  const goDashboard = () =>
    setActive(canSeeDashboard(role) ? 'dashboard' : role === 'storekeeper' ? 'products' : 'orders')

  const runManualSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      if (typeof window.syncWithGoogleSheets === 'function') {
        await window.syncWithGoogleSheets()
        showToast('تمت المزامنة مع Google Sheets بنجاح', 'success')
      } else {
        showToast('خدمة المزامنة مع Google Sheets غير متوفرة حالياً', 'warning')
      }
    } catch (err) {
      showToast('فشلت المزامنة: ' + ((err && err.message) || String(err)), 'error')
    } finally {
      setSyncing(false)
      setSyncMenuOpen(false)
    }
  }

  const openSyncSheet = () => {
    setSyncMenuOpen(false)
    const gs = window.GoogleSheetsSync
    if (gs && typeof gs.openSheetUrl === 'function') {
      gs.openSheetUrl()
    } else {
      showToast('خدمة فتح ورقة البيانات غير متوفرة حالياً', 'warning')
    }
  }

  const changeSyncDirection = value => {
    setSyncDir(value)
    const gs = window.GoogleSheetsSync
    if (gs && typeof gs.setQuickDirection === 'function') {
      gs.setQuickDirection(value)
    }
    const DIR_LABELS = { both: 'بالاتجاهين', export: 'تصدير فقط', import: 'استيراد فقط' }
    showToast(value === 'off' ? '⏸ تم إيقاف المزامنة التلقائية' : '✓ تم تغيير نوع المزامنة إلى: ' + (DIR_LABELS[value] || value), 'success')
  }

  const handleSandboxToggle = () => {
    toggleSandbox()
    showToast(
      sandboxActive
        ? 'تم الخروج من وضع الاختبار وعودة البيانات الأصلية'
        : '🧪 وضع الاختبار نشط — كل التغييرات داخل الذاكرة فقط ولن تمس بياناتك الحقيقية',
      'info'
    )
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 text-slate-100">
      {sandboxActive ? (
        <div className="sticky top-0 z-[60] w-full bg-gradient-to-r from-amber-500 to-orange-600 text-white text-sm font-bold px-4 py-2 flex items-center justify-center gap-2 text-center shadow-lg">
          <FlaskConical className="w-4 h-4 shrink-0" />
          <span className="truncate">🧪 وضع الاختبار نشط — كل التغييرات داخل الذاكرة فقط ولن تمس بياناتك الحقيقية. اضغط «إنهاء الاختبار» في الشريط العلوي للعودة.</span>
        </div>
      ) : null}
      <OrderModal />
      <PosModal />
      <AiAssistantModal />
      <OrderDetailsModal />
      <OrderStatusModal />
      <AddCustomerModal />
      <AddProductModal />
      <ShipmentModal />
      <AddSupplierModal />
      <SupplierReturnModal />
      <AddExpenseModal />
      <WipeDatabaseModal />
      <PaymentModal />
      <UserModal />
      <AdminPasswordModal />
      <ChangePasswordModal />
      <CloudSyncModal />
      <StatementModal />
      <div className="flex">
        <aside className="w-60 shrink-0 min-h-screen bg-slate-900/70 border-l border-slate-800 hidden md:flex flex-col">
          <button
            type="button"
            onClick={goDashboard}
            title="العودة للوحة التحكم"
            aria-label="العودة للوحة التحكم"
            className="w-full p-5 flex items-center gap-3 border-b border-slate-800 text-left cursor-pointer hover:bg-slate-800/40 transition-all"
          >
            <span className="w-10 h-10 grid place-items-center rounded-xl bg-brand-500/15 text-brand-400 shrink-0 overflow-hidden">
              {logo ? (
                <img src={logo} alt={appName} className="w-full h-full object-contain" />
              ) : (
                <ShoppingBag className="w-5 h-5" />
              )}
            </span>
            <div className="min-w-0">
              <div className="font-bold text-white leading-tight truncate">{appName}</div>
              <div className="text-[11px] text-slate-500">نظام إدارة المحل</div>
            </div>
          </button>
          <nav className="flex-1 p-3 space-y-1">
            {items.map(item => {
              const Icon = item.icon
              const isActive = item.id === active
              return (
                <button
                  key={item.id}
                  onClick={() => setActive(item.id)}
                  className={[
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all',
                    isActive
                      ? 'bg-brand-500/15 text-brand-300 font-semibold'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
                    item.ready ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                  ].join(' ')}
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-right">{item.label}</span>
                  {!item.ready && <span className="text-[10px] text-slate-600">قريباً</span>}
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="flex-1 min-w-0">
          <header className="h-16 flex items-center justify-between md:justify-end px-3 sm:px-6 border-b border-slate-800 bg-slate-900/40 sticky top-0 z-10 gap-3">
            {/* V3.41 — على الجوال فقط: زر القائمة (الثلاث شرط) أولاً في أقصى اليمين
                ثم الشعار. على الشاشات الكبيرة (md+) يختفي هذا القسم كاملاً لأن
                الشعار يعيش في الشريط الجانبي فقط (لا تكرار للشعار في الهيدر). */}
            <div className="flex items-center gap-2 min-w-0 md:hidden">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                title="فتح قائمة التنقل"
                aria-label="فتح قائمة التنقل"
                className="w-10 h-10 shrink-0 grid place-items-center rounded-xl border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <Menu className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={goDashboard}
                title="الذهاب إلى لوحة التحكم"
                aria-label="شعار المتجر — العودة للوحة التحكم"
                className="flex items-center gap-2 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
              >
                <span className="w-9 h-9 grid place-items-center rounded-xl bg-brand-500/15 text-brand-400 shrink-0 overflow-hidden">
                  {logo ? (
                    <img src={logo} alt={appName} className="w-full h-full object-contain" />
                  ) : (
                    <Store className="w-5 h-5" />
                  )}
                </span>
                <span className="min-w-0 text-right hidden sm:block">
                  <span className="block text-sm font-bold text-white truncate">{appName}</span>
                  <span className="block text-[11px] text-slate-500 truncate">نظام إدارة المحل</span>
                </span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {canCreateOrder(role) ? (
                <button
                  onClick={() => useUiStore.getState().openOrderModal()}
                  title="إنشاء طلب جديد / فاتورة بيع"
                  className="h-10 w-10 sm:w-auto sm:px-3 px-0 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-700 to-emerald-600 hover:from-emerald-600 hover:to-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-700/30 whitespace-nowrap transition-all cursor-pointer shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">إنشاء طلب جديد</span>
                </button>
              ) : null}

              {/* V3.41 — الكاشير السريع يُخفى على الجوال لتخفيف ازدحام الهيدر */}
              {canUsePos(role) ? (
                <button
                  onClick={() => useUiStore.getState().openPosModal()}
                  title="وضع الكاشير — بيع سريع فوري"
                  className="hidden sm:flex h-10 px-3 items-center gap-2 rounded-xl bg-amber-600 border border-amber-500 hover:bg-amber-500 text-white text-sm font-bold whitespace-nowrap transition-all cursor-pointer shrink-0"
                >
                  <Store className="w-4 h-4" />
                  <span className="hidden sm:inline">كاشير سريع</span>
                </button>
              ) : null}

              {canSyncOrTest(role) ? (
                <div className="relative shrink-0">
                <button
                  onClick={() => {
                    setSyncMenuOpen(o => !o)
                    setMenuOpen(false)
                  }}
                  title="خيارات المزامنة السريعة"
                  className="h-10 px-3 flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-800 text-sm font-medium transition-all whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw className={`w-4 h-4 text-brand-400 ${syncing ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">المزامنة</span>
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                </button>
                {syncMenuOpen ? (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setSyncMenuOpen(false)} />
                    <div className="absolute left-0 mt-2 w-64 max-w-[calc(100vw-5rem)] z-40 rounded-xl border border-slate-800 bg-slate-900 shadow-2xl py-2">
                      <p className="px-4 pt-1 pb-2 text-[11px] font-bold text-slate-500 border-b border-slate-800">
                        خيارات المزامنة السريعة
                      </p>
                      <button
                        onClick={runManualSync}
                        disabled={syncing}
                        title="مزامنة مع Google Sheets حسب نوع المزامنة المحفوظ في الإعدادات (تصدير / استيراد / بالاتجاهين)"
                        className="w-full px-4 py-2.5 text-right text-sm text-slate-300 hover:bg-slate-800 hover:text-white flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <RefreshCw className={`w-4 h-4 text-brand-400 ${syncing ? 'animate-spin' : ''}`} />
                        <span className="flex-1">مزامنة الآن</span>
                      </button>
                      <button
                        onClick={openSyncSheet}
                        className="w-full px-4 py-2.5 text-right text-sm text-slate-300 hover:bg-slate-800 hover:text-white flex items-center gap-2"
                        title="فتح ورقة Google Sheets المرتبطة في النظام في تبويب جديد"
                      >
                        <ExternalLink className="w-4 h-4 text-emerald-400" />
                        <span>فتح ورقة البيانات 📊</span>
                      </button>
                      <div className="px-3 py-2.5 border-t border-slate-800 mt-1">
                        <label className="block text-[11px] font-bold text-slate-500 mb-1.5">
                          نوع المزامنة التلقائية
                        </label>
                        <select
                          value={syncDir}
                          onChange={e => changeSyncDirection(e.target.value)}
                          title="نوع المزامنة — يتغير فوراً ويُرفع للسحابة"
                          className="w-full px-2.5 py-2 bg-slate-800/80 border border-slate-700 rounded-xl text-xs text-slate-200 font-medium transition-all cursor-pointer focus:outline-none focus:border-brand-500"
                        >
                          <option value="off">⏸ مزامنة متوقفة</option>
                          <option value="export">📤 تصدير فقط</option>
                          <option value="import">📥 استيراد فقط</option>
                          <option value="both">🔄 بالاتجاهين</option>
                        </select>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
              ) : null}

              {canSyncOrTest(role) ? (
                <button
                  onClick={handleSandboxToggle}
                  title="وضع الاختبار (حقل التجارب) — تجربة النظام بأمان دون أي مساس بالبيانات الحقيقية"
                  className={`h-9 px-3 flex items-center gap-2 rounded-xl border text-sm font-medium transition-all shrink-0 whitespace-nowrap cursor-pointer ${
                    sandboxActive
                      ? 'bg-amber-600 border-amber-500 text-white'
                      : 'bg-slate-800/80 border-slate-700 text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  <FlaskConical className="w-4 h-4 text-amber-400" />
                  <span className="hidden sm:inline">{sandboxActive ? 'إنهاء الاختبار' : 'وضع الاختبار'}</span>
                </button>
              ) : null}

              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                title="تبديل المظهر"
                className="w-9 h-9 grid place-items-center rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                <ThemeIcon className="w-4 h-4" />
              </button>
              {user ? (
                <div className="relative">
                  <button
                    onClick={() => setMenuOpen(o => !o)}
                    title="قائمة الحساب"
                    className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-800/70 transition-all"
                  >
                    <span className="w-9 h-9 grid place-items-center rounded-full bg-brand-500/15 text-brand-300 font-bold text-sm shrink-0">
                      {(user.name || '?').charAt(0)}
                    </span>
                    <div className="hidden sm:block text-right leading-tight">
                      <div className="text-sm font-semibold text-white">{user.name}</div>
                      <div className="text-[11px] text-slate-500">{user.email}</div>
                    </div>
                    <Badge variant={user.role === 'admin' ? 'brand' : 'info'}>{user.role}</Badge>
                    <ChevronDown
                      className={`w-4 h-4 text-slate-400 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {menuOpen ? (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                      <div className="absolute left-0 mt-2 w-60 z-40 rounded-xl border border-slate-800 bg-slate-900 shadow-2xl p-1.5 space-y-1">
                        {user.role === 'admin' ? (
                          <button
                            onClick={() => {
                              setMenuOpen(false)
                              openAdminPasswordModal(
                                'أدخل كلمة سر المدير للوصول إلى إعدادات الربط والسحابة (Firebase / OAuth / Refresh Token / Spreadsheet).',
                                () => useUiStore.getState().openSyncCloudModal()
                              )
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-800 transition-all"
                          >
                            <CloudCog className="w-4 h-4 text-brand-400" />
                            <span className="flex-1 text-right">إعدادات الربط والسحابة 🔐</span>
                          </button>
                        ) : null}
                        <button
                          onClick={() => {
                            setMenuOpen(false)
                            openChangePasswordModal()
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-800 transition-all"
                        >
                          <KeyRound className="w-4 h-4 text-amber-400" />
                          <span className="flex-1 text-right">تغيير كلمة السر</span>
                        </button>
                        <div className="my-1 border-t border-slate-800" />
                        <button
                          onClick={() => {
                            setMenuOpen(false)
                            logout()
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-rose-300 hover:bg-rose-500/10 transition-all"
                        >
                          <LogOut className="w-4 h-4" />
                          <span className="flex-1 text-right">تسجيل الخروج</span>
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : (
                <Badge variant="neutral">زائر</Badge>
              )}
            </div>
          </header>

          <main className="p-6">
            <View onNavigate={setActive} />
          </main>
        </div>
      </div>

      {/* قائمة التنقل على الجوال (Drawer) */}
      <div className={`fixed inset-0 z-50 md:hidden ${mobileNavOpen ? '' : 'pointer-events-none'}`} aria-hidden={!mobileNavOpen}>
        <div
          className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${mobileNavOpen ? 'opacity-100' : 'opacity-0'}`}
          onClick={() => setMobileNavOpen(false)}
        />
        <div
          role="dialog"
          aria-label="قائمة التنقل"
          className={`absolute top-0 right-0 h-full w-72 max-w-[85vw] bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col transition-transform duration-300 ${mobileNavOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <div className="p-4 flex items-center justify-between border-b border-slate-800">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 grid place-items-center rounded-xl bg-brand-500/15 text-brand-400 shrink-0 overflow-hidden">
                {logo ? (
                  <img src={logo} alt={appName} className="w-full h-full object-contain" />
                ) : (
                  <Store className="w-5 h-5" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-white truncate">{appName}</span>
                <span className="block text-[11px] text-slate-500 truncate">نظام إدارة المحل</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              title="إغلاق القائمة"
              aria-label="إغلاق القائمة"
              className="w-9 h-9 grid place-items-center rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto p-3 space-y-1">
            {items.map(item => {
              const Icon = item.icon
              const isActive = item.id === active
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActive(item.id)
                    setMobileNavOpen(false)
                  }}
                  className={[
                    'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm transition-all cursor-pointer',
                    isActive
                      ? 'bg-brand-500/15 text-brand-300 font-semibold'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
                  ].join(' ')}
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-right">{item.label}</span>
                </button>
              )
            })}
          </nav>
          <div className="p-3 border-t border-slate-800">
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false)
                logout()
              }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm text-rose-300 hover:bg-rose-500/10 transition-all cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span className="flex-1 text-right">تسجيل الخروج</span>
            </button>
          </div>
        </div>
      </div>

      {/* V3.41 — زر مساعد AI العائم (Floating Action Button): مثبّت في الزاوية
          السفلية اليسرى، ظاهر من أي صفحة، وتحت طبقة النوافذ (z-40 < z-50)
          كي لا يطفو فوق أي نافذة منبثقة. V3.43 — المدير فقط يتحدث مع AI. */}
      {canUseAi(role) ? (
        <button
          type="button"
          onClick={() => useUiStore.getState().openAiAssistantModal()}
          title="مساعد AI — ملخصات واقتراحات سريعة"
          aria-label="مساعد AI — ملخصات واقتراحات سريعة"
          className="fixed bottom-5 left-5 z-40 flex items-center gap-1.5 h-14 pl-4 pr-3.5 rounded-full bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-600/40 hover:from-violet-500 hover:to-fuchsia-500 hover:shadow-violet-500/50 active:scale-95 transition-all cursor-pointer"
        >
          <Sparkles className="w-5 h-5 shrink-0" />
          <span className="text-sm font-bold">AI</span>
        </button>
      ) : null}
    </div>
  )
}

export default AppShell
