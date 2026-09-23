// البند 9 — استيراد المخزون الافتتاحي (opening_stock): التحقق والتكلفة الصافية والرفض بعد التفعيل/البدء والتراجع. صرف + حراس ثابتة، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ImportHttpError, OPENING_STOCK_AFTER_CUTOVER_MESSAGE, OPENING_STOCK_ENTRY_TYPE, OPENING_STOCK_FULL_HISTORY_MESSAGE, OPENING_STOCK_KIND,
  assertOpeningStockAllowed, assertOpeningStockRevertAllowed, draftCutoverDate, draftMethod, importErrorBody, openingStockContentHash,
  openingStockProductFinder, openingStockRevertBlockReason, parseBatchRecordIds, resolveOpeningStockRows, serializeBatchRecordIds,
} from '../services/importLedger';
import {
  OPENING_STOCK_BATCH_KIND, classifyOpeningStockEntries, openingCutoff, openingSnapshotFromDbNow, openingStockCheckJson,
} from '../services/gl/opening';
import { LATE_COMMIT_WINDOW_MS } from '../services/gl/sync/types';
import { zonedStartOfDay } from '../services/gl/dates';
import { netUnitCost } from '../services/warehouseCost';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const TZ = 'Asia/Riyadh';
// 17 سبتمبر 2026 الساعة 23:30 بتوقيت الرياض
const NOW = new Date('2026-09-17T20:30:00.000Z');

const products = [
  { id: 'p1', code: 'A-1', barcode: '111', name: 'أرز بسمتي', taxPct: 15 },
  { id: 'p2', code: 'B-2', barcode: '222', name: 'سكّر ناعم', taxPct: 15 },
  { id: 'p3', code: 'C-3', barcode: '222', name: 'زيت', taxPct: 0 },
  { id: 'p4', code: 'D-4', barcode: null, name: 'زيت', taxPct: 5 },
  { id: 'p5', code: 'E-5', barcode: null, name: 'مكرونة إيطالية', taxPct: 15 },
];
const find = openingStockProductFinder(products);

function httpErr(fn: () => void): ImportHttpError {
  try { fn(); } catch (e) { assert.ok(e instanceof ImportHttpError); return e; }
  assert.fail('متوقع ImportHttpError');
}

test('مطابقة الصنف: الكود حكمٌ نهائي (البند 35)، وبلا كود الباركود ثم الاسم المطبَّع؛ والمشترك بين صنفين لا يطابق', () => {
  assert.equal(find({ productCode: ' A-1 ' })?.id, 'p1');
  assert.equal(find({ barcode: '111' })?.id, 'p1');
  // البند 35: كود مكتوب وغير موجود ⇒ لا سقوط إلى الباركود ولا إلى الاسم (كان يكتب جرد صنف آخر بصمت)
  assert.equal(find({ productCode: 'غير-موجود', barcode: '111' }), null, 'كود غير موجود لا يسقط إلى الباركود');
  assert.equal(find({ productCode: 'غير-موجود', productName: 'أرز بسمتي' }), null, 'كود غير موجود لا يسقط إلى الاسم');
  assert.equal(find({ productName: 'مكرونه ايطاليه' })?.id, 'p5', 'التاء المربوطة والهمزة');
  assert.equal(find({ barcode: '222' }), null, 'باركود مشترك');
  assert.equal(find({ productName: 'زيت' }), null, 'اسم مشترك');
  assert.equal(find({ productCode: 'C-3', productName: 'زيت' })?.id, 'p3', 'الكود يحسم');
  assert.equal(find({}), null);
});

