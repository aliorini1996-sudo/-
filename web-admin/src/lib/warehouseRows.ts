/**
 * جدول «مخزون الشركة» للعرض (مراجعة المخزون، نوفمبر ٢٠٢٦: S1 وS7 وS8 وS9 وS10) — نقيٌّ بلا React ولا شبكة، يُختبر وحده
 * (warehouseRows.test.ts)، وتقرؤه صفحة الويب (CompanyWarehousePage) وشاشة الجوال (MWarehouse) ونافذة «طلب مخزون».
 *
 * عرضٌ فقط: لا رقمٌ هنا يدخل رصيداً أو قيمة، وقيمة المستودع الصافية تبقى مجموع الصفوف بإشارتها كما يحسبها الخادم.
 *  · S1: الصنف الموقوف أو المحذوف (المؤرشف) يُوسم وينزل إلى ذيل الجدول، والاسم المكرّر يُوسم بكوده — فلا يبدو الصنف
 *    مكرّراً بلا تفسير. والحقلان `status`/`archived` اختياريان: خادمٌ أقدم لا يرسلهما ⇒ لا وسم والجدول كما كان.
 *  · S7: «الموجب − العجز» تحت القيمة الصافية حين في الصفوف قيمةٌ سالبة.
 *  · S8/S10: تكلفة الوحدة الكبرى من قيمة الصف ÷ كميته المقيَّمة (لا متوسّط الحبّة المقرَّب × ٣٦٠)، ولصف العجز «تكلفة العجز».
 *  · S9: لا إشارة على الصفر («0 كرتون» لا «−0 كرتون»).
 */
import { QTY_EPS, roundQty } from './units';
import { productNameKey } from './productGuards';

/** حقلا الحالة كما يرسلهما الخادم في صفّ المستودع (GET /warehouse) وصفّ السيارة */
export interface DormantFields { status?: string | null; archived?: boolean | null }

/** حال الصنف للوسم: محذوف (مؤرشف) بقي له رصيد، أو موقوف، أو null للنشط (أو خادمٍ أقدم) */
export type RowState = 'ARCHIVED' | 'INACTIVE' | null;

export function rowState(r: DormantFields | null | undefined): RowState {
  if (r?.archived === true) return 'ARCHIVED';
  return String(r?.status ?? '').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : null;
}

/** موقوفٌ أو محذوف — يُعرض في ذيل الجدول ولا يُعدّ «يحتاج استلام» ولا يُعرض للطلب */
export const isDormant = (r: DormantFields | null | undefined): boolean => rowState(r) !== null;

/** النشط أولاً ثم الموقوف والمحذوف، وكلٌّ بترتيبه كما جاء (الخادم: الأكبر رصيداً أولاً) */
export function splitDormant<T extends DormantFields>(rows: readonly T[]): { active: T[]; dormant: T[] } {
  const active: T[] = [], dormant: T[] = [];
  for (const r of rows) (isDormant(r) ? dormant : active).push(r);
  return { active, dormant };
}

/** عدّاد «يحتاج استلام»: النشط الذي رصيده صفر أو سالب — والموقوف والمحذوف خارجه (لا يُشترى) */
export function lowStockCount(rows: readonly (DormantFields & { onHand: number })[]): number {
  return rows.filter(r => !isDormant(r) && r.onHand <= 0).length;
}

/* تطبيع الاسم للمقارنة — مفتاح الخادم نفسه (backend/src/services/productNames.ts عبر lib/productGuards): قصٌّ ودمج مسافاتٍ
 * وحروفٌ لاتينية بلا حالة، بلا تطبيعٍ للعربية — فوسم «اسم مكرر» في المستودع يظهر حيث حذّر الإنشاء نفسه، وكما في مخزون
 * السيارات (lib/vanStockFlags) — المراجعة UX4 */
export function normalizeProductName(s: string | null | undefined): string {
  return productNameKey(s);
}

/** الأسماء (بعد التطبيع) التي تتكرّر في أكثر من صفّ — كل صفٍّ منها يُوسم «اسم مكرر» بكوده */
export function duplicateNames(rows: readonly { name: string }[]): Set<string> {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const r of rows) {
    const k = normalizeProductName(r.name);
    if (!k) continue;
    if (seen.has(k)) dup.add(k); else seen.add(k);
  }
  return dup;
}

export const isDuplicateName = (r: { name: string }, dup: ReadonlySet<string>): boolean => dup.has(normalizeProductName(r.name));

/** تفكيك القيمة الصافية (S7): مجموع الصفوف الموجبة، ومجموع السالبة بإشارتها، وعدد صفوف العجز. لا عجز ⇒ null */
export interface ValueBreakdown { positive: number; deficit: number; deficitCount: number }

