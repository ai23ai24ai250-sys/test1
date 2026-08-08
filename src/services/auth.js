/**
 * Authentication & Role-Based User Management Module — → React (Phase 2 port)
 * ============================================================================
 * Faithful ES-module port of js/auth.js. Connected to Firebase Auth & Cloud
 * Firestore Users Collection. Logic is identical to the legacy reference; the
 * only changes are the module wrapper + `export` + importing getCairoFormattedDate
 * and generateAutoId from the ported utils instead of window.
 */
import { generateAutoId, getCairoFormattedDate } from '../utils/formatters.js';

const AUTH_STORAGE_KEY = 'bms_user_session';

// Clean Slate Admin Primary Account
const INITIAL_USERS = [
  { id: 'USR-1001', name: 'المدير العام', email: 'admin@store.com', role: 'admin', createdAt: '2026-07-01T10:00:00Z' }
];

// Purge any legacy persistent sessions from localStorage so login is ALWAYS enforced on launch
if (typeof window !== 'undefined') localStorage.removeItem(AUTH_STORAGE_KEY);

export function getUsers() {
  const users = window.getCollection(window.STORAGE_KEYS.USER);
  return (users && users.length > 0) ? users : INITIAL_USERS;
}

// 🔒 Null-safe email normalization: a user doc/record may be missing its email
// (incomplete write, partial merge, legacy import). Sanitizing an undefined
// email with .toLowerCase() crashes the whole login/relogin flow with
// "Cannot read properties of undefined (reading 'toLowerCase')", so every email
// comparison must go through this helper.
function _normEmail(value) {
  return ((value || '') + '').trim().toLowerCase();
}

export function getCurrentUser() {
  // The local session is the app's authoritative identity (set by login() only
  // after strict validation against active user accounts).
  const session = sessionStorage.getItem(AUTH_STORAGE_KEY);
  if (session) {
    try {
      const parsed = JSON.parse(session);
      if (parsed && parsed.email) return parsed;
    } catch (parseErr) {
      console.error(parseErr);
    }
  }

  // Fallback: restore identity from a persisted Firebase Auth session, but ONLY
  // when its email still matches an active user document. A stale/deprecated
  // email (e.g. after an account email change) is rejected.
  if (window.auth && window.auth.currentUser) {
    const fbUser = window.auth.currentUser;
    const users = window.getUsers();
    const matched = users.find(u => _normEmail(u.email) === _normEmail(fbUser && fbUser.email));
    if (!matched) return null;
    return {
      email: fbUser.email,
      name: matched.name,
      role: matched.role
    };
  }

  return null;
}

export async function login(email, password) {
  const cleanEmail = _normEmail(email);
  const cleanPassword = (password || '').trim();

  if (!cleanEmail || !cleanPassword) {
    throw new Error('يرجى إدخال البريد الإلكتروني وكلمة المرور');
  }

  // 🔒 STRICT validation against active user accounts (null-safe email compare).
  // On a fresh device the local users list may hold only the seed admin until
  // the first cloud sync; a real Firebase Auth credential is then accepted and
  // the session is minted from the cloud-synced record below.
  let user = window.getUsers().find(u => _normEmail(u.email) === cleanEmail);

  // Local password gate first: instant feedback, no cloud latency on typos.
  if (user && user.password && user.password.trim() !== cleanPassword) {
    throw new Error('كلمة المرور غير صحيحة');
  }

  if (window.auth) {
    window._pendingAuth = true;
    // 🔌 V3.28 — ONLINE vs OFFLINE login gate. When the browser reports it is
    // online, a session is ONLY minted from a real Firebase Auth user: the old
    // silent fallback to a local-only seed session left the dashboard empty on
    // fresh browsers (mismatched projectId / rules / wrong cloud password).
    // Offline keeps the strict local fallback so the app still works without
    // the network.
    const online = (typeof navigator === 'undefined') || (navigator.onLine !== false);
    let authErr = null;
    try {
      // ✅ Await the real Firebase sign-in so onAuthStateChanged settles with a
      //    non-null user BEFORE any render / route-guard runs. This removes the
      //    relogin race (permission toasts + stale role/email sanitization) and
      //    lets a real cloud credential mint a session even when the local
      //    users list on THIS device hasn't synced yet (multi-device login).
      await window.auth.signInWithEmailAndPassword(cleanEmail, cleanPassword);
      if (window.waitForFirebaseAuth) await window.waitForFirebaseAuth();
    } catch (err) {
      authErr = err;
    } finally {
      window._pendingAuth = false;
    }

    // 🔒 ONLINE: no silent local-only session. If Firebase Auth failed OR the
    //    auth gate never confirmed a real user (_authUser === null), the login
    //    MUST fail with an explicit cloud error instead of a fake empty state.
    //    The REAL Firebase error (code + message) is surfaced so the operator can
    //    tell "wrong password" from "no such account in Firebase Auth" from
    //    "project/config mismatch" instead of guessing.
    if (authErr || !window._authUser) {
      const realReason = authErr ? (authErr.message || authErr.code || String(authErr)) : '';
      if (online) {
        throw new Error(
          'فشل تسجيل الدخول إلى السحابة - تحقق من بيانات الحساب وإعدادات الربط' +
          (realReason ? (' [' + realReason + ']') : '')
        );
      }
      // OFFLINE / blocked cloud: keep the strict LOCAL validation result as the
      // fallback (session still works, cloud sync is skipped until reconnect).
      if (!user) {
        throw new Error(realReason || 'فشل تسجيل الدخول إلى السحابة');
      }
    }

    // 🛰️ CLOUD-FIRST: after successful authentication, pull Firestore as the
    //    single source of truth so every device/browser converges to the exact
    //    same data before the dashboard is rendered. A failed fetch never
    //    blocks login — the local snapshot stays usable offline.
    try {
      window.startFirestoreSync();
      await window.fetchAllFromFirestore(true);
    } catch { /* local snapshot remains authoritative offline */ }

    // Re-resolve the account from the (now cloud-synced) users collection so a
    // role/name changed on another device is honored immediately.
    const synced = window.getUsers().find(u => _normEmail(u.email) === cleanEmail);
    if (synced && synced.id) user = synced;
  }

  if (!user) {
    throw new Error('حساب المستخدم غير موجود في النظام');
  }

  const sessionUser = {
    id: user.id,
    email: cleanEmail,
    name: user.name,
    role: user.role,
    loginTime: getCairoFormattedDate()
  };

  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionUser));

  return sessionUser;
}

