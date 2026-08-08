// =============================================================================
// ui/modals/SupplierReturnModal.jsx — نافذة تسجيل مرتجع مشتريات — نسخة React من
// window.openSupplierReturnModal (js/components/suppliers-view.js)
// -----------------------------------------------------------------------------
// تسجيل مرتجع لمورد/مصنع: منتجات مرتجعة (مقتصرة على منتجات المورد المحدد —
// V3.19) بكميات وأسعار وحدات، مع نوع الاسترداد (تخفيض المديونية / استرداد
// نقدي) وإجمالي يُحدَّث فورياً. الحفظ عبر window.createSupplierReturn
// (يخصم الكميات من المخزون ويخفض رصيد المورد آلياً).
// =============================================================================
import { useState, useMemo } from 'react'
import { Undo2, Plus, Trash2, CheckCircle2 } from 'lucide-react'
import Modal from '../components/Modal.jsx'
import Input from '../components/Input.jsx'
import Select from '../components/Select.jsx'
import Button from '../components/Button.jsx'
import { useUiStore } from '../state/uiStore.js'
import { showToast } from '../components/toastStore.js'
import { formatCurrency } from '@/utils/formatters'

function supplierProducts(supplierId, suppliers, products) {
  if (!supplierId) return products
  const sup = suppliers.find(s => s.id === supplierId)
  const name = sup ? sup.name : ''
  return products.filter(
    p => p.supplierId === supplierId || (p.supplierName && name && p.supplierName === name)
  )
}

function SupplierReturnModal() {
  const open = useUiStore(s => s.supplierReturnModal.open)
  if (!open) return null
  return <SupplierReturnModalInner />
}

