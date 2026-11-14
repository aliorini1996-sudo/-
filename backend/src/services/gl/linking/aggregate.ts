/**
 * تجميع نتيجة معاينة «ربط الدفاتر» من الظلّ (L2 — العقد §10.1، والخطة §4 «Preview contents»). صرفٌ بلا قاعدة ولا ساعة.
 *
 * - ميزان المراجعة بالأشهر، وقائمة الدخل منذ بداية السنة، والميزانية اليوم: بمحرّك التقارير نفسه (composeBalances +
 *   buildIncomeStatement/buildBalanceSheet + reportAccountRoles) على سطور الظلّ، فلا منطق تقارير ثانٍ.
 * - الضريبة بالفترة والمربع: vatBoxLineTaxMilli على سطور TAX/MARKER ووعاؤها taxBaseMilli.
 * - القيد الافتتاحي سطراً سطراً (المشتقّ أولاً بترتيب §11 ثم اليدوي ثم 319002)، والأحداث بالنوع والحالة، والمحجوز،
 *   وتقدير الوقت والتخزين.
 * كل الترتيبات حتمية (الرمز/التاريخ/المفتاح) فـresultHash ثابت لمدخلات ثابتة.
 */
import { addMonths, endOfMonth, fiscalYearOf, fiscalYearStart, formatLocalDate, localDate, monthKey, parseLocalDate } from '../dates';
import { toMilli } from '../money';
import type { ManualBalanceIssue, OpeningMoveResult } from '../opening';
import { composeBalances } from '../reports/balances';
import { buildBalanceSheet, flattenBalanceSheet } from '../reports/balanceSheet';
import { buildIncomeStatement, reportAccountRoles } from '../reports/incomeStatement';
import { makePeriod, monthKeysBetween } from '../reports/period';
import type { BalanceLineRow, ReportAccount } from '../reports/types';
import type { LedgerContext } from '../resolve';
import { decodeEventNote } from '../sync/classify';
import { siblingPostKey } from '../sync/keys';
import { CONSERVATIVE_MS_PER_EVENT } from '../backfill';
import { vatBoxLineTaxMilli } from '../vat/boxesSA';
import { resolveLineAccount } from '../validate';
import { MAPPING_KEYS, type LocalDate, type Milli, type MoveDraft, type TaxPeriodicity } from '../types';
import type { ShadowState } from './shadowStore';
import {
  BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN, BACKFILL_PEAK_BUDGET_MS_PER_MIN, COST_SNAPSHOT_ROW_BYTES, ROW_BYTES_ESTIMATE,
  type BalanceSheetPreview, type EventCountRow, type HeldLine, type OpeningPreview, type OpeningPreviewLine, type PnlPreview,
  type PreviewEta, type PreviewStorage, type StatementPreviewLine, type TrialBalanceByMonth, type TrialBalanceMonthRow,
  type VatPeriodBoxRow,
} from './types';

/** هامش التخزين: قرص القاعدة ٥ غيغا (basic_1gb) — دفاتر شركة واحدة فوق ١٠٪ منه تستحق تنبيه المالك */
export const PREVIEW_HEADROOM_BYTES = 500 * 1024 * 1024;

const byCodeThenId = (a: { code: string; id: string }, b: { code: string; id: string }) =>
  (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function reportAccounts(ctx: LedgerContext): ReportAccount[] {
  return ctx.accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, nameI18n: null, type: a.type }));
}

function allLineRows(shadow: ShadowState): BalanceLineRow[] {
  const out: BalanceLineRow[] = [];
  for (const m of shadow.moveList) {
    for (const l of m.lines) out.push({ accountId: l.accountId, date: l.date, debitMilli: l.debitMilli, creditMilli: l.creditMilli, closing: false, draft: false });
  }
  return out;
}

function rolesOf(ctx: LedgerContext, accounts: readonly ReportAccount[]) {
  const mappings = MAPPING_KEYS.map((key) => ({ key, accountId: ctx.ctx.accounts.byKey(key)?.id ?? '' })).filter((m) => m.accountId);
  return reportAccountRoles({ accounts, mappings });
}

function maxLineDate(shadow: ShadowState): LocalDate | null {
  let max: LocalDate | null = null;
  for (const m of shadow.moveList) if (!max || m.date > max) max = m.date;
  return max;
}

