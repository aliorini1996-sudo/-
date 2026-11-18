// «تتبّع اللوط» — نسبة تشغيلة المرتجع (طلب المالك ١٦ نوفمبر ٢٠٢٦، الشكوى ١: «المرتجع يدخل كـLOT جديد غير مسمى»):
// allocateInvoiceLotsInTx مباشرةً فوق معاملةٍ مزيّفة في الذاكرة — شروط where الحقيقية (Prisma) تُقيَّم على الصفوف المخزّنة،
// واستعلامات طبقات T3 الخام تُعرف بنصّها فتردّ مشاهداتٍ مجهَّزة. لا قاعدة ولا شبكة.
//   • T2 المسمّى أولاً: صفّ بيعٍ «غير معروف» أحدث لا يحجب شراءً مسمّى أقدم، وساعة جهازٍ مسرعة لا تُسقط بيعاً حيّاً للتوّ.
//   • T3: العميل ثم السيارة ثم الشركة، ASSUMED بوسم الطبقة، والكمية والمصدر كما هما، والختم لا يتغيّر، وبلا مرشّح UNKNOWN.
//   • T0: المندوب حيّاً صريحٌ CONFIRMED وخطؤه 422، وفي الإعادة تلميحٌ يُتجاهل مخالفه بتحذير ولا يُرفض المستند.
//   • المرتبط (المرحلة ب): الصريح من تشغيلات بند البيع وحدها وضمن المتبقي، وإلا 422؛ وفي الإعادة يُتجاهل بتحذير.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { LotError, type InvoiceLotLine, type InvoiceLotPlan, type ItemExpiryStamp } from '../services/lots';
import { allocateInvoiceLotsInTx } from '../services/lotsInvoice';
import type { LotTx } from '../services/lotsDb';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const TODAY = '2026-11-18';
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);
const OLD = new Date('2026-01-01T00:00:00Z');

interface Seen { productId: string; lotId: string; lastAt: Date | null }
interface World {
  lots: Row[]; invoices: Row[]; items: Row[]; iil: Row[]; notifications: Row[];
  tiers: { customer: Seen[]; van: Seen[]; company: Seen[] };
  queries: string[];
}

const lot = (id: string, productId: string, expiry: string | null, o: Row = {}): Row => ({
  id, tenantId: 't1', productId, lotNumber: id.toUpperCase(), productionDate: null, expiryDate: expiry ? D(expiry) : null,
  status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: OLD, ...o,
});

function world(): World {
  return {
    lots: [
      lot('l1', 'pM', '2027-01-01'), lot('l2', 'pM', '2027-03-01'), lot('lx', 'pM', '2026-11-01'),
      lot('lb', 'pM', '2027-02-01', { status: 'BLOCKED', blockKind: 'HOLD', blockedAt: OLD }),
      lot('lo', 'pO', '2027-01-01'),                                    // صنفٌ آخر
      { ...lot('lt2', 'pM', '2027-01-01'), tenantId: 't2' },            // شركةٌ أخرى
    ],
    invoices: [], items: [], iil: [], notifications: [],
    tiers: { customer: [], van: [], company: [] },
    queries: [],
  };
}

/** فاتورة بيعٍ ببندٍ واحد وصفوف توزيعه — يعيد معرّف البند ومعرّفات الصفوف */
function sale(w: World, o: { id: string; productId?: string; customerId?: string; at: Date; clientCreatedAt?: Date | null; rows: [string | null, number][] }): { itemId: string; rowIds: string[] } {
  const inv = { id: o.id, tenantId: 't1', customerId: o.customerId ?? 'c1', type: 'CASH', status: 'CONFIRMED', documentKind: null, invoiceDate: o.at, createdAt: o.at, clientCreatedAt: o.clientCreatedAt ?? null };
  w.invoices.push(inv);
  const itemId = `${o.id}-it`;
  const item = { id: itemId, invoiceId: o.id, returnOfItemId: null, creditedItemId: null, invoice: inv };
  w.items.push(item);
  const rowIds = o.rows.map(([lotId, qty], i) => {
    const id = `${o.id}-r${i}`;
    const exp = lotId ? w.lots.find((l) => l.id === lotId)?.expiryDate ?? null : null;
    w.iil.push({ id, tenantId: 't1', invoiceId: o.id, invoiceItemId: itemId, productId: o.productId ?? 'pM', lotId, quantity: qty, certainty: lotId ? 'CONFIRMED' : 'UNKNOWN', expiryDate: exp, createdAt: new Date(o.at.getTime() + i), sourceItemLotId: null, invoiceItem: item });
    return id;
  });
  return { itemId, rowIds };
}

