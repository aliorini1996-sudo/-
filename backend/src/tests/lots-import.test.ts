// «تتبّع اللوط» — الاستيراد الافتتاحي والتراجع عنه (المواصفة §٨.٢ lots-import، الحزمة B3): التحقق الصرف لصفوف الملف
// (services/importLedger.ts)، والبصمة بلا أعمدة لوط، وخطة اللوطات داخل المعاملة دفعةً واحدة (services/lotsWarehouse.ts)، والتراجع:
// القفل قبل الفحص، والمنع حين استُعملت التشغيلات (ومنه I1/I2 بدلالة الطيّ)، وحذف اليتيم مع LotEvent DELETE — ثم المساران
// الحقيقيان (routes/import.ts) فوق قاعدةٍ مزيّفة تجيب تجميعات SQL من صفوفها (lots-b3-fake.ts). لا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, dateOf, dayOf, type Row } from './lots-b3-fake';
import { IMPORT_ROW_MESSAGES, openingStockContentHash, openingStockProductFinder, productBlockReason, resolveOpeningStockRows } from '../services/importLedger';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const importRoutes = require('../routes/import') as typeof import('../routes/import');
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const lotsW = require('../services/lotsWarehouse') as typeof import('../services/lotsWarehouse');
const { LotError } = require('../services/lots') as typeof import('../services/lots');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };
const ACTOR = { type: 'ADMIN' as const, id: 'ADM', name: 'المدير' };

// ═══ التحقق الصرف للصفوف ═══

const P = [
  { id: 'p1', code: 'A-1', name: 'ماء', taxPct: 0, lotTracked: true, unit: 'حبة', units: [{ name: 'كرتون', factor: 24, isActive: true }] },
  { id: 'p2', code: 'B-2', name: 'حليب', taxPct: 0, lotTracked: true, shelfLifeEnabled: true, shelfLifeValue: 30, shelfLifeUnit: 'DAY' },
  { id: 'p3', code: 'C-3', name: 'سكر', taxPct: 0, lotTracked: false },
];
const find = openingStockProductFinder(P);

test('رموز الصفوف: LOT_REQUIRED وLOT_DATES_INVALID وLOT_QTY_INVALID بعمودها وقيمتها، والرسائل معرَّفة — وإلزام الانتهاء مع الصلاحية تحت القفل للجديد وحده', () => {
  const { lines, errors } = resolveOpeningStockRows([
    { productCode: 'A-1', qty: 5, unitCost: 1 },                                                           // 2: بلا رقم
    { productCode: 'A-1', qty: 5, unitCost: 1, lotNumber: 'x'.repeat(65) },                                // 3: أطول من ٦٤
    { productCode: 'A-1', qty: 5, unitCost: 1, lotNumber: 'L1', productionDate: '2026-13-01' },            // 4: تاريخ إنتاج تالف
    { productCode: 'A-1', qty: 5, unitCost: 1, lotNumber: 'L1', productionDate: '2027-02-01', expiryDate: '2027-01-01' }, // 5: الإنتاج بعد الانتهاء
    { productCode: 'B-2', qty: 5, unitCost: 1, lotNumber: 'M1' },                                          // 6: صلاحية بلا انتهاء — يُحسم تحت القفل (قائمةٌ تُقبل)
    { productCode: 'A-1', qty: 1.00005, unitCost: 1, lotNumber: 'L1' },                                    // 7: خمس خانات بالأساس
    { productCode: 'A-1', qty: 0.12345, unitCost: 1, lotNumber: ' l-٢ ', unit: 'كرتون' },                  // 8: ٢٫٩٦٢٨ بالأساس — مقبول
    { productCode: 'B-2', qty: 2, unitCost: 1, lotNumber: 'M1', expiryDate: '2027-03-31' },                // 9: مقبول
    { productCode: 'C-3', qty: 1.00005, unitCost: 1, lotNumber: 'تُتجاهل', expiryDate: 'تالف' },           // 10: غير متتبَّع كما كان
  ], find, false, { lotsOn: true });
  assert.deepEqual(errors.map((e) => [e.row, e.code, e.field, e.value]), [
    [2, 'LOT_REQUIRED', 'lotNumber', undefined],
    [3, 'LOT_REQUIRED', 'lotNumber', 'x'.repeat(65)],
    [4, 'LOT_DATES_INVALID', 'productionDate', '2026-13-01'],
    [5, 'LOT_DATES_INVALID', 'expiryDate', '2027-01-01'],
    [7, 'LOT_QTY_INVALID', 'qty', '1.00005'],
  ]);
  for (const e of errors) assert.equal(e.message, IMPORT_ROW_MESSAGES[e.code as keyof typeof IMPORT_ROW_MESSAGES]);
  assert.deepEqual(lines, [
    { row: 6, productId: 'p2', qty: 5, unitCost: 1, lot: { lotNumber: 'M1', productionDate: null, expiryDate: null, expiryRequired: true } },
    { row: 8, productId: 'p1', qty: 0.12345, unitCost: 1, unitName: 'كرتون', unitFactor: 24, lot: { lotNumber: 'L-2', productionDate: null, expiryDate: null } },
    { row: 9, productId: 'p2', qty: 2, unitCost: 1, lot: { lotNumber: 'M1', productionDate: null, expiryDate: '2027-03-31', expiryRequired: true } },
    { row: 10, productId: 'p3', qty: 1.00005, unitCost: 1 },
  ]);
});

