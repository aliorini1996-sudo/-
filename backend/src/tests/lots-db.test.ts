// «تتبّع اللوط» (P0) — services/lotsDb.ts فوق Prisma مزيّف (المواصفة §٨.٢ lots-db): ترتيب الأقفال واستعادة المهلة، والطابور
// داخل العملية (FIFO والتحرير والانشغال وعدم التسرّب)، وresolveOrCreateLot بحالاتها، ونصوص SQL التجميع (التوجيه والحقبة
// والحجز)، وعروض الأماكن من المجاميع، ويوم الشركة. لا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { II_BASE_QTY } from '../ai-rep/baseQty';
import { baseQtyOf } from '../services/units';
import { LOT_HOLD_MIRRORS, LotError, lotBaseQty, sortedLockKeys } from '../services/lots';
import {
  BASE_QTY_SQL, LOT_LOCK_TIMEOUT, aggInvLots, aggRelabels, aggVanInvoices, aggVanLots, aggVanTotals, aggWarehouseTotals, aggWhLots, companyDay,
  createLotQueue, loadLotMetas, lockLotProducts, placeViews, recordLotEvent, resolveOrCreateLot, type LotTx,
} from '../services/lotsDb';

interface Call { op: 'query' | 'exec'; sql: string; values: unknown[] }
const render = (strings: TemplateStringsArray, values: unknown[]) => {
  const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
};
function fakeTx(handler: (sql: string, values: unknown[]) => unknown[] = () => [], extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { const r = render(strings, values); calls.push({ op: 'query', ...r }); return handler(r.sql, r.values); },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { const r = render(strings, values); calls.push({ op: 'exec', ...r }); return 1; },
    ...extra,
  };
  return { tx: tx as unknown as LotTx, calls };
}

// ── lockLotProducts ──
test('lockLotProducts: FOR KEY SHARE أولاً، ثم حفظ lock_timeout وضبطه، ثم الأقفال بترتيب المفتاح للمتتبَّع وحده، ثم الاستعادة', async () => {
  const { tx, calls } = fakeTx((sql) => {
    if (sql.includes('FOR KEY SHARE')) return [
      { id: 'p1', lotTracked: true, lotTrackedSince: new Date('2026-11-01') },
      { id: 'p2', lotTracked: false, lotTrackedSince: null },
      { id: 'p3', lotTracked: true, lotTrackedSince: null },   // صار متتبَّعاً بين القراءتين: القاعدة هي المرجع
    ];
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '7s' }];
    return [];
  });
  const res = await lockLotProducts(tx, 't1', ['p3', 'p1', 'p2', 'p1']);
  assert.deepEqual([...res.tracked].sort(), ['p1', 'p3']);
  assert.equal(res.since.get('p1')!.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(res.since.get('p2'), null);
  assert.equal(calls.length, 1 + 1 + 1 + 2 + 1);
  assert.match(calls[0].sql, /^SELECT id, "lotTracked", "lotTrackedSince" FROM products WHERE "tenantId" = \$1 AND id = ANY\(\$2::text\[\]\) ORDER BY id FOR KEY SHARE$/);
  assert.deepEqual(calls[0].values, ['t1', ['p1', 'p2', 'p3']]);
  assert.match(calls[1].sql, /current_setting\('lock_timeout'\)/);
  assert.deepEqual([calls[2].op, calls[2].sql, calls[2].values], ['exec', "SELECT set_config('lock_timeout', $1, true)", [LOT_LOCK_TIMEOUT]]);
  const keys = sortedLockKeys('t1', ['p1', 'p3']).map((k) => k.key);
  assert.deepEqual(calls.slice(3, 5).map((c) => [c.op, c.sql, c.values[0]]), keys.map((k) => ['exec', 'SELECT pg_advisory_xact_lock($1)', k]));
  assert.deepEqual([calls[5].op, calls[5].values], ['exec', ['7s']], 'تُستعاد القيمة السابقة لا القيمة الافتراضية');
});

