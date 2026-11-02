/**
 * «أنواع الأسعار» (طلب المالك، ١ نوفمبر ٢٠٢٦) — أسعارٌ مسمّاة تحدّدها الشركة بحرّية («سعر الجملة»، «سعر التجزئة»…)، صرفةٌ هنا
 * بلا قاعدة ولا Express. الموجّه routes/priceLists.ts، وحارس الفاتورة في routes/invoices.ts.
 *
 * - **السعر لوحدة الأساس صافياً بستّ منازل** كـCustomerPrice تماماً: يُدخَل بالوحدة الرئيسية (أو الأساس بلاها) ويُقسم على
 *   معاملها، فتُشتقّ بقية الوحدات بمعاملها، ويقسمه convert-base على F مع أسعار العملاء.
 * - **الترتيب:** سعر العميل الخاص يغلب النوع، والنوع يغلب سعر الوحدة المحدَّد والأساس — أي سلسلة اليوم نفسها و«سعر العميل»
 *   فيها = سعر العميل ?? سعر النوع (refOverrideOf).
 * - **نوع المستند:** المرسل إن حضر مفتاحه، وإلا نوع العميل — فالعميل القديم وصندوق الأوف-لاين القديم بلا المفتاح كما كانا.
 * - شركةٌ بلا أنواع = سلوك اليوم حرفياً: لا استعلام زائد في مسار الإصدار.
 */
import { roundHalfUp } from '../lib/money';

/** أقصى طول لاسم نوع السعر واسم زرّ السعر الأساسي */
export const PRICE_LIST_NAME_MAX = 40;
/** منازل سعر النوع لوحدة الأساس — كسعر العميل المستورد من سعر كرتون (import.ts): ×٢٤ يعيد سعر الكرتون بالهللة */
export const LIST_PRICE_DECIMALS = 6;

export const PRICE_LIST_MESSAGES = Object.freeze({
  PRICE_LIST_INVALID: 'نوع السعر غير موجود',
  PRICE_LIST_FORBIDDEN: 'لا تملك صلاحية تبديل نوع السعر',
  PRICE_LIST_IN_USE: 'نوع السعر مستخدم لعملاء انقلهم إلى نوع آخر أولاً',
  PRICE_LIST_NAME_TAKEN: 'يوجد نوع سعر بهذا الاسم',
  PRICE_LIST_NAME_INVALID: `اسم نوع السعر من حرف إلى ${PRICE_LIST_NAME_MAX} حرفاً`,
  // «أنواع الأسعار على مستوى المندوب» (٢ نوفمبر ٢٠٢٦): نافذة المندوب — افتراضيٌّ خارج الأنواع المحدَّدة له
  PRICE_TYPE_DEFAULT_NOT_ALLOWED: 'النوع الافتراضي للمندوب يجب أن يكون من الأنواع المسموحة له',
  // رسالة 403 PRICE_LIST_FORBIDDEN (بـreason: PRICE_TYPE_NOT_ALLOWED_REASON) لمندوبٍ يملك «تبديل نوع السعر» والنوع خارج أنواعه
  // المسموحة — لا «لا تملك صلاحية»: صلاحيته قائمة، والتطبيق لا يطفئ رقائقه بها
  PRICE_TYPE_NOT_ALLOWED: 'نوع السعر غير مسموح لك',
});
/** وسم reason في ردّ 403 PRICE_LIST_FORBIDDEN: النوع خارج الأنواع المسموحة لا الصلاحية (غيابه = بلا «تبديل نوع السعر») */
export const PRICE_TYPE_NOT_ALLOWED_REASON = 'NOT_ALLOWED';
export type PriceListCode = keyof typeof PRICE_LIST_MESSAGES;

/**
 * رسالة 409 PRICE_LIST_IN_USE بما يمنع الحذف: عملاء عليه، أو مناديب هو افتراضيّهم أو من أنواعهم المسموحة، أو كلاهما —
 * والرمز واحد، والعددان customersCount وrepsCount في الردّ
 */
export const PRICE_LIST_IN_USE_BY = Object.freeze({
  customers: PRICE_LIST_MESSAGES.PRICE_LIST_IN_USE,
  reps: 'نوع السعر مستخدم لمناديب افتراضياً أو ضمن أنواعهم المسموحة عدّل أنواع أسعارهم أولاً',
  both: 'نوع السعر مستخدم لعملاء ومناديب انقل العملاء إلى نوع آخر وعدّل أنواع أسعار المناديب أولاً',
});

