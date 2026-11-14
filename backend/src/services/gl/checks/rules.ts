/**
 * قواعد الفحوصات (M3، DESIGN.md §5.9) — دوال صرفة فوق حقائق مقروءة مسبقاً (لا prisma ولا I/O).
 *
 * «مزامنة جارية» (pending): انحراف في C3/C4/C5 لشريك له أحداث غير نهائية (PENDING/BLOCKED/ERROR/HELD) أو صفوف مصدر
 * أحدث من آخر نبضة يُعرض **أصفر** لا أحمر، لأن الأستاذ لم يلحق بالمصدر بعد (زمن الترحيل دقيقة، §5.1)؛ الأحداث
 * المتعثرة نفسها يحمّرها C8. ولا يُنشأ قيد تصحيح لصف أصفر.
 */
import {
  custodyC4Gap, custodyC4bGap, type CustodyComponents,
} from '../custody';
import { toMilli } from '../money';
import { checkSequenceGaps, parseMoveNumber } from '../sequence';
import type { UserCustodyFold } from '../../userCustodyCore';
import type { BackfillState, LocalDate, Milli } from '../types';
import {
  CHECK_TITLES, limitRows, milliText, worstStatus,
  type CheckFix, type CheckKey, type CheckResult, type CheckRow, type CheckStatus,
} from './types';

export const C8_BLOCKED_YELLOW_MS = 60 * 60_000;
export const C8_RED_MS = 24 * 60 * 60_000;
export const C15_LAG_RED_MS = 15 * 60_000;

function result(
  key: CheckKey, status: CheckStatus, summary: string, rows: CheckRow[], fix: CheckFix | null,
  metrics: CheckResult['metrics'] = {},
): CheckResult {
  return { key, status, title: CHECK_TITLES[key], summary, metrics, rows: limitRows(rows), rowCount: rows.length, fix: status === 'GREEN' ? null : fix };
}

const abs = (m: Milli): Milli => (m < 0n ? -m : m);

// ═══ C1: توازن القيود ═══

export interface UnbalancedMove { moveId: string; number: string | null; debitMilli: Milli; creditMilli: Milli }

export function evaluateC1(moves: readonly UnbalancedMove[]): CheckResult {
  const rows = moves.filter((m) => m.debitMilli !== m.creditMilli).map((m) => ({
    moveId: m.moveId, number: m.number, debitMilli: milliText(m.debitMilli), creditMilli: milliText(m.creditMilli),
    gapMilli: milliText(m.debitMilli - m.creditMilli),
  }));
  return rows.length === 0
    ? result('C1', 'GREEN', 'كل القيود المرحّلة متوازنة', [], null)
    : result('C1', 'RED', `${rows.length} قيد مرحّل غير متوازن`, rows, null);
}

// ═══ C2: الأرصدة الشهرية ═══

export interface PeriodTotal { accountId: string; accountCode?: string | null; periodKey: string; debitMilli: Milli; creditMilli: Milli }

export function evaluateC2(ledger: readonly PeriodTotal[], stored: readonly PeriodTotal[]): CheckResult {
  const key = (t: PeriodTotal) => `${t.accountId}|${t.periodKey}`;
  const map = new Map<string, { accountId: string; accountCode: string | null; periodKey: string; ld: Milli; lc: Milli; sd: Milli; sc: Milli }>();
  const at = (t: PeriodTotal) => {
    const k = key(t);
    let e = map.get(k);
    if (!e) {
      e = { accountId: t.accountId, accountCode: t.accountCode ?? null, periodKey: t.periodKey, ld: 0n, lc: 0n, sd: 0n, sc: 0n };
      map.set(k, e);
    }
    if (!e.accountCode && t.accountCode) e.accountCode = t.accountCode;
    return e;
  };
  for (const t of ledger) { const e = at(t); e.ld += t.debitMilli; e.lc += t.creditMilli; }
  for (const t of stored) { const e = at(t); e.sd += t.debitMilli; e.sc += t.creditMilli; }
  const rows = [...map.values()]
    .filter((e) => e.ld !== e.sd || e.lc !== e.sc)
    .sort((a, b) => (a.periodKey < b.periodKey ? -1 : a.periodKey > b.periodKey ? 1 : (a.accountCode ?? '') < (b.accountCode ?? '') ? -1 : 1))
    .map((e) => ({
      accountId: e.accountId, accountCode: e.accountCode, periodKey: e.periodKey,
      ledgerDebitMilli: milliText(e.ld), ledgerCreditMilli: milliText(e.lc),
      storedDebitMilli: milliText(e.sd), storedCreditMilli: milliText(e.sc),
    }));
  return rows.length === 0
    ? result('C2', 'GREEN', 'الأرصدة الشهرية تطابق البنود المرحّلة', [], null)
    : result('C2', 'RED', `${rows.length} رصيد شهري لا يطابق البنود`, rows, 'REBUILD_BALANCES');
}

// ═══ C3: ذمم العملاء ═══

export interface C3Input {
  /** Σ(مدين − دائن) لسطور حسابات AR المرحّلة لكل عميل (ومنها قيد الافتتاح) */
  ledger: ReadonlyMap<string, Milli>;
  /** Σ سطور AR في قيود OPENING لكل عميل */
  opening: ReadonlyMap<string, Milli>;
  /** Σ(مدين − دائن) لصفوف AccountEntry غير المشمولة بالافتتاح */
  entriesAfterCutover: ReadonlyMap<string, Milli>;
  /** صفوف استيراد مشمولة بالافتتاح ثم تُراجع عنها (حدث AR_ENTRY:REVERSE وشقيقه SKIPPED(OPENING)) */
  deletedOpeningImports: ReadonlyMap<string, Milli>;
  /**
   * Σ(مدين − دائن) لصفوف AccountEntry **الحالية** المشمولة بالافتتاح (بقاعدة computeDerivedOpening) لكل عميل — لتعمّق
   * «صف افتتاحي حُذف بلا حدث» (استيراد البند 6 (ج)). غيابه ⇒ لا تعمّق (مخازن قديمة، أو الطريقة (ب) بلا قيد افتتاحي).
   */
  openingEntries?: ReadonlyMap<string, Milli> | null;
  names: ReadonlyMap<string, string>;
  pendingCustomers: ReadonlySet<string>;
  /** لا نبضة بعد، أو أحداث بلا عميل معروف ⇒ كل انحراف أصفر */
  pendingAll: boolean;
}

