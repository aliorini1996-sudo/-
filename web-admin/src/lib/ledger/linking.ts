import type { EventStatus } from '../../api/ledgerReview';
import type {
  EventCountRow, GlLinkPreviewSummary, GlLinkPreviewView, LinkBasis, LinkingMilestone, LocationKey, MilliText,
  OpeningPreview, ParityCheck, ParityCode, ParityDrillRow, ParityPartnerType, ParityReasonCode, ParityScope, ParityStatus, PreflightCheck,
  PreflightCode, PreflightLevel, PreflightReport, PreviewErrorCode, PreviewPhase, PreviewStatus, StatementPreviewLine,
  InventoryMode, HeldLine, OpeningPreviewLine,
} from '../../api/ledgerLinking';
import type { User } from '../../types';
import { ledgerErrorMessage, type LedgerErrorLike } from './errors';
import type { Tone } from './sync';

/**
 * منطق صفحة «ربط الدفاتر بالنظام (معاينة)» `/app/ledger/linking` (العقد l23 §15) — **صرف** بلا React ولا شبكة،
 * مختبَر في linking.test.ts. التسميات بنداءات tr حرفية (حارس langs.test)، ونصوص الخادم العربية (titleAr، details،
 * reason، error، headroomNote) لا تُعرض خاماً في الواجهة غير العربية (§8.7): لكل رمز تسمية مترجمة هنا.
 *
 * كل مبلغ نصّ ملّي من الخادم ويُحسب بـBigInt وحده (لا Number على مبلغ): الفرز والمجاميع وفحص التوازن.
 */

type Tr = (ar: string) => string;

// ═══ الملّي ═══

