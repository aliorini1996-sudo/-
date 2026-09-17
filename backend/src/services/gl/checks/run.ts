/**
 * تشغيل فحوصات السلامة (M3، DESIGN.md §5.9) فوق مخزن قراءة (CheckStore).
 *
 * لا يستورد prisma: التنفيذ الفعلي في checks/store.prisma.ts، والاختبارات بمخزن مزيّف أو بالقواعد الصرفة مباشرة.
 * يعمل عند الطلب (`POST /api/ledger/checks/run`) وتحت قفل gl-post لحساب انحراف قيد التصحيح (`control-adjustment`).
 */
import { custodyComponentsForRep, type CustodyComponentsInput } from '../custody';
import { zonedStartOfDay } from '../dates';
import { activeSyncSources, type LockDates } from '../locks';
import { cutoverContextOf } from '../sync/poster';
import type { BackfillState, InventoryMode, LocalDate, Milli } from '../types';
import {
  evaluateC1, evaluateC10, evaluateC11, evaluateC12, evaluateC14, evaluateC15, evaluateC2, evaluateC3, evaluateC4, evaluateC4b,
  evaluateC5, evaluateC8, evaluateC9,
  type C3Input, type C5Input, type CursorFacts, type PeriodTotal, type ProblemEvent, type RepCustodyFacts, type SequenceFacts,
  type SuspenseAccountFacts, type UnbalancedMove,
} from './rules';
import { CHECK_KEYS, worstStatus, type CheckKey, type CheckResult, type ChecksReport } from './types';

// ═══ الحقائق ═══

export interface CheckSettingsFacts {
  activatedAt: Date | null;
  backfillState: BackfillState;
  setupMethod: 'OPENING' | 'FULL_HISTORY' | null;
  cutoverDate: LocalDate | null;
  openingSnapshotAt: Date | null;
  timezone: string;
  currencyDecimals: number;
  lastSyncAt: Date | null;
  inventoryMode: InventoryMode;
  lockDates: LockDates;
}

export interface ControlAccountFacts { id: string; code: string; controlKind: string }

/** الشركاء الذين لهم أحداث غير نهائية أو صفوف مصدر لم تلحق بها نبضة */
export interface PendingPartners {
  customerIds: Set<string>;
  salesRepIds: Set<string>;
  /** أثر على الأمانات (PAYLINK_FEE/PAYOUT/سند ONLINE أو صف SettlementEntry حديث) */
  settlement: boolean;
  /** حدث بلا شريك معروف (حمولة غائبة) أو لا نبضة بعد ⇒ كل انحراف أصفر */
  unknown: boolean;
}

export interface CheckStore {
  dbNow(): Promise<Date>;
  loadSettings(tenantId: string): Promise<CheckSettingsFacts | null>;

  // C1/C2
  unbalancedMoves(tenantId: string, limit: number): Promise<UnbalancedMove[]>;
  periodLineTotals(tenantId: string): Promise<PeriodTotal[]>;
  storedPeriodBalances(tenantId: string): Promise<PeriodTotal[]>;

  // الحسابات
  controlAccounts(tenantId: string): Promise<ControlAccountFacts[]>;
  mappedAccounts(tenantId: string, keys: readonly string[]): Promise<{ key: string; id: string; code: string }[]>;
  /** Σ(مدين − دائن) للسطور المرحّلة على الحسابات مجمّعة بالشريك؛ moveType اختياري (OPENING) */
  ledgerByPartner(tenantId: string, accountIds: readonly string[], partner: 'customerId' | 'salesRepId', opts?: { moveType?: string }): Promise<Map<string, Milli>>;
  ledgerTotal(tenantId: string, accountIds: readonly string[]): Promise<Milli>;