export interface PartnerGap {
  partnerId: string;
  name: string | null;
  ledgerMilli: Milli;
  expectedMilli: Milli;
  gapMilli: Milli;
  pending: boolean;
}

export function c3Gaps(input: C3Input): PartnerGap[] {
  const ids = new Set<string>([
    ...input.ledger.keys(), ...input.opening.keys(), ...input.entriesAfterCutover.keys(), ...input.deletedOpeningImports.keys(),
  ]);
  const out: PartnerGap[] = [];
  for (const id of ids) {
    const ledgerMilli = input.ledger.get(id) ?? 0n;
    const expectedMilli = (input.opening.get(id) ?? 0n) + (input.entriesAfterCutover.get(id) ?? 0n) - (input.deletedOpeningImports.get(id) ?? 0n);
    const gapMilli = ledgerMilli - expectedMilli;
    if (gapMilli === 0n) continue;
    out.push({ partnerId: id, name: input.names.get(id) ?? null, ledgerMilli, expectedMilli, gapMilli, pending: input.pendingAll || input.pendingCustomers.has(id) });
  }
  return out.sort((a, b) => (abs(b.gapMilli) > abs(a.gapMilli) ? 1 : abs(b.gapMilli) < abs(a.gapMilli) ? -1 : a.partnerId < b.partnerId ? -1 : 1));
}

/**
 * تعمّق C3 (استيراد البند 6 (ج)): سطور AR في قيد OPEN لكل عميل مقابل Σ صفوفه الحالية المشمولة بالافتتاح + ما حُذف منها
 * بحدث (deletedOpeningImports). الفرق = صف افتتاحي حُذف بلا tombstone (تراجع سابَق اعتماد التفعيل) فبقي في الافتتاح
 * ولا صف له ولا حدث عكس — وهو ما لا يراه c3Gaps لأن «المتوقَّع» فيه يبدأ من قيد الافتتاح نفسه.
 */
export interface OpeningEntryGap {
  customerId: string;
  name: string | null;
  openingMilli: Milli;
  openingEntriesMilli: Milli;
  deletedWithEventMilli: Milli;
  gapMilli: Milli;
  pending: boolean;
}

export const OPENING_DELETED_WITHOUT_EVENT = 'OPENING_DELETED_WITHOUT_EVENT';

/** مجموعة صفوف AccountEntry المشمولة بنافذة الافتتاح لعميل ومستند ونوع (مجاميع لا صفوف) */
export interface OpeningEntryGroup {
  customerId: string;
  invoiceId: string | null;
  receiptId: string | null;
  type: string;
  invoiceType: string | null;
  debit: number;
  credit: number;
  /**
   * مجموع الصفوف بعد تقريب كل صف وحده (toMilli لكل صف ثم الجمع) — مرآة computeDerivedOpening. حين يوجد
   * يُعتمد بدل debit/credit، فكشف بثلاث منازل (1.005 + 2.005 + 3.125) لا يعطي تعمّقاً ≠ القيد الافتتاحي.
   */
  debitMilli?: Milli;
  creditMilli?: Milli;
}

/** صف AccountEntry واحد في نافذة الافتتاح (قراءة المخزن صفاً صفاً) */
export type OpeningEntryRow = Omit<OpeningEntryGroup, 'debitMilli' | 'creditMilli'>;

/**
 * يجمع الصفوف إلى مجموعات (عميل، فاتورة، سند، نوع) بعد تقريب كل صف وحده بـtoMilli — التقريب قبل الجمع
 * كما في computeDerivedOpening لا بعده (groupBy على Float ثم تقريب المجموع يعطي أحمر C3 كاذباً).
 */
export function openingEntryGroupsFromRows(rows: Iterable<OpeningEntryRow>, decimals: number, into: Map<string, OpeningEntryGroup> = new Map()): Map<string, OpeningEntryGroup> {
  for (const r of rows) {
    const key = `${r.customerId}|${r.invoiceId ?? ''}|${r.receiptId ?? ''}|${r.type}`;
    let g = into.get(key);
    if (!g) {
      g = { customerId: r.customerId, invoiceId: r.invoiceId, receiptId: r.receiptId, type: r.type, invoiceType: r.invoiceType, debit: 0, credit: 0, debitMilli: 0n, creditMilli: 0n };
      into.set(key, g);
    }
    g.debitMilli = (g.debitMilli ?? 0n) + toMilli(r.debit ?? 0, decimals);
    g.creditMilli = (g.creditMilli ?? 0n) + toMilli(r.credit ?? 0, decimals);
  }
  return into;
}

/**
 * مرآة openingRowRole في opening.ts (اختبار gl-checks يثبت التطابق) — لا يُستورد opening.ts هنا لأنه يجرّ
 * config/database عبر warehouseStock إلى المجدول والفحوص.
 */
export function openingEntryRole(e: Pick<OpeningEntryGroup, 'invoiceId' | 'receiptId' | 'type' | 'invoiceType'>): 'EFFECT' | 'REVERSAL' | null {
  if (e.invoiceId) {
    if (!e.invoiceType) return null;
    if (e.invoiceType === 'RETURN') return e.type === 'INVOICE_CREDIT' ? 'EFFECT' : e.type === 'INVOICE_DEBIT' ? 'REVERSAL' : null;
    if (e.type === 'INVOICE_DEBIT' || e.type === 'RECEIPT_CREDIT') return 'EFFECT';
    if (e.type === 'INVOICE_CREDIT' || e.type === 'RECEIPT_DEBIT') return 'REVERSAL';
    return null;
  }
  if (e.receiptId) return e.type === 'RECEIPT_CREDIT' ? 'EFFECT' : e.type === 'RECEIPT_DEBIT' ? 'REVERSAL' : null;
  return null;
}