/** نصّ ملّي ⇒ bigint؛ غير الصالح (null أو نصّ تالف) صفر — فلا يتسرّب NaN إلى جدول محاسبي */
export function toBig(m: MilliText | number | bigint | null | undefined): bigint {
  if (m === null || m === undefined) return 0n;
  if (typeof m === 'bigint') return m;
  if (typeof m === 'number') return Number.isFinite(m) ? BigInt(Math.round(m)) : 0n;
  const s = m.trim();
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

export const absBig = (v: bigint): bigint => (v < 0n ? -v : v);

/** Σ نصوص ملّي ⇒ نصّ ملّي */
export function sumMilli(values: readonly (MilliText | null | undefined)[]): MilliText {
  let t = 0n;
  for (const v of values) t += toBig(v);
  return t.toString();
}

export const isZeroMilliText = (m: MilliText | null | undefined): boolean => toBig(m) === 0n;

// ═══ الحالة والمرحلة والاستطلاع ═══

export const PREVIEW_POLL_MS = 2_000;

export const isActivePreview = (s: PreviewStatus | null | undefined): boolean => s === 'QUEUED' || s === 'RUNNING';

/** فاصل استطلاع GET /preview/:id: كل ثانيتين ما دامت QUEUED/RUNNING، وإلا يتوقف */
export function previewPollInterval(s: PreviewStatus | null | undefined): number | false {
  return isActivePreview(s) ? PREVIEW_POLL_MS : false;
}

/** استطلاع القائمة نفسها: كل عشر ثوانٍ ما دامت فيها جارية لا يستطلعها عرض المعاينة (اختار المستخدم غيرها) — وإلا لا */
export const PREVIEW_LIST_POLL_MS = 10_000;
export function previewListPollInterval(list: readonly Pick<GlLinkPreviewSummary, 'id' | 'status'>[] | undefined, polledId: string | null): number | false {
  return (list ?? []).some(p => isActivePreview(p.status) && p.id !== polledId) ? PREVIEW_LIST_POLL_MS : false;
}

/** شريط التقدّم: النسبة مقصوصة إلى 0..100، وDONE مئة دائماً، والمرحلة الغائبة من الحالة */
export function previewProgress(v: Pick<GlLinkPreviewView, 'status' | 'phase' | 'progressPct'>): { pct: number; phase: PreviewPhase } {
  if (v.status === 'DONE') return { pct: 100, phase: 'DONE' };
  const raw = Number.isFinite(v.progressPct) ? Math.round(v.progressPct) : 0;
  const pct = Math.max(0, Math.min(v.status === 'FAILED' ? 100 : 99, raw));
  return { pct, phase: v.phase ?? 'QUEUED' };
}

const timeOf = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const createdDesc = (a: GlLinkPreviewSummary, b: GlLinkPreviewSummary): number =>
  timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** المعاينات الأحدث أولاً بـ(createdAt، id) — ترتيب حتمي ولو تساوى الوقت */
export function sortPreviews(list: readonly GlLinkPreviewSummary[]): GlLinkPreviewSummary[] {
  return [...list].sort(createdDesc);
}

/**
 * «آخر معاينة» تُعرض: ما اختاره المستخدم صراحةً (من القائمة أو التي شغّلها للتوّ)، وإلا الجارية (واحدة للشركة)،
 * وإلا أحدث مكتملة بالأساس المختار، وإلا أحدث مكتملة، وإلا أحدث معاينة (ولو فاشلة) — null إن لا شيء.
 */
export function pickPreviewId(list: readonly GlLinkPreviewSummary[], opts: { explicitId?: string | null; basis?: LinkBasis | null } = {}): string | null {
  if (opts.explicitId) return opts.explicitId;
  const sorted = sortPreviews(list);
  const active = sorted.find(p => isActivePreview(p.status));
  if (active) return active.id;
  const doneSame = opts.basis ? sorted.find(p => p.status === 'DONE' && p.basis === opts.basis) : undefined;
  if (doneSame) return doneSame.id;
  const done = sorted.find(p => p.status === 'DONE');
  if (done) return done.id;
  return sorted[0]?.id ?? null;
}

/**
 * جدول الفحوص المسبقة: LIGHT من GET /preflight فوراً، ويُستبدل بـFULL من نتيجة المعاينة المكتملة **للأساس نفسه**
 * (الأساس يغيّر linkedFrom فتختلف الفحوص) — null حين لا هذا ولا ذاك.
 */
export function pickPreflight(
  light: PreflightReport | null | undefined,
  view: Pick<GlLinkPreviewView, 'status' | 'result'> | null | undefined,
  basis: LinkBasis,
): { report: PreflightReport; source: 'LIGHT' | 'FULL' } | null {
  const full = view?.status === 'DONE' ? view.result?.preflight ?? null : null;
  if (full && full.basis === basis) return { report: full, source: 'FULL' };
  // LIGHT يُجلب بمفتاح الأساس نفسه (ledgerLinkingKeys.preflight(basis))؛ التحقق يمنع عرض أساسٍ آخر من ذاكرةٍ قديمة
  if (light && light.basis === basis) return { report: light, source: 'LIGHT' };
  return null;
}

/** عدّ الفحوص: B وW غير المتحققة (لا تُحتسب «لا ينطبق»)، والناجحة */
export function preflightCounts(report: Pick<PreflightReport, 'checks'>): { blocking: number; warnings: number; passed: number; notApplicable: number } {
  let blocking = 0; let warnings = 0; let passed = 0; let notApplicable = 0;
  for (const c of report.checks) {
    if (c.notApplicable) { notApplicable++; continue; }
    if (c.ok) passed++;
    else if (c.level === 'B') blocking++;
    else warnings++;
  }
  return { blocking, warnings, passed, notApplicable };
}

type ParityApplicability = Pick<ParityCheck, 'status' | 'availableIn' | 'reason' | 'reasonCode'>;

/**
 * «لا ينطبق»: NOT_AVAILABLE لا تضيفه أي مرحلة (availableIn = null صراحةً) ومعه سببه من الخادم، رمزاً أو نصّاً — مثل R8
 * لشركة بجرد دوري (OD7). لا يُعرض له «يُضاف في Lx»، ولا يُعدّ «غير متاح بعد»، وتعمّقه للاطلاع لا فروق.
 */
export function isParityNotApplicable(c: ParityApplicability): boolean {
  return c.status === 'NOT_AVAILABLE' && c.availableIn === null && !!(c.reasonCode || c.reason);
}

/** حالة العرض: حالة الخادم، و«لا ينطبق» لما لا تضيفه أي مرحلة */
export type ParityDisplayStatus = ParityStatus | 'NOT_APPLICABLE';
export const parityDisplayStatus = (c: ParityApplicability): ParityDisplayStatus => (isParityNotApplicable(c) ? 'NOT_APPLICABLE' : c.status);

/** عدّ المطابقات بحالة عرضها */
export function parityCounts(checks: readonly ParityApplicability[]): { ok: number; mismatch: number; notAvailable: number; notApplicable: number } {
  let ok = 0; let mismatch = 0; let notAvailable = 0; let notApplicable = 0;
  for (const c of checks) {
    const s = parityDisplayStatus(c);
    if (s === 'OK') ok++;
    else if (s === 'MISMATCH') mismatch++;
    else if (s === 'NOT_APPLICABLE') notApplicable++;
    else notAvailable++;
  }
  return { ok, mismatch, notAvailable, notApplicable };
}

// ═══ القوائم المقصوصة (capResult في الخادم) ═══

/**
 * حالة قائمة يقصّها الخادم ليبقى حجم النتيجة ضمن سقفها، بعدد المحفوظ منها وعدّاد المقصوص (…Truncated):
 * EMPTY فارغة حقاً (فـ«لا شيء» صادقة)، وALL_TRUNCATED قُصّت كلها (فلا يُقال «لا شيء»)، وSHOWN فيها ما يُعرض.
 */
export type CappedListState = 'EMPTY' | 'ALL_TRUNCATED' | 'SHOWN';
export function cappedListState(kept: number, truncated: number | null | undefined): CappedListState {
  if (kept > 0) return 'SHOWN';
  return typeof truncated === 'number' && truncated > 0 ? 'ALL_TRUNCATED' : 'EMPTY';
}

/** يُفتح صفّ المطابقة إن كان فيه ما يُعرض: تعمّق محفوظ أو مقصوص، أو info */
export function parityExpandable(c: Pick<ParityCheck, 'drill' | 'drillTruncated' | 'info'>): boolean {
  return c.drill.length > 0 || (c.drillTruncated ?? 0) > 0 || infoEntries(c.info).length > 0;
}

/** يُفتح الفحص المسبق إن كان فيه ما يُعرض بهذه اللغة: عناصر محفوظة أو مقصوصة، أو تفاصيل الخادم (للعربية وحدها) */
export function preflightExpandable(c: Pick<PreflightCheck, 'items' | 'itemsTruncated' | 'details'>, lang: string): boolean {
  return (c.items?.length ?? 0) > 0 || (c.itemsTruncated ?? 0) > 0 || (lang === 'ar' && !!c.details);
}

// ═══ التعمّق ═══

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** فرز التعمّق كالخادم: |الفرق| تنازلياً ثم معرّف الشريك ثم الاسم (حتمي) */
export function sortDrill(rows: readonly ParityDrillRow[]): ParityDrillRow[] {
  return [...rows].sort((a, b) => {
    const da = absBig(toBig(a.diffMilli)); const db = absBig(toBig(b.diffMilli));
    if (da !== db) return da > db ? -1 : 1;
    return cmpStr(a.partnerId ?? '', b.partnerId ?? '') || cmpStr(a.name ?? '', b.name ?? '');
  });
}

/** صفوف التعمّق المعروضة: مرتّبة، وبالفروق وحدها إن طُلب */
export function visibleDrill(rows: readonly ParityDrillRow[], onlyDiff: boolean): ParityDrillRow[] {
  const sorted = sortDrill(rows);
  return onlyDiff ? sorted.filter(r => toBig(r.diffMilli) !== 0n) : sorted;
}

/** مفاتيح info: ما ينتهي بـMilli مبلغ، والباقي نصّ أو رقم */
export function infoEntries(info: ParityCheck['info']): { key: string; value: string | number | null; milli: boolean }[] {
  if (!info) return [];
  return Object.keys(info).sort().map(key => ({ key, value: info[key], milli: /Milli$/.test(key) }));
}

// ═══ الأحداث ═══

/** ترتيب الحالات في جدول أعداد الأحداث: المرحَّل ثم المتخطّى ثم ما يحتاج انتباهاً */
export const EVENT_COUNT_STATUS_ORDER: readonly EventStatus[] = ['DONE', 'SKIPPED', 'PENDING', 'BLOCKED', 'ERROR', 'HELD'];

export interface EventCountPivot {
  statuses: EventStatus[];
  rows: { sourceType: string; event: string; counts: Partial<Record<EventStatus, number>>; total: number }[];
  totals: Partial<Record<EventStatus, number>>;
  total: number;
  /** الأسباب (تخطٍّ/حجز/حجب) لغير المرحَّل، الأكثر أولاً */
  reasons: { status: EventStatus; reason: string; count: number }[];
}

/** أعداد الأحداث بالنوع والحالة (eventCounts) ⇒ جدول محوري حتمي */
export function pivotEventCounts(rows: readonly EventCountRow[]): EventCountPivot {
  const byKey = new Map<string, EventCountPivot['rows'][number]>();
  const totals: Partial<Record<EventStatus, number>> = {};
  const reasons = new Map<string, { status: EventStatus; reason: string; count: number }>();
  const seen = new Set<EventStatus>();
  let total = 0;
  for (const r of rows) {
    const n = Number.isFinite(r.count) ? r.count : 0;
    const k = `${r.sourceType}\u0000${r.event}`;
    let row = byKey.get(k);
    if (!row) { row = { sourceType: r.sourceType, event: r.event, counts: {}, total: 0 }; byKey.set(k, row); }
    row.counts[r.status] = (row.counts[r.status] ?? 0) + n;
    row.total += n;
    totals[r.status] = (totals[r.status] ?? 0) + n;
    total += n;
    seen.add(r.status);
    if (r.reason && r.status !== 'DONE') {
      const rk = `${r.status}\u0000${r.reason}`;
      const x = reasons.get(rk) ?? { status: r.status, reason: r.reason, count: 0 };
      x.count += n;
      reasons.set(rk, x);
    }
  }
  const order = [...EVENT_COUNT_STATUS_ORDER, ...[...seen].filter(s => !EVENT_COUNT_STATUS_ORDER.includes(s)).sort()];
  return {
    statuses: order.filter(s => seen.has(s)),
    rows: [...byKey.values()].sort((a, b) => cmpStr(a.sourceType, b.sourceType) || cmpStr(a.event, b.event)),
    totals,
    total,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count || cmpStr(a.status, b.status) || cmpStr(a.reason, b.reason)),
  };
}

