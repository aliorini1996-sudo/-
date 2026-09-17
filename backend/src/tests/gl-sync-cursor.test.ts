// M3 — مؤشر المُطابِق المركّب (DESIGN.md §5.1، §5.2، §10.1 صف M3: gl-sync-cursor.test.ts).
// بمخزن مزيّف في الذاكرة (لا قاعدة): (أ) 5,000 صف بـcreatedAt واحد، (ب) 20,000 صف بشكل /ledger على دقيقتين،
// (ج) صف التزم بعد 9 دقائق من createdAt، (د) فاتورة نقدية في صفحتين؛ والمؤشر لا يتجاوز الأفق، والذيل لا يحرّكه،
// وصفحة ممتلئة لم تحرّكه ⇒ stallTicks وسجل ERROR؛ وشبكة الأمان متساوية الأثر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cursorLagMs, reconcileHorizon, reconcileSource, reconcileTenant, safetyNetScan,
  type CommitPageResult, type PageQuery, type ReconcileLogEntry, type ReconcileSettings, type ReconcilerStore,
} from '../services/gl/sync/reconciler';
import type { AccountEntrySourceRow, DeriveContext, InvoiceFacts, ReconciledSource, SourceRow } from '../services/gl/sync/desired';
import { LATE_COMMIT_WINDOW_MS, compareCompositeKey, maxCompositeKey, type CompositeKey, type DesiredEvent, type SyncCursorState } from '../services/gl/sync/types';

const MIN = 60_000;
const T0 = Date.parse('2026-09-01T06:00:00.000Z');

class FakeStore implements ReconcilerStore {
  now = new Date(T0);
  rows: Record<ReconciledSource, SourceRow[]> = { ACCOUNT_ENTRY: [], REP_SETTLEMENT: [], SETTLEMENT_ENTRY: [] };
  invoices = new Map<string, InvoiceFacts>();
  events = new Map<string, DesiredEvent>();
  cursors = new Map<ReconciledSource, SyncCursorState>();
  /** المؤشر لا يتحرك (محاكاة خلل) */
  frozen = false;
  commits: { source: ReconciledSource; watermark: CompositeKey; horizon: Date }[] = [];
  settings: ReconcileSettings = { tenantId: 't1', activatedAt: new Date(T0 - 1000 * MIN), timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2 };

  constructor(initial: Date = new Date(0)) {
    for (const s of ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'] as const) {
      this.cursors.set(s, { source: s, watermarkAt: initial, watermarkId: '', lastRunAt: null, lastCount: 0, stallTicks: 0 });
    }
  }