/**
 * Σ(مدين − دائن) لكل عميل بقاعدة computeDerivedOpening: مجموعة «إلغاء» لمستند لا مجموعة «أثر» له في النافذة تُسقط
 * (مستند مؤرخ مستقبلاً أُلغي قبل البدء يُرحَّل POST وREVERSE معاً). roleOf = openingEntryRole افتراضياً.
 */
export function openingEntryTotalsFromGroups(
  groups: readonly OpeningEntryGroup[], decimals: number,
  roleOf: (g: Pick<OpeningEntryGroup, 'invoiceId' | 'receiptId' | 'type' | 'invoiceType'>) => 'EFFECT' | 'REVERSAL' | null = openingEntryRole,
): Map<string, Milli> {
  const docOf = (g: OpeningEntryGroup) => (g.invoiceId ? `I:${g.invoiceId}` : g.receiptId ? `R:${g.receiptId}` : null);
  const withEffect = new Set<string>();
  for (const g of groups) {
    const doc = docOf(g);
    if (doc && roleOf(g) === 'EFFECT') withEffect.add(doc);
  }
  const out = new Map<string, Milli>();
  for (const g of groups) {
    const doc = docOf(g);
    if (doc && roleOf(g) === 'REVERSAL' && !withEffect.has(doc)) continue;
    out.set(g.customerId, (out.get(g.customerId) ?? 0n) + (g.debitMilli ?? toMilli(g.debit, decimals)) - (g.creditMilli ?? toMilli(g.credit, decimals)));
  }
  return out;
}

export function c3OpeningEntryGaps(input: C3Input): OpeningEntryGap[] {
  const entries = input.openingEntries;
  if (!entries) return [];
  const ids = new Set<string>([...input.opening.keys(), ...entries.keys(), ...input.deletedOpeningImports.keys()]);
  const out: OpeningEntryGap[] = [];
  for (const id of ids) {
    const openingMilli = input.opening.get(id) ?? 0n;
    const openingEntriesMilli = entries.get(id) ?? 0n;
    const deletedWithEventMilli = input.deletedOpeningImports.get(id) ?? 0n;
    const gapMilli = openingMilli - openingEntriesMilli - deletedWithEventMilli;
    if (gapMilli === 0n) continue;
    out.push({
      customerId: id, name: input.names.get(id) ?? null, openingMilli, openingEntriesMilli, deletedWithEventMilli, gapMilli,
      pending: input.pendingAll || input.pendingCustomers.has(id),
    });
  }
  return out.sort((a, b) => (abs(b.gapMilli) > abs(a.gapMilli) ? 1 : abs(b.gapMilli) < abs(a.gapMilli) ? -1 : a.customerId < b.customerId ? -1 : 1));
}

function sumMap(m: ReadonlyMap<string, Milli>): Milli {
  let t = 0n;
  for (const v of m.values()) t += v;
  return t;
}

function gapRows(gaps: readonly PartnerGap[], idField: 'customerId' | 'salesRepId'): CheckRow[] {
  return gaps.map((g) => ({
    [idField]: g.partnerId, name: g.name, ledgerMilli: milliText(g.ledgerMilli), expectedMilli: milliText(g.expectedMilli),
    gapMilli: milliText(g.gapMilli), pending: g.pending, adjustable: !g.pending,
  }));
}

function gapStatus(gaps: readonly PartnerGap[]): CheckStatus {
  if (gaps.length === 0) return 'GREEN';
  return gaps.some((g) => !g.pending) ? 'RED' : 'YELLOW';
}

export function evaluateC3(input: C3Input): CheckResult {
  const gaps = c3Gaps(input);
  const gapsStatus = gapStatus(gaps);
  const openingGaps = c3OpeningEntryGaps(input);
  const openingStatus: CheckStatus = openingGaps.length === 0 ? 'GREEN' : openingGaps.some((g) => !g.pending) ? 'RED' : 'YELLOW';
  const status = worstStatus([gapsStatus, openingStatus]);
  const ledgerTotal = sumMap(input.ledger);
  const expectedTotal = sumMap(input.opening) + sumMap(input.entriesAfterCutover) - sumMap(input.deletedOpeningImports);
  const metrics: CheckResult['metrics'] = { ledgerTotalMilli: milliText(ledgerTotal), expectedTotalMilli: milliText(expectedTotal), totalGapMilli: milliText(ledgerTotal - expectedTotal) };
  if (openingGaps.length > 0) metrics.openingDeletedWithoutEvent = openingGaps.length;
  if (status === 'GREEN') return result('C3', 'GREEN', 'رصيد ذمم كل عميل يطابق حركاته', [], null, metrics);
  const parts: string[] = [];
  if (gapsStatus === 'RED') parts.push(`${gaps.filter((g) => !g.pending).length} عميل ينحرف رصيد ذممه عن حركاته`);
  if (openingStatus === 'RED') parts.push(`${openingGaps.filter((g) => !g.pending).length} صف افتتاحي حُذف بلا حدث`);
  const summary = parts.length > 0 ? parts.join('، ') : 'انحرافات مؤقتة بانتظار الترحيل الآلي';
  // صف «حُذف بلا حدث» لا يُصحَّح بقيد التصحيح من هنا (انحراف c3Gaps له صفر): adjustable=false دائماً
  const openingRows: CheckRow[] = openingGaps.map((g) => ({
    kind: OPENING_DELETED_WITHOUT_EVENT, customerId: g.customerId, name: g.name,
    openingMilli: milliText(g.openingMilli), openingEntriesMilli: milliText(g.openingEntriesMilli),
    deletedWithEventMilli: milliText(g.deletedWithEventMilli), openingGapMilli: milliText(g.gapMilli),
    pending: g.pending, adjustable: false,
  }));
  const fix: CheckFix | null = gapsStatus === 'RED' ? 'CONTROL_ADJUSTMENT' : status === 'YELLOW' ? 'SYNC_NOW' : null;
  return result('C3', status, summary, [...gapRows(gaps, 'customerId'), ...openingRows], fix, metrics);
}

