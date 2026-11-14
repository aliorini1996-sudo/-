/**
 * فترات إقرار ضريبة القيمة المضافة وقاعدة OD17 («ربط الدفاتر» L4، عقد L4+L5+L8 §4.3).
 *
 * صرفة بلا I/O. الحدود هي نفسها التي يحكم بها `isVatPeriodStart` (opening.ts): الفترات تقويمية (يناير/أبريل/يوليو/أكتوبر
 * للربعية، وكل شهرين من يناير للثنائية…)، وFISCAL_YEAR = السنة المالية بنهايتها المعرّفة. فـ`vatPeriodKey(d) === d`
 * ⇔ `isVatPeriodStart(d)` لكل تاريخ ودورية (اختبار l458-a03-vat-period يثبت التكافؤ).
 *
 * OD17 (قرار المالك): عكسُ مستند مبيعات تقع ضريبته في **فترة إقرار أخرى** غير فترة الأصل يُعلَّم `vatAdjustment=true`
 * على سطور الضريبة (TAX) والعلامة (MARKER) فيدخل عمود «التعديلات» في الإقرار — فالفترة الأصل أُقرّت وقد تكون قُدّمت.
 * في الفترة نفسها يبقى العلَم كما كان (المرتجع معلَّم أصلاً، والفاتورة لا).
 * تاريخ العكس المعتبر هو الذي **سيُرحَّل به فعلاً**: إن مُرِّرت تواريخ الإقفال وسياق الحسابات طُبّقت إزاحة ADR‑7 نفسها
 * التي يطبّقها postMove(SHIFT) — عكسٌ مؤرَّخ في فترة مقفلة (أُقرّت) يُزاح إلى أول يوم مفتوح فيقع في فترة لاحقة.
 */
import { addDays, addMonths, fiscalYearOf, formatLocalDate, parseLocalDate } from '../dates';
import { lockScopeOfDraft, shiftAutoMoveDate, type LockDates } from '../locks';
import type { BuildContext, GlSettingsSnapshot, LineDraft, LocalDate, MoveDraft, TaxPeriodicity } from '../types';

/** عدد أشهر الفترة التقويمية لكل دورية (مرآة PERIOD_MONTHS في opening.ts — لا تُستورد منه لثقل استيراداته) */
const PERIOD_MONTHS: Readonly<Record<Exclude<TaxPeriodicity, 'FISCAL_YEAR'>, number>> = {
  MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOUR_MONTHS: 4, SEMIANNUAL: 6, ANNUAL: 12,
};

export interface VatPeriodRange {
  start: LocalDate;
  end: LocalDate;
}

/** حدود فترة الإقرار التي تحوي التاريخ (شاملة الطرفين). */
export function vatPeriodRange(date: LocalDate, periodicity: TaxPeriodicity, fyEndMonth = 12, fyEndDay = 31): VatPeriodRange {
  if (periodicity === 'FISCAL_YEAR') return fiscalYearOf(date, fyEndMonth, fyEndDay);
  const months = PERIOD_MONTHS[periodicity];
  if (months === undefined) throw new RangeError(`دورية إقرار غير معروفة: ${String(periodicity)}`);
  const { y, m } = parseLocalDate(date);
  const startMonth = Math.floor((m - 1) / months) * months + 1;
  const start = formatLocalDate(y, startMonth, 1);
  return { start, end: addDays(addMonths(start, months), -1) };
}

/** مفتاح فترة الإقرار = تاريخ بدايتها (نصّ YYYY-MM-DD قابل للترتيب). */
export function vatPeriodKey(date: LocalDate, periodicity: TaxPeriodicity, fyEndMonth = 12, fyEndDay = 31): string {
  return vatPeriodRange(date, periodicity, fyEndMonth, fyEndDay).start;
}

export function sameVatPeriod(a: LocalDate, b: LocalDate, periodicity: TaxPeriodicity, fyEndMonth = 12, fyEndDay = 31): boolean {
  return vatPeriodKey(a, periodicity, fyEndMonth, fyEndDay) === vatPeriodKey(b, periodicity, fyEndMonth, fyEndDay);
}