test('الميزة مطفأة: أعمدة التشغيلة تُتجاهل والبنود بالشكل القديم حرفياً (لا مفتاح lot)، وصفّا الصنف بتشغيلتين يبقيان بندين', () => {
  const off = resolveOpeningStockRows([{ productCode: 'A-1', qty: 5, unitCost: 1 }, { productCode: 'A-1', qty: 1.00005, unitCost: 1, lotNumber: 'L' }], find, false);
  assert.deepEqual(off, { lines: [{ row: 2, productId: 'p1', qty: 5, unitCost: 1 }, { row: 3, productId: 'p1', qty: 1.00005, unitCost: 1 }], errors: [] });
  const two = resolveOpeningStockRows([
    { productCode: 'A-1', qty: 5, unitCost: 1, lotNumber: 'L1' }, { productCode: 'A-1', qty: 7, unitCost: 1, lotNumber: 'L2' },
  ], find, false, { lotsOn: true });
  assert.deepEqual(two.lines.map((l) => [l.row, l.qty, l.lot?.lotNumber]), [[2, 5, 'L1'], [3, 7, 'L2']]);
});

test('البصمة: ملفٌّ بلا أعمدة لوط يعطي البصمة نفسها بعد مخطط الصفوف الجديد، وأعمدة اللوط تغيّرها', () => {
  const raw = [{ productCode: 'A-1', qty: 5, unitCost: 2 }, { productCode: 'C-3', barcode: '111', qty: 1, unitCost: 3, unit: 'حبة' }];
  const parsed = raw.map((r) => importRoutes.openingStockRow.parse(r));
  for (const r of parsed) assert.deepEqual(Object.keys(r).filter((k) => /^lot|Date$/.test(k)), [], 'لا مفتاح لوط في الصف المحلَّل');
  assert.equal(openingStockContentHash(parsed), openingStockContentHash(raw));
  // البصمة قبل الميزة: مخطط الصفوف القديم (بلا أعمدة اللوط) على الصفوف نفسها
  const legacy = raw.map(({ productCode, barcode, qty, unitCost, unit }) => ({ productCode, barcode, qty, unitCost, unit }));
  assert.equal(openingStockContentHash(parsed), openingStockContentHash(legacy));
  const withLot = importRoutes.openingStockRow.parse({ ...raw[0], lotNumber: 'L1', expiryDate: '2027-01-01' });
  assert.notEqual(openingStockContentHash([withLot, parsed[1]]), openingStockContentHash(parsed));
  // والخانات الفارغة كغيابها
  const blanks = importRoutes.openingStockRow.parse({ ...raw[0], lotNumber: '', productionDate: null, expiryDate: '   ' });
  assert.equal(openingStockContentHash([blanks, parsed[1]]), openingStockContentHash(parsed));
});

test('حذف الصنف في التراجع: صنفٌ له تشغيلات ممنوعٌ بسببٍ مكتوب', () => {
  assert.equal(productBlockReason({ invoiceItems: 0, vanLoadItems: 0, warehouseEntryItems: 0, productLots: 2 }), 'للصنف تشغيلات مسجلة');
  assert.equal(productBlockReason({ invoiceItems: 0, vanLoadItems: 0, warehouseEntryItems: 0 }), null, 'الشكل القديم كما كان');
});

// ═══ خطة اللوطات داخل المعاملة (دفعةً واحدة) ═══

function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'p1', code: 'A-1', name: 'ماء' });
  world.product({ id: 'p2', code: 'B-2', name: 'حليب', shelfLifeEnabled: true, shelfLifeValue: 30, shelfLifeUnit: 'DAY' });
  world.product({ id: 'p3', code: 'C-3', name: 'سكر' });
  world.product({ id: 'p4', code: 'D-4', name: 'زيت' });
  world.unit({ id: 'U-CT', productId: 'p1', name: 'كرتون', factor: 24 });
  world.track('p1');
  world.track('p2');
}
const locks = (tracked: string[]) => ({ tracked: new Set(tracked), since: new Map<string, Date | null>() });
const lot = (n: string, p: string | null = null, e: string | null = null) => ({ lotNumber: n, productionDate: p, expiryDate: e });