test('lockLotProducts: بلا صنف متتبَّع لا مسّ لـlock_timeout ولا قفل، والصفوف المقفلة سلفاً تُغني عن الاستعلام', async () => {
  const a = fakeTx((sql) => (sql.includes('FOR KEY SHARE') ? [{ id: 'p1', lotTracked: false, lotTrackedSince: null }] : []));
  const r1 = await lockLotProducts(a.tx, 't1', ['p1']);
  assert.equal(r1.tracked.size, 0);
  assert.equal(a.calls.length, 1);
  const b = fakeTx((sql) => (sql.includes('current_setting') ? [{ lock_timeout: '0' }] : []));
  const r2 = await lockLotProducts(b.tx, 't1', ['p1', 'p2'], { lockedRows: [{ id: 'p1', lotTracked: true, lotTrackedSince: null }, { id: 'pX', lotTracked: true, lotTrackedSince: null }] });
  assert.deepEqual([...r2.tracked], ['p1'], 'صفٌّ خارج أصناف العملية يُتجاهل');
  assert.ok(!b.calls.some((c) => c.sql.includes('FOR KEY SHARE')));
  assert.equal(b.calls.filter((c) => c.sql.includes('pg_advisory_xact_lock')).length, 1);
  const c = fakeTx();
  assert.deepEqual((await lockLotProducts(c.tx, 't1', [])).tracked.size, 0);
  assert.equal(c.calls.length, 0);
});

// ── الطابور داخل العملية ──
const tick = () => new Promise((r) => setTimeout(r, 5));

test('acquireLotQueue: FIFO لكل مفتاح، والتحرير يمرّر للتالي، ولا تسرّب مفاتيح', async () => {
  const q = createLotQueue({ waitMs: 2000 });
  const order: string[] = [];
  const r1 = await q.acquire('t1', ['p1', 'p2']);
  const w2 = q.acquire('t1', ['p2']).then((rel) => { order.push('second'); return rel; });
  const w3 = q.acquire('t1', ['p1']).then((rel) => { order.push('third'); return rel; });
  await tick();
  assert.deepEqual(order, [], 'المنتظرون لا يدخلون قبل التحرير');
  r1();
  r1(); // التحرير مرتين لا يحرّر غيره
  const [rel2, rel3] = await Promise.all([w2, w3]);
  assert.deepEqual(order.sort(), ['second', 'third']);
  rel2(); rel3();
  await tick(); // التحرير يمرّ عبر finally في runExclusive (دورة microtask)
  assert.equal(q.activeKeys(), 0);
  // FIFO على مفتاحٍ واحد
  const seq: number[] = [];
  const h = await q.acquire('t1', ['p9']);
  const ws = [1, 2, 3].map((n) => q.acquire('t1', ['p9']).then(async (rel) => { seq.push(n); await tick(); rel(); }));
  await tick();
  h();
  await Promise.all(ws);
  assert.deepEqual(seq, [1, 2, 3]);
  await tick();
  assert.equal(q.activeKeys(), 0);
});

