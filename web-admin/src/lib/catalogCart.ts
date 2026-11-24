/**
 * سلّة «منيو المنتجات» العام (طلب المالك ٢٤ نوفمبر ٢٠٢٦): «بالضغط على المنتجات يمكن إتمام طلب» — يضيف عميل الشركة
 * الأصناف من الصفحة العامة /c/{tenantId}/{repId} إلى سلّة، ثم يرسل طلبه فيصل مندوبَ الرابط في تطبيقه («طلب جديد»).
 * الخادم: POST /api/public/catalog/:tenantId/:repId/orders (routes/publicCatalog.ts).
 *
 * منطقٌ صرفٌ بلا React ولا DOM (يختبره catalogCart.test.ts) فتبقى الصفحة عرضاً فقط:
 *  - السطر مفتاحه الصنف + الوحدة (null = وحدة الأساس)، ولا يحمل اسماً ولا سعراً: يُحلّ دائماً من بيانات المنيو الحالية،
 *    فسلّةٌ محفوظة من أمس تُعرض بأسعار اليوم، وسطرُ صنفٍ أُوقف أو وحدةٍ أُلغيت يسقط بدل أن يُرسَل فيرفضه الخادم؛
 *  - الإجمالي «تقريبي» بمعادلة بطاقة المنيو حرفاً (catalogGross — تستعملها CatalogPrices نفسها) لأنّ السعر النهائي
 *    يحكمه المندوب بقواعد تسعيره عند تحويل الطلب لفاتورة، والخادم يلتقط الأسعار من القاعدة لا من المتصفّح؛
 *  - حدود الجسم مرآةُ حدود الخادم (الاسم ٢..٨٠، الجوال ٥..٣٠، الملاحظة ≤٣٠٠، ١..١٠٠ سطر، الكمية ≤١٠٠٠٠٠ بثلاث خانات)؛
 *  - الحفظ في localStorage لكل رابط (شركة/مندوب) ملفوفٌ بـtry/catch: التصفّح الخاص أو التخزين المحجوب لا يُسقط الصفحة.
 */
import { roundDecimal } from '../rep/invoiceCalc';
import { latinDigits } from './loginErrors';

export const CART_MAX_LINES = 100;
export const CART_MAX_QTY = 100000;
export const ORDER_NAME_MIN = 2;
export const ORDER_NAME_MAX = 80;
export const ORDER_PHONE_MIN = 5;
export const ORDER_PHONE_MAX = 30;
export const ORDER_NOTE_MAX = 300;
/** أقلّ أرقامٍ لجوالٍ يصل إليه المندوب اتصالاً وواتساباً (كحدّ wa.me في rep/customerPhone) — الخادم يقبل ٥ أحرف، والصفحة أشدّ */
export const ORDER_PHONE_MIN_DIGITS = 7;

/** وحدة بيعٍ كما يرسلها GET المنيو — `id` يصل مع ميزة الطلب (`orderEnabled`)، وغيابه = خادمٌ أقدم لا يُطلب منه */
export interface CartUnitLike { id?: string; name: string; factor: number; price: number; isPrimary?: boolean }
/** صنف المنيو بالقدر الذي تحتاجه السلّة (CatalogProduct في الصفحة يوافقه بنيوياً) */
export interface CartProductLike { id?: string; name: string; unit: string; basePrice: number; taxPct: number; units?: CartUnitLike[] }

/** سطر السلّة كما يُحفظ ويُرسَل: الكمية بوحدة السطر */
export interface CartLine { productId: string; unitId: string | null; qty: number }

/** خيار في منتقي الوحدة: `unitId` null = وحدة الأساس بسعرها `basePrice` */
export interface CartUnitOption { unitId: string | null; name: string; factor: number; price: number }

