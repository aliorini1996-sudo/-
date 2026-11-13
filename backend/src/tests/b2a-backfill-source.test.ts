// «ربط الدفاتر» L1 — scripts/backfillWarehouseEntrySource.ts (لا يُشغَّل آلياً): ملء WarehouseEntry.source للحركات السابقة —
// OPENING_IMPORT من معرّفات دفعات المخزون الافتتاحي، وSTOCK_ZERO لما zeroRunId غير فارغ. تجريبي افتراضياً (عدٌّ بلا كتابة)،
// والكتابة بـ--apply، وآمنٌ للإعادة (لا يلمس إلا 'MANUAL'). على قاعدةٍ في الذاكرة تفهم شروط السكربت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_CHUNK, backfillWarehouseEntrySource, openingEntryIdsByTenant, openingWhere, stockZeroWhere, type BackfillSourceDb,
} from '../../scripts/backfillWarehouseEntrySource';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function memDb(entries: Row[], batches: Row[]) {
  const log: string[] = [];
  const match = (e: Row, w: Row): boolean => Object.entries(w).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(e[k]);
    if (v && typeof v === 'object' && 'not' in v) return v.not === null ? e[k] != null : e[k] !== v.not;
    return e[k] === v;
  });
  const db: BackfillSourceDb = {
    importBatch: {
      findMany: async (a) => { log.push(`importBatch.findMany:${a.where.kind}`); return batches.filter((b) => b.kind === a.where.kind).map((b) => ({ tenantId: b.tenantId, recordIds: b.recordIds })); },
    },
    warehouseEntry: {
      count: async (a) => { log.push('count'); return entries.filter((e) => match(e, a.where)).length; },
      updateMany: async (a) => {
        log.push('updateMany');
        const rs = entries.filter((e) => match(e, a.where));
        rs.forEach((e) => Object.assign(e, a.data));
        return { count: rs.length };
      },
    },
  };
  return { db, log, entries };
}

const E = (id: string, tenantId: string, extra: Row = {}): Row => ({ id, tenantId, type: 'RECEIVE', source: 'MANUAL', zeroRunId: null, ...extra });

function world() {
  const entries = [
    E('o1', 't1'), E('o2', 't1'), E('o3', 't2'),
    E('x1', 't1'), // وارد يدوي عادي — يبقى MANUAL
    E('o4', 't2', { source: 'API' }), // صنّفه الكود الجديد — لا يُمسّ
    E('z1', 't1', { type: 'ADJUST', zeroRunId: 'Z1' }), E('z2', 't2', { type: 'ADJUST', zeroRunId: 'Z2' }),
    E('a1', 't1', { type: 'ADJUST' }),
    E('o5', 't3', { type: 'ADJUST' }), // معرّفٌ في دفعة لكنه ليس وارداً — لا يُمسّ
  ];
  const batches = [
    { tenantId: 't1', kind: 'opening_stock', recordIds: JSON.stringify(['o1', 'o2', 'gone']) },
    { tenantId: 't1', kind: 'opening_stock', recordIds: JSON.stringify(['o2']) }, // تكرار
    { tenantId: 't2', kind: 'opening_stock', recordIds: JSON.stringify(['o3', 'o4', 'o1']) }, // o1 لشركة أخرى ⇒ لا يطابق هنا
    { tenantId: 't3', kind: 'opening_stock', recordIds: JSON.stringify(['o5']) },
    { tenantId: 't1', kind: 'products', recordIds: JSON.stringify({ products: ['x1'], categories: [] }) }, // نوع آخر
    { tenantId: 't1', kind: 'opening_stock', recordIds: 'تالف{' },
  ];
  return memDb(entries, batches);
}

test('openingEntryIdsByTenant: لكل شركة معرّفاتها بلا تكرار، والشكل التالف أو الفارغ يُتجاهل', () => {
  const m = openingEntryIdsByTenant([
    { tenantId: 't1', recordIds: '["a","b"]' }, { tenantId: 't1', recordIds: '["b","c"]' }, { tenantId: 't2', recordIds: '[]' },
    { tenantId: 't3', recordIds: null }, { tenantId: 't4', recordIds: '{bad' },
  ]);
  assert.deepEqual([...m], [['t1', ['a', 'b', 'c']]]);
  assert.deepEqual(openingWhere('t1', ['a']), { tenantId: 't1', id: { in: ['a'] }, type: 'RECEIVE', source: 'MANUAL' });
  assert.deepEqual(stockZeroWhere(), { zeroRunId: { not: null }, source: 'MANUAL' });
});

test('التجريبي (الافتراضي): يعدّ ما سيتغيّر ولا يكتب شيئاً', async () => {
  const w = world();
  const before = JSON.stringify(w.entries);
  const r = await backfillWarehouseEntrySource(w.db, { apply: false });
  assert.deepEqual(r, { apply: false, openingImport: 3, stockZero: 2, tenants: 3 });
  assert.ok(!w.log.includes('updateMany'));
  assert.equal(JSON.stringify(w.entries), before);
  assert.deepEqual(w.log.filter((l) => l.startsWith('importBatch')), ['importBatch.findMany:opening_stock']);
});

test('--apply: الافتتاحي OPENING_IMPORT والتصفير STOCK_ZERO وحدهما — ثم الإعادة لا تغيّر شيئاً', async () => {
  const w = world();
  const r = await backfillWarehouseEntrySource(w.db, { apply: true });
  assert.deepEqual([r.openingImport, r.stockZero], [3, 2]);
  const src = Object.fromEntries(w.entries.map((e) => [e.id, e.source]));
  assert.deepEqual(src, {
    o1: 'OPENING_IMPORT', o2: 'OPENING_IMPORT', o3: 'OPENING_IMPORT', x1: 'MANUAL', o4: 'API', z1: 'STOCK_ZERO', z2: 'STOCK_ZERO', a1: 'MANUAL', o5: 'MANUAL',
  });
  const again = await backfillWarehouseEntrySource(w.db, { apply: true });
  assert.deepEqual([again.openingImport, again.stockZero], [0, 0], 'آمنٌ للإعادة');
  const dry = await backfillWarehouseEntrySource(w.db, { apply: false });
  assert.deepEqual([dry.openingImport, dry.stockZero], [0, 0]);
});

test('المعرّفات الكثيرة تُقطَّع بـID_CHUNK في كل استعلام', async () => {
  const n = ID_CHUNK * 2 + 5;
  const ids = Array.from({ length: n }, (_, i) => `e${i}`);
  const sizes: number[] = [];
  const entries = ids.map((id) => E(id, 't1'));
  const w = memDb(entries, [{ tenantId: 't1', kind: 'opening_stock', recordIds: JSON.stringify(ids) }]);
  const upd = w.db.warehouseEntry.updateMany;
  w.db.warehouseEntry.updateMany = async (a) => { const inIds = (a.where.id as { in: string[] } | undefined)?.in; if (inIds) sizes.push(inIds.length); return upd(a); };
  const r = await backfillWarehouseEntrySource(w.db, { apply: true });
  assert.equal(r.openingImport, n);
  assert.deepEqual(sizes, [ID_CHUNK, ID_CHUNK, 5]);
  assert.ok(entries.every((e) => e.source === 'OPENING_IMPORT'));
});
