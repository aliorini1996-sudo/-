/**
 * «طلبات المنيو» في تطبيق المندوب (طلب المالك ٢٤ نوفمبر ٢٠٢٦: «في منيو المنتجات الذي يصدر من تطبيق المندوب اجعل بالضغط على
 * المنتجات يمكن إتمام طلب، يظهر في تطبيق المندوب أيقونة جديدة «طلب جديد» ولا تظهر إلا إذا جاء طلب»). العميل يطلب من الصفحة
 * العامة /c/{tenantId}/{repId} فيصل الطلب مندوبَ الرابط: بطاقة «طلب جديد» في الرئيسية بعدد المفتوحة، وشاشة الطلبات، وتحويل
 * الطلب إلى فاتورة معبّأة. الخادم: /api/catalog-orders (routes/catalogOrders.ts) للمندوب وحده.
 *
 * منطقٌ صرفٌ بلا React ولا شبكة (يختبره catalogOrders.test.ts) فتبقى الشاشة عرضاً فقط:
 *  - تطبيع ردّ الخادم دفاعياً: حقلٌ غائب أو خادمٌ أقدم لا يُسقط الشاشة ولا يُظهر بطاقةً بعددٍ كاذب؛
 *  - الإجمالي «تقريبي» بمعادلة بطاقة المنيو حرفاً (سعر الوحدة شاملاً مقرَّباً بخانات العملة × الكمية) — للعلم وحده، فالفاتورة
 *    تُسعَّر بأسعار المندوب وقواعده المعتادة لا بسعر المنيو؛
 *  - تعبئة الفاتورة: الوحدة بالاسم والمعامل معاً وإلا الأساس بالكمية × المعامل — فلا تضيع كمية العميل إن أُعيدت تسمية الوحدة أو
 *    تغيّر معاملها بعد الطلب — والصنف المحذوف أو غير المتاح للمندوب الآن يُتخطّى ويُسمّى له (لا يختفي صامتاً).
 */
import { roundDecimal } from './invoiceCalc';

export type CatalogOrderStatus = 'NEW' | 'SEEN' | 'DONE' | 'CANCELLED';
const STATUSES: readonly CatalogOrderStatus[] = ['NEW', 'SEEN', 'DONE', 'CANCELLED'];

export interface CatalogOrderItem {
  id: string;
  /** null = حُذف الصنف بعد الطلب (onDelete: SetNull) — يُعرض باسمه ولا يدخل الفاتورة */
  productId: string | null;
  productName: string;
  /** null = وحدة الأساس */
  unitName: string | null;
  unitFactor: number;
  /** بوحدة البند */
  qty: number;
  /** صافي سعر وحدة البند (قبل الضريبة) لحظة الطلب كما عرضه المنيو */
  unitPrice: number;
  taxPct: number;
}

export interface CatalogOrder {
  id: string;
  customerName: string;
  customerPhone: string;
  note: string | null;
  status: CatalogOrderStatus;
  createdAt: string;
  invoiceId: string | null;
  items: CatalogOrderItem[];
  /** أحدث عميلٍ للمندوب بالجوال نفسه (phoneKey) — به تُفتح فاتورته مباشرة، وبدونه «إضافة عميل» بالاسم والجوال أولاً */
  matchedCustomer: { id: string; name: string } | null;
}

export interface CatalogOrdersCount { open: number; fresh: number }

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | null => str(v) || null;

/** بند الطلب من ردّ الخادم — بندٌ بلا كمية موجبة لا يُعرض ولا يُعبّأ */
export function catalogOrderItemOf(raw: unknown): CatalogOrderItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const qty = num(r.qty);
  if (!(qty > 0)) return null;
  const factor = num(r.unitFactor, 1);
  return {
    id: str(r.id),
    productId: optStr(r.productId),
    productName: str(r.productName) || '—',
    unitName: optStr(r.unitName),
    unitFactor: factor > 0 ? factor : 1,
    qty,
    unitPrice: Math.max(0, num(r.unitPrice)),
    taxPct: Math.max(0, num(r.taxPct)),
  };
}

/** الطلب من ردّ الخادم — بلا معرّف لا يُعرض (لا يُفتح ولا تُغيَّر حالته) */
export function catalogOrderOf(raw: unknown): CatalogOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = optStr(r.id);
  if (!id) return null;
  const status = STATUSES.includes(r.status as CatalogOrderStatus) ? (r.status as CatalogOrderStatus) : 'NEW';
  const m = r.matchedCustomer && typeof r.matchedCustomer === 'object' ? (r.matchedCustomer as Record<string, unknown>) : null;
  const mid = m ? optStr(m.id) : null;
  return {
    id,
    customerName: str(r.customerName),
    customerPhone: str(r.customerPhone),
    note: optStr(r.note),
    status,
    createdAt: str(r.createdAt),
    invoiceId: optStr(r.invoiceId),
    items: (Array.isArray(r.items) ? r.items : []).map(catalogOrderItemOf).filter((x): x is CatalogOrderItem => x !== null),
    matchedCustomer: mid ? { id: mid, name: str(m!.name) } : null,
  };
}

