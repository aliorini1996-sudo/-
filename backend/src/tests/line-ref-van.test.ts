// «مرجع السطر» (lineRef) — حركات السيارة: POST /van-stock/loads يقبل items[].lineRef ويحفظه على البند في كل الأنواع وكل الفروع
// (المطفأة، وغير المتتبَّع والميزة مفعّلة، والإزالة، ومسار اللوط، وتنزيل سيارة المندوب المحذوف D30)، ويعيده كما هو في ردّ الإنشاء
// وGET /loads وGET /movements. فوق Prisma مزيّف في الذاكرة بلا قاعدة.
//
// المحروس: الشكوى «مشاكل اللوط على مستوى السطر» — فالمرجع على البند الواحد مهما تعدّدت صفوف تشغيلاته (D2: البند لا يُشطر)،
// ويبقى مع سطره بعد ترشيح الأسطر الصفرية (موضعه i.at). والعميل الذي لا يرسله (الواجهات وتطبيق المندوب) بندُه كما كان حرفياً:
// لا مفتاح lineRef في بيانات الإنشاء. خطة اللوط نفسها مزيّفة هنا (planVanMovementInTx) — محروسةٌ في lots-van.test.ts،
// والمرجع لا يمسّها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ القاعدة في الذاكرة ═══

const T = 't1';
type Row = Record<string, unknown>;
interface ProductRow { id: string; tenantId: string; name: string; unit: string; code: string; primaryUnitId: string | null; lotTracked: boolean; lotTrackedSince: Date | null; shelfLifeEnabled: boolean; shelfLifeValue: number | null; shelfLifeUnit: string | null }
interface VanLoadRow { id: string; tenantId: string; salesRepId: string | null; deletedSalesRepId: string | null; type: string; note: string | null; createdBy: string | null; locationId: string | null; zeroRunId: string | null; createdAt: Date }
interface VanItemRow { id: string; vanLoadId: string; productId: string; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null; suggestedQty: number | null; expectedQty: number | null; lineRef: string | null }
interface VanItemLotRow { id: string; vanLoadItemId: string; lotId: string | null; qty: number; [k: string]: unknown }
interface InvItemRow { id: string; productId: string | null; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null; returnExpired: boolean | null; lineRef: string | null }
interface InvoiceRow { id: string; tenantId: string; salesRepId: string; number: string; type: string; status: string; returnToStock: boolean | null; returnReason: string | null; createdAt: Date; invoiceDate: Date; teamId?: string | null; items: InvItemRow[] }

interface State {
  tenant: { id: string; lotTrackingEnabled: boolean; warehouseEnabled: boolean; locationsEnabled: boolean };
  products: ProductRow[]; reps: { id: string; tenantId: string; name: string; canManageVanStock: boolean; locationId: string | null }[];
  vanLoads: VanLoadRow[]; vanItems: VanItemRow[]; vanItemLots: VanItemLotRow[]; invoices: InvoiceRow[];
  /** بيانات كل نداء إنشاء كما وصلت (لفحص غياب المفتاح) */
  createData: Row[];
  /** أسطر خطة اللوط كما وصلت إلى المخطِّط */
  planned: { idx: number; productId: string; qty: number }[][];
  scoped: boolean; seq: number; tick: number;
  /** شرط نطاق المستندات للمستخدم المقيَّد (scopedRecordWhere) — {} لغير المقيَّد */
  docScope: Row;
}
let S: State;

