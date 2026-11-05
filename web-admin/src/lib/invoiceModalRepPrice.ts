/**
 * «نوع سعر المندوب» في نافذة فاتورة الإدارة (InvoiceModal — طلب المالك ٢ نوفمبر ٢٠٢٦) — منطقٌ صرف بلا React ولا شبكة، يُختبر وحده
 * (invoiceModalRepPrice.test.ts). القاعدة نفسها defaultPriceTypeOf المشتركة مع الخادم حرفاً — لا تُكرَّر هنا.
 *
 * نوع الفاتورة: ما اختاره المدير برقاقة إن اختار — والمدير حرٌّ بين كل الأنواع (قيد «الأنواع المسموحة» للمندوب وحده) — وإلا
 * الافتراضي: نوع العميل ?? النوع الافتراضي للمندوب المختار ?? السعر الأساسي (null). تغيير العميل يعيد الاختيار إلى الافتراضي كما كان،
 * وتغيير المندوب يغيّر الافتراضي وحده: النوع يتبعه ما لم يختر المدير رقاقة. والبنود التي لم يُعدَّل سعرها تُعاد بالنوع الجديد.
 *
 * ═══ «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — تسعير البند في فاتورة الإدارة و/m (MInvoiceCreate عبر mUnits) ═══
 * المسعِّر الواحد `docLinePricerOf`: سعر العميل الخاص يغلب كل شيء كاليوم، ثم ما تقوله قائمة الفاتورة (سعر الصنف الثابت فيها
 * وقواعدها: نسبة، فئة، حدٌّ أدنى للكمية، فترة) **بكمية الصنف في الفاتورة كلّها** ويوم الفاتورة (pricingDayOf)، ثم سلّم اليوم —
 * عبر lineNetWithList (lib/priceListPricing.ts) فيُقترح ما يحسبه حارس الخادم. ⚠️ صافياً قبل الضريبة، ويُقرَّب لأربع منازل حين يأتي
 * من سعر العميل أو القائمة كما كان suggestedNetOf (١٠٠ ÷ ٢٤ × ٢٤ = 100.000008)، وبلاهما choiceNet كما كان حرفاً.
 * والكمية تغيّر السعر الآن (شريحة «من ١٠ كراتين»)، فكل تغيّرٍ في كمية صنفٍ يعيد تسعير بنوده التي لم يمسّها المستخدم وحدها
 * (`repriceDocLines` ← repriceUntouched): المعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده.
 * شركةٌ بلا قوائم: لا قواعد تُجلب ولا قائمة، فالمسعِّر سعر العميل ثم choiceNet — الناتج نفسه حرفاً، وإعادة التسعير بالكمية لا تغيّر شيئاً.
 */
import { defaultPriceTypeOf, listPriceMap, repriceUntouched } from './priceLists';
import { roundHalfUp } from './money';
import type { ProductListPrice } from '../types';
import { choiceById, rebaseCustPrices, type CustPriceInput, type UnitChoice, type UnitProduct } from '../rep/repUnits';
import { baseQtyByProduct, lineNetWithList, listResultFor, type PricedProduct, type PriceRuleRow } from './priceListPricing';

/** اختيار المدير برقاقة: undefined = لم يختر (يتبع الافتراضي)، null = السعر الأساسي صريحاً، أو معرّف نوع */
export type AdminListChoice = string | null | undefined;

/** نوع سعر الفاتورة الذي تُسعَّر به البنود ويُرسل — شركةٌ بلا أنواع ⇒ null (ولا مفتاح في الجسم) */
export function adminInvoiceListOf(
  listsOn: boolean, choice: AdminListChoice, custList: string | null | undefined, repDefault: string | null | undefined,
): string | null {
  if (!listsOn) return null;
  return choice !== undefined ? choice : defaultPriceTypeOf(custList, repDefault);
}

/**
 * تلميح الرقاقة حين يخالف النوعُ افتراضيَّ الفاتورة: 'rep' حين يأتي الافتراضي من المندوب (العميل بلا نوع)، و'customer' لعميلٍ
 * مختار (نوعه أو السعر الأساسي كما كان)، وإلا null
 */
export function adminListHintOf(
  type: string | null, custList: string | null | undefined, repDefault: string | null | undefined, hasCustomer: boolean,
): 'customer' | 'rep' | null {
  if (type === defaultPriceTypeOf(custList, repDefault)) return null;
  if (!custList && repDefault) return 'rep';
  return hasCustomer ? 'customer' : null;
}

