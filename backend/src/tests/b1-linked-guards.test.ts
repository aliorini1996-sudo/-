// «ربط الدفاتر» L0 (وكيل B1) — المربوطة (LINKED) لا تُعامَل يدويةً أبداً: خطافات الحذف (tombstone) تكتب أحداثها، وحارس حذف
// المندوب يعدّ بصمة التشغيل كاملة، والفحوص كلها تعمل (لا تخطّي MANUAL_LEDGER_SKIPPED_CHECKS)، ومحمّل العهدة بلا نافذة
// البداية النظيفة. واليدوية (CLEAN) كما كانت حرفياً في كل ذلك. ومعه: إعادة الضبط لا تمسّ سجلّ الموردين، والجرد المستمر
// لا يُختار جديداً حتى L6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CustodyComponentsInput } from '../services/gl/custody';
import {
  MANUAL_LEDGER_SKIPPED_CHECKS, loadC5Input, loadRepCustodyFacts, runChecks,
  type CheckSettingsFacts, type CheckStore, type PendingPartners,
} from '../services/gl/checks/run';
import { createPrismaCheckStore } from '../services/gl/checks/store.prisma';
import { PrismaPostingTx } from '../services/gl/sync/postingStore.prisma';
import { assertRepDeletable, ledgerTombstoneSettings, ledgerTombstones, settlementTombstones } from '../services/gl/sync/tombstone';
import { GL_RESET_KEEP, GL_RESET_ORDER } from '../services/gl/reset';
import { isLedgerError, type Milli } from '../services/gl/types';
import {
  INVENTORY_MODE_UNAVAILABLE_CODE, INVENTORY_MODE_UNAVAILABLE_MESSAGE, inventoryModeAvailable, inventoryModeOptions,
} from '../routes/ledger/config';
import { ledgerErrorResponse, LedgerHttpError } from '../routes/ledger/errors';

const at = (iso: string) => new Date(iso);
const T0 = at('2027-01-15T09:00:00.000Z');

// ═══ tombstone ═══

const settingsDb = (setupMethod: string | null, activatedAt: Date | null = T0) => ({
  glSettings: { findUnique: async () => ({ activatedAt, currencyDecimals: 2, setupMethod }) },
});

test('tombstone: LINKED تكتب أحداث الحذف (كالتفعيلات السابقة)، وCLEAN لا تكتب شيئاً كما كانت، وغير المفعّلة لا شيء', async () => {
  assert.deepEqual(await ledgerTombstoneSettings(settingsDb('LINKED') as never, 't1'), { activatedAt: T0, currencyDecimals: 2 });
  assert.equal(await ledgerTombstoneSettings(settingsDb('CLEAN') as never, 't1'), null);
  assert.equal(await ledgerTombstoneSettings(settingsDb('LINKED', null) as never, 't1'), null);

  const row = { id: 'st1', salesRepId: 'rep1', amount: 250, method: 'CASH', note: null, settledAt: at('2027-02-10T08:00:00Z'), createdAt: at('2027-02-10T08:00:00Z') };
  const linked = await settlementTombstones(settingsDb('LINKED') as never, 't1', row, { deletedAt: at('2027-02-12T08:00:00Z'), salesRepName: 'مندوب' });
  assert.deepEqual(linked.map((r) => r.sourceKey), ['SETTLEMENT:st1:POST', 'SETTLEMENT:st1:REVERSE']);
  assert.ok(linked.every((r) => r.status === 'PENDING' && r.tenantId === 't1'));
  assert.deepEqual(await settlementTombstones(settingsDb('CLEAN') as never, 't1', row), []);

  const ae = { id: 'ae1', customerId: 'c1', debit: 0, credit: 100, description: null, entryDate: at('2027-02-01T08:00:00Z'), createdAt: at('2027-02-01T08:00:00Z'), customerName: 'عميل' };
  const db = (m: string) => ({ ...settingsDb(m), customer: { findMany: async () => [] } });
  assert.equal((await ledgerTombstones(db('LINKED') as never, 't1', [ae])).length, 2);
  assert.deepEqual(await ledgerTombstones(db('CLEAN') as never, 't1', [ae]), []);
});