  // C3
  /** Σ(مدين − دائن) لصفوف AccountEntry لكل عميل، مستبعَداً منها المشمول بالافتتاح (entryDate < cutoverStart و createdAt ≤ T0) */
  accountEntryTotals(tenantId: string, excludeOpening: { cutoverStart: Date; openingSnapshotAt: Date } | null, decimals: number): Promise<Map<string, Milli>>;
  /** صفوف استيراد مشمولة بالافتتاح تُراجع عنها: حمولة AR_ENTRY:<id>:REVERSE وشقيقها POST = SKIPPED(OPENING) */
  deletedOpeningImports(tenantId: string, decimals: number): Promise<Map<string, Milli>>;
  customerNames(tenantId: string, ids: readonly string[]): Promise<Map<string, string>>;

  // C4/C4b
  salesReps(tenantId: string): Promise<{ id: string; name: string; isActive: boolean }[]>;
  custodyInputs(tenantId: string, salesRepId: string): Promise<CustodyComponentsInput>;
  repCollections(tenantId: string, decimals: number): Promise<Map<string, Milli>>;

  // C5
  settlementBalance(tenantId: string, decimals: number): Promise<Milli>;
  paylinkExplanations(tenantId: string, decimals: number): Promise<Pick<C5Input, 'refundedLinksWithoutRefund' | 'cancelledOnlineWithoutRefund'>>;

  // المزامنة
  pendingPartners(tenantId: string, since: Date | null): Promise<PendingPartners>;
  problemEvents(tenantId: string, limit: number): Promise<ProblemEvent[]>;
  cursorStates(tenantId: string, dbNow: Date): Promise<CursorFacts[]>;

  // C9–C14
  attentionMovesOn(tenantId: string, accountId: string, limit: number): Promise<SuspenseAccountFacts['attentionMoves']>;
  draftsUpTo(tenantId: string, date: LocalDate, limit: number): Promise<{ count: number; drafts: { id: string; date: LocalDate; ref: string | null }[] }>;
  taxes(tenantId: string): Promise<{ id: string; key: string | null; name: string; rate: number; vatBox: string | null }[]>;
  sequences(tenantId: string): Promise<SequenceFacts[]>;
  postedMoveNumbers(tenantId: string): Promise<{ journalId: string; number: string }[]>;
  erpOdooActive(tenantId: string): Promise<boolean>;
}

/** صفوف المصدر بعد (آخر نبضة − هامش) تُعدّ لم تلحق بها نبضة */
export const RECENT_ROWS_MARGIN_MS = 60_000;

export const MAX_PROBLEM_EVENTS = 500;

export interface RunChecksOptions {
  only?: readonly CheckKey[];
  now?: Date;
}

const DETAIL_LIMIT = 50;

function latestLockDate(l: LockDates): LocalDate | null {
  const vals = [l.salesLockDate, l.purchaseLockDate, l.taxLockDate, l.hardLockDate].filter((v): v is LocalDate => !!v);
  return vals.length ? vals.sort()[vals.length - 1] : null;
}

function idsOf(accounts: readonly ControlAccountFacts[], kind: string): string[] {
  return accounts.filter((a) => a.controlKind === kind).map((a) => a.id);
}

export async function loadPendingPartners(store: CheckStore, tenantId: string, s: CheckSettingsFacts): Promise<PendingPartners> {
  const since = s.lastSyncAt ? new Date(s.lastSyncAt.getTime() - RECENT_ROWS_MARGIN_MS) : null;
  const p = await store.pendingPartners(tenantId, since);
  if (!s.lastSyncAt) p.unknown = true;
  return p;
}