test('planOpeningLotsInTx: الجديد بمصدر OPENING_IMPORT وsourceEntryId، والقائم يُعاد استعماله، والمخالف والناقص خطأ صفّ لا إنشاء له', async () => {
  fresh();
  const old = world.lot({ id: 'L-OLD', productId: 'p1', lotNumber: 'OLD', expiryDate: dateOf('2027-01-01') });
  const out = await lotsW.planOpeningLotsInTx(db as never, {
    tenantId: 't1', entryId: 'E1', createdBy: 'المدير', actor: ACTOR, locked: locks(['p1', 'p2', 'p4']),
    lines: [
      { row: 2, productId: 'p1', qty: 5, lot: lot('NEW') },
      { row: 3, productId: 'p1', qty: 5, lot: lot('OLD', null, '2027-02-01') },      // يخالف المسجَّل
      { row: 4, productId: 'p1', qty: 2, lot: lot('OLD') },                          // الفارغ يطابق
      { row: 5, productId: 'p2', qty: 1, lot: lot('X', '2026-10-01', '2026-12-31') },
      { row: 6, productId: 'p2', qty: 1, lot: lot('X', null, '2027-12-31') },         // يخالف أول صفوف الرقم في الملف
      { row: 7, productId: 'p3', qty: 9, lot: lot('IGNORED') },                       // لم يعد متتبَّعاً تحت القفل
      { row: 8, productId: 'p4', qty: 3 },                                            // صار متتبَّعاً بعد القراءة المسبقة
      { row: 9, productId: 'p1', qty: 1, lot: lot('REJ', null, '2027-01-01') },
    ],
  });
  assert.deepEqual(out.rejected.map((r) => [r.row, r.code]), [[3, 'LOT_DATES_MISMATCH'], [6, 'LOT_DATES_MISMATCH'], [8, 'LOT_REQUIRED']]);
  assert.deepEqual(out.lines.map((l) => l.row), [2, 4, 5, 7, 9]);
  const NEW = world.lotByNumber('p1', 'NEW')!;
  const X = world.lotByNumber('p2', 'X')!;
  assert.deepEqual([NEW.source, NEW.sourceEntryId, NEW.createdBy], ['OPENING_IMPORT', 'E1', 'المدير']);
  assert.deepEqual([dayOf(X.productionDate), dayOf(X.expiryDate)], ['2026-10-01', '2026-12-31']);
  assert.equal(world.lotByNumber('p3', 'IGNORED'), undefined);
  assert.deepEqual([...out.lotIdByRow], [[2, NEW.id], [4, old.id], [5, X.id], [7, null], [9, world.lotByNumber('p1', 'REJ')!.id]]);
  assert.deepEqual(world.events.map((e) => [e.kind, e.lotId, e.actorType, e.after.source, e.after.sourceEntryId]).sort(),
    [['CREATE', NEW.id, 'ADMIN', 'OPENING_IMPORT', 'E1'], ['CREATE', X.id, 'ADMIN', 'OPENING_IMPORT', 'E1'], ['CREATE', world.lotByNumber('p1', 'REJ')!.id, 'ADMIN', 'OPENING_IMPORT', 'E1']].sort());
});

test('planOpeningLotsInTx: الجرد إلى تشغيلةٍ قائمةٍ موقوفة مقبولٌ بتحذير LOT_INTO_BLOCKED كالوارد اليدوي', async () => {
  fresh();
  world.lot({ id: 'L-H', productId: 'p1', lotNumber: 'H', status: 'BLOCKED', blockKind: 'HOLD', blockedAt: new Date() });
  const out = await lotsW.planOpeningLotsInTx(db as never, {
    tenantId: 't1', entryId: 'E9', createdBy: null, actor: ACTOR, locked: locks(['p1']), lines: [{ row: 2, productId: 'p1', qty: 4, lot: lot('H') }, { row: 3, productId: 'p1', qty: 1, lot: lot('K') }],
  });
  assert.deepEqual(out.warnings.map((w) => [w.code, w.detail?.row, w.detail?.lotId, w.detail?.blockKind]), [['LOT_INTO_BLOCKED', 2, 'L-H', 'HOLD']]);
  assert.equal(out.lotIdByRow.get(2), 'L-H');
});

test('planOpeningLotsInTx: دفعةٌ واحدة لا استعلامٌ لكل صفّ (٤ استعلامات لمئتي صفّ)، وكل الصفوف مرفوضة ⇒ لا إنشاء', async () => {
  fresh();
  const lines = Array.from({ length: 200 }, (_, i) => ({ row: i + 2, productId: 'p1', qty: 1, lot: lot(`N${i % 50}`) }));
  world.calls.length = 0;
  const out = await lotsW.planOpeningLotsInTx(db as never, { tenantId: 't1', entryId: 'E2', createdBy: null, actor: ACTOR, locked: locks(['p1']), lines });
  assert.equal(out.lines.length, 200);
  assert.equal(world.lots.length, 50);
  assert.deepEqual(world.calls.map((c) => c.op), ['productLot.findMany', 'productLot.createMany', 'productLot.findMany', 'lotEvent.createMany']);
  fresh();
  world.lot({ id: 'L-A', productId: 'p1', lotNumber: 'A', expiryDate: dateOf('2027-01-01') });
  world.calls.length = 0;
  const none = await lotsW.planOpeningLotsInTx(db as never, {
    tenantId: 't1', entryId: 'E3', createdBy: null, actor: ACTOR, locked: locks(['p1']),
    lines: [{ row: 2, productId: 'p1', qty: 1, lot: lot('A', null, '2028-01-01') }, { row: 3, productId: 'p1', qty: 1 }],
  });
  assert.equal(none.lines.length, 0);
  assert.equal(world.lots.length, 1);
  assert.ok(!world.calls.some((c) => c.op === 'productLot.createMany' || c.op === 'lotEvent.createMany'));
});

