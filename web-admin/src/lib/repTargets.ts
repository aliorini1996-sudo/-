/**
 * «هدف الشهر» (طلب المالك ٩ نوفمبر ٢٠٢٦) — نقيٌّ بلا React ولا شبكة، يُختبر وحده (repTargets.test.ts). تشترك فيه نافذة
 * المناديب في لوحة الإدارة (components/RepTargetsModal.tsx) وبطاقة الصفحة الرئيسية في تطبيق المندوب (rep/RepTargetsCard.tsx).
 *
 * لكل مندوبٍ أهدافٌ شهرية (حتى ٢٠ في الشهر)، لكلٍّ مكافأته وشريط تقدّمه:
 *  · **مبيعات بمبلغ** (SALES_AMOUNT): صافي مبيعات الشهر (البيع ناقص المرتجع، بإجمالي الفواتير كبقية أرقام «المبيعات»).
 *  · **كمية صنف** (PRODUCT_QTY): صافي كمية الصنف بوحدة الهدف المختارة — الخادم يحسب بالأساس (الهدف × معامل لقطة الوحدة)
 *    ويردّ المُنجَز بوحدة الهدف نفسها، فلا تحويل هنا. والجسم يحمل الكمية كما كُتبت ومعرّف الوحدة (null = الأساس).
 *  · **تحصيل نسبة من الديون** (COLLECTION_PCT): نسبةٌ من ديون المندوب الآجلة المفتوحة في بداية الشهر — الهدف مبلغٌ = الأساس × النسبة.
 * والمكافأة: عمولة % من صافي المبيعات (مبلغها من الخادم)، أو % من الراتب (نصٌّ فقط — الراتب لا يُدخل ولا يُحفظ)، أو مبلغ محدد.
 *
 * الحساب كلّه في الخادم (backend/src/services/repTargets.ts) بشهر الشركة وتوقيتها؛ هنا العرض والتحقق قبل الإرسال
 * (`draftProblem` مرآة حدود الخادم، والخادم الحَكَم). الدوالّ تأخذ `tr` والمنسّقات معاملاتٍ فتبقى نقيّة،
 * وكل عبارةٍ عربية تُنتجها في `REP_TARGET_TEXTS` (حارس القاموس في الاختبار). ولا ذكر للضريبة في أي نصّ (وضع «إزالة الضريبة»).
 */
import type { UnitChoice } from '../rep/repUnits';

type Tr = (ar: string) => string;
type Fmt = (n: number) => string;

export type RepTargetKind = 'SALES_AMOUNT' | 'PRODUCT_QTY' | 'COLLECTION_PCT';
export type RepRewardKind = 'COMMISSION_SALES_PCT' | 'SALARY_PCT' | 'FIXED_AMOUNT';
/** OK · NO_BASE (لا ديون مفتوحة بداية الشهر لهدف التحصيل) · PRODUCT_DELETED (حُذف صنف هدف الكمية) */
export type RepTargetState = 'OK' | 'NO_BASE' | 'PRODUCT_DELETED';

export interface RepTargetProgress {
  state: RepTargetState;
  /** المُنجَز: مبلغ (المبيعات والتحصيل) أو كمية بوحدة الهدف */
  achieved: number;
  /** الهدف بالوحدة نفسها (للتحصيل مبلغٌ = الأساس × النسبة) */
  goal: number;
  /** نسبة الإنجاز بمنزلة عشرية — غير مسقوفة (١٢٠٪ ممكنة)، وnull بلا هدفٍ قابل للقياس */
  pct: number | null;
  done: boolean;
  /** للتحصيل وحده: الديون المفتوحة في بداية الشهر */
  base?: number;
  collectedPct?: number | null;
}

export interface RepTargetReward {
  kind: RepRewardKind;
  value: number;
  /** العمولة محسوبةً من صافي مبيعات الشهر، والمبلغ المحدد نفسه، وnull لنسبة الراتب */
  amount: number | null;
  earned: boolean;
}

