/**
 * «قيود المندوب» على الصنف (طلب المالك ٣١ أكتوبر ٢٠٢٦) — نسخة العرض في تطبيق المندوب؛ المرجع الخادم
 * (backend/src/services/repProductRules.ts) وهو يرفض المخالف بـ422 REP_PRODUCT_RULE.
 *
 * لكل صنف: يبيعه المندوب أم لا، ويرجعه أم لا، وبأيّ وحدة في كلٍّ منهما — ANY (كل الوحدات)، BASE (الصغرى = وحدة الأساس)،
 * LARGE (الكبرى = كل وحدة معاملها > ١). غياب الحقل (كاشٌ قبل الميزة، خادمٌ أقدم) بلا قيد كافتراض الخادم.
 */
import { unitChoices, type UnitChoice, type UnitProduct } from './repUnits';

export type RepAction = 'SALE' | 'RETURN';
export type RepUnitRule = 'ANY' | 'BASE' | 'LARGE';

const EPS = 1e-9;

export interface RepRuleFields {
  repSaleAllowed?: boolean | null;
  repReturnAllowed?: boolean | null;
  repSaleUnit?: string | null;
  repReturnUnit?: string | null;
}

/** قيد الوحدة لفعل — قيمةٌ مجهولة أو غائبة ⇒ ANY */
export function repUnitRuleOf(p: (UnitProduct & RepRuleFields) | null | undefined, action: RepAction): RepUnitRule {
  const v = action === 'SALE' ? p?.repSaleUnit : p?.repReturnUnit;
  return v === 'BASE' || v === 'LARGE' ? v : 'ANY';
}

/** هل يُسمح بالفعل — false الصريحة وحدها منع */
export function repAllows(p: (UnitProduct & RepRuleFields) | null | undefined, action: RepAction): boolean {
  return (action === 'SALE' ? p?.repSaleAllowed : p?.repReturnAllowed) !== false;
}

/** هل تُسمح وحدةٌ معاملها factor تحت القيد (المعامل ١ = الصغرى) */
export function repUnitOk(rule: RepUnitRule, factor: number): boolean {
  const large = Number(factor) > 1 + EPS;
  return rule === 'ANY' || (rule === 'BASE' ? !large : large);
}

/** وحدات البند المسموحة للمندوب في هذا الفعل — قد تكون فارغة («الكبرى فقط» بلا وحدة كبرى نشطة) */
export function repUnitChoices(p: (UnitProduct & RepRuleFields) | null | undefined, action: RepAction): UnitChoice[] {
  const rule = repUnitRuleOf(p, action);
  return unitChoices(p).filter((c) => repUnitOk(rule, c.factor));
}

/** الوحدة الافتراضية للمندوب: الأكبر بين المسموحة (كـdefaultChoice)، أو null حين لا وحدة مسموحة */
export function repDefaultChoice(p: (UnitProduct & RepRuleFields) | null | undefined, action: RepAction): UnitChoice | null {
  const ok = repUnitChoices(p, action);
  return ok.length ? ok.reduce((a, b) => (b.factor > a.factor ? b : a)) : null;
}

/**
 * سبب منع الصنف على المندوب في هذا الفعل (مفتاح ترجمة عربي)، أو null. يُعرض بجانب الصنف ويُمنع به الإضافة.
 */
export function repBlockKey(p: (UnitProduct & RepRuleFields) | null | undefined, action: RepAction): string | null {
  if (!repAllows(p, action)) return action === 'SALE' ? 'هذا الصنف لا يبيعه المندوب' : 'هذا الصنف لا يرجعه المندوب';
  if (!repUnitChoices(p, action).length) return 'لا وحدة مسموحة للمندوب في هذا الصنف';
  return null;
}

/** سبب رفض بندٍ بوحدته (معاملها) قبل الإصدار — لسلّةٍ قديمة بعد تحديث الكتالوج، أو null */
export function repLineBlockKey(p: (UnitProduct & RepRuleFields) | null | undefined, action: RepAction, factor: number): string | null {
  const whole = repBlockKey(p, action);
  if (whole) return whole;
  const rule = repUnitRuleOf(p, action);
  if (repUnitOk(rule, factor)) return null;
  if (action === 'SALE') return rule === 'BASE' ? 'يباع من المندوب بالوحدة الصغرى فقط' : 'يباع من المندوب بالوحدة الكبرى فقط';
  return rule === 'BASE' ? 'يرجع من المندوب بالوحدة الصغرى فقط' : 'يرجع من المندوب بالوحدة الكبرى فقط';
}
