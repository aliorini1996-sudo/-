// «ربط الدفاتر» L5/L8 — A7: الفحوص (عقد L4+L5+L8 §5.8): C4u عهدة مستخدمي الشركة (أخضر/أحمر/أصفر)، وC16 الذمم المفتوحة
// مقابل متبقّي الفواتير (أخضر/أصفر بتعمّق الفاتورة)، والفحصان للمربوطة وحدها (القديمة واليدوية بلا تغيير في قائمة الفحوص)،
// وC4b بالنقدية المختومة (OD3)، ومؤشر USER_SETTLEMENT في C15 للمربوطة، ومخزن Prisma المزيّف للطرق الجديدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIdOf } from '../services/gl/testing/fixtures';
import type { CustodyComponentsInput } from '../services/gl/custody';
import {
  C16_INVOICE_DETAIL_LIMIT, evaluateC16, evaluateC4u, type C16InvoiceDetail, type UserCustodyFacts,
} from '../services/gl/checks/rules';
import {
  MANUAL_LEDGER_SKIPPED_CHECKS, loadC16Input, loadUserCustodyFacts, runChecks,
  type CheckSettingsFacts, type CheckStore, type PendingPartners,
} from '../services/gl/checks/run';
import { createPrismaCheckStore } from '../services/gl/checks/store.prisma';
import { CHECK_KEYS, CHECK_TITLES, LINKED_ONLY_CHECKS } from '../services/gl/checks/types';
import { foldUserCustody, type UserCustodyInputs } from '../services/userCustodyCore';
import type { Milli } from '../services/gl/types';
import type { PrismaClient } from '@prisma/client';

const at = (iso: string) => new Date(iso);
const AR = accountIdOf('113001');
const CUSTODY = accountIdOf('111003');
const USER_CUSTODY = 'acc-111004';

const userInputs = (userId: string, receivedCash: bigint, delivered: bigint): UserCustodyInputs => ({
  userId,
  received: receivedCash ? [{ id: `${userId}-r`, amountMilli: receivedCash, method: 'CASH', at: '2027-01-10T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z' }] : [],
  delivered: delivered ? [{ id: `${userId}-d`, amountMilli: delivered, method: 'CASH', at: '2027-01-11T08:00:00.000Z', createdAt: '2027-01-11T08:00:00.000Z' }] : [],
  refunds: [],
});

const facts = (userId: string, ledger: bigint, inputs: UserCustodyInputs, pending = false): UserCustodyFacts => ({
  userId, name: `مستخدم ${userId}`, ledgerMilli: ledger, fold: foldUserCustody(inputs), pending,
});

test('C4u: أخضر حين 111004 = الطيّ لكل مستخدم، وأحمر لانحرافٍ لا ينتظر ترحيلاً، وأصفر لمن له أحداث غير نهائية', () => {
  const green = evaluateC4u([facts('u1', 300_000n, userInputs('u1', 800_000n, 500_000n)), facts('u2', 0n, userInputs('u2', 0n, 0n))]);
  assert.equal(green.status, 'GREEN');
  assert.equal(green.title, 'عهدة مستخدمي الشركة');
  assert.equal(green.rows.length, 2, 'جدول العهدة لكل مستخدم');
  assert.equal(green.rows[0].matched, true);

  const red = evaluateC4u([facts('u1', 800_000n, userInputs('u1', 800_000n, 500_000n)), facts('u2', 0n, userInputs('u2', 0n, 0n))]);
  assert.equal(red.status, 'RED');
  assert.equal(red.rows[0].userId, 'u1', 'المختلف أولاً');
  assert.equal(red.rows[0].gapMilli, '500000');
  assert.equal(red.rows[0].expectedMilli, '300000', 'العهدة التشغيلية (الطيّ)');
  assert.equal(red.rows[0].adjustable, false, 'لا قيد تصحيح آلياً لـC4u');
  assert.equal(red.fix, null);
  assert.equal(red.metrics.mismatched, 1);

  const yellow = evaluateC4u([facts('u1', 0n, userInputs('u1', 800_000n, 0n), true)]);
  assert.equal(yellow.status, 'YELLOW');
  assert.equal(yellow.fix, 'SYNC_NOW');
});

