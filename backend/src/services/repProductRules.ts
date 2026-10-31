/**
 * «قيود المندوب» على الصنف (طلب المالك ٣١ أكتوبر ٢٠٢٦): ما يفعله **المندوب وحده** بهذا الصنف — يبيعه أم لا، ويُرجعه أم لا،
 * وبأيّ وحدة في كلٍّ منهما. مستخدمو الشركة ومفاتيح API وجلسة المالك أحرار (قرار المالك: المدير يصحّح الاستثناء بنفسه).
 *
 * الوحدة «الصغرى» هي وحدة الأساس (المعامل ١ — الأساس أصغر الوحدات دائماً، services/units.ts unitProblem)، و«الكبرى» كل
 * وحدةٍ معاملها > ١. الافتراضي بلا قيد (true/ANY)، وغياب الحقل (صفٌّ قديم، كاش تطبيقٍ قديم) يُقرأ بلا قيد.
 *
 * المرجع في الخادم: routes/invoices.ts (البيع والمرتجع بمرحلتيه، و/returnable) وroutes/invoicesNotes.ts (الإشعار الدائن).
 * وتطبيق المندوب يعرض القيد نفسه (web-admin/src/rep/repProductRules.ts) — والخادم يقرّر.
 */
import { QTY_EPS } from './units';

export const REP_UNIT_RULES = ['ANY', 'BASE', 'LARGE'] as const;
export type RepUnitRule = typeof REP_UNIT_RULES[number];
export type RepAction = 'SALE' | 'RETURN';

/** رمز رفض بندٍ يخالف قيد المندوب — 422 في POST /invoices وفي الإشعار الدائن */
export const REP_PRODUCT_RULE_CODE = 'REP_PRODUCT_RULE';

export interface RepRuleProduct {
  name?: string | null;
  unit?: string | null;
  repSaleAllowed?: boolean | null;
  repReturnAllowed?: boolean | null;
  repSaleUnit?: string | null;
  repReturnUnit?: string | null;
  repRulesChangedAt?: Date | string | null;
}

/** قيد الوحدة لفعلٍ — قيمةٌ غير معروفة أو غائبة ⇒ ANY */
export function repUnitRuleOf(p: RepRuleProduct, action: RepAction): RepUnitRule {
  const v = action === 'SALE' ? p.repSaleUnit : p.repReturnUnit;
  return (REP_UNIT_RULES as readonly string[]).includes(String(v)) ? (v as RepUnitRule) : 'ANY';
}

/** هل يُسمح للمندوب بالفعل أصلاً — false الصريحة وحدها منع */
export function repActionAllowed(p: RepRuleProduct, action: RepAction): boolean {
  return (action === 'SALE' ? p.repSaleAllowed : p.repReturnAllowed) !== false;
}

/** هل تُسمح وحدةٌ معاملها factor تحت القيد */
export function repUnitAllowed(rule: RepUnitRule, factor: number): boolean {
  const large = Number(factor) > 1 + QTY_EPS;
  return rule === 'ANY' || (rule === 'BASE' ? !large : large);
}

/** سبب رفض بندٍ للمندوب (فعله ووحدته)، أو null حين يُسمح */
export function repLineProblem(p: RepRuleProduct, action: RepAction, unitFactor: number): string | null {
  const name = String(p.name ?? '').trim() || 'هذا الصنف';
  if (!repActionAllowed(p, action)) {
    return action === 'SALE' ? `الصنف «${name}» لا يبيعه المندوب` : `الصنف «${name}» لا يرجعه المندوب`;
  }
  const rule = repUnitRuleOf(p, action);
  if (repUnitAllowed(rule, unitFactor)) return null;
  const verb = action === 'SALE' ? 'يباع' : 'يرجع';
  const base = String(p.unit ?? '').trim();
  return rule === 'BASE'
    ? `الصنف «${name}» ${verb} من المندوب بالوحدة الصغرى${base ? ` (${base})` : ''} فقط`
    : `الصنف «${name}» ${verb} من المندوب بالوحدة الكبرى فقط`;
}

