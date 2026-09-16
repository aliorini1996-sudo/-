/**
 * مسند صلاحيات الدفاتر (§9.1) — صرفٌ بلا قاعدة، يستدعيه `requireLedgerPermission`
 * بعد قراءة المستخدم، ويطابق `canLedger` في الويب حرفياً (`web-admin/src/lib/ledgerPerms.ts`).
 *
 * الترتيب مقصود:
 *  1. مقيّد النطاق ممنوع أولاً (`LEDGER_SCOPED_ADMIN`): الدفاتر على مستوى الشركة كلها.
 *  2. ما يكافئ مالك الشركة (`ADMIN && isActive && canManageCompanyUsers === true`) يملك الست
 *     ضمناً — قادرٌ أصلاً على منح نفسه إياها. **لا مرور لـ`role === 'ADMIN'` المجرّد.**
 *  3. طلب `canViewLedger` يمرّ بأيٍّ من المفاتيح الست `=== true`.
 *  4. غير ذلك `true` الصريحة وحدها؛ الغائب منع (خلافاً لـ`requireAdminPermission`).
 */
export const LEDGER_KEYS = [
  'canViewLedger',
  'canPostJournals',
  'canManagePayables',
  'canManageBank',
  'canCloseLedgerPeriods',
  'canConfigureLedger',
] as const;
export type LedgerKey = typeof LEDGER_KEYS[number];

export type LedgerAdminRow = {
  isActive?: boolean | null;
  tenantId?: string | null;
  role?: string | null;
  canManageCompanyUsers?: boolean | null;
  scopeEnabled?: boolean | null;
} & Partial<Record<LedgerKey, boolean | null>>;

export type LedgerPermissionDecision = 'ALLOW' | 'DENIED' | 'SCOPED';

export function ledgerPermissionDecision(
  admin: LedgerAdminRow | null | undefined,
  key: LedgerKey,
  tenantId: string | null | undefined,
): LedgerPermissionDecision {
  if (!admin || admin.isActive !== true || !tenantId || admin.tenantId !== tenantId) return 'DENIED';
  if (admin.scopeEnabled === true) return 'SCOPED';
  if (admin.role === 'ADMIN' && admin.canManageCompanyUsers === true) return 'ALLOW';
  if (key === 'canViewLedger') return LEDGER_KEYS.some(k => admin[k] === true) ? 'ALLOW' : 'DENIED';
  return admin[key] === true ? 'ALLOW' : 'DENIED';
}