// ═══ ميزان المراجعة بالأشهر ═══

/**
 * حسابات × أشهر: الافتتاحي = سطور ما قبل linkedFrom (القيد الافتتاحي)، والأشهر من شهر linkedFrom إلى شهر اللقطة —
 * ويمتدّ إلى آخر شهر فيه سطر إن وُجد مستند مؤرّخ مستقبلاً (لا يُخفى سطرٌ من الميزان؛ P11 ينبّه عنه).
 */
export function trialBalanceByMonth(shadow: ShadowState, ctx: LedgerContext, linkedFrom: LocalDate, asOf: LocalDate): TrialBalanceByMonth {
  const last = maxLineDate(shadow);
  const to = last && last > asOf ? last : asOf;
  const months = monthKeysBetween(linkedFrom, to < linkedFrom ? linkedFrom : to);
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const rows: TrialBalanceMonthRow[] = [];
  for (const accountId of shadow.accountIdsWithLines()) {
    const acc = ctx.accountById.get(accountId);
    const md = months.map(() => 0n);
    const mc = months.map(() => 0n);
    let opening = 0n;
    let debit = 0n;
    let credit = 0n;
    for (const l of shadow.linesOn(accountId)) {
      if (l.date < linkedFrom) { opening += l.debitMilli - l.creditMilli; continue; }
      const i = monthIndex.get(monthKey(l.date));
      if (i === undefined) continue;
      md[i] += l.debitMilli;
      mc[i] += l.creditMilli;
      debit += l.debitMilli;
      credit += l.creditMilli;
    }
    if (opening === 0n && debit === 0n && credit === 0n) continue; // سطور العلامات وحدها
    rows.push({
      accountId, accountCode: acc?.code ?? accountId, accountName: acc?.name ?? accountId, accountType: acc?.type ?? 'unknown',
      openingMilli: opening, months: months.map((month, i) => ({ month, debitMilli: md[i], creditMilli: mc[i] })),
      debitMilli: debit, creditMilli: credit, closingMilli: opening + debit - credit,
    });
  }
  rows.sort((a, b) => byCodeThenId({ code: a.accountCode, id: a.accountId }, { code: b.accountCode, id: b.accountId }));
  const totals = rows.reduce((t, r) => ({
    openingMilli: t.openingMilli + r.openingMilli, debitMilli: t.debitMilli + r.debitMilli,
    creditMilli: t.creditMilli + r.creditMilli, closingMilli: t.closingMilli + r.closingMilli,
  }), { openingMilli: 0n, debitMilli: 0n, creditMilli: 0n, closingMilli: 0n });
  return { months, rows, totals };
}

// ═══ القوائم ═══

export interface StatementInput {
  /** اليوم المحلي للقطة */
  asOf: LocalDate;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
}

/** قائمة الدخل من بداية السنة المالية لليوم إلى اليوم (buildIncomeStatement + reportAccountRoles) */
export function pnlYtd(shadow: ShadowState, ctx: LedgerContext, i: StatementInput): PnlPreview {
  const fy = { endMonth: i.fiscalYearEndMonth, endDay: i.fiscalYearEndDay };
  const from = fiscalYearStart(i.asOf, fy.endMonth, fy.endDay);
  const period = makePeriod(from, i.asOf, fy);
  const accounts = reportAccounts(ctx);
  const balances = composeBalances({ period, accounts, lines: allLineRows(shadow) });
  const st = buildIncomeStatement({ period, accounts, balances, roles: rolesOf(ctx, accounts) });
  const lines: StatementPreviewLine[] = [];
  const acctLine = (prefix: string, a: { code: string; name: string; amountMilli: Milli }, depth: number): StatementPreviewLine => ({
    key: `${prefix}:${a.code}`, labelAr: `${a.code} — ${a.name}`, amountMilli: a.amountMilli, depth,
  });
  for (const l of st.lines) {
    lines.push({ key: l.key, labelAr: l.label, amountMilli: l.amountMilli, depth: 0 });
    for (const a of l.accounts) lines.push(acctLine(l.key, a, 1));
    for (const g of l.groups) {
      lines.push({ key: `${l.key}.${g.key}`, labelAr: g.label, amountMilli: g.amountMilli, depth: 1 });
      for (const a of g.accounts) lines.push(acctLine(`${l.key}.${g.key}`, a, 2));
    }
  }
  return { from, to: i.asOf, lines, netMilli: st.netProfitMilli };
}