test('حذف المندوب: LINKED تعدّ البصمة الخمسة (الفواتير وتحميلات السيارة مرحَّلة) فتحجب الحذف؛ CLEAN تعدّ سطور القيود وحدها كما كانت', async () => {
  const run = async (setupMethod: string, counts: Record<string, number>) => {
    const counted: string[] = [];
    const counter = (name: string) => ({ count: async () => { counted.push(name); return counts[name] ?? 0; } });
    const db = {
      glSettings: { findUnique: async () => ({ activatedAt: T0, setupMethod }) },
      repSettlement: counter('repSettlement'), invoice: counter('invoice'), receipt: counter('receipt'), vanLoad: counter('vanLoad'), glMoveLine: counter('glMoveLine'),
    };
    let err: unknown = null;
    try { await assertRepDeletable(db as never, 't1', 'rep1'); } catch (e) { err = e; }
    return { counted, err };
  };
  const linked = await run('LINKED', { invoice: 3, vanLoad: 2 });
  assert.deepEqual(linked.counted, ['repSettlement', 'invoice', 'receipt', 'vanLoad', 'glMoveLine']);
  assert.ok(isLedgerError(linked.err) && linked.err.code === 'LEDGER_HISTORY_LOCKED');
  assert.deepEqual((linked.err as unknown as { details: { footprint: unknown } }).details.footprint, { settlements: 0, invoices: 3, receipts: 0, vanLoads: 2, moveLines: 0 });
  // اليدوية: بصمة التشغيل لا تُعدّ ولا تحجب
  const manual = await run('CLEAN', { invoice: 3, vanLoad: 2 });
  assert.deepEqual(manual.counted, ['glMoveLine']);
  assert.equal(manual.err, null);
});

// ═══ الفحوص ═══