/** هدفٌ كما يردّه الخادم (GET /rep-targets/rep/:repId و/mine، ونتيجة POST/PUT) */
export interface RepTargetView {
  id: string;
  month: string;
  kind: RepTargetKind;
  targetValue: number;
  productId: string | null;
  productName: string | null;
  unitId: string | null;
  unitName: string | null;
  unitFactor: number;
  rewardKind: RepRewardKind;
  rewardValue: number;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  progress: RepTargetProgress;
  reward: RepTargetReward;
}

/** ردّ GET: الشهر بحدوده بتوقيت الشركة، وأهدافه بترتيب الإنشاء */
export interface RepTargetsData {
  month: string;
  from: string;
  to: string;
  isCurrent: boolean;
  /** الشهر الحالي: الأيام الباقية مع اليوم · الماضي ٠ · القادم أيام الشهر كلها */
  daysLeft: number;
  monthNetSales: number;
  targets: RepTargetView[];
}

/** جسم POST/PUT */
export interface RepTargetInput {
  month: string;
  kind: RepTargetKind;
  targetValue: number;
  productId: string | null;
  unitId: string | null;
  /** هدف الكمية: اسم وحدة الصنف الصغرى (الأساس) كما رآها النموذج — تحوّلت منذ تحميل الأصناف ⇒ 400 UNIT_INVALID لا هدفٌ ×F صامت */
  baseUnitName?: string | null;
  rewardKind: RepRewardKind;
  rewardValue: number;
  note: string | null;
}

export const TARGET_KINDS: ReadonlyArray<{ kind: RepTargetKind; label: string }> = [
  { kind: 'SALES_AMOUNT', label: 'مبيعات بمبلغ' },
  { kind: 'PRODUCT_QTY', label: 'كمية صنف' },
  { kind: 'COLLECTION_PCT', label: 'تحصيل نسبة من الديون' },
];

export const REWARD_KINDS: ReadonlyArray<{ kind: RepRewardKind; label: string }> = [
  { kind: 'COMMISSION_SALES_PCT', label: 'عمولة % من المبيعات' },
  { kind: 'SALARY_PCT', label: '% من الراتب' },
  { kind: 'FIXED_AMOUNT', label: 'مبلغ محدد' },
];

/** سقف قيمة الهدف لكل نوع — مرآة zod الخادم (والحدّ الأدنى أكبر من صفر للجميع) */
export const TARGET_MAX: Record<RepTargetKind, number> = { SALES_AMOUNT: 1e12, PRODUCT_QTY: 1e9, COLLECTION_PCT: 100 };
/** سقف قيمة المكافأة لكل نوع */
export const REWARD_MAX: Record<RepRewardKind, number> = { COMMISSION_SALES_PCT: 100, SALARY_PCT: 1000, FIXED_AMOUNT: 1e9 };
export const TARGET_NOTE_MAX = 300;
/** أقصى عدد أهدافٍ للمندوب في الشهر (409 TARGET_LIMIT) */
export const MAX_TARGETS_PER_MONTH = 20;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** خانات نموذج الهدف كما كُتبت — الأرقام نصوصٌ من الخانات */
export interface TargetDraft {
  month: string;
  kind: RepTargetKind;
  targetValue: string;
  productId: string | null;
  unitId: string | null;
  rewardKind: RepRewardKind;
  rewardValue: string;
  note: string;
}

export function emptyDraft(month: string): TargetDraft {
  return { month, kind: 'SALES_AMOUNT', targetValue: '', productId: null, unitId: null, rewardKind: 'COMMISSION_SALES_PCT', rewardValue: '', note: '' };
}

/** نموذج التعديل من هدفٍ قائم */
export function draftOf(t: RepTargetView): TargetDraft {
  return {
    month: t.month, kind: t.kind, targetValue: String(t.targetValue),
    productId: t.kind === 'PRODUCT_QTY' ? t.productId : null, unitId: t.kind === 'PRODUCT_QTY' ? t.unitId : null,
    rewardKind: t.rewardKind, rewardValue: String(t.rewardValue), note: t.note ?? '',
  };
}