const T0 = Date.UTC(2026, 10, 10, 8);
function product(id: string, name: string, extra: Partial<ProductRow> = {}): ProductRow {
  return { id, tenantId: T, name, unit: 'حبة', code: id, primaryUnitId: null, lotTracked: false, lotTrackedSince: null, shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, ...extra };
}
function reset(opts: { lots?: boolean } = {}): void {
  S = {
    tenant: { id: T, lotTrackingEnabled: opts.lots ?? false, warehouseEnabled: true, locationsEnabled: false },
    products: [product('pB', 'عصير', { lotTracked: true }), product('pA', 'حليب', { lotTracked: true }), product('pU', 'ماء')],
    reps: [{ id: 'r1', tenantId: T, name: 'سالم', canManageVanStock: true, locationId: null }],
    vanLoads: [], vanItems: [], vanItemLots: [], invoices: [], createData: [], planned: [], scoped: false, seq: 0, tick: 0, docScope: {},
  };
}
reset();

const nid = (p: string) => `${p}${++S.seq}`;
const clock = () => new Date(T0 + (++S.tick) * 1000);
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in (v as object) ? ((v as { in: unknown[] }).in).includes(row[k]) : row[k] === v));
const productOf = (id: string | null) => S.products.find((p) => p.id === id) ?? null;
const lotsOfItem = (itemId: string) => S.vanItemLots.filter((x) => x.vanLoadItemId === itemId).map((x) => ({ ...x, lot: x.lotId ? { lotNumber: String(x.lotId).toUpperCase(), expiryDate: null } : null }));
/** البند كما تعيده Prisma بـinclude: كل أعمدته (ومنها lineRef) + صنفه + تشغيلاته حين طُلبت */
const itemOut = (row: VanItemRow, include: Row) => ({
  ...row, product: productOf(row.productId),
  ...('lots' in include && { lots: lotsOfItem(row.id) }),
});