/** حقائق C3 (مع الانحراف لكل عميل) */
export async function loadC3Input(store: CheckStore, tenantId: string, s: CheckSettingsFacts, pending: PendingPartners, accounts?: ControlAccountFacts[]): Promise<C3Input> {
  const acc = accounts ?? await store.controlAccounts(tenantId);
  const ar = idsOf(acc, 'AR');
  const cut = cutoverContextOf({ setupMethod: s.setupMethod, cutoverDate: s.cutoverDate, openingSnapshotAt: s.openingSnapshotAt, timezone: s.timezone });
  const exclude = s.cutoverDate && s.openingSnapshotAt
    ? { cutoverStart: zonedStartOfDay(cut.cutoverDate, cut.timezone), openingSnapshotAt: cut.openingSnapshotAt }
    : null;
  const [ledger, opening, entriesAfterCutover, deletedOpeningImports] = await Promise.all([
    ar.length ? store.ledgerByPartner(tenantId, ar, 'customerId') : Promise.resolve(new Map<string, Milli>()),
    ar.length ? store.ledgerByPartner(tenantId, ar, 'customerId', { moveType: 'OPENING' }) : Promise.resolve(new Map<string, Milli>()),
    store.accountEntryTotals(tenantId, exclude, s.currencyDecimals),
    exclude ? store.deletedOpeningImports(tenantId, s.currencyDecimals) : Promise.resolve(new Map<string, Milli>()),
  ]);
  const ids = new Set<string>([...ledger.keys(), ...entriesAfterCutover.keys()]);
  const names = await store.customerNames(tenantId, [...ids]);
  return {
    ledger, opening, entriesAfterCutover, deletedOpeningImports, names,
    pendingCustomers: pending.customerIds, pendingAll: pending.unknown,
  };
}

/** حقائق C4/C4b لكل مندوب له أثر (أو مندوب مسجّل) */
export async function loadRepCustodyFacts(store: CheckStore, tenantId: string, s: CheckSettingsFacts, pending: PendingPartners, accounts?: ControlAccountFacts[], onlyRepId?: string): Promise<RepCustodyFacts[]> {
  const acc = accounts ?? await store.controlAccounts(tenantId);
  const custody = idsOf(acc, 'CUSTODY');
  const [reps, ledger, ops] = await Promise.all([
    store.salesReps(tenantId),
    custody.length ? store.ledgerByPartner(tenantId, custody, 'salesRepId') : Promise.resolve(new Map<string, Milli>()),
    store.repCollections(tenantId, s.currencyDecimals),
  ]);
  const byId = new Map(reps.map((r) => [r.id, r]));
  const ids = new Set<string>([...reps.map((r) => r.id), ...[...ledger.keys()]]);
  const out: RepCustodyFacts[] = [];
  for (const id of ids) {
    if (onlyRepId && id !== onlyRepId) continue;
    const inputs = await store.custodyInputs(tenantId, id);
    const components = custodyComponentsForRep(inputs, id);
    const rep = byId.get(id);
    out.push({
      salesRepId: id, name: rep?.name ?? null, isActive: rep?.isActive ?? false, ledgerMilli: ledger.get(id) ?? 0n,
      components, opsOutstandingMilli: ops.get(id) ?? 0n, pending: pending.unknown || pending.salesRepIds.has(id),
    });
  }
  return out.sort((a, b) => (a.name ?? a.salesRepId).localeCompare(b.name ?? b.salesRepId, 'ar'));
}

export async function loadC5Input(store: CheckStore, tenantId: string, s: CheckSettingsFacts, pending: PendingPartners, accounts?: ControlAccountFacts[]): Promise<C5Input> {
  const acc = accounts ?? await store.controlAccounts(tenantId);
  const paylink = idsOf(acc, 'PAYLINK');
  const [ledgerMilli, settlementBalanceMilli, explanations] = await Promise.all([
    paylink.length ? store.ledgerTotal(tenantId, paylink) : Promise.resolve(0n),
    store.settlementBalance(tenantId, s.currencyDecimals),
    store.paylinkExplanations(tenantId, s.currencyDecimals),
  ]);
  return { ledgerMilli, settlementBalanceMilli, pending: pending.unknown || pending.settlement, ...explanations };
}

/**
 * يشغّل الفحوصات (كلها أو `only`). شركة غير مفعّلة ⇒ تقرير بلا نتائج (overall GREEN) — الفحوص تفترض activatedAt.
 */
