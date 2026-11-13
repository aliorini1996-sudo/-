// «ربط الدفاتر» L0 (وكيل B1) — الاختبار الذهبي للدفاتر اليدوية (CLEAN): النبضة تعيد MANUAL_LEDGER بلا أي كتابة في gl_*
// (ولا قفل ولا عقد ولا lastSyncAt)، والشركة غائبة عن أهلية النبضة في SQL نفسه وحاضرة في الفحوص الليلية كما كانت؛
// والإيقاف المؤقت (PAUSED) يوقف المُرحِّل أيضاً لا المُطابِق وحده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { invoiceKey } from '../services/gl/sync/keys';
import { createSyncBudget } from '../services/gl/sync/poster';
import { PrismaPostingStore, eligibleTenantsWhere } from '../services/gl/sync/postingStore.prisma';
import { createLedgerSyncScheduler, runNightlyChecksRound } from '../services/gl/sync/scheduler';
import { isPostingPaused, runManualSync, runTenantTick } from '../services/gl/sync/tick';
import type { DesiredEvent, SourceEventPayload } from '../services/gl/sync/types';
import { FakePostingStore } from './gl-fake-posting-store';

const at = (iso: string) => new Date(iso);
const ACT = at('2027-01-15T09:00:00.000Z');
const NOW = at('2027-03-01T10:00:00.000Z').getTime();
const quiet = { log: () => undefined, poster: { log: () => undefined } };

function invoiceEvent(id: string, entryDate = '2027-02-10'): DesiredEvent {
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
    items: [{ qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
    customerName: 'عميل أول', entryDate, currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at(`${entryDate}T08:00:00.000Z`),
    payload: { ...payload, sourceCreatedAt: `${entryDate}T08:00:00.000Z` } as SourceEventPayload,
  };
}

/** يسجّل كل استدعاء على المخزن (الاسم وحده) فوق FakePostingStore حقيقي */
function recorded(store: FakePostingStore): { store: FakePostingStore; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => { calls.push(String(prop)); return (v as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
  return { store: proxy, calls };
}

const fullBudget = () => createSyncBudget({ clock: () => NOW, timeMs: 60_000, events: 1_000 });

// ═══ الذهبي: CLEAN ⇒ MANUAL_LEDGER بلا أي كتابة ═══

test('ذهبي (مخزن مزيّف): شركة CLEAN بأحداث معلّقة ⇒ النبضة و«مزامنة الآن» تعيدان MANUAL_LEDGER، ولا قيد ولا حدث يتغيّر ولا عقد ولا lastSyncAt', async () => {
  const base = new FakePostingStore({ now: () => NOW, settings: { setupMethod: 'CLEAN', activatedAt: ACT } });
  base.seedEvents([invoiceEvent('i1'), invoiceEvent('i2', '2027-02-11')]);
  const before = structuredClone(base.state);
  const { store, calls } = recorded(base);
  let reconciled = 0;
  let safety = 0;
  const deps = { store, reconcile: async () => { reconciled++; return []; }, safetyNet: async () => { safety++; }, inProcess: new Set<string>(), ...quiet };

  const r = await runTenantTick(deps, 't1', fullBudget());
  assert.equal(r.skipped, 'MANUAL_LEDGER');
  assert.equal(r.leaseAcquired, false);
  assert.equal(r.post, null);
  assert.equal(r.pendingEvents, 0);
  const m = await runManualSync(deps, 't1', { clock: () => NOW, lastRun: new Map() });
  assert.equal(m.running, false);
  assert.equal(m.running === false && m.result.skipped, 'MANUAL_LEDGER');

  assert.deepEqual(calls, ['loadPosterSettings', 'loadPosterSettings'], 'قراءة الإعدادات وحدها — لا عقد ولا قفل ولا عدّ ولا ترحيل');
  assert.equal(reconciled, 0);
  assert.equal(safety, 0);
  assert.equal(base.lockCalls, 0, 'لا معاملة gl-post');
  assert.deepEqual(base.state, before, 'لا قيد ولا حدث ولا رصيد ولا تسلسل ولا عقد ولا lastSyncAt تغيّر');
  assert.equal(base.moves().length, 0);
});

/** عميل Prisma مزيّف يسجّل كل وصول (المفوَّض.الطريقة أو $raw) ويعيد صف إعدادات بالطريقة المعطاة */
function recordingPrisma(setupMethod: string | null) {
  const calls: string[] = [];
  const row = {
    id: 'gs1', tenantId: 't1', activatedAt: ACT, backfillState: 'DONE', setupMethod, cutoverDate: at('2027-01-15T00:00:00.000Z'),
    openingSnapshotAt: ACT, currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', templateKey: 'SA_6D', countryCode: 'SA',
    fiscalYearEndMonth: 12, fiscalYearEndDay: 31, weekStartsOn: 0, inventoryMode: 'PERIODIC', perpetualFromDate: null,
    salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null, taxPeriodicity: 'QUARTERLY',
    taxDeadlineRule: 'END_OF_NEXT_MONTH', taxDeadlineDays: null, zeroRatedSalesTaxKey: null, postSalesDiscountSeparately: false,
    postReturnsToContra: true, receiptRouting: null, cashInvoiceRouting: 'MAIN_CASH', paylinkFeeTaxInvoiceFrom: null,
    postPurchaseDiscountSeparately: false, billPricesIncludeTax: false, earlyDiscountAdjustsVat: false, taxRoundingMethod: 'PER_TAX',
    defaultPurchaseTaxId: null, lastSyncAt: null, tenant: { accountingSuiteEnabled: true, accountingEnabled: true },
  };
  const delegate = (model: string) => new Proxy({}, {
    get: (_t, method: string) => async () => {
      calls.push(`${model}.${method}`);
      if (model === 'glSettings' && method === 'findUnique') return row;
      if (model === 'companySettings' && method === 'findUnique') return { currency: 'SAR', currencyOverride: null };
      return null;
    },
  });
  const db = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop.startsWith('$')) return async () => { calls.push(prop); return prop === '$executeRaw' ? 1 : [{ now: new Date(NOW) }]; };
      return delegate(prop);
    },
  }) as unknown as PrismaClient;
  return { db, calls, row };
}

