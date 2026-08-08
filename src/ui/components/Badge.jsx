// =============================================================================
// ui/components/Badge.jsx — شارة/وسم بنمط .badge / .status-chip القديم
// -----------------------------------------------------------------------------
// الأنماط تعتمد على الثيم (CSS vars) عبر class .badge + ألوان حسب الحالة.
// =============================================================================
const VARIANTS = {
  brand: 'border-brand-500/30 text-brand-300 bg-brand-500/15',
  success: 'border-emerald-500/30 text-emerald-300 bg-emerald-500/15',
  error: 'border-rose-500/30 text-rose-300 bg-rose-500/15',
  warning: 'border-amber-500/30 text-amber-300 bg-amber-500/15',
  info: 'border-sky-500/30 text-sky-300 bg-sky-500/15',
  purple: 'border-purple-500/30 text-purple-300 bg-purple-500/15',
  neutral: 'border-slate-600/50 text-slate-300 bg-slate-700/40',
}

function Badge({ variant = 'neutral', className = '', children, ...rest }) {
  return (
    <span
      className={['badge inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold whitespace-nowrap', VARIANTS[variant] || VARIANTS.neutral, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </span>
  )
}

export default Badge