// ═══ C4 وC4b: العهدة ═══

export interface RepCustodyFacts {
  salesRepId: string;
  name: string | null;
  isActive: boolean;
  /** Σ(مدين − دائن) لسطور حسابات CUSTODY المرحّلة للمندوب */
  ledgerMilli: Milli;
  components: CustodyComponents;
  /** صيغة repCollection القائمة: Σ السندات النشطة بكل الطرق − Σ الاستلامات */
  opsOutstandingMilli: Milli;
  pending: boolean;
}

export function c4Gaps(reps: readonly RepCustodyFacts[]): PartnerGap[] {
  return reps
    .map((r) => ({
      partnerId: r.salesRepId, name: r.name, ledgerMilli: r.ledgerMilli, expectedMilli: r.components.ledgerCustody,
      gapMilli: custodyC4Gap(r.ledgerMilli, r.components), pending: r.pending,
    }))
    .filter((g) => g.gapMilli !== 0n);
}

export function evaluateC4(reps: readonly RepCustodyFacts[]): CheckResult {
  const gaps = c4Gaps(reps);
  const status = gapStatus(gaps);
  if (status === 'GREEN') return result('C4', 'GREEN', 'عهدة كل مندوب في الأستاذ تطابق مكوّناتها', [], null, { reps: reps.length });
  return result(
    'C4', status,
    status === 'RED' ? `${gaps.filter((g) => !g.pending).length} مندوب تنحرف عهدته في الأستاذ` : 'انحرافات مؤقتة بانتظار الترحيل الآلي',
    gapRows(gaps, 'salesRepId'), status === 'RED' ? 'CONTROL_ADJUSTMENT' : 'SYNC_NOW', { reps: reps.length },
  );
}

/** C4b أصفر لا أحمر (§5.9): الفرق دلالي، مع جدول المكوّنات لكل مندوب */
export function evaluateC4b(reps: readonly RepCustodyFacts[]): CheckResult {
  const rows: CheckRow[] = reps.map((r) => {
    const c = r.components;
    const gap = custodyC4bGap(c, r.opsOutstandingMilli);
    return {
      salesRepId: r.salesRepId, name: r.name, isActive: r.isActive,
      opsOutstandingMilli: milliText(r.opsOutstandingMilli), ledgerCustodyMilli: milliText(c.ledgerCustody),
      onlineUnclearedMilli: milliText(c.onlineUncleared), custodyExpensesMilli: milliText(c.custodyExpenses),
      openShortageMilli: milliText(c.openShortage), shortagesExpensedMilli: milliText(c.shortagesExpensed),
      nonCustodyClearedMilli: milliText(c.nonCustodyCleared), gapMilli: milliText(gap), matched: gap === 0n,
      // «ربط الدفاتر» C11: إلغاءٌ رُدّ ماله من خارج العهدة ينقص الشاشة ولا ينقص 111003 — بند المعادلة حين يوجد وحده
      ...(c.cancelRefundOutside ? { cancelRefundOutsideMilli: milliText(c.cancelRefundOutside) } : {}),
    };
  });
  const mismatched = rows.filter((r) => r.matched === false);
  if (mismatched.length === 0) return result('C4b', 'GREEN', 'الشاشة التشغيلية تطابق مكوّنات العهدة', rows, null, { reps: reps.length });
  // الصفوف غير المتطابقة أولاً
  const ordered = [...mismatched, ...rows.filter((r) => r.matched !== false)];
  return result('C4b', 'YELLOW', `${mismatched.length} مندوب تختلف شاشته التشغيلية عن مكوّنات عهدته`, ordered, null, { reps: reps.length, mismatched: mismatched.length });
}

// ═══ C5: الأمانات ═══

export interface C5Input {
  /** Σ(مدين − دائن) لحسابات PAYLINK (112005) */
  ledgerMilli: Milli;
  /** settlementBalance(tenant) = Σ SettlementEntry.amount */
  settlementBalanceMilli: Milli;
  pending: boolean;
  refundedLinksWithoutRefund: readonly { linkId: string; receiptId: string | null; amountMilli: Milli }[];
  cancelledOnlineWithoutRefund: readonly { receiptId: string; number: string | null; amountMilli: Milli }[];
}

export function c5Gap(input: Pick<C5Input, 'ledgerMilli' | 'settlementBalanceMilli'>): Milli {
  return input.ledgerMilli - input.settlementBalanceMilli;
}

export function evaluateC5(input: C5Input): CheckResult {
  const gap = c5Gap(input);
  const metrics = {
    ledgerMilli: milliText(input.ledgerMilli), settlementBalanceMilli: milliText(input.settlementBalanceMilli), gapMilli: milliText(gap),
    pending: input.pending,
  };
  // صف التفسير (§5.9): الروابط المستردة بلا REFUND، وسندات ONLINE الملغاة دون REFUND (قيدها على 911001، P6)
  const explanation: CheckRow[] = [
    ...input.refundedLinksWithoutRefund.map((l) => ({ kind: 'REFUNDED_LINK_WITHOUT_REFUND', linkId: l.linkId, receiptId: l.receiptId, amountMilli: milliText(l.amountMilli) })),
    ...input.cancelledOnlineWithoutRefund.map((r) => ({ kind: 'CANCELLED_ONLINE_WITHOUT_REFUND', receiptId: r.receiptId, number: r.number, amountMilli: milliText(r.amountMilli) })),
  ];
  if (gap === 0n) return result('C5', 'GREEN', 'رصيد الأمانات في الأستاذ يطابق دفتر الأمانات', explanation, null, metrics);
  const status: CheckStatus = input.pending ? 'YELLOW' : 'RED';
  const rows: CheckRow[] = [
    { kind: 'GAP', ledgerMilli: milliText(input.ledgerMilli), expectedMilli: milliText(input.settlementBalanceMilli), gapMilli: milliText(gap), pending: input.pending, adjustable: !input.pending },
    ...explanation,
  ];
  return result('C5', status, status === 'RED' ? 'رصيد الأمانات في الأستاذ لا يطابق دفتر الأمانات' : 'انحراف مؤقت بانتظار الترحيل الآلي', rows, status === 'RED' ? 'CONTROL_ADJUSTMENT' : 'SYNC_NOW', metrics);
}