/** سطرٌ محلولٌ من بيانات المنيو الحالية — للعرض والإجمالي */
export interface ResolvedCartLine extends CartLine {
  key: string;
  name: string;
  /** «كرتون (24 حبة)» أو اسم وحدة الأساس — بوسم بطاقة المنيو نفسه */
  unitLabel: string;
  /** السعر الصافي (قبل الضريبة) لوحدة السطر كما في المنيو */
  netPrice: number;
  taxPct: number;
  /** سعر وحدة السطر شاملاً الضريبة — ما تعرضه البطاقة */
  grossUnit: number;
  lineTotal: number;
}

export interface ResolvedCart { lines: ResolvedCartLine[]; count: number; total: number }

/** مفتاح السطر: الصنف + الوحدة — الصنف نفسه بالكرتون وبالحبة سطران */
export function cartLineKey(productId: string, unitId: string | null): string {
  return `${productId}|${unitId ?? ''}`;
}

/**
 * سعر وحدةٍ شاملاً الضريبة — معادلة بطاقة المنيو حرفاً (كانت `gross` داخل CatalogPrices، ومعادلة السعر المعلن في تطبيق
 * المندوب). مصدرٌ واحد للبطاقة والسلّة فلا يختلف سعر الكرتون في البطاقة عنه في السلّة بكسر.
 */
export function catalogGross(price: number, taxPct: number, dec: number): number {
  return roundDecimal(Number(price) * (1 + Number(taxPct) / 100), dec);
}

const hasId = (u: CartUnitLike): u is CartUnitLike & { id: string } => typeof u.id === 'string' && u.id.length > 0;

/**
 * خيارات منتقي الوحدة بترتيب البطاقة (catalogPriceLines): الرئيسية أولاً إن وُجدت ثم الأساس ثم البقية، وإلا الأساس ثم
 * الوحدات الأكبر. وحدةٌ بلا معرّف (خادمٌ أقدم) لا تُطلب فلا تُعرض خياراً.
 */
export function cartUnitOptions(p: CartProductLike): CartUnitOption[] {
  const units = (p.units ?? []).filter(hasId);
  const base: CartUnitOption = { unitId: null, name: p.unit, factor: 1, price: p.basePrice };
  const opt = (u: CartUnitLike & { id: string }): CartUnitOption => ({ unitId: u.id, name: u.name, factor: u.factor, price: u.price });
  const primary = units.find(u => u.isPrimary === true);
  if (!primary) return [base, ...units.map(opt)];
  return [opt(primary), base, ...units.filter(u => u !== primary).map(opt)];
}

/** الوحدة الافتراضية للإضافة: الرئيسية (`isPrimary`) — العميل يطلب بالكرتون — وإلا الأساس */
export function defaultUnitId(p: CartProductLike): string | null {
  return (p.units ?? []).filter(hasId).find(u => u.isPrimary === true)?.id ?? null;
}

/**
 * الوحدة المختارة في بطاقة الصنف: اختيار العميل في هذه الجلسة إن كان صالحاً، وإلا وحدة أوّل سطرٍ للصنف في السلّة (فسلّةٌ
 * محفوظة بالحبة تُظهر عدّاد الحبة لا «أضف» على الكرتون)، وإلا الافتراضية.
 */
export function pickedUnitId(p: CartProductLike, cart: CartLine[], picked: Record<string, string | null>): string | null {
  const id = p.id ?? '';
  const valid = new Set(cartUnitOptions(p).map(o => o.unitId));
  if (Object.prototype.hasOwnProperty.call(picked, id) && valid.has(picked[id])) return picked[id];
  const inCart = cart.find(l => l.productId === id && valid.has(l.unitId));
  return inCart ? inCart.unitId : defaultUnitId(p);
}

/** كميةٌ صالحة للسلّة: موجبة، بثلاث خانات (حدّ الخادم)، لا تتجاوز السقف — وغير ذلك صفر (= حذف) */
export function normalizeQty(q: number): number {
  const n = Number(q);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(CART_MAX_QTY, roundDecimal(n, 3));
}

/**
 * الكمية للعرض بأرقام المنيو (ar-SA كأسعار البطاقة) حتى ثلاث خانات، بلا فاصل آلاف: النصّ نفسه يُكتب في خانة الكمية
 * فيجب أن يقرأه parseQtyInput كما هو («١٬٠٠٠» كان سيُقرأ عبثاً).
 */
