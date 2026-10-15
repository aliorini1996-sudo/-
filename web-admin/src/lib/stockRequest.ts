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

// ——— طلبات بضاعة المناديب (الخادم: /rep-stock-requests) ———
// المندوب الذي لا يملك صلاحية التحميل يرفع من تطبيقه ما يحتاجه، فتظهر طلباته المعلّقة أسفل هذه
// النافذة: يعدّل الإداري الكمية المعتمدة لكل صنف، ومجموع المشمول منها هو الكمية المبدئية في الطلب العام.

export interface RepRequestItem { productId: string; name: string; code?: string; unit?: string; requestedQty: number; qty: number }
export interface RepStockRequest {
  id: string; salesRepId: string; repName: string; note: string | null;
  createdAt: string; updatedAt: string; items: RepRequestItem[];
}

/** الكمية المعتمدة لبندٍ الآن: ما كتبه الإداري في خانته (فارغها صفر)، وإلا المحفوظة في الخادم */
export function repItemQty(saved: number, raw: string | undefined): number {
  if (raw === undefined) return saved;
  return isInvalidRequestQty(raw) ? saved : (parseRequestQty(raw) ?? 0);
}

/** هل في خانات هذا الطلب ما يخالف المحفوظ؟ — يظهر «حفظ التعديل» ويُحفظ تلقائياً قبل الإرسال */
export function repRequestDirty(r: RepStockRequest, edits: Record<string, string> | undefined): boolean {
  if (!edits) return false;
  return r.items.some(i => edits[i.productId] !== undefined && repItemQty(i.qty, edits[i.productId]) !== i.qty);
}

/** مجموع الكميات المعتمدة لكل صنف عبر الطلبات المشمولة — بخانتين كبقية الطلب */
export function repRequestTotals(reqs: RepStockRequest[], edits: Record<string, Record<string, string>>): Map<string, number> {
  const sum = new Map<string, number>();
  for (const r of reqs) {
    for (const i of r.items) {
      const q = repItemQty(i.qty, edits[r.id]?.[i.productId]);
      if (q > 0) sum.set(i.productId, Math.round(((sum.get(i.productId) ?? 0) + q) * 100) / 100);
    }
  }
  return sum;
}

/** صنفٌ طلبه مندوب وليس في جدول المستودع (أُضيف بعده مثلاً) يُلحق برصيد صفر — فلا يسقط من الطلب العام */
export function withRequestedProducts(rows: StockRequestSourceRow[], reqs: RepStockRequest[]): StockRequestSourceRow[] {
  const known = new Set(rows.map(r => r.productId));
  const extra: StockRequestSourceRow[] = [];
  for (const r of reqs) {
    for (const i of r.items) {
      if (known.has(i.productId)) continue;
      known.add(i.productId);
      extra.push({ productId: i.productId, name: i.name, code: i.code, unit: i.unit, onHand: 0 });
    }
  }
  return [...rows, ...extra];
}

/** ما طلبه المناديب أولاً (بما طلبوه أصلاً لا بالمعدَّل، فلا يقفز الترتيب أثناء الكتابة)، ثم الناقص، ثم البقية */
export function requestedFirst<T extends { productId: string; onHand: number }>(rows: T[], requested: Set<string>): T[] {
  return [...rows.filter(r => requested.has(r.productId)), ...shortFirst(rows.filter(r => !requested.has(r.productId)))];
}
