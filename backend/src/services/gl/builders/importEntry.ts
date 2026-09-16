// M1 — وصفة صفوف AccountEntry بلا مستند (DESIGN.md §5.5 P11 وP12، §5.2، §5.3).
// الرصيد أو الأستاذ المستورد (ADJUSTMENT_*) إلى دفتر OPEN (moveType=IMPORT):
//   مدين 113001 = المدين (العميل) / دائن 319002        أو        مدين 319002 / دائن 113001 = الدائن (العميل)
// عدة أحداث متتالية للدفعة نفسها تُجمَّع في قيد واحد بسطر لكل عميل، و GlMoveSource لكل مفتاح.
// دوال صرفة: لا prisma ولا I/O.
import { compareLocalDate, isLocalDate, localDate } from '../dates';
import { toMilli } from '../money';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type LineDraft, type LocalDate, type Milli, type MoveDraft,
  type SourceEvent,
} from '../types';

/** مفتاح حدث صف بلا مستند (§5.2). النسخة المرجعية تصل في M3 إلى sync/keys.ts → arEntryKey */
export const arEntryEventKey = (entryId: string, event: 'POST' | 'REVERSE' = 'POST'): string =>
  `AR_ENTRY:${entryId}:${event}`;

type Amount = string | number;

/** حمولة حدث AR_ENTRY (§5.2): {customerId, debit, credit, description, entryDate, createdAt} + معرّف الصف */
export interface ImportEntryPayload {
  /** AccountEntry.id */
  entryId: string;
  customerId: string;
  /** لقطة اسم العميل لـpartnerName (G6 (ز))؛ إن غابت يُكتب بديل يحمل المعرّف */
  customerName?: string | null;
  debit: Amount;
  credit: Amount;
  description?: string | null;
  entryDate: Date | string;
  createdAt?: Date | string | null;
}

export interface ImportEntriesOptions {
  /**
   * POST (الافتراضي) = P11. REVERSE = عكس من الحمولة بقلب الجانبين، لا يُستعمل إلا حين يكون شقيق
   * POST مشمولاً بالافتتاح SKIPPED(OPENING) (§5.4)؛ وإلا فالعكس من القيد الحيّ في reverse.ts.
   */
  event?: Extract<SourceEvent, 'POST' | 'REVERSE'>;
  /** تاريخ القيد: إلزامي للعكس (effectAt للعكس)، وللترحيل يُشتق من entryDate المحلي */
  date?: LocalDate;
}

/** التاريخ المحلي لصف مستورد بتوقيت الشركة */
export function importEntryLocalDate(entry: Pick<ImportEntryPayload, 'entryDate'>, timeZone: string): LocalDate {
  return localDate(entry.entryDate, timeZone);
}

/**
 * تجميع أحداث متتالية في مجموعات تُبنى كل منها قيداً واحداً: مجموعة لكل تاريخ محلي، بترتيب أول ظهور.
 * (القيد يحمل تاريخاً واحداً، واستيراد /ledger يحمل تاريخاً لكل صف.)
 */
export function groupImportEntries<T extends Pick<ImportEntryPayload, 'entryDate'>>(
  entries: readonly T[],
  timeZone: string,
): { date: LocalDate; entries: T[] }[] {
  const groups = new Map<LocalDate, T[]>();
  for (const e of entries) {
    const d = importEntryLocalDate(e, timeZone);
    const g = groups.get(d);
    if (g) g.push(e);
    else groups.set(d, [e]);
  }
  return [...groups].map(([date, list]) => ({ date, entries: list }));
}

/** مفاتيح GlMoveSource لكل صف في القيد المجمَّع */
export function importEntrySourceKeys(
  entries: readonly Pick<ImportEntryPayload, 'entryId'>[],
  event: 'POST' | 'REVERSE' = 'POST',
): string[] {
  return entries.map(e => arEntryEventKey(e.entryId, event));
}

interface CustomerNet {
  customerId: string;
  partnerName: string;
  named: boolean;
  descriptions: string[];
  netMilli: Milli;
}