/** الميزانية «اعتباراً من» اليوم ([FYStart(D), D] — شرط buildBalanceSheet) */
export function balanceSheetToday(shadow: ShadowState, ctx: LedgerContext, i: StatementInput): BalanceSheetPreview {
  const fy = { endMonth: i.fiscalYearEndMonth, endDay: i.fiscalYearEndDay };
  const period = makePeriod(fiscalYearStart(i.asOf, fy.endMonth, fy.endDay), i.asOf, fy);
  const accounts = reportAccounts(ctx);
  const balances = composeBalances({ period, accounts, lines: allLineRows(shadow) });
  const sheet = buildBalanceSheet({ period, accounts, balances, roles: rolesOf(ctx, accounts) });
  const lines: StatementPreviewLine[] = [];
  for (const { node, depth } of flattenBalanceSheet(sheet)) {
    lines.push({ key: node.key, labelAr: node.label, amountMilli: node.amountMilli, depth });
    for (const a of node.accounts) lines.push({ key: `${node.key}:${a.code}`, labelAr: `${a.code} — ${a.name}`, amountMilli: a.amountMilli, depth: depth + 1 });
  }
  return {
    asOf: sheet.asOf, lines, assetsMilli: sheet.totalAssetsMilli, liabilitiesMilli: sheet.totalLiabilitiesMilli,
    equityMilli: sheet.totalEquityMilli, balanced: sheet.balanced,
  };
}

// ═══ الضريبة بالفترة والمربع ═══

const PERIOD_MONTHS: Readonly<Record<Exclude<TaxPeriodicity, 'FISCAL_YEAR'>, number>> = {
  MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOUR_MONTHS: 4, SEMIANNUAL: 6, ANNUAL: 12,
};
const PERIOD_LETTER: Readonly<Record<Exclude<TaxPeriodicity, 'FISCAL_YEAR' | 'MONTHLY' | 'ANNUAL'>, string>> = {
  BIMONTHLY: 'B', QUARTERLY: 'Q', FOUR_MONTHS: 'T', SEMIANNUAL: 'H',
};

/** فترة الإقرار التي يقع فيها التاريخ — تقويمية كـisVatPeriodStart في opening.ts، وFISCAL_YEAR بالسنة المالية */
export function vatPeriodOf(date: LocalDate, p: TaxPeriodicity, fyEnd: { month: number; day: number }): { key: string; from: LocalDate; to: LocalDate } {
  if (p === 'FISCAL_YEAR') {
    const y = fiscalYearOf(date, fyEnd.month, fyEnd.day);
    return { key: y.start.slice(0, 4), from: y.start, to: y.end };
  }
  const span = PERIOD_MONTHS[p];
  const { y, m } = parseLocalDate(date);
  const idx = Math.floor((m - 1) / span);
  const from = formatLocalDate(y, idx * span + 1, 1);
  const to = endOfMonth(addMonths(from, span - 1));
  const key = p === 'MONTHLY' ? monthKey(from) : p === 'ANNUAL' ? String(y) : `${y}-${PERIOD_LETTER[p]}${idx + 1}`;
  return { key, from, to };
}