function SupplierReturnModalInner() {
  const { supplierId: defaultSupplierId, onDone } = useUiStore(s => s.supplierReturnModal)
  const close = useUiStore(s => s.closeSupplierReturnModal)

  const [suppliers] = useState(() => (window.getSuppliers ? window.getSuppliers() : []))
  const [products] = useState(() => (window.getProducts ? window.getProducts() : []))

  const [supplierId, setSupplierId] = useState(
    () => (defaultSupplierId && suppliers.some(s => s.id === defaultSupplierId) ? defaultSupplierId : '')
  )
  const [refundType, setRefundType] = useState('debt')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const productsForSupplier = supplierId => supplierProducts(supplierId, suppliers, products)

  const firstProduct = () => productsForSupplier(supplierId)[0] || products[0] || null

  const [lineItems, setLineItems] = useState(() => {
    const first = firstProduct()
    return [{ productId: first ? first.id : '', quantity: 1, unitCost: first ? Number(first.purchasePrice) || 0 : 0 }]
  })

  const filteredProducts = useMemo(
    () => supplierProducts(supplierId, suppliers, products),
    [supplierId, suppliers, products]
  )

  const totalValue = useMemo(
    () => lineItems.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unitCost) || 0), 0),
    [lineItems]
  )

  const handleSupplierChange = id => {
    setSupplierId(id)
    const first = productsForSupplier(id)[0] || products[0] || null
    setLineItems([
      { productId: first ? first.id : '', quantity: 1, unitCost: first ? Number(first.purchasePrice) || 0 : 0 },
    ])
  }

  const updateRow = (idx, patch) =>
    setLineItems(items => items.map((it, i) => (i === idx ? { ...it, ...patch } : it)))

  const handleProductChange = (idx, pid) => {
    const p = products.find(pr => pr.id === pid)
    updateRow(idx, { productId: pid, unitCost: p ? Number(p.purchasePrice) || 0 : 0 })
  }

  const addRow = () => {
    const first = firstProduct()
    setLineItems(items => [
      ...items,
      { productId: first ? first.id : '', quantity: 1, unitCost: first ? Number(first.purchasePrice) || 0 : 0 },
    ])
  }

  const handleSubmit = e => {
    e.preventDefault()
    if (submitting) return
    if (!supplierId) {
      showToast('يرجى اختيار المورد / المصنع أولاً', 'error')
      return
    }

    const items = lineItems
      .filter(it => it.productId && Number(it.quantity) > 0)
      .map(it => {
        const prd = products.find(p => p.id === it.productId)
        return {
          productId: it.productId,
          productName: prd ? prd.name : '',
          quantity: Number(it.quantity),
          unitCost: Math.max(0, Number(it.unitCost) || 0),
        }
      })

    if (items.length === 0) {
      showToast('يرجى إدخال منتج واحد على الأقل بكمية صحيحة أكبر من الصفر', 'error')
      return
    }

    // V3.19 — Guard: when a supplier is selected, every returned product must
    // actually belong to that supplier (or be unassigned), never another's.
    const foreign = items.find(i => {
      const prd = products.find(p => p.id === i.productId)
      return prd && prd.supplierId && prd.supplierId !== supplierId
    })
    if (foreign) {
      showToast('المنتج المحدد لا يخص هذا المورد — اختر منتجاً من قائمة المورد المحدد', 'error')
      return
    }

    const supplier = suppliers.find(s => s.id === supplierId)
    setSubmitting(true)
    try {
      const record = window.createSupplierReturn({
        supplierId,
        supplierName: supplier ? supplier.name : '',
        items,
        refundType,
        notes,
      })
      showToast(
        `تم تسجيل المرتجع ${record.id} بقيمة ${formatCurrency(record.totalValue)} وتحديث المخزون وحساب المورد بنجاح`,
        'success'
      )
      close()
      if (typeof onDone === 'function') onDone()
    } catch (err) {
      showToast(err.message || 'حدث خطأ أثناء تسجيل المرتجع', 'error')
      setSubmitting(false)
    }
  }

  return (
    <Modal open onClose={close} title="↩️ تسجيل مرتجع مشتريات لمورد / مصنع" icon={Undo2} maxWidth="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="المورد / المصنع المسترجع إليه *"
          value={supplierId}
          onChange={handleSupplierChange}
          options={[
            { value: '', label: '-- اختر المورد / المصنع --' },
            ...suppliers.map(s => ({ value: s.id, label: `${s.name} — الرصيد المستحق له: ${formatCurrency(s.remainingBalance)}` })),
          ]}
        />

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-bold text-slate-300">المنتجات المرتجعة للمورد *</label>
            <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={addRow} className="text-amber-300">
              إضافة منتج
            </Button>
          </div>

          <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
            {lineItems.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">لا توجد منتجات — أضف صفاً واحداً على الأقل</p>
            ) : (
              lineItems.map((item, idx) => (
                <div
                  key={`${item.productId}-${idx}`}
                  className="return-row grid grid-cols-12 gap-3 p-3 bg-slate-800/60 rounded-xl border border-slate-700/80 items-center"
                >
                  <div className="col-span-12 sm:col-span-5">
                    <select
                      value={item.productId}
                      onChange={e => handleProductChange(idx, e.target.value)}
                      className="return-product-select w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-orange-500"
                    >
                      <option value="">اختر المنتج...</option>
                      {filteredProducts.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} (المخزون: {p.stock ?? 0})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-6 sm:col-span-3">
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={e => updateRow(idx, { quantity: Number(e.target.value) || 1 })}
                      title="الكمية المرتجعة"
                      className="return-qty w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white num-font text-center focus:outline-none focus:border-orange-500"
                    />
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitCost}
                      onChange={e => updateRow(idx, { unitCost: Number(e.target.value) || 0 })}
                      title="سعر الوحدة المسترجع"
                      className="return-cost w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white num-font text-center focus:outline-none focus:border-orange-500"
                    />
                  </div>
                  <div className="col-span-1 flex justify-end">
                    {lineItems.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setLineItems(items => items.filter((_, i) => i !== idx))}
                        className="return-remove-row text-rose-400 hover:text-rose-300 p-1.5 hover:bg-rose-950/40 rounded-lg transition-all"
                        aria-label="حذف الصف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="p-3 bg-orange-950/30 rounded-xl border border-orange-800/40 flex justify-between items-center text-sm">
          <span className="text-orange-300 font-bold">إجمالي قيمة المرتجع (يخصم من المخزون والمورد):</span>
          <span className="text-lg font-extrabold text-orange-400 num-font">{formatCurrency(totalValue)}</span>
        </div>

        <Select
          label="نوع الاسترداد *"
          value={refundType}
          onChange={setRefundType}
          options={[
            { value: 'debt', label: 'تخفيض المديونية (خصم قيمة المرتجع من رصيد المورد آلياً)' },
            { value: 'cash', label: 'استرداد نقدي (استلام كاش من المورد + قيد استرداد بالخزينة)' },
          ]}
        />

        <Input
          label="سبب المرتجع / ملاحظات"
          value={notes}
          onChange={setNotes}
          placeholder="مثال: عيوب صناعة / جودة غير مطابقة للمواصفات"
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={close}>إلغاء</Button>
          <Button type="submit" variant="primary" icon={CheckCircle2} loading={submitting} disabled={submitting} className="px-6">
            {submitting ? 'جاري تسجيل المرتجع...' : 'تسجيل المرتجع وخصم الكميات من المخزن'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export default SupplierReturnModal