test('acquireLotQueue: التحرير في finally عند الخطأ، وLOT_BUSY بعد المهلة أو امتلاء الطابور، وتحرير ما أُخذ جزئياً', async () => {
  const q = createLotQueue({ waitMs: 40, maxWaiters: 1 });
  const failing = async () => {
    const rel = await q.acquire('t1', ['p1']);
    try { throw new Error('boom'); } finally { rel(); }
  };
  await assert.rejects(failing(), /boom/);
  await tick();
  assert.equal(q.activeKeys(), 0, 'الخطأ لا يترك المفتاح محجوزاً');

  const held = await q.acquire('t1', ['p2']);
  const waiter = q.acquire('t1', ['p2']);
  await assert.rejects(q.acquire('t1', ['p2']), (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY' && e.status === 503 && e.detail?.reason === 'QUEUE_FULL');
  await assert.rejects(waiter, (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY' && e.detail?.reason === 'WAIT_TIMEOUT');
  // مفتاحان: الأول يُؤخذ والثاني ينتظر حتى المهلة ⇒ الأول يُحرَّر
  await assert.rejects(q.acquire('t1', ['p1', 'p2']), (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY');
  held();
  await tick();
  assert.equal(q.activeKeys(), 0, 'لا مفتاح باقٍ بعد الانشغال');
  const again = await q.acquire('t1', ['p1', 'p2']);
  again();
  await tick();
  assert.equal(q.activeKeys(), 0);
});

// ── resolveOrCreateLot ──
interface LotRec { id: string; tenantId: string; productId: string; lotNumber: string; productionDate: Date | null; expiryDate: Date | null; status: string; blockKind: string | null; blockedAt: Date | null; createdAt: Date; source?: string; sourceEntryId?: string | null }
function lotStore(seed: LotRec[] = []) {
  const lots = [...seed];
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const pick = (l: LotRec) => ({ id: l.id, productId: l.productId, lotNumber: l.lotNumber, productionDate: l.productionDate, expiryDate: l.expiryDate, status: l.status, blockKind: l.blockKind, blockedAt: l.blockedAt, createdAt: l.createdAt });
  const tx = {
    productLot: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => { const l = lots.find((x) => x.id === where.id && x.tenantId === where.tenantId); return l ? pick(l) : null; },
      findUnique: async ({ where }: { where: { tenantId_productId_lotNumber: { tenantId: string; productId: string; lotNumber: string } } }) => {
        const w = where.tenantId_productId_lotNumber;
        const l = lots.find((x) => x.tenantId === w.tenantId && x.productId === w.productId && x.lotNumber === w.lotNumber);
        return l ? pick(l) : null;
      },
      createMany: async ({ data, skipDuplicates }: { data: Omit<LotRec, 'id' | 'status' | 'blockKind' | 'blockedAt' | 'createdAt'>[]; skipDuplicates: boolean }) => {
        assert.equal(skipDuplicates, true, 'الإدراج بلا إجهاض المعاملة عند التصادم');
        let count = 0;
        for (const d of data) {
          if (lots.some((x) => x.tenantId === d.tenantId && x.productId === d.productId && x.lotNumber === d.lotNumber)) continue;
          lots.push({ ...d, id: `new${++n}`, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-11-05T00:00:00Z') });
          count++;
        }
        return { count };
      },
    },
    lotEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; } },
  };
  return { tx: tx as unknown as LotTx, lots, events };
}
const P = { id: 'p1', name: 'حليب', shelfLifeOn: true };
const META = { source: 'RECEIVE' as const, sourceEntryId: 'e1', createdBy: 'أحمد', actor: { type: 'ADMIN' as const, id: 'u1', name: 'أحمد' } };
const existing: LotRec = { id: 'L1', tenantId: 't1', productId: 'p1', lotNumber: 'B-12', productionDate: null, expiryDate: new Date('2027-01-31T00:00:00Z'), status: 'BLOCKED', blockKind: 'HOLD', blockedAt: new Date('2026-11-01'), createdAt: new Date('2026-10-01') };

test('resolveOrCreateLot: بالمعرّف (موجود، ومن شركة أخرى، ومن صنف آخر)', async () => {
  const s = lotStore([existing, { ...existing, id: 'L2', productId: 'p2' }, { ...existing, id: 'LX', tenantId: 't2' }]);
  const r = await resolveOrCreateLot(s.tx, 't1', P, { lotId: 'L1' }, META);
  assert.deepEqual([r.created, r.meta.lotNumber, r.meta.expiryDate, r.meta.status], [false, 'B-12', '2027-01-31', 'BLOCKED'], 'الموقوف يُعاد كما هو (تحذير LOT_INTO_BLOCKED للمستدعي)');
  await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, { lotId: 'LX' }, META), (e: unknown) => e instanceof LotError && e.code === 'LOT_NOT_FOUND' && e.status === 422);
  await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, { lotId: 'L2' }, META), (e: unknown) => e instanceof LotError && e.code === 'LOT_PRODUCT_MISMATCH');
  assert.equal(s.events.length, 0);
});

test('resolveOrCreateLot: بالرقم المطبَّع — القائم بتواريخه، والمخالف يُرفض، والجديد يُنشأ بحدثٍ CREATE', async () => {
  const s = lotStore([existing]);
  const same = await resolveOrCreateLot(s.tx, 't1', P, { lotNumber: ' b-١٢ ', expiryDate: '2027-01-31' }, META);
  assert.deepEqual([same.created, same.meta.id], [false, 'L1']);
  const noDates = await resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'b-12' }, META);
  assert.equal(noDates.meta.id, 'L1', 'غياب التواريخ لا يخالف المسجَّل');
  await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'B-12', expiryDate: '2027-02-01' }, META),
    (e: unknown) => e instanceof LotError && e.code === 'LOT_DATES_MISMATCH' && e.status === 409);
  const made = await resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'n-7', productionDate: '2026-10-01', expiryDate: '2027-04-01' }, META);
  assert.equal(made.created, true);
  assert.deepEqual([made.meta.lotNumber, made.meta.productionDate, made.meta.expiryDate, made.meta.status], ['N-7', '2026-10-01', '2027-04-01', 'ACTIVE']);
  const row = s.lots.find((l) => l.id === made.meta.id)!;
  assert.deepEqual([row.source, row.sourceEntryId, row.expiryDate!.toISOString()], ['RECEIVE', 'e1', '2027-04-01T00:00:00.000Z']);
  assert.equal(s.events.length, 1);
  assert.deepEqual([s.events[0].kind, s.events[0].lotId, s.events[0].actorType, s.events[0].actorName], ['CREATE', made.meta.id, 'ADMIN', 'أحمد']);
});