class MiniCheckStore implements CheckStore {
  settings: CheckSettingsFacts;
  collectionsOpts: unknown[] = [];
  balanceOpts: unknown[] = [];
  openingReads: string[] = [];
  constructor(setupMethod: CheckSettingsFacts['setupMethod']) {
    this.settings = {
      activatedAt: T0, backfillState: 'DONE', setupMethod, cutoverDate: '2027-01-15', openingSnapshotAt: T0, timezone: 'Asia/Riyadh',
      currencyDecimals: 2, lastSyncAt: at('2027-03-10T11:59:00.000Z'), inventoryMode: 'PERIODIC',
      lockDates: { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null },
    };
  }
  async dbNow() { return at('2027-03-10T12:00:00.000Z'); }
  async loadSettings() { return this.settings; }
  async unbalancedMoves() { return []; }
  async periodLineTotals() { return []; }
  async storedPeriodBalances() { return []; }
  async controlAccounts() { return [{ id: 'ar', code: '113001', controlKind: 'AR' }, { id: 'cu', code: '111003', controlKind: 'CUSTODY' }, { id: 'pl', code: '112005', controlKind: 'PAYLINK' }]; }
  async mappedAccounts() { return []; }
  async ledgerByPartner(_t: string, _a: readonly string[], partner: 'customerId' | 'salesRepId', opts: { moveType?: string } = {}) {
    if (opts.moveType) this.openingReads.push(`${partner}:${opts.moveType}`);
    return new Map<string, Milli>();
  }
  async ledgerTotal(_t: string, _a: readonly string[], opts: { moveType?: 'OPENING' } = {}) {
    if (opts.moveType) this.openingReads.push(`total:${opts.moveType}`);
    return 0n;
  }
  async accountEntryTotals() { return new Map<string, Milli>(); }
  async deletedOpeningImports() { return new Map<string, Milli>(); }
  async customerNames() { return new Map<string, string>(); }
  async salesReps() { return [{ id: 'rep1', name: 'مندوب', isActive: true }]; }
  async custodyInputs(): Promise<CustodyComponentsInput> { return { receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' } }; }
  async repCollections(_t: string, _d: number, opts: { createdAfter?: Date } = {}) { this.collectionsOpts.push(opts); return new Map<string, Milli>(); }
  async settlementBalance(_t: string, _d: number, opts: { createdAfter?: Date } = {}) { this.balanceOpts.push(opts); return 0n; }
  async paylinkExplanations() { return { refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] }; }
  async pendingPartners(): Promise<PendingPartners> { return { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false }; }
  async problemEvents() { return []; }
  async cursorStates() { return ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'].map((source) => ({ source, watermarkAt: at('2027-03-10T11:40:00.000Z'), lastRunAt: at('2027-03-10T11:59:00.000Z'), lastCount: 0, stallTicks: 0, lagMs: 0 })); }
  async attentionMovesOn() { return []; }
  async draftsUpTo() { return { count: 0, drafts: [] }; }
  async taxes() { return []; }
  async sequences() { return []; }
  async postedMoveNumbers() { return []; }
  async erpOdooActive() { return false; }
}

test('الفحوص: LINKED تُفحص كلها (C3/C4/C4b/C5/C8/C14/C15 لا تُتخطّى)، وCLEAN تتخطّاها كما كانت', async () => {
  const keys = async (m: CheckSettingsFacts['setupMethod']) => (await runChecks(new MiniCheckStore(m), 't1')).results.map((r) => r.key);
  const linked = await keys('LINKED');
  // C4u وC16 (L5/L8) خلف علَم linked في لقطة الإعدادات — المخزن المصغّر هنا بلا العلَم، فتُفحص السبعة الأصلية
  for (const k of MANUAL_LEDGER_SKIPPED_CHECKS.filter((c) => c !== 'C4u' && c !== 'C16')) assert.ok(linked.includes(k), `LINKED: ${k}`);
  assert.deepEqual(linked, await keys('OPENING'), 'LINKED = OPENING في مجموعة الفحوص');
  const manual = await keys('CLEAN');
  for (const k of MANUAL_LEDGER_SKIPPED_CHECKS) assert.ok(!manual.includes(k), `CLEAN: ${k}`);
  for (const k of ['C1', 'C2', 'C10', 'C12'] as const) assert.ok(manual.includes(k), `CLEAN: ${k}`);
});

test('العهدة والأمانات في الفحوص: LINKED بلا نافذة البداية النظيفة (التاريخ كله، بلا قراءة الافتتاحي)، وCLEAN بالنافذة كما كانت', async () => {
  const pending: PendingPartners = { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false };
  const linked = new MiniCheckStore('LINKED');
  await loadRepCustodyFacts(linked, 't1', linked.settings, pending);
  await loadC5Input(linked, 't1', linked.settings, pending);
  assert.deepEqual(linked.collectionsOpts, [{}]);
  assert.deepEqual(linked.balanceOpts, [{}]);
  assert.deepEqual(linked.openingReads, []);
  const manual = new MiniCheckStore('CLEAN');
  await loadRepCustodyFacts(manual, 't1', manual.settings, pending);
  await loadC5Input(manual, 't1', manual.settings, pending);
  assert.deepEqual(manual.collectionsOpts, [{ createdAfter: T0 }]);
  assert.deepEqual(manual.balanceOpts, [{ createdAfter: T0 }]);
  assert.deepEqual(manual.openingReads.sort(), ['salesRepId:OPENING', 'total:OPENING']);
});

test('مخزن الفحوص (Prisma): loadSettings يمرّر LINKED كما هي، وغير المعروف null', async () => {
  const store = (setupMethod: string | null) => createPrismaCheckStore({
    glSettings: {
      findUnique: async () => ({
        activatedAt: T0, backfillState: 'DONE', setupMethod, cutoverDate: null, openingSnapshotAt: T0, timezone: 'Asia/Riyadh',
        currencyDecimals: 2, lastSyncAt: null, inventoryMode: 'PERIODIC', salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null,
      }),
    },
  } as never);
  assert.equal((await store('LINKED').loadSettings('t1'))?.setupMethod, 'LINKED');
  assert.equal((await store('CLEAN').loadSettings('t1'))?.setupMethod, 'CLEAN');
  assert.equal((await store('BOGUS').loadSettings('t1'))?.setupMethod, null);
});

// ═══ محمّل العهدة الموحّد (المُرحِّل وC4 وصفحة العهدة) ═══

test('محمّل العهدة: LINKED بلا نافذة createdAt > T0 ولا قراءة للعهدة الافتتاحية (كـOPENING)، وCLEAN بالنافذة كما كانت', async () => {
  const load = async (setupMethod: string | null) => {
    const wheres: Record<string, unknown> = {};
    let aggregated = false;
    const tx = {
      glSettings: { findUnique: async () => ({ timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, receiptRouting: null, cashInvoiceRouting: 'MAIN_CASH', setupMethod, openingSnapshotAt: T0 }) },
      receipt: { findMany: async (a: { where: unknown }) => { wheres.receipt = a.where; return []; } },
      invoice: { findMany: async (a: { where: unknown }) => { wheres.invoice = a.where; return []; } },
      repSettlement: { findMany: async (a: { where: unknown }) => { wheres.repSettlement = a.where; return []; } },
      glSourceEvent: { findMany: async () => [] },
      glMoveLine: { aggregate: async () => { aggregated = true; return { _sum: { debitMilli: 0n, creditMilli: 0n } }; } },
      accountEntry: { findMany: async () => [] },
    };
    await new PrismaPostingTx(tx as never, 't1').loadCustodyInputs('rep1');
    return { wheres, aggregated };
  };
  const linked = await load('LINKED');
  assert.deepEqual(linked.wheres.receipt, { tenantId: 't1', salesRepId: 'rep1' });
  assert.deepEqual(linked.wheres.repSettlement, { tenantId: 't1', salesRepId: 'rep1' });
  assert.equal(linked.aggregated, false);
  assert.deepEqual(linked, await load('OPENING'));
  const manual = await load('CLEAN');
  assert.deepEqual(manual.wheres.receipt, { tenantId: 't1', salesRepId: 'rep1', createdAt: { gt: T0 } });
  assert.deepEqual(manual.wheres.invoice, { tenantId: 't1', salesRepId: 'rep1', type: 'CASH', createdAt: { gt: T0 } });
  assert.equal(manual.aggregated, true);
});

// ═══ صفحات العملاء في الدفاتر ═══

test('حارس ثابت: صفحات العملاء/العهدة/الأمانات تحكم «يدوية» بـisManualBooks — LINKED لا تُعرض فارغة كاليدوية', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'customers.ts'), 'utf8');
  assert.match(src, /import \{ isManualBooks \} from '\.\.\/\.\.\/services\/gl\/mode';/);
  assert.match(src, /manual: isManualBooks\(s\),/);
  assert.equal((src.match(/if \(!s\?\.activatedAt \|\| isManualBooks\(s\)\) \{/g) ?? []).length, 2);
  const status = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'index.ts'), 'utf8');
  assert.match(status, /bookMode: bookMode\(s\),/, 'GET /status يعيد الوضع المحسوم للواجهة');
});