// ═══ القيد الافتتاحي وميزان الشهور ═══

/** توازن القيد الافتتاحي من سطوره المعروضة ومن مجاميع الخادم: Σ المدين = Σ الدائن بالملّي */
export function openingBalanceCheck(o: Pick<OpeningPreview, 'lines' | 'linesTruncated' | 'totals'>): {
  balanced: boolean; diffMilli: MilliText; linesMatchTotals: boolean | null;
} {
  const d = toBig(o.totals.debitMilli); const c = toBig(o.totals.creditMilli);
  // السطور المقصوصة لا تُجمع (مجموعها ليس الكل) — المطابقة مع المجاميع لا تُعرف حينها
  let linesMatchTotals: boolean | null = null;
  if (!o.linesTruncated) {
    let ld = 0n; let lc = 0n;
    for (const l of o.lines) { ld += toBig(l.debitMilli); lc += toBig(l.creditMilli); }
    linesMatchTotals = ld === d && lc === c;
  }
  return { balanced: d === c, diffMilli: (d - c).toString(), linesMatchTotals };
}

/** صافي حركة الشهر (مدين − دائن) */
export function monthNetMilli(m: { debitMilli: MilliText; creditMilli: MilliText } | undefined): MilliText {
  if (!m) return '0';
  return (toBig(m.debitMilli) - toBig(m.creditMilli)).toString();
}