test('C16: أخضر حين Σ الذمم المفتوحة = Σ متبقّي الفواتير لكل عميل، وأصفر بتعمّق العميل والفاتورة (حتى ٥٠)', () => {
  const base = { names: new Map([['c1', 'عميل ١']]), pendingCustomers: new Set<string>(), pendingAll: false, invoices: [] as C16InvoiceDetail[] };
  const g = evaluateC16({ ...base, ledgerOpen: new Map([['c1', 550_000n]]), opsRemaining: new Map([['c1', 550_000n]]) });
  assert.equal(g.status, 'GREEN');
  assert.equal(g.title, 'الذمم المفتوحة مقابل متبقّي الفواتير');

  const invoices: C16InvoiceDetail[] = Array.from({ length: 60 }, (_, i) => ({
    invoiceId: `i${i}`, number: `INV-${i}`, customerId: 'c1', invoiceDate: '2027-01-01', remainingMilli: 10_000n, ledgerOpenMilli: 0n,
  }));
  const y = evaluateC16({ ...base, ledgerOpen: new Map([['c1', 550_000n], ['c2', 1_000n]]), opsRemaining: new Map([['c1', 600_000n]]), invoices });
  assert.equal(y.status, 'YELLOW', 'أصفر لا أحمر');
  const customers = y.rows.filter((r) => r.kind === 'CUSTOMER');
  assert.deepEqual(customers.map((r) => [r.customerId, r.gapMilli]), [['c1', '-50000'], ['c2', '1000']]);
  assert.equal(y.rows.filter((r) => r.kind === 'INVOICE').length, C16_INVOICE_DETAIL_LIMIT);
  assert.equal(y.fix, null);
  const pendingOnly = evaluateC16({ ...base, pendingAll: true, ledgerOpen: new Map([['c1', 1n]]), opsRemaining: new Map() });
  assert.equal(pendingOnly.fix, 'SYNC_NOW');
});

test('مفاتيح الفحوص: C4u بعد C4b وC16 آخراً، وعناوينهما، والفحصان في قائمة اليدوية والمربوطة وحدها', () => {
  assert.deepEqual([...CHECK_KEYS], ['C1', 'C2', 'C3', 'C4', 'C4b', 'C4u', 'C5', 'C8', 'C9', 'C10', 'C11', 'C12', 'C14', 'C15', 'C16']);
  assert.equal(CHECK_TITLES.C4u, 'عهدة مستخدمي الشركة');
  assert.deepEqual([...LINKED_ONLY_CHECKS], ['C4u', 'C16']);
  for (const k of LINKED_ONLY_CHECKS) assert.ok(MANUAL_LEDGER_SKIPPED_CHECKS.includes(k));
});

// ═══ runChecks فوق مخزن مزيّف ═══

class Store implements CheckStore {
  settings: CheckSettingsFacts = {
    activatedAt: at('2027-02-01T10:10:00.000Z'), backfillState: 'DONE', setupMethod: null, cutoverDate: '2027-01-01',
    openingSnapshotAt: at('2027-02-01T10:00:00.000Z'), timezone: 'Asia/Riyadh', currencyDecimals: 2, lastSyncAt: at('2027-03-10T11:59:00.000Z'),
    inventoryMode: 'PERIODIC', lockDates: { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null }, linked: true,
  };
  userLedger = new Map<string, Milli>([['u1', 300_000n]]);
  users = new Map<string, UserCustodyInputs>([['u1', userInputs('u1', 800_000n, 500_000n)]]);
  ledgerOpen = new Map<string, Milli>([['c1', 550_000n]]);
  remaining = new Map<string, Milli>([['c1', 550_000n]]);
  pendingSeen: ({ linked?: boolean } | undefined)[] = [];
  openItemsCalls = 0;
  requiredSeen: string[] = [];
  async dbNow() { return at('2027-03-10T12:00:00.000Z'); }
  async loadSettings() { return this.settings; }
  async unbalancedMoves() { return []; }
  async periodLineTotals() { return []; }
  async storedPeriodBalances() { return []; }
  async controlAccounts() {
    return [{ id: AR, code: '113001', controlKind: 'AR' }, { id: CUSTODY, code: '111003', controlKind: 'CUSTODY' }, { id: USER_CUSTODY, code: '111004', controlKind: 'CUSTODY' }];
  }
  async mappedAccounts() { return []; }
  async ledgerByPartner(_t: string, ids: readonly string[], partner: 'customerId' | 'salesRepId' | 'adminUserId') {
    assert.ok(ids.includes(USER_CUSTODY) || partner !== 'adminUserId');
    return partner === 'adminUserId' ? this.userLedger : new Map<string, Milli>();
  }
  async ledgerTotal() { return 0n; }
  async accountEntryTotals() { return new Map<string, Milli>(); }
  async deletedOpeningImports() { return new Map<string, Milli>(); }
  async customerNames(_t: string, ids: readonly string[]) { return new Map(ids.map((i) => [i, `عميل ${i}`])); }
  async salesReps() { return []; }
  async custodyInputs(): Promise<CustodyComponentsInput> { return { receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' } }; }
  async repCollections() { return new Map<string, Milli>(); }
  async settlementBalance() { return 0n; }
  async paylinkExplanations() { return { refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] }; }
  async pendingPartners(_t: string, _since: Date | null, opts?: { linked?: boolean }): Promise<PendingPartners> {
    this.pendingSeen.push(opts);
    return { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false, userIds: new Set() };
  }
  async problemEvents() { return []; }
  async cursorStates() {
    return ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'USER_SETTLEMENT'].map((source) => ({
      source, watermarkAt: at('2027-03-10T11:40:00.000Z'), lastRunAt: at('2027-03-10T11:59:00.000Z'), lastCount: 0, stallTicks: 0, lagMs: 0,
    }));
  }
  async attentionMovesOn() { return []; }
  async draftsUpTo() { return { count: 0, drafts: [] }; }
  async taxes() { return []; }
  async sequences() { return []; }
  async postedMoveNumbers() { return []; }
  async erpOdooActive() { return false; }
  async userCustodyInputs() { return this.users; }
  async adminNames(_t: string, ids: readonly string[]) { return new Map(ids.map((i) => [i, `مستخدم ${i}`])); }
  async openArByCustomer() { return this.ledgerOpen; }
  async invoiceRemainingByCustomer() { return this.remaining; }
  async invoiceOpenItems(_t: string, ids: readonly string[]) {
    this.openItemsCalls++;
    return ids.map((c) => ({ invoiceId: `inv-${c}`, number: 'INV', customerId: c, invoiceDate: '2027-01-01', remainingMilli: 600_000n, ledgerOpenMilli: 550_000n }));
  }
}