test('planOpeningLotsInTx: الانتهاء إلزامي مع الصلاحية **للجديد وحده** (قاعدة resolveOrCreateLot) — القائم بلا انتهاء يُقبل بالفارغ', async () => {
  fresh();
  const U = world.lot({ id: 'L-U', productId: 'p2', lotNumber: 'U1' });     // قائمة بلا انتهاء
  const req = (n: string, e: string | null = null) => ({ ...lot(n, null, e), expiryRequired: true });
  const out = await lotsW.planOpeningLotsInTx(db as never, {
    tenantId: 't1', entryId: 'E7', createdBy: null, actor: ACTOR, locked: locks(['p2']),
    lines: [
      { row: 2, productId: 'p2', qty: 4, lot: req('U1') },                  // القائمة بالفارغ ⇒ مقبول
      { row: 3, productId: 'p2', qty: 1, lot: req('U1', '2027-01-01') },    // انتهاءٌ لقائمةٍ بلا انتهاء ⇒ MISMATCH (لا تصحيح صامت)
      { row: 4, productId: 'p2', qty: 1, lot: req('N1') },                  // جديدة بلا انتهاء ⇒ إلزامي، ولا تحدّد تاريخي الرقم
      { row: 5, productId: 'p2', qty: 2, lot: req('N1', '2027-03-31') },    // أول صفٍّ مقبول للرقم يُنشئه
      { row: 6, productId: 'p2', qty: 3, lot: req('N1') },                  // الفارغ يطابق ما أُنشئ في الملف
    ],
  });
  assert.deepEqual(out.rejected, [
    { row: 3, code: 'LOT_DATES_MISMATCH', value: 'U1', field: 'lotNumber' },
    { row: 4, code: 'LOT_EXPIRY_REQUIRED', value: 'N1', field: 'expiryDate' },
  ]);
  const N1 = world.lotByNumber('p2', 'N1')!;
  assert.equal(dayOf(N1.expiryDate), '2027-03-31');
  assert.deepEqual([...out.lotIdByRow], [[2, U.id], [5, N1.id], [6, N1.id]]);
  assert.equal(U.expiryDate, null);
});

// ═══ التراجع: القفل قبل الفحص، والمنع، وحذف اليتيم ═══

/** حركة افتتاحية بلوطٍ أنشأته (sourceEntryId) — كما يكتبها الاستيراد */
function opening(lines: { productId: string; qty: number; lotNumber?: string; unitFactor?: number }[], id = 'EO'): { entryId: string; lotIds: Map<string, string> } {
  const lotIds = new Map<string, string>();
  const at = world.now();
  for (const l of lines) {
    if (!l.lotNumber || lotIds.has(l.lotNumber)) continue;
    const lt = world.lot({ id: `L-${l.lotNumber}`, productId: l.productId, lotNumber: l.lotNumber, source: 'OPENING_IMPORT', sourceEntryId: id, createdAt: at });
    lotIds.set(l.lotNumber, lt.id);
  }
  world.entry('RECEIVE', lines.map((l) => ({ productId: l.productId, qty: l.qty, unitFactor: l.unitFactor, lotId: l.lotNumber ? lotIds.get(l.lotNumber)! : null })), at, id);
  return { entryId: id, lotIds };
}
const ref = (entryId: string) => {
  const e = world.entries.find((x) => x.id === entryId)!;
  return { id: e.id, createdAt: e.createdAt, productIds: [...new Set(world.items.filter((i) => i.entryId === e.id).map((i) => i.productId))] };
};
const usedErr = (e: unknown) => e instanceof LotError && e.code === 'LOT_IN_USE' && e.status === 409 && e.message === 'استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد';

test('assertOpeningRevertKeepsLots: يقفل أصناف الحركة قبل أي فحص (مهلة القفل ثم FOR KEY SHARE ثم القفل الاستشاري أولاً)، والحركة غير المستعملة تمرّ', async () => {
  fresh();
  const { entryId } = opening([{ productId: 'p1', qty: 2, unitFactor: 24, lotNumber: 'A' }, { productId: 'p3', qty: 5 }]);
  world.calls.length = 0;
  await lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId));
  const ops = world.calls.map((c) => c.sql ?? c.op);
  // «الوحدة الرئيسية» I10: lock_timeout محلية قبل FOR KEY SHARE على الأصناف، ثم القفل
  const share = ops.findIndex((s) => /FOR KEY SHARE$/.test(s));
  assert.ok(share > 0 && ops.slice(0, share).some((s) => s.includes("set_config('lock_timeout'")), ops.join('\n'));
  assert.ok(ops.slice(0, share).every((s) => s.includes('lock_timeout')), 'لا فحص قبل القفل');
  const lockAt = ops.findIndex((s) => s.includes('pg_advisory_xact_lock'));
  const firstCheck = ops.findIndex((s) => s.endsWith('.count') || s === 'warehouseEntryItem.findMany' || s.includes('FROM warehouse_entry_items'));
  assert.ok(lockAt > 0 && lockAt < firstCheck, ops.join('\n'));
});

test('assertOpeningRevertKeepsLots: تحميلٌ أو تسميةٌ أو تسوية بالنقص على تشغيلاتها بعدها ⇒ LOT_IN_USE «استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد»', async () => {
  for (const use of ['van', 'relabel', 'out'] as const) {
    fresh();
    const { entryId, lotIds } = opening([{ productId: 'p1', qty: 10, lotNumber: 'A' }]);
    const A = lotIds.get('A')!;
    if (use === 'van') world.vanMove('LOAD', 'R1', 'p1', 1, A);
    if (use === 'relabel') world.relabel({ productId: 'p1', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: A, toLotId: null, qty: 1 });
    if (use === 'out') world.entry('ADJUST', [{ productId: 'p1', qty: -1, lotId: A }]);
    await assert.rejects(lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId)), usedErr, use);
  }
  // وما يزيدها بعده (تسميةٌ إليها، أو تنزيلٌ إليها) استعمالٌ كذلك ولو بقي صالحها موجباً: المنع بسببه لا بـI1
  for (const [use, reason] of [['relabel-in', 'RELABEL'], ['unload-in', 'VAN_MOVEMENT']] as const) {
    fresh();
    const { entryId, lotIds } = opening([{ productId: 'p1', qty: 10, lotNumber: 'A' }]);
    const A = lotIds.get('A')!;
    if (use === 'relabel-in') world.relabel({ productId: 'p1', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: A, qty: 2 });
    if (use === 'unload-in') world.vanMove('UNLOAD', 'R1', 'p1', 2, A);
    await assert.rejects(lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId)),
      (e: unknown) => usedErr(e) && (e as InstanceType<typeof LotError>).detail?.reason === reason, use);
  }
});

