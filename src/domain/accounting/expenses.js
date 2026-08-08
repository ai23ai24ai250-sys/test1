/**
 * Operational Expenses accounting — pure domain layer.
 * Ported verbatim from js/services/expenses.js (legacy). Pure calculations take
 * data directly; create/update/delete receive an injected `repo`
 * (repository pattern) — see src/legacy/compat.js for adapters.
 */
import { toNumber, round2, generateAutoId, getCairoFormattedDate } from '../../utils/formatters.js';

export const EXPENSES_STORAGE_KEY = 'expenses';

export function getTotalExpenses(expenses) {
  return round2(expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
}

/* ===== Recurring (monthly) expenses ===== */
export function getExpenseNextDueDate(expense, baseDate) {
  if (!expense || expense.recurring !== true) return '';
  const due = parseInt(expense.dueDay, 10);
  if (isNaN(due) || due < 1 || due > 31) return '';
  const now = baseDate ? new Date(baseDate) : new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  if (now.getDate() >= due) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(due, lastDay);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getCurrentOperatingExpenses(expenses, nowDate) {
  const list = expenses || [];
  const now = nowDate ? new Date(nowDate) : new Date();
  const currentDay = now.getDate();
  const toNum = toNumber;
  let oneTime = 0;
  let recurringThisMonth = 0;
  let recurringFuture = 0;
  list.forEach(e => {
    const amt = toNum(e.amount);
    if (e.recurring === true) {
      const due = parseInt(e.dueDay, 10);
      if (isNaN(due) || due < 1 || due > 31) {
        oneTime += amt;
        return;
      }
      if (currentDay >= due) recurringThisMonth += amt;
      else recurringFuture += amt;
    } else {
      oneTime += amt;
    }
  });
  return {
    oneTime: round2(oneTime),
    recurringThisMonth: round2(recurringThisMonth),
    recurringFuture: round2(recurringFuture),
    total: round2(oneTime + recurringThisMonth)
  };
}

export function createExpense({ title, amount, category = 'عمومية', date, notes = '', createdBy = 'المدير العام', recurring = false, dueDay = null }, repo) {
  const numAmount = round2(parseFloat(amount));
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('يرجى إدخال قيمة مصروف صحيحة أكبر من الصفر');
  }

  const expenseId = generateAutoId('EXP');
  const now = getCairoFormattedDate();

  const newExpense = {
    id: expenseId,
    title: title.trim(),
    amount: numAmount,
    category: category.trim(),
    date: date || now.slice(0, 10),
    notes: notes.trim(),
    recurring: !!recurring,
    dueDay: recurring ? (parseInt(dueDay, 10) || null) : null,
    createdBy,
    createdAt: now,
    updatedAt: now
  };

  return repo.addFirestoreDoc(repo.storageKeys.EXPENSES, newExpense);
}

export function updateExpense(id, updates, repo) {
  const sanitized = { ...updates };
  if (sanitized.amount != null) sanitized.amount = round2(parseFloat(sanitized.amount));
  if (sanitized.recurring != null) sanitized.recurring = !!sanitized.recurring;
  if (sanitized.recurring === true) {
    sanitized.dueDay = parseInt(sanitized.dueDay, 10) || null;
  } else if (sanitized.recurring === false) {
    sanitized.dueDay = null;
  }
  repo.updateFirestoreDoc(repo.storageKeys.EXPENSES, id, { ...sanitized, updatedAt: getCairoFormattedDate() });
  return repo.getExpenses().find(e => e.id === id) || null;
}

export function deleteExpense(id, repo) {
  return repo.deleteFirestoreDoc(repo.storageKeys.EXPENSES, id);
}