test('runChecks: المربوطة تشمل C4u وC16 (أخضرين) ومؤشر USER_SETTLEMENT في C15، والقديمة واليدوية بلا الفحصين', async () => {
  const s = new Store();
  const r = await runChecks(s, 't1');
  const keys = r.results.map((x) => x.key);
  assert.deepEqual(keys, ['C1', 'C2', 'C3', 'C4', 'C4b', 'C4u', 'C5', 'C8', 'C9', 'C10', 'C11', 'C12', 'C14', 'C15', 'C16']);
  assert.equal(r.results.find((x) => x.key === 'C4u')!.status, 'GREEN');
  assert.equal(r.results.find((x) => x.key === 'C16')!.status, 'GREEN');
  assert.equal(s.openItemsCalls, 0, 'لا تعمّق بالفاتورة بلا فرق');
  const c15 = r.results.find((x) => x.key === 'C15')!;
  assert.ok(c15.rows.some((row) => row.source === 'USER_SETTLEMENT'), 'مؤشر توريد المستخدم مطلوب للمربوطة');
  assert.deepEqual(s.pendingSeen[0], { linked: true });

  const legacy = new Store();
  legacy.settings = { ...legacy.settings, setupMethod: 'OPENING', linked: undefined };
  const lk = (await runChecks(legacy, 't1')).results.map((x) => x.key);
  assert.deepEqual(lk, ['C1', 'C2', 'C3', 'C4', 'C4b', 'C5', 'C8', 'C9', 'C10', 'C11', 'C12', 'C14', 'C15'], 'القديمة كما كانت');
  const lc15 = (await runChecks(legacy, 't1', { only: ['C15'] })).results[0];
  assert.ok(!lc15.rows.some((row) => row.source === 'USER_SETTLEMENT'));
  assert.equal(legacy.pendingSeen[0], undefined, 'pendingPartners بلا خيار للقديمة');

  const manual = new Store();
  manual.settings = { ...manual.settings, setupMethod: 'CLEAN', linked: false };
  const mk = (await runChecks(manual, 't1')).results.map((x) => x.key);
  for (const k of ['C3', 'C4', 'C4b', 'C4u', 'C5', 'C8', 'C14', 'C15', 'C16']) assert.ok(!mk.includes(k as never), k);

  // only=['C4u'] وحده يقرأ الحسابات والمعلّق بنفسه
  const only = await runChecks(new Store(), 't1', { only: ['C4u'] });
  assert.deepEqual(only.results.map((x) => x.key), ['C4u']);
});