const db: Record<string, unknown> = {
  // قفل الأساس (lockBases) وإعادة قراءة التتبّع (assertReturnStillUntracked) وقفل أصناف اللوط (lockLotProducts): FOR KEY SHARE ومهلة القفل
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    if (sql.includes('FOR KEY SHARE')) {
      const ids = values[1] as string[];
      return S.products.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: p.unit, lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince }));
    }
    throw new Error(`SQL غير متوقَّع في المزيّف: ${sql}`);
  },
  $executeRaw: async () => 1,
  tenant: { findUnique: async () => ({ ...S.tenant }) },
  glSettings: { findUnique: async () => null },
  companySettings: { findUnique: async () => null },
  salesRep: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
      const r = S.reps.find((x) => x.id === where.id && x.tenantId === where.tenantId);
      return r ? { ...r, tenant: { locationsEnabled: S.tenant.locationsEnabled, lotTrackingEnabled: S.tenant.lotTrackingEnabled, warehouseEnabled: S.tenant.warehouseEnabled } } : null;
    },
  },
  product: { findMany: async ({ where }: { where: Row }) => S.products.filter((p) => matches(p as unknown as Row, where)).map((p) => ({ ...p, units: [] })) },
  productUnit: { findMany: async () => [] },
  // D2 (التحميل فوق رصيد المستودع يُمنع): رصيد المستودع لأصناف الحركة — وفيرٌ هنا، فهذا الملف لا يحرس الرصيد (van-load-warehouse-guard.test.ts)
  warehouseEntryItem: { findMany: async ({ where }: { where: { productId: { in: string[] } } }) => where.productId.in.map((productId) => ({ productId, qty: 1e6, unitFactor: 1, baseQty: 1e6 })) },
  invoiceItemLot: { findFirst: async () => null },
  // computeStock (رصيد الإزالة)؛ وقراءة رصيد المستودع (D2، مقيّدة بالأصناف) بلا حركات سيارة — الوارد وفير
  vanLoadItem: {
    findMany: async ({ where }: { where: { productId?: unknown; vanLoad: { tenantId: string; salesRepId: string } } }) => 'productId' in where ? [] :
      S.vanItems.map((it) => ({ it, l: S.vanLoads.find((l) => l.id === it.vanLoadId)! }))
        .filter(({ l }) => l.tenantId === where.vanLoad.tenantId && l.salesRepId === where.vanLoad.salesRepId)
        .map(({ it, l }) => ({ productId: it.productId, qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty, vanLoad: { type: l.type, createdAt: l.createdAt } })),
  },
  invoiceItem: {
    findMany: async ({ where }: { where: { invoice: { tenantId: string; salesRepId: string; status: string } } }) =>
      S.invoices.filter((i) => i.tenantId === where.invoice.tenantId && i.salesRepId === where.invoice.salesRepId && i.status === where.invoice.status)
        .flatMap((i) => i.items.map((it) => ({
          productId: it.productId, qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty, returnExpired: it.returnExpired,
          invoice: { type: i.type, returnToStock: i.returnToStock, invoiceDate: i.invoiceDate, returnReason: i.returnReason, createdAt: i.createdAt },
        }))),
  },
  invoice: {
    // GET /movements: الفواتير المؤكَّدة ببنودها (كل الأعمدة) وصنفها وعميلها — ونداء النطاق (id.in + شرط النطاق) بمعرّفاتها وحدها
    findMany: async ({ where }: { where: Row & { tenantId?: string; salesRepId?: string; status?: string } }) =>
      'id' in where
        ? S.invoices.filter((i) => matches(i as unknown as Row, where)).map((i) => ({ id: i.id }))
        : S.invoices.filter((i) => i.tenantId === where.tenantId && i.salesRepId === where.salesRepId && i.status === where.status)
          .map((i) => ({ ...i, customer: { name: 'بقالة النور' }, items: i.items.map((it) => ({ ...it, product: productOf(it.productId) })) })),
  },
  vanLoad: {
    findFirst: async ({ where }: { where: { tenantId: string; deletedSalesRepId: string } }) =>
      S.vanLoads.find((l) => l.tenantId === where.tenantId && l.deletedSalesRepId === where.deletedSalesRepId) ?? null,
    count: async () => S.vanLoads.length,
    findMany: async ({ where, include }: { where: { tenantId: string; salesRepId?: string }; include: { items: { include: Row } } }) =>
      S.vanLoads.filter((l) => l.tenantId === where.tenantId && (!where.salesRepId || l.salesRepId === where.salesRepId)).reverse().map((l) => ({
        ...l, salesRep: S.reps.find((r) => r.id === l.salesRepId) ?? null, location: null,
        items: S.vanItems.filter((it) => it.vanLoadId === l.id).map((it) => itemOut(it, include.items.include)),
      })),
    create: async ({ data, include }: { data: Row & { items: { create: Row[] } }; include: { items: { include: Row } } }) => {
      S.createData.push(data);
      const load: VanLoadRow = {
        id: nid('vl'), tenantId: data.tenantId as string, salesRepId: (data.salesRepId as string | null) ?? null,
        deletedSalesRepId: (data.deletedSalesRepId as string | undefined) ?? null, type: data.type as string, note: (data.note as string | undefined) ?? null,
        createdBy: (data.createdBy as string) ?? null, locationId: (data.locationId as string | undefined) ?? null, zeroRunId: null, createdAt: clock(),
      };
      S.vanLoads.push(load);
      const items = data.items.create.map((c) => {
        const row: VanItemRow = {
          id: nid('vi'), vanLoadId: load.id, productId: c.productId as string, qty: c.qty as number, unitName: (c.unitName as string | null) ?? null,
          unitFactor: (c.unitFactor as number) ?? 1, baseQty: (c.baseQty as number | null) ?? null,
          suggestedQty: (c.suggestedQty as number | null) ?? null, expectedQty: (c.expectedQty as number | null) ?? null,
          // العمود اختياري بلا افتراض: غائبٌ ⇒ null كما في القاعدة
          lineRef: (c.lineRef as string | undefined) ?? null,
        };
        S.vanItems.push(row);
        for (const x of ((c.lots as { create?: Row[] } | undefined)?.create ?? [])) {
          S.vanItemLots.push({ id: nid('vil'), vanLoadItemId: row.id, ...(x as { lotId: string | null; qty: number }) });
        }
        return itemOut(row, include.items.include);
      });
      return { ...load, items };
    },
  },
};
db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
  const snap = { vanLoads: [...S.vanLoads], vanItems: [...S.vanItems], vanItemLots: [...S.vanItemLots], createData: [...S.createData] };
  try {
    return await fn(db);
  } catch (e) {
    Object.assign(S, snap);
    throw e;
  }
};