/**
 * خانة رقمٍ عشريّ كما تُكتب: الأرقام الهندية تُقرأ كاللاتينية، والفاصلة (,) والعربية (٫) نقطةً عشرية — كـDecimalInput حرفاً
 * (فلا فاصل آلاف). يُرجع النصّ المطبَّع، أو null لضغطةٍ دخيلة يتجاهلها الحقل فلا يُمسح ما كُتب.
 */
export function cleanDecimal(raw: string): string | null {
  const s = String(raw ?? '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٫,]/g, '.');
  return /^\d*\.?\d*$/.test(s) ? s : null;
}

/** رقمٌ من خانة: الأرقام الهندية والفاصلة العشرية العربية تُقرأ كاللاتينية، والفارغ null، والنصّ NaN */
export function readNum(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim()
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٫,]/g, '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const VALUE_ZERO: Record<RepTargetKind, string> = {
  SALES_AMOUNT: 'مبلغ الهدف رقم أكبر من صفر',
  PRODUCT_QTY: 'كمية الهدف رقم أكبر من صفر',
  COLLECTION_PCT: 'نسبة التحصيل أكبر من صفر وحتى 100',
};
const VALUE_BIG: Record<RepTargetKind, string> = {
  SALES_AMOUNT: 'مبلغ الهدف كبير جدا',
  PRODUCT_QTY: 'كمية الهدف كبيرة جدا',
  COLLECTION_PCT: 'نسبة التحصيل أكبر من صفر وحتى 100',
};
const REWARD_ZERO: Record<RepRewardKind, string> = {
  COMMISSION_SALES_PCT: 'نسبة العمولة أكبر من صفر وحتى 100',
  SALARY_PCT: 'نسبة الراتب أكبر من صفر وحتى 1000',
  FIXED_AMOUNT: 'مبلغ المكافأة رقم أكبر من صفر',
};
const REWARD_BIG: Record<RepRewardKind, string> = {
  COMMISSION_SALES_PCT: 'نسبة العمولة أكبر من صفر وحتى 100',
  SALARY_PCT: 'نسبة الراتب أكبر من صفر وحتى 1000',
  FIXED_AMOUNT: 'مبلغ المكافأة كبير جدا',
};

/**
 * سبب رفض النموذج قبل إرساله (مفتاح القاموس — tr في الشاشة)، أو null. مرآة TargetInput في الخادم: الشهر YYYY-MM، والقيمة
 * أكبر من صفر حتى سقف نوعها، وهدف الكمية بصنف، والملاحظة ٣٠٠ حرف. ووحدة الصنف يحكمها المنتقي (choiceById) والخادم.
 */
export function draftProblem(d: TargetDraft): string | null {
  if (!MONTH_RE.test(String(d.month ?? ''))) return 'الشهر غير صحيح';
  if (!TARGET_KINDS.some(k => k.kind === d.kind)) return 'نوع الهدف غير صحيح';
  if (d.kind === 'PRODUCT_QTY' && !d.productId) return 'اختر صنفاً صحيحاً';
  const v = readNum(d.targetValue);
  if (v === null || Number.isNaN(v) || v <= 0) return VALUE_ZERO[d.kind];
  if (v > TARGET_MAX[d.kind]) return VALUE_BIG[d.kind];
  if (!REWARD_KINDS.some(k => k.kind === d.rewardKind)) return 'نوع المكافأة غير صحيح';
  const r = readNum(d.rewardValue);
  if (r === null || Number.isNaN(r) || r <= 0) return REWARD_ZERO[d.rewardKind];
  if (r > REWARD_MAX[d.rewardKind]) return REWARD_BIG[d.rewardKind];
  if (String(d.note ?? '').trim().length > TARGET_NOTE_MAX) return 'الملاحظة 300 حرف على الأكثر';
  return null;
}

