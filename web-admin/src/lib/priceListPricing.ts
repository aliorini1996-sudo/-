/**
 * «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — تسعير البند في الأجهزة: فاتورة الإدارة و/m وتطبيق المندوب.
 *
 * طبقةٌ رقيقة فوق الحلّ المشترك lib/priceRules.ts (نسخة services/priceRules.ts حرفاً) وchoiceNet (rep/repUnits.ts)،
 * فيقترح الجهاز السعر الذي يحرسه الخادم بالحساب نفسه (routes/invoices.ts):
 *   سعر العميل الخاص (لوحدة الأساس) ⇐ يغلب كل شيء كاليوم: choiceNet(c, base, cust)
 *   وإلا ما تقوله القائمة (سعر الصنف الثابت فيها + قواعدها) بكمية الصنف في الفاتورة كلّها ويوم الفاتورة: listLineRef
 *   وإلا سلّم اليوم: سعر الوحدة المحدَّد ثم الأساس × المعامل = choiceNet(c, base, null)
 * والنسبة تُحسب من «سعر البند بلا قائمة» نفسه (choiceNet بلا تجاوز) كما في الخادم.
 */
import { choiceNet, type UnitChoice } from '../rep/repUnits';
import { primaryUnitOf, type UnitDef } from './units';
import {
  listLineRef, listPriceOf, qtyPrimaryOf, rulesDependOnQty, type ListPriceResult, type PriceRuleProduct, type PriceRuleRow,
} from './priceRules';
import { todayLocal } from './shelfLife';

export type { PriceRuleRow } from './priceRules';

/** الصنف كما يصل للأجهزة (الحقول التي يحتاجها الحلّ) */
export interface PricedProduct {
  id: string;
  basePrice: number | string;
  categoryId?: string | null;
  primaryUnitId?: string | null;
  units?: UnitDef[] | null;
}

/** الصنف بما يحتاجه الحلّ: فئته ومعامل رئيسيّته (1 بلاها) */
export function ruleProductOf(p: PricedProduct): PriceRuleProduct {
  const f = Number(primaryUnitOf(p)?.factor);
  return { id: p.id, categoryId: p.categoryId ?? null, primaryFactor: Number.isFinite(f) && f > 0 ? f : 1 };
}

/** يوم الشركة للحظةٍ بمنطقتها الزمنية 'YYYY-MM-DD' (كـcompanyDayOf في الخادم)، وإلا اليوم المحلي للجهاز */
export function companyDayIn(tz: string | null | undefined, now: Date = new Date()): string {
  if (typeof tz === 'string' && tz.trim() !== '') {
    try {
      const s = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    } catch { /* منطقةٌ مجهولة ⇒ اليوم المحلي */ }
  }
  return todayLocal(now);
}

/** يوم الفاتورة على الجهاز 'YYYY-MM-DD': تاريخٌ اختاره المستخدم إن صحّ، وإلا يوم الشركة بمنطقتها (tz)، وإلا اليوم المحلي */
export function pricingDayOf(chosen?: string | null, now: Date = new Date(), tz?: string | null): string {
  if (typeof chosen === 'string' && /^\d{4}-\d{2}-\d{2}/.test(chosen)) return chosen.slice(0, 10);
  return companyDayIn(tz, now);
}

/** مجموع كمية كل صنفٍ بالأساس من بنود الفاتورة (البنود المرتبطة بفاتورة بيع تُستبعد بالمستدعي) */
export function baseQtyByProduct(lines: ReadonlyArray<{ productId?: string | null; qty?: number | string | null; factor?: number | null }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!l?.productId) continue;
    const q = Number(l.qty);
    const f = Number(l.factor ?? 1);
    if (!Number.isFinite(q) || q <= 0) continue;
    m.set(l.productId, (m.get(l.productId) ?? 0) + q * (Number.isFinite(f) && f > 0 ? f : 1));
  }
  return m;
}

/** ما تقوله القائمة للصنف بكميته (بالأساس) ويومه — بلا قواعد ولا سعر ثابت ⇒ null */
export function listResultFor(
  p: PricedProduct, itemPerBase: number | null | undefined, rules: readonly PriceRuleRow[] | null | undefined,
  totalBaseQty: number, day: string,
): ListPriceResult {
  const rp = ruleProductOf(p);
  return listPriceOf(itemPerBase, rules, rp, qtyPrimaryOf(totalBaseQty, rp), day);
}

/**
 * السعر الصافي لوحدة البند: سعر العميل الخاص، ثم القائمة (ثابتها وقواعدها)، ثم سلّم اليوم.
 * `custPerBase`/`itemPerBase` لوحدة الأساس كما يُخزَّنان (بعد rebaseCustPrices للكاش)، و`rules` قواعد القائمة المختارة وحدها.
 */
export function lineNetWithList(
  c: UnitChoice, p: PricedProduct, custPerBase: number | null | undefined, itemPerBase: number | null | undefined,
  rules: readonly PriceRuleRow[] | null | undefined, totalBaseQty: number, day: string,
): number {
  if (custPerBase != null && Number.isFinite(Number(custPerBase))) return choiceNet(c, p.basePrice, Number(custPerBase));
  const noList = choiceNet(c, p.basePrice, null);
  const ref = listLineRef(listResultFor(p, itemPerBase, rules, totalBaseQty, day), c.factor, noList);
  return ref ?? noList;
}

/** هل تتغيّر أسعار القائمة بالكمية (فيُعاد تسعير البنود غير المعدَّلة يدوياً عند تغيّرها)؟ */
export function listDependsOnQty(rules: readonly PriceRuleRow[] | null | undefined): boolean {
  return rulesDependOnQty(rules);
}