test('runChecks: انحراف 111004 أحمر في C4u، وفرق الذمم المفتوحة أصفر في C16 بتعمّق الفاتورة', async () => {
  const s = new Store();
  s.userLedger = new Map([['u1', 800_000n]]);
  s.remaining = new Map([['c1', 600_000n]]);
  const r = await runChecks(s, 't1');
  const c4u = r.results.find((x) => x.key === 'C4u')!;
  assert.equal(c4u.status, 'RED');
  assert.equal(c4u.rows[0].name, 'مستخدم u1');
  const c16 = r.results.find((x) => x.key === 'C16')!;
  assert.equal(c16.status, 'YELLOW');
  assert.equal(s.openItemsCalls, 1);
  assert.deepEqual(c16.rows.map((x) => x.kind), ['CUSTOMER', 'INVOICE']);
  assert.equal(c16.rows[0].name, 'عميل c1');
  assert.equal(r.overall, 'RED');
});

test('loadUserCustodyFacts: المستخدمون = من له سطور 111004 أو تاريخ عهدة، والمعلّق من userIds، وonlyUserId', async () => {
  const s = new Store();
  s.userLedger = new Map([['u1', 300_000n], ['u3', 10_000n]]);
  const pending: PendingPartners = { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false, userIds: new Set(['u3']) };
  const f = await loadUserCustodyFacts(s, 't1', s.settings, pending);
  assert.deepEqual(f.map((x) => [x.userId, x.ledgerMilli, x.fold.outstandingMilli, x.pending]), [['u1', 300_000n, 300_000n, false], ['u3', 10_000n, 0n, true]]);
  assert.equal(evaluateC4u(f).status, 'YELLOW', 'انحراف u3 ينتظر ترحيلاً');
  const one = await loadUserCustodyFacts(s, 't1', s.settings, pending, undefined, 'u1');
  assert.deepEqual(one.map((x) => x.userId), ['u1']);
  const c16 = await loadC16Input(s, 't1', s.settings, pending);
  assert.deepEqual(c16.invoices, []);
});

// ═══ مخزن Prisma المزيّف: الطرق الجديدة والمعدّلة ═══

function prismaFake(seen: Record<string, unknown[]>) {
  const push = (k: string, v: unknown) => { (seen[k] ??= []).push(v); };
  return {
    glSettings: {
      findUnique: async () => ({
        activatedAt: at('2027-02-01T10:10:00Z'), backfillState: 'DONE', setupMethod: 'LINKED', cutoverDate: at('2027-01-01T00:00:00Z'),
        openingSnapshotAt: at('2027-02-01T10:00:00Z'), timezone: 'Asia/Riyadh', currencyDecimals: 2, lastSyncAt: null, inventoryMode: 'PERIODIC',
        salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null,
      }),
    },
    glMoveLine: {
      groupBy: async (a: { by: string[] }) => {
        push('glMoveLine.groupBy', a);
        return a.by[0] === 'adminUserId'
          ? [{ adminUserId: 'u1', _sum: { debitMilli: 800_000n, creditMilli: 500_000n } }, { adminUserId: null, _sum: { debitMilli: 1n, creditMilli: 0n } }]
          : [];
      },
    },
    receipt: { groupBy: async () => [{ salesRepId: 'rep1', _sum: { amount: 500 } }] },
    repSettlement: {
      groupBy: async () => [{ salesRepId: 'rep1', _sum: { amount: 700 } }],
      findMany: async (a: { where: Record<string, unknown> }) => {
        push('repSettlement.findMany', a.where);
        return 'receivedByUserId' in a.where ? [{ receivedByUserId: 'u7' }] : [];
      },
    },
    invoice: {
      groupBy: async (a: unknown) => { push('invoice.groupBy', a); return [{ salesRepId: 'rep1', _sum: { paidAmt: 115 } }]; },
      findMany: async () => [],
    },
    userSettlement: { findMany: async () => [{ fromUserId: 'u8' }] },
    glSourceEvent: {
      findMany: async () => [
        { sourceType: 'USER_SETTLEMENT', sourceId: 'us1', event: 'POST', payload: { fromUserId: 'u5' } },
        { sourceType: 'SETTLEMENT', sourceId: 's1', event: 'POST', payload: { salesRepId: 'rep1', receivedByUserId: 'u6' } },
        { sourceType: 'PAYLINK_REFUND', sourceId: 'se1', event: 'POST', payload: { customerId: 'c1' } },
      ],
    },
    accountEntry: { findMany: async () => [] },
    settlementEntry: { count: async () => 0 },
    $queryRaw: async (q: unknown) => {
      const text = Array.isArray(q) ? (q as string[]).join('?') : (q as { strings: string[] }).strings.join('?');
      push('$queryRaw', text);
      if (text.includes('GROUP BY i."customerId"')) return [{ customerId: 'c1', total: '600.00' }, { customerId: 'c2', total: '0.00' }];
      return [{ invoiceId: 'i1', number: 'INV-1', customerId: 'c1', invoiceDate: at('2026-12-31T22:00:00Z'), remaining: '600.00', ledgerOpen: 550000n }];
    },
  } as unknown as PrismaClient;
}