/** خلية شهر لصفّ ميزان: الصفّ قد لا يحمل كل الشهور (الخادم يرسل ما فيه حركة) */
export function monthCell(row: { months: { month: string; debitMilli: MilliText; creditMilli: MilliText }[] }, month: string) {
  return row.months.find(m => m.month === month);
}

// ═══ التسميات ═══

export const linkBasisLabels = (tr: Tr): Record<LinkBasis, string> => ({
  FY_RESTATED: tr('من بداية السنة المالية (بأثر رجعي)'),
  FROM_ACTIVATION: tr('من يوم التفعيل'),
});

export const linkBasisHints = (tr: Tr): Record<LinkBasis, string> => ({
  FY_RESTATED: tr('تُرحَّل حركات السنة المالية الحالية كلها بتواريخها، والافتتاحي يحمل أرصدة ما قبلها'),
  FROM_ACTIVATION: tr('القيد الافتتاحي بأرصدة اليوم، وتُرحَّل الحركات من يوم التفعيل وحده'),
});

export const previewStatusLabels = (tr: Tr): Record<PreviewStatus, string> => ({
  QUEUED: tr('في الانتظار'),
  RUNNING: tr('قيد التشغيل'),
  DONE: tr('اكتملت'),
  FAILED: tr('فشلت'),
});

export const previewPhaseLabels = (tr: Tr): Record<PreviewPhase, string> => ({
  QUEUED: tr('في طابور المعاينات'),
  READ: tr('قراءة لقطة البيانات'),
  COSTING: tr('حساب تكلفة المخزون'),
  OPENING: tr('بناء القيد الافتتاحي'),
  RECONCILE: tr('اشتقاق أحداث المستندات'),
  POST: tr('ترحيل تجريبي في الذاكرة'),
  PARITY: tr('مطابقة الأرصدة'),
  PREFLIGHT: tr('الفحوص المسبقة'),
  DONE: tr('اكتملت'),
});

export const previewErrorLabels = (tr: Tr): Record<PreviewErrorCode, string> => ({
  INTERRUPTED: tr('انقطعت المعاينة قبل اكتمالها، شغّلها من جديد'),
  TIMEOUT: tr('تجاوزت المعاينة المهلة المسموحة'),
  TOO_LARGE: tr('حجم البيانات أكبر من سقف المعاينة'),
  SHADOW_GL_ACCESS: tr('أُوقفت المعاينة حمايةً للدفاتر: وصول غير مدعوم، ولا رقم معروض منها'),
  ALREADY_ACTIVATED: tr('الدفاتر مفعّلة بالفعل'),
  INTERNAL: tr('خطأ داخلي في المعاينة'),
});

export function previewErrorText(tr: Tr, code: string | null | undefined): string {
  return (code && (previewErrorLabels(tr) as Record<string, string>)[code]) || tr('فشلت المعاينة');
}

export const preflightLevelLabels = (tr: Tr): Record<PreflightLevel, string> => ({
  B: tr('يحجب الاعتماد'),
  W: tr('تحذير'),
});

/** عناوين الفحوص المسبقة (العقد §12) — titleAr الخادم احتياطٌ لرمز مجهول */
export const preflightTitles = (tr: Tr): Record<PreflightCode, string> => ({
  P1: tr('تفعيل النظام المحاسبي ومعالج الترحيل'),
  P2: tr('تأكيد نهاية السنة المالية'),
  P3: tr('عملة الشركة وعملة الدفاتر'),
  P4: tr('تواريخ الإقفال قبل تاريخ الربط'),
  P5: tr('لا استيراد جارٍ، والمخزون الافتتاحي المستورد سليم'),
  P6: tr('تكامل أودو: ازدواج الدفاتر'),
  P7: tr('نسب ضريبة البيع ومربعات الإقرار'),
  P8: tr('مسارات طرق الدفع'),
  P9: tr('رصيد بلا تكلفة في بداية السنة'),
  P10: tr('تسعير الوارد وسدّ الرصيد السالب'),
  P11: tr('مناديب محذوفون وفواتير بلا مندوب ومستندات مستقبلية'),
  P12: tr('فروق تقريب مبالغ الفواتير'),
  P13: tr('الحجم والتخزين والوقت'),
  P14: tr('تحويل دفاتر يدوية قائمة'),
});