// ═══ C8: الأحداث ═══

export interface ProblemEvent {
  id: string;
  sourceKey: string;
  sourceType: string;
  event: string;
  status: string;
  effectAt: Date;
  detectedAt: Date;
  nextAttemptAt: Date | null;
  attempts: number;
  lastError: string | null;
  /** حالة شقيق POST (لأحداث REVERSE/COGS/RESTOCK) */
  sibling: { sourceKey: string; status: string; skipReason: string | null; nextAttemptAt: Date | null } | null;
}

export function c8Severity(e: Pick<ProblemEvent, 'status' | 'detectedAt'>, now: Date): CheckStatus {
  const age = now.getTime() - e.detectedAt.getTime();
  if (e.status === 'BLOCKED') return age > C8_RED_MS ? 'RED' : age > C8_BLOCKED_YELLOW_MS ? 'YELLOW' : 'GREEN';
  if (e.status === 'ERROR' || e.status === 'HELD') return age > C8_RED_MS ? 'RED' : 'YELLOW';
  return 'GREEN';
}

export function evaluateC8(events: readonly ProblemEvent[], now: Date): CheckResult {
  const scored = events
    .map((e) => ({ e, severity: c8Severity(e, now) }))
    .filter((x) => x.severity !== 'GREEN')
    .sort((a, b) => (a.severity === b.severity ? a.e.detectedAt.getTime() - b.e.detectedAt.getTime() : a.severity === 'RED' ? -1 : 1));
  const rows: CheckRow[] = scored.map(({ e, severity }) => ({
    id: e.id, sourceKey: e.sourceKey, sourceType: e.sourceType, event: e.event, status: e.status, severity,
    effectAt: e.effectAt.toISOString(), detectedAt: e.detectedAt.toISOString(),
    nextAttemptAt: e.nextAttemptAt ? e.nextAttemptAt.toISOString() : null, attempts: e.attempts, lastError: e.lastError,
    siblingKey: e.sibling?.sourceKey ?? null, siblingStatus: e.sibling?.status ?? null, siblingSkipReason: e.sibling?.skipReason ?? null,
    siblingNextAttemptAt: e.sibling?.nextAttemptAt ? e.sibling.nextAttemptAt.toISOString() : null,
  }));
  const status = worstStatus(scored.map((x) => x.severity));
  const metrics = {
    red: scored.filter((x) => x.severity === 'RED').length,
    yellow: scored.filter((x) => x.severity === 'YELLOW').length,
  };
  if (status === 'GREEN') return result('C8', 'GREEN', 'لا أحداث متعثرة', [], null, metrics);
  return result('C8', status, `${rows.length} حدث متعثر أو محجوب`, rows, 'REVIEW_EVENTS', metrics);
}

// ═══ C9: المعلّقات ═══

export interface SuspenseAccountFacts {
  key: 'POSTING_SUSPENSE' | 'BANK_SUSPENSE';
  accountId: string | null;
  accountCode: string | null;
  balanceMilli: Milli;
  /** قيود مرحّلة على الحساب تحتاج انتباهاً (أحدثها أولاً) */
  attentionMoves: readonly { moveId: string; number: string | null; date: LocalDate; attentionReason: string | null; amountMilli: Milli }[];
}

/**
 * استيراد البند 7 (ب): صافي 319002 (OPENING_EQUITY) من قيود IMPORT بتاريخ ≥ البدء — حركات مستوردة بعد البدء رُحّلت على
 * الأرصدة الافتتاحية لا على الإيراد والضريبة. المخزن يستبعد الوصولات المتأخرة (مكانها الصحيح الافتتاح بتاريخ البدء)
 * وعكس صف افتتاحي (مصدره REVERSE بلا قيد معكوس)، ويُدخل عكس قيد مشمول فيصفّيه.
 */
export interface ImportAfterCutoverFacts {
  accountId: string;
  accountCode: string | null;
  cutoverDate: LocalDate;
  netMilli: Milli;
  moveCount: number;
  /** أحدثها أولاً — مقصوصة */
  moves: readonly { moveId: string; number: string | null; date: LocalDate; attentionReason: string | null; amountMilli: Milli; reversal: boolean }[];
}

export const IMPORT_AFTER_CUTOVER_ROW = 'IMPORT_AFTER_CUTOVER';