/**
 * مستند صندوق الأوف-لاين (X-FS-Replay) أُنشئ على الجهاز **قبل** آخر تغييرٍ لقيود الصنف ⇒ يُقبل: صدر وسُلّمت بضاعته حين
 * كان مسموحاً، فرفضه يُعدمه في الصندوق. لحظة الجهاز من deviceAt (لا مفتاح API). وبلا لحظةٍ مفهومة أو بلا تغييرٍ مسجَّل ⇒
 * لا تسامح (القيد يُطبَّق): التطبيق يرسل clientCreatedAt دائماً، وطلبٌ يُسقطها ليس صندوقاً.
 * والجهاز يملك ساعته — هذا تسامحٌ للمندوب الأمين مع صندوقه، لا حدٌّ أمني (كسائر تسامح الإعادة).
 */
export function replayPredatesRepRule(p: RepRuleProduct, replay: boolean, deviceAt: string | null | undefined): boolean {
  if (!replay || !deviceAt || p.repRulesChangedAt == null) return false;
  const device = Date.parse(deviceAt);
  const changed = new Date(p.repRulesChangedAt).getTime();
  return Number.isFinite(device) && Number.isFinite(changed) && device < changed;
}

/** القيود الأربعة كما تُحفظ — للمقارنة قبل التعديل وبعده */
type RuleFields = Pick<RepRuleProduct, 'repSaleAllowed' | 'repReturnAllowed' | 'repSaleUnit' | 'repReturnUnit'>;
const norm = (p: RuleFields) => [p.repSaleAllowed !== false, p.repReturnAllowed !== false, repUnitRuleOf(p, 'SALE'), repUnitRuleOf(p, 'RETURN')].join('|');

/** هل غيّر التعديل أيّاً من القيود — يُختم repRulesChangedAt حينها (مرجع تسامح الإعادة) */
export function repRulesChanged(before: RuleFields, after: RuleFields): boolean {
  return norm(before) !== norm(after);
}

/** هل في الصنف قيدٌ غير الافتراضي */
export function hasRepRules(p: RuleFields): boolean {
  return norm(p) !== norm({});
}

/**
 * فحص الإعداد عند الحفظ: «الكبرى فقط» يلزمه وحدةٌ نشطة معاملها > ١ — وإلا صار الصنف ممنوعاً على المندوب بلا قصد.
 * units غائبة (إنشاء صنفٍ جديد بلا وحدات بعد) ⇒ لا وحدة كبرى.
 */
export function repRuleConfigProblem(
  p: RuleFields, units: ReadonlyArray<{ factor: number | string; isActive?: boolean | null }> | null | undefined,
): string | null {
  const wantsLarge = repUnitRuleOf(p, 'SALE') === 'LARGE' || repUnitRuleOf(p, 'RETURN') === 'LARGE';
  if (!wantsLarge) return null;
  const hasLarge = (units ?? []).some((u) => u.isActive !== false && Number(u.factor) > 1 + QTY_EPS);
  return hasLarge ? null : 'قيد «الوحدة الكبرى فقط» يحتاج وحدة كبرى نشطة لهذا الصنف — أضف وحدة أكبر من وحدة الأساس أولا';
}

/**
 * مرتجعٌ من فاتورة بيع (/returnable): بندٌ بيع بوحدة الأساس لا يُرجع منه «بالكبرى فقط» شيء — وحدات الإرجاع لا تتجاوز وحدة
 * البيع (lib/returnInvoice returnUnitChoices). سبب الحجب للمندوب أو null.
 */
export function repLinkedReturnProblem(p: RepRuleProduct, saleUnitFactor: number): string | null {
  if (!repActionAllowed(p, 'RETURN')) return repLineProblem(p, 'RETURN', 1);
  if (repUnitRuleOf(p, 'RETURN') === 'LARGE' && Number(saleUnitFactor) <= 1 + QTY_EPS) {
    return repLineProblem(p, 'RETURN', 1);
  }
  return null;
}