test('ذهبي (مخزن Prisma الحقيقي): شركة CLEAN ⇒ قراءتان فقط (gl_settings وإعدادات الشركة) — لا $executeRaw للعقد ولا $transaction ولا كتابة', async () => {
  const { db, calls } = recordingPrisma('CLEAN');
  const r = await runTenantTick({ store: new PrismaPostingStore(db), inProcess: new Set(), ...quiet }, 't1', fullBudget());
  assert.equal(r.skipped, 'MANUAL_LEDGER');
  assert.deepEqual(calls, ['glSettings.findUnique', 'companySettings.findUnique']);
  assert.ok(!calls.some((c) => /\$executeRaw|\$transaction|\.(create|update|upsert|delete)/.test(c)));
});

test('loadPosterSettings: LINKED تمرّ كما هي (لا تسقط إلى null)، وغير المعروف null، وCLEAN كما هي', async () => {
  for (const [raw, want] of [['LINKED', 'LINKED'], ['CLEAN', 'CLEAN'], ['OPENING', 'OPENING'], ['FULL_HISTORY', 'FULL_HISTORY'], ['BOGUS', null], [null, null]] as const) {
    const { db } = recordingPrisma(raw);
    const s = await new PrismaPostingStore(db).loadPosterSettings('t1');
    assert.equal(s?.setupMethod, want, String(raw));
  }
});

// ═══ الأهلية في SQL ═══

type Row = { tenantId: string; activatedAt: Date | null; setupMethod: string | null; lastSyncAt: Date | null; tenant: { accountingSuiteEnabled: boolean; accountingEnabled: boolean } };