export function logout() {
  if (window.auth) {
    window.auth.signOut().catch(err => console.error(err));
  }
  // 🔒 Tear down every realtime Firestore listener the moment the session ends
  // (idempotent: the auth gate also unsubscribes on the signOut() event).
  if (window.stopFirestoreSync) window.stopFirestoreSync();
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function isAuthenticated() {
  return !!getCurrentUser();
}

export function isAdmin() {
  const user = getCurrentUser();
  return user && user.role === 'admin';
}

/**
 * Strict Admin Password Verification Helper
 * Returns strict boolean (true/false)
 * Uses Firestore-stored password as source of truth only
 */
export function verifyAdminPassword(enteredPassword) {
  if (!enteredPassword || typeof enteredPassword !== 'string' || !enteredPassword.trim()) {
    return false;
  }

  const currentUser = getCurrentUser();
  if (!currentUser) return false;

  const cleanInput = enteredPassword.trim();
  const usersList = window.getUsers();
  const activeUserDoc = usersList.find(u => _normEmail(u.email) === _normEmail(currentUser.email));

  // Check against password stored in Firestore users document
  if (activeUserDoc && activeUserDoc.password && activeUserDoc.password.trim()) {
    return activeUserDoc.password.trim() === cleanInput;
  }

  // 🔒 Security: if no password is registered in the users document, NO
  // entered password is accepted. The admin must set a real password first
  // (via updateUserAccount), otherwise an arbitrary non-empty string would
  // unlock every password-protected action.
  return false;
}

/**
 * Whether the current admin has a real password registered in the users
 * document. Callers use this to surface a friendly "set a password first"
 * message instead of a generic wrong-password error.
 */
export function adminPasswordConfigured() {
  const currentUser = getCurrentUser();
  if (!currentUser) return false;
  const usersList = window.getUsers();
  const activeUserDoc = usersList.find(u => _normEmail(u.email) === _normEmail(currentUser.email));
  return !!(activeUserDoc && activeUserDoc.password && activeUserDoc.password.trim());
}

/**
 * Admin User Creation without session overwrite
 * V3.41 — CLOUD AUTH SYNC: besides the Firestore users doc, the account is
 * created in Firebase Authentication (createUserWithEmailAndPassword) so the
 * employee can actually SIGN IN. Before this fix the account existed only in
 * Firestore and every online login failed with auth/invalid-credential, forcing
 * the admin to hand-create the Auth user in the Firebase console.
 */
export async function createNewUserAccount({ name, email, password, role }) {
  if (!isAdmin()) {
    throw new Error('غير مصرح لك بإنشاء حسابات مستخدمين. هذه الصلاحية للمدير فقط');
  }

  const cleanEmail = _normEmail(email);
  const existing = window.getUsers().find(u => _normEmail(u.email) === cleanEmail);
  if (existing) {
    throw new Error('هذا البريد الإلكتروني مسجل بالفعل لمستخدم آخر');
  }

  const cleanPassword = (password || '').trim();
  if (!cleanPassword || cleanPassword.length < 6) {
    throw new Error('كلمة المرور يجب ألا تقل عن 6 أحرف');
  }

  const newUser = {
    id: generateAutoId('USR'),
    name: name.trim(),
    email: cleanEmail,
    password: cleanPassword,
    role: role || 'employee',
    createdAt: getCairoFormattedDate()
  };

  // 🔐 Create the real Firebase Auth account FIRST: a user with no Auth record
  // cannot sign in when online. The Firestore doc is written only after the
  // Auth account exists, so no orphan Firestore record is left behind.
  if (window.auth) {
    try {
      await window.auth.createUserWithEmailAndPassword(cleanEmail, cleanPassword);
    } catch (authErr) {
      const reason = authErr && authErr.message ? authErr.message : String(authErr);
      if (authErr && authErr.code === 'auth/email-already-in-use') {
        throw new Error('هذا البريد الإلكتروني مسجل بالفعل في Firebase Authentication — استخدم بريداً آخر أو احذف الحساب القديم');
      }
      throw new Error('تعذر إنشاء حساب الدخول السحابي: ' + reason);
    }
  }

  return window.addFirestoreDoc(window.STORAGE_KEYS.USER, newUser);
}

/**
 * V3.41 — CLOUD AUTH SYNC helper. Returns a promise that resolves with:
 *   'created'  → a Firebase Auth account did NOT exist and was just created
 *   'updated'  → the Auth account exists and its password was updated
 *   'unchanged'→ no password given / no Auth available (nothing to sync)
 * Used by updateUserAccount (healing old Firestore-only users) and
 * changeOwnPassword (keeping the self Auth password in sync).
 */
function syncAuthCredentials(email, newPassword) {
  const firebase = window.auth;
  if (!firebase || !newPassword) return Promise.resolve('unchanged');
  const clean = _normEmail(email);

  return firebase.fetchSignInMethodsForEmail(clean)
    .then(function (methods) {
      const exists = Array.isArray(methods) && methods.length > 0;
      if (exists) {
        // Can only update the CURRENT user's Auth password from the client SDK;
        // another user's existing Auth account must be reset via the console.
        const cur = firebase.currentUser;
        if (cur && _normEmail(cur.email) === clean) {
          return cur.updatePassword(newPassword).then(function () { return 'updated'; });
        }
        return Promise.resolve('exists-other');
      }
      // No Auth account yet → heal by creating one (exactly what creating the
      // account does). This fixes employees created before the V3.41 sync.
      return firebase.createUserWithEmailAndPassword(clean, newPassword)
        .then(function () { return 'created'; });
    });
}

export async function updateUserAccount(userId, { name, email, password, role }) {
  if (!isAdmin()) {
    throw new Error('غير مصرح لك بتعديل بيانات الحسابات');
  }

  const payload = {
    updatedAt: getCairoFormattedDate()
  };

  let changedEmail = false;
  let oldEmail = '';

  if (name) payload.name = name.trim();

  // 🔒 Main Admin protection: the role of the primary admin account
  // (USR-1001) can never be demoted, even by another admin.
  if (role && userId === 'USR-1001' && role !== 'admin') {
    throw new Error('لا يمكن تغيير صلاحية المدير العام الرئيسي');
  }

  // 🔒 Self-protection: a logged-in admin can never demote their own account.
  if (role && role !== 'admin') {
    const target = window.getUsers().find(u => u.id === userId);
    const currentSession = getCurrentUser();
    if (target && currentSession && _normEmail(target.email) === _normEmail(currentSession.email)) {
      throw new Error('لا يمكن تغيير صلاحية المدير العام الرئيسي');
    }
  }

  if (role) payload.role = role;
  if (password && password.trim().length > 0) {
    payload.password = password.trim();
  }

  // Validate & prepare the email change BEFORE writing anything so we never
  // leave a partial update when the new email collides with another account.
  if (email) {
    const cleanEmail = _normEmail(email);
    const oldUser = window.getUsers().find(u => u.id === userId);
    oldEmail = oldUser ? _normEmail(oldUser.email) : '';

    if (cleanEmail !== oldEmail) {
      const duplicate = window.getUsers().find(u => u.id !== userId && _normEmail(u.email) === cleanEmail);
      if (duplicate) {
        throw new Error('هذا البريد الإلكتروني مسجل بالفعل لمستخدم آخر');
      }
      changedEmail = true;
    }
    payload.email = cleanEmail;
  }

  window.updateFirestoreDoc(window.STORAGE_KEYS.USER, userId, payload);

  // 🔒 EMAIL SYNC: keep authentication strictly in sync so the OLD email can
  // never log in again.
  if (changedEmail) {
    // 1. Remove any legacy/stale user documents still carrying the old email.
    window.getUsers().forEach(u => {
      if (u.id !== userId && _normEmail(u.email) === oldEmail) {
        window.deleteFirestoreDoc(window.STORAGE_KEYS.USER, u.id);
      }
    });

    // 2. If the currently signed-in Firebase Auth account uses the old email,
    //    update it so Firebase Auth accepts ONLY the new email going forward.
    if (window.auth && window.auth.currentUser && _normEmail(window.auth.currentUser.email) === oldEmail) {
      window.auth.currentUser.updateEmail(payload.email).catch(err => {
        console.warn('Firebase Auth email sync note:', err && err.message);
      });
    }
  }

  // 🔐 V3.41 — CLOUD AUTH SYNC: keep the Firebase Auth password in sync with the
  // account record. When the admin resets a password for an OLD Firestore-only
  // user (created before V3.41), this heals the missing Auth account so the
  // employee can sign in again (auth/invalid-credential fix).
  let authSyncResult = 'unchanged';
  const finalEmail = payload.email || oldEmail;
  if (finalEmail && password && password.trim().length > 0) {
    try {
      authSyncResult = await syncAuthCredentials(finalEmail, password.trim());
    } catch (syncErr) {
      console.warn('Firebase Auth credential sync note:', syncErr && syncErr.message);
      authSyncResult = 'failed';
    }
  }

  // 🖥️ SESSION SYNC: if the updated account is the currently logged-in user,
  // refresh the local session (id / name / email / role) so the header profile
  // updates instantly without requiring a page reload or re-login.
  const sessionRaw = sessionStorage.getItem(AUTH_STORAGE_KEY);
  if (sessionRaw) {
    try {
      const sess = JSON.parse(sessionRaw);
      const sessionEmail = _normEmail(sess && sess.email);
      const targetEmail = _normEmail(payload.email || oldEmail || '');
      if (sess && sessionEmail && sessionEmail === targetEmail) {
        sess.id = userId;
        if (payload.name) sess.name = payload.name;
        if (payload.email) sess.email = payload.email;
        if (payload.role) sess.role = payload.role;
        sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sess));
      }
    } catch { /* ignore malformed session */ }
  }

  return { authSync: authSyncResult };
}