test('الصفوف: الكمية والتكلفة > 0، والصنف غير الموجود صف في errors لا يُسقط الطلب، ورقم السطر = الفهرس + 2', () => {
  const { lines, errors } = resolveOpeningStockRows([
    { productCode: 'A-1', qty: 10, unitCost: 5 },
    { productCode: 'X-9', qty: 1, unitCost: 1 },
    { productCode: 'B-2', qty: 0, unitCost: 3 },
    { productCode: 'B-2', qty: -2, unitCost: 3 },
    { productCode: 'B-2', qty: 2, unitCost: 0 },
    { productCode: 'B-2', qty: 2 },
    { productCode: 'B-2', qty: 2, unitCost: 0.00001 },
    { productCode: 'E-5', qty: 2.5, unitCost: 3.3333 },
  ], find, false);
  assert.deepEqual(lines, [
    { row: 2, productId: 'p1', qty: 10, unitCost: 5 },
    { row: 9, productId: 'p5', qty: 2.5, unitCost: 3.3333 },
  ]);
  assert.deepEqual(errors.map((e) => e.row), [3, 4, 5, 6, 7, 8]);
  assert.match(errors[0].message, /الصنف غير موجود/);
  assert.match(errors[1].message, /الكمية/);
  assert.match(errors[3].message, /تكلفة الوحدة/);
  assert.match(errors[5].message, /صفرية/, 'تكلفة تُقرَّب إلى صفر (4 منازل) مرفوضة');
});

test('التكلفة الصافية بمنطق netUnitCost نفسه: «شاملة الضريبة» تُردّ بنسبة ضريبة الصنف، وإلا كما كُتبت', () => {
  const rows = [{ productCode: 'A-1', qty: 3, unitCost: 11.5 }, { productCode: 'D-4', qty: 1, unitCost: 10.5 }, { productCode: 'C-3', qty: 1, unitCost: 7 }];
  const inc = resolveOpeningStockRows(rows, find, true).lines.map((l) => l.unitCost);
  assert.deepEqual(inc, [netUnitCost(11.5, 15, true), netUnitCost(10.5, 5, true), netUnitCost(7, 0, true)]);
  assert.deepEqual(inc, [10, 10, 7]);
  const net = resolveOpeningStockRows(rows, find, false).lines.map((l) => l.unitCost);
  assert.deepEqual(net, [11.5, 10.5, 7]);
});

test('بعد التفعيل ⇒ 409 OPENING_STOCK_LEDGER_ACTIVE؛ والتراجع بعده ⇒ 409 OPENING_STOCK_REVERT_LEDGER_ACTIVE', () => {
  const e = httpErr(() => assertOpeningStockAllowed({ activatedAt: new Date('2026-09-01T00:00:00Z'), setupDraft: null, timezone: TZ, now: NOW }));
  assert.equal(e.status, 409);
  assert.equal(e.code, 'OPENING_STOCK_LEDGER_ACTIVE');
  const r = httpErr(() => assertOpeningStockRevertAllowed(new Date('2026-09-01T00:00:00Z')));
  assert.equal(r.status, 409);
  assert.equal(r.code, 'OPENING_STOCK_REVERT_LEDGER_ACTIVE');
  assert.doesNotThrow(() => assertOpeningStockRevertAllowed(null));
});