test('resolveOrCreateLot: رقمٌ فارغ LOT_REQUIRED، وتاريخٌ فاسد LOT_DATES_INVALID، والانتهاء إلزامي مع الصلاحية للجديد وحده', async () => {
  const s = lotStore([{ ...existing, expiryDate: null, status: 'ACTIVE' }]);
  for (const ref of [{}, { lotNumber: '   ' }, { lotNumber: null }]) {
    await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, ref, META), (e: unknown) => e instanceof LotError && e.code === 'LOT_REQUIRED' && /«حليب»/.test(e.message));
  }
  await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'Z', expiryDate: '2027-13-01' }, META), (e: unknown) => e instanceof LotError && e.code === 'LOT_DATES_INVALID');
  await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'Z', productionDate: '2027-05-01', expiryDate: '2027-01-01' }, META), (e: unknown) => e instanceof LotError && e.code === 'LOT_DATES_INVALID');
  await assert.rejects(resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'Z' }, META), (e: unknown) => e instanceof LotError && e.code === 'LOT_EXPIRY_REQUIRED');
  const old = await resolveOrCreateLot(s.tx, 't1', P, { lotNumber: 'B-12' }, META);
  assert.equal(old.created, false, 'لوطٌ قائم بلا انتهاء يُقبل (الإلزام عند الإنشاء)');
  const free = await resolveOrCreateLot(s.tx, 't1', { ...P, shelfLifeOn: false }, { lotNumber: 'Z' }, META);
  assert.equal(free.meta.expiryDate, null);
});

test('loadLotMetas: الشركة شرطٌ في الاستعلام (I5)، والفارغ بلا استعلام، والحالة المجهولة موقوفة', async () => {
  let where: Record<string, unknown> | null = null;
  const db = { productLot: { findMany: async (a: { where: Record<string, unknown> }) => { where = a.where; return [{ id: 'A', productId: 'p', lotNumber: 'A', productionDate: null, expiryDate: null, status: 'WEIRD', blockKind: 'X', blockedAt: null, createdAt: new Date(0) }]; } } } as unknown as LotTx;
  const m = await loadLotMetas(db, 't1', { lotIds: ['A', 'A'] });
  assert.deepEqual(where, { tenantId: 't1', id: { in: ['A'] } });
  assert.deepEqual([m.get('A')!.status, m.get('A')!.blockKind], ['BLOCKED', null]);
  where = null;
  assert.equal((await loadLotMetas(db, 't1', { lotIds: [] })).size, 0);
  assert.equal((await loadLotMetas(db, 't1', {})).size, 0);
  assert.equal(where, null);
});

test('recordLotEvent: الحدث بفاعله وسببه وقبل/بعد', async () => {
  const s = lotStore();
  await recordLotEvent(s.tx, { tenantId: 't1', lotId: null, productId: 'p1', kind: 'TRACKING_ON', reason: 'تفعيل', actor: { type: 'OWNER', id: null, name: 'المالك' } });
  await recordLotEvent(s.tx, { tenantId: 't1', lotId: 'L1', productId: 'p1', kind: 'BLOCK', before: { status: 'ACTIVE' }, after: { status: 'BLOCKED' }, actor: { type: 'API_KEY', id: 'k1', name: null } });
  assert.deepEqual(s.events[0], { tenantId: 't1', lotId: null, productId: 'p1', kind: 'TRACKING_ON', reason: 'تفعيل', actorType: 'OWNER', actorId: null, actorName: 'المالك' });
  assert.deepEqual([s.events[1].before, s.events[1].after, s.events[1].reason], [{ status: 'ACTIVE' }, { status: 'BLOCKED' }, null]);
});

// ── نصوص SQL التجميع ──
const EPOCH = 'GREATEST(COALESCE(t."lotTrackingSince", \'-infinity\'::timestamp), COALESCE(p."lotTrackedSince", \'-infinity\'::timestamp))';

test('SQL: لوطات السيارة بالحقبة وأول دخول موجب، وvanKeys أو viaWarehouse، وbefore', async () => {
  const { tx, calls } = fakeTx();
  await aggVanLots(tx, 't1', { productIds: ['p1'], vanKeys: ['r1'] });
  await aggVanLots(tx, 't1', { productIds: ['p1'], viaWarehouseOnly: true, before: new Date('2026-12-01') });
  const [a, b] = calls;
  assert.ok(a.sql.includes('FROM van_load_item_lots l'));
  assert.ok(a.sql.includes(`l."createdAt" >= ${EPOCH}`), 'الحقبة');
  assert.ok(a.sql.includes('MIN(l."createdAt") FILTER (WHERE l.qty > 0) AS "firstInAt"'));
  assert.ok(a.sql.includes('GROUP BY l."productId", l."lotId", l."vanKey", l."moveType", l."viaWarehouse"'));
  assert.ok(a.sql.includes('l."vanKey" = ANY('));
  assert.ok(!a.sql.includes('"viaWarehouse" = true'));
  assert.ok(b.sql.includes(`l."viaWarehouse" = true AND l."moveType" IN ('LOAD', 'UNLOAD')`));
  assert.ok(!b.sql.includes('l."vanKey" = ANY('), 'لوطات المستودع من كل السيارات');
  assert.ok(b.sql.includes('l."createdAt" <'));
  const none = fakeTx();
  assert.deepEqual(await aggVanLots(none.tx, 't1', { productIds: [], vanKeys: ['r1'] }), []);
  assert.deepEqual(await aggVanLots(none.tx, 't1', { productIds: ['p'], vanKeys: [] }), []);
  assert.equal(none.calls.length, 0);
});