/** قائمة الطلبات من `data` في ردّ GET /catalog-orders/mine (مصفوفة، أو { orders } احتياطاً) */
export function catalogOrdersOf(data: unknown): CatalogOrder[] {
  const rows = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { orders?: unknown }).orders) ? (data as { orders: unknown[] }).orders : [];
  return rows.map(catalogOrderOf).filter((o): o is CatalogOrder => o !== null);
}

/** العدّاد من GET /catalog-orders/mine/count — ما لا يُقرأ عدداً صفر: لا بطاقة بعددٍ لا نعرفه */
export function catalogOrdersCountOf(data: unknown): CatalogOrdersCount {
  const r = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const open = Math.max(0, Math.floor(num(r.open)));
  return { open, fresh: Math.min(open, Math.max(0, Math.floor(num(r.fresh)))) };
}

/** نصّ الشارة على البطاقة — الرقم كما هو حتى ٩٩ ثم «99+» (الخادم يحدّ المفتوحة بمئة لكل مندوب) */
export function ordersBadgeText(open: number): string {
  return open > 99 ? '99+' : String(Math.max(0, Math.floor(open)));
}

/** مفتوح = جديد أو اطّلع عليه المندوب ولم يُنجَز أو يُلغَ */
export function isOpenOrder(o: { status: CatalogOrderStatus }): boolean {
  return o.status === 'NEW' || o.status === 'SEEN';
}

/** سعر وحدة البند شاملاً الضريبة — معادلة بطاقة المنيو (catalogGross) حرفاً، فيرى المندوب الرقم الذي رآه العميل */
export function orderUnitGross(it: Pick<CatalogOrderItem, 'unitPrice' | 'taxPct'>, dec: number): number {
  return roundDecimal(it.unitPrice * (1 + it.taxPct / 100), dec);
}

export function orderLineTotal(it: Pick<CatalogOrderItem, 'unitPrice' | 'taxPct' | 'qty'>, dec: number): number {
  return roundDecimal(orderUnitGross(it, dec) * it.qty, dec);
}

/** الإجمالي التقريبي — مجموع البنود كسلّة المنيو (للعلم: الفاتورة تُسعَّر بأسعار المندوب) */
export function orderTotal(o: { items: readonly Pick<CatalogOrderItem, 'unitPrice' | 'taxPct' | 'qty'>[] }, dec: number): number {
  return roundDecimal(o.items.reduce((s, it) => s + orderLineTotal(it, dec), 0), dec);
}

/** الأحدث أولاً (والخادم يرسلها كذلك) — تاريخٌ لا يُقرأ يذهب آخراً */
export function sortOrdersNewest<T extends { createdAt: string }>(orders: readonly T[]): T[] {
  const t = (s: string) => { const n = Date.parse(s); return Number.isFinite(n) ? n : 0; };
  return [...orders].sort((a, b) => t(b.createdAt) - t(a.createdAt));
}

/** حالةٌ جديدة لطلبٍ في القائمة المفتوحة: المطّلع عليه يبقى (بلا تمييز «جديد»)، والمنجَز والملغى يخرجان منها */
export function withOrderStatus<T extends { id: string; status: CatalogOrderStatus }>(orders: readonly T[], id: string, status: CatalogOrderStatus): T[] {
  return isOpenOrder({ status }) ? orders.map(o => (o.id === id ? { ...o, status } : o)) : orders.filter(o => o.id !== id);
}

export type OrderAge = { unit: 'now' } | { unit: 'min' | 'hour'; n: number } | { unit: 'date' };

/** عمر الطلب للقائمة: «الآن» دون دقيقة (وفرق ساعة الجوال القليل بالسالب)، ثم دقائق ثم ساعات، وبعد يومٍ تاريخه */
export function orderAge(createdAt: string, now: number): OrderAge {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return { unit: 'date' };
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return { unit: 'now' };
  if (min < 60) return { unit: 'min', n: min };
  const h = Math.floor(min / 60);
  return h < 24 ? { unit: 'hour', n: h } : { unit: 'date' };
}

/**
 * رابط الاتصال بجوال العميل — أرقامه وحدها (والعربية/الفارسية أرقاماً) و«+» الدولية في أوّله. الجوال من صفحةٍ عامة: لا يُبنى
 * منه رابطٌ بغير الأرقام، وما لا رقم فيه لا زرّ اتصالٍ له (null)
 */
export function orderTelHref(phone: unknown): string | null {
  const s = String(phone ?? '').trim()
    .replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `tel:${s.startsWith('+') ? '+' : ''}${digits}`;
}

// ─── تعبئة الفاتورة من الطلب ───

/** بند تعبئةٍ لفاتورة المندوب: الصنف ووحدة الطلب (null = الأساس) ومعاملها والكمية بها */
export interface CatalogPrefillItem { productId: string; name: string; unitName: string | null; unitFactor: number; qty: number }