test('مسودة المعالج بتاريخ بدء ≤ اليوم (بتوقيت الشركة) ⇒ 409 OPENING_STOCK_AFTER_CUTOVER برسالة صادقة ما لم يُقَرّ؛ بلا تاريخ أو بعد اليوم مسموح', () => {
  const draft = (cutoverDate: unknown) => ({ step1: { cutoverDate } });
  for (const d of ['2026-09-17', '2026-01-01']) {
    const e = httpErr(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: draft(d), timezone: TZ, now: NOW }));
    assert.equal(e.status, 409);
    assert.equal(e.code, 'OPENING_STOCK_AFTER_CUTOVER');
    assert.equal(e.message, OPENING_STOCK_AFTER_CUTOVER_MESSAGE);
    assert.doesNotMatch(e.message, /عدّل تاريخ البدء في المعالج/, 'المعالج لا يقبل تاريخ بدء مستقبلياً اليوم');
    assert.match(e.message, /بعد يوم الاستيراد/);
    assert.match(e.message, /من الغد/);
    const body = importErrorBody(e);
    assert.equal(body.cutoverDate, d);
    assert.equal(body.today, '2026-09-17');
    assert.equal(body.minCutoverDate, '2026-09-18');
    assert.equal(body.field, 'acknowledgeCutoverChange');
    // الإقرار يسمح (الحسم في /setup/commit)، وfalse أو غيابه لا
    assert.doesNotThrow(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: draft(d), timezone: TZ, now: NOW, acknowledgeCutoverChange: true }));
    assert.equal(httpErr(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: draft(d), timezone: TZ, now: NOW, acknowledgeCutoverChange: false })).code, 'OPENING_STOCK_AFTER_CUTOVER');
  }
  // الإقرار لا يتجاوز التفعيل
  assert.equal(httpErr(() => assertOpeningStockAllowed({ activatedAt: new Date('2026-09-01T00:00:00Z'), setupDraft: draft('2026-09-17'), timezone: TZ, now: NOW, acknowledgeCutoverChange: true })).code, 'OPENING_STOCK_LEDGER_ACTIVE');
  // 23:30 الرياض = 20:30 UTC: في UTC ما زال 17، وفي توقيت +5 صار 18 ⇒ 18 سبتمبر مرفوض هناك ومسموح في الرياض
  assert.doesNotThrow(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: draft('2026-09-18'), timezone: TZ, now: NOW }));
  assert.equal(httpErr(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: draft('2026-09-18'), timezone: 'Asia/Karachi', now: NOW })).code, 'OPENING_STOCK_AFTER_CUTOVER');
  for (const d of [null, undefined, {}, { step1: {} }, draft('2026-02-31'), draft(''), 'x', []]) {
    assert.doesNotThrow(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: d, timezone: TZ, now: NOW }));
  }
  assert.equal(draftCutoverDate(draft('2026-10-01')), '2026-10-01');
  assert.equal(draftCutoverDate(draft('2026-02-30')), null);
});

test('البصمة: ثابتة مع ترتيب الصفوف ومع خيار «شاملة الضريبة» (البند 16)، وتختلف بتغيّر صف؛ recordIds مصفوفة معرّف الحركة', () => {
  const rows = [{ productCode: 'A-1', qty: 10, unitCost: 5 }, { barcode: '111', qty: 1, unitCost: 2 }];
  const h = openingStockContentHash(rows);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(openingStockContentHash([...rows].reverse()), h);
  // البند 16: الملف نفسه بالخيار الآخر تكرار لا دفعة ثانية (الخيار لم يعد في البصمة)
  assert.equal(openingStockContentHash(rows), h);
  assert.notEqual(openingStockContentHash([{ ...rows[0], qty: 11 }, rows[1]]), h);
  assert.equal(OPENING_STOCK_KIND, 'opening_stock');
  assert.equal(OPENING_STOCK_ENTRY_TYPE, 'RECEIVE');
  const ser = serializeBatchRecordIds(OPENING_STOCK_KIND, ['e1']);
  assert.equal(ser, '["e1"]');
  assert.deepEqual(parseBatchRecordIds(ser).records, ['e1']);
});

// البند 34: الدالّة نفسها لم تتغيّر، لكن المسار صار يمرّر invoiceItems: 0 — الفاتورة لا تمسّ رصيد المستودع
// (انظر الحارس الثابت لتراجع opening_stock أدناه). الحقل يبقى في التوقيع حتى تُنظَّف importLedger.ts.
test('حارس التراجع: تحميل سيارات أو فواتير أو تسوية بالنقص بعد الحركة ⇒ blocked', () => {
  assert.equal(openingStockRevertBlockReason({ vanLoads: 0, invoiceItems: 0, warehouseOut: 0 }), null);
  assert.match(openingStockRevertBlockReason({ vanLoads: 1, invoiceItems: 0, warehouseOut: 0 })!, /السيارات/);
  assert.match(openingStockRevertBlockReason({ vanLoads: 0, invoiceItems: 2, warehouseOut: 0 })!, /فواتير/);
  assert.match(openingStockRevertBlockReason({ vanLoads: 0, invoiceItems: 0, warehouseOut: 1 })!, /بالنقص/);
});