/** عناوين المطابقات (العقد §13) */
export const parityTitles = (tr: Tr): Record<ParityCode, string> => ({
  R1: tr('توازن القيود وفرق الأرصدة الافتتاحية'),
  R2: tr('ذمم العملاء لكل عميل'),
  R3: tr('عهدة المناديب لكل مندوب'),
  R4: tr('عهدة المستخدمين'),
  R5: tr('أمانات الدفع الإلكتروني'),
  R6: tr('صافي المبيعات الشهري'),
  R7: tr('ضريبة المخرجات بالفترة والمربع'),
  R8: tr('المخزون لكل موقع'),
  R9: tr('تكلفة البضاعة المباعة للسنة'),
  R10: tr('ذمم الموردين لكل مورد'),
  R11: tr('الوارد غير المصنف'),
  R12: tr('سجل ضريبة المشتريات'),
  R13: tr('اكتمال الترحيل وخلو حساب التعليق'),
});

/** سبب «غير متاح بعد» لكل مطابقة مؤجّلة (مرآة reason في parity.ts بالعربية) */
export const parityPendingReasons = (tr: Tr): Partial<Record<ParityCode, string>> => ({
  R4: tr('عهدة المستخدمين 111004 تُضاف في L5'),
  R6: tr('مطابقة صافي المبيعات الشهري تُضاف في L4'),
  R7: tr('ضريبة المخرجات بالفترة والمربع من المستندات تُضاف في L4'),
  R8: tr('قيود حركات المخزون تُضاف في L6'),
  R9: tr('قيد تكلفة المبيعات يُضاف في L4'),
  R10: tr('قيود المشتريات والموردين تُضاف في L6'),
  R11: tr('قيود الوارد غير المصنف تُضاف في L6'),
  R12: tr('سجل ضريبة المشتريات يُضاف في L6'),
  R13: tr('اكتمال الترحيل وخلو 911001 يُحسم عند الاعتماد'),
});

export const milestoneText = (tr: Tr, m: LinkingMilestone | null | undefined): string => (m ? tr('يُضاف في {milestone}').replace('{milestone}', m) : tr('يُضاف في مرحلة لاحقة'));

/** سبب «لا ينطبق» برمز الخادم (reasonCode) — مترجماً في كل اللغات */
export const parityReasonCodeLabels = (tr: Tr): Record<ParityReasonCode, string> => ({
  INVENTORY_PERIODIC: tr('لا ينطبق: جرد دوري، فلا تحمل الدفاتر رصيد مخزون مستمراً ولا مطابقة له في أي مرحلة'),
});

/**
 * نصّ سبب ما لم يُطابَق: «لا ينطبق» أولاً (برمز الخادم مترجماً، وإلا نصّه للعربية، وإلا «لا ينطبق على هذه الشركة») —
 * فلا تُلصق به تسمية «تُضاف في Lx» الثابتة. ثم «غير متاح بعد»: تسميتنا المترجمة، وإلا نصّ الخادم للعربية، وإلا «يُضاف في Lx».
 */
export function parityReasonText(tr: Tr, c: Pick<ParityCheck, 'code' | 'status' | 'reason' | 'reasonCode' | 'availableIn'>, lang: string): string | null {
  if (c.status !== 'NOT_AVAILABLE') return null;
  if (isParityNotApplicable(c)) {
    const coded = c.reasonCode ? (parityReasonCodeLabels(tr) as Record<string, string>)[c.reasonCode] : undefined;
    if (coded) return coded;
    if (lang === 'ar' && c.reason) return c.reason;
    return tr('لا ينطبق على هذه الشركة');
  }
  const own = parityPendingReasons(tr)[c.code];
  if (own) return own;
  if (lang === 'ar' && c.reason) return c.reason;
  return milestoneText(tr, c.availableIn);
}

export const parityStatusLabels = (tr: Tr): Record<ParityDisplayStatus, string> => ({
  OK: tr('مطابق'),
  MISMATCH: tr('فرق'),
  NOT_AVAILABLE: tr('غير متاح بعد'),
  NOT_APPLICABLE: tr('لا ينطبق'),
});

export const parityScopeLabels = (tr: Tr): Record<ParityScope, string> => ({
  FULL: tr('مطابقة كاملة'),
  OPENING_ONLY: tr('الافتتاح وحده'),
  NONE: tr('بلا مطابقة'),
});

export const partnerTypeLabels = (tr: Tr): Record<ParityPartnerType, string> => ({
  CUSTOMER: tr('عميل'),
  REP: tr('مندوب'),
  VENDOR: tr('مورد'),
  LOCATION: tr('موقع'),
  MOVE: tr('قيد'),
  ACCOUNT: tr('حساب'),
});

export const openingOriginLabels = (tr: Tr): Record<OpeningPreviewLine['origin'], string> => ({
  DERIVED: tr('مشتق من التشغيل'),
  MANUAL: tr('يدوي'),
  EQUITY: tr('فرق الأرصدة الافتتاحية'),
});

export const heldKindLabels = (tr: Tr): Record<HeldLine['kind'], string> => ({
  EVENT: tr('حدث محجوز'),
  SUSPENSE_LINE: tr('سطر على حساب التعليق'),
});

