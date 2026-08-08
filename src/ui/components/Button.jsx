// =============================================================================
// ui/components/Button.jsx — زر بنمط النظام (أنماط Tailwind مطابقة للقديم)
// -----------------------------------------------------------------------------
// الأنماط منقولة من العلامات المستخدمة في js/components (primary/خطر/ثانوي).
// يدعم أيقونة lucide-react، تحميل، تعطيل، وتمرير باقي الخصائص للزر.
// =============================================================================
import { Loader2 } from 'lucide-react'

const BASE =
  'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-150 cursor-pointer select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-50 disabled:cursor-not-allowed'

const VARIANTS = {
  primary:
    'bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-white shadow-lg shadow-brand-600/30 hover:shadow-brand-500/50',
  secondary:
    'bg-slate-800/80 border border-slate-700 text-slate-200 hover:bg-slate-700/80 hover:text-white',
  danger:
    'bg-gradient-to-r from-rose-700 to-rose-600 hover:from-rose-600 hover:to-rose-500 text-white shadow-lg shadow-rose-700/30',
  success:
    'bg-gradient-to-r from-emerald-700 to-emerald-600 hover:from-emerald-600 hover:to-emerald-500 text-white shadow-lg shadow-emerald-700/30',
  ghost:
    'text-slate-400 hover:text-white hover:bg-slate-800/80',
}

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-5 py-3 text-base',
}

function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  icon: Icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  className = '',
  onClick,
  ...rest
}) {
  const isDisabled = disabled || loading
  return (
    <button
      type={type}
      className={[
        BASE,
        VARIANTS[variant] || VARIANTS.primary,
        SIZES[size] || SIZES.md,
        fullWidth ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={isDisabled}
      onClick={onClick}
      {...rest}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : Icon ? <Icon className="w-4 h-4 shrink-0" /> : null}
      {children}
    </button>
  )
}

export default Button
