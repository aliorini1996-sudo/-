/**
 * القرارات الرقمية في كشف الحساب المطبوع — دالّتان نقيّتان تُختبَران وحدهما.
 *
 * لماذا خرجتا من المكوّن: الكشف **ورقةٌ تُسلَّم للعميل ويُطالَب بما فيها**،
 * وقرارٌ خاطئ فيها لا يُرى على شاشةٍ حتى يُطبع. وكانتا مدفونتين في
 * `PrintableStatement` و`statementDocFromData` لا يبلغهما اختبار، فسقط فيهما
 * خللان لم يظهرا سنةً كاملة لأنّ كلّ المستدعين كانوا يطلبون الكشف **بلا مدّة**:
 *
 *  · مدّةٌ بطرفٍ واحد كانت تُطبع «كل الفترات»، فتقول ورقةُ شهرٍ إنّها تاريخ
 *    العميل كلّه.
 *  · ومدّةٌ بلا حركات كانت تطبع `customer.balance` — لقطةٌ لكلّ الزمن يحذّر
 *    الخادم نفسه من قراءتها — مطالَباً بها عن تلك المدّة وحدها.
 */

/** شكل المدّة المطلوبة: بطرفيها، أو بطرفٍ واحد، أو بلا حدّ */
export type PeriodShape = 'range' | 'from' | 'to' | 'all';

export function periodShape(from?: string, to?: string): PeriodShape {
  if (from && to) return 'range';
  if (from) return 'from';
  if (to) return 'to';
  return 'all';
}

/**
 * الرصيد الذي يُطبع في أسفل الكشف وفي مربّع «المستحق على العميل».
 *
 * الترتيب مقصود:
 *  ١) ما حسبه **الخادم** لهذه المدّة (`closingBalance`) — وهو الوحيد الذي
 *     يطابق ما رآه المستخدم على الشاشة.
 *  ٢) فإن لم يُمرَّر (المستدعون القدامى): رصيد آخر حركة — صحيحٌ ما دامت ثمّة
 *     حركات، لأنّ الأرصدة مشتقّة متسلسلة.
 *  ٣) فإن لم تكن حركات: اللقطة المخزَّنة — آخر ملاذ، وهي صحيحةٌ فقط حين يكون
 *     الكشف **بلا مدّة** أصلاً. ولهذا وجدت (١).
 */
export function statementFinalBalance(o: {
  closingBalance?: number;
  lastEntryBalance?: number;
  customerBalance?: number;
}): number {
  if (o.closingBalance !== undefined && o.closingBalance !== null) return Number(o.closingBalance);
  if (o.lastEntryBalance !== undefined && o.lastEntryBalance !== null) return Number(o.lastEntryBalance);
  return Number(o.customerBalance ?? 0);
}