/** مرتجعٌ سابق مرتبط من صفّ بيع (يُنقص المتبقي للإرجاع منه) */
function priorReturn(w: World, sourceRowId: string, qty: number, saleItemId: string): void {
  const inv = { id: `ret-${w.invoices.length}`, tenantId: 't1', customerId: 'c1', type: 'RETURN', status: 'CONFIRMED', documentKind: null, invoiceDate: OLD, createdAt: OLD, clientCreatedAt: null };
  w.invoices.push(inv);
  const item = { id: `${inv.id}-it`, invoiceId: inv.id, returnOfItemId: saleItemId, creditedItemId: null, invoice: inv };
  w.items.push(item);
  const src = w.iil.find((r) => r.id === sourceRowId)!;
  w.iil.push({ ...src, id: `${inv.id}-r0`, invoiceId: inv.id, invoiceItemId: item.id, quantity: qty, sourceItemLotId: sourceRowId, invoiceItem: item });
}

// ═══ مطابقة where (Prisma) على الصفوف ═══

const OPS = new Set(['in', 'notIn', 'not', 'lte', 'gte', 'lt', 'gt']);
const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);
function ops(v: unknown, o: Row): boolean {
  if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
  if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
  if ('not' in o && (o.not === null ? v == null : val(v) === val(o.not))) return false;
  for (const k of ['lte', 'gte', 'lt', 'gt'] as const) {
    if (!(k in o)) continue;
    if (v == null) return false;
    const a = val(v) as number, b = val(o[k]) as number;
    if ((k === 'lte' && !(a <= b)) || (k === 'gte' && !(a >= b)) || (k === 'lt' && !(a < b)) || (k === 'gt' && !(a > b))) return false;
  }
  return true;
}
function match(obj: Row | null | undefined, w: Row): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === 'AND') { if (!(v as Row[]).every((x) => match(obj, x))) return false; continue; }
    if (k === 'OR') { if (!(v as Row[]).some((x) => match(obj, x))) return false; continue; }
    const cur = obj?.[k];
    if (v === null) { if (cur != null) return false; continue; }
    if (v instanceof Date || typeof v !== 'object') { if (val(cur) !== val(v)) return false; continue; }
    const keys = Object.keys(v as Row);
    if (keys.length && keys.every((x) => OPS.has(x))) { if (!ops(cur, v as Row)) return false; continue; }
    if (!match(cur, v as Row)) return false;
  }
  return true;
}

function fakeTx(w: World): LotTx {
  const strip = (r: Row) => { const { invoiceItem: _i, ...rest } = r; return rest; };
  const models: Record<string, Record<string, (a: Row) => unknown>> = {
    tenant: { findUnique: () => ({ id: 't1', lotTrackingEnabled: true, lotTrackingSince: OLD }) },
    product: {
      findMany: ({ where }) => ['pM', 'pO', 'pN'].filter((id) => !where?.id?.in || where.id.in.includes(id)).map((id) => ({ id, lotTrackedSince: null, lotTracked: true })),
      findFirst: ({ where }) => ({ id: where.id, lotTrackedSince: null }),
    },
    productLot: { findMany: ({ where }) => w.lots.filter((l) => match(l, where)) },
    invoiceItemLot: {
      findMany: ({ where, orderBy }) => {
        const rows = w.iil.filter((r) => match(r, where));
        if (Array.isArray(orderBy) && orderBy[0]?.invoiceItem) {
          rows.sort((a, b) => (b.invoiceItem.invoice.invoiceDate - a.invoiceItem.invoice.invoiceDate)
            || (b.invoiceItem.invoice.createdAt - a.invoiceItem.invoice.createdAt) || (a.createdAt - b.createdAt));
        } else rows.sort((a, b) => a.createdAt - b.createdAt);
        return rows.map(strip);
      },
    },
    invoiceItem: { findMany: ({ where }) => w.items.filter((it) => match(it, where)).map((it) => ({ id: it.id, invoiceId: it.invoiceId })) },
    invoice: { findUnique: () => null },
    notification: { create: ({ data }) => { w.notifications.push(data); return data; } },
  };
  const raw = (s: TemplateStringsArray, ...v: unknown[]) => {
    const q = Prisma.sql(s, ...(v as Prisma.Sql[]));
    const sql = q.text.replace(/\s+/g, ' ');
    w.queries.push(sql);
    const pids = new Set((q.values.find((x) => Array.isArray(x)) as string[] | undefined) ?? []);
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    if (sql.includes('FROM products') && sql.includes('FOR KEY SHARE')) return [...pids].map((id) => ({ id, unit: 'حبة', lotTracked: true, lotTrackedSince: null }));
    if (sql.includes('FROM warehouse_entry_items')) return w.tiers.company.filter((r) => pids.has(r.productId));
    if (sql.includes('l."vanKey" =')) return w.tiers.van.filter((r) => pids.has(r.productId));
    if (sql.includes('i."customerId" =')) return w.tiers.customer.filter((r) => pids.has(r.productId));
    throw new Error(`SQL غير متوقَّع: ${sql}`);
  };
  return new Proxy({}, {
    get: (_t, key: string) => {
      if (key === '$queryRaw') return async (s: TemplateStringsArray, ...v: unknown[]) => raw(s, ...v);
      if (key === '$executeRaw') return async () => 1;
      const m = models[key];
      if (!m) throw new Error(`نموذج غير متوقَّع: ${key}`);
      return new Proxy({}, { get: (_x, method: string) => async (a: Row) => { const fn = m[method]; if (!fn) throw new Error(`${key}.${method}`); return fn(a ?? {}); } });
    },
  }) as unknown as LotTx;
}