export const inventoryModeLabels = (tr: Tr): Record<InventoryMode, string> => ({
  PERPETUAL: tr('جرد مستمر'),
  PERIODIC: tr('جرد دوري'),
});

/** تحذيرات النتيجة المعروفة — غيرها برسالته للعربية وبرمزه لغيرها */
export const linkingWarningLabels = (tr: Tr): Record<string, string> => ({
  RESULT_TRUNCATED: tr('قُصّت بعض القوائم لتبقى النتيجة ضمن الحجم المسموح'),
});

export function linkingWarningText(tr: Tr, w: { code: string; message: string }, lang: string): string {
  return linkingWarningLabels(tr)[w.code] ?? (lang === 'ar' && w.message ? w.message : w.code);
}

/** أسباب رفض صفوف الأرصدة اليدوية في المعاينة: DERIVED_ACCOUNT للربط، والبقية كمعالج الإعداد */
export const linkingManualIssueLabels = (tr: Tr): Record<string, string> => ({
  DERIVED_ACCOUNT: tr('هذا الحساب يُشتق من التشغيل في الربط (الذمم والعهدة والأمانات والمخزون)، فاحذف رصيده اليدوي'),
  ACCOUNT_NOT_FOUND: tr('الحساب غير موجود'),
  ACCOUNT_ARCHIVED: tr('الحساب مؤرشف'),
  OPENING_EQUITY: tr('حساب الأرصدة الافتتاحية يأخذ الفرق آليا'),
  EQUITY_UNAFFECTED: tr('أرباح السنة الجارية يحسبها النظام'),
  OFF_BALANCE: tr('لا تُدخل أرصدة افتتاحية لحسابات خارج الميزانية'),
  VAT_REQUIRES_MID_PERIOD: tr('أرصدة ضريبة المخرجات والمدخلات للفترة المفتوحة تُقبل فقط مع تاريخ بدء مؤكد داخل فترة إقرار'),
  VENDOR_REQUIRED: tr('سطر الموردين يتطلب اسم المورد'),
  INVALID_AMOUNT: tr('مبلغ غير صالح'),
  NEGATIVE_AMOUNT: tr('المبلغ لا يكون سالبا'),
  DEBIT_AND_CREDIT: tr('السطر لا يحمل مدينا ودائنا معا'),
  ZERO_AMOUNT: tr('سطر بلا مبلغ'),
  INVALID_DUE_DATE: tr('تاريخ الاستحقاق غير صالح'),
  CUSTOMER_REQUIRED: tr('سطر ذمم العملاء يتطلب العميل'),
  CUSTOMER_NOT_FOUND: tr('العميل غير موجود: اكتب رمزه أو اسمه كما في قائمة العملاء'),
  CUSTOMER_AMBIGUOUS: tr('أكثر من عميل بهذا الاسم: اكتب رمز العميل'),
  SALES_REP_REQUIRED: tr('سطر عهدة المناديب يتطلب المندوب'),
  SALES_REP_NOT_FOUND: tr('المندوب غير موجود'),
  SALES_REP_AMBIGUOUS: tr('أكثر من مندوب بهذا الاسم: اختره من القائمة'),
});

export function linkingManualIssueText(tr: Tr, reason: string): string {
  return linkingManualIssueLabels(tr)[reason] ?? reason;
}

/** عنوان فحص مسبق: تسميتنا، وإلا titleAr للعربية وحدها، وإلا الرمز */
export function preflightTitle(tr: Tr, c: Pick<PreflightCheck, 'code' | 'titleAr'>, lang: string): string {
  return (preflightTitles(tr) as Record<string, string>)[c.code] ?? (lang === 'ar' && c.titleAr ? c.titleAr : c.code);
}

export function parityTitle(tr: Tr, c: Pick<ParityCheck, 'code' | 'titleAr'>, lang: string): string {
  return (parityTitles(tr) as Record<string, string>)[c.code] ?? (lang === 'ar' && c.titleAr ? c.titleAr : c.code);
}

// ═══ النغمات ═══

export function previewStatusTone(s: PreviewStatus): Tone {
  return s === 'DONE' ? 'green' : s === 'FAILED' ? 'red' : 'blue';
}

export function parityTone(s: ParityDisplayStatus): Tone {
  return s === 'OK' ? 'green' : s === 'MISMATCH' ? 'red' : 'gray';
}

/** الفحص: ناجح أخضر، «لا ينطبق» رمادي، حاجب فاشل أحمر، تحذير فاشل كهرماني */
export function preflightTone(c: Pick<PreflightCheck, 'ok' | 'level' | 'notApplicable'>): Tone {
  if (c.notApplicable) return 'gray';
  if (c.ok) return 'green';
  return c.level === 'B' ? 'red' : 'amber';
}

// ═══ أسطر القائمتين ═══

/*
 * تسميات أسطر القائمتين بمفاتيح الخادم — **نسخة** جدول التقارير المترجم (pages/ledger/reports/statementLines.ts)
 * بالنصوص العربية نفسها حرفاً (فترجماتها قائمة). لا تُستورد منه عمداً: استيراده يجرّ قشرة التقارير (ReportView
 * والمفضلات والمزامنة) إلى شجرة الصفحة فيحسبها حارس ledgerMenuPerms كتابات لها. linking.test.ts يطابق النسختين.
 */