export function vatByPeriodBox(shadow: ShadowState, ctx: LedgerContext, periodicity: TaxPeriodicity, fyEnd: { month: number; day: number }): VatPeriodBoxRow[] {
  const acc = new Map<string, VatPeriodBoxRow>();
  for (const m of shadow.moveList) {
    for (const l of m.lines) {
      if (l.taxRole !== 'TAX' && l.taxRole !== 'MARKER') continue;
      const tax = l.taxId ? ctx.taxById.get(l.taxId) ?? null : null;
      const box = l.vatBox ?? null;
      let taxMilli = box ? vatBoxLineTaxMilli(box, l.debitMilli, l.creditMilli) : null;
      if (taxMilli === null) taxMilli = tax?.use === 'PURCHASE' ? l.debitMilli - l.creditMilli : l.creditMilli - l.debitMilli;
      const p = vatPeriodOf(l.date, periodicity, fyEnd);
      const k = `${p.from}|${box ?? ''}`;
      let row = acc.get(k);
      if (!row) {
        row = { periodKey: p.key, from: p.from, to: p.to, box, baseMilli: 0n, taxMilli: 0n };
        acc.set(k, row);
      }
      row.baseMilli += l.taxBaseMilli ?? 0n;
      row.taxMilli += taxMilli;
    }
  }
  const boxNo = (b: string | null) => (b === null ? Number.MAX_SAFE_INTEGER : Number(b.replace(/\D/g, '')) || 0);
  return [...acc.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : boxNo(a.box) - boxNo(b.box) || ((a.box ?? '') < (b.box ?? '') ? -1 : 1)));
}

// ═══ القيد الافتتاحي ═══

export function openingPreview(
  draft: MoveDraft | null, result: OpeningMoveResult, ctx: LedgerContext,
  manualIssues: readonly (Pick<ManualBalanceIssue, 'index' | 'accountCode'> & { reason: string })[], cap: number, date?: LocalDate,
): OpeningPreview {
  const derivedCount = (result as OpeningMoveResult & { derivedLineCount?: number }).derivedLineCount ?? 0;
  const equityId = ctx.ctx.accounts.byKey('OPENING_EQUITY')?.id ?? null;
  const all: OpeningPreviewLine[] = [];
  let derivedNet = 0n;
  (draft?.lines ?? []).forEach((l, i, arr) => {
    const a = resolveLineAccount(l, ctx.ctx.accounts);
    const isEquity = result.equityDiffMilli !== 0n && i === arr.length - 1 && a?.id === equityId;
    const origin: OpeningPreviewLine['origin'] = i < derivedCount ? 'DERIVED' : isEquity ? 'EQUITY' : 'MANUAL';
    if (origin === 'DERIVED') derivedNet += l.debitMilli - l.creditMilli;
    let partnerType: OpeningPreviewLine['partnerType'] = null;
    let partnerId: string | null = null;
    if (l.customerId) { partnerType = 'CUSTOMER'; partnerId = l.customerId; }
    else if (l.vendorId) { partnerType = 'VENDOR'; partnerId = l.vendorId; }
    else if (a?.controlKind === 'INVENTORY') {
      partnerType = 'LOCATION';
      const isVan = a.id === ctx.ctx.accounts.byKey('INVENTORY_VAN')?.id;
      partnerId = isVan ? `VAN:${l.salesRepId ?? '_'}` : 'WH';
    } else if (l.salesRepId) { partnerType = 'REP'; partnerId = l.salesRepId; }
    all.push({
      accountCode: a?.code ?? l.accountCode ?? l.accountKey ?? '', accountName: a?.name ?? '', origin, partnerType, partnerId,
      partnerName: l.partnerName ?? null, label: l.label, debitMilli: l.debitMilli, creditMilli: l.creditMilli,
    });
  });
  const byAcc = new Map<string, { accountCode: string; accountName: string; debitMilli: Milli; creditMilli: Milli; lines: number }>();
  let debit = 0n;
  let credit = 0n;
  for (const l of all) {
    debit += l.debitMilli;
    credit += l.creditMilli;
    const g = byAcc.get(l.accountCode) ?? { accountCode: l.accountCode, accountName: l.accountName, debitMilli: 0n, creditMilli: 0n, lines: 0 };
    g.debitMilli += l.debitMilli;
    g.creditMilli += l.creditMilli;
    g.lines++;
    byAcc.set(l.accountCode, g);
  }
  return {
    date: draft?.date ?? date ?? '',
    lines: all.slice(0, Math.max(0, cap)),
    linesTruncated: Math.max(0, all.length - Math.max(0, cap)),
    byAccount: [...byAcc.values()].sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0)),
    totals: {
      debitMilli: debit, creditMilli: credit, derivedNetMilli: derivedNet,
      manualDebitMilli: result.manualDebitMilli, manualCreditMilli: result.manualCreditMilli, equityDiffMilli: result.equityDiffMilli,
    },
    manualIssues: manualIssues.map((x) => ({ index: x.index, accountCode: x.accountCode, reason: String(x.reason) }))
      .sort((a, b) => a.index - b.index || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
  };
}