/** اسم نوع السعر (أو زرّ الأساس) بعد القصّ — null إن كان فارغاً أو أطول من الحدّ */
export function priceListName(raw: unknown): string | null {
  const name = String(raw ?? '').trim();
  return name.length >= 1 && name.length <= PRICE_LIST_NAME_MAX ? name : null;
}

/**
 * سعر النوع لوحدة الأساس من سعرٍ صافٍ بالوحدة الرئيسية ومعاملها (١ = الأساس نفسه) — نصف-لأعلى بستّ منازل.
 * المعامل التالف يُقرأ ١ (كـfactorOf)، والسعر غير المنتهي null.
 */
export function listBasePriceOf(primaryNet: number, primaryFactor: number | null | undefined): number | null {
  const p = Number(primaryNet);
  if (!Number.isFinite(p) || p < 0) return null;
  const f = Number(primaryFactor);
  return roundHalfUp(p / (Number.isFinite(f) && f > 0 ? f : 1), LIST_PRICE_DECIMALS);
}

/**
 * نوع سعر المستند: المرسل إن حضر مفتاحه (`undefined` = غائب؛ null = السعر الأساسي صراحةً)، وإلا نوع العميل المحفوظ.
 */
export function docPriceListOf(sent: string | null | undefined, customerListId: string | null | undefined): string | null {
  return sent !== undefined ? (sent || null) : (customerListId ?? null);
}

/** سعر لوحدة الأساس يغلب سعر الوحدة والأساس في مرجع الحارس: سعر العميل الخاص، وإلا سعر نوع المستند، وإلا null */
export function refOverrideOf(custPrice: number | null | undefined, listPrice: number | null | undefined): number | null {
  if (custPrice != null && Number.isFinite(Number(custPrice))) return Number(custPrice);
  if (listPrice != null && Number.isFinite(Number(listPrice))) return Number(listPrice);
  return null;
}


// ═══ نوع سعر المندوب (طلب المالك ٢ نوفمبر ٢٠٢٦) — نسختان متطابقتان: backend/src/services/priceLists.ts وweb-admin/src/lib/priceLists.ts ═══

/** «السعر الأساسي» في allowedPriceTypes — يقابله null في نوع المستند */
export const BASE_PRICE_TYPE = 'base';

/** نوع المستند الافتراضي: نوع العميل، وإلا نوع المندوب الافتراضي، وإلا السعر الأساسي (null) */
export function defaultPriceTypeOf(customerListId: string | null | undefined, repDefaultListId: string | null | undefined): string | null {
  return customerListId || repDefaultListId || null;
}

/**
 * الأنواع المسموحة للمندوب من عمود JSON: null = بلا قيد (كل الأنواع والأساسي، كاليوم)؛ وإلا مصفوفة أنواعٍ بلا تكرار بترتيبها،
 * 'base' فيها = null. ما ليس نصّاً يُهمل، ومصفوفةٌ فارغة تبقى فارغة (لا مسموح إلا الافتراضي)
 */
export function allowedPriceTypesOf(raw: unknown): Array<string | null> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<string | null> = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !v) continue;
    const t = v === BASE_PRICE_TYPE ? null : v;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** هل يبدّل المندوب (بصلاحية التبديل) إلى هذا النوع: بلا قيد ⇒ نعم؛ وإلا إن كان افتراضيَّ المستند أو ضمن المسموح */
export function priceTypeAllowed(type: string | null, allowed: Array<string | null> | null, docDefault: string | null): boolean {
  if (allowed === null) return true;
  return type === docDefault || allowed.includes(type);
}

/**
 * الأنواع التي يبدّل بينها المندوب بالترتيب: افتراضيّ المستند أولاً، ثم المسموح (أو الأساسي وكل الأنواع بلا قيد) — بلا تكرار،
 * ومعرّفٌ لم يعد في أنواع الشركة يُسقط (allLists = معرّفات الأنواع الموجودة)
 */
export function switchablePriceTypesOf(
  allowed: Array<string | null> | null, docDefault: string | null, allLists: readonly string[],
): Array<string | null> {
  const pool: Array<string | null> = allowed === null ? [null, ...allLists] : allowed;
  const out: Array<string | null> = [docDefault];
  for (const t of pool) {
    if (t !== null && !allLists.includes(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
