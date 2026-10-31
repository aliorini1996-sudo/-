// ============================================================================
// تحذير حذف المندوب: ما بقي في سيارته.
// ----------------------------------------------------------------------------
// حذف المندوب لا يمحو تحميلاته بعد الآن (حادثة ٢ أكتوبر ٢٠٢٦: المحو كان يُعيد
// إلى المستودع كل ما حُمّل وبيع)، فرصيد المستودع لا يتغيّر بالحذف. لكنّ ما بقي
// في سيارته يبقى محسوباً «خارج المستودع» ولا سيارةَ تعرضه بعد الحذف — فيُقال
// للمدير قبل التأكيد كم بقي، ليُسجّل تنزيله إن كانت البضاعة قد عادت فعلاً.
// تحذيرٌ لا حجب: الحذف يمضي دائماً (قرار المالك)، ولا حركة مخزون آلية.
// ============================================================================

export interface VanLeft {
  /** أصنافٌ رصيدها موجب في السيارة */
  products: number;
  /** مجموع كمّياتها — بالوحدة الصغرى لكل صنف (`remaining` بالأساس) */
  qty: number;
  /**
   * «الوحدة الرئيسية» (R3، §5.3 «الجوال: المناديب»): في المجموع صنفٌ رئيسيّه كرتون — فالرقم مجموع وحداتٍ صغرى يُوسَم
   * «بالوحدات الصغرى» لا «وحدة» (٤٨ قارورة تُقرأ كراتين). المفتاح لا يحضر إلا صادقاً: بلاه الشكل والنصّ كما كانا (I1).
   */
  anyPrimary?: true;
}

/**
 * يقرأ صفوف `/van-stock/current`. الموجب وحده بضاعةٌ في السيارة؛ السالب بيعٌ
 * بلا مخزون (canSellWithoutStock) لا بضاعة تعود، فلا يُطرح من الموجب ولا يُعدّ.
 * شكلٌ غير متوقَّع يعود صفراً: التحذير لا يُسقط حوار الحذف.
 */
export function vanLeftover(rows: unknown): VanLeft {
  if (!Array.isArray(rows)) return { products: 0, qty: 0 };
  let products = 0;
  let qty = 0;
  let anyPrimary = false;
  for (const r of rows) {
    const row = r as { remaining?: unknown; primaryUnitId?: unknown } | null;
    const n = Number(row?.remaining);
    if (!Number.isFinite(n) || n <= 1e-9) continue;
    products += 1;
    qty += n;
    if (row?.primaryUnitId) anyPrimary = true;
  }
  // أربع خانات كالخادم: غبار الجمع (0.1+0.2) لا يظهر رقماً طويلاً في التحذير
  return { products, qty: Math.round(qty * 1e4) / 1e4, ...(anyPrimary && { anyPrimary: true as const }) };
}

/** نصّ «ما بقي في سيارته» المناسب: بالوحدات الصغرى حين في المجموع صنفٌ له رئيسية، وإلّا النصّ القائم حرفاً */
export function vanLeftText(left: VanLeft): string {
  return left.anyPrimary ? REP_DELETE_VAN.leftSmallest : REP_DELETE_VAN.left;
}

/** نصوص التحذير — مفاتيح القاموس (strings.ts) بالعربية، و{qty} و{n} يُملآن بعد الترجمة */
export const REP_DELETE_VAN = {
  history: 'سجل تحميل سيارته وتنزيلها يبقى بعد الحذف فلا يتغير رصيد المستودع',
  left: 'في سيارته الآن {qty} وحدة من {n} صنف وتبقى محسوبة خارج المستودع بعد حذفه',
  leftSmallest: 'في سيارته الآن {qty} بالوحدات الصغرى من {n} صنف وتبقى محسوبة خارج المستودع بعد حذفه',
  unloadFirst: 'إن كانت البضاعة قد عادت فعلا فسجل تنزيلها للمستودع من مخزون السيارة قبل الحذف',
  empty: 'لا بضاعة في سيارته الآن',
  checking: 'جار فحص مخزون سيارته',
} as const;

/** يملأ {qty} و{n} في النصّ المترجَم — بعد tr لا قبله، فالمفتاح ثابت والرقم متغيّر */
export function fillVanLeft(text: string, left: VanLeft, fmt: (n: number) => string = String): string {
  return text.split('{qty}').join(fmt(left.qty)).split('{n}').join(fmt(left.products));
}
