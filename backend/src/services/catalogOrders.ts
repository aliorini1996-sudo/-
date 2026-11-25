// ============================================================================
// «طلب من المنيو» (طلب المالك ٢٤ نوفمبر ٢٠٢٦): عميل الشركة يفتح منيو المنتجات العام (fieldsa.net/c/{tenantId}/{repId})
// فيضيف أصنافاً إلى سلّته ويرسل طلباً يصل المندوب صاحب الرابط؛ وفي تطبيق المندوب أيقونة «طلب جديد» لا تظهر إلا ما دام
// له طلبٌ مفتوح، ومنها يتصل بالعميل أو يحوّل الطلب إلى فاتورة جاهزة الأسطر أو يغلقه.
//
// هنا المنطق الصافي بلا قاعدة (tests/catalog-orders.test.ts): فحص جسم الطلب العام، وتسعير الأسطر من صفوف القاعدة —
// **لا يُوثق بسعرٍ يرسله العميل أبداً**، فالصفحة العامة يعدّلها أيّ أحد — وسقف الطلبات المفتوحة لكل مندوب، ومطابقة جوال
// الطلب بعميلٍ قائم، وانتقالات الحالة، وشكل الردّ. المسارات: routes/publicCatalog.ts (العلن) وroutes/catalogOrders.ts (المندوب).
// ============================================================================
import { z } from 'zod';
import { phoneKey } from './phoneKey';
import { primaryUnitOf, unitPriceOf } from './units';
import { effectiveTaxPct, type TaxModeCompany } from './taxMode';
import { listLineRef, listPriceOf, type PriceRuleProduct, type PriceRuleRow } from './priceRules';
import { roundHalfUp } from '../lib/money';

/** رموز الردود — الصفحة العامة وتطبيق المندوب يميّزان بها لا بالنصّ */
export const CATALOG_ORDER_CODES = {
  /** صنفٌ أو وحدةٌ لم تعد صالحة للبيع (حُذف، أُوقف، من شركةٍ أخرى) — الصفحة: «تغيرت قائمة الأصناف — حدّث الصفحة» */
  INVALID: 'CATALOG_ORDER_INVALID',
  /** جسمٌ ناقص أو مشوّه (الاسم، الجوال، الكمية…) ومعه `field` — صفحةٌ سليمة تفحصه قبل الإرسال فلا يصل إلا من عبث */
  BAD_INPUT: 'CATALOG_ORDER_BAD_INPUT',
  /** تجاوز المندوب سقف الطلبات المفتوحة — الصفحة: «طلبات كثيرة — حاول بعد قليل» */
  LIMIT: 'CATALOG_ORDER_LIMIT',
  /** جسمٌ أكبر من السقف (413) */
  TOO_LARGE: 'CATALOG_ORDER_TOO_LARGE',
  /** إغلاق طلبٍ أُغلق من قبل (DONE/CANCELLED) — 409 */
  CLOSED: 'CATALOG_ORDER_CLOSED',
  /** الفاتورة المربوطة ليست فاتورةً للشركة أصدرها هذا المندوب — 400 */
  INVOICE_INVALID: 'CATALOG_ORDER_INVOICE_INVALID',
} as const;

export type CatalogOrderStatus = 'NEW' | 'SEEN' | 'DONE' | 'CANCELLED';
/** «مفتوح» = لم يُحسم بعد: جديدٌ لم يفتحه المندوب، أو رآه ولم يغلقه. الأيقونة وعدّادها والسقف كلها على هذين */
export const OPEN_STATUSES: readonly CatalogOrderStatus[] = ['NEW', 'SEEN'];
/** ما يُغلق به المندوب الطلب */
export const DECIDED_STATUSES: readonly CatalogOrderStatus[] = ['DONE', 'CANCELLED'];

/** سقف الطلبات المفتوحة لكل مندوب: رابط المنيو علنيّ، فمن يغرقه بطلباتٍ وهمية يتوقّف عند هذا الحدّ لا عند امتلاء القاعدة */
export const MAX_OPEN_ORDERS_PER_REP = 100;
export const MAX_ORDER_LINES = 100;
export const MAX_LINE_QTY = 100000;
/** سقف جسم الطلب العام بالبايت: مئة سطرٍ بمعرّفاتها وملاحظةٌ قصيرة دون ١٥ ك.ب — وما فوقه عبث */
export const MAX_ORDER_BODY_BYTES = 20 * 1024;
/** سقف قائمة طلبات المندوب الواحدة */
export const MINE_LIST_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ═══ فحص جسم الطلب العام ═══