stub('config/database', { default: db });
stub('middleware/auth', {
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAccounting: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
stub('services/adminScope', {
  canAccessRep: async () => true,
  adminRepFilter: async () => ({}),
  adminScopeEnabled: async () => S.scoped,
  scopedRepRecordWhere: async () => ({}),
  scopedRecordWhere: async () => S.docScope,
  SHAPE_INVOICE_RECEIPT: {},
});
// خطة اللوط مزيّفة: كل سطرٍ متتبَّع يتوزّع على تشغيلتين (مجموعهما كميته الأساسية بإشارتها) — بقية الوحدة حقيقية (vanItemLotColumns)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLotsVan = require('../services/lotsVan') as Record<string, unknown>;
stub('services/lotsVan', {
  ...realLotsVan,
  planVanMovementInTx: async (_tx: unknown, input: { tracked?: unknown; type: string; lines: { idx: number; productId: string; qty: number }[] }) => {
    S.planned.push(input.lines.map((l) => ({ idx: l.idx, productId: l.productId, qty: l.qty })));
    const lines = new Map<number, Row[]>();
    for (const l of input.lines) {
      const sign = Math.sign(l.qty);
      const a = Math.abs(l.qty);
      const first = Math.ceil(a / 2);
      const rows = [{ lotId: `${l.productId}-L1`, qty: sign * first }, ...(a - first > 0 ? [{ lotId: `${l.productId}-L2`, qty: sign * (a - first) }] : [])];
      lines.set(l.idx, rows.map((r) => ({ ...r, certainty: 'CONFIRMED', flags: [], expiryDate: null, viaWarehouse: input.type === 'LOAD' || input.type === 'UNLOAD', reason: null })));
    }
    return { tracked: new Set(input.lines.map((l) => l.productId)), lines, warnings: [] };
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/vanStock').default as Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../middleware/errorHandler') as { errorHandler: (...a: unknown[]) => void };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] }; handle: (...a: unknown[]) => unknown }
const layers = (router as unknown as { stack: Layer[] }).stack;
const errLayer = layers.find((l) => !l.route && l.handle.length === 4)!;
function handler(method: 'get' | 'post', p: string) {
  for (const l of layers) {
    const r = l.route;
    if (r && r.path === p && r.methods[method]) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
interface Res { statusCode: number; body: Record<string, unknown> | null; status(c: number): Res; json(b: unknown): Res }
const ADMIN = { role: 'ADMIN', id: 'adm1', tenantId: T, name: 'مدير' };
const API = { role: 'ADMIN', id: 'adm1', tenantId: T, name: 'مفتاح الربط', apiKeyId: 'k1' };
/** المعالج ثم معالج الموجّه ثم المعالج العام (errorHandler: ZodError ⇒ 400) — كما في الخادم */
async function call(method: 'get' | 'post', p: string, opts: { user?: unknown; body?: unknown; query?: Record<string, string> } = {}): Promise<Res> {
  const res: Res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b as Record<string, unknown>; return this; } };
  const req = { user: opts.user ?? ADMIN, body: opts.body ?? {}, query: opts.query ?? {}, headers: {}, params: {}, path: p, method: method.toUpperCase() };
  let err: unknown = null;
  await handler(method, p)(req, res, (e?: unknown) => { if (e) err = e; });
  if (err) {
    let passed: unknown = null;
    errLayer.handle(err, req, res, (e?: unknown) => { passed = e ?? null; });
    if (passed) errorHandler(passed, req, res, () => undefined);
  }
  return res;
}
const post = (body: Record<string, unknown>, user: unknown = API) => call('post', '/loads', { body, user });
const lastLoad = () => S.vanLoads[S.vanLoads.length - 1];
const refsOf = (loadId: string) => S.vanItems.filter((i) => i.vanLoadId === loadId).map((i) => i.lineRef);
const resItems = (r: Res) => (r.body!.data as { items: (VanItemRow & { lots?: { lotId: string; qty: number }[] })[] }).items;

/** مرتجعٌ مؤكَّد في سيارة المندوب يدخل دلو المنتهي (returnExpired) أو التالف (DAMAGED منذ DAMAGED_VAN_SINCE) — رصيدٌ للإزالة */
function seedReturn(pid: string, qty: number, kind: 'expired' | 'damaged', lineRef: string | null = null): void {
  const at = new Date(Math.max(T0, DAMAGED_VAN_SINCE.getTime()) + (++S.tick) * 1000);
  S.invoices.push({
    id: nid('inv'), tenantId: T, salesRepId: 'r1', number: `R-${S.seq}`, type: 'RETURN', status: 'CONFIRMED', returnToStock: true,
    returnReason: kind === 'damaged' ? 'DAMAGED' : null, createdAt: at, invoiceDate: at,
    items: [{ id: nid('ii'), productId: pid, qty, unitName: null, unitFactor: 1, baseQty: qty, returnExpired: kind === 'expired', lineRef }],
  });
}

// ═══ القبول والتطبيع ═══

test('الميزة مطفأة (المسار القائم): المرجع يُقصّ ويُحفظ على بنده ويعود في الردّ، والفراغ وnull والغياب ⇒ null بلا مفتاح في الإنشاء', async () => {
  reset();
  const r = await post({
    salesRepId: 'r1', type: 'LOAD',
    items: [
      { productId: 'pU', qty: 3, lineRef: '  PO-77/1  ' },
      { productId: 'pB', qty: 2, lineRef: '   ' },
      { productId: 'pA', qty: 1, lineRef: null },
      { productId: 'pU', qty: 4 },
    ],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(refsOf(lastLoad().id), ['PO-77/1', null, null, null]);
  assert.deepEqual(resItems(r).map((i) => i.lineRef), ['PO-77/1', null, null, null], 'ردّ الإنشاء بالمرجع المحفوظ');
  const created = (S.createData[0].items as { create: Row[] }).create;
  assert.equal(created[0].lineRef, 'PO-77/1');
  for (const c of created.slice(1)) assert.ok(!('lineRef' in c), 'الفراغ والغياب وnull: البند كما كان حرفياً (لا مفتاح)');
  assert.ok(!('warnings' in r.body!), 'المسار القائم بلا warnings');
});

test('المرجع ليس فريداً: سطران بالمرجع نفسه وحركتان بالمرجع نفسه تُقبل كلها', async () => {
  reset();
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 1, lineRef: 'X' }, { productId: 'pB', qty: 1, lineRef: 'X' }] })).statusCode, 201);
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 1, lineRef: 'X' }] })).statusCode, 201);
  assert.deepEqual(S.vanItems.map((i) => i.lineRef), ['X', 'X', 'X']);
});