test('assertOpeningRevertKeepsLots: I2 بدلالة الطيّ — بندٌ بلا تشغيلة (قبل تتبّع صنفه) سُمّي رصيده بعدها يجعل طرحه غير المسمّى سالباً ⇒ ممنوع', async () => {
  fresh();
  // p3 غير متتبَّع عند الاستيراد: بندٌ بلا تشغيلة يدخل غير المسمّى
  const { entryId } = opening([{ productId: 'p3', qty: 10 }]);
  world.track('p3');
  // يوم التفعيل: سُمّي الرصيد كله إلى X — فطرح ١٠ من غير المسمّى (٠) يجعله −١٠
  const X = world.lot({ id: 'L-X', productId: 'p3', lotNumber: 'X' }).id;
  world.relabel({ productId: 'p3', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: X, qty: 10 });
  await assert.rejects(lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId)), (e: unknown) => usedErr(e) && (e as InstanceType<typeof LotError>).detail?.reason === 'REMOVAL');
  // وبلا تسمية يمرّ: غير المسمّى ١٠ يُطرح منه ١٠
  fresh();
  const second = opening([{ productId: 'p3', qty: 10 }], 'EO2');
  world.track('p3');
  await lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(second.entryId));
});

test('assertOpeningRevertKeepsLots بالوحدات: كرتونٌ وخمس حبّات بلا تشغيلة = ٢٩ بالأساس تُطرح من غير المسمّى — بقي ٢٨ ⇒ ممنوع، و٢٩ ⇒ يمرّ', async () => {
  for (const named of [1, 0]) {
    fresh();
    world.unit({ id: 'U-CT3', productId: 'p3', name: 'كرتون', factor: 24 });
    const { entryId } = opening([{ productId: 'p3', qty: 1, unitFactor: 24 }, { productId: 'p3', qty: 5 }]);
    world.track('p3');
    assert.equal(world.warehouseUnknown('p3'), 29);
    if (named) {
      const X = world.lot({ id: 'L-X', productId: 'p3', lotNumber: 'X' }).id;
      world.relabel({ productId: 'p3', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: X, qty: named });
      await assert.rejects(lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId)),
        (e: unknown) => usedErr(e) && (e as InstanceType<typeof LotError>).detail?.wanted === 29, 'الطرح بالأساس لا بكمية السطر (١ + ٥)');
    } else {
      await lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId));
    }
  }
});

test('assertOpeningRevertKeepsLots: الحركة أقدم من حقبة الصنف تُطرح من غير المسمّى لا من لوطها، والصنف غير المتتبَّع الآن بلا فحص', async () => {
  fresh();
  const { entryId } = opening([{ productId: 'p1', qty: 10, lotNumber: 'A' }]);
  // إطفاء وإعادة تفعيل (حقبة جديدة): خام A صفر، والعشرة في غير المسمّى — والتسمية الجديدة منها إلى B تستهلكها
  world.track('p1');
  const B = world.lot({ id: 'L-B', productId: 'p1', lotNumber: 'B' }).id;
  world.relabel({ productId: 'p1', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: B, qty: 10 });
  await assert.rejects(lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId)), usedErr, 'من غير المسمّى (٠) لا من A');
  // الصنف لم يعد متتبَّعاً: لا فحص
  world.products.find((p) => p.id === 'p1')!.lotTracked = false;
  await lotsW.assertOpeningRevertKeepsLots(db as never, 't1', ref(entryId));
});

test('deleteOrphanOpeningLots: يحذف ما أنشأه الاستيراد بلا مرجع مع LotEvent DELETE، ويُبقي المرجوع إليه وما لم يُنشئه', async () => {
  fresh();
  const { entryId, lotIds } = opening([{ productId: 'p1', qty: 10, lotNumber: 'A' }, { productId: 'p1', qty: 5, lotNumber: 'B' }, { productId: 'p2', qty: 1, lotNumber: 'C' }]);
  const other = world.lot({ id: 'L-OTHER', productId: 'p1', lotNumber: 'O' });
  // B له وارد آخر بعده، وC مرجوعٌ إليه من مرتجعٍ حرّ صريح
  world.entry('RECEIVE', [{ productId: 'p1', qty: 1, lotId: lotIds.get('B')! }]);
  world.invLotRefs.push({ lotId: lotIds.get('C')! });
  world.items = world.items.filter((i) => i.entryId !== entryId);
  world.entries = world.entries.filter((e) => e.id !== entryId);
  const n = await lotsW.deleteOrphanOpeningLots(db as never, 't1', entryId, ACTOR);
  assert.equal(n, 1);
  assert.deepEqual(world.lots.map((l) => l.lotNumber).sort(), ['B', 'C', 'O']);
  assert.ok(world.lots.includes(other));
  const ev = world.events.filter((e) => e.kind === 'DELETE');
  assert.deepEqual(ev.map((e) => [e.lotId, e.actorType, e.before.source, e.before.sourceEntryId]), [[lotIds.get('A'), 'ADMIN', 'OPENING_IMPORT', entryId]]);
  assert.equal(await lotsW.deleteOrphanOpeningLots(db as never, 't1', 'NONE'), 0);
});