// ═══ إعادة الضبط وسجلّ الموردين ═══

test('إعادة ضبط الدفاتر لا تمسّ سجلّ الموردين التشغيلي: GlVendor في GL_RESET_KEEP لا GL_RESET_ORDER', () => {
  assert.ok((GL_RESET_KEEP as readonly string[]).includes('GlVendor'));
  assert.ok(!(GL_RESET_ORDER as readonly string[]).includes('GlVendor'));
  assert.ok((GL_RESET_KEEP as readonly string[]).includes('GlAuditLog'));
});

// ═══ الجرد المستمر حتى L6 ═══

test('طريقة الجرد: PERPETUAL لا يُختار جديداً (400 INVENTORY_MODE_UNAVAILABLE)، ولا تنكسر شركة قيمتها PERPETUAL أصلاً', () => {
  assert.equal(inventoryModeAvailable('PERIODIC', 'PERIODIC'), true);
  assert.equal(inventoryModeAvailable('PERIODIC', 'PERPETUAL'), true, 'العودة إلى الدوري مسموحة');
  assert.equal(inventoryModeAvailable('PERPETUAL', 'PERIODIC'), false);
  assert.equal(inventoryModeAvailable('PERPETUAL', null), false);
  assert.equal(inventoryModeAvailable('PERPETUAL', 'PERPETUAL'), true, 'إبقاء القائم');
  // «ربط الدفاتر» L6/L7: المربوطة يظهر لها الجرد المستمر (قيود المخزون وتكلفة البضاعة تُرحَّل لها)
  assert.equal(inventoryModeAvailable('PERPETUAL', 'PERIODIC', { linked: true }), true);
  assert.deepEqual(inventoryModeOptions('PERIODIC', { linked: true }).map((o) => o.available), [true, true]);
  assert.deepEqual(inventoryModeOptions('PERIODIC'), [
    { value: 'PERIODIC', available: true, reason: null },
    { value: 'PERPETUAL', available: false, reason: 'INVENTORY_MODE_UNAVAILABLE' },
  ]);
  assert.deepEqual(inventoryModeOptions('PERPETUAL').map((o) => o.available), [true, true]);
  // شكل الرد: 400 بالرمز والرسالة العربية والحقل
  const r = ledgerErrorResponse(new LedgerHttpError(400, INVENTORY_MODE_UNAVAILABLE_MESSAGE, { reason: INVENTORY_MODE_UNAVAILABLE_CODE, field: 'inventoryMode' }, INVENTORY_MODE_UNAVAILABLE_CODE));
  assert.equal(r?.status, 400);
  assert.equal(r?.body.code, 'INVENTORY_MODE_UNAVAILABLE');
  assert.equal(r?.body.message, 'المخزون الدائم يتاح مع ربط الدفاتر');
  assert.equal(r?.body.field, 'inventoryMode');
});

