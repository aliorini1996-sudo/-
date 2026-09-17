/**
 * البند 22 (مراجعة الاستيراد 2026-09-17): فلتر فترة كشف حساب العميل (GET /customers/:id/statement).
 *
 * الحركات المستوردة تُخزَّن بأول لحظة من اليوم المحلي بتوقيت الشركة (2026-01-01 في الرياض = 2025-12-31T21:00Z).
 * فلتر `new Date('2026-01-01')` (منتصف ليل UTC) كان يُسقطها من يناير ويُدخلها في المرحَّل، و`setHours` على خادم UTC
 * يُدخلها في كشف ديسمبر. الحدود هنا بأيام الشركة: [بداية يوم «من»، بداية اليوم التالي لـ«إلى»).
 *
 * البند 22 (البقيّة): الحدود تُبنى بـ`importedEntryInstant` — الدالّة نفسها التي يُخزَّن بها تاريخ القيد المستورد.
 * فالشركة بلا إعدادات دفاتر (tz = null) تُقرأ حدودها بمنتصف ليل UTC كما تُكتب بالضبط، بلا افتراض Asia/Riyadh
 * في طرف دون طرف، وبلا `setHours` التي تتبع منطقة الخادم لا منطقة الشركة.
 *
 * دالة صرفة: طرف معطى بغير صيغة YYYY-MM-DD ⇒ السلوك القديم حرفياً (توافق مع العملاء القدامى).
 */
import { addDays, isLocalDate } from './gl/dates';
import { importedEntryInstant } from './importTimezoneRebase';

export interface StatementEntryDateFilter {
  entryDate?: { gte?: Date; lt?: Date; lte?: Date };
  /** حد الرصيد المرحّل: entryDate < openingBefore (فقط حين «من» معطى) */
  openingBefore?: Date;
  /** true ⇒ الحدود بتوقيت الشركة */
  zoned: boolean;
}

const given = (v: string | undefined): v is string => typeof v === 'string' && v.length > 0;

export function statementEntryDateFilter(from: string | undefined, to: string | undefined, tz: string | null): StatementEntryDateFilter {
  if (!given(from) && !given(to)) return { zoned: false };
  // tz === null ⇒ الشركة لم تضبط توقيتاً (لا إعدادات دفاتر ولا مسودة): الحدود بمنتصف ليل UTC — لا تُزاح كشوف
  // شركة مصرية أو تركية إلى +3 بافتراض الرياض، وهي عين اللحظة التي يكتب بها الاستيراد تاريخها (البند 22).
  if ((!given(from) || isLocalDate(from)) && (!given(to) || isLocalDate(to))) {
    const start = given(from) ? importedEntryInstant(from, tz) : undefined;
    return {
      entryDate: {
        ...(start ? { gte: start } : {}),
        ...(given(to) ? { lt: importedEntryInstant(addDays(to, 1), tz) } : {}),
      },
      ...(start ? { openingBefore: start } : {}),
      zoned: tz !== null,
    };
  }
  return {
    entryDate: {
      ...(given(from) ? { gte: new Date(from) } : {}),
      ...(given(to) ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
    },
    ...(given(from) ? { openingBefore: new Date(from) } : {}),
    zoned: false,
  };
}
