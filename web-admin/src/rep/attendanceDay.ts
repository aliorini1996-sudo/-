// بصمات يوم المندوب (الدوام المتقطّع) — منطقٌ صرف لشاشة البصمة يُختبر وحده.
// قرار المالك: كل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل. بعد الانصراف لا «انتهى يومك»: الحضور التالي فترةٌ جديدة،
// والمندوب يرى بصمات يومه كلها كما سيراها المشرف في التقرير (فترةٌ لكل حضور→انصراف، وما بينها استراحة).

export interface PunchShift { checkInAt: string; checkOutAt: string | null }

export type AttendanceState =
  | { status: 'in'; shift: { checkInAt: string; checkInLat: number | null; checkInLng: number | null }; already?: boolean; shifts?: PunchShift[] }
  | { status: 'out'; last: { checkInAt: string; checkOutAt: string } | null; shifts?: PunchShift[] }
  | { status: 'none'; last?: null; shifts?: PunchShift[] };

/**
 * بصمات اليوم مرتّبةً من الأقدم. خادمٌ أقدم (انزلاق النشر) لا يرسل `shifts` ⇒ ما تحمله الحالة نفسها
 * (النوبة المفتوحة أو آخر نوبةٍ مغلقة) — فلا تختفي البصمة الوحيدة المعروفة.
 */
export function shiftsOf(s: AttendanceState): PunchShift[] {
  if (Array.isArray(s.shifts)) return [...s.shifts].sort((a, b) => Date.parse(a.checkInAt) - Date.parse(b.checkInAt));
  if (s.status === 'in') return [{ checkInAt: s.shift.checkInAt, checkOutAt: null }];
  if (s.status === 'out' && s.last) return [{ checkInAt: s.last.checkInAt, checkOutAt: s.last.checkOutAt }];
  return [];
}

/** دقائق نوبةٍ مغلقة (المفتوحة ٠ حتى الانصراف — كما يحسبها التقرير) */
export function shiftMinutes(sh: PunchShift): number {
  if (!sh.checkOutAt) return 0;
  return Math.max(0, Math.round((Date.parse(sh.checkOutAt) - Date.parse(sh.checkInAt)) / 60000));
}

/** مجموع النوبات المغلقة */
export const closedMinutes = (list: readonly PunchShift[]): number => list.reduce((s, sh) => s + shiftMinutes(sh), 0);

/**
 * مجموع فترات **اليوم** كما سيظهر في التقرير: التقرير ينسب النوبة ليوم حضورها (workDay.ts)، والقائمة
 * تعرض أيضاً نوبةً بدأت أمس وانتهت اليوم (نسي الانصراف ليلاً) — فتُعرض بوسم «أمس» ولا تُضاف ساعاتها هنا،
 * وإلّا ظهر «مجموع اليوم» ٢٣ ساعة لمن انصرف صباحاً عن نوبة أمس.
 */
export const dayMinutes = (list: readonly PunchShift[], dayStart: Date): number =>
  closedMinutes(list.filter(sh => Date.parse(sh.checkInAt) >= dayStart.getTime()));

/**
 * الزرّ التالي: حاضرٌ ⇒ انصراف. غير حاضر ⇒ حضور، وبعد انصرافٍ اليوم يُسمّى «بدء فترة عمل جديدة»
 * (لا «انتهى عملك»): المندوب الذي خرج ظهراً يعود مساءً ويبصم فترةً ثانية.
 */
export function nextPunch(s: AttendanceState): 'checkout' | 'checkin' | 'checkin-again' {
  if (s.status === 'in') return 'checkout';
  return s.status === 'out' || shiftsOf(s).some(sh => sh.checkOutAt) ? 'checkin-again' : 'checkin';
}
