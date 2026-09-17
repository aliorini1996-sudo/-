// M3 — مطابقة الذمم بالبناء (ADR‑5، DESIGN.md §5.2، §5.4، §5.6، §10.1 صف M3: gl-ar-parity.test.ts).
// مولّد عشوائي حتمي لتسلسلات فواتير (آجلة ونقدية بصفّين ومرتجعات وصفرية) وسندات (نقدية وإلكترونية باسترداد)
// وإلغاءات واستيراد وتراجع عنه، قبل التفعيل (مشمول بالافتتاح) وبعده (ومنه الوصول المتأخر بتاريخ سابق للبدء)،
// عبر **المُطابِق الحقيقي** (sync/reconciler.ts بمخزن مزيّف فوق الجداول المحاكاة) و**المُرحِّل الحقيقي** والنبضة (tick.ts):
//   لكل عميل: رصيد 113001 في الأستاذ + رصيده الافتتاحي = Σ(مدين − دائن) في AccountEntry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { localDate, compareLocalDate } from '../services/gl/dates';
import { toMilli } from '../services/gl/money';
import { initialWatermarkAt, tombstoneOrigin } from '../services/gl/sync/classify';
import { arEntryTombstoneEvents } from '../services/gl/sync/tombstone';
import type { AccountEntrySourceRow, DeriveContext, InvoiceFacts, ReceiptFacts, ReconciledSource, SourceRow } from '../services/gl/sync/desired';
import type { CommitPageResult, PageQuery, ReconcilerStore, ReconcileSettings } from '../services/gl/sync/reconciler';
import { createSyncBudget } from '../services/gl/sync/poster';
import { reconcilerFn, runTenantTick } from '../services/gl/sync/tick';
import { compareCompositeKey, maxCompositeKey, type CompositeKey, type DesiredEvent, type SourceEventRecord } from '../services/gl/sync/types';
import type { SourceData } from '../services/gl/sync/postingStore';
import { FakePostingStore } from './gl-fake-posting-store';

const TZ = 'Asia/Riyadh';
const CUTOVER = '2027-01-01';
const T0 = new Date('2027-01-15T09:00:00.000Z');
const AR = accountIdOf('113001');

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimInvoice { id: string; type: 'CASH' | 'CREDIT' | 'RETURN'; customerId: string; total: number; subtotal: number; tax: number; cancelled: boolean }
interface SimReceipt { id: string; customerId: string; amount: number; method: 'CASH' | 'ONLINE'; paylinkId: string | null; refund: { entryId: string; amount: number } | null; cancelled: boolean }

class Sim {
  entries: AccountEntrySourceRow[] = [];
  invoices = new Map<string, SimInvoice>();
  receipts = new Map<string, SimReceipt>();
  seq = 0;
  opening = new Map<string, bigint>();
  openingTaken = false;
  constructor(public now: number) {}

  id(prefix: string) { this.seq++; return `${prefix}${String(this.seq).padStart(6, '0')}`; }
  add(row: Omit<AccountEntrySourceRow, 'id' | 'createdAt' | 'description'> & { createdAt?: Date; description?: string | null }) {
    const e: AccountEntrySourceRow = { description: null, ...row, id: this.id('ae'), createdAt: row.createdAt ?? new Date(this.now) };
    this.entries.push(e);
    return e;
  }
  customerNet(): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const e of this.entries) m.set(e.customerId, (m.get(e.customerId) ?? 0n) + toMilli(e.debit, 2) - toMilli(e.credit, 2));
    return m;
  }
  takeOpening() {
    for (const e of this.entries) {
      if (compareLocalDate(localDate(e.entryDate, TZ), CUTOVER) < 0 && e.createdAt.getTime() <= T0.getTime()) {
        this.opening.set(e.customerId, (this.opening.get(e.customerId) ?? 0n) + toMilli(e.debit, 2) - toMilli(e.credit, 2));
      }
    }
    this.openingTaken = true;
  }

  invoiceFacts(id: string): InvoiceFacts | undefined {
    const i = this.invoices.get(id);
    if (!i) return undefined;
    return {
      id: i.id, number: i.id, type: i.type, customerId: i.customerId, salesRepId: null, pricesIncludeTax: false, subtotal: i.subtotal,
      discountAmt: 0, taxAmt: i.tax, total: i.total, dueDate: null, customerName: `عميل ${i.customerId}`, salesRepName: null,
      items: i.total === 0 ? [] : [{ productId: null, categoryId: null, qty: 1, unitPrice: i.subtotal, taxPct: 15, taxAmt: i.tax, lineTotal: i.total, vatCategory: null }],
    };
  }
  receiptFacts(id: string): ReceiptFacts | undefined {
    const r = this.receipts.get(id);
    if (!r) return undefined;
    return {
      id: r.id, number: r.id, customerId: r.customerId, salesRepId: null, paymentMethod: r.method, amount: r.amount,
      customerName: `عميل ${r.customerId}`, salesRepName: null, paylinkId: r.paylinkId, refund: r.refund,
    };
  }
}