test('SQL: فواتير السيارة بمفاتيح توجيه foldStock وشرط الحجز (D24) والحالة المؤكَّدة والحقبة', async () => {
  const t0 = new Date('2026-11-03T08:00:00Z');
  const { tx, calls } = fakeTx(() => [{ productId: 'p1', lotId: null, vanKey: 'r1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: '2.5', firstAt: t0, src: 'LOT' }]);
  const rows = await aggInvLots(tx, 't1', { productIds: ['p1'], vanKeys: ['r1'], before: new Date('2026-12-01') });
  assert.deepEqual(rows, [{ productId: 'p1', lotId: null, vanKey: 'r1', route: { type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false }, held: true, qty: 2.5, firstAt: t0 }]);
  const { sql, values } = calls[0];
  for (const frag of ['i.type', 'i."returnToStock"', 'it."returnExpired"', `i.status = 'CONFIRMED'`, 'il."vanKey" = ANY(', `il."createdAt" >= ${EPOCH}`, 'i."invoiceDate" <',
    'MIN(il."createdAt") AS "firstAt"',
    `COALESCE(i."returnReason" = 'DAMAGED' AND i."createdAt" >=`, `i.type = 'RETURN' AND i."zatcaPhase" = 2 AND i."invoiceSubtype" = '01'`,
    'i."einvoiceStatus" IS NULL OR i."einvoiceStatus" = ANY(', 'GROUP BY 1, 2, 3, 4, 5, 6, 7, 8']) {
    assert.ok(sql.includes(frag), `مفقود: ${frag}`);
  }
  assert.ok(values.some((v) => v instanceof Date && v.getTime() === DAMAGED_VAN_SINCE.getTime()), 'DAMAGED_VAN_SINCE من vanDamaged.ts');
  assert.ok(values.some((v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify([...LOT_HOLD_MIRRORS])), 'LOT_HOLD_MIRRORS معاملاً');
});

test('SQL: التسميات وأسطر المستودع بالحقبة، ومجاميع رصيد الصنف بلا حقبة وبالكمية الأساسية', async () => {
  const { tx, calls } = fakeTx(() => []);
  await aggRelabels(tx, 't1', { productIds: ['p1'], warehouse: true, vanKeys: ['r1'] });
  await aggWhLots(tx, 't1', { productIds: ['p1'] });
  await aggVanTotals(tx, 't1', { vanKeys: ['r1'], productIds: ['p1'] });
  await aggWarehouseTotals(tx, 't1', { productIds: ['p1'] });
  const [rel, whl, vl, vi, wt, wv] = calls.map((c) => c.sql);
  assert.ok(rel.includes(`(r.place = 'WAREHOUSE' OR (r.place = 'VAN' AND r."vanKey" = ANY(`) && rel.includes(`r."createdAt" >= ${EPOCH}`));
  assert.ok(rel.includes('MIN(r."createdAt") FILTER (WHERE r.qty > 0) AS "firstAt"'), 'التسمية دخولٌ للوط الوجهة (طبقة الإعادة ١)');
  assert.ok(whl.includes('wi."lotId" IS NOT NULL') && whl.includes(`we."createdAt" >= ${EPOCH}`), 'أسطر المستودع بتاريخ الحركة');
  for (const s of [vl, vi, wt, wv]) {
    assert.ok(!s.includes('lotTrackingSince'), 'رصيد الصنف يشمل التاريخ كله');
    assert.ok(s.includes(`SUM(${BASE_QTY_SQL.sql})::float8`), 'الكمية الأساسية من BASE_QTY_SQL');
  }
  assert.ok(vl.includes('vl."salesRepId" = ANY(') && vi.includes('i."salesRepId" = ANY(') && vi.includes(`i.status = 'CONFIRMED'`), 'مرشّحات computeStock');
  assert.ok(vi.includes(`i.type = 'RETURN' AND i."zatcaPhase" = 2 AND i."invoiceSubtype" = '01'`) && vi.includes('AS held'), 'البنود تحمل الحجز للمحجوز الكلي (D24)');
  assert.ok(wv.includes(`vl.type IN ('LOAD', 'UNLOAD')`) && !wv.includes('salesRepId'), 'المستودع: كل السيارات ومنها المحذوفة');
  // D19 (الوحدات أولاً): تعبير الوحدات نفسه بلا اسمٍ مستعار — II_BASE_QTY (ai-rep/baseQty.ts) ومُطلِق القاعدة
  assert.equal(BASE_QTY_SQL.sql, II_BASE_QTY.sql.replace(/\bii\./g, ''), 'BASE_QTY_SQL = II_BASE_QTY بلا ii.');
  assert.equal(BASE_QTY_SQL.values.length, 0, 'مقطعٌ ثابت بلا قيم');
  const trigger = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backfillBaseQty.ts'), 'utf8');
  assert.ok(trigger.includes('NEW."baseQty" := NEW."qty" * COALESCE(NULLIF(NEW."unitFactor", 0), 1);'), 'المُطلِق يحسب الأساس بالتعبير نفسه');
});

test('BASE_QTY_SQL بالدلالة = baseQtyOf (units.ts) = lotBaseQty على صفوفٍ بلقطاتٍ متنوّعة', () => {
  // مرآة SQL صرفة للتعبير: COALESCE(baseQty, qty * COALESCE(NULLIF(unitFactor, 0), 1)) — العمود unitFactor غير فارغ (@default(1))
  const sqlBase = (r: { qty: number; baseQty: number | null; unitFactor: number }) => r.baseQty ?? r.qty * (r.unitFactor === 0 ? 1 : r.unitFactor);
  const rows = [
    { qty: 2, baseQty: null, unitFactor: 24 }, { qty: 2, baseQty: 48, unitFactor: 24 }, { qty: 3, baseQty: null, unitFactor: 1 },
    { qty: 1.5, baseQty: null, unitFactor: 6 }, { qty: 0, baseQty: 0, unitFactor: 12 }, { qty: 5, baseQty: null, unitFactor: 0 },
    { qty: -4, baseQty: null, unitFactor: 6 }, { qty: 0.125, baseQty: 3, unitFactor: 24 },
  ];
  for (const r of rows) {
    assert.equal(sqlBase(r), baseQtyOf(r), `SQL ≠ baseQtyOf ${JSON.stringify(r)}`);
    assert.equal(lotBaseQty(r), baseQtyOf(r), `lotBaseQty ≠ baseQtyOf ${JSON.stringify(r)}`);
  }
  // حوافّ baseQtyOf التي لا تبلغها القاعدة (المعامل يُتحقَّق منه عند الكتابة): lotBaseQty يتبعها حرفياً لا مرآةً
  for (const r of [{ qty: 2, unitFactor: null }, { qty: 2 }, { qty: 2, unitFactor: -3 }, { qty: 2, unitFactor: Number.NaN }, { qty: 2, baseQty: Number.NaN, unitFactor: 12 },
    { qty: 0.1 + 0.2, unitFactor: 1 }, { qty: Number.NaN, unitFactor: 6 }]) {
    assert.equal(lotBaseQty(r), baseQtyOf(r), `lotBaseQty ≠ baseQtyOf ${JSON.stringify(r)}`);
  }
  assert.equal(lotBaseQty({ qty: 2, unitFactor: 24 }), 48);
  assert.equal(lotBaseQty({ qty: 2, baseQty: 5, unitFactor: 24 }), 5, 'العمود المخزَّن يسبق اللقطة');
});

// ── عروض الأماكن ──
test('placeViews: الخام من المجاميع، ورصيد الصنف من foldStock وcomposeWarehouse، وغير المسمّى، والسيارة المحذوفة تقريبية', async () => {
  const handler = (sql: string): unknown[] => {
    if (sql.includes('FROM van_load_item_lots')) {
      if (sql.includes('"viaWarehouse" = true')) return [
        { productId: 'p', lotId: 'A', vanKey: 'R1', moveType: 'LOAD', viaWarehouse: true, qty: 10, firstInAt: new Date('2026-11-02') },
        { productId: 'p', lotId: 'A', vanKey: 'GONE', moveType: 'LOAD', viaWarehouse: true, qty: 4, firstInAt: null },
      ];
      return [
        { productId: 'p', lotId: 'A', vanKey: 'R1', moveType: 'LOAD', viaWarehouse: true, qty: 10, firstInAt: new Date('2026-11-02') },
        { productId: 'p', lotId: 'A', vanKey: 'GONE', moveType: 'LOAD', viaWarehouse: true, qty: 4, firstInAt: new Date('2026-11-03') },
      ];
    }
    if (sql.includes('FROM invoice_item_lots')) {
      assert.ok(sql.includes('UNION ALL') && sql.includes('FROM invoice_items it'), 'لوطات الفواتير وبنودها في عبارةٍ واحدة');
      return [
        { productId: 'p', lotId: 'A', vanKey: 'R1', type: 'CASH', returnToStock: true, returnExpired: null, damaged: false, held: false, qty: 3, firstAt: null, src: 'LOT' },
        { productId: 'p', lotId: null, vanKey: 'R1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: 1, firstAt: null, src: 'LOT' },
        { productId: 'p', lotId: null, vanKey: 'R1', type: 'CASH', returnToStock: true, returnExpired: null, damaged: false, held: false, qty: 3, firstAt: null, src: 'TOT' },
        { productId: 'p', lotId: null, vanKey: 'R1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: 1, firstAt: null, src: 'TOT' },
      ];
    }
    if (sql.includes('FROM lot_relabels')) return [];
    if (sql.includes('FROM warehouse_entry_items') && sql.includes('IS NOT NULL')) return [{ productId: 'p', lotId: 'A', qty: 20 }];
    if (sql.includes('FROM warehouse_entry_items')) return [{ productId: 'p', type: 'RECEIVE', qty: 25 }];
    if (sql.includes('FROM van_load_items') && sql.includes('AS "vanKey"')) return [{ productId: 'p', vanKey: 'R1', type: 'LOAD', qty: 12 }];
    if (sql.includes('FROM van_load_items')) return [{ productId: 'p', type: 'LOAD', qty: 16 }];
    throw new Error(`استعلام غير متوقَّع: ${sql}`);
  };
  const { tx, calls } = fakeTx(handler, {
    salesRep: { findMany: async () => [{ id: 'R1' }] },
    productLot: { findMany: async () => [{ id: 'A', productId: 'p', lotNumber: 'A-1', productionDate: null, expiryDate: new Date('2027-01-01T00:00:00Z'), status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-10-01') }] },
  });
  const res = await placeViews(tx, 't1', { warehouse: true, vanKeys: ['R1', 'GONE'], productIds: ['p', 'q'], withTotals: true });
  const invCalls = calls.filter((c) => c.sql.includes('invoice_item'));
  assert.equal(invCalls.length, 1, 'نداء $queryRaw واحد للوطات الفواتير وبنودها (لقطةٌ واحدة تحت READ COMMITTED)');
  assert.ok(invCalls[0].values.some((v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify(['R1'])), 'البنود للمناديب القائمين وحدهم');
  const wh = res.warehouse.get('p')!;
  assert.deepEqual([wh.lots[0].raw.SELLABLE, wh.total!.SELLABLE, wh.unknown!.SELLABLE], [20 - 10 - 4, 25 - 16, 9 - 6]);
  const r1 = res.vans.get('R1')!.get('p')!;
  assert.deepEqual([r1.lots[0].raw.SELLABLE, r1.total!.SELLABLE, r1.unknown!.SELLABLE, r1.unknownUsable!.SELLABLE], [7, 12 - 3 + 1, 3, 2]);
  assert.equal(r1.lots[0].meta.lotNumber, 'A-1');
  assert.equal(r1.firstInAt.get('A')!.toISOString(), '2026-11-02T00:00:00.000Z');
  const gone = res.vans.get('GONE')!.get('p')!;
  assert.deepEqual([gone.approximate, gone.total, gone.lots[0].raw.SELLABLE], [true, null, 4]);
  assert.deepEqual([...res.deletedVans], ['GONE']);
  const q = res.vans.get('R1')!.get('q')!;
  assert.deepEqual([q.lots.length, q.total!.SELLABLE, q.unknown!.SELLABLE], [0, 0, 0], 'عرضٌ لكل صنف مطلوب ولو بلا صفوف');
  const empty = fakeTx(() => { throw new Error('لا استعلام'); });
  assert.equal((await placeViews(empty.tx, 't1', { vanKeys: [], productIds: ['p'], withTotals: true })).vans.size, 0);
});

test('aggVanInvoices: عبارةٌ واحدة بـUNION ALL (لوطات بعد الحقبة + بنود كل التاريخ)، وجزءٌ واحد حين يغيب الآخر، ولا استعلام بلا مفاتيح', async () => {
  const both = fakeTx(() => [
    { productId: 'p', lotId: 'A', vanKey: 'R1', type: 'CASH', returnToStock: true, returnExpired: null, damaged: false, held: false, qty: 2, firstAt: null, src: 'LOT' },
    { productId: 'p', lotId: null, vanKey: 'R1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: '5', firstAt: null, src: 'TOT' },
  ]);
  const r = await aggVanInvoices(both.tx, 't1', { productIds: ['p'], vanKeys: ['R1', 'GONE'], totalVanKeys: ['R1'] });
  assert.equal(both.calls.length, 1);
  const sql = both.calls[0].sql;
  assert.ok(sql.includes('UNION ALL') && sql.includes('FROM invoice_item_lots il') && sql.includes('FROM invoice_items it'));
  assert.ok(sql.indexOf(`il."createdAt" >= ${EPOCH}`) > 0 && sql.split('lotTrackingSince').length === 2, 'الحقبة على صفوف اللوط وحدها');
  assert.deepEqual(r.lots.map((x) => [x.lotId, x.qty, x.held]), [['A', 2, false]]);
  assert.deepEqual(r.totals, [{ productId: 'p', vanKey: 'R1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: 5 }]);
  const lotsOnly = fakeTx();
  await aggVanInvoices(lotsOnly.tx, 't1', { productIds: ['p'], vanKeys: ['GONE'], totalVanKeys: [] });
  assert.ok(!lotsOnly.calls[0].sql.includes('UNION ALL') && lotsOnly.calls[0].sql.includes('FROM invoice_item_lots'));
  const none = fakeTx();
  assert.deepEqual(await aggVanInvoices(none.tx, 't1', { productIds: [], vanKeys: ['R1'], totalVanKeys: ['R1'] }), { lots: [], totals: [] });
  assert.equal(none.calls.length, 0);
});

test('placeViews (D24): مرتجعٌ قياسي محجوز كُتب قبل الحقبة بلا صفوف لوط محجوزٌ في غير المسمّى — فلا يُصرف، وإبطاله لا يُنقص صالحه', async () => {
  // R1: تحميل 10 من A (بعد الحقبة)، ومرتجع «01» محجوز بخمس وحدات قبل التفعيل (بندٌ بلا صفوف لوط)
  const views = async (withHeldReturn: boolean) => {
    const handler = (sql: string): unknown[] => {
      if (sql.includes('FROM van_load_item_lots')) return [{ productId: 'p', lotId: 'A', vanKey: 'R1', moveType: 'LOAD', viaWarehouse: true, qty: 10, firstInAt: null }];
      if (sql.includes('FROM invoice_item_lots')) return withHeldReturn
        ? [{ productId: 'p', lotId: null, vanKey: 'R1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: 5, firstAt: null, src: 'TOT' }]
        : [];
      if (sql.includes('FROM lot_relabels')) return [];
      if (sql.includes('FROM van_load_items')) return [{ productId: 'p', vanKey: 'R1', type: 'LOAD', qty: 10 }];
      throw new Error(`استعلام غير متوقَّع: ${sql}`);
    };
    const { tx } = fakeTx(handler, {
      salesRep: { findMany: async () => [{ id: 'R1' }] },
      productLot: { findMany: async () => [{ id: 'A', productId: 'p', lotNumber: 'A', productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0) }] },
    });
    return (await placeViews(tx, 't1', { vanKeys: ['R1'], productIds: ['p'], withTotals: true })).vans.get('R1')!.get('p')!;
  };
  const before = await views(true);
  assert.deepEqual([before.total!.SELLABLE, before.unknown!.SELLABLE, before.unknownUsable!.SELLABLE], [15, 5, 0], 'المحجوز الكلي من البنود لا من صفوف اللوط');
  const after = await views(false); // أُبطل المرتجع (رفض الهيئة أو السحب): حالته وحدها تتغيّر
  assert.deepEqual([after.total!.SELLABLE, after.unknown!.SELLABLE, after.unknownUsable!.SELLABLE], [10, 0, 0], 'صالح غير المسمّى لم يتغيّر بالإبطال');
});

test('companyDay: منطقة الدفاتر ثم البلد، واليوم المحلي (لا UTC)', async () => {
  const db = (tz: string | null, cc: string | null) => ({
    glSettings: { findUnique: async () => (tz ? { timezone: tz } : null) },
    companySettings: { findUnique: async () => (cc ? { countryCode: cc } : null) },
  }) as unknown as LotTx;
  const at = new Date('2026-11-09T22:30:00Z');
  assert.deepEqual(await companyDay(db('Africa/Cairo', 'SA'), 't1', at), { tz: 'Africa/Cairo', day: '2026-11-10' });
  assert.deepEqual(await companyDay(db(null, 'SA'), 't1', at), { tz: 'Asia/Riyadh', day: '2026-11-10' });
  assert.equal((await companyDay(db(null, null), 't1', new Date('2026-11-09T12:00:00Z'))).day, '2026-11-09');
});