export function evaluateC9(accounts: readonly SuspenseAccountFacts[], importAfterCutover: ImportAfterCutoverFacts | null = null): CheckResult {
  const rows: CheckRow[] = [];
  for (const a of accounts) {
    if (a.balanceMilli === 0n) continue;
    rows.push({ kind: 'ACCOUNT', key: a.key, accountId: a.accountId, accountCode: a.accountCode, balanceMilli: milliText(a.balanceMilli) });
    for (const m of a.attentionMoves) {
      rows.push({ kind: 'MOVE', key: a.key, accountCode: a.accountCode, moveId: m.moveId, number: m.number, date: m.date, attentionReason: m.attentionReason, amountMilli: milliText(m.amountMilli) });
    }
  }
  const imported = importAfterCutover && importAfterCutover.netMilli !== 0n ? importAfterCutover : null;
  if (imported) {
    rows.push({
      kind: IMPORT_AFTER_CUTOVER_ROW, key: 'OPENING_EQUITY', accountId: imported.accountId, accountCode: imported.accountCode,
      cutoverDate: imported.cutoverDate, balanceMilli: milliText(imported.netMilli), moveCount: imported.moveCount,
    });
    for (const m of imported.moves) {
      rows.push({
        kind: 'IMPORT_MOVE', key: 'OPENING_EQUITY', accountCode: imported.accountCode, moveId: m.moveId, number: m.number, date: m.date,
        attentionReason: m.attentionReason, amountMilli: milliText(m.amountMilli), reversal: m.reversal,
      });
    }
  }
  const nonZero = accounts.filter((a) => a.balanceMilli !== 0n);
  const metrics: CheckResult['metrics'] = Object.fromEntries(accounts.map((a) => [`${a.key}Milli`, milliText(a.balanceMilli)]));
  if (importAfterCutover) metrics.importAfterCutoverMilli = milliText(importAfterCutover.netMilli);
  if (nonZero.length === 0 && !imported) return result('C9', 'GREEN', 'الحسابات المعلّقة صفرية', [], null, metrics);
  const parts: string[] = [];
  if (nonZero.length > 0) parts.push('رصيد معلّق ينتظر التسوية إلى حسابه الصحيح');
  if (imported) parts.push('حركات مستوردة بعد تاريخ البدء على الأرصدة الافتتاحية 319002 — راجع تصنيفها');
  return result('C9', 'YELLOW', parts.join('، '), rows, 'REVIEW_SUSPENSE', metrics);
}

// ═══ C10: المسودات قبل الإقفال ═══

export function evaluateC10(input: { lockDate: LocalDate | null; count: number; drafts: readonly { id: string; date: LocalDate; ref: string | null }[] }): CheckResult {
  if (!input.lockDate || input.count === 0) {
    return result('C10', 'GREEN', 'لا مسودات قبل أحدث تاريخ إقفال', [], null, { lockDate: input.lockDate, count: 0 });
  }
  const rows: CheckRow[] = input.drafts.map((d) => ({ moveId: d.id, date: d.date, ref: d.ref }));
  const r = result('C10', 'YELLOW', `${input.count} مسودة بتاريخ لا يتجاوز ${input.lockDate}`, rows, 'REVIEW_DRAFTS', {
    lockDate: input.lockDate, count: input.count, listUrl: `/app/ledger/entries?state=DRAFT&dateTo=${input.lockDate}`,
  });
  return { ...r, rowCount: input.count };
}

// ═══ C11: ضرائب AUTO_SALE بلا مربع ═══

export function evaluateC11(taxes: readonly { id: string; key: string | null; name: string; rate: number; vatBox: string | null }[]): CheckResult {
  const rows = taxes
    .filter((t) => (t.key ?? '').startsWith('AUTO_SALE_') && !(t.vatBox ?? '').trim())
    .map((t) => ({ taxId: t.id, key: t.key, name: t.name, rate: t.rate }));
  return rows.length === 0
    ? result('C11', 'GREEN', 'كل الضرائب الآلية مربوطة بمربع إقرار', [], null)
    : result('C11', 'YELLOW', `${rows.length} ضريبة آلية بلا مربع إقرار`, rows, 'CONFIGURE_TAXES');
}

// ═══ C12: الترقيم ═══

export interface SequenceFacts { journalId: string; journalCode: string | null; prefix: string; periodKey: string; nextNumber: number }

export function evaluateC12(sequences: readonly SequenceFacts[], moves: readonly { journalId: string; number: string }[]): CheckResult {
  const groups = new Map<string, { journalId: string; prefix: string; periodKey: string; numbers: number[] }>();
  const rows: CheckRow[] = [];
  for (const m of moves) {
    const p = parseMoveNumber(m.number);
    if (!p) {
      rows.push({ kind: 'UNPARSEABLE', journalId: m.journalId, number: m.number });
      continue;
    }
    const k = `${m.journalId}|${p.prefix}|${p.periodKey}`;
    let g = groups.get(k);
    if (!g) { g = { journalId: m.journalId, prefix: p.prefix, periodKey: p.periodKey, numbers: [] }; groups.set(k, g); }
    g.numbers.push(p.n);
  }
  const seqByKey = new Map(sequences.map((s) => [`${s.journalId}|${s.prefix}|${s.periodKey}`, s]));
  const keys = new Set<string>([...groups.keys(), ...seqByKey.keys()]);
  for (const k of [...keys].sort()) {
    const g = groups.get(k);
    const s = seqByKey.get(k);
    const numbers = g?.numbers ?? [];
    const rep = checkSequenceGaps(numbers, s ? s.nextNumber : undefined);
    if (rep.ok) continue;
    rows.push({
      kind: 'GAP', journalId: g?.journalId ?? s?.journalId ?? null, journalCode: s?.journalCode ?? null,
      prefix: g?.prefix ?? s?.prefix ?? null, periodKey: g?.periodKey ?? s?.periodKey ?? null,
      nextNumber: s?.nextNumber ?? null, missing: rep.missing.slice(0, 50), missingCount: rep.missing.length,
      unexpected: rep.unexpected.slice(0, 50), duplicates: rep.duplicates.slice(0, 50),
    });
  }
  return rows.length === 0
    ? result('C12', 'GREEN', 'لا فجوات في تسلسلات الترقيم', [], null, { groups: keys.size })
    : result('C12', 'RED', `${rows.length} تسلسل فيه فجوة أو رقم خارج المدى`, rows, null, { groups: keys.size });
}

// ═══ C14: ازدواج القيد مع ERP ═══

