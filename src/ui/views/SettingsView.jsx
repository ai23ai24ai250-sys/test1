// =============================================================================
// ui/views/SettingsView.jsx — نسخة React من renderSettingsView + setupSettingsEvents
// (settings-view.js) — Phase 11
// -----------------------------------------------------------------------------
// صفحة الإعدادات العامة فقط (بدون كلمة سر): اسم النظام، الشعار (رابط/رفع صورة)،
// اللون الأساسي (ألوان جاهزة + لون مخصص)، ومظهر النظام (8 ثيمات). الحفظ عبر
// settingsStore.save (تطبيق + كتابة + نسخة سحابية) مع إشعار المزامنة. إعدادات
// الربط والسحابة 🔐 تبقى من قائمة الحساب (نافذة legacy openSyncCloudModal).
// =============================================================================
import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Palette, Lock } from 'lucide-react'
import Button from '../components/Button.jsx'
import Input from '../components/Input.jsx'
import Select from '../components/Select.jsx'
import { useSettingsStore } from '@/state/settingsStore'
import { useAuthStore } from '@/state/authStore'
import { showToast } from '../components/toastStore.js'

// خيارات الثيمات (القيمة → التسمية + اللون المميز الذي يُطبَّق فورياً).
const THEME_META = {
  dark: { label: 'داكن', accent: '#0284c7' },
  light: { label: 'فاتح', accent: '#0284c7' },
  ocean: { label: 'محيطي', accent: '#06b6d4' },
  emerald: { label: 'زمردي', accent: '#10b981' },
  royal: { label: 'ملكي', accent: '#8b5cf6' },
  coffee: { label: 'قهوة', accent: '#d97706' },
  'luxury-gold': { label: 'ذهبي فاخر', accent: '#d4af37' },
  graphite: { label: 'جرافيت', accent: '#8b8f9a' },
}

const THEME_OPTIONS = [
  { value: 'dark', label: '🌙 داكن (افتراضي)' },
  { value: 'light', label: '☀️ فاتح' },
  { value: 'ocean', label: '🌊 محيطي' },
  { value: 'emerald', label: '💎 زمردي' },
  { value: 'royal', label: '👑 ملكي' },
  { value: 'coffee', label: '☕ قهوة' },
  { value: 'luxury-gold', label: '✨ ذهبي فاخر' },
  { value: 'graphite', label: '⚫ جرافيت' },
]

const PRESET_COLORS = ['#0284c7', '#0ea5e9', '#7c3aed', '#16a34a', '#dc2626', '#f59e0b', '#db2777', '#0f172a']

const DEFAULT_SETTINGS = {
  appName: 'علاء الدين',
  tagline: 'للبطاطين والمفروشات',
  logo: '2.jpg',
  primaryColor: '#0284c7',
  theme: 'dark',
}

// تصغير صور الشعار قبل الحفظ — dataURL صغير (≤160px) يمنع تجاوز سعة localStorage
// التي كانت تُفشل الحفظ بصمت فيظهر وكأن الإعدادات «ترجع» بعد إعادة الفتح.
const MAX_LOGO_SIZE = 160

function readLogoFile(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_LOGO_SIZE / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve('')
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve('')
    }
    img.src = url
  })
}

