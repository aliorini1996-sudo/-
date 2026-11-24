/**
 * «عمر الدين» في تقرير أرصدة العملاء (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — عرضٌ صرف لحقل `aging` الذي يحسبه الخادم
 * (backend/src/services/customerAging.ts): العمر من أقدم دينٍ قائم بعد مطابقة الفواتير المفتوحة برصيد العميل، والتأخّر عن
 * مهلة السداد، وتوزيع الرصيد على شرائح العمر. خادمٌ أقدم بلا الحقل ⇒ لا شيء يُعرض (null) لا صفر كاذب.
 */

export const DEBT_AGE_BANDS = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type DebtAgeBand = (typeof DEBT_AGE_BANDS)[number];

export interface DebtAging {
  oldestDay: string | null;
  ageDays: number | null;
  overdueDays: number;
  overdueAmount: number;
  bands: Record<DebtAgeBand, number>;
  undated: number;
}

/** عناوين الشرائح — مفاتيح ترجمة (الأخيرتان والوسطى كأعمار ذمم الموردين) */
export const DEBT_AGE_BAND_LABELS: Record<DebtAgeBand, string> = {
  d0_30: '0 إلى 30 يوما',
  d31_60: '31 إلى 60 يوما',
  d61_90: '61 إلى 90 يوما',
  d90_plus: 'أكثر من 90 يوما',
};

const EPS = 1e-6;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** الحقل كما وصل — كائنٌ بشكله وإلا null (خادمٌ أقدم، أو عميلٌ غير مدين) */
export function debtAgingOf(row: { aging?: unknown } | null | undefined): DebtAging | null {
  const a = row?.aging as Partial<DebtAging> | null | undefined;
  if (!a || typeof a !== 'object' || !a.bands || typeof a.bands !== 'object') return null;
  const bands = a.bands as Partial<Record<DebtAgeBand, unknown>>;
  return {
    oldestDay: typeof a.oldestDay === 'string' ? a.oldestDay : null,
    ageDays: typeof a.ageDays === 'number' && Number.isFinite(a.ageDays) ? a.ageDays : null,
    overdueDays: num(a.overdueDays),
    overdueAmount: num(a.overdueAmount),
    bands: { d0_30: num(bands.d0_30), d31_60: num(bands.d31_60), d61_90: num(bands.d61_90), d90_plus: num(bands.d90_plus) },
    undated: num(a.undated),
  };
}

/** شرائح لها مبلغ — بترتيبها، و«بلا تاريخ» آخراً إن وُجد */
export function debtAgeParts(a: DebtAging): { key: DebtAgeBand | 'undated'; label: string; amount: number }[] {
  const out: { key: DebtAgeBand | 'undated'; label: string; amount: number }[] = DEBT_AGE_BANDS
    .filter((k) => a.bands[k] > EPS)
    .map((k) => ({ key: k, label: DEBT_AGE_BAND_LABELS[k], amount: a.bands[k] }));
  if (a.undated > EPS) out.push({ key: 'undated', label: 'بلا تاريخ', amount: a.undated });
  return out;
}

/** التوزيع يستحق العرض حين يقع الرصيد في أكثر من شريحة — شريحةٌ واحدة يكفيها العمر نفسه */
export function debtAgeSplit(a: DebtAging): boolean {
  return debtAgeParts(a).length > 1;
}

/** لون العمر: أحمر متأخّرٌ عن مهلة السداد، وإلا حسب الشريحة — أكثر من ٩٠ يوماً أحمر ولو ضمن مهلةٍ طويلة */
export function debtAgeTone(a: DebtAging): 'bad' | 'warn' | 'ok' {
  if (a.overdueDays > 0 || (a.ageDays ?? 0) > 90) return 'bad';
  if ((a.ageDays ?? 0) > 30) return 'warn';
  return 'ok';
}
