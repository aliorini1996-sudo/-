/**
 * القرارات الرقمية في إشعار الوارد والتسوية — دوالّ نقيّة تُختبَر وحدها.
 *
 * الإشعار **ورقةٌ تُوقَّع**: أمين المستودع يوقّع أنّه استلم، والمورّد أنّه
 * سلّم. فكلّ رقمٍ فيها يجب أن يطابق السجلّ حرفاً، وثلاثة أخطاء تُغري هنا:
 *
 *  · **جمع التسوية رقماً صافياً.** تسويةٌ بـ«+١٠ بيض XL» و«−١٠ بيض L» صافيها
 *    صفر، فتقول الورقة «إجمالي الكميات: ٠» عن حركةٍ نقلت عشرين كرتوناً. فالزيادة
 *    والنقص يُطبعان منفصلين دائماً.
 *  · **حساب قيمة السطر في المتصفّح.** الخادم يجمع الإجمالي من أسطرٍ مقرَّبة
 *    (`entryTotalCost`) ليطابق مجموعُ الأسطر المعروضة الإجماليَّ فلساً بفلس،
 *    وحسابٌ ثانٍ هنا ينزاح عنه يوماً. فقيمة السطر تأتي من الخادم (`lineCost`)
 *    ولا تُحسب هنا.
 *  · **سطرٌ بلا سعر يُطبع صفراً.** الصفر ادّعاءٌ بأنّ البضاعة مجّانية؛ والحقيقة
 *    أنّ سعرها غير معروف فهي **خارج** القيمة المطبوعة. فتُطبع «—» ويُقال ذلك.
 *  · **جمع كرتونٍ وحبّةٍ رقماً واحداً** (الوحدات المتعددة). «+٢ كرتون +٥ حبة = ٧»
 *    رقمٌ لا وحدة له؛ فحين تختلط الوحدات يُطبع الإجمالي لكل وحدة (`qtyByUnit`).
 */
import { factorOf } from '../lib/units';

export interface NoticeLine {
  qty: number;
  unitCost?: number | null;
  lineCost?: number | null;
  /** اسم وحدة السطر كما يُطبع — لقطته، وإلا وحدة الصنف */
  unit?: string;
  /** معامل وحدة السطر (الوحدات المتعددة) — null/١ = وحدة الأساس كما قبل الميزة */
  unitFactor?: number | null;
}

/**
 * إجمالي كمّياتٍ **تختلط وحداتها**: مجموعٌ لكل وحدة («٢ كرتون · ٥ حبة») — لا «٧» على ورقةٍ تُوقَّع، فرقمٌ واحد
 * يجمع كراتين وحبّات يكذب بلا علامة. و`null` حين الأسطر كلّها بوحدة الأساس: يبقى الإجمالي الرقميّ كما كان حرفاً.
 * `pick` يختار ما يُجمع من كمية السطر (المطلق للتحميل، والموجب وحده لزيادة التسوية…).
 */
export function qtyByUnit(lines: NoticeLine[], pick: (q: number) => number = (q) => q): { unit: string; qty: number }[] | null {
  if (!lines.some((l) => factorOf(l) !== 1)) return null;
  const m = new Map<string, number>();
  for (const l of lines) {
    const q = pick(Number(l.qty));
    if (!Number.isFinite(q) || q === 0) continue;
    const u = (l.unit || '').trim();
    m.set(u, (m.get(u) ?? 0) + q);
  }
  return [...m].map(([unit, qty]) => ({ unit, qty: Number(qty.toFixed(4)) }));
}

/** نصّ الإجمالي لكل وحدة بمنسّق الورقة — «٠» حين لا كميات */
export function unitTotalsText(rows: { unit: string; qty: number }[], fmt: (n: number) => string): string {
  return rows.length ? rows.map((r) => `${fmt(r.qty)} ${r.unit}`.trim()).join(' · ') : fmt(0);
}

/** مرجعٌ قصير للحركة — الحركات لا رقم متسلسل لها، والمعرّف الطويل لا يُقرأ على ورقة */
export function noticeRef(id: string): string {
  return (id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

/**
 * الزيادة والنقص في التسوية — **منفصلين**، لا صافياً واحداً.
 * القيم مطلقة للعرض، والإشارة في اسم الخانة.
 */
export function adjustTotals(lines: NoticeLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    const q = Number(l.qty);
    if (!Number.isFinite(q)) continue;
    if (q > 0) added += q;
    else if (q < 0) removed += -q;
  }
  const r = (n: number) => Number(n.toFixed(4));
  return { added: r(added), removed: r(removed) };
}

/** إجمالي كمّيات الوارد — الوارد موجبٌ دائماً (الخادم يرفض السالب) */
export function receiveTotalQty(lines: NoticeLine[]): number {
  return Number(lines.reduce((s, l) => s + (Number.isFinite(Number(l.qty)) ? Number(l.qty) : 0), 0).toFixed(4));
}

/** هل السطر مسعَّر؟ الصفر والسالب والغياب كلّها «بلا سعر» — كقاعدة الخادم `hasAnyCost` */
export function isCosted(l: NoticeLine): boolean {
  return l.unitCost != null && Number.isFinite(Number(l.unitCost)) && Number(l.unitCost) > 0;
}

/** كم سطراً خارج القيمة لأنّ سعره غير معروف */
export function uncostedCount(lines: NoticeLine[]): number {
  return lines.filter(l => !isCosted(l)).length;
}