function SettingsView() {
  const authed = useAuthStore(s => s.authed)

  const initial = useSettingsStore.getState()
  const [appName, setAppName] = useState(initial.appName)
  const [logo, setLogo] = useState(initial.logo)
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor)
  const [theme, setTheme] = useState(initial.theme)
  const [saving, setSaving] = useState(false)

  // سحب نسخة الإعدادات من السحابة عند فتح الشاشة (تغييرات متصفح آخر).
  useEffect(() => {
    let mounted = true
    const hydrate = () => {
      if (window.generalSettings && typeof window.generalSettings.hydrateFromCloud === 'function') {
        window.generalSettings
          .hydrateFromCloud()
          .then(adopted => {
            if (!adopted || !mounted) return
            const d = useSettingsStore.getState()
            setAppName(d.appName)
            setLogo(d.logo)
            setPrimaryColor(d.primaryColor)
            setTheme(d.theme)
          })
          .catch(() => {})
      }
    }
    hydrate()
    return () => {
      mounted = false
    }
  }, [])

  if (!authed) {
    return (
      <div className="p-8 text-center bg-slate-900 border border-slate-800 rounded-2xl animate-fadeIn">
        <Lock className="w-16 h-16 text-rose-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">سجّل الدخول أولاً</h2>
        <p className="text-sm text-slate-400">
          الإعدادات العامة متاحة بعد تسجيل الدخول — وإعدادات الربط والسحابة 🔐 من قائمة الحساب للمدير فقط
        </p>
      </div>
    )
  }

  const saveGeneral = extra => {
    const current = useSettingsStore.getState()
    const obj = Object.assign(
      {
        appName: appName.trim() || current.appName,
        logo: logo.trim() || current.logo,
        primaryColor,
        theme,
      },
      extra || {}
    )
    const saved = useSettingsStore.getState().save(obj)
    // مزامنة النموذج مع ما حُفظ فعلاً (بعد تطبيع الثيم/اللون في الخدمة) —
    // فيبقى الحقل معروضاً للقيمة المحفوظة تماماً ولا «يرتد» لقيمة قديمة.
    setAppName(saved.appName)
    setLogo(saved.logo)
    setPrimaryColor(saved.primaryColor)
    setTheme(saved.theme)
    showToast('✓ تم حفظ الإعدادات العامة محلياً', 'success')
    if (window.generalSettings && typeof window.generalSettings.pushToCloud === 'function') {
      setSaving(true)
      window.generalSettings
        .pushToCloud()
        .then(ok => {
          showToast(ok ? '☁️ وتزامنت مع السحابة ✓' : '⚠️ سجّل الدخول لرفع الإعدادات للسحابة', ok ? 'success' : 'warning')
        })
        .catch(err => {
          showToast('⚠️ حُفظت محلياً فقط — تعذر رفع السحابة: ' + (err && err.message ? err.message : String(err)), 'error')
        })
        .finally(() => setSaving(false))
    }
  }

  const pickColor = (c, opts = {}) => {
    setPrimaryColor(c)
    useSettingsStore.getState().setPrimary(c)
    if (!opts.silent) showToast('✓ تم تغيير اللون الأساسي', 'info', 1500)
  }

  const changeTheme = value => {
    const meta = THEME_META[value] || THEME_META.dark
    setPrimaryColor(meta.accent)
    useSettingsStore.getState().setPrimary(meta.accent)
    saveGeneral({ theme: value, primaryColor: meta.accent })
    showToast(`✓ تم التبديل إلى ثيم ${meta.label}`, 'success')
  }

  const reset = () => {
    if (!window.confirm('هل أنت متأكد من استعادة الإعدادات الافتراضية؟ سيتم التراجع عن جميع التعديلات الحالية.')) return
    useSettingsStore.getState().save(DEFAULT_SETTINGS)
    setAppName(DEFAULT_SETTINGS.appName)
    setLogo(DEFAULT_SETTINGS.logo)
    setPrimaryColor(DEFAULT_SETTINGS.primaryColor)
    setTheme(DEFAULT_SETTINGS.theme)
    showToast('تم استعادة الإعدادات الافتراضية', 'success')
  }

  const onLogoFile = async e => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const dataUrl = await readLogoFile(f)
    if (dataUrl) setLogo(dataUrl)
    e.target.value = ''
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="bg-slate-900/60 p-6 rounded-2xl border border-slate-800">
        <h1 className="text-2xl font-bold text-white mb-1 flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-slate-300" />
          <span>إعدادات النظام</span>
        </h1>
        <p className="text-sm text-slate-400">
          الإعدادات العامة (بدون كلمة سر) — أما إعدادات الربط والسحابة 🔐 فهي من قائمة الحساب، للمدير فقط.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg space-y-4">
        <div className="border-b border-slate-800 pb-3">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Palette className="w-5 h-5 text-brand-400" />
            <span>إعدادات النظام العامة</span>
          </h3>
          <p className="text-xs text-slate-500 mt-1">متاحة مباشرة دون كلمة سر — تُحفظ في هذا المتصفح وتُزامن مع السحابة تلقائياً</p>
        </div>

        <Input label="اسم النظام / التطبيق" value={appName} onChange={setAppName} placeholder="علاء الدين" />

        <div>
          <label className="block font-bold text-slate-300 text-xs mb-1.5">الشعار</label>
          <div className="flex items-center gap-3 flex-wrap">
            <img
              src={logo || '2.jpg'}
              alt="logo"
              className="w-14 h-14 rounded-xl border border-slate-700 object-contain bg-slate-800 shrink-0"
            />
            <input
              type="text"
              value={logo}
              onChange={e => setLogo(e.target.value)}
              placeholder="رابط صورة (URL) أو اختر ملفاً…"
              className="flex-1 min-w-[180px] px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-brand-500"
            />
            <label className="px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold rounded-xl cursor-pointer shadow-md transition-all shrink-0">
              رفع صورة
              <input type="file" accept="image/*" className="hidden" onChange={onLogoFile} />
            </label>
          </div>
        </div>

        <div>
          <label className="block font-bold text-slate-300 text-xs mb-1.5">اللون الأساسي (Theme Accent)</label>
          <div className="flex items-center gap-2 flex-wrap">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                type="button"
                data-color={c}
                onClick={() => pickColor(c)}
                title={c}
                style={{ background: c, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)' }}
                className="w-8 h-8 rounded-lg border-2 border-transparent hover:scale-110 transition-all cursor-pointer"
              />
            ))}
            <input
              type="color"
              value={primaryColor}
              onChange={e => pickColor(e.target.value, { silent: true })}
              className="w-10 h-10 rounded-lg cursor-pointer bg-transparent border border-slate-700 p-0.5"
              title="لون مخصص"
            />
            <span className="text-[11px] font-mono text-slate-400">{primaryColor}</span>
          </div>
        </div>

        <Select label="مظهر النظام (الثيم)" value={theme} onChange={changeTheme} options={THEME_OPTIONS} />

        <div className="pt-2 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => saveGeneral()} loading={saving} disabled={saving}>
            {saving ? 'جارٍ المزامنة مع السحابة...' : 'حفظ الإعدادات العامة'}
          </Button>
          <Button variant="secondary" onClick={reset}>
            استعادة الافتراضي
          </Button>
        </div>
      </div>
    </div>
  )
}

export default SettingsView