export function formatQty(q: number): string {
  return Number(q).toLocaleString('ar-SA', { maximumFractionDigits: 3, useGrouping: false });
}

/** نصّ خانة الكمية كما يكتبه العميل (أرقام عربية، فاصلة «٫» أو «,») إلى رقم — الفارغ والعبث صفر */
export function parseQtyInput(text: string): number {
  const s = latinDigits(String(text ?? '')).replace(/[٫,]/g, '.').trim();
  if (!s || !/^\d*\.?\d*$/.test(s)) return 0;
  return normalizeQty(Number(s));
}

/** كمية سطرٍ في السلّة (صفر إن غاب) */
export function cartQty(cart: CartLine[], productId: string, unitId: string | null): number {
  const k = cartLineKey(productId, unitId);
  return cart.find(l => cartLineKey(l.productId, l.unitId) === k)?.qty ?? 0;
}

/**
 * تعيين كمية سطر: صفرٌ أو أقلّ يحذفه، والسطر الجديد يُلحق آخر السلّة ما لم تبلغ حدّ الخادم (١٠٠ سطر) — عندها لا تتغيّر.
 * يعيد مصفوفةً جديدة دائماً حين يتغيّر شيء (حالة React)، والسلّة نفسها حين لا يتغيّر.
 */
export function setCartQty(cart: CartLine[], productId: string, unitId: string | null, qty: number): CartLine[] {
  const q = normalizeQty(qty);
  const k = cartLineKey(productId, unitId);
  const i = cart.findIndex(l => cartLineKey(l.productId, l.unitId) === k);
  if (i < 0) {
    if (q <= 0 || cart.length >= CART_MAX_LINES) return cart;
    return [...cart, { productId, unitId, qty: q }];
  }
  if (q <= 0) return cart.filter((_, j) => j !== i);
  if (cart[i].qty === q) return cart;
  return cart.map((l, j) => (j === i ? { ...l, qty: q } : l));
}

/** «أضف» و+ و−: خطوة واحدة على الكمية الحالية (− من ١ يحذف السطر) */
export function stepCartQty(cart: CartLine[], productId: string, unitId: string | null, delta: number): CartLine[] {
  return setCartQty(cart, productId, unitId, cartQty(cart, productId, unitId) + delta);
}

type Found = { p: CartProductLike & { id: string }; opt: CartUnitOption };

function finder(products: CartProductLike[]): (l: CartLine) => Found | null {
  const byId = new Map<string, CartProductLike & { id: string }>();
  for (const p of products) if (typeof p.id === 'string' && p.id) byId.set(p.id, p as CartProductLike & { id: string });
  return (l) => {
    const p = byId.get(l.productId);
    if (!p) return null;
    const opt = cartUnitOptions(p).find(o => o.unitId === l.unitId);
    return opt ? { p, opt } : null;
  };
}

/** يُسقط أسطر صنفٍ لم يعد في المنيو أو وحدةٍ لم تعد نشطة — بعد تحميل سلّةٍ محفوظة */
export function reconcileCart(cart: CartLine[], products: CartProductLike[]): CartLine[] {
  const find = finder(products);
  const kept = cart.filter(l => find(l) !== null);
  return kept.length === cart.length ? cart : kept;
}

/**
 * السلّة محلولةً من المنيو الحالي بإجماليها التقريبي: سعر وحدة السطر شاملاً الضريبة × الكمية مقرّباً بخانات العملة، ثم
 * المجموع. `taxOff` («إزالة الضريبة») يصفّر النسبة كما تفعل البطاقة (`taxOff ? { ...p, taxPct: 0 } : p`).
 */