export const linkingIncomeLineLabels = (tr: Tr): Record<string, string> => ({
  grossRevenue: tr('إجمالي المبيعات والإيرادات'),
  salesDeductions: tr('يُطرح: مردودات وخصومات المبيعات'),
  revenue: tr('صافي الإيرادات'),
  costOfRevenue: tr('تكلفة البضاعة المباعة'),
  grossProfit: tr('مجمل الربح'),
  operatingExpenses: tr('المصروفات التشغيلية'),
  operatingIncome: tr('الربح التشغيلي'),
  otherIncome: tr('إيرادات أخرى'),
  otherExpenses: tr('مصروفات أخرى'),
  profitBeforeZakat: tr('صافي الربح قبل الزكاة'),
  zakat: tr('الزكاة وضريبة الدخل'),
  netProfit: tr('صافي الربح'),
  drawings: tr('التخصيصات والمسحوبات'),
  netProfitAfterDrawings: tr('صافي الربح المتبقي بعد المخصصات والمسحوبات'),
});

export const linkingOperatingLossLabel = (tr: Tr): string => tr('الخسارة التشغيلية');

export const linkingIncomeGroupLabels = (tr: Tr): Record<string, string> => ({
  selling: tr('مصروفات البيع والتوزيع'),
  admin: tr('المصروفات العمومية والإدارية'),
  otherOperating: tr('مصروفات تشغيلية أخرى'),
  depreciation: tr('الإهلاك'),
});

export const linkingBalanceLineLabels = (tr: Tr): Record<string, string> => ({
  assets: tr('الأصول'),
  currentAssets: tr('الأصول المتداولة'),
  assetCash: tr('الحسابات البنكية والنقدية'),
  assetReceivable: tr('المدينون'),
  assetCurrent: tr('أصول متداولة أخرى'),
  assetPrepayments: tr('المدفوعات المقدمة'),
  fixedAssets: tr('الأصول الثابتة'),
  nonCurrentAssets: tr('الأصول غير المتداولة'),
  liabilities: tr('الالتزامات'),
  currentLiabilities: tr('الالتزامات المتداولة'),
  liabilityCurrent: tr('الالتزامات المتداولة'),
  liabilityCreditCard: tr('البطاقة الائتمانية'),
  liabilityPayable: tr('الدائنون'),
  nonCurrentLiabilities: tr('الالتزامات غير المتداولة'),
  equity: tr('حقوق الملكية'),
  capitalAndReserves: tr('رأس المال والاحتياطيات'),
  earnings: tr('الأرباح'),
  currentYearEarnings: tr('أرباح السنة الجارية غير الموزعة'),
  previousYearsEarnings: tr('أرباح سنوات سابقة'),
  liabilitiesAndEquity: tr('الالتزامات + حقوق الملكية'),
});

/**
 * تسمية سطر قائمة الدخل أو الميزانية في المعاينة من مفتاحه (نسخة جدول التقارير المترجم أعلاه):
 * `key` سطرٌ (`revenue`)، و`key.group` مجموعة، و`…:code` حساب (يُعرض «الرمز — الاسم» كما وصل).
 * المفتاح المجهول يرتدّ إلى labelAr فلا يسقط سطر جديد صامتاً.
 */
export function statementLineLabel(tr: Tr, line: Pick<StatementPreviewLine, 'key' | 'labelAr' | 'amountMilli'>): string {
  const { key } = line;
  if (key.includes(':')) return line.labelAr;
  const parts = key.split('.');
  if (parts.length > 1) {
    return linkingIncomeGroupLabels(tr)[parts[parts.length - 1]] ?? line.labelAr;
  }
  if (key === 'operatingIncome' && toBig(line.amountMilli) < 0n) return linkingOperatingLossLabel(tr);
  return linkingIncomeLineLabels(tr)[key] ?? linkingBalanceLineLabels(tr)[key] ?? line.labelAr;
}

/** سطر حساب داخل القائمة (للخط الأنحف) */
export const isStatementAccountLine = (line: Pick<StatementPreviewLine, 'key'>): boolean => line.key.includes(':');

// ═══ متفرّقات العرض ═══

/** الموقع: المستودع، أو «سيارة مجهولة»، أو «سيارة — <الاسم أو بداية المعرّف>» */
export function locationLabel(tr: Tr, loc: LocationKey | string, names?: Readonly<Record<string, string>> | null): string {
  if (loc === 'WH') return tr('المستودع');
  if (loc === 'VAN:_') return tr('سيارة غير معروفة');
  if (loc.startsWith('VAN:')) {
    const rep = loc.slice(4);
    return `${tr('سيارة')} — ${names?.[rep] ?? rep.slice(0, 8)}`;
  }
  return loc;
}