// ═══ الأحداث ═══

/** سبب الحالة: skipReason لـSKIPPED، وسبب ملاحظة HELD/BLOCKED/PENDING، ورمز الخطأ لـERROR */
export function eventReason(e: { status: string; skipReason: string | null; lastError: string | null }): string | null {
  if (e.status === 'SKIPPED') return e.skipReason ?? null;
  if (e.status === 'DONE') return null;
  const n = decodeEventNote(e.lastError);
  if (!n) return null;
  if (n.kind === 'HELD' || n.kind === 'BLOCKED' || n.kind === 'PENDING') return n.reason;
  const m = /^(P\d{4}|LEDGER_[A-Z_]+)/.exec(n.message);
  return m ? m[1] : 'ERROR';
}

export function eventCounts(shadow: ShadowState): EventCountRow[] {
  const acc = new Map<string, EventCountRow>();
  for (const e of shadow.events.values()) {
    const reason = eventReason(e);
    const k = `${e.sourceType}|${e.event}|${e.status}|${reason ?? ''}`;
    const row = acc.get(k);
    if (row) row.count++;
    else acc.set(k, { sourceType: e.sourceType, event: e.event, status: e.status, reason, count: 1 });
  }
  // ترتيب بنقاط الترميز (لا localeCompare: يختلف بين إصدارات ICU فيتغيّر resultHash)
  const cmp = (x: string | null, y: string | null) => ((x ?? '') < (y ?? '') ? -1 : (x ?? '') > (y ?? '') ? 1 : 0);
  return [...acc.values()].sort((a, b) => cmp(a.sourceType, b.sourceType) || cmp(a.event, b.event) || cmp(a.status, b.status) || cmp(a.reason, b.reason));
}

const OPEN_STATUSES = new Set(['HELD', 'ERROR', 'BLOCKED', 'PENDING']);

function payloadAmountMilli(sourceType: string, p: Record<string, unknown> | null, decimals: number): Milli | null {
  if (!p) return null;
  const parse = (v: unknown): Milli | null => {
    if (v === null || v === undefined || v === '') return null;
    try { return toMilli(typeof v === 'number' ? v : String(v), decimals); } catch { return null; }
  };
  if (sourceType === 'INVOICE') return parse(p.total);
  if (sourceType === 'AR_ENTRY') {
    const d = parse(p.debit) ?? 0n;
    const c = parse(p.credit) ?? 0n;
    return d - c;
  }
  return parse(p.amount);
}

type PartnerRef = Pick<HeldLine, 'partnerType' | 'partnerId' | 'partnerName'>;
type Payload = Record<string, unknown> | null;

const payloadOf = (e: { payload: unknown }): Payload =>
  (e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : null);

/**
 * شركاء حدث من حمولته — **كلّهم** بترتيب العرض: الفاتورة والسند لعميلهما ثم مندوبهما (السند النقدي والفاتورة النقدية الموجّهان
 * إلى العهدة يمسّان 111003 بالمندوب — R3 — لا الذمم وحدها)، وصفّ الذمم لعميله، والاستلام لمندوبه.
 */
function partnersOfPayload(sourceType: string, p: Payload): PartnerRef[] {
  if (!p) return [];
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const out: PartnerRef[] = [];
  if ((sourceType === 'INVOICE' || sourceType === 'RECEIPT' || sourceType === 'AR_ENTRY') && str(p.customerId)) {
    out.push({ partnerType: 'CUSTOMER', partnerId: str(p.customerId), partnerName: str(p.customerName) });
  }
  if ((sourceType === 'INVOICE' || sourceType === 'RECEIPT' || sourceType === 'SETTLEMENT') && str(p.salesRepId)) {
    out.push({ partnerType: 'REP', partnerId: str(p.salesRepId), partnerName: str(p.salesRepName) });
  }
  return out;
}

/**
 * حمولة الحدث الأصلي لحدث عكسٍ (REVERSE وREPOST_REV): حمولة العكس في desired.ts بلا عميل ولا مندوب ولا مبلغ ({invoiceId،
 * type، entryDate…} و{receiptId، paymentMethod…}) — والعكس يُبطل أثر شقيقه POST نفسه، فشركاؤه شركاؤه ومبلغه سالبُ مبلغه.
 */
