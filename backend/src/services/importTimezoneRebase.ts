/**
 * البند 25 (مراجعة الاستيراد 2026-09-17): تغيير المنطقة الزمنية في معالج الدفاتر بعد استيراد أرصدة أو كشوف.
 *
 * الاستيراد يخزّن التاريخ المحلي بأول لحظة من يومه بالمنطقة الفعلية وقتها (importTimezone). تغيير المنطقة بعدها
 * يزيح كل تاريخ مستورد يوماً (2026-01-01 في الرياض = 2025-12-31T21:00Z = 2025-12-31 في القاهرة)، فتدخل حركات يوم
 * البدء في الافتتاح وتنتقل حركات أول الشهر إلى الشهر السابق. لذا يُرفض التغيير (409) ما لم يؤكّد المستخدم إعادة
 * ضبط التواريخ: كل قيد محاذٍ لبداية يوم بالمنطقة السابقة يُنقل إلى بداية اليوم نفسه بالمنطقة الجديدة.
 *
 * دوال صرفة؛ الكتابة في routes/ledger/setup.ts.
 */
import { isLocalDate, localDate, zonedStartOfDay } from './gl/dates';

/**
 * البند 22 (البقيّة): **مصدر واحد للحقيقة** للحظة التي يُخزَّن بها تاريخ مستورد — الكاتب والقارئ بالدالّة نفسها.
 * - منطقة مضبوطة صراحةً للشركة ⇒ أول لحظة من اليوم بها (كما كان).
 * - `null` (لا إعدادات دفاتر ولا مسودة؛ والدفاتر اختيارية ومطفأة للجميع) ⇒ منتصف ليل UTC، وهو عين ما يقرؤه
 *   فلتر كشف الحساب لتلك الشركة. بلا هذا كان الكاتب يفترض Asia/Riyadh والقارئ UTC، فينزاح اليوم بينهما.
 */
export function importedEntryInstant(ymd: string, tz: string | null): Date {
  if (!isLocalDate(ymd)) throw new RangeError(`تاريخ محلي غير صالح: "${ymd}" (المتوقع YYYY-MM-DD)`);
  return tz ? zonedStartOfDay(ymd, tz) : new Date(`${ymd}T00:00:00.000Z`);
}

export const LEDGER_TIMEZONE_IMPORTS_CONFLICT_CODE = 'LEDGER_TIMEZONE_IMPORTS_CONFLICT';
export const LEDGER_TIMEZONE_IMPORTS_CONFLICT_MESSAGE =
  'للشركة أرصدة أو كشوف مستوردة بالمنطقة الزمنية السابقة، وتغييرها يزيح تواريخها يوماً. تراجع عن الدفعات أو أكّد إعادة ضبط تواريخها على المنطقة الجديدة';

/** لحظة مستوردة بالمنطقة السابقة ⇒ اللحظة نفسها لليوم المحلي بالمنطقة الجديدة؛ غير محاذية لبداية يوم ⇒ null (لا تُمس) */
export function rebaseImportedEntryDate(entryDate: Date, fromTz: string, toTz: string): Date | null {
  const t = entryDate.getTime();
  if (!Number.isFinite(t)) return null;
  const ymd = localDate(entryDate, fromTz);
  if (zonedStartOfDay(ymd, fromTz).getTime() !== t) return null;
  return zonedStartOfDay(ymd, toTz);
}

export interface ImportTimezoneBatch { id: string; kind: string; count: number; createdAt: Date | string }

export interface ImportTimezoneConflictDetails {
  reason: 'IMPORT_TIMEZONE_CONFLICT';
  previousTimezone: string;
  timezone: string;
  field: 'rebaseImportDates';
  /** البند D: عدد القيود التي ستُزاح فعلاً — أكبر من صفر دائماً، فلا تعارض باسم المنطقة وحده */
  shiftedEntries: number;
  batches: { id: string; kind: string; count: number; createdAt: string }[];
}

/**
 * تعارض حقيقي ⇒ تفاصيل 409؛ وإلا null. شرطه الثلاثي:
 * تغيّر اسم المنطقة، ودفعات balances/ledger غير متراجع عنها (count > 0)، و**إزاحة فعلية** على تواريخ قيودها.
 *
 * البند D: القياس بالإزاحة لا بالاسم — Asia/Riyadh ⇄ Asia/Aden إزاحتهما واحدة (+03) فـ`planImportDateRebase`
 * تتخطّى كل قيد، وكان الاسم وحده يُشعل 409 (أو LEDGER_IMPORT_IN_PROGRESS في حفظ المسودة) بلا سبب.
 */
export function importTimezoneConflict(i: {
  previousTimezone: string; timezone: string; batches: readonly ImportTimezoneBatch[]; shiftedEntries: number;
}): ImportTimezoneConflictDetails | null {
  if (i.previousTimezone === i.timezone) return null;
  if (!(i.shiftedEntries > 0)) return null;
  const batches = i.batches.filter((b) => (b.kind === 'balances' || b.kind === 'ledger') && b.count > 0);
  if (!batches.length) return null;
  return {
    reason: 'IMPORT_TIMEZONE_CONFLICT',
    previousTimezone: i.previousTimezone,
    timezone: i.timezone,
    field: 'rebaseImportDates',
    shiftedEntries: i.shiftedEntries,
    batches: batches.map((b) => ({
      id: b.id, kind: b.kind, count: b.count,
      createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
    })),
  };
}

/** تجميع القيود حسب (القديمة ⇒ الجديدة) لتحديث جماعي؛ غير المحاذي يُتخطى */
export function planImportDateRebase(
  entries: readonly { id: string; entryDate: Date }[], fromTz: string, toTz: string,
): { from: Date; to: Date; ids: string[] }[] {
  const groups = new Map<number, { from: Date; to: Date; ids: string[] }>();
  for (const e of entries) {
    const next = rebaseImportedEntryDate(e.entryDate, fromTz, toTz);
    if (!next || next.getTime() === e.entryDate.getTime()) continue;
    const key = e.entryDate.getTime();
    let g = groups.get(key);
    if (!g) { g = { from: new Date(key), to: next, ids: [] }; groups.set(key, g); }
    g.ids.push(e.id);
  }
  return [...groups.values()];
}

/** البند D: عدد القيود المُزاحة فعلاً في خطّة (صفر ⇒ لا تعارض ولا قفل ولا كتابة) */
export function plannedRebaseCount(plan: readonly { ids: readonly string[] }[]): number {
  return plan.reduce((n, g) => n + g.ids.length, 0);
}