/** P11 (وعكسه من الحمولة لـP12) — قيد واحد لصفوف مستوردة بتاريخ محلي واحد */
export function buildImportEntriesMove(
  entries: readonly ImportEntryPayload[],
  ctx: BuildContext,
  opts: ImportEntriesOptions = {},
): BuildResult {
  const { settings } = ctx;
  const dec = settings.currencyDecimals;
  const event = opts.event ?? 'POST';
  if (entries.length === 0) return noMove('ZERO_VALUE', 'لا صفوف مستوردة');

  const dates = new Set(entries.map(e => importEntryLocalDate(e, settings.timezone)));
  if (dates.size > 1) {
    throw new RangeError(`صفوف مستوردة بتواريخ محلية مختلفة (${[...dates].join('، ')}) — جمّعها بـgroupImportEntries`);
  }
  const entryDate = [...dates][0];
  if (opts.date !== undefined && !isLocalDate(opts.date)) throw new RangeError(`تاريخ غير صالح: ${String(opts.date)}`);
  if (event === 'REVERSE' && opts.date === undefined) {
    throw new RangeError('عكس الصفوف المستوردة من الحمولة يتطلب تاريخ العكس');
  }
  const date = opts.date ?? entryDate;
  if (event === 'REVERSE' && compareLocalDate(date, entryDate) < 0) {
    throw new RangeError(`تاريخ العكس ${date} يسبق تاريخ الأصل ${entryDate}`);
  }

  // صافي كل عميل (مدين − دائن) بترتيب أول ظهور
  const byCustomer = new Map<string, CustomerNet>();
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.entryId)) throw new RangeError(`صف مستورد مكرر: ${e.entryId}`);
    ids.add(e.entryId);
    // استيراد /ledger لا يمنع القيم السالبة (z.number)، فالصافي مدين − دائن وحده يحفظ تطابق C3
    const debit = toMilli(e.debit, dec);
    const credit = toMilli(e.credit, dec);
    let c = byCustomer.get(e.customerId);
    if (!c) {
      const name = e.customerName?.trim();
      c = { customerId: e.customerId, partnerName: name || `عميل ${e.customerId}`, named: !!name, descriptions: [], netMilli: 0n };
      byCustomer.set(e.customerId, c);
    } else if (!c.named && e.customerName?.trim()) {
      c.partnerName = e.customerName.trim();
      c.named = true;
    }
    const desc = e.description?.trim();
    if (desc && !c.descriptions.includes(desc)) c.descriptions.push(desc);
    c.netMilli += debit - credit;
  }

  const sign = event === 'REVERSE' ? -1n : 1n;
  const lines: LineDraft[] = [];
  let arNet = 0n;
  for (const c of byCustomer.values()) {
    const net = c.netMilli * sign;
    if (net === 0n) continue;
    arNet += net;
    const what = c.descriptions.length === 1 ? c.descriptions[0] : 'رصيد مستورد';
    lines.push({
      accountKey: 'AR_CONTROL',
      label: event === 'REVERSE' ? `عكس ${what} — ${c.partnerName}` : `${what} — ${c.partnerName}`,
      debitMilli: net > 0n ? net : 0n,
      creditMilli: net < 0n ? -net : 0n,
      customerId: c.customerId,
      partnerName: c.partnerName,
    });
  }
  if (lines.length === 0) return noMove('ZERO_VALUE', 'صافي الصفوف المستوردة صفر');

  if (arNet !== 0n) {
    lines.push({
      accountKey: 'OPENING_EQUITY',
      label: event === 'REVERSE' ? 'عكس مقابل أرصدة العملاء المستوردة' : 'مقابل أرصدة العملاء المستوردة',
      debitMilli: arNet < 0n ? -arNet : 0n,
      creditMilli: arNet > 0n ? arNet : 0n,
    });
  }

  const first = entries[0];
  const single = entries.length === 1;
  const customerCount = byCustomer.size;
  const narrationBase = customerCount === 1
    ? `رصيد مستورد للعميل ${[...byCustomer.values()][0].partnerName}`
    : `أرصدة مستوردة لعدد ${customerCount} عملاء`;
  const onlyCustomer = customerCount === 1 ? [...byCustomer.values()][0] : null;

  const draft: MoveDraft = {
    kind: 'MOVE',
    journalCode: ctx.journals.bySystemKey('OPENING')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.OPENING,
    journalSystemKey: 'OPENING',
    moveType: 'IMPORT',
    origin: 'AUTO',
    date,
    ref: single ? (first.description?.trim() || null) : null,
    narration: event === 'REVERSE' ? `تراجع عن استيراد: ${narrationBase}` : narrationBase,
    needsAttention: false,
    attentionReason: null,
    customerId: onlyCustomer?.customerId ?? null,
    sourceType: 'AR_ENTRY',
    sourceId: first.entryId,
    sourceKey: arEntryEventKey(first.entryId, event),
    sourceEvent: event,
    currencyCode: settings.currency,
    currencyDecimals: dec,
    lines,
  };
  return draft;
}

/** اختصار لصف واحد */
export function buildImportEntryMove(
  entry: ImportEntryPayload,
  ctx: BuildContext,
  opts: ImportEntriesOptions = {},
): BuildResult {
  return buildImportEntriesMove([entry], ctx, opts);
}