/**
 * مقيّم مصغّر لما تستعمله eligibleTenantsWhere من شروط Prisma — بمنطق SQL الثلاثي: `NOT IN` و`<>` لا يطابقان NULL
 * (هكذا يولّدهما Prisma لعمود اختياري)، و`null` = IS NULL، والعلاقة tenant بمطابقة حقولها.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    if (k === 'AND') return (cond as Record<string, unknown>[]).every((c) => matches(row, c));
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (typeof cond !== 'object' || cond instanceof Date) return v === cond;
    const c = cond as Record<string, unknown>;
    if (k === 'tenant') return matches(v as Record<string, unknown>, c);
    if ('not' in c && c.not === null) return v !== null && v !== undefined;
    if ('notIn' in c) return v !== null && v !== undefined && !(c.notIn as unknown[]).includes(v);
    if ('in' in c) return v !== null && v !== undefined && (c.in as unknown[]).includes(v);
    if ('not' in c) return v !== null && v !== undefined && v !== c.not;
    throw new Error(`شرط غير مدعوم في المقيّم: ${k} ${JSON.stringify(c)}`);
  });
}

const ON = { accountingSuiteEnabled: true, accountingEnabled: true };
const ROWS: Row[] = [
  { tenantId: 'clean', activatedAt: ACT, setupMethod: 'CLEAN', lastSyncAt: null, tenant: ON },
  { tenantId: 'linked', activatedAt: ACT, setupMethod: 'LINKED', lastSyncAt: null, tenant: ON },
  { tenantId: 'opening', activatedAt: ACT, setupMethod: 'OPENING', lastSyncAt: at('2027-03-01T09:00:00Z'), tenant: ON },
  { tenantId: 'full', activatedAt: ACT, setupMethod: 'FULL_HISTORY', lastSyncAt: null, tenant: ON },
  { tenantId: 'nullMethod', activatedAt: ACT, setupMethod: null, lastSyncAt: null, tenant: ON },
  { tenantId: 'bogus', activatedAt: ACT, setupMethod: 'BOGUS', lastSyncAt: null, tenant: ON },
  { tenantId: 'notActivated', activatedAt: null, setupMethod: 'LINKED', lastSyncAt: null, tenant: ON },
  { tenantId: 'suiteOff', activatedAt: ACT, setupMethod: 'LINKED', lastSyncAt: null, tenant: { accountingSuiteEnabled: false, accountingEnabled: true } },
  { tenantId: 'accountingOff', activatedAt: ACT, setupMethod: 'OPENING', lastSyncAt: null, tenant: { accountingSuiteEnabled: true, accountingEnabled: false } },
];
const pick = (where: Prisma.GlSettingsWhereInput) => ROWS.filter((r) => matches(r as unknown as Record<string, unknown>, where as Record<string, unknown>)).map((r) => r.tenantId).sort();

test('أهلية النبضة في SQL: اليدوية (CLEAN) غائبة، وكل ما سواها كما كان (ومنها setupMethod الفارغ وغير المعروف)؛ الفحوص الليلية تعمّ اليدوية', () => {
  assert.deepEqual(pick(eligibleTenantsWhere({ excludeManual: true })), ['bogus', 'full', 'linked', 'nullMethod', 'opening']);
  assert.deepEqual(pick(eligibleTenantsWhere({ excludeManual: false })), ['bogus', 'clean', 'full', 'linked', 'nullMethod', 'opening'], 'قائمة الفحوص = الأهلية القديمة');
  // لماذا الفرع الصريح setupMethod: null — NOT IN وحده يُسقط الصف الفارغ (فخّ SQL الثلاثي)
  assert.ok(!pick({ activatedAt: { not: null }, setupMethod: { notIn: ['CLEAN'] } }).includes('nullMethod'));
  // المستبعَد مشتقّ من services/gl/mode لا حرفي
  assert.deepEqual(eligibleTenantsWhere({ excludeManual: true }).OR, [{ setupMethod: null }, { setupMethod: { notIn: ['CLEAN'] } }]);
});

test('PrismaPostingStore: listEligibleTenants بلا اليدوية وlistCheckTenants بها — الترتيب نفسه (أقدم lastSyncAt، الفارغ أولاً) وسقف 200', async () => {
  const seen: { where: unknown; orderBy: unknown; take: unknown; select: unknown }[] = [];
  const db = { glSettings: { findMany: async (args: { where: unknown; orderBy: unknown; take: unknown; select: unknown }) => { seen.push(args); return []; } } } as unknown as PrismaClient;
  const store = new PrismaPostingStore(db);
  await store.listEligibleTenants();
  await store.listCheckTenants();
  await store.listEligibleTenants(7);
  assert.deepEqual(seen[0].where, eligibleTenantsWhere({ excludeManual: true }));
  assert.deepEqual(seen[1].where, eligibleTenantsWhere({ excludeManual: false }));
  for (const a of seen) {
    assert.deepEqual(a.orderBy, [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }, { tenantId: 'asc' }]);
    assert.deepEqual(a.select, { tenantId: true, lastSyncAt: true });
  }
  assert.deepEqual(seen.map((a) => a.take), [200, 200, 7]);
});

test('المجدول: شركة CLEAN لا تدخل النبضة إطلاقاً (لا نتيجة ولا أحداث)، والمربوطة تدخل وترحّل؛ والفحوص الليلية تشمل اليدوية', async () => {
  const manual = new FakePostingStore({ now: () => NOW, settings: { setupMethod: 'CLEAN', activatedAt: ACT } });
  manual.seedEvents([invoiceEvent('i1')]);
  const before = structuredClone(manual.state);
  const sch = createLedgerSyncScheduler({ store: manual, clock: () => NOW, inFlightRequests: () => 0, inProcess: new Set(), mutex: { busy: false }, ...quiet });
  const r = await sch.tick();
  assert.deepEqual(r.tenants, []);
  assert.equal(r.eventsProcessed, 0);
  assert.deepEqual(manual.state, before);

  const linked = new FakePostingStore({ now: () => NOW, settings: { setupMethod: 'LINKED', activatedAt: ACT } });
  linked.seedEvents([invoiceEvent('i1')]);
  const r2 = await createLedgerSyncScheduler({ store: linked, clock: () => NOW, inFlightRequests: () => 0, inProcess: new Set(), mutex: { busy: false }, ...quiet }).tick();
  assert.equal(r2.tenants.length, 1);
  assert.equal(r2.tenants[0].skipped, null);
  assert.equal(r2.eventsProcessed, 1);
  assert.equal(linked.moves().length, 1);
  assert.equal(linked.event(invoiceKey('i1', 'POST'))!.status, 'DONE');

  // الفحوص الليلية: المصدر listCheckTenants (اليدوية فيه) — مرآة المجدول الفعلي
  assert.deepEqual(await manual.listCheckTenants(), [{ tenantId: 't1', lastSyncAt: null }]);
  const ran = await runNightlyChecksRound({
    listTenants: () => manual.listCheckTenants(), timezoneOf: async () => 'Asia/Riyadh', runAndRecord: async () => undefined,
    clock: () => at('2027-03-01T03:00:00.000Z').getTime(), lastRun: new Map(), mutex: { busy: false }, inFlightRequests: () => 0,
  });
  assert.deepEqual(ran, ['t1']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'sync', 'scheduler.ts'), 'utf8');
  assert.match(src, /listTenants: \(\) => deps\.store\.listCheckTenants\(\),/);
  assert.match(src, /const tenants = await store\.listEligibleTenants\(deps\.tenantLimit\);/);
});

// ═══ الإيقاف المؤقت يوقف المُرحِّل أيضاً ═══

test('PAUSED: لا مُطابِق (ولو محقوناً بلا احترام للإيقاف) ولا شبكة أمان ولا مُرحِّل ولا lastSyncAt — والأحداث المُدرجة تبقى PENDING؛ الاستئناف يرحّلها', async () => {
  const s = new FakePostingStore({ now: () => NOW, settings: { setupMethod: 'LINKED', activatedAt: ACT, backfillState: 'PAUSED' } });
  s.seedEvents([invoiceEvent('i1')]);
  let reconciled = 0;
  let safety = 0;
  // مُطابِق لا يعرف الإيقاف (كـreconcilerFn): الحارس في النبضة نفسها
  const deps = { store: s, reconcile: async () => { reconciled++; return []; }, safetyNet: async () => { safety++; }, inProcess: new Set<string>(), ...quiet };
  const r = await runTenantTick(deps, 't1', fullBudget());
  assert.equal(isPostingPaused(s.settings), true);
  assert.equal(r.skipped, null);
  assert.equal(r.leaseAcquired, true);
  assert.equal(r.post, null, 'لا مُرحِّل');
  assert.equal(r.pendingEvents, 1);
  assert.equal(r.backfillState, 'PAUSED');
  assert.equal(reconciled, 0);
  assert.equal(safety, 0);
  assert.equal(s.lockCalls, 0, 'لا معاملة ترحيل');
  assert.equal(s.moves().length, 0);
  assert.equal(s.event(invoiceKey('i1', 'POST'))!.status, 'PENDING');
  assert.equal(s.state.lastSyncAt, null, 'لم يُزامَن شيء');
  assert.equal(s.state.lease.token, null, 'العقد فُكّ');
  // «مزامنة الآن» أثناء الإيقاف: النتيجة نفسها
  const m = await runManualSync(deps, 't1', { clock: () => NOW, lastRun: new Map() });
  assert.equal(m.running === false && m.result.post, null);
  assert.equal(s.moves().length, 0);

  // الاستئناف ⇒ يرحّل
  s.settings = { ...s.settings, backfillState: 'RUNNING' };
  const r2 = await runTenantTick(deps, 't1', fullBudget());
  assert.equal(r2.post?.done, 1);
  assert.equal(reconciled, 1);
  assert.equal(s.moves().length, 1);
  assert.equal(s.event(invoiceKey('i1', 'POST'))!.status, 'DONE');
  assert.ok(s.state.lastSyncAt);
  for (const st of ['RUNNING', 'DONE', 'NONE'] as const) assert.equal(isPostingPaused({ backfillState: st }), false, st);
});