test('مخزن Prisma: linked في الإعدادات، و111004 ببُعد المستخدم، وC4b بالنقدية المختومة، والمعلّق للمستخدمين، ومجاميع C16', async () => {
  const seen: Record<string, unknown[]> = {};
  const store = createPrismaCheckStore(prismaFake(seen));
  const s = (await store.loadSettings('t1'))!;
  assert.equal(s.linked, true);
  assert.equal(s.setupMethod, null, 'سطر الطريقة كما هو (L0 يعدّله)');

  const users = await store.ledgerByPartner('t1', [USER_CUSTODY], 'adminUserId');
  assert.deepEqual([...users], [['u1', 300_000n]]);

  // ops = السندات 500 + النقدية المختومة 115 − الاستلامات 700 (شاشة collection-balance)
  const ops = await store.repCollections('t1', 2);
  assert.equal(ops.get('rep1'), -85_000n);
  assert.ok(JSON.stringify(seen['invoice.groupBy'][0]).includes('cashCollectedByRep'), 'REP_COLLECTED_CASH_SALE');

  const p = await store.pendingPartners('t1', at('2027-03-10T11:58:00Z'), { linked: true });
  assert.deepEqual([...(p.userIds ?? [])].sort(), ['u5', 'u6', 'u7', 'u8']);
  assert.equal(p.settlement, true, 'PAYLINK_REFUND يمسّ الأمانات');
  const legacy = await store.pendingPartners('t1', at('2027-03-10T11:58:00Z'));
  assert.equal(legacy.userIds, undefined, 'بلا خيار: كما كان');

  const rem = await store.invoiceRemainingByCustomer!('t1', 2);
  assert.deepEqual([...rem], [['c1', 600_000n]]);
  assert.ok(String(seen.$queryRaw[0]).includes('ROUND(i."remainingAmt"::numeric'), 'تقريب كل فاتورة في SQL');
  const items = await store.invoiceOpenItems!('t1', ['c1'], 2, 50, 'Asia/Riyadh');
  assert.deepEqual(items, [{ invoiceId: 'i1', number: 'INV-1', customerId: 'c1', invoiceDate: '2027-01-01', remainingMilli: 600_000n, ledgerOpenMilli: 550_000n }]);
  assert.deepEqual(await store.invoiceOpenItems!('t1', [], 2, 50), []);
});

test('C4b: بند الردّ من خارج العهدة يظهر في الصف حين يوجد وحده (صفوف القديمة بلا مفتاح جديد)، وأعمدة C16 بمفاتيح الجدول القائمة', async () => {
  const { evaluateC4b } = await import('../services/gl/checks/rules');
  const { custodyComponentsForRep } = await import('../services/gl/custody');
  const empty: CustodyComponentsInput = { receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' } };
  const c0 = custodyComponentsForRep(empty, 'rep1');
  const row0 = evaluateC4b([{ salesRepId: 'rep1', name: 'م', isActive: true, ledgerMilli: 0n, components: c0, opsOutstandingMilli: 0n, pending: false }]).rows[0];
  assert.ok(!('cancelRefundOutsideMilli' in row0));
  const c1 = { ...c0, cancelRefundOutside: 500_000n };
  const r1 = evaluateC4b([{ salesRepId: 'rep1', name: 'م', isActive: true, ledgerMilli: 0n, components: c1, opsOutstandingMilli: -500_000n, pending: false }]);
  assert.equal(r1.rows[0].cancelRefundOutsideMilli, '500000');
  assert.equal(r1.status, 'GREEN', 'E5.7: ops −500 = الأستاذ 0 − الردّ من خارج العهدة 500');
  const c16 = evaluateC16({
    ledgerOpen: new Map([['c1', 1n]]), opsRemaining: new Map(), names: new Map(), pendingCustomers: new Set(), pendingAll: false,
    invoices: [{ invoiceId: 'i1', number: 'N', customerId: 'c1', invoiceDate: '2027-01-01', remainingMilli: 0n, ledgerOpenMilli: 1n }],
  });
  assert.deepEqual(Object.keys(c16.rows[1]).sort(), ['customerId', 'date', 'expectedMilli', 'gapMilli', 'invoiceId', 'kind', 'ledgerMilli', 'number'].sort());
});