test('الطول: ١٠٠ حرف بعد القصّ يُقبل، و١٠١ أو نوعٌ غير نصّي ⇒ 400 «بيانات غير صحيحة» بلا حركة', async () => {
  reset();
  const ok = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 1, lineRef: ` ${'ق'.repeat(100)} ` }] });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  assert.equal(lastLoad() && refsOf(lastLoad().id)[0], 'ق'.repeat(100));
  for (const lineRef of ['x'.repeat(101), 5, { a: 1 }]) {
    const n = S.vanLoads.length;
    const bad = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 1, lineRef }] });
    assert.equal(bad.statusCode, 400, `${JSON.stringify(lineRef)}: ${JSON.stringify(bad.body)}`);
    assert.match(String(bad.body!.message), /بيانات غير صحيحة/);
    assert.equal(S.vanLoads.length, n, 'لا حركة بعد الرفض');
  }
});

// ═══ كل الأنواع وكل الفروع ═══

test('كل أنواع الحركة بالمسار القائم: LOAD وUNLOAD وADJUST (بالسالب) وEXPIRED_OUT وDAMAGED_OUT — المرجع على بنده', async () => {
  reset();
  seedReturn('pU', 5, 'expired');
  seedReturn('pU', 4, 'damaged');
  const cases: [string, number][] = [['LOAD', 10], ['UNLOAD', 2], ['ADJUST', -1], ['EXPIRED_OUT', 3], ['DAMAGED_OUT', 2]];
  for (const [type, qty] of cases) {
    const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pU', qty, lineRef: `${type}-1` }] });
    assert.equal(r.statusCode, 201, `${type}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([lastLoad().type, refsOf(lastLoad().id)], [type, [`${type}-1`]]);
    assert.equal(resItems(r)[0].lineRef, `${type}-1`);
  }
});

test('الميزة مفعّلة وصنفٌ غير متتبَّع (فرع إعادة قراءة التتبّع D25) والإزالة فيه — المرجع محفوظ ولا خطة لوط', async () => {
  reset({ lots: true });
  seedReturn('pU', 2, 'expired');
  const load = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 6, lineRef: 'U-LOAD' }] });
  assert.equal(load.statusCode, 201, JSON.stringify(load.body));
  const out = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pU', qty: 2, lineRef: 'U-EXP' }] });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  assert.deepEqual(S.vanItems.map((i) => i.lineRef), ['U-LOAD', 'U-EXP']);
  assert.equal(S.planned.length, 0, 'لا خطة لوط لصنفٍ غير متتبَّع');
  assert.equal(S.vanItemLots.length, 0);
});

test('مسار اللوط: البند الواحد يحمل مرجعه وصفوف تشغيلاته معاً (D2)، والمرجع يبقى مع سطره بعد ترشيح الصفري (i.at)', async () => {
  reset({ lots: true });
  const r = await post({
    salesRepId: 'r1', type: 'LOAD',
    items: [
      { productId: 'pU', qty: 0, lineRef: 'ZERO' },
      { productId: 'pB', qty: 5, lineRef: 'B-5' },
      { productId: 'pA', qty: 3 },
      { productId: 'pU', qty: 2, lineRef: 'U-2' },
    ],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body!.warnings), 'ردّ مسار اللوط بتحذيراته');
  assert.deepEqual(S.planned[0].map((l) => [l.idx, l.productId]), [[1, 'pB'], [2, 'pA'], [3, 'pU']], 'أسطر الخطة بمواضعها في الطلب');
  const items = S.vanItems.filter((i) => i.vanLoadId === lastLoad().id);
  assert.deepEqual(items.map((i) => [i.productId, i.lineRef]), [['pB', 'B-5'], ['pA', null], ['pU', 'U-2']], 'بندٌ لكل سطر لا لكل تشغيلة');
  const out = resItems(r);
  assert.deepEqual(out.map((i) => [i.lineRef, (i.lots ?? []).map((l) => [l.lotId, l.qty])]), [
    ['B-5', [['pB-L1', 3], ['pB-L2', 2]]],
    [null, [['pA-L1', 2], ['pA-L2', 1]]],
    ['U-2', [['pU-L1', 1], ['pU-L2', 1]]],
  ], 'ردّ الإنشاء: المرجع والتشغيلات على البند نفسه');
  assert.ok(!S.createData.some((d) => (d.items as { create: Row[] }).create.some((c) => c.lineRef === 'ZERO')), 'السطر الصفري لا يُكتب ولا يزيح مرجع ما بعده');
});

test('مسار اللوط: التنزيل والتسوية بالسالب والإزالة — المرجع على بنده في كل نوع', async () => {
  reset({ lots: true });
  seedReturn('pB', 4, 'expired');
  seedReturn('pB', 3, 'damaged');
  for (const [type, qty] of [['UNLOAD', 2], ['ADJUST', -2], ['EXPIRED_OUT', 4], ['DAMAGED_OUT', 3]] as [string, number][]) {
    const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pB', qty, lineRef: `L-${type}` }] });
    assert.equal(r.statusCode, 201, `${type}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(refsOf(lastLoad().id), [`L-${type}`]);
    assert.equal(resItems(r)[0].lineRef, `L-${type}`);
    assert.ok((resItems(r)[0].lots ?? []).length > 0, `${type}: صفوف التشغيلات مع البند`);
  }
});

test('D30: تنزيل سيارة مندوبٍ محذوف — المرجع على بنده مع deletedSalesRepId وsalesRepId: null', async () => {
  reset({ lots: true });
  S.vanLoads.push({ id: 'old1', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone1', type: 'LOAD', note: null, createdBy: 'ADMIN', locationId: null, zeroRunId: null, createdAt: new Date(T0) });
  const r = await post({ type: 'UNLOAD', deletedSalesRepId: 'gone1', items: [{ productId: 'pB', qty: 2, lineRef: 'GONE-RET-9', lots: [{ lotId: 'pB-L1', qty: 2 }] }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual([lastLoad().salesRepId, lastLoad().deletedSalesRepId, lastLoad().type], [null, 'gone1', 'UNLOAD']);
  assert.deepEqual(refsOf(lastLoad().id), ['GONE-RET-9']);
  assert.equal(resItems(r)[0].lineRef, 'GONE-RET-9');
});

// ═══ القراءات ═══

test('GET /loads وGET /movements: lineRef في كل بند كما حُفظ (نصّاً أو null)، مع withLots وبدونه، وبنود الفواتير في الحركات كذلك', async () => {
  reset({ lots: true });
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 4, lineRef: 'GR-1' }, { productId: 'pU', qty: 1 }] })).statusCode, 201);
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 3, lineRef: 'GR-2' }] })).statusCode, 201);
  const at = new Date(T0 + 99_000);
  S.invoices.push({
    id: 'inv1', tenantId: T, salesRepId: 'r1', number: 'INV-1', type: 'CASH', status: 'CONFIRMED', returnToStock: null, returnReason: null, createdAt: at, invoiceDate: at,
    items: [
      { id: 'ii1', productId: 'pU', qty: 1, unitName: null, unitFactor: 1, baseQty: 1, returnExpired: null, lineRef: 'SO-1/1' },
      { id: 'ii2', productId: 'pU', qty: 1, unitName: null, unitFactor: 1, baseQty: 1, returnExpired: null, lineRef: null },
    ],
  });
  type LoadOut = { type: string; items: { productId: string; lineRef: string | null; lots?: unknown[] }[] };
  const refsByLoad = (r: Res) => (r.body!.data as LoadOut[]).map((l) => l.items.map((i) => i.lineRef));

  const plain = await call('get', '/loads', { query: { salesRepId: 'r1' } });
  assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
  assert.deepEqual(refsByLoad(plain), [['GR-2'], ['GR-1', null]], 'الأحدث أولاً، والمرجع على بنده');
  assert.ok(!('lots' in (plain.body!.data as LoadOut[])[0].items[0]), 'بلا withLots الردّ كما كان');
  const withLots = await call('get', '/loads', { query: { salesRepId: 'r1', withLots: '1' } });
  assert.deepEqual(refsByLoad(withLots), [['GR-2'], ['GR-1', null]]);
  assert.equal(((withLots.body!.data as LoadOut[])[0].items[0].lots ?? []).length, 2, 'التشغيلات مع البند الذي يحمل المرجع');

  const mv = await call('get', '/movements', { query: { salesRepId: 'r1' } });
  assert.equal(mv.statusCode, 200, JSON.stringify(mv.body));
  const rows = mv.body!.data as { kind: string; items: { name: string; lineRef: string | null }[] }[];
  assert.deepEqual(rows.map((m) => [m.kind, m.items.map((i) => i.lineRef)]), [
    ['SALE', ['SO-1/1', null]],
    ['LOAD', ['GR-2']],
    ['LOAD', ['GR-1', null]],
  ], 'المفتاح حاضرٌ دائماً في بنود الحركات والفواتير');
});

