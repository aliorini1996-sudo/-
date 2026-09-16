import type { AccountImportRow, AccountType } from '../../../../api/ledgerConfig';

/**
 * استيراد شجرة الحسابات (COA‑07) — منطق صرف بلا React: مطابقة أعمدة الملف (عربي أو إنجليزي أو تصدير Odoo)،
 * وتحليل النوع والتسوية، والتحقق المبكر نفسه في الخادم (الرمز 4–10 أرقام، الاسم عربي G7، التسوية لا للنقد).
 * الخادم يبقى الحكم: الموجود بالرمز يُتخطى ولا يُعدَّل، والاسم غير العربي يرفض الملف كله.
 */

export const ACCOUNT_TYPE_KEYS: readonly AccountType[] = [
  'asset_cash', 'asset_receivable', 'asset_current', 'asset_prepayments', 'asset_fixed', 'asset_non_current',
  'liability_payable', 'liability_credit_card', 'liability_current', 'liability_non_current',
  'equity', 'equity_unaffected', 'income', 'income_other',
  'expense_direct_cost', 'expense', 'expense_depreciation', 'expense_other', 'expense_zakat', 'off_balance',
];

/** تسميات Odoo الإنجليزية لأنواع الحسابات (تصدير «Chart of Accounts»). */
const ODOO_TYPE_NAMES: Record<string, AccountType> = {
  'bank and cash': 'asset_cash',
  receivable: 'asset_receivable',
  'current assets': 'asset_current',
  prepayments: 'asset_prepayments',
  'fixed assets': 'asset_fixed',
  'non-current assets': 'asset_non_current',
  payable: 'liability_payable',
  'credit card': 'liability_credit_card',
  'current liabilities': 'liability_current',
  'non-current liabilities': 'liability_non_current',
  equity: 'equity',
  'current year earnings': 'equity_unaffected',
  income: 'income',
  'other income': 'income_other',
  'cost of revenue': 'expense_direct_cost',
  expenses: 'expense',
  depreciation: 'expense_depreciation',
  'off-balance sheet': 'off_balance',
};

export type ImportField = 'code' | 'name' | 'nameEn' | 'type' | 'reconcile';

const HEADER_SYNONYMS: Record<ImportField, string[]> = {
  code: ['code', 'الرمز', 'رمز الحساب', 'رقم الحساب', 'account code'],
  name: ['name', 'الاسم', 'اسم الحساب', 'الاسم العربي', 'account name', 'account'],
  nameEn: ['nameen', 'name en', 'english name', 'الاسم الإنجليزي', 'الاسم بالإنجليزية'],
  type: ['type', 'النوع', 'نوع الحساب', 'account type'],
  reconcile: ['reconcile', 'التسوية', 'قابل للتسوية', 'allow reconciliation'],
};

const normHeader = (s: string) => s.trim().toLowerCase().replace(/[\s_\-.]+/g, ' ').replace(/[أإآ]/g, 'ا');

/** عنوان عمود ⇒ حقل الاستيراد (مطابقة تامة بعد التطبيع). */
export function importFieldOf(header: string): ImportField | null {
  const h = normHeader(header);
  for (const [field, names] of Object.entries(HEADER_SYNONYMS) as [ImportField, string[]][]) {
    if (names.some(n => normHeader(n) === h)) return field;
  }
  return null;
}

/** نص النوع ⇒ AccountType: المفتاح نفسه، أو تسمية واجهة (أي لغة)، أو تسمية Odoo. */
export function parseAccountType(raw: unknown, labels: Record<AccountType, string>[] = []): AccountType | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if ((ACCOUNT_TYPE_KEYS as readonly string[]).includes(low)) return low as AccountType;
  for (const table of labels) {
    for (const k of ACCOUNT_TYPE_KEYS) if (table[k] && table[k].trim().toLowerCase() === low) return k;
  }
  return ODOO_TYPE_NAMES[low] ?? null;
}

export function parseBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'نعم', '✓', 'x', 'vrai', 'evet', '是'].includes(s);
}

export const hasArabicLetter = (v: unknown) => typeof v === 'string' && /[؀-ۿݐ-ݿ]/.test(v);

export type ImportRowIssue = 'CODE_INVALID' | 'NAME_REQUIRED' | 'NAME_NOT_ARABIC' | 'TYPE_INVALID' | 'RECONCILE_CASH' | 'DUPLICATE_IN_FILE' | 'EQUITY_UNAFFECTED';

export interface ParsedImportRow {
  line: number;
  row: AccountImportRow | null;
  raw: { code: string; name: string; nameEn: string; type: string; reconcile: boolean };
  issues: ImportRowIssue[];
}

export const IMPORT_MAX_ROWS = 5000;

/** صفوف الملف (كائنات بعناوينه) ⇒ صفوف استيراد مع مشكلات كل صف. */
export function parseImportRows(records: Record<string, unknown>[], typeLabels: Record<AccountType, string>[] = []): { rows: ParsedImportRow[]; missingColumns: ImportField[] } {
  const headers = new Map<ImportField, string>();
  for (const rec of records.slice(0, 50)) {
    for (const h of Object.keys(rec)) {
      const f = importFieldOf(h);
      if (f && !headers.has(f)) headers.set(f, h);
    }
  }
  const missingColumns = (['code', 'name', 'type'] as ImportField[]).filter(f => !headers.has(f));
  const get = (rec: Record<string, unknown>, f: ImportField) => {
    const h = headers.get(f);
    return h === undefined ? '' : rec[h];
  };
  const seen = new Set<string>();
  const rows = records.map((rec, i): ParsedImportRow => {
    const code = String(get(rec, 'code') ?? '').replace(/\s+/g, '').replace(/\.0+$/, '');
    const name = String(get(rec, 'name') ?? '').trim();
    const nameEn = String(get(rec, 'nameEn') ?? '').trim();
    const typeRaw = String(get(rec, 'type') ?? '').trim();
    const reconcile = parseBool(get(rec, 'reconcile'));
    const type = parseAccountType(typeRaw, typeLabels);
    const issues: ImportRowIssue[] = [];
    if (!/^\d{4,10}$/.test(code)) issues.push('CODE_INVALID');
    else if (seen.has(code)) issues.push('DUPLICATE_IN_FILE');
    if (!name) issues.push('NAME_REQUIRED');
    else if (!hasArabicLetter(name)) issues.push('NAME_NOT_ARABIC');
    if (!type) issues.push('TYPE_INVALID');
    if (type === 'asset_cash' && reconcile) issues.push('RECONCILE_CASH');
    if (type === 'equity_unaffected') issues.push('EQUITY_UNAFFECTED');
    if (/^\d{4,10}$/.test(code)) seen.add(code);
    const ok = issues.length === 0 && type;
    return {
      line: i + 2,
      raw: { code, name, nameEn, type: typeRaw, reconcile },
      issues,
      row: ok ? { code, name, nameEn: nameEn || null, type: type!, ...(reconcile ? { reconcile: true } : {}) } : null,
    };
  });
  return { rows, missingColumns };
}