const line = (o: Partial<InvoiceLotLine> & { qty: number }): InvoiceLotLine =>
  ({ idx: 0, productId: 'pM', productName: 'حليب', unitFactor: 1, saleItemId: null, lotsRaw: undefined, ...o });

function plan(o: Partial<InvoiceLotPlan> & { lines: InvoiceLotLine[] }): InvoiceLotPlan {
  return {
    tenantId: 't1', customerId: 'c1', vanKey: 'r1', docType: 'RETURN', link: 'NONE', actor: 'ADMIN', replay: null,
    day: TODAY, returnDay: TODAY, allowUnknown: true, clientRef: null, fallbackStamps: new Map(), historyAsOf: new Date('2026-11-18T12:00:00Z'),
    ...o,
  };
}

const run = (w: World, p: InvoiceLotPlan) => allocateInvoiceLotsInTx(fakeTx(w), p);
const brief = (rows: Row[]) => rows.map((r) => [r.lotId, r.qty, r.certainty, r.flags.join(','), r.sourceItemLotId ?? null]);
const REPLAY = { at: new Date('2026-11-18T10:00:00Z'), clamped: false };

// ═══ T2: المسمّى أولاً، وساعة الجهاز ═══

test('T2: صفّ بيعٍ «غير معروف» أحدث لا يحجب شراءً مسمّى أقدم — المرتجع يرث L1 بلا تخمين', async () => {
  const w = world();
  const s1 = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 5]] });
  sale(w, { id: 's2', at: new Date('2026-11-12T09:00:00Z'), rows: [[null, 10]] });
  const r = await run(w, plan({ lines: [line({ qty: 3 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 3, 'ASSUMED', '', s1.rowIds[0]]]);
  assert.equal(w.queries.some((q) => q.includes('i."customerId" =')), false, 'لا T3 حين لا يبقى غير مسمّى');
});

test('T2: بيعٌ حيّ بساعة جهازٍ مسرعة (clientCreatedAt بعد حدّ المرتجع ولحظة الرفع قبله) يُورث منه', async () => {
  const w = world();
  const asOf = new Date('2026-11-18T12:00:00Z');
  const s1 = sale(w, { id: 's1', at: new Date('2026-11-18T11:59:00Z'), clientCreatedAt: new Date('2026-11-18T12:03:00Z'), rows: [['l2', 4]] });
  const r = await run(w, plan({ historyAsOf: asOf, lines: [line({ qty: 2 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l2', 2, 'ASSUMED', '', s1.rowIds[0]]]);
});

test('T2: بيعٌ بعد حدّ المرتجع بلحظتيه معاً لا يُورث منه', async () => {
  const w = world();
  sale(w, { id: 's1', at: new Date('2026-11-18T12:05:00Z'), clientCreatedAt: new Date('2026-11-18T12:06:00Z'), rows: [['l2', 4]] });
  const r = await run(w, plan({ lines: [line({ qty: 2 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [[null, 2, 'UNKNOWN', '', null]], 'لا مشاهدات طبقات ⇒ UNKNOWN');
});

// ═══ T3: الطبقات ═══

test('T3: ما فاق مشتريات العميل يأخذ تشغيلة العميل (RETURN_GUESS_CUSTOMER) بلا مصدر، وΣ = كمية السطر', async () => {
  const w = world();
  const s1 = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 5]] });
  w.tiers.customer = [{ productId: 'pM', lotId: 'l1', lastAt: new Date('2026-11-10T09:00:00Z') }];
  w.tiers.van = [{ productId: 'pM', lotId: 'l2', lastAt: new Date('2026-11-17T09:00:00Z') }];
  const r = await run(w, plan({ lines: [line({ qty: 7 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 5, 'ASSUMED', '', s1.rowIds[0]], ['l1', 2, 'ASSUMED', 'RETURN_GUESS_CUSTOMER', null]]);
  assert.equal(r.lines.get(0)!.rows.reduce((s, x) => s + x.qty, 0), 7);
  assert.equal(w.queries.some((q) => q.includes('l."vanKey" =')), false, 'وجد العميل مرشّحاً فلا تُستعلم السيارة');
});

test('T3: عميلٌ بلا مشتريات ⇒ أحدث تشغيلات السيارة (النشطة غير المنتهية أولاً)، والختم لا يتغيّر', async () => {
  const w = world();
  w.tiers.van = [
    { productId: 'pM', lotId: 'lx', lastAt: new Date('2026-11-17T09:00:00Z') },   // منتهية يوم المرتجع
    { productId: 'pM', lotId: 'l2', lastAt: new Date('2026-11-15T09:00:00Z') },
  ];
  const fallback: ItemExpiryStamp = { expiresAt: D('2026-12-01'), returnExpired: false, expirySaleInvoiceId: null };
  const r = await run(w, plan({ lines: [line({ qty: 2 })], fallbackStamps: new Map([[0, fallback]]) }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l2', 2, 'ASSUMED', 'RETURN_GUESS_VAN', null]]);
  assert.deepEqual(r.lines.get(0)!.stamp, fallback, 'المخمَّن لا يقلب الختم (D6/D12)');
});

test('T3: تخمين تشغيلةٍ منتهية لا يقلب returnExpired', async () => {
  const w = world();
  w.tiers.van = [{ productId: 'pM', lotId: 'lx', lastAt: new Date('2026-11-17T09:00:00Z') }];
  const r = await run(w, plan({ lines: [line({ qty: 1 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['lx', 1, 'ASSUMED', 'RETURN_GUESS_VAN', null]]);
  assert.equal(r.lines.get(0)!.stamp, null, 'بلا لقطةٍ قائمة يبقى الختم كما كان لـUNKNOWN');
});

test('T3: بلا سيارة ولا عميل ⇒ تشغيلة الشركة، وصنفٌ بلا تشغيلة مسمّاة في الحقبة يبقى UNKNOWN', async () => {
  const w = world();
  w.tiers.company = [{ productId: 'pM', lotId: 'l1', lastAt: new Date('2026-11-01T09:00:00Z') }];
  const r = await run(w, plan({ vanKey: null, lines: [line({ qty: 2 }), line({ idx: 1, productId: 'pN', productName: 'خبز', qty: 1 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 2, 'ASSUMED', 'RETURN_GUESS_COMPANY', null]]);
  assert.deepEqual(brief(r.lines.get(1)!.rows), [[null, 1, 'UNKNOWN', '', null]]);
  assert.equal(w.queries.some((q) => q.includes('l."vanKey" =')), false, 'بلا vanKey لا طبقة سيارة');
});

test('T3: مشاهدةٌ لتشغيلة صنفٍ آخر أو شركةٍ أخرى لا تُرشَّح (I5)', async () => {
  const w = world();
  w.tiers.customer = [{ productId: 'pM', lotId: 'lo', lastAt: new Date() }, { productId: 'pM', lotId: 'lt2', lastAt: new Date() }];
  const r = await run(w, plan({ vanKey: null, lines: [line({ qty: 1 })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [[null, 1, 'UNKNOWN', '', null]]);
});

test('T3: تشغيلةٌ موقوفة مخمَّنة ⇒ LOT_INTO_BLOCKED مرةً واحدة', async () => {
  const w = world();
  w.tiers.customer = [{ productId: 'pM', lotId: 'lb', lastAt: new Date() }];
  const r = await run(w, plan({ lines: [line({ qty: 1 }), line({ idx: 1, qty: 2 })] }));
  assert.deepEqual(brief(r.lines.get(1)!.rows), [['lb', 2, 'ASSUMED', 'RETURN_GUESS_CUSTOMER', null]]);
  assert.equal(r.warnings.filter((x) => x.code === 'LOT_INTO_BLOCKED').length, 1);
});

test('T3: صريح الإدارة «غير مسمّى» يبقى كما اختير بلا تخمين ولا استعلام طبقات', async () => {
  const w = world();
  w.tiers.customer = [{ productId: 'pM', lotId: 'l1', lastAt: new Date() }];
  const r = await run(w, plan({ lines: [line({ qty: 2, lotsRaw: [{ lotId: null, qty: 2 }] })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [[null, 2, 'UNKNOWN', '', null]]);
  assert.equal(w.queries.some((q) => q.includes('i."customerId" =')), false);
});

// ═══ T0: المندوب ═══

test('T0: المندوب حيّاً يختار تشغيلة المرتجع الحرّ ⇒ CONFIRMED بلا سجلّ ولا تخمين', async () => {
  const w = world();
  sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 5]] });
  const r = await run(w, plan({ actor: 'REP', lines: [line({ qty: 3, lotsRaw: [{ lotId: 'l2', qty: 3 }] })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l2', 3, 'CONFIRMED', '', null]]);
});

test('T0: المندوب حيّاً بتشغيلة شركةٍ أخرى ⇒ 422 LOT_NOT_FOUND، وبتشغيلة صنفٍ آخر ⇒ LOT_PRODUCT_MISMATCH، وبمجموعٍ خاطئ ⇒ LOT_QTY_INVALID', async () => {
  const w = world();
  for (const [lots, code] of [[[{ lotId: 'lt2', qty: 3 }], 'LOT_NOT_FOUND'], [[{ lotId: 'lo', qty: 3 }], 'LOT_PRODUCT_MISMATCH'], [[{ lotId: 'l1', qty: 2 }], 'LOT_QTY_INVALID']] as const) {
    await assert.rejects(run(w, plan({ actor: 'REP', lines: [line({ qty: 3, lotsRaw: lots })] })), (e: unknown) => e instanceof LotError && e.code === code && e.status === 422);
  }
});

test('T0: إعادة المندوب بتلميحٍ صالح ⇒ CONFIRMED، وبمخالفٍ ⇒ يُتجاهل بتحذير ووسم ويكمل بالاستنتاج ولا يُرفض', async () => {
  const w = world();
  const s1 = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 5]] });
  const ok = await run(w, plan({ actor: 'REP', replay: REPLAY, clientRef: 'cr-1', lines: [line({ qty: 2, lotsRaw: [{ lotId: 'l2', qty: 2 }] })] }));
  assert.deepEqual(brief(ok.lines.get(0)!.rows), [['l2', 2, 'CONFIRMED', '', null]]);
  for (const bad of [[{ lotId: 'lt2', qty: 2 }], [{ lotId: 'l2', qty: 1 }], 'خطأ']) {
    const before = w.notifications.length;
    const r = await run(w, plan({ actor: 'REP', replay: REPLAY, clientRef: 'cr-2', lines: [line({ qty: 2, lotsRaw: bad })] }));
    assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 2, 'ASSUMED', 'HINT_REJECTED', s1.rowIds[0]]]);
    assert.deepEqual(r.warnings.map((x) => x.code).sort(), ['LOT_HINT_REJECTED', 'LOT_REPLAY_FLAGGED']);
    assert.equal(w.notifications.length, before + 1, 'إشعار الإدارة كتلميح البيع المرفوض');
  }
});

// ═══ المرتجع المرتبط ═══

test('المرتبط: بيعٌ بصفٍّ «غير معروف» ⇒ تشغيلةٌ مخمَّنة ومصدرها صفّ البيع المرتبط نفسه', async () => {
  const w = world();
  const s = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [[null, 4]] });
  w.tiers.van = [{ productId: 'pM', lotId: 'l1', lastAt: new Date() }];
  const r = await run(w, plan({ link: 'RETURN_OF', lines: [line({ qty: 3, saleItemId: s.itemId })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 3, 'ASSUMED', 'RETURN_GUESS_VAN', s.rowIds[0]]]);
});

test('المرتبط: بند بيعٍ بلا صفوف (قبل الحقبة) ⇒ مخمَّنٌ بلا مصدر، وبلا مرشّح UNKNOWN كما كان', async () => {
  const w = world();
  const s = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [] });
  const none = await run(w, plan({ link: 'RETURN_OF', lines: [line({ qty: 2, saleItemId: s.itemId })] }));
  assert.deepEqual(brief(none.lines.get(0)!.rows), [[null, 2, 'UNKNOWN', '', null]]);
  w.tiers.customer = [{ productId: 'pM', lotId: 'l2', lastAt: new Date() }];
  const got = await run(w, plan({ link: 'CREDITED', lines: [line({ qty: 2, saleItemId: s.itemId })] }));
  assert.deepEqual(brief(got.lines.get(0)!.rows), [['l2', 2, 'ASSUMED', 'RETURN_GUESS_CUSTOMER', null]]);
});

test('المرتبط (المرحلة ب) حيّاً: الاختيار من تشغيلات بند البيع ⇒ CONFIRMED بمصدر صفّه', async () => {
  const w = world();
  const s = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 3], ['l2', 4]] });
  const r = await run(w, plan({ link: 'RETURN_OF', actor: 'REP', lines: [line({ qty: 4, saleItemId: s.itemId, lotsRaw: [{ lotId: 'l1', qty: 1 }, { lotId: 'l2', qty: 3 }] })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 1, 'CONFIRMED', '', s.rowIds[0]], ['l2', 3, 'CONFIRMED', '', s.rowIds[1]]]);
});

test('المرتبط (المرحلة ب) حيّاً: تشغيلةٌ ليست في البيع أو فوق المتبقي ⇒ 422 بسببها', async () => {
  const w = world();
  const s = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 3]] });
  priorReturn(w, s.rowIds[0], 2, s.itemId);
  const reasonOf = (e: unknown) => (e instanceof LotError && e.status === 422 ? e.detail?.reason : null);
  await assert.rejects(run(w, plan({ link: 'RETURN_OF', lines: [line({ qty: 1, saleItemId: s.itemId, lotsRaw: [{ lotId: 'l2', qty: 1 }] })] })),
    (e: unknown) => reasonOf(e) === 'LOT_NOT_IN_SALE');
  await assert.rejects(run(w, plan({ link: 'RETURN_OF', lines: [line({ qty: 2, saleItemId: s.itemId, lotsRaw: [{ lotId: 'l1', qty: 2 }] })] })),
    (e: unknown) => reasonOf(e) === 'LOT_OVER_RETURNABLE' && (e as LotError).detail?.returnable === 1);
  // سطران على البند نفسه يتتابعان: الثاني يرى ما أخذه الأول
  await assert.rejects(run(w, plan({
    link: 'RETURN_OF',
    lines: [line({ qty: 1, saleItemId: s.itemId, lotsRaw: [{ lotId: 'l1', qty: 1 }] }), line({ idx: 1, qty: 1, saleItemId: s.itemId, lotsRaw: [{ lotId: 'l1', qty: 1 }] })],
  })), (e: unknown) => reasonOf(e) === 'LOT_OVER_RETURNABLE');
});

test('المرتبط (المرحلة ب) في الإعادة: الاختيار يُتجاهل بتحذير ووسم ويرث السطر كما لو لم يُرسل', async () => {
  const w = world();
  const s = sale(w, { id: 's1', at: new Date('2026-11-10T09:00:00Z'), rows: [['l1', 3]] });
  const r = await run(w, plan({ link: 'RETURN_OF', actor: 'REP', replay: REPLAY, clientRef: 'cr-3', lines: [line({ qty: 2, saleItemId: s.itemId, lotsRaw: [{ lotId: 'l2', qty: 2 }] })] }));
  assert.deepEqual(brief(r.lines.get(0)!.rows), [['l1', 2, 'CONFIRMED', 'HINT_REJECTED', s.rowIds[0]]]);
  assert.ok(r.warnings.some((x) => x.code === 'LOT_HINT_REJECTED' && x.detail?.reason === 'LINKED_REPLAY'));
});