/** الأرقام الهندية (العربية والفارسية) لاتينيةً — لوحة مفاتيح الجوال العربية تكتب «٠٥٥…» */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

const digitCount = (s: string): number => asciiDigits(s).replace(/\D/g, '').length;

/** كميةٌ بثلاث منازل عشرية على الأكثر — كدقّة الكميات في المنصّة (roundQty)؛ ما بعدها خطأ إدخالٍ أو عبث */
export function hasAtMost3Decimals(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const scaled = n * 1000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** قصّ الطرفين وضمّ المسافات — الاسم يُعرض في سطرٍ واحد في التطبيق والإشعار */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const orderBodySchema = z.object({
  clientRef: z.string().refine((v) => UUID_RE.test(v)),
  name: z.string().max(400).transform(oneLine).pipe(z.string().min(2).max(80)),
  // الجوال: ٥–٣٠ محرفاً وفيه ٥ أرقام على الأقل — بلا أرقامٍ لا يستطيع المندوب الاتصال، وهذا كل ما يحتاجه من الطلب.
  // ويُحفظ بأرقامٍ لاتينية: رابط الاتصال وواتساب في تطبيق المندوب لا يفهمان «٠٥٥…»
  phone: z.string().max(400).transform((s) => asciiDigits(oneLine(s))).pipe(z.string().min(5).max(30).refine((s) => digitCount(s) >= 5)),
  note: z.string().max(2000).nullish().transform((s) => (s == null ? null : s.trim() || null)).pipe(z.string().max(300).nullable()),
  items: z.array(z.object({
    productId: z.string().min(1).max(64),
    // null أو غائب ⇒ وحدة الأساس
    unitId: z.string().min(1).max(64).nullish().transform((v) => v ?? null),
    qty: z.number().finite().gt(0).max(MAX_LINE_QTY).refine(hasAtMost3Decimals),
  })).min(1).max(MAX_ORDER_LINES),
});

export interface OrderLineInput { productId: string; unitId: string | null; qty: number }
export interface OrderInput { clientRef: string; name: string; phone: string; note: string | null; items: OrderLineInput[] }

/** جسم الطلب العام مفحوصاً، أو أول حقلٍ معيب (للردّ 400 بـ`field`) */
export function parseOrderBody(body: unknown): { ok: true; value: OrderInput } | { ok: false; field: string } {
  const r = orderBodySchema.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return { ok: false, field: String(first?.path?.[0] ?? 'body') };
}

/**
 * «مصيدة» الروبوتات: حقلٌ مخفيّ اسمه website لا يراه الإنسان فلا يملؤه. الممتلئ (أو غير النصّي — عميلٌ عُبث به) يُردّ عليه
 * 201 بمعرّفٍ وهميّ ولا يُحفظ شيء: الروبوت يظنّ أنه نجح فلا يعدّل نفسه ليتجاوزها، والمندوب لا يرى طلباً مزيّفاً
 */
export function isHoneypotHit(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const w = (body as Record<string, unknown>).website;
  if (w === undefined || w === null) return false;
  return typeof w !== 'string' || w.trim() !== '';
}

/** حجم الجسم: البايتات الخام إن حُفظت (express.json العام يحفظها لتوقيع webhook)، وإلا ترويسة Content-Length */
export function orderBodyTooLarge(rawLength: number | null | undefined, contentLength: unknown): boolean {
  const n = typeof rawLength === 'number' ? rawLength : Number(contentLength);
  return Number.isFinite(n) && n > MAX_ORDER_BODY_BYTES;
}

/**
 * السطر المكرّر (الصنف نفسه بالوحدة نفسها) يُجمع في سطرٍ واحد بترتيب أول ظهور — الصفحة مفتاح سلّتها الصنف + الوحدة فلا
 * تكرّر، لكنّ الجسم يصنعه أيّ أحد. والمجموع يُقرَّب لثلاث منازل، وما تجاوز سقف الكمية بعد الجمع ⇒ null (جسمٌ معيب)
 */
export function mergeOrderLines(items: readonly OrderLineInput[]): OrderLineInput[] | null {
  const out: OrderLineInput[] = [];
  const at = new Map<string, number>();
  for (const it of items) {
    const key = `${it.productId}\u0000${it.unitId ?? ''}`;
    const i = at.get(key);
    if (i === undefined) { at.set(key, out.length); out.push({ productId: it.productId, unitId: it.unitId ?? null, qty: it.qty }); continue; }
    out[i].qty = Math.round((out[i].qty + it.qty) * 1000) / 1000;
  }
  return out.some((l) => l.qty > MAX_LINE_QTY) ? null : out;
}

// ═══ سعر المنيو: «الأسعار تظهر للعملاء حسب تسعير الشركة» (المالك ٢٤ نوفمبر ٢٠٢٦) ═══

/**
 * قائمة أسعار المنيو: القائمة الافتراضية لمندوب الرابط (SalesRep.defaultPriceListId) محمَّلةً لأصناف المنيو — يحمّلها
 * routes/publicCatalog.ts بالاستعلامات نفسها التي يقرؤها تطبيق المندوب (rulesOfLists) والفاتورة (PriceListItem). وبلا قائمةٍ null
 */
export interface MenuPriceList {
  /** سعر الصنف الثابت فيها لوحدة الأساس صافياً (PriceListItem) */
  itemOf: ReadonlyMap<string, number>;
  /** قواعدها (PriceListRule) كما يحلّها services/priceRules.ts */
  rules: readonly PriceRuleRow[];
  /** يوم الشركة 'YYYY-MM-DD' — تقرؤه قواعد الفترة وحدها */
  day: string;
}

/** منازل سعر المنيو من القائمة — كسعر القائمة الذي يقترحه نموذج فاتورة المندوب (roundHalfUp لأربع منازل) */
export const MENU_LIST_PRICE_DECIMALS = 4;

/** الصنف كما يحتاجه سعر المنيو: سعر أساسه، وفئته ورئيسيّته لقواعد القائمة، ووحداته النشطة */
export interface MenuPricedProduct {
  id: string;
  basePrice: number;
  categoryId?: string | null;
  primaryUnitId?: string | null;
  units: { id: string; name: string; factor: number; price: number | null; isActive?: boolean }[];
}

/**
 * سعر وحدةٍ واحدة في المنيو صافياً قبل الضريبة — **الدالة الواحدة** لعرض المنيو (GET) ولقطة سعر الطلب (POST): فتقدير العميل
 * هو ما رآه حرفاً. `unit` null ⇒ وحدة الأساس.
 *   • بلا قائمة (`list` null): سعر اليوم حرفاً — الوحدة بـunitPriceOf (المحدَّد لها، وإلا الأساس × المعامل) والأساس بسعره.
 *   • بقائمة: ما تقوله لوحدةٍ رئيسيةٍ واحدة (listPriceOf بكمية ١ ويوم الشركة: ثابتها وقواعدها بأولويتها) لمعامل الوحدة
 *     (listLineRef — النسبة من سعر اليوم نفسه) مقرَّباً لأربع منازل؛ وما لا تقول فيه شيئاً يبقى بسعر اليوم.
 * وسعر العميل الخاص (CustomerPrice) لا يدخل أبداً: عميل المنيو مجهول، والرابط يراه كل من وصله
 */
export function menuPriceOf(
  p: MenuPricedProduct,
  unit: { name: string; factor: number; price: number | null } | null,
  list: MenuPriceList | null | undefined,
): number {
  // الفارغ undefined لا null: Number(null) = 0 «سعرٌ صالح» في unitPriceOf فيُعرض الكرتون مجاناً بدل الأساس × المعامل
  const noListRef = unit ? unitPriceOf({ name: unit.name, factor: unit.factor, price: unit.price ?? undefined }, p.basePrice) : p.basePrice;
  if (!list) return noListRef;
  const rp: PriceRuleProduct = { id: p.id, categoryId: p.categoryId ?? null, primaryFactor: Number(primaryUnitOf(p)?.factor) || 1 };
  const ref = listLineRef(listPriceOf(list.itemOf.get(p.id), list.rules, rp, 1, list.day), unit ? unit.factor : 1, noListRef);
  return ref === null || !Number.isFinite(ref) ? noListRef : roundHalfUp(ref, MENU_LIST_PRICE_DECIMALS);
}

// ═══ تسعير الأسطر من القاعدة ═══

/** الصنف كما يقرؤه مسار الطلب: صالحٌ للعلن (الشركة نفسها، ACTIVE، غير مؤرشف) ووحداته النشطة وحدها — قيدٌ في استعلامه */
export interface CatalogProductRow extends MenuPricedProduct {
  name: string;
  taxPct: number;
}

/** سطرٌ يُكتب في catalog_order_items — لقطة لحظة الطلب */
export interface PricedLine {
  productId: string;
  productName: string;
  unitName: string | null;
  unitFactor: number;
  qty: number;
  unitPrice: number;
  taxPct: number;
}

/**
 * يسعّر الأسطر من صفوف القاعدة بالسعر الذي يعرضه المنيو نفسه (menuPriceOf — الدالة نفسها التي يعرض بها GET): بقائمة المندوب
 * الافتراضية إن كانت (`list`)، وإلا الوحدة بـunitPriceOf (المحدَّد لها، وإلا الأساس × المعامل) والأساس بسعره، صافياً قبل الضريبة،
 * والنسبة صفرٌ للشركة «بلا ضريبة». صنفٌ غائب عن `products` (شركةٌ أخرى، موقوف، محذوف) أو وحدةٌ ليست من وحداته النشطة
 * ⇒ `{ ok: false }` فيُردّ الطلب كله: لا يُقبل نصف طلب بصمت
 */
export function priceOrderLines(
  items: readonly OrderLineInput[], products: readonly CatalogProductRow[], company: TaxModeCompany | null | undefined,
  list: MenuPriceList | null = null,
): { ok: true; lines: PricedLine[] } | { ok: false } {
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: PricedLine[] = [];
  for (const it of items) {
    const p = byId.get(it.productId);
    if (!p) return { ok: false };
    const taxPct = effectiveTaxPct(company, p.taxPct);
    if (it.unitId === null) {
      const base = Number(menuPriceOf(p, null, list));
      lines.push({ productId: p.id, productName: p.name, unitName: null, unitFactor: 1, qty: it.qty, unitPrice: Number.isFinite(base) ? base : 0, taxPct });
      continue;
    }
    const u = p.units.find((x) => x.id === it.unitId && x.isActive !== false);
    if (!u) return { ok: false };
    // السعر المعروض للعميل هو المحفوظ في الطلب حرفاً
    const unitPrice = menuPriceOf(p, u, list);
    lines.push({ productId: p.id, productName: p.name, unitName: u.name, unitFactor: u.factor, qty: it.qty, unitPrice, taxPct });
  }
  return { ok: true, lines };
}

/** هل بلغ المندوب سقف الطلبات المفتوحة؟ «أكثر من مئة» ⇒ الطلب الذي يجعلها ١٠١ يُرفض */
export function openCapReached(openCount: number): boolean {
  return openCount >= MAX_OPEN_ORDERS_PER_REP;
}

/** إشعار المندوب بطلبٍ جديد — `url` يفتح شاشة الطلبات في التطبيق، و`tag` يجمع إشعارات الطلبات في واحد */
export function orderPushPayload(customerName: string, lineCount: number) {
  return { title: 'طلب جديد من المنيو', body: `${customerName} — ${lineCount} صنف`, tag: 'catalog-order', url: '/rep?screen=orders' };
}

// ═══ مطابقة الجوال بعميلٍ قائم ═══

/** مفتاح جوال الطلب: الأرقام الهندية لاتينيةً ثم phoneKey (هوية الجوال في المنصّة، services/phoneKey.ts) — أو null */
export function orderPhoneKey(phone: string | null | undefined): string | null {
  const k = phoneKey(asciiDigits(String(phone ?? '')));
  return k || null;
}

/**
 * مفتاحٌ يصلح للمطابقة: ثمانية أرقامٍ على الأقل وليست رقماً واحداً مكرّراً. جوال العميل اختياريٌّ في المنصّة وكثيرٌ منه
 * عبثٌ («0000000»، «12345»)، فلو طابقناه لاقترح التطبيق على المندوب عميلاً غريباً يصدر فاتورته باسمه
 */
export function matchableKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.length >= 8 && !/^(\d)\1*$/.test(key);
}