/** ترتيب المواقع: المستودع ثم السيارات بمعرّفها (كسطور القيد الافتتاحي) */
export function sortLocations<T extends { location: string }>(rows: readonly T[]): T[] {
  const rank = (l: string) => (l === 'WH' ? 0 : l === 'VAN:_' ? 2 : 1);
  return [...rows].sort((a, b) => rank(a.location) - rank(b.location) || cmpStr(a.location, b.location));
}

/** بصمة مختصرة للعرض (الكاملة في title) */
export function shortHash(h: string | null | undefined, n = 12): string {
  if (!h) return '—';
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

/** حجم بالبايت ⇒ «1.4 MB» (أرقام لاتينية: وحدة تقنية تُقرأ يساراً) */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** مدة بالدقائق ⇒ نصّ: دقائق تحت الساعة، وساعات تحت يومين، وأيام بعدها */
export function durationText(tr: Tr, minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return `0 ${tr('دقيقة')}`;
  if (minutes < 60) return `${Math.max(1, Math.ceil(minutes))} ${tr('دقيقة')}`;
  const h = minutes / 60;
  if (h < 48) return `${Math.round(h * 10) / 10} ${tr('ساعة')}`;
  return `${Math.round((h / 24) * 10) / 10} ${tr('يوم')}`;
}

// ═══ الصلاحية والأخطاء ═══

/**
 * مالك الشركة في الواجهة (تلميح؛ الحَكَم requireCompanyOwner في الخادم يقرأ القاعدة ومنها isActive): جلسة
 * مالك المنصّة، أو ADMIN بـcanManageCompanyUsers غير مقيّد النطاق.
 */
export function isLinkingOwner(user: Pick<User, 'role' | 'canManageCompanyUsers' | 'scopeEnabled'> | null | undefined, impersonating?: string | null): boolean {
  if (!user || user.scopeEnabled === true) return false;
  if (impersonating) return true;
  return user.role === 'ADMIN' && user.canManageCompanyUsers === true;
}

export interface LinkingErrorLike extends LedgerErrorLike {
  retryAfterSeconds?: unknown;
}

/** ثوانٍ ⇒ دقائق مقرّبة لأعلى (حدّ المعدّل) */
export const retryMinutes = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

/** نصّ خطأ مسارات الربط: رموزها الخاصة أولاً، وإلا نصوص الدفاتر العامة (بلا رسالة الخادم) */
/** أسباب 422 LEDGER_LINK_PARAMS_INVALID (LinkingParamsError في services/gl/linking/params.ts) */
export const linkingParamsReasonLabels = (tr: Tr): Record<string, string> => ({
  TEMPLATE_UNAVAILABLE: tr('لا قالب محاسبي لدولة الشركة، تواصل مع الدعم قبل ربط الدفاتر'),
  INVALID_FISCAL_YEAR_END: tr('يوم نهاية السنة المالية غير صالح للشهر، صححه في الخطوة الأولى من معالج الإعداد'),
  INVALID_BASIS: tr('أساس الربط غير معروف'),
});

export function linkingErrorText(tr: Tr, e: LinkingErrorLike | null | undefined): string {
  switch (e?.code) {
    case 'LEDGER_LINK_PARAMS_INVALID': {
      const reason = typeof e.reason === 'string' ? e.reason : typeof e.details?.reason === 'string' ? e.details.reason : '';
      return linkingParamsReasonLabels(tr)[reason] ?? tr('إعدادات الربط غير صالحة، راجع معالج الإعداد');
    }
    case 'LEDGER_LINKING_OWNER_ONLY': return tr('ربط الدفاتر بالنظام لمالك الشركة وحده');
    case 'LEDGER_LINKING_INTERACTIVE_ONLY': return tr('ربط الدفاتر بالنظام من لوحة التحكم وحدها لا بمفتاح الربط البرمجي');
    case 'LEDGER_LINK_ALREADY_ACTIVATED': return tr('الدفاتر مفعّلة بالفعل، والمعاينة للشركات قبل التفعيل وحدها');
    case 'LEDGER_LINK_PREVIEW_NOT_FOUND': return tr('المعاينة غير موجودة');
    case 'LEDGER_LINK_PREVIEW_RATE_LIMITED': {
      const raw = e.retryAfterSeconds ?? e.details?.retryAfterSeconds;
      const s = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      const base = tr('بلغت حد المعاينات في الساعة');
      return Number.isFinite(s) && s > 0 ? `${base} — ${tr('أعد المحاولة بعد {minutes} دقيقة').replace('{minutes}', String(retryMinutes(s)))}` : base;
    }
    default: return ledgerErrorMessage(tr, e);
  }
}

/** سبب تعطيل «تشغيل المعاينة» (null = متاح) — بالأولوية: المالك، التفعيل، معاينة جارية، طلب قائم */
export function runDisabledReason(tr: Tr, s: { owner: boolean; activated: boolean; running: boolean; pending: boolean }): string | null {
  if (!s.owner) return tr('ربط الدفاتر بالنظام لمالك الشركة وحده');
  if (s.activated) return tr('الدفاتر مفعّلة بالفعل، والمعاينة للشركات قبل التفعيل وحدها');
  if (s.running) return tr('معاينة جارية الآن، انتظر اكتمالها');
  if (s.pending) return tr('جاري الطلب...');
  return null;
}