export function valueBreakdown(rows: readonly { stockValue: number }[]): ValueBreakdown | null {
  let positive = 0, deficit = 0, deficitCount = 0;
  for (const r of rows) {
    const v = Number(r.stockValue) || 0;
    if (v < 0) { deficit += v; deficitCount += 1; } else positive += v;
  }
  return deficitCount > 0 ? { positive, deficit, deficitCount } : null;
}

/** ما يحتاجه حساب التكلفة من صفّ المستودع — كله بالأساس كما يرسله الخادم */
export interface CostRow { onHand: number; avgCost: number; costedQty: number; stockValue: number; uncostedQty: number }

/**
 * معنى خلية التكلفة (S10) — ثلاث علاماتٍ مختلفة بدل «—» واحدة:
 *  · costed: رصيدٌ مقيَّم ⇒ المتوسّط.
 *  · deficit: عجزٌ له قيمة سالبة ⇒ «تكلفة العجز» = القيمة ÷ الكمية المقيَّمة.
 *  · deficitUncosted: عجزٌ نشأ قبل أي سعر (قيمته صفر) ⇒ «عجز بلا تكلفة» لا «0.00».
 *  · uncosted: رصيدٌ بلا تكلفة معروفة ⇒ «بلا تكلفة».
 *  · none: لا رصيد ⇒ «—» وحدها.
 */
export type CostKind = 'costed' | 'deficit' | 'deficitUncosted' | 'uncosted' | 'none';

export function costKindOf(r: CostRow): CostKind {
  const cq = Number(r.costedQty) || 0, v = Number(r.stockValue) || 0;
  if (cq < -QTY_EPS) return Math.abs(v) > 1e-9 ? 'deficit' : 'deficitUncosted';
  if (cq > QTY_EPS) return 'costed';
  if ((Number(r.onHand) || 0) < -QTY_EPS) return 'deficitUncosted';
  if ((Number(r.onHand) || 0) > QTY_EPS || (Number(r.uncostedQty) || 0) > QTY_EPS) return 'uncosted';
  return 'none';
}

/**
 * أقلّ كمية مقيَّمة (بالأساس) تُحسب عندها تكلفة الوحدة الكبرى من قيمة الصف: القيمة مقرَّبة بخانات العملة (خطؤها ≤ ٠٫٠٠٥)
 * ومتوسّط الأساس بأربع (≤ ٠٫٠٠٠٠٥)، فالنسبة أدقّ من المتوسّط المقرَّب حين الكمية ١٠٠ فأكثر — ودونها المتوسّط × المعامل كما كان.
 */
export const RATIO_MIN_QTY = 100;

/**
 * تكلفة الوحدة بمعاملها (S8، S10) — عرضٌ فقط. للأساس (المعامل ١) متوسّط الخادم كما هو (أربع خانات)؛ وللوحدة الكبرى قيمة الصف ÷
 * كميته المقيَّمة × المعامل، فـ«الكمية × تكلفة الكرتون» تساوي قيمة الصف المعروضة (25 × 104.348 = 2,608.70، لا 104.364 من
 * متوسّط البيضة المقرَّب × 360) — ما دامت الكمية المقيَّمة ≥ RATIO_MIN_QTY. ولصف العجز (متوسّط الخادم له صفر) النسبة نفسها
 * بأي معامل (موجبةً: قيمةٌ سالبة ÷ كميةٌ سالبة). لا تكلفة ⇒ null.
 */
export function rowUnitCost(r: CostRow, factor = 1): number | null {
  const f = Number(factor) > 0 ? Number(factor) : 1;
  const kind = costKindOf(r);
  if (kind !== 'costed' && kind !== 'deficit') return null;
  const cq = Number(r.costedQty) || 0;
  const ratio = Math.abs(Number(r.stockValue) || 0) > 1e-9 && Math.abs(cq) > QTY_EPS ? (Number(r.stockValue) || 0) / cq : null;
  if (kind === 'deficit') return ratio !== null ? ratio * f : null;
  if (f === 1) return Number(r.avgCost) || 0;
  return ratio !== null && Math.abs(cq) >= RATIO_MIN_QTY ? ratio * f : (Number(r.avgCost) || 0) * f;
}

/**
 * كمية بإشارةٍ صريحة في عمودٍ اتجاهه معروف («−» خرج للسيارات، «+» عاد منها): الإشارة لما ليس صفراً وحده (S9) — «0 كرتون»
 * لا «−0 كرتون» تُقرأ حركةً لم تقع. `text` نصّ الكمية منسّقاً (موجباً).
 */
export function signedQty(n: number, sign: '−' | '+', text: string): string {
  return Math.abs(roundQty(Number(n) || 0)) <= QTY_EPS ? text : `${sign}${text}`;
}

/** الكمية صفرٌ للعرض؟ — لتخفيت الخلية بدل لونها الأحمر أو الأخضر */
export const isZeroQty = (n: number): boolean => Math.abs(roundQty(Number(n) || 0)) <= QTY_EPS;
