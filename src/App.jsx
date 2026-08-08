// Phase 3 — هيكل التطبيق: بوابة الجلسة (LoginView) ثم AppShell.
// يُهيّئ المخازن (المظهر/الجلسة) عند الإقلاع؛ البيانات تمر عبر الجسر (compat).
import { useEffect } from 'react'
import AppShell from '@/ui/layout/AppShell'
import LoginView from '@/ui/views/LoginView'
import ToastContainer from '@/ui/components/ToastContainer'
import { useSettingsStore } from '@/state/settingsStore'
import { useAuthStore } from '@/state/authStore'
import { initDB } from '@/services/db.js'

function App() {
  const user = useAuthStore(s => s.user)

  useEffect(() => {
    // V3.40 — boot the storage layer exactly like the legacy app: pre-hydrate
    // the local mirrors, install the auth gate, and start realtime Firestore
    // sync IMMEDIATELY when a session is restored. A page reload must never
    // serve a stale localStorage cache while the cloud holds newer data.
    initDB()
    useSettingsStore.getState().hydrate()
    useAuthStore.getState().restore()
  }, [])

  // V3.17 — بعد تسجيل الدخول تُسحب نسخة الإعدادات السحابية (الاسم/الثيم/اللون)
  // من جهاز آخر لتُطبّق فوراً، تماماً مثل hydrateGeneralSettings في legacy.
  useEffect(() => {
    if (user) useSettingsStore.getState().hydrate()
  }, [user])

  return (
    <>
      {user ? <AppShell /> : <LoginView />}
      <ToastContainer />
    </>
  )
}

export default App
