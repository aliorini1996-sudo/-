/**
 * «أنواع الأسعار على مستوى المندوب» في صلاحيات المندوب على الجوال (طلب المالك ٢ نوفمبر ٢٠٢٦) — منطق الخانات صرفاً بلا React ولا
 * شبكة، يُختبر وحده (mPriceLists.test.ts). والقواعد نفسها في lib/priceLists.ts (allowedPriceTypesOf) ومرآتها في الخادم:
 *  - لا خانة مختارة = «كل الأنواع» = `allowedPriceTypes: null` (سلوك اليوم حرفاً)؛ وإلا مصفوفة 'base' ومعرّفات الأنواع بترتيب العرض
 *    (السعر الأساسي أولاً ثم الأنواع بترتيب الشركة).
 *  - «النوع الافتراضي» من المختارة وحدها (أو كل الأنواع بلا اختيار) — والخادم يرفض افتراضيّاً خارجها (400
 *    PRICE_TYPE_DEFAULT_NOT_ALLOWED)، فإزالة خانة الافتراضي تنقله إلى أول المختارة أمام العين لا في الخفاء.
 *  - null في الحالة = السعر الأساسي، ويُكتب 'base' في المصفوفة وnull في `defaultPriceListId`.
 */
import { BASE_PRICE_TYPE, allowedPriceTypesOf } from '../lib/priceLists';

export interface RepPriceTypesState {
  /** الأنواع المختارة بترتيب العرض (null = السعر الأساسي) — فارغة = كل الأنواع */
  checked: Array<string | null>;
  /** النوع الافتراضي للمندوب (null = السعر الأساسي) */
  def: string | null;
}

/** الأنواع بترتيب العرض: السعر الأساسي ثم أنواع الشركة بترتيبها — وما لم يعد من أنواعها يسقط */
function ordered(types: ReadonlyArray<string | null>, listIds: readonly string[]): Array<string | null> {
  return [null, ...listIds].filter(t => types.includes(t));
}

/** الخيارات المعروضة لـ«النوع الافتراضي»: المختارة، أو كل الأنواع والسعر الأساسي بلا اختيار */
export function defaultOptionsOf(checked: ReadonlyArray<string | null>, listIds: readonly string[]): Array<string | null> {
  return checked.length ? ordered(checked, listIds) : [null, ...listIds];
}

/** افتراضيٌّ خارج الخيارات (أُزيلت خانته، أو نوعٌ لم يعد) ⇒ أوّلها؛ وإلا كما هو */
function defWithin(def: string | null, checked: Array<string | null>, listIds: readonly string[]): string | null {
  const opts = defaultOptionsOf(checked, listIds);
  return opts.includes(def) ? def : opts[0] ?? null;
}

/** حالة الخانات من صفّ المندوب كما ردّه الخادم */
export function repPriceTypesOf(
  rep: { defaultPriceListId?: string | null; allowedPriceTypes?: unknown }, listIds: readonly string[],
): RepPriceTypesState {
  const checked = ordered(allowedPriceTypesOf(rep.allowedPriceTypes) ?? [], listIds);
  return { checked, def: defWithin(rep.defaultPriceListId ?? null, checked, listIds) };
}

/** حالةٌ عدّلها المستخدم بعد أن تبدّلت أنواع الشركة (نوعٌ حُذف منذ فُتحت الشاشة): تسقط خانته ويبقى الافتراضي داخل الباقية */
export function priceTypesWithin(s: RepPriceTypesState, listIds: readonly string[]): RepPriceTypesState {
  const checked = ordered(s.checked, listIds);
  return { checked, def: defWithin(s.def, checked, listIds) };
}

/**
 * نقر خانة نوعٍ: تُضاف أو تُزال بترتيب العرض، والافتراضي يبقى داخل المختارة. وأول خانةٍ تُنقر من «كل الأنواع» (لا اختيار) تضمّ
 * الافتراضيّ الحالي معها مختاراً: كانت تنقله إليها في الخفاء، فإن أعاد المدير خانة الافتراضيّ القديم بعدها بقي الجديد وتبدّل تسعير
 * عملاء المندوب بلا نوع عند الحفظ. وإزالة خانته بعد ذلك تنقله أمام العين كما كان
 */
export function togglePriceType(s: RepPriceTypesState, t: string | null, listIds: readonly string[]): RepPriceTypesState {
  const next = s.checked.includes(t) ? s.checked.filter(x => x !== t) : s.checked.length ? [...s.checked, t] : [s.def, t];
  const checked = ordered(next, listIds);
  return { checked, def: defWithin(s.def, checked, listIds) };
}

/** اختيار «النوع الافتراضي» — من الخيارات المعروضة وحدها، وغيرها لا يغيّر شيئاً */
export function setDefaultPriceType(s: RepPriceTypesState, def: string | null, listIds: readonly string[]): RepPriceTypesState {
  return defaultOptionsOf(s.checked, listIds).includes(def) ? { ...s, def } : s;
}

/** الحقلان في جسم PUT /sales-reps/:id — لا اختيار ⇒ null (كل الأنواع) */
export function repPriceTypesBody(s: RepPriceTypesState): { defaultPriceListId: string | null; allowedPriceTypes: string[] | null } {
  return {
    defaultPriceListId: s.def,
    allowedPriceTypes: s.checked.length ? s.checked.map(t => t ?? BASE_PRICE_TYPE) : null,
  };
}

/** هل تغيّرت الحالة عمّا ردّه الخادم — الحقلان يُرسلان حينها وحدها، فحفظ الصلاحيات لا يعيد كتابة ما لم يُمسّ */
export function repPriceTypesDirty(initial: RepPriceTypesState, now: RepPriceTypesState): boolean {
  return JSON.stringify(repPriceTypesBody(initial)) !== JSON.stringify(repPriceTypesBody(now));
}
