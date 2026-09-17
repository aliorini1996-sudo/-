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
import { checkSequenceGaps, parseMoveNumber } from '../sequence';
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
  const status = gapStatus(gaps);
  const ledgerTotal = sumMap(input.ledger);
  const expectedTotal = sumMap(input.opening) + sumMap(input.entriesAfterCutover) - sumMap(input.deletedOpeningImports);
  const metrics = { ledgerTotalMilli: milliText(ledgerTotal), expectedTotalMilli: milliText(expectedTotal), totalGapMilli: milliText(ledgerTotal - expectedTotal) };
  if (status === 'GREEN') return result('C3', 'GREEN', 'رصيد ذمم كل عميل يطابق حركاته', [], null, metrics);
  const summary = status === 'RED'
    ? `${gaps.filter((g) => !g.pending).length} عميل ينحرف رصيد ذممه عن حركاته`
    : 'انحرافات مؤقتة بانتظار الترحيل الآلي';
  return result('C3', status, summary, gapRows(gaps, 'customerId'), status === 'RED' ? 'CONTROL_ADJUSTMENT' : 'SYNC_NOW', metrics);
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

export function evaluateC9(accounts: readonly SuspenseAccountFacts[]): CheckResult {
  const rows: CheckRow[] = [];
  for (const a of accounts) {
    if (a.balanceMilli === 0n) continue;
    rows.push({ kind: 'ACCOUNT', key: a.key, accountId: a.accountId, accountCode: a.accountCode, balanceMilli: milliText(a.balanceMilli) });
    for (const m of a.attentionMoves) {
      rows.push({ kind: 'MOVE', key: a.key, accountCode: a.accountCode, moveId: m.moveId, number: m.number, date: m.date, attentionReason: m.attentionReason, amountMilli: milliText(m.amountMilli) });
    }
  }
  const nonZero = accounts.filter((a) => a.balanceMilli !== 0n);
  const metrics = Object.fromEntries(accounts.map((a) => [`${a.key}Milli`, milliText(a.balanceMilli)]));
  if (nonZero.length === 0) return result('C9', 'GREEN', 'الحسابات المعلّقة صفرية', [], null, metrics);
  return result('C9', 'YELLOW', 'رصيد معلّق ينتظر التسوية إلى حسابه الصحيح', rows, 'REVIEW_SUSPENSE', metrics);
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
