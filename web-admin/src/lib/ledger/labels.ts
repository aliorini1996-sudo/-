import type { LedgerKey } from '../ledgerPerms';

/**
 * تسميات الدفاتر التقنية (§8.7) — **بنداءات `tr()` حرفية** لا `tr(متغير)`: حارس
 * `langs.test.ts` لا يلتقط إلا الحرفية، والنداء بمتغير يسقط صامتاً إلى العربية.
 * M0: تسميات الصلاحيات الست وحدها؛ تتسع من M2.
 */
export const ledgerPermissionItems = (tr: (ar: string) => string): { key: LedgerKey; label: string }[] => [
  { key: 'canViewLedger', label: tr('عرض الدفاتر والتقارير') },
  { key: 'canPostJournals', label: tr('إنشاء القيود وترحيلها') },
  { key: 'canManagePayables', label: tr('الموردون والمدفوعات') },
  { key: 'canManageBank', label: tr('البنك والمطابقة') },
  { key: 'canCloseLedgerPeriods', label: tr('إقفال الفترات والإقرار الضريبي') },
  { key: 'canConfigureLedger', label: tr('إعداد الدفاتر') },
];