export function resolveCart(cart: CartLine[], products: CartProductLike[], opts: { dec: number; taxOff: boolean }): ResolvedCart {
  const find = finder(products);
  const lines: ResolvedCartLine[] = [];
  for (const l of cart) {
    const f = find(l);
    if (!f) continue;
    const taxPct = opts.taxOff ? 0 : Number(f.p.taxPct) || 0;
    const grossUnit = catalogGross(f.opt.price, taxPct, opts.dec);
    lines.push({
      ...l,
      key: cartLineKey(l.productId, l.unitId),
      name: f.p.name,
      unitLabel: f.opt.unitId === null ? f.p.unit : `${f.opt.name} (${f.opt.factor} ${f.p.unit})`,
      netPrice: f.opt.price,
      taxPct,
      grossUnit,
      lineTotal: roundDecimal(grossUnit * l.qty, opts.dec),
    });
  }
  const total = roundDecimal(lines.reduce((s, l) => s + l.lineTotal, 0), opts.dec);
  return { lines, count: lines.length, total };
}

// ═══ إتمام الطلب ═══

/** حقول نافذة الإتمام — `website` حقل الفخّ المخفيّ (يملؤه الروبوت وحده) */
export interface CheckoutForm { name: string; phone: string; note: string; website: string }

export interface CatalogOrderItem { productId: string; unitId: string | null; qty: number }
/** جسم POST …/orders بلا clientRef — منه يُحسب توقيع المحاولة */
export interface CatalogOrderDraft { name: string; phone: string; note?: string; items: CatalogOrderItem[]; website?: string }
export interface CatalogOrderBody extends CatalogOrderDraft { clientRef: string }

const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** الحقول كما تُرسَل: مسافات موحّدة، والجوال بأرقام لاتينية (phoneKey في الخادم لا يقرأ «٠٥٥…» فلا يطابق عميلاً قائماً) */
export function cleanCheckout(form: CheckoutForm): { name: string; phone: string; note: string } {
  return {
    name: oneLine(form.name),
    phone: oneLine(latinDigits(String(form.phone ?? ''))),
    note: String(form.note ?? '').trim(),
  };
}

/** سبب منع الإرسال قبل الخادم (بنصّ الصفحة)، أو null حين يصلح */
export function checkoutProblem(form: CheckoutForm, lineCount: number): string | null {
  const c = cleanCheckout(form);
  if (lineCount <= 0) return 'السلة فارغة — أضف صنفاً أولاً';
  if (c.name.length < ORDER_NAME_MIN || c.name.length > ORDER_NAME_MAX) return 'اكتب اسمك (حرفان على الأقل)';
  const digits = c.phone.replace(/[^0-9]/g, '').length;
  if (c.phone.length < ORDER_PHONE_MIN || c.phone.length > ORDER_PHONE_MAX || digits < ORDER_PHONE_MIN_DIGITS) return 'اكتب رقم جوال صحيح ليتواصل معك المندوب';
  if (c.note.length > ORDER_NOTE_MAX) return `الملاحظة أطول من ${ORDER_NOTE_MAX} حرف`;
  return null;
}

/**
 * جسم الطلب بلا clientRef: أسطرٌ صالحة في المنيو الحالي وحدها (الأسعار لا تُرسَل — الخادم يلتقطها من القاعدة)، والملاحظة
 * والفخّ يغيبان فارغين.
 */
export function orderDraft(form: CheckoutForm, cart: CartLine[], products: CartProductLike[]): CatalogOrderDraft {
  const c = cleanCheckout(form);
  const items = reconcileCart(cart, products)
    .slice(0, CART_MAX_LINES)
    .map(l => ({ productId: l.productId, unitId: l.unitId, qty: normalizeQty(l.qty) }))
    .filter(l => l.qty > 0);
  const website = String(form.website ?? '');
  return {
    name: c.name,
    phone: c.phone,
    ...(c.note ? { note: c.note } : {}),
    items,
    ...(website ? { website } : {}),
  };
}

/** توقيع المحاولة: الجسم نفسه حرفاً = إعادةُ المحاولة نفسها */
export function orderSignature(draft: CatalogOrderDraft): string {
  return JSON.stringify(draft);
}

/** مرجع الإعادة الآمنة المعلّق مع توقيع الجسم الذي وُلّد له */
export interface PendingRef { sig: string; ref: string }