// ═══════════════ «قوائم الأسعار» بقواعدها: تسعير البند بكمية صنفه في الفاتورة ═══════════════

/** الصنف كما تسعّره فاتورة الإدارة و/m: وحداته وسعر أساسه وفئته وسعره الثابت في كل قائمة (listPrices في GET /products) */
export interface DocPricedProduct extends UnitProduct {
  id: string;
  /** سعر وحدة الأساس صافياً قبل الضريبة */
  basePrice?: number | string | null;
  /** فئة الصنف — بها تنطبق قواعد الفئة */
  categoryId?: string | null;
  listPrices?: ProductListPrice[] | null;
  /** حقبة أساس الصنف — بها تُعاد أسعار العميل وسعر قاعدة الصنف المقروءان قبل تحويلٍ إلى أساسه الحالي */
  baseConvertedAt?: string | Date | null;
}

/** قاعدة كما يردّها GET /price-lists/rules: صفّ الحلّ ومعرّف قائمته، ولقاعدة الصنف أساسه كما قُرئت (إن أرسله الخادم) */
export type DocPriceRule = PriceRuleRow & { priceListId?: string | null; unit?: string | null; baseConvertedAt?: string | Date | null };

/** مسعِّر البند: السعر الصافي لوحدة البند `c` بكمية صنفه في الفاتورة كلّها (بالأساس) */
export type DocLinePricer<P extends DocPricedProduct = DocPricedProduct> = (p: P, c: UnitChoice, totalBaseQty: number) => number;

const NO_RULES: readonly PriceRuleRow[] = Object.freeze([]) as readonly PriceRuleRow[];

/** قواعد قائمة الفاتورة وحدها من قواعد الشركة كلّها — بلا قائمة (السعر الأساسي) أو بلا قواعد (أو ردٌّ تالف) ⇒ [] */
export function rulesOfList<R extends { priceListId?: string | null }>(rules: readonly R[] | null | undefined, listId: string | null | undefined): R[] {
  if (!listId || !Array.isArray(rules) || !rules.length) return [];
  return rules.filter(r => !!r && r.priceListId === listId);
}

/**
 * سعر قاعدة الصنف الثابت (لوحدة الأساس) قُرئ على أساسٍ غير أساس الصنف المعروض (تحويلٌ بين جلب الأصناف وجلب القواعد): يُعاد إلى
 * أساسه الحالي بقاعدة أسعار العميل نفسها (rebaseCustPrices) — وما لا يُعرف أساسه يسقط فيُكمل الحلّ بغيره، لا يُضرب في معاملٍ
 * خاطئ. صفٌّ بلا حقبة الأساس (الخادم لم يرسلها) كما هو.
 */
function rebasedRule(r: DocPriceRule, p: DocPricedProduct): DocPriceRule | null {
  if (r.kind !== 'fixed' || !Object.prototype.hasOwnProperty.call(r, 'baseConvertedAt')) return r;
  const raw = Number(r.basePrice);
  if (r.basePrice == null || !Number.isFinite(raw)) return r;
  const v = rebaseCustPrices([{ productId: p.id, price: raw, unit: r.unit ?? null, baseConvertedAt: r.baseConvertedAt ?? null }], [p])[p.id];
  if (v === undefined || !Number.isFinite(v)) return null;
  return v === raw ? r : { ...r, basePrice: v };
}

/** فهرس قواعد القائمة بالصنف والفئة: لا يمرّ الحلّ على كل قواعد القائمة لكل صنفٍ في المنتقي (حتى ٢٠٠٠ قاعدة × ١٠٠٠ صنف) */
function ruleIndexOf(rules: readonly DocPriceRule[]): (p: DocPricedProduct) => readonly PriceRuleRow[] {
  if (!rules.length) return () => NO_RULES;
  const byProduct = new Map<string, DocPriceRule[]>();
  const byCategory = new Map<string, DocPriceRule[]>();
  const all: DocPriceRule[] = [];
  const push = (m: Map<string, DocPriceRule[]>, k: string, r: DocPriceRule) => { const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); };
  for (const r of rules) {
    if (!r) continue;
    if (r.scope === 'product' && r.productId) push(byProduct, String(r.productId), r);
    else if (r.scope === 'category' && r.categoryId) push(byCategory, String(r.categoryId), r);
    else if (r.scope === 'all') all.push(r);
  }
  return (p) => {
    const own = (byProduct.get(p.id) ?? []).map(r => rebasedRule(r, p)).filter((r): r is DocPriceRule => r !== null);
    const cat = p.categoryId ? byCategory.get(String(p.categoryId)) ?? [] : [];
    return own.length || cat.length || all.length ? [...own, ...cat, ...all] : NO_RULES;
  };
}

