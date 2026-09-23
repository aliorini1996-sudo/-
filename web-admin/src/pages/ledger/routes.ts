import type { LedgerKey } from '../../lib/ledgerPerms';

/**
 * جدول مسارات الدفاتر (§8.2) — **مصدر تسجيل `App.tsx` وقوائم `LedgerLayout` معاً**.
 * كل صف يُسجَّل تحت `/app/ledger` ملفوفاً بـ`LedgerRoute perm={view}`، وأزرار الكتابة داخل
 * الصفحة تُعطَّل دون `canLedger(user, write)`.
 *
 * قاعدة المراحل: كل مسار لمرحلة لم تُسلَّم لا يُسجَّل ولا يظهر عنصره — فهذا الملف يحمل
 * صفوف المراحل المسلَّمة وحدها، ويتسع مع كل مرحلة (الاختباران ledgerRoutes وledgerMenuPerms).
 *
 * `component` مسار الملف تحت `pages/ledger/` بلا امتداد؛ الملف صرف (بلا React ولا Vite)
 * كي يقرأه اختبار node مباشرة.
 */

export type LedgerMilestone = 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | 'M9' | 'M10' | 'M11' | 'M12' | 'M13';

export interface LedgerRouteDef {
  /** نسبي إلى `/app/ledger`؛ `''` = الفهرس */
  path: string;
  /** مكوّن الصفحة: `pages/ledger/<component>.tsx` */
  component: string;
  /** صلاحية العرض (غلاف LedgerRoute وظهور عنصر القائمة) — صلاحية `GET` لنقطته */
  view: LedgerKey;
  /** صلاحية الكتابة (أزرار الإنشاء والتعديل والترحيل) — `null` = للقراءة */
  write: LedgerKey | null;
  milestone: LedgerMilestone;
}