/**
 * clientRef للإرسال: يُعاد المرجع نفسه ما دام الجسم لم يتغيّر — فإعادة المحاولة بعد انقطاعٍ وصل فيه الطلب فعلاً يردّ الخادم
 * عليها بالطلب نفسه (200) لا بطلبٍ مكرّر عند المندوب. وتغيّر السلّة أو البيانات يولّد مرجعاً جديداً، وإلا ردّ الخادم بالطلب
 * القديم فضاع التعديل.
 */
export function pickClientRef(pending: PendingRef | null | undefined, sig: string, gen: () => string): PendingRef {
  if (pending && pending.sig === sig && typeof pending.ref === 'string' && pending.ref) return pending;
  return { sig, ref: gen() };
}

/** رسالة فشل الإرسال بحالة الردّ (null = لا ردّ: الشبكة)، و`reload` حين يلزم تحديث الصفحة */
export function orderFailure(status: number | null): { msg: string; reload?: true } {
  if (status === 429) return { msg: 'طلبات كثيرة — حاول بعد قليل' };
  if (status === 400 || status === 413) return { msg: 'تغيرت قائمة الأصناف — حدّث الصفحة', reload: true };
  // المنيو أُطفئ أو المندوب أُوقف بعد فتح الصفحة — العبارة نفسها التي تعرضها الصفحة للرابط غير المتاح
  if (status === 404) return { msg: 'الرابط غير صحيح او لم يعد متاحا — تواصل مع مندوبك' };
  return { msg: 'تعذر الإرسال — تحقق من الاتصال وأعد المحاولة' };
}

// ═══ الحفظ المحلي ═══

export interface StoredCart { lines: CartLine[]; pending: PendingRef | null }
export type CartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** مفتاح السلّة لكل رابط: عميلٌ يفتح منيو مندوبَين لا تختلط سلّتاهما */
export function cartStorageKey(tenantId: string, repId: string): string {
  return `fs_catalog_cart:${tenantId}/${repId}`;
}

function browserStorage(): CartStorage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** ما يُقرأ من التخزين بيانات غير موثوقة (نسخة قديمة أو عبث): أسطرٌ سليمة الشكل وحدها، بلا تكرار، بالحدود */
export function sanitizeCart(raw: unknown): StoredCart {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { lines?: unknown; pending?: unknown };
  let lines: CartLine[] = [];
  if (Array.isArray(obj.lines)) {
    for (const x of obj.lines as Array<Record<string, unknown>>) {
      if (!x || typeof x !== 'object') continue;
      const productId = x.productId, unitId = x.unitId ?? null;
      if (typeof productId !== 'string' || !productId || (unitId !== null && (typeof unitId !== 'string' || !unitId))) continue;
      lines = setCartQty(lines, productId, unitId as string | null, cartQty(lines, productId, unitId as string | null) + normalizeQty(Number(x.qty)));
    }
  }
  const p = obj.pending as Partial<PendingRef> | null | undefined;
  const pending = p && typeof p === 'object' && typeof p.sig === 'string' && typeof p.ref === 'string' && p.ref ? { sig: p.sig, ref: p.ref } : null;
  return { lines, pending };
}

export function loadCart(tenantId: string, repId: string, storage: CartStorage | null = browserStorage()): StoredCart {
  try {
    const s = storage?.getItem(cartStorageKey(tenantId, repId));
    return sanitizeCart(s ? JSON.parse(s) : null);
  } catch { return { lines: [], pending: null }; }
}

/** السلّة الفارغة تُمحى من التخزين (ومرجعها المعلّق معها — لا معنى لإعادة طلبٍ بلا أسطر) */
export function saveCart(tenantId: string, repId: string, stored: StoredCart, storage: CartStorage | null = browserStorage()): void {
  try {
    const key = cartStorageKey(tenantId, repId);
    if (!stored.lines.length) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify({ lines: stored.lines, pending: stored.pending }));
  } catch { /* تخزينٌ ممتلئ أو محجوب — السلّة تبقى في الذاكرة لهذه الزيارة */ }
}