/** مخزن المُطابِق فوق الجداول المحاكاة، يكتب الأحداث في المخزن المزيّف للمُرحِّل (الجدول نفسه) */
function reconcilerStore(sim: Sim, store: FakePostingStore): ReconcilerStore {
  const settings: ReconcileSettings = { tenantId: 't1', activatedAt: T0, timezone: TZ, currency: 'SAR', currencyDecimals: 2 };
  const key = (r: SourceRow): CompositeKey => ({ at: r.createdAt, id: r.id });
  const rows = (source: ReconciledSource): SourceRow[] => (source === 'ACCOUNT_ENTRY' ? [...sim.entries] : []);
  return {
    async dbNow() { return new Date(sim.now); },
    async loadSettings() { return settings; },
    async readCursor(_t, source) { return store.state.cursors.get(source) ?? null; },
    async readPage(_t, source, q: PageQuery) {
      return rows(source)
        .filter((r) => compareCompositeKey(key(r), q.after) > 0 && r.createdAt.getTime() <= q.upTo.getTime())
        .sort((a, b) => compareCompositeKey(key(a), key(b)))
        .slice(0, q.limit);
    },
    async loadFacts(_t, _source, page): Promise<DeriveContext> {
      const invoices = new Map<string, InvoiceFacts>();
      const receipts = new Map<string, ReceiptFacts>();
      const customerNames = new Map<string, string>();
      for (const r of page as AccountEntrySourceRow[]) {
        if (r.invoiceId) { const f = sim.invoiceFacts(r.invoiceId); if (f) invoices.set(f.id, f); }
        if (r.receiptId) { const f = sim.receiptFacts(r.receiptId); if (f) receipts.set(f.id, f); }
        customerNames.set(r.customerId, `عميل ${r.customerId}`);
      }
      return { timezone: TZ, currency: 'SAR', currencyDecimals: 2, invoices, receipts, customerNames };
    },
    async commitPage(_t, source, events, advanceTo, rowCount): Promise<CommitPageResult> {
      const inserted = store.seedEvents(events);
      const cur = store.state.cursors.get(source)!;
      const next = maxCompositeKey({ at: cur.watermarkAt, id: cur.watermarkId }, advanceTo);
      store.state.cursors.set(source, { ...cur, watermarkAt: next.at, watermarkId: next.id, lastRunAt: new Date(sim.now), lastCount: rowCount });
      return { inserted, watermark: next };
    },
    async insertEvents(_t, events) { return store.seedEvents(events); },
    async recordStall(_t, source) {
      const cur = store.state.cursors.get(source)!;
      store.state.cursors.set(source, { ...cur, stallTicks: cur.stallTicks + 1 });
      return cur.stallTicks + 1;
    },
    async hasUnreadRows(_t, source, watermark, horizon) {
      return rows(source).some((r) => compareCompositeKey(key(r), watermark) > 0 && r.createdAt.getTime() <= horizon.getTime());
    },
  };
}