/**
 * Self-service password change for the logged-in account.
 * Requires the CURRENT password to be verified against the stored account
 * before the new password is accepted (strict 3-field flow).
 */
export async function changeOwnPassword(currentPassword, newPassword) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    throw new Error('يجب تسجيل الدخول أولاً لتغيير كلمة السر');
  }
  if (!newPassword || newPassword.trim().length < 6) {
    throw new Error('كلمة السر الجديدة يجب ألا تقل عن 6 أحرف');
  }

  const usersList = window.getUsers();
  const activeUser = usersList.find(u => _normEmail(u.email) === _normEmail(currentUser.email));
  if (!activeUser) {
    throw new Error('حساب المستخدم غير موجود في النظام');
  }

  // Verify the current password against the stored account password.
  const hasStoredPassword = !!(activeUser.password && activeUser.password.trim());
  if (hasStoredPassword) {
    if (!currentPassword || !currentPassword.trim()) {
      throw new Error('يرجى إدخال كلمة السر الحالية');
    }
    if (activeUser.password.trim() !== currentPassword.trim()) {
      throw new Error('كلمة السر الحالية غير صحيحة');
    }
  } else if (currentUser.role !== 'admin') {
    // Non-admin accounts must always have a stored password to verify against
    throw new Error('كلمة السر الحالية غير صحيحة');
  }
  // 🔓 No stored password + admin (e.g. the seed admin right after a wipe):
  // allowed to register a NEW password without a "current" one.

  const newPasswordTrimmed = newPassword.trim();

  // 🔒 PERSISTENCE GUARD: `getUsers()` falls back to INITIAL_USERS when the
  // users collection is still empty (fresh device before the first cloud sync).
  // A seed admin record lives ONLY in that fallback — it is NOT a real doc in
  // the collection, so updateFirestoreDoc would silently no-op (findIndex -1)
  // and the password would never persist, leaving adminPasswordConfigured()
  // forever false ("لا توجد كلمة سر مسجلة للمدير" loop). Ensure the record
  // actually exists in the collection before writing; otherwise create it.
  const collection = window.firestoreCache && window.firestoreCache[window.STORAGE_KEYS.USER];
  const inCollection = Array.isArray(collection) && collection.some(u => u && u.id === activeUser.id);

  if (inCollection) {
    window.updateFirestoreDoc(window.STORAGE_KEYS.USER, activeUser.id, {
      password: newPasswordTrimmed,
      updatedAt: getCairoFormattedDate()
    });
  } else {
    window.addFirestoreDoc(window.STORAGE_KEYS.USER, {
      ...activeUser,
      password: newPasswordTrimmed,
      updatedAt: getCairoFormattedDate()
    });
  }

  // 🔐 V3.41 — keep the Firebase Auth password in sync so the NEW password
  // actually signs in (otherwise the online login gate rejects it with
  // auth/invalid-credential and the admin gets locked out of cloud).
  if (window.auth) {
    try {
      await syncAuthCredentials(activeUser.email, newPasswordTrimmed);
    } catch (syncErr) {
      console.warn('Firebase Auth password sync note:', syncErr && syncErr.message);
    }
  }

  return true;
}

