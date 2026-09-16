import type { User } from '../types';

/**
 * صلاحيات الدفاتر — **المصدر الوحيد للويب و`/m`** (§8.1)، بالمسند نفسه في
 * `requireLedgerPermission` على الخادم (§9.1): فلا يرى مستخدمٌ عنصراً يرده الخادم
 * بـ403 ولا يُحجب عن عنصر يسمح به.
 *
 * خلافاً لـ`can()` و`PermissionRoute` (تمنعان عند `=== false` وحدها وتتجاهلان الدور):
 * أعمدة الدفاتر افتراضها `false`، فتلك الدلالة تحجب مالك الشركة وتمرّر من غاب عنه المفتاح.
 */
export const LEDGER_KEYS = ['canViewLedger','canPostJournals','canManagePayables','canManageBank','canCloseLedgerPeriods','canConfigureLedger'] as const;
export type LedgerKey = typeof LEDGER_KEYS[number];
export function canLedger(user: User | null | undefined, key: LedgerKey): boolean {
  if (!user || user.scopeEnabled === true) return false;                 // يطابق LEDGER_SCOPED_ADMIN، ويُفحص قبل الدور كما في §9.1
  if (user.role === 'ADMIN' && user.canManageCompanyUsers === true) return true; // ما يكافئ مالك الشركة يملك الست ضمناً
  if (key === 'canViewLedger') return LEDGER_KEYS.some(k => user[k] === true);   // أي صلاحية أعلى تتضمن العرض (§9.1)
  return user[key] === true;                                              // true الصريحة وحدها؛ الغائب (جلسة قديمة) منع
}