export function evaluateC14(input: { erpOdooActive: boolean }): CheckResult {
  return input.erpOdooActive
    ? result('C14', 'YELLOW', 'ربط ERP بمزوّد Odoo مفعّل مع النظام المحاسبي المتكامل: خطر القيد المزدوج', [{ provider: 'ODOO' }], 'DISABLE_ERP_POSTING')
    : result('C14', 'GREEN', 'لا ربط ERP يقيد الحركات نفسها', [], null);
}

// ═══ C15: تأخّر المؤشر ═══

export interface CursorFacts {
  source: string;
  watermarkAt: Date | null;
  lastRunAt: Date | null;
  lastCount: number;
  stallTicks: number;
  /** cursorLagMs: dbNow − watermarkAt حين توجد صفوف غير مقروءة حتى الأفق، وإلا 0؛ null = لا مؤشر */
  lagMs: number | null;
}

export function evaluateC15(input: { backfillState: BackfillState | string; cursors: readonly CursorFacts[]; requiredSources: readonly string[] }): CheckResult {
  const bySource = new Map(input.cursors.map((c) => [c.source, c]));
  const rows: CheckRow[] = [];
  const backfill = input.backfillState !== 'DONE';
  let red = false;
  let yellow = false;
  for (const source of input.requiredSources) {
    const c = bySource.get(source);
    const missing = !c;
    const lagging = !!c && c.lagMs !== null && c.lagMs > C15_LAG_RED_MS;
    const stalled = !!c && c.stallTicks > 0;
    if (missing || lagging || stalled) {
      if (backfill) yellow = true; else red = true;
    }
    rows.push({
      source, watermarkAt: c?.watermarkAt ? c.watermarkAt.toISOString() : null, lastRunAt: c?.lastRunAt ? c.lastRunAt.toISOString() : null,
      lastCount: c?.lastCount ?? 0, stallTicks: c?.stallTicks ?? 0, lagMs: c?.lagMs ?? null,
      lagMinutes: c?.lagMs != null ? Math.floor(c.lagMs / 60_000) : null, missing, lagging, stalled,
    });
  }
  const metrics = { backfillState: String(input.backfillState), backfill };
  if (red) return result('C15', 'RED', 'مؤشر المزامنة متأخر أو متوقف', rows, 'SYNC_NOW', metrics);
  if (yellow) return result('C15', 'YELLOW', 'الترحيل التاريخي جارٍ ولا تقدم في بعض المصادر', rows, 'SYNC_NOW', metrics);
  return result('C15', 'GREEN', backfill ? 'الترحيل التاريخي جارٍ' : 'المؤشرات حديثة', rows, null, metrics);
}

// ═══ «ربط الدفاتر» L5 — C4u: عهدة مستخدمي الشركة (D6، OD5) ═══

/** حقائق مستخدمٍ واحد: رصيده في الأستاذ (111004 ببُعد adminUserId) وطيّ عهدته التشغيلية بالدالة نفسها للشاشة والقيد */
export interface UserCustodyFacts {
  userId: string;
  name: string | null;
  /** Σ(مدين − دائن) لسطور حسابات CUSTODY المرحّلة ببُعد المستخدم (ومنها القيد الافتتاحي) */
  ledgerMilli: Milli;
  fold: UserCustodyFold;
  pending: boolean;
}

export function c4uGaps(users: readonly UserCustodyFacts[]): PartnerGap[] {
  return users
    .map((u) => ({
      partnerId: u.userId, name: u.name, ledgerMilli: u.ledgerMilli, expectedMilli: u.fold.outstandingMilli,
      gapMilli: u.ledgerMilli - u.fold.outstandingMilli, pending: u.pending,
    }))
    .filter((g) => g.gapMilli !== 0n)
    .sort((a, b) => (abs(b.gapMilli) > abs(a.gapMilli) ? 1 : abs(b.gapMilli) < abs(a.gapMilli) ? -1 : a.partnerId < b.partnerId ? -1 : 1));
}

/**
 * C4u: 111004 لكل مستخدم = foldUserCustody(...).outstanding (R4). أي فرق أحمر، إلا لمستخدمٍ له أحداث غير نهائية فأصفر
 * (§5.9: الأستاذ لم يلحق بعد). الصفوف لكل مستخدم بمكوّنات طيّه (المختلف أولاً)، ولا قيد تصحيح آلياً من هنا (adjustable=false).
 */
export function evaluateC4u(users: readonly UserCustodyFacts[]): CheckResult {
  const gaps = c4uGaps(users);
  const gapOf = new Map(gaps.map((g) => [g.partnerId, g]));
  const status = gapStatus(gaps);
  const rowOf = (u: UserCustodyFacts): CheckRow => {
    const g = gapOf.get(u.userId);
    return {
      userId: u.userId, name: u.name, ledgerMilli: milliText(u.ledgerMilli), expectedMilli: milliText(u.fold.outstandingMilli),
      gapMilli: milliText(g?.gapMilli ?? 0n), receivedCashMilli: milliText(u.fold.receivedCashMilli),
      receivedNonCashMilli: milliText(u.fold.receivedNonCashMilli), deliveredMilli: milliText(u.fold.deliveredMilli),
      passThroughMilli: milliText(u.fold.passThroughMilli), refundsMilli: milliText(u.fold.refundsMilli),
      nonCashPoolMilli: milliText(u.fold.nonCashPoolMilli), matched: !g, pending: u.pending, adjustable: false,
    };
  };
  const ordered = [...users].sort((a, b) => {
    const ga = gapOf.has(a.userId) ? 0 : 1;
    const gb = gapOf.has(b.userId) ? 0 : 1;
    return ga - gb || (a.name ?? a.userId).localeCompare(b.name ?? b.userId, 'ar');
  });
  const ledgerTotal = users.reduce((t, u) => t + u.ledgerMilli, 0n);
  const outstandingTotal = users.reduce((t, u) => t + u.fold.outstandingMilli, 0n);
  const metrics: CheckResult['metrics'] = {
    users: users.length, ledgerTotalMilli: milliText(ledgerTotal), expectedTotalMilli: milliText(outstandingTotal),
    totalGapMilli: milliText(ledgerTotal - outstandingTotal), mismatched: gaps.length,
  };
  const rows = ordered.map(rowOf);
  if (status === 'GREEN') return result('C4u', 'GREEN', 'عهدة كل مستخدم في الأستاذ تطابق عهدته التشغيلية', rows, null, metrics);
  return result(
    'C4u', status,
    status === 'RED' ? `${gaps.filter((g) => !g.pending).length} مستخدم تنحرف عهدته في الأستاذ عن عهدته التشغيلية` : 'انحرافات مؤقتة بانتظار الترحيل الآلي',
    rows, status === 'RED' ? null : 'SYNC_NOW', metrics,
  );
}