// ═══ حراس ثابتة على المسار ═══

function handlerBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `لم يُعثر على ${marker}`);
  const end = src.indexOf('\nrouter.', start + marker.length);
  return src.slice(start, end < 0 ? undefined : end);
}
function assertOrder(body: string, parts: string[], label: string) {
  let pos = -1;
  for (const p of parts) {
    const i = body.indexOf(p, pos + 1);
    assert.ok(i > pos, `${label}: «${p}» مفقود أو خارج الترتيب`);
    pos = i;
  }
}

test('حارس ثابت: POST /opening-stock — الرفض والبصمة قبل الكتابة، والكتابة تحت قفل gl-post بإعادة الفحص، وحركة RECEIVE واحدة ودفعة', () => {
  const src = read('routes/import.ts');
  const body = handlerBody(src, "router.post('/opening-stock'");
  assert.match(body, /requireAccounting/);
  assert.match(body, /'WAREHOUSE_NOT_ENABLED'/);
  assertOrder(body, [
    'const preSettings = await settingsOf(prisma)', 'guard(preSettings, new Date())', 'openingStockContentHash(', 'assertNotDuplicateBatch(', 'resolveOpeningStockRows(',
    'prisma.$transaction(', 'acquirePostLock(tx, tid)', 'guard(await settingsOf(tx)', 'assertNotDuplicateBatch(',
    'tx.warehouseEntry.create(', 'type: OPENING_STOCK_ENTRY_TYPE', 'items: { create:', 'tx.importBatch.create(', 'kind: OPENING_STOCK_KIND', 'contentHash',
  ], '/opening-stock');
  assert.equal((body.match(/warehouseEntry\.create\(/g) ?? []).length, 1, 'حركة واحدة');
  assert.match(body, /sendImportError\(err, res, next\)/);
  // لا خطاف ولا حساب افتتاح في المسار: المسموح من services/gl/opening قاعدتا التاريخ الصرفتان وحدهما (البند 39)
  assert.doesNotMatch(src, /from '\.\.\/services\/gl\/opening'/, 'المسار لا يستورد من حساب الافتتاح — قاعدتا التاريخ في services/importLedger.ts (البند 39، الإغلاقة)');
  // ولا يُستدعى شيء من حساب الافتتاح أو الترحيل في مسار المخزون الافتتاحي
  assert.doesNotMatch(src, /loadOpening|buildOpeningMove|openingCutoff|postMove\(/);
});

test('حارس ثابت: تراجع opening_stock — 409 بعد التفعيل قبل الحلقة وتحت القفل، وفحص الاستهلاك قبل الحذف', () => {
  const src = read('routes/import.ts');
  const start = src.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)", start));
  assertOrder(body, [
    'assertOpeningStockRevertAllowed(', 'for (const eid of ids)', 'acquirePostLock(tx, tid)', 'assertOpeningStockRevertAllowed(',
    'FOR UPDATE', 'openingStockRevertBlockReason(', "type: 'LOAD'", 'invoiceItems: 0', 'qty: { lt: 0 }',
    "status: 'blocked'", 'tx.warehouseEntryItem.deleteMany(', 'tx.warehouseEntry.deleteMany(',
  ], 'revert opening_stock');
  assert.match(body, /if \(isImportHttpError\(e\)\) throw e;/);
  // البند 34: الفاتورة لا تمسّ رصيد المستودع، فلا تُعدّ ولا تمنع التراجع — المانع ما يمسّه وحده
  assert.doesNotMatch(body, /invoiceItem\.count\(/, 'الفواتير ما زالت تمنع التراجع عن المخزون الافتتاحي');
});

// ═══ البند 15 (إغلاقة الدفعة 2): فحص «للصنف حركات سابقة» مُقطَّع فلا يطول حبس قفل gl-post ═══

/** تقطيع كما في import.ts (idChunks) */
function chunkOf<T>(ids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** محاكاة الفحص كما في import.ts: شرائح groupBy، وما ثبتت حركته في المستودع لا يُسأل عنه في التحميلات */
function movedCheck(productIds: string[], stock: { warehouse: ReadonlySet<string>; van: ReadonlySet<string> }, size = 200) {
  const queries: { table: 'warehouse' | 'van'; ids: string[] }[] = [];
  const moved = new Set<string>();
  for (const part of chunkOf(productIds, size)) {
    queries.push({ table: 'warehouse', ids: part });
    for (const id of part) if (stock.warehouse.has(id)) moved.add(id);
  }
  for (const part of chunkOf(productIds.filter((id) => !moved.has(id)), size)) {
    queries.push({ table: 'van', ids: part });
    for (const id of part) if (stock.van.has(id)) moved.add(id);
  }
  return { moved, queries };
}

test('البند 15: الفحص مُقطَّع (200) بالنتيجة نفسها، ولا شريحة تتجاوز الحجم، وما ثبتت حركته لا يُسأل عنه في التحميلات', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `p${i + 1}`);
  const warehouse = new Set(['p1', 'p500', 'p999']);
  const van = new Set(['p1', 'p7', 'p1000']);
  const r = movedCheck(ids, { warehouse, van });
  // النتيجة اتحاد المجموعتين نفسه (كما القراءة دفعةً واحدة قبل التقطيع) ⇒ قائمة الممنوع لا تتغير
  assert.deepEqual([...r.moved].sort(), [...new Set([...warehouse, ...van])].sort());
  assert.ok(r.queries.every((q) => q.ids.length <= 200), 'شريحة أكبر من الحدّ');
  assert.equal(r.queries.filter((q) => q.table === 'warehouse').length, 5, '1000 صنف ⇒ 5 شرائح');
  const vanIds = r.queries.filter((q) => q.table === 'van').flatMap((q) => q.ids);
  assert.equal(vanIds.length, 997);
  for (const id of warehouse) assert.equal(vanIds.includes(id), false, `${id} سُئل عنه مرتين`);
  // ملف صغير ⇒ استعلام لكل جدول، وملف بلا أصناف ⇒ لا استعلام أصلاً
  assert.equal(movedCheck(['p1', 'p2'], { warehouse: new Set(), van: new Set() }).queries.length, 2);
  assert.equal(movedCheck([], { warehouse: new Set(), van: new Set() }).queries.length, 0);
});

test('حارس ثابت (البند 15): الفحص بشرائح idChunks بمعرّفات الشريحة وحدها، بلا قراءة كل الأصناف دفعةً واحدة', () => {
  const src = read('routes/import.ts');
  const body = handlerBody(src, "router.post('/opening-stock'");
  const start = body.indexOf('const productIds = ');
  assert.ok(start > 0);
  const check = body.slice(start, body.indexOf('openingStockMovementConflicts(', start));
  assert.equal((check.match(/for \(const part of idChunks\(/g) ?? []).length, 3, 'استعلام غير مُقطَّع تحت القفل');
  assert.doesNotMatch(check, /productId: \{ in: productIds \}/, 'قراءة كل أصناف الملف دفعةً واحدة');
  assert.match(check, /productIds\.filter\(id => !movedProductIds\.has\(id\)\)/, 'التحميلات تُسأل عمّا ثبتت حركته');
  assert.match(check, /select: \{ productId: true, entryId: true \}/, 'صفوف كاملة إلى الذاكرة');
  assert.match(src, /const STOCK_CHECK_CHUNK = 200;/);
});

test('العقد (البند K): الخريطة تحمل {id, createdAt} والتوقيت يُمرَّر — فالمالك يرى تاريخ الدفعة لا معرّفها', () => {
  const body = handlerBody(read('routes/import.ts'), "router.post('/opening-stock'");
  assert.match(body, /const tz = importTimezone\(preSettings\)/);
  assert.match(body, /select: \{ id: true, recordIds: true, createdAt: true \}/);
  assert.match(body, /openingEntryBatch\.set\(eid, \{ id: ob\.id, createdAt: ob\.createdAt \}\)/);
  assert.match(body, /openingStockMovementConflicts\(lines, \{ movedProductIds, openingBatchOf, timezone: tz \}\)/);
  // التوقيت يُقرأ قبل المعاملة فلا قراءة إضافية تحت قفل gl-post
  assert.ok(body.indexOf('const tz = importTimezone(preSettings)') < body.indexOf('prisma.$transaction('));
});

test('warehouse.ts لم يتغير سلوكه: ما زال يستدعي netUnitCost نفسه من services/warehouseCost', () => {
  const wh = read('routes/warehouse.ts');
  assert.match(wh, /import \{ netUnitCost, entryTotalCost, lineCost \} from '\.\.\/services\/warehouseCost';/);
  assert.match(wh, /netUnitCost\(i\.unitCost, taxOf\.get\(i\.productId\) \?\? 0, data\.costsIncludeTax\)/);
  assert.match(read('services/importLedger.ts'), /import \{ netUnitCost \} from '\.\/warehouseCost';/);
});

// ═══ مراجعة الجولة 2: التاريخ الكامل، والحركات خارج الافتتاح، وحراس الاعتماد ═══

test('FULL_HISTORY في المسودة ⇒ 409 OPENING_STOCK_FULL_HISTORY بلا تاريخ وبتاريخ مستقبلي، ولو مع الإقرار', () => {
  for (const step1 of [undefined, {}, { cutoverDate: '2026-10-01' }, { cutoverDate: '2026-09-01' }]) {
    const e = httpErr(() => assertOpeningStockAllowed({
      activatedAt: null, setupDraft: { step1, step2: { method: 'FULL_HISTORY' } }, timezone: TZ, now: NOW, acknowledgeCutoverChange: true,
    }));
    assert.equal(e.status, 409);
    assert.equal(e.code, 'OPENING_STOCK_FULL_HISTORY');
    assert.equal(e.message, OPENING_STOCK_FULL_HISTORY_MESSAGE);
    assert.deepEqual(e.details, { method: 'FULL_HISTORY' });
  }
  // OPENING أو بلا طريقة ⇒ القاعدة العادية
  assert.doesNotThrow(() => assertOpeningStockAllowed({ activatedAt: null, setupDraft: { step2: { method: 'OPENING' } }, timezone: TZ, now: NOW }));
  assert.equal(draftMethod({ step2: { method: 'FULL_HISTORY' } }), 'FULL_HISTORY');
  assert.equal(draftMethod({ step2: { method: 'OPENING' } }), 'OPENING');
  for (const d of [null, {}, { step2: null }, { step2: { method: 'x' } }, { step2: [] }, 'x']) assert.equal(draftMethod(d), null);
  // التفعيل أولاً
  assert.equal(httpErr(() => assertOpeningStockAllowed({ activatedAt: new Date('2026-09-01T00:00:00Z'), setupDraft: { step2: { method: 'FULL_HISTORY' } }, timezone: TZ, now: NOW })).code, 'OPENING_STOCK_LEDGER_ACTIVE');
});

test('الحركات خارج الافتتاح: createdAt = بداية تاريخ البدء خارجه (AFTER_CUTOVER)، وأحدث من T0 قبل البدء TOO_RECENT، وcreatedAt = T0 داخله', () => {
  assert.equal(OPENING_STOCK_BATCH_KIND, OPENING_STOCK_KIND);
  const start = zonedStartOfDay('2026-09-18', TZ);
  const commitAt = new Date(start.getTime() + 3 * 60_000); // 00:03 يوم 18 بتوقيت الرياض
  const T0 = openingSnapshotFromDbNow(commitAt); // 23:53 يوم 17
  const cut = openingCutoff('2026-09-18', TZ, T0);
  assert.equal(cut.cutoverStart.getTime(), start.getTime());
  const row = (entryId: string, createdAt: Date, items: { qty: number; unitCost: number | null }[] = [{ qty: 2, unitCost: 10.5 }]) =>
    ({ batchId: `b-${entryId}`, entryId, createdAt, items });
  const r = classifyOpeningStockEntries([
    row('at-start', start),
    row('after', new Date(start.getTime() + 60_000), [{ qty: 3, unitCost: 1 }, { qty: 1, unitCost: null }]),
    row('before-start-late', new Date(start.getTime() - 5 * 60_000)), // 23:55 يوم 17 > T0
    row('at-T0', T0),
    row('old', new Date(T0.getTime() - 1)),
  ], cut, 2, 5);
  assert.equal(r.batches, 5);
  assert.deepEqual(r.afterCutover.entries.map((e) => e.entryId), ['at-start', 'after']);
  assert.equal(r.afterCutover.count, 2);
  assert.equal(r.afterCutover.valueMilli, 21_000n + 3_000n);
  assert.deepEqual(r.tooRecent.entries.map((e) => e.entryId), ['before-start-late']);
  const atStart = r.afterCutover.entries[0];
  assert.equal(atStart.importedOn, '2026-09-18');
  assert.equal(atStart.minCutoverDate, '2026-09-19');
  const json = openingStockCheckJson(r, 2, cut);
  assert.equal(json.afterCutover.value, '24.00');
  assert.equal(json.afterCutover.minCutoverDate, '2026-09-19');
  assert.equal(json.tooRecent.count, 1);
  assert.equal(json.tooRecent.retryAfter, new Date(start.getTime() - 5 * 60_000 + LATE_COMMIT_WINDOW_MS).toISOString());
  assert.equal(json.cutoverDate, '2026-09-18');
  // استيراد في D واعتماد في D بتاريخ بدء D ⇒ خارج؛ واعتماد في D+1 بتاريخ بدء D+1 ⇒ داخل
  const importedD = new Date('2026-09-17T09:00:00.000Z');
  const sameDay = openingCutoff('2026-09-17', TZ, openingSnapshotFromDbNow(new Date('2026-09-17T12:00:00.000Z')));
  assert.equal(classifyOpeningStockEntries([row('d', importedD)], sameDay, 2).afterCutover.count, 1);
  const nextDay = openingCutoff('2026-09-18', TZ, openingSnapshotFromDbNow(new Date('2026-09-18T09:00:00.000Z')));
  const inc = classifyOpeningStockEntries([row('d', importedD)], nextDay, 2);
  assert.equal(inc.afterCutover.count + inc.tooRecent.count, 0);
  // لا دفعات ⇒ لا شيء
  const none = openingStockCheckJson(classifyOpeningStockEntries([], cut, 2), 2, cut);
  assert.deepEqual([none.batches, none.afterCutover.count, none.afterCutover.minCutoverDate, none.tooRecent.retryAfter], [0, 0, null, null]);
});

function ledgerHandlerBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `لم يُعثر على ${marker}`);
  const end = src.indexOf('\n}));', start);
  assert.ok(end > start);
  return src.slice(start, end);
}

test('حارس ثابت: /setup/commit يفحص المخزون المستورد تحت القفل قبل أي كتابة وقبل حساب الافتتاح (buildOpeningMove)، والمعاينة تعيده', () => {
  const setup = read('routes/ledger/setup.ts');
  const commit = ledgerHandlerBody(setup, "router.post('/setup/commit'");
  // البند 42: القفلان أولاً، ثم ساعة القاعدة واللقطة T0 منها (فتشمل ما كُتب أثناء انتظار القفل)، ثم الفحوص، ثم الكتابة.
  // الترتيب القديم (اللقطة قبل القفل) كان يترك صفوفاً تُكتب بين اللقطة وحيازة القفل خارج الافتتاح وخارج الفحص.
  assertOrder(commit, [
    'acquirePostLock(tx, tenantId)', 'acquireImportEntriesLock(tx, tenantId)', 'const dbNow = await dbClockOf(tx)',
    'openingSnapshotFromDbNow(dbNow)', 'loadRunningImportBatch(tx, tenantId, dbNow)',
    'assertCutoverNotInFuture(cutoverDate', 'checkStep1({ ...eff, cutoverDate }, dbNow)',
    'openingCutoff(cutoverDate, eff.timezone, T0)', 'loadOpeningStockCheck(tx, tenantId, stockCut',
    "eff.method === 'FULL_HISTORY' && openingStock.batches > 0", "'LEDGER_OPENING_STOCK_FULL_HISTORY'",
    'openingStock.afterCutover.count > 0 && parsed.data.acknowledgeOpeningStockExcluded !== true', "'LEDGER_OPENING_STOCK_AFTER_CUTOVER'",
    'openingStock.tooRecent.count > 0', "'LEDGER_OPENING_STOCK_TOO_RECENT'",
    'ensureSettingsRow(', 'seedTemplate(tx', 'const cut = openingCutoff(cutoverDate, eff.timezone, T0)', 'loadOpeningSources(tx', 'buildOpeningMove(', 'postMove(tx',
  ], '/setup/commit opening_stock');
  assert.match(setup, /acknowledgeOpeningStockExcluded: z\.boolean\(\)\.optional\(\)/);
  const preview = ledgerHandlerBody(setup, "router.post('/setup/preview-opening'");
  assert.match(preview, /openingCutoff\(cutoverDate, eff\.timezone, openingSnapshotFromDbNow\(now\)\)/);
  assert.match(preview, /loadOpeningStockCheck\(prisma, tenantId, stockCut, decimals\)/);
  assert.match(preview, /fullHistoryBlocked: eff\.method === 'FULL_HISTORY' && openingStock\.batches > 0/);
  // المُحمِّل: دفعات opening_stock غير المتراجَع عنها ⇒ حركاتها، بالمسند نفسه في loadOpeningSources
  const opening = read('services/gl/opening.ts');
  const loader = opening.slice(opening.indexOf('export async function loadOpeningStockCheck('), opening.indexOf('export function openingStockCheckJson('));
  assert.match(loader, /where: \{ tenantId, reverted: false, kind: OPENING_STOCK_BATCH_KIND \}/);
  assert.match(loader, /db\.warehouseEntry\.findMany\(/);
  assert.doesNotMatch(loader, /\.(create|update|upsert|delete)(Many)?\(/);
  assert.match(opening, /createdAt: \{ lt: cut\.cutoverStart, lte: cut\.snapshotAt \}/, 'مسند المحرك لم يتغير');
  // الاستيراد يكتب createdAt من ساعة القاعدة ويمرّر الإقرار
  const body = handlerBody(read('routes/import.ts'), "router.post('/opening-stock'");
  assertOrder(body, ['acquirePostLock(tx, tid)', 'SELECT now()', 'guard(await settingsOf(tx), dbNow)', 'createdAt: dbNow', 'tx.importBatch.create(', 'createdAt: dbNow'], 'opening-stock dbNow');
  assert.match(body, /acknowledgeCutoverChange: body\.acknowledgeCutoverChange === true/);
});