export function updateUserRole(userId, newRole) {
  if (!isAdmin()) {
    throw new Error('غير مصرح لك بتعديل الرتب والصلاحيات');
  }
  // 🔒 Main Admin & self-protection: the primary admin account (USR-1001) and
  // the currently logged-in account can never be demoted from any JS action.
  if (userId === 'USR-1001' && newRole !== 'admin') {
    throw new Error('لا يمكن تغيير صلاحية المدير العام الرئيسي');
  }
  if (newRole !== 'admin') {
    const target = window.getUsers().find(u => u.id === userId);
    const currentSession = getCurrentUser();
    if (target && currentSession && _normEmail(target.email) === _normEmail(currentSession.email)) {
      throw new Error('لا يمكن تغيير صلاحية المدير العام الرئيسي');
    }
  }
  window.updateFirestoreDoc(window.STORAGE_KEYS.USER, userId, { role: newRole });
}

export async function deleteUserAccount(userId) {
  if (!isAdmin()) {
    throw new Error('غير مصرح لك بحذف الحسابات');
  }
  // 🔒 The primary admin account (USR-1001) and the logged-in account can never
  // be deleted from any JS action (prevents self lock-out / losing the owner).
  if (userId === 'USR-1001') {
    throw new Error('لا يمكن حذف حساب المدير العام الرئيسي');
  }
  const target = window.getUsers().find(u => u.id === userId);
  const currentSession = getCurrentUser();
  if (target && currentSession && _normEmail(target.email) === _normEmail(currentSession.email)) {
    throw new Error('لا يمكن حذف حسابك الحالي');
  }

  const result = window.deleteFirestoreDoc(window.STORAGE_KEYS.USER, userId);

  // 🔐 V3.41 — also delete the linked Firebase Auth account so the email can be
  // reused later. From the client SDK an admin can only delete the CURRENT
  // user, so for other accounts we disable the Auth user's access instead by
  // signing out / notifying — falls back silently when not possible.
  if (target && target.email && window.auth && window.auth.currentUser) {
    const targetEmail = _normEmail(target.email);
    const curEmail = _normEmail(window.auth.currentUser.email);
    if (targetEmail === curEmail) {
      // Self deletion is blocked above; this branch is defensive only.
      window.auth.currentUser.delete().catch(err => {
        console.warn('Firebase Auth account delete note:', err && err.message);
      });
    } else {
      // Other users cannot be deleted from the client SDK. Best-effort: if the
      // Auth account's email is the same as this user's, nothing else can be done
      // from the browser — the Firestore record is gone (login will fail with
      // 'حساب المستخدم غير موجود في النظام' after the next sync).
      console.info('Firebase Auth account for other users must be removed from the Firebase console:', target.email);
    }
  }

  return result;
}

// Wire the full service onto window — identical surface to the legacy script.
if (typeof window !== 'undefined') {
  window.getUsers = getUsers;
  window.getCurrentUser = getCurrentUser;
  window.login = login;
  window.logout = logout;
  window.isAuthenticated = isAuthenticated;
  window.isAdmin = isAdmin;
  window.verifyAdminPassword = verifyAdminPassword;
  window.adminPasswordConfigured = adminPasswordConfigured;
  window.createNewUserAccount = createNewUserAccount;
  window.updateUserAccount = updateUserAccount;
  window.changeOwnPassword = changeOwnPassword;
  window.updateUserRole = updateUserRole;
  window.deleteUserAccount = deleteUserAccount;
}