/** ذيل المفتاح لترشيح المرشّحين في SQL (آخر ثمانية أرقام من أرقام الجوال) — والحكم بعده بالمفتاح الكامل في JS */
export const phoneTail = (key: string): string => key.slice(-8);

export interface CustomerCandidate { id: string; name: string; phone: string | null; createdAt: Date | string }

/**
 * أحدث عميلٍ في الشركة جوّاله بمفتاح الطلب نفسه **ويصل إليه المندوب** (`canSee` — قيد عزل العملاء، services/customerScope.ts)
 * — أو null. المرشّحون بأيّ ترتيب؛ والمفتاح غير الصالح للمطابقة لا يطابق شيئاً
 */
export function pickMatchedCustomer(
  key: string | null | undefined, candidates: readonly CustomerCandidate[], canSee: (id: string) => boolean,
): { id: string; name: string } | null {
  if (!matchableKey(key)) return null;
  let best: CustomerCandidate | null = null;
  for (const c of candidates) {
    if (orderPhoneKey(c.phone) !== key || !canSee(c.id)) continue;
    if (!best) { best = c; continue; }
    const d = new Date(c.createdAt).getTime() - new Date(best.createdAt).getTime();
    if (d > 0 || (d === 0 && c.id > best.id)) best = c;
  }
  return best ? { id: best.id, name: best.name } : null;
}