/**
 * جسم POST/PUT من نموذجٍ سليم (`draftProblem` = null). الكمية تُرسل **كما كُتبت بوحدة الهدف** ومعها معرّف الوحدة — والخادم
 * يلتقط اسمها ومعاملها ويقيس بالأساس (الهدف × المعامل)، فضربُها هنا كان يضاعف الهدف مرّتين. ووحدة الأساس `unitId: null`.
 * و`baseUnitName` أساس الصنف كما في قائمة الأصناف المحمَّلة (يُرسل لهدف الكمية حين يُعرف — الخادم يقارنه بأساس الصنف الآن).
 * وغير هدف الكمية بلا صنفٍ ولا وحدة.
 */
export function toTargetInput(d: TargetDraft, unit: UnitChoice | null, baseUnitName?: string | null): RepTargetInput {
  const product = d.kind === 'PRODUCT_QTY';
  const base = product ? String(baseUnitName ?? '').trim() : '';
  return {
    month: d.month,
    kind: d.kind,
    targetValue: Number(readNum(d.targetValue)),
    productId: product ? d.productId : null,
    unitId: product ? (unit?.id ?? null) : null,
    ...(base ? { baseUnitName: base } : {}),
    rewardKind: d.rewardKind,
    rewardValue: Number(readNum(d.rewardValue)),
    note: String(d.note ?? '').trim() || null,
  };
}