function siblingPostPayload(shadow: ShadowState, sourceKey: string): Payload {
  const k = siblingPostKey(sourceKey);
  if (!k) return null;
  const s = shadow.events.get(k);
  return s ? payloadOf(s) : null;
}

/** شركاء الحدث: من حمولته، وإلا (حدث عكسٍ بلا شريك) من حمولة شقيقه POST */
function eventPartners(shadow: ShadowState, e: { sourceKey: string; sourceType: string; event: string; payload: unknown }): PartnerRef[] {
  const own = partnersOfPayload(e.sourceType, payloadOf(e));
  if (own.length || e.event === 'POST') return own;
  return partnersOfPayload(e.sourceType, siblingPostPayload(shadow, e.sourceKey));
}

/**
 * مبلغ الحدث للعرض (موقَّعاً بأثره): مبلغ المستند من حمولته، والمرتجع سالب (دائنٌ للعميل)؛ وحدث العكس بلا مبلغ ⇒ سالب مبلغ شقيقه
 * POST الموقَّع (العكس يُبطله).
 */
function eventAmountMilli(shadow: ShadowState, e: { sourceKey: string; sourceType: string; event: string; payload: unknown }, dec: number): Milli | null {
  const signed = (p: Payload): Milli | null => {
    const a = payloadAmountMilli(e.sourceType, p, dec);
    return a !== null && e.sourceType === 'INVOICE' && p?.type === 'RETURN' ? -a : a;
  };
  const own = signed(payloadOf(e));
  if (own !== null || e.event === 'POST') return own;
  const sib = signed(siblingPostPayload(shadow, e.sourceKey));
  return sib === null ? null : -sib;
}

/** أحداث باقية بلا ترحيل (HELD/ERROR/BLOCKED/PENDING) وسطور القيود على المعلّق 911001 */
export function heldLines(shadow: ShadowState, cap: number): { lines: HeldLine[]; truncated: number } {
  const tz = shadow.posterSettings.timezone;
  const dec = shadow.posterSettings.snapshot.currencyDecimals;
  const out: HeldLine[] = [];
  const none: PartnerRef = { partnerType: null, partnerId: null, partnerName: null };
  for (const e of shadow.events.values()) {
    if (!OPEN_STATUSES.has(e.status)) continue;
    const note = decodeEventNote(e.lastError);
    const detail = !note ? null : note.kind === 'ERROR' ? note.message : note.kind === 'PENDING' ? null : note.detail ?? null;
    out.push({
      kind: 'EVENT', sourceKey: e.sourceKey, sourceType: e.sourceType, status: e.status, reason: eventReason(e),
      detail: detail ? detail.slice(0, 300) : null, effectDate: localDate(e.effectAt, tz),
      amountMilli: eventAmountMilli(shadow, e, dec), ...(eventPartners(shadow, e)[0] ?? none),
    });
  }
  const suspenseId = shadow.context.ctx.accounts.byKey('POSTING_SUSPENSE')?.id ?? null;
  if (suspenseId) {
    for (const l of shadow.linesOn(suspenseId)) {
      const m = shadow.moves.get(l.moveId)!;
      // سطر المعلّق بلا شريك غالباً (سند إلكتروني بلا رابط، زيادة استلام): شريكه شريك القيد (سطر الذمة أو العهدة فيه)
      const owner = l.customerId || l.salesRepId ? l
        : m.lines.find((x) => x.customerId) ?? m.lines.find((x) => x.salesRepId) ?? null;
      out.push({
        kind: 'SUSPENSE_LINE', sourceKey: m.sourceKey ?? m.number, sourceType: m.sourceType ?? 'MOVE', status: 'POSTED',
        reason: m.attentionReason, detail: l.label.slice(0, 300), effectDate: l.date, amountMilli: l.debitMilli - l.creditMilli,
        partnerType: owner?.customerId ? 'CUSTOMER' : owner?.salesRepId ? 'REP' : null,
        partnerId: owner?.customerId ?? owner?.salesRepId ?? null,
        partnerName: owner?.partnerName ?? null,
      });
    }
  }
  out.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'EVENT' ? -1 : 1)
    : (a.effectDate ?? '') < (b.effectDate ?? '') ? -1 : (a.effectDate ?? '') > (b.effectDate ?? '') ? 1
      : a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  const c = Math.max(0, cap);
  return { lines: out.slice(0, c), truncated: Math.max(0, out.length - c) };
}

