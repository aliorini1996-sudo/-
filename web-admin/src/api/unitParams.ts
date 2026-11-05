/**
 * استعلام حذف وحدة الصنف (`DELETE /products/:id/units/:unitId`) — الحذف بلا جسم، فخياراه في الاستعلام:
 *  • `clearPrimary=1`: حذف الوحدة الرئيسية بعد تأكيده (وإلا 409 PRIMARY_UNIT_IN_USE).
 *  • `expectedBaseName`: الأساس كما رآه النموذج — نموذجٌ فُتح قبل «إضافة وحدة فرعية أصغر» يُردّ 409 BASE_UNIT_CHANGED
 *    كبقية كتابات الوحدات (§4.2)، لا يحذف على أساسٍ قديم.
 * بلا خيار ⇒ undefined، فالطلب كما كان حرفاً.
 */
export function removeUnitParams(opts?: { clearPrimary?: boolean; expectedBaseName?: string | null; acknowledgePriceRules?: boolean }): Record<string, string | number> | undefined {
  const out: Record<string, string | number> = {};
  if (opts?.clearPrimary) out.clearPrimary = 1;
  // إقرار 409 PRICE_RULES_UNIT_ACK (قوائم الأسعار بالوحدة الرئيسية)
  if (opts?.acknowledgePriceRules) out.acknowledgePriceRules = 1;
  if (typeof opts?.expectedBaseName === 'string' && opts.expectedBaseName !== '') out.expectedBaseName = opts.expectedBaseName;
  return Object.keys(out).length ? out : undefined;
}