// ═══ «ربط الدفاتر» L8 — C16: الذمم المفتوحة مقابل متبقّي الفواتير ═══

/** الحد الأعلى لفواتير التعمّق في C16 */
export const C16_INVOICE_DETAIL_LIMIT = 50;

/** فاتورة تختلف ذمتها المفتوحة في الأستاذ (Σ متبقّي سطور مدينها بعد المطابقة) عن remainingAmt التشغيلي */
export interface C16InvoiceDetail {
  invoiceId: string;
  number: string | null;
  customerId: string;
  invoiceDate: LocalDate | null;
  /** remainingAmt مقرَّباً لمنازل العملة (نصف-لأعلى) */
  remainingMilli: Milli;
  /** Σ متبقّي سطور الذمة المدينة لقيدها الحيّ (0 إن لم يُرحَّل) */
  ledgerOpenMilli: Milli;
}

export interface C16Input {
  /** Σ متبقّي سطور 113001 المدينة لكل عميل (reconcile/store.prisma.openArByCustomer) */
  ledgerOpen: ReadonlyMap<string, Milli>;
  /** Σ remainingAmt لفواتير CONFIRMED (CREDIT/CASH) لكل عميل بتقريب كل فاتورة */
  opsRemaining: ReadonlyMap<string, Milli>;
  names: ReadonlyMap<string, string>;
  pendingCustomers: ReadonlySet<string>;
  pendingAll: boolean;
  /** تعمّق بالفاتورة للعملاء المختلفين (حتى C16_INVOICE_DETAIL_LIMIT) */
  invoices: readonly C16InvoiceDetail[];
}

export function c16Gaps(input: Pick<C16Input, 'ledgerOpen' | 'opsRemaining' | 'names' | 'pendingCustomers' | 'pendingAll'>): PartnerGap[] {
  const ids = new Set<string>([...input.ledgerOpen.keys(), ...input.opsRemaining.keys()]);
  const out: PartnerGap[] = [];
  for (const id of ids) {
    const ledgerMilli = input.ledgerOpen.get(id) ?? 0n;
    const expectedMilli = input.opsRemaining.get(id) ?? 0n;
    const gapMilli = ledgerMilli - expectedMilli;
    if (gapMilli === 0n) continue;
    out.push({ partnerId: id, name: input.names.get(id) ?? null, ledgerMilli, expectedMilli, gapMilli, pending: input.pendingAll || input.pendingCustomers.has(id) });
  }
  return out.sort((a, b) => (abs(b.gapMilli) > abs(a.gapMilli) ? 1 : abs(b.gapMilli) < abs(a.gapMilli) ? -1 : a.partnerId < b.partnerId ? -1 : 1));
}

/**
 * C16 (أصفر، L8): لكل عميل Σ الذمم المفتوحة في الأستاذ (متبقّي السطور المدينة بعد المطابقة الجزئية) = Σ متبقّي فواتيره.
 * فرقٌ دلالة على مطابقة ناقصة (فاتورة لم تُرحَّل، أو تخصيص لم يُطابَق) أو فجوة D8 الموثّقة (إشعار دائن أسقط من أصله أكثر
 * من المفتوح) — لا تصحيح آلياً. التعمّق بالفاتورة للعملاء المختلفين.
 */
export function evaluateC16(input: C16Input): CheckResult {
  const gaps = c16Gaps(input);
  const sum = (m: ReadonlyMap<string, Milli>): Milli => { let t = 0n; for (const v of m.values()) t += v; return t; };
  const ledgerTotal = sum(input.ledgerOpen);
  const opsTotal = sum(input.opsRemaining);
  const metrics: CheckResult['metrics'] = {
    customers: gaps.length, ledgerTotalMilli: milliText(ledgerTotal), expectedTotalMilli: milliText(opsTotal),
    totalGapMilli: milliText(ledgerTotal - opsTotal),
  };
  if (gaps.length === 0) return result('C16', 'GREEN', 'الذمم المفتوحة في الأستاذ تطابق متبقّي الفواتير لكل عميل', [], null, metrics);
  const rows: CheckRow[] = [
    ...gaps.map((g) => ({
      kind: 'CUSTOMER', customerId: g.partnerId, name: g.name, ledgerMilli: milliText(g.ledgerMilli), expectedMilli: milliText(g.expectedMilli),
      gapMilli: milliText(g.gapMilli), pending: g.pending, adjustable: false,
    })),
    ...input.invoices.slice(0, C16_INVOICE_DETAIL_LIMIT).map((i) => ({
      kind: 'INVOICE', invoiceId: i.invoiceId, number: i.number, customerId: i.customerId, date: i.invoiceDate,
      ledgerMilli: milliText(i.ledgerOpenMilli), expectedMilli: milliText(i.remainingMilli), gapMilli: milliText(i.ledgerOpenMilli - i.remainingMilli),
    })),
  ];
  const allPending = gaps.every((g) => g.pending);
  return result(
    'C16', 'YELLOW',
    allPending ? 'انحرافات مؤقتة بانتظار الترحيل الآلي' : `${gaps.length} عميل تختلف ذممه المفتوحة في الأستاذ عن متبقّي فواتيره`,
    rows, allPending ? 'SYNC_NOW' : null, metrics,
  );
}
