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
  /**
   * مراجعة المخزون #7 (D9): ما لا يُباع في السيارة — «المرتجع التالف» و«منتهي الصلاحية» الموجبان — وعدد أصنافه. كان التحذير يقول
   * «لا بضاعة في سيارته» وفيها تالف. المفتاحان لا يحضران إلا بقيمة: بلاهما الشكل كما كان
   */
  unsellable?: number;
  unsellableProducts?: number;
}

/**
 * يقرأ صفوف `/van-stock/current`. الموجب وحده بضاعةٌ في السيارة؛ السالب بيعٌ
 * بلا مخزون (canSellWithoutStock) لا بضاعة تعود، فلا يُطرح من الموجب ولا يُعدّ.
 * والتالف والمنتهي الموجبان يُعدّان وحدهما (لا يدخلان «ما بقي»: لا يُباعان ولا يُنزَّلان بضاعةً صالحة).
 * شكلٌ غير متوقَّع يعود صفراً: التحذير لا يُسقط حوار الحذف.
 */
export function vanLeftover(rows: unknown): VanLeft {
  if (!Array.isArray(rows)) return { products: 0, qty: 0 };
  let products = 0;
  let qty = 0;
  let anyPrimary = false;
  let unsellable = 0;
  let unsellableProducts = 0;
  for (const r of rows) {
    const row = r as { remaining?: unknown; primaryUnitId?: unknown; damaged?: unknown; expired?: unknown } | null;
    const bad = Math.max(0, Number(row?.damaged) || 0) + Math.max(0, Number(row?.expired) || 0);
    if (bad > 1e-9) { unsellable += bad; unsellableProducts += 1; }
    const n = Number(row?.remaining);
    if (!Number.isFinite(n) || n <= 1e-9) continue;
    products += 1;
    qty += n;
    if (row?.primaryUnitId) anyPrimary = true;
  }
  // أربع خانات كالخادم: غبار الجمع (0.1+0.2) لا يظهر رقماً طويلاً في التحذير
  return {
    products, qty: Math.round(qty * 1e4) / 1e4, ...(anyPrimary && { anyPrimary: true as const }),
    ...(unsellableProducts > 0 && { unsellable: Math.round(unsellable * 1e4) / 1e4, unsellableProducts }),
  };
}

/** عهدة أدوات السيارة قبل الحذف (D9): مجموع الأدوات وأسماؤها بعددها — من GET /van-stock/tools */
export interface ToolsLeft { total: number; names: string[] }

/** يقرأ `balances` من ردّ /van-stock/tools — الموجب وحده عهدة؛ شكلٌ غير متوقَّع ⇒ لا عهدة (التحذير لا يُسقط الحوار) */
export function toolsLeftover(data: unknown): ToolsLeft {
  const balances = (data as { balances?: unknown } | null | undefined)?.balances;
  if (!Array.isArray(balances)) return { total: 0, names: [] };
  let total = 0;
  const names: string[] = [];
  for (const b of balances) {
    const row = b as { toolName?: unknown; qty?: unknown } | null;
    const q = Number(row?.qty);
    if (!Number.isFinite(q) || q <= 0 || typeof row?.toolName !== 'string' || !row.toolName.trim()) continue;
    total += q;
    names.push(q > 1 ? `${row.toolName.trim()} ×${q}` : row.toolName.trim());
  }
  return { total, names };
}

/** «لا بضاعة في سيارته» صادقةً: لا متاح ولا تالف/منتهٍ ولا أدوات */
export const vanIsEmpty = (left: VanLeft, tools: ToolsLeft | null | undefined): boolean =>
  left.products === 0 && !(left.unsellableProducts ?? 0) && !(tools?.total ?? 0);

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
  // D9: ما لا يُباع وعهدة الأدوات — {qty} و{n} يُملآن بـfillVanUnsellable و{names} بـfillTools
  unsellable: 'وفي سيارته {qty} تالف أو منتهي الصلاحية من {n} صنف لا يباع وتبقى محسوبة عليها بعد حذفه',
  tools: 'في عهدة سيارته {qty} من الأدوات {names} — سجل استلامها من مخزون السيارة قبل الحذف وإلا بقيت باسم مندوب محذوف',
} as const;

/** يملأ {qty} و{n} في النصّ المترجَم — بعد tr لا قبله، فالمفتاح ثابت والرقم متغيّر */
export function fillVanLeft(text: string, left: VanLeft, fmt: (n: number) => string = String): string {
  return text.split('{qty}').join(fmt(left.qty)).split('{n}').join(fmt(left.products));
}

/** يملأ نصّ التالف والمنتهي بمجموعه وعدد أصنافه */
export function fillVanUnsellable(text: string, left: VanLeft, fmt: (n: number) => string = String): string {
  return text.split('{qty}').join(fmt(left.unsellable ?? 0)).split('{n}').join(fmt(left.unsellableProducts ?? 0));
}

/** يملأ نصّ عهدة الأدوات بمجموعها وأسمائها */
export function fillTools(text: string, tools: ToolsLeft, fmt: (n: number) => string = String): string {
  return text.split('{qty}').join(fmt(tools.total)).split('{names}').join(tools.names.join('، '));
}
