/**
 * طلب مخزون (طلب زيادة المستودع) — ورقةٌ يصدرها مسؤول المستودع ويرسلها لإدارة
 * المشتريات أو الإنتاج: لكل صنفٍ كمّيته المطلوبة ورصيده الآن.
 *
 * لا يُحفظ في الخادم: ليس حركة مخزون ولا التزاماً مالياً، بل ورقة طلب. فالرصيد
 * لا يتغيّر بإصداره، ويتغيّر حين تصل البضاعة وتُسجَّل «وارداً».
 */

/** الجهة الموجَّه إليها الطلب */
export type StockRequestTo = 'PURCHASING' | 'PRODUCTION';

/** اسم الجهة — مفتاح ترجمة عربي يُمرَّر على `tr` عند العرض */
export const stockRequestToLabel = (to: StockRequestTo): string =>
  to === 'PRODUCTION' ? 'إدارة الإنتاج' : 'إدارة المشتريات';

/** خانة اعتماد الجهة في الورقة */
export const stockRequestApproverLabel = (to: StockRequestTo): string =>
  to === 'PRODUCTION' ? 'اعتماد إدارة الإنتاج' : 'اعتماد إدارة المشتريات';

/**
 * مرجع الطلب من لحظة إصداره بتوقيت الجهاز: `SR-سنةشهريوم-ساعةدقيقة`.
 * قصيرٌ يُقرأ على الهاتف ويُذكر في المراسلة، ويُرتَّب زمنياً كما يُكتب.
 */
export function stockRequestRef(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `SR-${String(at.getFullYear()).slice(2)}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

/** الخانة كما كُتبت رقماً — الأرقام الهندية والفاصلة العشرية العربية تُقرأ كما تُقرأ اللاتينية */
function readNumber(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * الكمية المطلوبة في الخانة — أو `null` حين لا تُعدّ طلباً: فارغةٌ أو صفرٌ أو
 * سالبةٌ أو ليست رقماً. الطلب يطلب زيادةً فلا معنى فيه لكمّية سالبة.
 */
export function parseRequestQty(raw: string | undefined): number | null {
  const n = readNumber(raw);
  if (n === null || Number.isNaN(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * خانةٌ لا تُفهم: نصٌّ ليس رقماً أو كمّية سالبة. تُوقف الإصدار ولا تُسقَط صامتةً —
 * سطرٌ كتبه المستخدم ثم غاب عن الورقة المرسلة أسوأ من زرٍّ معطّل يقول السبب.
 * والصفر ليس خطأً: معناه «لا أطلب هذا الصنف».
 */
export function isInvalidRequestQty(raw: string | undefined): boolean {
  const n = readNumber(raw);
  return n !== null && (Number.isNaN(n) || n < 0);
}

export interface StockRequestSourceRow { productId: string; name: string; code?: string; unit?: string; onHand: number }
export interface StockRequestLine { productId: string; name: string; code?: string; unit?: string; onHand: number; qty: number }

/** أسطر الطلب بترتيب الأصناف المعطى — الصنف الذي لم تُكتب له كمية مطلوبة لا يدخل الورقة */
export function stockRequestLines(rows: StockRequestSourceRow[], qtyById: Record<string, string>): StockRequestLine[] {
  const out: StockRequestLine[] = [];
  for (const r of rows) {
    const qty = parseRequestQty(qtyById[r.productId]);
    if (qty === null) continue;
    out.push({ productId: r.productId, name: r.name, code: r.code || undefined, unit: r.unit || undefined, onHand: Number(r.onHand) || 0, qty });
  }
  return out;
}

/** إجمالي الكميات المطلوبة — بخانتين، فجمع الكسور لا يطبع ذيلاً عشرياً طويلاً */
export const stockRequestTotalQty = (lines: { qty: number }[]): number =>
  Math.round(lines.reduce((s, l) => s + l.qty, 0) * 100) / 100;

/** الناقص: رصيده صفر أو سالب — هو ما ينبّه إليه شريط الصفحة «يحتاج استلام بضاعة» */
export const isShort = (r: { onHand: number }): boolean => r.onHand <= 0;

/** الناقص أولاً، ثم البقية — وكلٌّ بترتيبه في جدول المستودع */
export function shortFirst<T extends { onHand: number }>(rows: T[]): T[] {
  return [...rows.filter(isShort), ...rows.filter(r => !isShort(r))];
}