// ═══ المساران الحقيقيان فوق القاعدة المزيّفة ═══

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row; err?: unknown }> {
  const stack = (importRoutes.default as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { method: method.toUpperCase(), query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  let err: unknown = null;
  for (const h of [...pre, ...layer!.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) return { status: 500, body: { message: (err as Error)?.message }, err };
  return { status: res.statusCode, body: res.body };
}
const importFile = (rows: Row[]) => call('post', '/opening-stock', { body: { rows } });

test('POST /opening-stock: أصناف الملف تُقفل بعد gl-post وقبل فحص الحركات، والبند يحمل تشغيلته، والرفض صفّاً صفّاً', async () => {
  fresh();
  world.lot({ id: 'L-OLD', productId: 'p2', lotNumber: 'OLD', expiryDate: dateOf('2027-01-01') });
  world.calls.length = 0;
  const r = await importFile([
    { productCode: 'A-1', qty: 2, unitCost: 48, unit: 'كرتون', lotNumber: 'a-1' },
    { productCode: 'A-1', qty: 5, unitCost: 2, lotNumber: 'A-2' },
    { productCode: 'B-2', qty: 3, unitCost: 4, lotNumber: 'OLD', expiryDate: '2027-02-01' },   // مخالف ⇒ خطأ صفّ تحت القفل
    { productCode: 'B-2', qty: 3, unitCost: 4, lotNumber: 'NEW' },                             // جديدة بصلاحية بلا انتهاء ⇒ خطأ صفّ تحت القفل
    { productCode: 'C-3', qty: 7, unitCost: 1 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.created, 3);
  assert.deepEqual(r.body.data.errors.map((e: Row) => [e.row, e.code]).sort(), [[4, 'LOT_DATES_MISMATCH'], [5, 'LOT_EXPIRY_REQUIRED']]);
  const entry = world.entries.find((e) => e.id === r.body.data.entryId)!;
  const items = world.items.filter((i) => i.entryId === entry.id);
  const A1 = world.lotByNumber('p1', 'A-1')!;
  assert.deepEqual(items.map((i) => [i.productId, i.baseQty, i.lotId]), [['p1', 48, A1.id], ['p1', 5, world.lotByNumber('p1', 'A-2')!.id], ['p3', 7, null]]);
  assert.deepEqual([A1.source, A1.sourceEntryId], ['OPENING_IMPORT', entry.id], 'الحركة بمعرّفها المولَّد مسبقاً');
  assert.equal(world.warehouseRaw(A1.id), 48);
  const ops = world.calls.map((c) => c.sql ?? c.op);
  const post = ops.findIndex((s) => s.includes('pg_advisory_xact_lock(hashtext('));
  const share = ops.findIndex((s) => s.includes('FOR KEY SHARE'));
  const lotLock = ops.findIndex((s) => s === 'SELECT pg_advisory_xact_lock($1)');
  const create = ops.findIndex((s) => s === 'warehouseEntry.create');
  assert.ok(post >= 0 && post < share && share < lotLock && lotLock < create, ops.join('\n'));
  assert.deepEqual(world.txOpts.at(-1), { maxWait: 10_000, timeout: 30_000 }, 'مهلة الاستيراد القائمة');
});

test('POST /opening-stock: تشغيلةٌ قائمة بلا انتهاء لصنفٍ صار بصلاحية تُقبل بانتهاءٍ فارغ (كالوارد اليدوي)، والجديدة بلا انتهاء LOT_EXPIRY_REQUIRED', async () => {
  fresh();
  // أُنشئت والصلاحية مطفأة ثم فُعّلت — بلا حركة، فالجرد الافتتاحي ما زال مسموحاً
  const U = world.lot({ id: 'L-U', productId: 'p2', lotNumber: 'U1' });
  const r = await importFile([
    { productCode: 'B-2', qty: 4, unitCost: 3, lotNumber: 'u1' },                               // القائمة بلا انتهاء ⇒ مقبول
    { productCode: 'B-2', qty: 2, unitCost: 3, lotNumber: 'U1', expiryDate: '2027-01-01' },     // انتهاءٌ يخالف المسجَّل ⇒ MISMATCH كالوارد
    { productCode: 'B-2', qty: 1, unitCost: 3, lotNumber: 'N1' },                               // جديدة بلا انتهاء ⇒ إلزامي
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.created, 1, JSON.stringify(r.body.data.errors));
  assert.deepEqual(r.body.data.errors.map((e: Row) => [e.row, e.code, e.field, e.value]).sort(),
    [[3, 'LOT_DATES_MISMATCH', 'lotNumber', 'U1'], [4, 'LOT_EXPIRY_REQUIRED', 'expiryDate', 'N1']]);
  for (const e of r.body.data.errors) assert.equal(e.message, IMPORT_ROW_MESSAGES[e.code as keyof typeof IMPORT_ROW_MESSAGES]);
  const items = world.items.filter((i) => i.entryId === r.body.data.entryId);
  assert.deepEqual(items.map((i) => [i.productId, i.baseQty, i.lotId]), [['p2', 4, U.id]]);
  assert.equal(world.lotByNumber('p2', 'N1'), undefined, 'لا لوط لصفٍّ مرفوض');
  assert.equal(U.expiryDate, null, 'لا يُصحَّح تاريخ لوطٍ من استيراد');
});

test('POST /opening-stock: الميزة مطفأة ⇒ أعمدة التشغيلة تُتجاهل والمسار كما كان بلا قفل لوط ولا lotId', async () => {
  fresh();
  world.lotsEnabled = false;
  world.calls.length = 0;
  const r = await importFile([{ productCode: 'A-1', qty: 5, unitCost: 2, lotNumber: 'X' }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.created, 1);
  // «الوحدة الرئيسية» §2.11: قفل حارس الوحدات وحده (lockBases بعد gl-post، FOR KEY SHARE واحد) — لا قفل لوط استشاري ولا تشغيلة
  assert.equal(world.calls.filter((c) => c.sql?.includes('FOR KEY SHARE')).length, 1);
  assert.ok(!world.calls.some((c) => c.sql === 'SELECT pg_advisory_xact_lock($1)' || c.op.startsWith('productLot.')));
  const create = world.calls.find((c) => c.op === 'warehouseEntry.create')!.args as Row;
  assert.ok(!('lotId' in create.data.items.create[0]) && !('id' in create.data));
  assert.equal(world.lots.length, 0);
});

test('POST /opening-stock: صنفٌ صار متتبَّعاً بعد القراءة المسبقة ولا متتبَّع غيره في الملف ⇒ يُقفل في القاعدة وصفّه LOT_REQUIRED لا رصيدٌ غير مسمّى (§٣.١)', async () => {
  fresh();
  const p1 = world.products.find((p) => p.id === 'p1')!;
  p1.lotTracked = false;
  p1.lotTrackedSince = null;
  // المالك يفعّل تتبّع p1 بين القراءة المسبقة والمعاملة (تبديل العلم FOR UPDATE ثم الالتزام)
  const orig = db.product.findMany;
  db.product.findMany = async (a: Row) => {
    const rows = await orig(a);
    db.product.findMany = orig;
    world.track('p1');
    return rows;
  };
  world.calls.length = 0;
  try {
    const r = await importFile([{ productCode: 'A-1', qty: 5, unitCost: 2 }, { productCode: 'C-3', qty: 7, unitCost: 1 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.errors.map((e: Row) => [e.row, e.code]), [[2, 'LOT_REQUIRED']]);
    assert.equal(r.body.data.created, 1);
    const items = world.items.filter((i) => i.entryId === r.body.data.entryId);
    assert.deepEqual(items.map((i) => [i.productId, i.lotId]), [['p3', null]], 'لا رصيد غير مسمّى لصنفٍ متتبَّع تحت القفل');
    const ops = world.calls.map((c) => c.sql ?? c.op);
    const post = ops.findIndex((s) => s.includes('pg_advisory_xact_lock(hashtext('));
    const share = ops.findIndex((s) => s.includes('FOR KEY SHARE'));
    const lotLock = ops.findIndex((s) => s === 'SELECT pg_advisory_xact_lock($1)');
    const create = ops.findIndex((s) => s === 'warehouseEntry.create');
    assert.ok(post >= 0 && post < share && share < lotLock && lotLock < create, ops.join('\n'));
  } finally {
    db.product.findMany = orig;
  }
  // والملف كله غير متتبَّع تحت القفل: قراءة FOR KEY SHARE وحدها، والحركة بشكلها القديم (لا معرّف مولَّد ولا مفتاح lotId)
  fresh();
  world.calls.length = 0;
  const plain = await importFile([{ productCode: 'C-3', qty: 7, unitCost: 1 }, { productCode: 'D-4', qty: 2, unitCost: 3 }]);
  assert.equal(plain.body.data.created, 2, JSON.stringify(plain.body));
  assert.equal(world.calls.filter((c) => c.sql?.includes('FOR KEY SHARE')).length, 1);
  assert.ok(!world.calls.some((c) => c.sql === 'SELECT pg_advisory_xact_lock($1)' || c.op.startsWith('productLot.')));
  const create = world.calls.find((c) => c.op === 'warehouseEntry.create')!.args as Row;
  assert.ok(!('lotId' in create.data.items.create[0]) && !('id' in create.data));
});

test('POST /opening-stock: انشغال قفل التشغيلة ⇒ 409 OPENING_STOCK_LEDGER_BUSY القائم ولا كتابة، والطابور يُحرَّر', async () => {
  fresh();
  world.failOn = (sql) => (sql === 'SELECT pg_advisory_xact_lock($1)' ? Object.assign(new Error('deadlock detected'), { code: '40P01' }) : null);
  const r = await importFile([{ productCode: 'A-1', qty: 5, unitCost: 2, lotNumber: 'X' }]);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'OPENING_STOCK_LEDGER_BUSY');
  assert.equal(world.entries.length, 0);
  assert.equal(world.lots.length, 0);
  world.failOn = null;
  assert.equal((await importFile([{ productCode: 'A-1', qty: 5, unitCost: 2, lotNumber: 'X' }])).body.data.created, 1);
});

test('التراجع عن opening_stock: يحذف الحركة وتشغيلاتها اليتيمة، ويمنع (blocked) حين استُعملت تشغيلاتها — والدفعة تبقى بمعرّفها', async () => {
  fresh();
  const imp = await importFile([{ productCode: 'A-1', qty: 10, unitCost: 2, lotNumber: 'A' }, { productCode: 'C-3', qty: 3, unitCost: 1 }]);
  const batchId = imp.body.data.batchId as string;
  const A = world.lotByNumber('p1', 'A')!.id;
  // تسميةٌ من A بعد الاستيراد (لا تحميل ولا تسوية: لا يلتقطها الحارس القائم) ⇒ ممنوع بسبب التشغيلات
  world.relabel({ productId: 'p1', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: A, toLotId: null, qty: 1 });
  const blocked = await call('post', '/batches/:id/revert', { params: { id: batchId } });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.deepEqual(blocked.body.data.blocked.map((b: Row) => b.reason), ['استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد']);
  assert.equal(blocked.body.data.reverted, false);
  assert.ok(world.entries.some((e) => e.id === imp.body.data.entryId), 'لا حذف');
  assert.ok(world.lotByNumber('p1', 'A'));
  // بعد إزالة التسمية: يُحذف كل شيء، واللوط اليتيم مع LotEvent DELETE
  world.relabels = [];
  world.calls.length = 0;
  const ok = await call('post', '/batches/:id/revert', { params: { id: batchId } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.reverted, true);
  assert.equal(world.entries.length, 0);
  assert.equal(world.lotByNumber('p1', 'A'), undefined);
  assert.ok(world.events.some((e) => e.kind === 'DELETE' && e.lotId === A && e.actorName === 'المدير'));
  // القفل قبل الفحوص القائمة (ن١-١١): FOR UPDATE على الحركة ثم FOR KEY SHARE ثم القفل الاستشاري قبل عدّ التحميلات
  const ops = world.calls.map((c) => c.sql ?? c.op);
  const row = ops.findIndex((s) => s.includes('FROM warehouse_entries WHERE id'));
  const share = ops.findIndex((s) => s.includes('FOR KEY SHARE'));
  const lotLock = ops.findIndex((s) => s === 'SELECT pg_advisory_xact_lock($1)');
  const firstCount = ops.findIndex((s) => s === 'warehouseEntryItem.count' || s === 'vanLoadItemLot.count');
  const del = ops.findIndex((s) => s === 'warehouseEntryItem.deleteMany');
  assert.ok(row >= 0 && row < share && share < lotLock && lotLock < firstCount && firstCount < del, ops.join('\n'));
});

test('التراجع عن opening_stock والميزة مطفأة: تشغيلاتٌ أنشأها الاستيراد تُحذف يتيمةً مع LotEvent DELETE (بلا قفل لوط)، وإعادة الاستيراد بعد التفعيل لا تصطدم بها', async () => {
  fresh();
  const imp = await importFile([{ productCode: 'B-2', qty: 10, unitCost: 2, lotNumber: 'M', expiryDate: '2027-01-01' }, { productCode: 'C-3', qty: 3, unitCost: 1 }]);
  assert.equal(imp.body.data.created, 2, JSON.stringify(imp.body));
  const M = world.lotByNumber('p2', 'M')!.id;
  world.lotsEnabled = false;   // المالك أطفأ الميزة (D8) ثم تراجعت الشركة عن الجرد لتصحيحه
  world.calls.length = 0;
  const ok = await call('post', '/batches/:id/revert', { params: { id: imp.body.data.batchId } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.reverted, true);
  assert.equal(world.entries.length, 0);
  assert.equal(world.lotByNumber('p2', 'M'), undefined, 'لا تشغيلة يتيمة بلا حركة');
  assert.ok(world.events.some((e) => e.kind === 'DELETE' && e.lotId === M && e.before.sourceEntryId === imp.body.data.entryId));
  assert.ok(!world.calls.some((c) => c.sql?.includes('FOR KEY SHARE') || c.sql === 'SELECT pg_advisory_xact_lock($1)'), 'الميزة مطفأة: لا قفل لوط ولا حارس I1/I2');
  // بعد إعادة التفعيل: الرقم نفسه بانتهاءٍ مصحَّح يُنشأ من جديد لا LOT_DATES_MISMATCH مع تشغيلةٍ لم تحمل رصيداً
  world.lotsEnabled = true;
  const again = await importFile([{ productCode: 'B-2', qty: 10, unitCost: 2, lotNumber: 'M', expiryDate: '2027-02-01' }]);
  assert.equal(again.body.data.created, 1, JSON.stringify(again.body));
  assert.equal(dayOf(world.lotByNumber('p2', 'M')!.expiryDate), '2027-02-01');
  // وشركةٌ لم تستعمل التشغيلات قط (الميزة مطفأة من البداية): التراجع بلا أي استعلام لوط (§١٠.١)
  fresh();
  world.lotsEnabled = false;
  const off = await importFile([{ productCode: 'A-1', qty: 5, unitCost: 2, lotNumber: 'X' }]);
  world.calls.length = 0;
  const r = await call('post', '/batches/:id/revert', { params: { id: off.body.data.batchId } });
  assert.equal(r.body.data.reverted, true, JSON.stringify(r.body));
  assert.ok(!world.calls.some((c) => c.op.startsWith('productLot.') || c.op.startsWith('lotEvent.')), world.calls.map((c) => c.op).join('\n'));
});
