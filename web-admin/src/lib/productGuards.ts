/**
 * حرّاس نافذة الصنف وحذفه (مراجعة مخزون الشركة S4/S6، ومراجعة المخزون البند ٢ — قرارا المالك D4 وD7):
 *   • الاسم المكرَّر تحذيرٌ لا رفض: قبل الحفظ يُسأل الخادم (GET /products/name-check) عن أصنافٍ بالاسم نفسه — قائمةٍ أو موقوفةٍ
 *     أو مؤرشفة — فيؤكّد المدير أو يضيف وحدةً أصغر للقديم بدل صنفٍ جديد. والخادم يحذّر بنفسه أيضاً (warnings) لمن لم يسأل.
 *   • إعادة تسمية وحدة الأساس لصنفٍ له رصيد: الرصيد لا يتغيّر رقمه، يُقرأ بالاسم الجديد — فيُطلب إقرارٌ صريح.
 *   • الحذف: نصّ التأكيد يذكر رصيد الصنف في المستودع والسيارات (GET /products/:id/stock-summary) — الحذف نفسه كما هو.
 * النصوص والقراءة هنا نقيّة تُختبر وحدها، والطلبان في productGuardsApi.ts.
 */
import type { UnitDef } from './units';

/** صنفٌ يطابق الاسم كما يردّه الخادم — archived: محذوفٌ مؤرشف بأثره */
export interface NameMatch { id: string | null; code: string; name: string; status: string; archived: boolean }

/** رصيد الصنف بالأساس — warehouseBase = null حين مخزون الشركة مطفأ */
export interface StockSummary {
  productId?: string; warehouseBase: number | null; vansBase: number; vansSellableBase?: number;
  unit: string; units: UnitDef[]; primaryUnitId: string | null;
}

/** مفتاح المقارنة كما في الخادم (services/productNames.ts): قصٌّ ودمج مسافات وأحرفٌ لاتينية صغيرة، بلا تطبيعٍ للعربية */
export const productNameKey = (s: string | null | undefined): string => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** مطابقات الاسم من ردّ الخادم — ما ليس صنفاً بكودٍ يُسقط */
export const nameMatchesOf = (raw: unknown): NameMatch[] => (Array.isArray(raw) ? raw : [])
  .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { code?: unknown }).code === 'string')
  .map((m) => ({
    id: typeof m.id === 'string' ? m.id : null, code: String(m.code), name: String(m.name ?? ''),
    status: String(m.status ?? 'ACTIVE'), archived: m.archived === true,
  }));

/** تحذير الاسم المكرَّر من ردّ الإنشاء أو التعديل (warnings) — مطابقاته، و[] بلاه */
export function duplicateNameWarningsOf(body: unknown): NameMatch[] {
  const w = (body as { warnings?: unknown } | null | undefined)?.warnings;
  if (!Array.isArray(w)) return [];
  return w.filter((x) => (x as { code?: unknown })?.code === 'DUPLICATE_NAME').flatMap((x) => nameMatchesOf((x as { matches?: unknown }).matches));
}

/** النصوص — مفاتيح القاموس */
export const PRODUCT_GUARD_TEXT = {
  duplicateAsk: 'يوجد صنف بالاسم نفسه: {list} — إن كان هو نفسه فأضف له وحدة أصغر بدل صنف جديد. أتحفظ على كل حال؟',
  duplicateSaved: 'تم حفظ الصنف ويوجد صنف آخر بالاسم نفسه: {list}',
  archived: 'محذوف',
  inactive: 'موقوف',
  balance: '{wh} في المستودع و{vans} في السيارات',
  balanceVans: '{vans} في السيارات',
  renameAsk: 'إعادة تسمية وحدة الأساس من «{from}» إلى «{to}» لا تغير الكميات: رصيد الصنف ({balance}) سيقرأ بالاسم الجديد. لإضافة وحدة أصغر استعمل إضافة وحدة فرعية أصغر. أتتابع؟',
  deleteBalance: 'للصنف رصيد الآن: {balance} — يبقى في جداول المخزون باسم الصنف المحذوف حتى تسويه أو تنزله',
  deleteNoBalance: 'لا رصيد له في المستودع ولا في السيارات',
  deleteChecking: 'جار فحص رصيد الصنف',
} as const;

const put = (s: string, vals: Record<string, string>): string =>
  Object.entries(vals).reduce((t, [k, v]) => t.split(`{${k}}`).join(v), s);

/** «كرتون بيض M (EGG-M — محذوف)» لكل مطابقة، مفصولةً — حتى خمسٍ ثم «…» */
export function matchesText(matches: readonly NameMatch[], tr: (ar: string) => string): string {
  const one = (m: NameMatch) => {
    const tag = m.archived ? ` — ${tr(PRODUCT_GUARD_TEXT.archived)}` : m.status === 'INACTIVE' ? ` — ${tr(PRODUCT_GUARD_TEXT.inactive)}` : '';
    return `${m.name.trim() || '—'} (${m.code}${tag})`;
  };
  return matches.slice(0, 5).map(one).join('، ') + (matches.length > 5 ? '، …' : '');
}

export const duplicateNameAskText = (matches: readonly NameMatch[], tr: (ar: string) => string): string =>
  put(tr(PRODUCT_GUARD_TEXT.duplicateAsk), { list: matchesText(matches, tr) });

export const duplicateNameSavedText = (matches: readonly NameMatch[], tr: (ar: string) => string): string =>
  put(tr(PRODUCT_GUARD_TEXT.duplicateSaved), { list: matchesText(matches, tr) });

const EPS = 1e-9;

/** للصنف رصيدٌ غير صفري (موجبٌ أو سالب) في المستودع أو السيارات */
export const hasStockBalance = (s: StockSummary | null | undefined): boolean =>
  !!s && (Math.abs(s.warehouseBase ?? 0) > EPS || Math.abs(s.vansBase) > EPS);

/** «X في المستودع وY في السيارات» — بلا مستودع (الميزة مطفأة) السيارات وحدها. `qty` يعرض الكمية بالأساس بوحداتها */
export function stockBalanceText(s: StockSummary, tr: (ar: string) => string, qty: (base: number) => string): string {
  return s.warehouseBase == null
    ? put(tr(PRODUCT_GUARD_TEXT.balanceVans), { vans: qty(s.vansBase) })
    : put(tr(PRODUCT_GUARD_TEXT.balance), { wh: qty(s.warehouseBase), vans: qty(s.vansBase) });
}

export const baseRenameAskText = (from: string, to: string, s: StockSummary, tr: (ar: string) => string, qty: (base: number) => string): string =>
  put(tr(PRODUCT_GUARD_TEXT.renameAsk), { from: from.trim(), to: to.trim(), balance: stockBalanceText(s, tr, qty) });

/** سطر رصيد الصنف تحت نصّ تأكيد الحذف — undefined = جارٍ الفحص، null = تعذّر (لا سطر) */
export function deleteBalanceText(s: StockSummary | null | undefined, tr: (ar: string) => string, qty: (base: number) => string): string | null {
  if (s === undefined) return tr(PRODUCT_GUARD_TEXT.deleteChecking);
  if (s === null) return null;
  return hasStockBalance(s) ? put(tr(PRODUCT_GUARD_TEXT.deleteBalance), { balance: stockBalanceText(s, tr, qty) }) : tr(PRODUCT_GUARD_TEXT.deleteNoBalance);
}