export const LEDGER_ROUTES: readonly LedgerRouteDef[] = [
  // الفهرس: قبل التفعيل «بانتظار الإعداد» (M2 هيكل، M3 المعالج، M4 البطاقات)
  { path: '', component: 'LedgerHome', view: 'canViewLedger', write: 'canConfigureLedger', milestone: 'M2' },
  // المحاسبة ← المعاملات
  { path: 'entries', component: 'entries/MoveList', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M2' },
  { path: 'entries/new', component: 'entries/MoveForm', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M2' },
  { path: 'entries/:id', component: 'entries/MoveForm', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M2' },
  { path: 'items', component: 'entries/MoveLineList', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M2' },
  // التهيئة
  { path: 'config/settings', component: 'config/SettingsPage', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/accounts', component: 'config/AccountList', view: 'canViewLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/accounts/:id', component: 'config/AccountForm', view: 'canViewLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/taxes', component: 'config/TaxList', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/journals', component: 'config/JournalList', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/mappings', component: 'config/MappingsPage', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/tags', component: 'config/TagList', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M2' },
  { path: 'config/fiscal-years', component: 'config/FiscalYearList', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M2' },
  // العملاء (M3): حالة ترحيل المستندات القائمة، وعهدة المناديب (وزر «تسجيل عجز» M4)، والأمانات
  { path: 'customers/invoices', component: 'customers/InvoicePostingList', view: 'canViewLedger', write: null, milestone: 'M3' },
  { path: 'customers/receipts', component: 'customers/ReceiptPostingList', view: 'canViewLedger', write: null, milestone: 'M3' },
  { path: 'customers/custody', component: 'customers/CustodyPage', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M3' },
  { path: 'customers/paylink', component: 'customers/PaylinkClearingPage', view: 'canViewLedger', write: null, milestone: 'M3' },
  // مراجعة (M3)
  { path: 'review/events', component: 'review/SyncEventsPage', view: 'canViewLedger', write: 'canConfigureLedger', milestone: 'M3' },
  { path: 'review/attention', component: 'review/MoveReviewList', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M3' },
  { path: 'review/late', component: 'review/MoveReviewList', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M3' },
  { path: 'review/unreviewed', component: 'review/MoveReviewList', view: 'canViewLedger', write: 'canPostJournals', milestone: 'M3' },
  { path: 'review/checks', component: 'review/IntegrityChecksPage', view: 'canViewLedger', write: 'canConfigureLedger', milestone: 'M3' },
  { path: 'review/audit', component: 'review/AuditLogPage', view: 'canConfigureLedger', write: null, milestone: 'M3' },
  // إعداد التقارير (M4، §7.1 إلى §7.5): صفحةٌ لكل تقرير فوق قشرة `reports/ReportView` المشتركة.
  // **المفتاح واحد في كل موضع**: `income-statement` مسارُ الواجهة ومفتاحُ النقطة معاً، و`profit-and-loss`
  // مرادفُ مدخلٍ على الخادم وحده فلا يُسجَّل هنا ولا يظهر في ردٍّ (انظر رأس routes/ledger/reports.ts).
  { path: 'reports/balance-sheet', component: 'reports/BalanceSheetPage', view: 'canViewLedger', write: null, milestone: 'M4' },
  { path: 'reports/income-statement', component: 'reports/IncomeStatementPage', view: 'canViewLedger', write: null, milestone: 'M4' },
  { path: 'reports/trial-balance', component: 'reports/TrialBalancePage', view: 'canViewLedger', write: null, milestone: 'M4' },
  { path: 'reports/general-ledger', component: 'reports/GeneralLedgerPage', view: 'canViewLedger', write: null, milestone: 'M4' },
];

/** الحوارات بلا مسار (صف «تواريخ الإقفال…» في جدول §8.2). */
export type LedgerDialogKey = 'lockDates';
export interface LedgerDialogDef { key: LedgerDialogKey; view: LedgerKey; write: LedgerKey; milestone: LedgerMilestone }
export const LEDGER_DIALOGS: readonly LedgerDialogDef[] = [
  { key: 'lockDates', view: 'canCloseLedgerPeriods', write: 'canCloseLedgerPeriods', milestone: 'M2' },
];

export const LEDGER_BASE = '/app/ledger';
/** رابط مطلق لمسار نسبي من الجدول */
export const ledgerHref = (path: string) => (path ? `${LEDGER_BASE}/${path}` : LEDGER_BASE);

export function findLedgerRoute(path: string): LedgerRouteDef | undefined {
  return LEDGER_ROUTES.find(r => r.path === path);
}

// ═══ القوائم (مرآة Odoo) ═══

/** عنصر قائمة: مسار من الجدول أو حوار — وصلاحيته تُقرأ من صفه لا تُكرَّر هنا (والرابط الخارجي يحمل صلاحية عرضه). */
export type LedgerMenuItem =
  | { kind: 'route'; label: string; path: string }
  | { kind: 'dialog'; label: string; dialog: LedgerDialogKey }
  /** رابط إلى صفحة قائمة خارج `/app/ledger` (لا يُسجَّل في الجدول، §8.2: «العملاء ← /app/customers») */
  | { kind: 'link'; label: string; href: string; view: LedgerKey };

export interface LedgerMenuSection { label?: string; items: LedgerMenuItem[] }
export interface LedgerMenu { key: string; label: string; sections: LedgerMenuSection[] }

/**
 * قوائم M2 وM3 وM4 من جدول §8.2 — بنداءات `tr()` **حرفية** (حارس langs.test لا يلتقط tr(متغير)).
 * بترتيب Odoo: العملاء، المحاسبة، مراجعة، إعداد التقارير، التهيئة. القوائم الأخرى (لوحة البيانات M4،
 * الموردون M6) وبنود M4 في العملاء (تسويات الذمم) تُضاف بمراحلها، وكذلك بقيّة صفوف «إعداد التقارير»
 * (دفتر أستاذ الشركاء وأعمار الذمم M6، والتقرير الضريبي M5، والتدفقات النقدية M7، والملخّص التنفيذي).
 */
export const ledgerMenus = (tr: (ar: string) => string): LedgerMenu[] => [
  {
    key: 'customers',
    label: tr('العملاء'),
    sections: [
      {
        items: [
          { kind: 'route', label: tr('الفواتير والمرتجعات'), path: 'customers/invoices' },
          { kind: 'route', label: tr('سندات القبض'), path: 'customers/receipts' },
          { kind: 'route', label: tr('عهدة المناديب'), path: 'customers/custody' },
          { kind: 'route', label: tr('أمانات الدفع الإلكتروني'), path: 'customers/paylink' },
        ],
      },
      { items: [{ kind: 'link', label: tr('العملاء'), href: '/app/customers', view: 'canViewLedger' }] },
    ],
  },
  {
    key: 'accounting',
    label: tr('المحاسبة'),
    sections: [
      {
        label: tr('المعاملات'),
        items: [
          { kind: 'route', label: tr('قيود اليومية'), path: 'entries' },
          { kind: 'route', label: tr('بنود اليومية'), path: 'items' },
        ],
      },
      {
        label: tr('الإقفال'),
        items: [
          { kind: 'dialog', label: tr('تواريخ الإقفال…'), dialog: 'lockDates' },
        ],
      },
    ],
  },
  {
    key: 'review',
    label: tr('مراجعة'),
    sections: [
      {
        items: [
          { kind: 'route', label: tr('أحداث الترحيل الآلي'), path: 'review/events' },
          { kind: 'route', label: tr('قيود تحتاج انتباها'), path: 'review/attention' },
          { kind: 'route', label: tr('مستندات وصلت متأخرة'), path: 'review/late' },
          { kind: 'route', label: tr('قيود غير مراجعة'), path: 'review/unreviewed' },
          { kind: 'route', label: tr('فحوصات السلامة'), path: 'review/checks' },
          { kind: 'route', label: tr('سجل التدقيق'), path: 'review/audit' },
        ],
      },
    ],
  },
  {
    key: 'reports',
    label: tr('إعداد التقارير'),
    sections: [
      {
        label: tr('كشوف الحساب'),
        items: [
          { kind: 'route', label: tr('الميزانية العمومية'), path: 'reports/balance-sheet' },
          { kind: 'route', label: tr('قائمة الدخل'), path: 'reports/income-statement' },
        ],
      },
      {
        label: tr('دفاتر الأستاذ'),
        items: [
          { kind: 'route', label: tr('ميزان المراجعة'), path: 'reports/trial-balance' },
          { kind: 'route', label: tr('دفتر الأستاذ العام'), path: 'reports/general-ledger' },
        ],
      },
    ],
  },
  {
    key: 'config',
    label: tr('التهيئة'),
    sections: [
      { items: [{ kind: 'route', label: tr('الإعدادات'), path: 'config/settings' }] },
      {
        label: tr('المحاسبة'),
        items: [
          { kind: 'route', label: tr('شجرة الحسابات'), path: 'config/accounts' },
          { kind: 'route', label: tr('الضرائب'), path: 'config/taxes' },
          { kind: 'route', label: tr('دفاتر اليومية'), path: 'config/journals' },
          { kind: 'route', label: tr('ربط الحسابات'), path: 'config/mappings' },
          { kind: 'route', label: tr('السنوات المالية'), path: 'config/fiscal-years' },
          { kind: 'route', label: tr('علامات الحسابات'), path: 'config/tags' },
        ],
      },
    ],
  },
];

/** صلاحية عرض عنصر القائمة من صف الجدول (مسار أو حوار). */
export function menuItemViewPerm(item: LedgerMenuItem): LedgerKey | undefined {
  if (item.kind === 'route') return findLedgerRoute(item.path)?.view;
  if (item.kind === 'link') return item.view;
  return LEDGER_DIALOGS.find(d => d.key === item.dialog)?.view;
}

/**
 * قاعدة الظهور (§8.2): العنصر يظهر حين يملك المستخدم صلاحية عرضه، والقسم بلا عناصر ظاهرة يُخفى،
 * والقائمة التي لا يملك عرض أي من بنودها تُخفى كلها. صرفة — `has` = `k => canLedger(user, k)`.
 */
export function visibleLedgerMenus(menus: readonly LedgerMenu[], has: (k: LedgerKey) => boolean): LedgerMenu[] {
  const out: LedgerMenu[] = [];
  for (const m of menus) {
    const sections = m.sections
      .map(s => ({ ...s, items: s.items.filter(i => { const p = menuItemViewPerm(i); return !!p && has(p); }) }))
      .filter(s => s.items.length > 0);
    if (sections.length > 0) out.push({ ...m, sections });
  }
  return out;
}