test('GET /movements للمستخدم المقيَّد: بند فاتورةٍ خارج نطاقه بلا مرجعه (null كرقمها وعميلها)، وفاتورة نطاقه وحركات السيارة بمراجعها', async () => {
  reset({ lots: true });
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 4, lineRef: 'GR-1' }] })).statusCode, 201);
  const inv = (id: string, number: string, teamId: string, lineRef: string, at: number): InvoiceRow => ({
    id, tenantId: T, salesRepId: 'r1', number, type: 'CASH', status: 'CONFIRMED', returnToStock: null, returnReason: null,
    createdAt: new Date(T0 + at), invoiceDate: new Date(T0 + at), teamId,
    items: [{ id: `${id}-1`, productId: 'pU', qty: 1, unitName: null, unitFactor: 1, baseQty: 1, returnExpired: null, lineRef }],
  });
  S.invoices.push(inv('invMine', 'INV-A', 'tA', 'SO-A/1', 98_000), inv('invOther', 'INV-B', 'tB', 'SO-2026-00123/CUST-RAJHI/1', 99_000));
  type Mv = { kind: string; ref: string; items: { qty: number; lineRef: string | null; lots?: unknown[] }[] };
  const rowsOf = (r: Res) => (r.body!.data as Mv[]).map((m) => [m.kind, m.ref, m.items.map((i) => [i.qty, i.lineRef])]);

  S.docScope = { teamId: 'tA' };
  for (const query of [{ salesRepId: 'r1' }, { salesRepId: 'r1', withLots: '1' }]) {
    const mv = await call('get', '/movements', { query });
    assert.equal(mv.statusCode, 200, JSON.stringify(mv.body));
    assert.deepEqual(rowsOf(mv), [
      ['SALE', 'مستند خارج نطاقك', [[1, null]]],
      ['SALE', 'INV-A · بقالة النور', [[1, 'SO-A/1']]],
      ['LOAD', '', [[4, 'GR-1']]],
    ], `${JSON.stringify(query)}: الكمّية باقية والمرجع مُخفى كالرقم والعميل`);
    assert.ok(!JSON.stringify(mv.body).includes('RAJHI'), 'لا أثر لمرجع المستند الخارج عن النطاق في الردّ');
  }

  // المندوب نفسه وغير المقيَّد: كل المراجع كما حُفظت
  S.docScope = {};
  const all = await call('get', '/movements', { query: { salesRepId: 'r1' } });
  assert.deepEqual(rowsOf(all).map((r) => r[2]), [[[1, 'SO-2026-00123/CUST-RAJHI/1']], [[1, 'SO-A/1']], [[4, 'GR-1']]]);
  S.docScope = { teamId: 'tA' };
  const rep = await call('get', '/movements', { user: { role: 'SALES_REP', id: 'r1', tenantId: T, name: 'سالم' } });
  assert.equal(rep.statusCode, 200, JSON.stringify(rep.body));
  assert.deepEqual(rowsOf(rep).map((r) => r[2]), [[[1, 'SO-2026-00123/CUST-RAJHI/1']], [[1, 'SO-A/1']], [[4, 'GR-1']]], 'المندوب يرى مستنداته كلها');
});