  async dbNow() { return new Date(this.now); }
  async loadSettings() { return this.settings; }
  async readCursor(_t: string, source: ReconciledSource) {
    const c = this.cursors.get(source);
    return c ? { ...c } : null;
  }
  async readPage(_t: string, source: ReconciledSource, q: PageQuery) {
    return this.rows[source]
      .filter((r) => r.createdAt.getTime() <= q.upTo.getTime() && compareCompositeKey({ at: r.createdAt, id: r.id }, q.after) > 0)
      .sort((a, b) => compareCompositeKey({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
      .slice(0, q.limit);
  }
  async loadFacts(): Promise<DeriveContext> {
    return { timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, invoices: this.invoices, receipts: new Map(), customerNames: new Map() };
  }
  private insert(events: readonly DesiredEvent[]) {
    let n = 0;
    for (const e of events) if (!this.events.has(e.sourceKey)) { this.events.set(e.sourceKey, e); n++; }
    return n;
  }
  async commitPage(_t: string, source: ReconciledSource, events: readonly DesiredEvent[], advanceTo: CompositeKey, rowCount: number): Promise<CommitPageResult> {
    const inserted = this.insert(events);
    const c = this.cursors.get(source)!;
    if (!this.frozen) {
      const next = maxCompositeKey({ at: c.watermarkAt, id: c.watermarkId }, advanceTo);
      c.watermarkAt = next.at;
      c.watermarkId = next.id;
    }
    c.lastCount = rowCount;
    c.lastRunAt = new Date(this.now);
    const watermark = { at: c.watermarkAt, id: c.watermarkId };
    this.commits.push({ source, watermark, horizon: reconcileHorizon(this.now) });
    return { inserted, watermark };
  }
  async insertEvents(_t: string, events: readonly DesiredEvent[]) { return this.insert(events); }
  async recordStall(_t: string, source: ReconciledSource) {
    const c = this.cursors.get(source)!;
    c.stallTicks++;
    return c.stallTicks;
  }
  async hasUnreadRows(_t: string, source: ReconciledSource, watermark: CompositeKey, horizon: Date) {
    return (await this.readPage('t1', source, { after: watermark, upTo: horizon, limit: 1 })).length > 0;
  }
  wm(source: ReconciledSource = 'ACCOUNT_ENTRY'): CompositeKey {
    const c = this.cursors.get(source)!;
    return { at: c.watermarkAt, id: c.watermarkId };
  }
}

const pad = (n: number) => String(n).padStart(8, '0');
function adj(id: string, createdAt: Date, o: Partial<AccountEntrySourceRow> = {}): AccountEntrySourceRow {
  return { id, customerId: 'c1', invoiceId: null, receiptId: null, type: 'ADJUSTMENT_DEBIT', debit: 1, credit: 0, description: 'قيد مستورد', entryDate: createdAt, createdAt, ...o };
}

function assertStrictlyIncreasing(keys: CompositeKey[], msg: string) {
  for (let i = 1; i < keys.length; i++) assert.ok(compareCompositeKey(keys[i], keys[i - 1]) > 0, `${msg} عند ${i}`);
}

test('(أ) 5,000 صف AccountEntry بـcreatedAt واحد ⇒ كلها أحداث خلال نحو 10 نبضات، بلا تكرار، والمؤشر متزايد تماماً', async () => {
  const store = new FakeStore();
  const same = new Date(T0 - 60 * MIN);
  // ترتيب إدراج عشوائي؛ المعرّفات تكسر التعادل
  const ids = Array.from({ length: 5000 }, (_, i) => `e-${pad(i)}`).sort(() => Math.random() - 0.5);
  store.rows.ACCOUNT_ENTRY = ids.map((id) => adj(id, same));
  const marks: CompositeKey[] = [store.wm()];
  let ticks = 0;
  for (; ticks < 50; ticks++) {
    const r = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY', { maxPages: 1, log: () => assert.fail('لا توقف') });
    assert.ok(r);
    assert.equal(r.stalled, false);
    if (r.rowsRead === 0) break;
    marks.push(store.wm());
    store.now = new Date(store.now.getTime() + MIN);
  }
  assert.ok(ticks >= 10 && ticks <= 11, `عدد النبضات ${ticks}`);
  assert.equal(store.events.size, 5000);
  assert.deepEqual([...store.events.keys()].sort(), ids.map((id) => `AR_ENTRY:${id}:POST`).sort());
  assertStrictlyIncreasing(marks, 'المؤشر لم يتزايد');
  assert.deepEqual(store.wm(), { at: same, id: `e-${pad(4999)}` });
  // الأسلوب القديم (createdAt > watermark − 10min بحد 500 ثم max(createdAt)) كان سيعيد الـ500 نفسها إلى الأبد
});

test('(ب) 20,000 صف بشكل /ledger موزعة على دقيقتين ⇒ كل الأحداث بلا تكرار، ومؤشر الصفحات متزايد تماماً ولا يتجاوز الأفق', async () => {
  const store = new FakeStore();
  const start = T0 - 30 * MIN;
  store.rows.ACCOUNT_ENTRY = Array.from({ length: 20_000 }, (_, i) =>
    adj(`l-${pad(i)}`, new Date(start + Math.floor((i * 2 * MIN) / 20_000)), { type: i % 3 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT', entryDate: new Date(start - i * 86_400_000) }));
  let ticks = 0;
  while (ticks < 100) {
    ticks++;
    const r = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY', { maxPages: 7 });
    if (!r || r.rowsRead === 0) break;
  }
  assert.equal(store.events.size, 20_000);
  const marks = store.commits.map((c) => c.watermark);
  assertStrictlyIncreasing(marks, 'مؤشر الصفحات');
  for (const c of store.commits) assert.ok(c.watermark.at.getTime() <= c.horizon.getTime(), 'المؤشر تجاوز الأفق');
  assert.equal(store.commits.length, 40);
  // تكرار التشغيل لا يضيف شيئاً
  const again = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  assert.equal(again?.eventsInserted, 0);
  assert.equal(store.events.size, 20_000);
});

test('(ج) صف التزم بعد 9 دقائق من createdAt ⇒ يلتقطه الذيل فوراً ثم التمريرة الدائمة، والذيل لا يحرّك المؤشر', async () => {
  const store = new FakeStore(new Date(T0 - 60 * MIN));
  const created = new Date(T0);
  // نبضة قبل الالتزام
  store.now = new Date(T0 + 5 * MIN);
  await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  assert.equal(store.events.size, 0);
  const before = store.wm();
  // الالتزام بعد 9 دقائق
  store.now = new Date(T0 + 9 * MIN);
  store.rows.ACCOUNT_ENTRY.push(adj('late-1', created));
  const r1 = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  assert.ok(r1);
  assert.equal(r1.tailRowsRead, 1);
  assert.equal(r1.tailEventsInserted, 1);
  assert.ok(store.events.has('AR_ENTRY:late-1:POST'));
  assert.deepEqual(store.wm(), before, 'الذيل حرّك المؤشر');
  assert.ok(store.wm().at.getTime() <= reconcileHorizon(store.now).getTime());
  // بعد تخطي الأفق: التمريرة الدائمة تقرؤه (skipDuplicates ⇒ صفر) وتحرّك المؤشر إليه
  store.now = new Date(T0 + LATE_COMMIT_WINDOW_MS + MIN);
  const r2 = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  assert.equal(r2?.rowsRead, 1);
  assert.equal(r2?.eventsInserted, 0);
  assert.deepEqual(store.wm(), { at: created, id: 'late-1' });

  // ودون الذيل: التمريرة الدائمة وحدها تلتقطه لأنه التزم خلال 10 دقائق
  const s2 = new FakeStore(new Date(T0 - 60 * MIN));
  s2.now = new Date(T0 + 5 * MIN);
  await reconcileSource(s2, 't1', 'ACCOUNT_ENTRY', { tail: false });
  s2.now = new Date(T0 + 9 * MIN);
  s2.rows.ACCOUNT_ENTRY.push(adj('late-2', created));
  await reconcileSource(s2, 't1', 'ACCOUNT_ENTRY', { tail: false });
  assert.equal(s2.events.size, 0);
  s2.now = new Date(T0 + 11 * MIN);
  const r3 = await reconcileSource(s2, 't1', 'ACCOUNT_ENTRY', { tail: false });
  assert.equal(r3?.eventsInserted, 1);
});

test('(د) فاتورة نقدية وقع صفّاها في صفحتين (وبترتيب معكوس) ⇒ INVOICE:<id>:POST واحد بلا REVERSE', async () => {
  for (const reversed of [false, true]) {
    const store = new FakeStore();
    store.invoices.set('i1', {
      id: 'i1', number: 'INV-1', type: 'CASH', customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
      subtotal: 10, discountAmt: 0, taxAmt: 1.5, total: 11.5, dueDate: null, customerName: 'ع', salesRepName: 'م', items: [],
    });
    const base = T0 - 60 * MIN;
    const debit = adj(reversed ? 'b-2' : 'b-1', new Date(base + (reversed ? 3 : 0)), { type: 'INVOICE_DEBIT', invoiceId: 'i1' });
    const credit = adj(reversed ? 'b-1' : 'b-2', new Date(base + (reversed ? 0 : 3)), { type: 'RECEIPT_CREDIT', invoiceId: 'i1' });
    store.rows.ACCOUNT_ENTRY = [adj('a-0', new Date(base - 1)), debit, credit, adj('c-0', new Date(base + 10))];
    const r = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY', { pageSize: 2 });
    assert.equal(r?.pages, 3);
    const invoiceKeys = [...store.events.keys()].filter((k) => k.startsWith('INVOICE:'));
    assert.deepEqual(invoiceKeys, ['INVOICE:i1:POST'], `reversed=${reversed}`);
  }
});

test('المؤشر لا يتجاوز الأفق: صفوف بعد الأفق لا تحرّكه ولو قُرئت في الذيل', async () => {
  const store = new FakeStore();
  store.rows.ACCOUNT_ENTRY = [adj('old', new Date(T0 - 30 * MIN)), adj('fresh', new Date(T0 - 2 * MIN))];
  const r = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  assert.deepEqual(store.wm(), { at: new Date(T0 - 30 * MIN), id: 'old' });
  assert.equal(r?.tailRowsRead, 1);
  assert.equal(store.events.size, 2);
  assert.ok(store.wm().at.getTime() <= reconcileHorizon(store.now).getTime());
  assert.equal(await cursorLagMs(store, 't1', 'ACCOUNT_ENTRY'), 0);
});

test('صفحة ممتلئة لم تحرّك المؤشر ⇒ stallTicks++ وسجل ERROR منظّم وتوقف التمريرة', async () => {
  const store = new FakeStore();
  store.frozen = true;
  store.rows.ACCOUNT_ENTRY = Array.from({ length: 6 }, (_, i) => adj(`s-${i}`, new Date(T0 - 60 * MIN)));
  const logs: ReconcileLogEntry[] = [];
  const r = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY', { pageSize: 3, log: (e) => logs.push(e) });
  assert.equal(r?.stalled, true);
  assert.equal(r?.pages, 1);
  assert.equal(store.cursors.get('ACCOUNT_ENTRY')?.stallTicks, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'ERROR');
  assert.equal(logs[0].event, 'GL_SYNC_CURSOR_STALLED');
  assert.equal(logs[0].stallTicks, 1);
  // تأخر المؤشر يظهر
  assert.ok(((await cursorLagMs(store, 't1', 'ACCOUNT_ENTRY')) ?? 0) > 0);
  // صفحة ناقصة لا تُعدّ توقفاً
  const partial = new FakeStore();
  partial.frozen = true;
  partial.rows.ACCOUNT_ENTRY = [adj('p-0', new Date(T0 - 60 * MIN))];
  const r2 = await reconcileSource(partial, 't1', 'ACCOUNT_ENTRY', { pageSize: 3, log: () => assert.fail('توقف زائف') });
  assert.equal(r2?.stalled, false);
});

test('المؤشر لا يتراجع حين تكتب نبضة متأخرة مفتاحاً أصغر (GREATEST)', async () => {
  const store = new FakeStore();
  const hi = { at: new Date(T0 - 20 * MIN), id: 'z' };
  await store.commitPage('t1', 'ACCOUNT_ENTRY', [], hi, 0);
  const res = await store.commitPage('t1', 'ACCOUNT_ENTRY', [], { at: new Date(T0 - 40 * MIN), id: 'a' }, 0);
  assert.deepEqual(res.watermark, hi);
});

test('شبكة الأمان: صف التزم بعد أكثر من 10 دقائق (خلف المؤشر) يُلتقط بلا تحريك المؤشر وبتساوي الأثر', async () => {
  const store = new FakeStore();
  store.rows.ACCOUNT_ENTRY = [adj('n-1', new Date(T0 - 60 * MIN)), adj('n-3', new Date(T0 - 30 * MIN))];
  await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  const wm = store.wm();
  // صف createdAt قبل المؤشر التزم متأخراً جداً
  store.rows.ACCOUNT_ENTRY.push(adj('n-2', new Date(T0 - 45 * MIN)));
  const normal = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY');
  assert.equal(normal?.rowsRead, 0, 'التمريرة الدائمة لا تعود خلف المؤشر');
  const net = await safetyNetScan(store, 't1', 'ACCOUNT_ENTRY');
  assert.equal(net?.eventsInserted, 1);
  assert.ok(store.events.has('AR_ENTRY:n-2:POST'));
  assert.deepEqual(store.wm(), wm);
  const again = await safetyNetScan(store, 't1', 'ACCOUNT_ENTRY');
  assert.equal(again?.eventsInserted, 0);
  // خارج نافذة 24 ساعة لا يُقرأ
  store.rows.ACCOUNT_ENTRY.push(adj('n-0', new Date(T0 - 25 * 60 * MIN)));
  assert.equal((await safetyNetScan(store, 't1', 'ACCOUNT_ENTRY'))?.rowsRead, 3);
});

test('reconcileTenant: المصادر الثلاثة، ولا شيء لشركة غير مفعّلة أو مصدر بلا مؤشر', async () => {
  const store = new FakeStore();
  store.rows.REP_SETTLEMENT = [{ id: 's1', salesRepId: 'r1', amount: 5, method: 'CASH', note: null, settledAt: new Date(T0 - 90 * MIN), createdAt: new Date(T0 - 60 * MIN) }];
  store.rows.SETTLEMENT_ENTRY = [
    { id: 'f1', kind: 'FEE', amount: -1, feeNet: 0.87, feeVat: 0.13, linkId: 'L', payoutId: null, note: null, createdAt: new Date(T0 - 60 * MIN) },
    { id: 'c1', kind: 'COLLECTED', amount: 100, feeNet: null, feeVat: null, linkId: 'L', payoutId: null, note: null, createdAt: new Date(T0 - 60 * MIN) },
  ];
  store.cursors.delete('ACCOUNT_ENTRY');
  const res = await reconcileTenant(store, 't1');
  assert.deepEqual(res.map((r) => r.source), ['REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
  assert.deepEqual([...store.events.keys()].sort(), ['PAYLINK_FEE:f1', 'SETTLEMENT:s1:POST']);
  assert.equal(store.events.get('SETTLEMENT:s1:POST')?.effectAt.getTime(), T0 - 90 * MIN);

  const off = new FakeStore();
  off.settings = { ...off.settings, activatedAt: null };
  off.rows.ACCOUNT_ENTRY = [adj('x', new Date(T0 - 60 * MIN))];
  assert.deepEqual(await reconcileTenant(off, 't1'), []);
  assert.equal(await reconcileSource(off, 't1', 'ACCOUNT_ENTRY'), null);
  assert.equal(off.events.size, 0);
});

test('الميزانية الزمنية: deadline منقضٍ ⇒ budgetExhausted بلا قراءة', async () => {
  const store = new FakeStore();
  store.rows.ACCOUNT_ENTRY = [adj('x', new Date(T0 - 60 * MIN))];
  let t = 0;
  const r = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY', { clock: () => t, deadline: 0 });
  assert.equal(r?.budgetExhausted, true);
  assert.equal(r?.rowsRead, 0);
  t = -1;
  const r2 = await reconcileSource(store, 't1', 'ACCOUNT_ENTRY', { clock: () => t, deadline: 0 });
  assert.equal(r2?.rowsRead, 1);
});

test('حارس ثابت: reconciler.ts وdesired.ts وtombstone.ts لا تستورد prisma', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const f of ['reconciler.ts', 'desired.ts', 'tombstone.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '../services/gl/sync', f), 'utf8');
    assert.doesNotMatch(s, /from ['"]@prisma\/client['"]|config\/database/, f);
  }
});