/** عرض الشريط ٠–١٠٠ (النسبة غير مسقوفة من الخادم، وnull ⇒ ٠) */
export function barPct(pct: number | null | undefined): number {
  const n = Number(pct);
  if (pct == null || !Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** النسبة بلغة العرض («٨٥٫٥٪»)، و«—» بلا نسبة */
export function pctText(pct: number | null | undefined, locale: string): string {
  if (pct == null || !Number.isFinite(Number(pct))) return '—';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(Number(pct) / 100);
}

/** عنوان الهدف: «مبيعات الشهر» · «{الصنف} — {الوحدة}» · «تحصيل {pct}% من الديون السابقة» */
export function targetTitle(t: Pick<RepTargetView, 'kind' | 'targetValue' | 'productName' | 'unitName'>, tr: Tr, num: Fmt = String): string {
  if (t.kind === 'PRODUCT_QTY') {
    const name = (t.productName ?? '').trim() || tr('صنف محذوف');
    const unit = (t.unitName ?? '').trim();
    return unit ? `${name} — ${unit}` : name;
  }
  if (t.kind === 'COLLECTION_PCT') return tr('تحصيل {pct}% من الديون السابقة').replace('{pct}', () => num(Number(t.targetValue)));
  return tr('مبيعات الشهر');
}

/** وسم نوع الهدف ونوع المكافأة (مفتاح القاموس) */
export const targetKindLabel = (k: RepTargetKind) => TARGET_KINDS.find(x => x.kind === k)?.label ?? k;
export const rewardKindLabel = (k: RepRewardKind) => REWARD_KINDS.find(x => x.kind === k)?.label ?? k;

/**
 * قيمةٌ من قيم الهدف (المُنجَز أو الهدف أو المتبقي) بشكلها: مالٌ للمبيعات والتحصيل، وكميةٌ ومعها اسم وحدة الهدف للصنف
 * («١٢٫٥ كرتون») — رقمٌ بلا وحدةٍ يُقرأ حبّاتٍ وهو كراتين.
 */
export function targetAmountText(t: Pick<RepTargetView, 'kind' | 'unitName'>, value: number, money: Fmt, num: Fmt = String): string {
  const v = Number(value) || 0;
  if (t.kind === 'PRODUCT_QTY') {
    const unit = (t.unitName ?? '').trim();
    return unit ? `${num(v)} ${unit}` : num(v);
  }
  return money(v);
}

/** الباقي حتى الهدف (لا سالب) — يُعرض «متبقي {x}» ما لم يتحقق */
export function targetRemaining(p: Pick<RepTargetProgress, 'achieved' | 'goal'>): number {
  const r = (Number(p.goal) || 0) - (Number(p.achieved) || 0);
  return r > 1e-9 ? Math.round(r * 1e4) / 1e4 : 0;
}

/** نصّ الحالة التي لا شريط لها، أو null للحالة العادية */
export function targetStateText(p: Pick<RepTargetProgress, 'state'>): string | null {
  if (p.state === 'NO_BASE') return 'لا توجد ديون سابقة مفتوحة في بداية الشهر';
  if (p.state === 'PRODUCT_DELETED') return 'الصنف محذوف';
  return null;
}

/**
 * سطر المكافأة: «عمولة {v}% من المبيعات ≈ {amount}» (المبلغ من الخادم بصافي مبيعات الشهر حتى الآن) · «يستحق {v}% من الراتب»
 * (الراتب لا يُعرف — النسبة وحدها) · «مكافأة {amount}».
 */
export function rewardText(t: Pick<RepTargetView, 'rewardKind' | 'rewardValue' | 'reward'>, tr: Tr, money: Fmt, num: Fmt = String): string {
  const v = num(Number(t.rewardValue));
  if (t.rewardKind === 'COMMISSION_SALES_PCT') {
    const amount = t.reward?.amount;
    return amount == null || !Number.isFinite(Number(amount))
      ? tr('عمولة {v}% من المبيعات').replace('{v}', () => v)
      : tr('عمولة {v}% من المبيعات ≈ {amount}').replace('{v}', () => v).replace('{amount}', () => money(Number(amount)));
  }
  if (t.rewardKind === 'SALARY_PCT') return tr('يستحق {v}% من الراتب').replace('{v}', () => v);
  const amount = t.reward?.amount ?? t.rewardValue;
  return tr('مكافأة {amount}').replace('{amount}', () => money(Number(amount)));
}

/**
 * «متبقي {n} يوم» — بالعربية بتمييز العدد («يوم واحد»، «يومان»، «٥ أيام»، «١٢ يوماً»)، وبغيرها ترجمة العبارة والعدد
 * بأرقام العرض. الصفر (شهرٌ مضى) لا نصّ له.
 */
export function daysLeftText(n: number, lang: string, tr: Tr, num: Fmt = String): string {
  const k = Math.max(0, Math.trunc(Number(n) || 0));
  if (k === 0) return '';
  if (lang !== 'ar') return tr('متبقي {n} يوم').replace('{n}', () => num(k));
  const r = k % 100;
  const count = k === 1 ? 'يوم واحد' : k === 2 ? 'يومان' : r >= 3 && r <= 10 ? `${num(k)} أيام` : r >= 11 ? `${num(k)} يوماً` : `${num(k)} يوم`;
  return `متبقي ${count}`;
}

/** الشهر بعد/قبل n شهراً: shiftMonth('2026-01', -1) = '2025-12' */
export function shiftMonth(month: string, n: number): string {
  const m = MONTH_RE.exec(String(month ?? ''));
  if (!m) return month;
  const [y, mo] = month.split('-').map(Number);
  const idx = y * 12 + (mo - 1) + Math.trunc(n);
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

/** «نوفمبر ٢٠٢٦» بلغة العرض — بتوقيت UTC فلا ينزلق الشهر عند منتصف الليل في أي منطقة */
export function monthLabel(month: string, locale: string): string {
  if (!MONTH_RE.test(String(month ?? ''))) return String(month ?? '');
  const [y, mo] = month.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, 1)));
  } catch {
    return month;
  }
}

// ─── رسائل الرفض ───