/** ما تحمله «إنشاء فاتورة» إلى CreateInvoice: البنود، وأسماء بنودٍ حُذف صنفها بعد الطلب (تُسمّى ولا تُضاف)، ومعرّف الطلب لإنجازه */
export interface CatalogPrefill { orderId: string; customerName: string; items: CatalogPrefillItem[]; missing: string[] }

export function prefillOf(o: Pick<CatalogOrder, 'id' | 'items' | 'customerName'>): CatalogPrefill {
  const items: CatalogPrefillItem[] = [];
  const missing: string[] = [];
  for (const it of o.items) {
    if (it.productId) items.push({ productId: it.productId, name: it.productName, unitName: it.unitName, unitFactor: it.unitFactor, qty: it.qty });
    else missing.push(it.productName);
  }
  return { orderId: o.id, customerName: o.customerName, items, missing };
}

/** أربع خانات: حدّ كمية الصنف المتتبَّع في الخادم (LOT_QTY_INVALID)، وبه يزول غبار الضرب العشريّ (٣ × ٠٫١) */
const roundQty = (n: number): number => Math.round(n * 1e4) / 1e4;
const EPS = 1e-9;

/** خيار وحدةٍ كما تعطيه repUnitChoices/unitChoices (id null = الأساس) — بنيوياً لا استيراداً، فيبقى هذا الملف صرفاً */
export interface PrefillChoice { id: string | null; name: string; factor: number }

/**
 * وحدة البند في الفاتورة بين وحدات المندوب المسموحة له في البيع (`choices`):
 *  1) وحدة الطلب نفسها: الاسم **والمعامل** معاً — اسمٌ بقي ومعاملٌ تغيّر ليس الوحدة التي طلبها العميل؛
 *  2) وإلا الأساس بالكمية × معامل الطلب: العدد الذي طلبه العميل بالحبّة لا يتغيّر بتغيّر الوحدات؛
 *  3) والأساس غير مسموحٍ للمندوب («الكبرى فقط»): أكبر وحدةٍ مسموحة تقسم الكمية الأساسية عدداً صحيحاً — ٤٨ حبة = ٢ كرتون؛
 *  وإلا null: يُتخطّى البند ويُسمّى للمندوب ليضيفه بيده.
 */
export function prefillUnitOf<C extends PrefillChoice>(choices: readonly C[], it: Pick<CatalogPrefillItem, 'unitName' | 'unitFactor' | 'qty'>): { choice: C; qty: number } | null {
  if (!(it.qty > 0)) return null;
  const F = it.unitFactor > 0 ? it.unitFactor : 1;
  const want = (it.unitName ?? '').trim();
  if (want) {
    const hit = choices.find(c => c.id !== null && c.name.trim() === want && Math.abs(c.factor - F) < EPS);
    if (hit) return { choice: hit, qty: roundQty(it.qty) };
  }
  const baseQty = roundQty(it.qty * F);
  const base = choices.find(c => c.id === null);
  if (base) return { choice: base, qty: baseQty };
  const whole = [...choices].filter(c => c.factor > 0).sort((a, b) => b.factor - a.factor).find(c => {
    const q = baseQty / c.factor;
    return Math.round(q) >= 1 && Math.abs(q - Math.round(q)) < 1e-6;
  });
  return whole ? { choice: whole, qty: Math.round(baseQty / whole.factor) } : null;
}

/**
 * خطة التعبئة على أصناف المندوب **القابلة للبيع الآن** (`sellable`: أصناف الفريق الحالي بلا قيد مندوبٍ يمنعها، من كتالوج الجهاز
 * النشط): لكل بندٍ صنفه ووحدته وكميته، والبندان بالصنف والوحدة نفسيهما (وحدتان سقطتا إلى الأساس) سطرٌ واحد بمجموعهما — كدمج
 * «+١» في السلّة. وما لا صنف له بينها أو لا وحدة مسموحة تحمله يُتخطّى باسمه (مرّةً واحدة)
 */
export function planPrefill<P extends { id: string }, C extends PrefillChoice>(
  items: readonly CatalogPrefillItem[], sellable: readonly P[], choicesOf: (p: P) => readonly C[],
): { lines: { product: P; choice: C; qty: number }[]; skipped: string[] } {
  const lines: { product: P; choice: C; qty: number }[] = [];
  const skipped: string[] = [];
  for (const it of items) {
    const p = sellable.find(x => x.id === it.productId);
    const u = p ? prefillUnitOf(choicesOf(p), it) : null;
    if (!p || !u) {
      if (!skipped.includes(it.name)) skipped.push(it.name);
      continue;
    }
    const at = lines.findIndex(l => l.product.id === p.id && l.choice.id === u.choice.id);
    if (at >= 0) lines[at] = { ...lines[at], qty: roundQty(lines[at].qty + u.qty) };
    else lines.push({ product: p, choice: u.choice, qty: u.qty });
  }
  return { lines, skipped };
}