test('حارس ثابت: PUT /settings يرفض PERPETUAL الجديد بعد حارس التجميد (المفعّلة تلقى FROZEN_AFTER_ACTIVATION كما كانت) وقبل أي كتابة، وGET/PUT يعيدان الخيارات', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'config.ts'), 'utf8');
  const put = src.slice(src.indexOf("router.put('/settings'"), src.indexOf("router.post('/settings/load-template'"));
  const frozen = put.indexOf("reason: 'FROZEN_AFTER_ACTIVATION'");
  const guard = put.indexOf('!inventoryModeAvailable(body.inventoryMode, s.inventoryMode, { linked: isLinked(s) })');
  const write = put.indexOf('tx.glSettings.update(');
  assert.ok(frozen > 0 && guard > frozen && write > guard, 'التجميد ثم الإتاحة ثم الكتابة');
  assert.match(put.slice(guard, write), /throw new LedgerHttpError\(400, INVENTORY_MODE_UNAVAILABLE_MESSAGE, \{/);
  assert.match(put, /inventoryModeOptions: inventoryModeOptions\(updated\.settings\.inventoryMode, \{ linked: isLinked\(updated\.settings\) \}\),/);
  const get = src.slice(src.indexOf("router.get('/settings'"), src.indexOf('const RECEIPT_METHODS'));
  assert.match(get, /inventoryModeOptions: inventoryModeOptions\(s\.inventoryMode, \{ linked: isLinked\(s\) \}\)/);
  // الخيار المشتقّ خارج settingsOut (لا يدخل diff التدقيق)
  const out = src.slice(src.indexOf('export function settingsOut('), src.indexOf("router.get('/settings'"));
  assert.doesNotMatch(out, /inventoryModeOptions/);
});