// ═══ الحالة والعرض ═══

export const isOpenStatus = (s: unknown): boolean => s === 'NEW' || s === 'SEEN';
/** الإغلاق (تم/إلغاء) من مفتوحٍ وحده — ما أُغلق لا يُعاد فتحه ولا يُغلق ثانيةً بحالٍ أخرى */
export const canDecide = (from: unknown): boolean => isOpenStatus(from);

const statusBodySchema = z.object({
  status: z.enum(['DONE', 'CANCELLED']),
  invoiceId: z.string().min(1).max(64).nullish().transform((v) => v ?? null),
});

/**
 * جسم الإغلاق: الحالة DONE أو CANCELLED، والفاتورة المربوطة اختيارية — ومع الإلغاء وحده لا تُقبل:
 * طلبٌ مُلغى بفاتورة تناقضٌ يضلّل من يقرأ السجلّ
 */
export function parseStatusBody(body: unknown): { ok: true; status: 'DONE' | 'CANCELLED'; invoiceId: string | null } | { ok: false; field: string } {
  const r = statusBodySchema.safeParse(body);
  if (!r.success) return { ok: false, field: String(r.error.issues[0]?.path?.[0] ?? 'body') };
  if (r.data.status === 'CANCELLED' && r.data.invoiceId) return { ok: false, field: 'invoiceId' };
  return { ok: true, status: r.data.status, invoiceId: r.data.invoiceId };
}