export async function runChecks(store: CheckStore, tenantId: string, opts: RunChecksOptions = {}): Promise<ChecksReport> {
  const started = Date.now();
  const now = opts.now ?? await store.dbNow();
  const s = await store.loadSettings(tenantId);
  const want = new Set<CheckKey>(opts.only ?? CHECK_KEYS);
  const results: CheckResult[] = [];
  if (!s || !s.activatedAt) {
    return { tenantId, ranAt: now.toISOString(), durationMs: Date.now() - started, overall: 'GREEN', results };
  }
  const needAccounts = ['C3', 'C4', 'C4b', 'C5'].some((k) => want.has(k as CheckKey));
  const accounts = needAccounts ? await store.controlAccounts(tenantId) : [];
  const pending = ['C3', 'C4', 'C5'].some((k) => want.has(k as CheckKey))
    ? await loadPendingPartners(store, tenantId, s)
    : { customerIds: new Set<string>(), salesRepIds: new Set<string>(), settlement: false, unknown: false };

  if (want.has('C1')) results.push(evaluateC1(await store.unbalancedMoves(tenantId, 500)));
  if (want.has('C2')) {
    const [ledger, stored] = await Promise.all([store.periodLineTotals(tenantId), store.storedPeriodBalances(tenantId)]);
    results.push(evaluateC2(ledger, stored));
  }
  if (want.has('C3')) results.push(evaluateC3(await loadC3Input(store, tenantId, s, pending, accounts)));
  if (want.has('C4') || want.has('C4b')) {
    const reps = await loadRepCustodyFacts(store, tenantId, s, pending, accounts);
    if (want.has('C4')) results.push(evaluateC4(reps));
    if (want.has('C4b')) results.push(evaluateC4b(reps));
  }
  if (want.has('C5')) results.push(evaluateC5(await loadC5Input(store, tenantId, s, pending, accounts)));
  if (want.has('C8')) results.push(evaluateC8(await store.problemEvents(tenantId, MAX_PROBLEM_EVENTS), now));
  if (want.has('C9')) {
    const mapped = await store.mappedAccounts(tenantId, ['POSTING_SUSPENSE', 'BANK_SUSPENSE']);
    const facts: SuspenseAccountFacts[] = [];
    for (const key of ['POSTING_SUSPENSE', 'BANK_SUSPENSE'] as const) {
      const a = mapped.find((m) => m.key === key);
      if (!a) { facts.push({ key, accountId: null, accountCode: null, balanceMilli: 0n, attentionMoves: [] }); continue; }
      const balanceMilli = await store.ledgerTotal(tenantId, [a.id]);
      const attentionMoves = balanceMilli !== 0n ? await store.attentionMovesOn(tenantId, a.id, DETAIL_LIMIT) : [];
      facts.push({ key, accountId: a.id, accountCode: a.code, balanceMilli, attentionMoves });
    }
    results.push(evaluateC9(facts));
  }
  if (want.has('C10')) {
    const lockDate = latestLockDate(s.lockDates);
    const d = lockDate ? await store.draftsUpTo(tenantId, lockDate, DETAIL_LIMIT) : { count: 0, drafts: [] };
    results.push(evaluateC10({ lockDate, ...d }));
  }
  if (want.has('C11')) results.push(evaluateC11(await store.taxes(tenantId)));
  if (want.has('C12')) {
    const [sequences, moves] = await Promise.all([store.sequences(tenantId), store.postedMoveNumbers(tenantId)]);
    results.push(evaluateC12(sequences, moves));
  }
  if (want.has('C14')) results.push(evaluateC14({ erpOdooActive: await store.erpOdooActive(tenantId) }));
  if (want.has('C15')) {
    results.push(evaluateC15({
      backfillState: s.backfillState,
      cursors: await store.cursorStates(tenantId, now),
      // المُطابِق في M3 يقرأ المصادر الثلاثة؛ مصادر المخزون تُضاف في M9
      requiredSources: activeSyncSources('PERIODIC'),
    }));
  }
  const order = new Map(CHECK_KEYS.map((k, i) => [k, i]));
  results.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return {
    tenantId, ranAt: now.toISOString(), durationMs: Date.now() - started,
    overall: worstStatus(results.map((r) => r.status)), results,
  };
}