export interface DocPricingInput {
  /** قائمة الفاتورة (null = السعر الأساسي) — adminInvoiceListOf أو listId في /m */
  listId: string | null | undefined;
  /** أسعار العميل الخاصة كما يردّها /products/customer-prices (لوحدة الأساس) */
  custRows?: CustPriceInput[] | null;
  /** قواعد القوائم كلّها (GET /price-lists/rules) — تُصفّى هنا بقائمة الفاتورة. null/غائب ⇒ لا قواعد (شركةٌ بلا قوائم، أو قبل وصولها) */
  rules?: readonly DocPriceRule[] | null;
  /** يوم الفاتورة 'YYYY-MM-DD' — pricingDayOf(تاريخ الفاتورة المختار) */
  day: string;
}

/**
 * المسعِّر الواحد لفاتورة الإدارة و/m (انظر رأس الملف): سعر العميل الخاص ⇐ القائمة (ثابتها وقواعدها بالكمية واليوم) ⇐ سلّم اليوم،
 * صافياً — مقرَّباً لأربع منازل حين يأتي من سعر العميل أو القائمة (suggestedNetOf)، وchoiceNet كما كان حرفاً بلاهما.
 */
export function docLinePricerOf({ listId, custRows, rules, day }: DocPricingInput): DocLinePricer {
  const custBy = new Map<string, CustPriceInput[]>();
  for (const r of Array.isArray(custRows) ? custRows : []) {
    if (!r || r.productId == null) continue;
    const k = String(r.productId);
    const a = custBy.get(k);
    if (a) a.push(r); else custBy.set(k, [r]);
  }
  const rulesOf = ruleIndexOf(rulesOfList(rules, listId));
  return (p, c, totalBaseQty) => {
    const mine = custBy.get(p.id);
    const cust = mine ? rebaseCustPrices(mine, [p])[p.id] : undefined;
    const item = listId ? listPriceMap([p], listId)[p.id] : undefined;
    const rs = rulesOf(p);
    const pp: PricedProduct = { id: p.id, basePrice: p.basePrice ?? 0, categoryId: p.categoryId ?? null, primaryUnitId: p.primaryUnitId ?? null, units: p.units ?? null };
    const net = lineNetWithList(c, pp, cust, item, rs, totalBaseQty, day);
    const fromCust = cust != null && Number.isFinite(Number(cust));
    return fromCust || listResultFor(pp, item, rs, totalBaseQty, day) !== null ? roundHalfUp(net, 4) : net;
  };
}

/** كمية كل صنفٍ بالأساس في بنود المحرّر (البنود المرتبطة بفاتورة بيعٍ في جدولها وحدها فلا تدخل) */
export function docBaseQty(lines: ReadonlyArray<{ productId: string; qty: number; unitFactor?: number | null }>): Map<string, number> {
  return baseQtyByProduct(lines.map(l => ({ productId: l.productId, qty: l.qty, factor: l.unitFactor ?? 1 })));
}

/**
 * إعادة تسعير البنود التي لم يمسّها المستخدم (`unitPrice` ما زال `refPrice`) بالمسعِّر الحالي وكمية صنفها في الفاتورة كلّها —
 * repriceUntouched حرفاً: المعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده، وصنفٌ لا يُعرف أو وحدةٌ لم تعد قائمة كما هو، ولا تغيّر ⇒
 * المصفوفة نفسها. تُستدعى عند تغيّر القائمة أو العميل أو القواعد أو اليوم، وعند كل تغيّرٍ في كمية صنف (إضافة، كمية، وحدة، حذف).
 */
export function repriceDocLines<
  L extends { productId: string; unitId?: string | null; qty: number; unitFactor?: number | null; unitPrice: number; refPrice: number },
  P extends UnitProduct,
>(
  lines: L[],
  productOf: (productId: string) => P | null | undefined,
  priceOf: (p: P, c: UnitChoice, totalBaseQty: number) => number,
  withPrice: (l: L, price: number) => L,
): L[] {
  if (!lines.length) return lines;
  const qty = docBaseQty(lines);
  return repriceUntouched(lines, (l) => {
    const p = productOf(l.productId);
    const c = p ? choiceById(p, l.unitId ?? null) : null;
    return p && c ? priceOf(p, c, qty.get(l.productId) ?? 0) : null;
  }, withPrice);
}