/** رموز رفض /api/rep-targets ⇒ نصٌّ عربيّ مترجَم (رسالة الخادم عربيةٌ وحدها) */
export const TARGET_ERRORS: Record<string, string> = {
  REP_NOT_FOUND: 'المندوب غير موجود',
  TARGET_NOT_FOUND: 'الهدف غير موجود',
  TARGET_PRODUCT_INVALID: 'اختر صنفاً صحيحاً',
  TARGET_UNIT_INVALID: 'وحدة الصنف غير صحيحة',
  TARGET_LIMIT: 'وصلت للحد الأعلى من الأهداف لهذا الشهر (20)',
  // حارس أساس الصنف (backend services/baseGuard): كاش أصنافٍ قديم (400) أو تحويلٌ التزم أثناء الحفظ (409) — والنافذة تعيد جلب الأصناف
  UNIT_INVALID: 'تغيرت وحدات الصنف راجع الوحدة ثم احفظ',
  PRODUCT_UNITS_CHANGED: 'تغيرت وحدات الصنف راجع الوحدة ثم احفظ',
  PRODUCT_UNITS_BUSY: 'وحدات الصنف قيد التحديث الآن أعد المحاولة بعد لحظات',
};

/** رمز الرفض في ردّ الخادم (أو undefined) */
export function targetErrorCode(err: unknown): string | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' && code ? code : undefined;
}

/** رسالة الرفض للمستخدم: الرمز المعروف مترجَماً، وإلا رسالة الخادم (أخطاء التحقق ٤٠٠)، وإلا البديل */
export function targetErrorMessage(err: unknown, tr: Tr, fallback: string): string {
  const d = (err as { response?: { data?: { code?: string; message?: string } } } | null)?.response?.data;
  const code = targetErrorCode(err);
  const ar = code ? TARGET_ERRORS[code] : undefined;
  if (ar) return tr(ar);
  return (typeof d?.message === 'string' && d.message.trim()) || fallback;
}

// ─── تطبيق المندوب: متى يُعاد الجلب ───

/** أقلّ فاصلٍ بين جلبين للبطاقة حين تُفتح الرئيسية بتبديل التبويب — قاعدة البيانات عنق الزجاجة لا الواجهة */
export const TARGETS_REFETCH_GAP_MS = 30_000;

/**
 * هل تجلب الرئيسية الأهداف الآن؟ نعم بلا جلبٍ سابق، أو بعد مستندٍ أو مزامنة (`refreshKey` تغيّر عن آخر جلب)، أو بعد ٣٠ ثانية.
 * وإلّا تكفي النسخة المحفوظة المعروضة فوراً.
 */
export function targetsFetchDue(last: { at: number; key: number } | null, refreshKey: number, now: number, gapMs = TARGETS_REFETCH_GAP_MS): boolean {
  if (!last) return true;
  if (last.key !== refreshKey) return true;
  return now - last.at >= gapMs || now < last.at;
}

/** كل عبارةٍ عربية تُنتجها الدوالّ أعلاه أو تُمرّرها إلى tr — حارس القاموس (repTargets.test.ts) */
export const REP_TARGET_TEXTS: readonly string[] = [
  ...TARGET_KINDS.map(k => k.label),
  ...REWARD_KINDS.map(k => k.label),
  ...new Set([...Object.values(VALUE_ZERO), ...Object.values(VALUE_BIG), ...Object.values(REWARD_ZERO), ...Object.values(REWARD_BIG)]),
  'الشهر غير صحيح',
  'نوع الهدف غير صحيح',
  'نوع المكافأة غير صحيح',
  'الملاحظة 300 حرف على الأكثر',
  'صنف محذوف',
  'تحصيل {pct}% من الديون السابقة',
  'مبيعات الشهر',
  'لا توجد ديون سابقة مفتوحة في بداية الشهر',
  'الصنف محذوف',
  'عمولة {v}% من المبيعات',
  'عمولة {v}% من المبيعات ≈ {amount}',
  'يستحق {v}% من الراتب',
  'مكافأة {amount}',
  'متبقي {n} يوم',
  ...new Set(Object.values(TARGET_ERRORS)),
];