/**
 * مفاتيح الأحداث المحجوزة لكل شريك (عميل **و**مندوب) — لملاحظة «يفسّره حدث محجوز» في المطابقة: R2 يسأل بالعميل وR3 بالمندوب،
 * فالفاتورة والسند يُفهرسان تحت كليهما، وحدث العكس (بلا شريك في حمولته) تحت شركاء شقيقه POST.
 */
export function heldByPartner(shadow: ShadowState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of shadow.events.values()) {
    if (!OPEN_STATUSES.has(e.status)) continue;
    for (const { partnerId } of eventPartners(shadow, e)) {
      if (!partnerId) continue;
      const list = out.get(partnerId);
      if (!list) out.set(partnerId, [e.sourceKey]);
      else if (!list.includes(e.sourceKey)) list.push(e.sourceKey);
    }
  }
  for (const v of out.values()) v.sort();
  return out;
}

// ═══ الوقت والتخزين ═══

export interface EtaStorageInput {
  /** أحداث ستُرحَّل في الترحيل التاريخي (DONE في الظلّ) */
  eventsToPost: number;
  events: number;
  moves: number;
  lines: number;
  moveSources: number;
  costSnapshots: number;
}

export function etaAndStorage(i: EtaStorageInput): { eta: PreviewEta; storage: PreviewStorage } {
  const ms = i.eventsToPost * CONSERVATIVE_MS_PER_EVENT;
  const eta: PreviewEta = {
    eventsToPost: i.eventsToPost,
    msPerEvent: CONSERVATIVE_MS_PER_EVENT,
    offPeakBudgetMsPerMin: BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN,
    peakBudgetMsPerMin: BACKFILL_PEAK_BUDGET_MS_PER_MIN,
    etaMinutesOffPeak: Math.ceil(ms / BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN),
    etaMinutesPeakOnly: Math.ceil(ms / BACKFILL_PEAK_BUDGET_MS_PER_MIN),
  };
  // سجلّ تدقيق واحد لكل قيد مرحَّل (postMove ⇒ appendAudit)
  const audits = i.moves;
  const glRows = i.events + i.moves + i.lines + i.moveSources + audits;
  const bytesEstimate = glRows * ROW_BYTES_ESTIMATE + i.costSnapshots * COST_SNAPSHOT_ROW_BYTES;
  const storage: PreviewStorage = {
    rows: { events: i.events, moves: i.moves, lines: i.lines, moveSources: i.moveSources, audits, costSnapshots: i.costSnapshots, total: glRows + i.costSnapshots },
    bytesEstimate,
    headroomNote: bytesEstimate > PREVIEW_HEADROOM_BYTES
      ? `حجم الدفاتر المتوقّع نحو ${Math.ceil(bytesEstimate / (1024 * 1024))} ميغابايت يتجاوز هامش قاعدة البيانات المخصّص لشركة واحدة (${PREVIEW_HEADROOM_BYTES / (1024 * 1024)} ميغابايت) — راجع سعة القاعدة قبل الاعتماد`
      : null,
  };
  return { eta, storage };
}

/** إحصاءات الظلّ لتقدير الوقت والتخزين ولـP13 */
export function shadowCounts(shadow: ShadowState): Omit<EtaStorageInput, 'costSnapshots'> & { byType: Record<string, number> } {
  let done = 0;
  const byType: Record<string, number> = {};
  for (const e of shadow.events.values()) {
    if (e.status !== 'DONE') continue;
    done++;
    byType[e.sourceType] = (byType[e.sourceType] ?? 0) + 1;
  }
  let lines = 0;
  for (const m of shadow.moveList) lines += m.lines.length;
  return { eventsToPost: done, events: shadow.events.size, moves: shadow.moveList.length, lines, moveSources: shadow.sources.size, byType };
}