function sourceDataOf(sim: Sim) {
  return (sourceType: string, id: string, event: string): SourceData => {
    if (sourceType === 'INVOICE' && event === 'POST') {
      const f = sim.invoiceFacts(id);
      const i = sim.invoices.get(id);
      const rows = sim.entries.filter((e) => e.invoiceId === id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (!f || !i || rows.length === 0) return { kind: 'MISSING' };
      const payload = invoicePayloadFromRows({
        invoice: { ...f, pricesIncludeTax: false }, items: f.items, customerName: f.customerName, entryDate: localDate(rows[0].entryDate, TZ),
        currency: 'SAR', currencyDecimals: 2,
      });
      return { kind: 'FOUND', payload, createdAt: rows[0].createdAt };
    }
    if (sourceType === 'RECEIPT' && event === 'POST') {
      const r = sim.receipts.get(id);
      const row = sim.entries.find((e) => e.receiptId === id && e.type === 'RECEIPT_CREDIT');
      if (!r || !row) return { kind: 'MISSING' };
      return {
        kind: 'FOUND', createdAt: row.createdAt,
        payload: { receiptId: id, number: id, entryDate: localDate(row.entryDate, TZ), salesRepId: null, paymentMethod: r.method, amount: r.amount.toFixed(2), customerId: r.customerId, paylinkId: r.paylinkId },
      };
    }
    return { kind: 'MISSING' };
  };
}

function originOf(sim: Sim) {
  return (ev: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>) => {
    if (ev.sourceType === 'AR_ENTRY' || ev.sourceType === 'SETTLEMENT') {
      const o = tombstoneOrigin(ev.sourceType, ev.payload);
      return o ? { ...o, sourceExists: sim.entries.some((e) => e.id === ev.sourceId) } : null;
    }
    const rows = sim.entries
      .filter((e) => (ev.sourceType === 'INVOICE' ? e.invoiceId === ev.sourceId : e.receiptId === ev.sourceId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (rows.length === 0) return null;
    return { originEffectAt: rows[0].entryDate, originEffectDate: localDate(rows[0].entryDate, TZ), originCreatedAt: rows[0].createdAt, sourceExists: true };
  };
}

const money = (rnd: () => number, max = 500) => Math.round((5 + rnd() * max) * 100) / 100;

async function scenario(seed: number, ops: number) {
  const rnd = mulberry32(seed);
  const sim = new Sim(new Date('2026-12-20T08:00:00.000Z').getTime());
  const store = new FakePostingStore({
    now: () => sim.now,
    settings: { activatedAt: new Date(T0.getTime() + 10 * 60_000), openingSnapshotAt: T0, cutoverDate: CUTOVER, setupMethod: 'OPENING', backfillState: 'RUNNING' },
    sourceData: sourceDataOf(sim) as never,
    origin: originOf(sim),
  });
  const wm = initialWatermarkAt({ method: 'OPENING', cutoverDate: CUTOVER, openingSnapshotAt: T0, timezone: TZ });
  store.setCursor('ACCOUNT_ENTRY', wm, '');
  const recStore = reconcilerStore(sim, store);
  const deps = { store, reconcile: reconcilerFn(recStore), inProcess: new Set<string>(), log: () => undefined, poster: { log: () => undefined } };
  const tick = () => runTenantTick(deps, 't1', createSyncBudget({ timeMs: 1e9, events: 1e6 }));
  const customers = ['c1', 'c2', 'c3', 'c4'];
  const imports: AccountEntrySourceRow[] = [];
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const step = async (activated: boolean) => {
    sim.now += Math.floor(rnd() * 6 * 3600_000) + 60_000;
    const cust = pick(customers);
    // الوصول المتأخر: مستند بعد التفعيل بتاريخ أثر قبل البدء
    const late = activated && rnd() < 0.1;
    const entryDate = late ? new Date(new Date('2026-12-28T10:00:00.000Z').getTime() + Math.floor(rnd() * 3) * 86400_000) : new Date(sim.now);
    const r = rnd();
    if (r < 0.3) {
      const type = pick(['CREDIT', 'CREDIT', 'CASH', 'RETURN'] as const);
      const total = rnd() < 0.05 ? 0 : money(rnd);
      const subtotal = Math.round((total / 1.15) * 100) / 100;
      const inv: SimInvoice = { id: sim.id('inv'), type, customerId: cust, total, subtotal, tax: Math.round((total - subtotal) * 100) / 100, cancelled: false };
      sim.invoices.set(inv.id, inv);
      if (type === 'RETURN') {
        sim.add({ customerId: cust, invoiceId: inv.id, receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: total, entryDate });
      } else {
        const d = { customerId: cust, invoiceId: inv.id, receiptId: null, type: 'INVOICE_DEBIT', debit: total, credit: 0, entryDate };
        if (type === 'CASH') {
          const c = { customerId: cust, invoiceId: inv.id, receiptId: null, type: 'RECEIPT_CREDIT', debit: 0, credit: total, entryDate };
          const gap = 1 + Math.floor(rnd() * 5);
          // Prisma يملأ now() لكل طلب: الصفّان بمللي ثانية مختلفة وبترتيب قد ينعكس
          const [first, second] = rnd() < 0.5 ? [d, c] : [c, d];
          sim.add({ ...first, createdAt: new Date(sim.now) });
          sim.add({ ...second, createdAt: new Date(sim.now + gap) });
        } else {
          sim.add(d);
        }
      }
    } else if (r < 0.5) {
      const online = rnd() < 0.4;
      const rc: SimReceipt = { id: sim.id('rc'), customerId: cust, amount: money(rnd, 300), method: online ? 'ONLINE' : 'CASH', paylinkId: online ? sim.id('pl') : null, refund: null, cancelled: false };
      sim.receipts.set(rc.id, rc);
      sim.add({ customerId: cust, invoiceId: null, receiptId: rc.id, type: 'RECEIPT_CREDIT', debit: 0, credit: rc.amount, entryDate });
    } else if (r < 0.65) {
      const open = [...sim.invoices.values()].filter((i) => !i.cancelled);
      if (open.length === 0) return;
      const inv = pick(open);
      inv.cancelled = true;
      const at = new Date(sim.now);
      if (inv.type === 'RETURN') {
        sim.add({ customerId: inv.customerId, invoiceId: inv.id, receiptId: null, type: 'INVOICE_DEBIT', debit: inv.total, credit: 0, entryDate: at });
      } else {
        sim.add({ customerId: inv.customerId, invoiceId: inv.id, receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: inv.total, entryDate: at });
        if (inv.type === 'CASH') {
          sim.add({ customerId: inv.customerId, invoiceId: inv.id, receiptId: null, type: 'RECEIPT_DEBIT', debit: inv.total, credit: 0, entryDate: at, createdAt: new Date(sim.now + 3) });
        }
      }
    } else if (r < 0.75) {
      const open = [...sim.receipts.values()].filter((x) => !x.cancelled);
      if (open.length === 0) return;
      const rc = pick(open);
      rc.cancelled = true;
      if (rc.method === 'ONLINE' && rnd() < 0.6) rc.refund = { entryId: sim.id('se'), amount: -rc.amount };
      sim.add({ customerId: rc.customerId, invoiceId: null, receiptId: rc.id, type: 'RECEIPT_DEBIT', debit: rc.amount, credit: 0, entryDate: new Date(sim.now) });
    } else if (r < 0.9) {
      const debit = rnd() < 0.7;
      const amount = money(rnd, 1000);
      const row = sim.add({ customerId: cust, invoiceId: null, receiptId: null, type: debit ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT', debit: debit ? amount : 0, credit: debit ? 0 : amount, entryDate, description: 'رصيد مستورد' });
      imports.push(row);
      // أحياناً يُتراجع عن الاستيراد فوراً قبل أن يقرأه المُطابِق
      if (activated && rnd() < 0.2) await revert(row);
    } else if (activated) {
      const live = imports.filter((row) => sim.entries.includes(row));
      if (live.length) await revert(pick(live));
    }
  };

  const revert = async (row: AccountEntrySourceRow) => {
    sim.now += 1000;
    // خطاف الحذف (§5.3): الحدثان في معاملة الحذف نفسها ثم deleteMany
    store.seedEvents(arEntryTombstoneEvents([{ ...row, customerName: `عميل ${row.customerId}` }], 2, { deletedAt: new Date(sim.now) }) as DesiredEvent[]);
    sim.entries = sim.entries.filter((e) => e !== row);
  };

  // قبل التفعيل
  while (sim.now < T0.getTime() - 6 * 3600_000) await step(false);
  sim.now = T0.getTime();
  sim.takeOpening();
  sim.now = T0.getTime() + 10 * 60_000;
  // بعد التفعيل: عمليات ونبضات متداخلة
  for (let i = 0; i < ops; i++) {
    await step(true);
    if (rnd() < 0.35) await tick();
  }
  // التصريف
  sim.now += 3600_000;
  for (let i = 0; i < 40; i++) {
    await tick();
    const open = [...store.state.events.values()].filter((e) => ['PENDING', 'BLOCKED', 'ERROR'].includes(e.status));
    if (open.length === 0) break;
    sim.now += 3 * 3600_000;
  }
  return { sim, store };
}

for (const seed of [11, 2027, 90210, 424242]) {
  test(`تكافؤ الذمم: 113001 لكل عميل + الافتتاحي = Σ AccountEntry (بذرة ${seed})`, async () => {
    const { sim, store } = await scenario(seed, 140);
    const events = [...store.state.events.values()];
    const stuck = events.filter((e) => !['DONE', 'SKIPPED'].includes(e.status));
    assert.deepEqual(stuck.map((e) => `${e.sourceKey} ${e.status} ${e.lastError ?? ''}`), [], 'كل الأحداث نهائية');
    const expected = sim.customerNet();
    const customers = new Set([...expected.keys(), ...sim.opening.keys()]);
    for (const c of customers) {
      const ledger = store.balance(AR, c);
      const opening = sim.opening.get(c) ?? 0n;
      assert.equal(ledger + opening, expected.get(c) ?? 0n, `العميل ${c}: أستاذ ${ledger} + افتتاحي ${opening}`);
    }
    // لا قيد مكرر لمفتاح: كل ربط مصدر فريد، ولا قيد بلا ربط
    const linked = new Set(store.state.sources.values());
    assert.equal(linked.size, store.moves().length, 'كل قيد له ربط مصدر واحد على الأقل');
    // التغطية: الاختبار مرّ فعلاً بمسارات البوابة
    const kinds = new Set(events.map((e) => `${e.event}:${e.status}:${e.skipReason ?? ''}`));
    assert.ok(kinds.has('POST:DONE:'), [...kinds].join(','));
    assert.ok(store.moves().some((m) => m.reversedMoveId), 'عكس قيد حيّ');
    assert.ok(store.moves().some((m) => m.lateArrival), 'وصول متأخر بتاريخ البدء');
  });
}