/** إعدادات الفترة كما يأخذها العكس (ReversalDraftOptions.vatPeriod وinvertInvoiceDraft) */
export interface VatPeriodSettings {
  periodicity: TaxPeriodicity;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
}

export function vatPeriodSettingsOf(
  s: Pick<GlSettingsSnapshot, 'taxPeriodicity' | 'fiscalYearEndMonth' | 'fiscalYearEndDay'>,
): VatPeriodSettings {
  return { periodicity: s.taxPeriodicity, fiscalYearEndMonth: s.fiscalYearEndMonth, fiscalYearEndDay: s.fiscalYearEndDay };
}

/** OD17 على عكسٍ: الإعدادات، واختيارياً الإقفالات وسياق الحسابات لتاريخ الترحيل الفعلي بعد الإزاحة */
export interface ReversalVatPeriod extends VatPeriodSettings {
  lockShift?: { locks: LockDates; ctx: Pick<BuildContext, 'accounts' | 'journals'> };
}

/** إعدادات OD17 الكاملة من سياق البناء (الإقفالات وسياق الحسابات للإزاحة). */
export function reversalVatPeriodOf(ctx: Pick<BuildContext, 'settings' | 'accounts' | 'journals'>): ReversalVatPeriod {
  return { ...vatPeriodSettingsOf(ctx.settings), lockShift: { locks: ctx.settings, ctx } };
}

/**
 * للمُمرِّرين (PrismaPostingTx.reverseMove وغيره): OD17 للدفاتر المربوطة وحدها، وundefined لغيرها فيبقى العكس كما كان حرفاً.
 * الاستعمال: `reversalDraftFromRecord(rec, { …, vatPeriod: linkedReversalVatPeriod(context.ctx) })`.
 */
export function linkedReversalVatPeriod(ctx: Pick<BuildContext, 'settings' | 'accounts' | 'journals'>): ReversalVatPeriod | undefined {
  return ctx.settings.linkedPosting === true ? reversalVatPeriodOf(ctx) : undefined;
}

/** التاريخ الذي سيُرحَّل به قيدٌ آليّ فعلاً (إزاحة ADR‑7 كما في postMove(SHIFT))، أو تاريخه إن لم تُمرَّر إقفالات. */
export function effectivePostingDate(draft: MoveDraft, vat: ReversalVatPeriod): LocalDate {
  if (!vat.lockShift) return draft.date;
  return shiftAutoMoveDate(draft.date, vat.lockShift.locks, lockScopeOfDraft(draft, vat.lockShift.ctx)).date;
}

/** هل يقع العكس (بتاريخ ترحيله الفعلي) في فترة إقرار غير فترة الأصل؟ */
export function reversalCrossesVatPeriod(originalDate: LocalDate, draft: MoveDraft, vat: ReversalVatPeriod): boolean {
  const posting = effectivePostingDate(draft, vat);
  return !sameVatPeriod(originalDate, posting, vat.periodicity, vat.fiscalYearEndMonth, vat.fiscalYearEndDay);
}

const isTaxOrMarker = (l: Pick<LineDraft, 'taxRole'>): boolean => l.taxRole === 'TAX' || l.taxRole === 'MARKER';

/**
 * يطبّق OD17 على مسودة عكسٍ مقلوبة الجانبين: سطور TAX/MARKER تصير `vatAdjustment = الأصل || عبور الفترة`.
 * لا يمسّ غيرها، ولا ينشئ مفتاحاً على سطرٍ لم يتغيّر علَمه (فالفترة نفسها = المسودة نفسها حرفاً).
 */
export function applyReversalVatPeriod(draft: MoveDraft, originalDate: LocalDate, vat: ReversalVatPeriod): MoveDraft {
  if (!reversalCrossesVatPeriod(originalDate, draft, vat)) return draft;
  if (!draft.lines.some((l) => isTaxOrMarker(l) && l.vatAdjustment !== true)) return draft;
  return {
    ...draft,
    lines: draft.lines.map((l) => (isTaxOrMarker(l) && l.vatAdjustment !== true ? { ...l, vatAdjustment: true } : l)),
  };
}