/** عدّادا الأيقونة من تجميع الحالات: المفتوح كله، والجديد منه (لم يفتحه المندوب بعد) */
export function openCounts(groups: readonly { status: string; _count: { _all: number } | number }[]): { open: number; fresh: number } {
  let open = 0;
  let fresh = 0;
  for (const g of groups) {
    const n = typeof g._count === 'number' ? g._count : g._count?._all ?? 0;
    if (!isOpenStatus(g.status)) continue;
    open += n;
    if (g.status === 'NEW') fresh += n;
  }
  return { open, fresh };
}

export interface CatalogOrderRow {
  id: string;
  status: string;
  customerName: string;
  customerPhone: string;
  note: string | null;
  invoiceId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  items: { id: string; productId: string | null; productName: string; unitName: string | null; unitFactor: number; qty: number; unitPrice: number; taxPct: number }[];
}

/** شكل الطلب في ردّ المندوب — بلا مفاتيح داخلية (الشركة، clientRef، مفتاح الجوال) */
export function shapeOrder(o: CatalogOrderRow, matchedCustomer: { id: string; name: string } | null) {
  return {
    id: o.id,
    status: o.status,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    note: o.note,
    invoiceId: o.invoiceId,
    decidedAt: o.decidedAt,
    createdAt: o.createdAt,
    items: o.items.map((i) => ({
      id: i.id, productId: i.productId, productName: i.productName, unitName: i.unitName, unitFactor: i.unitFactor,
      qty: i.qty, unitPrice: i.unitPrice, taxPct: i.taxPct,
    })),
    matchedCustomer,
  };
}
