// «تتبّع اللوط» — حرّاس نصّية للحزمة B3 (المواصفة §٨.٣): الوارد والاستيراد يقفلان الأصناف (lockLotProducts) قبل أول قراءة رصيد
// لوط وأول إنشاء، ولا يستدعيان دوال اللوط إلا داخل شرط العلم (R1، §١٠)، والتراجع عن الافتتاحي يقفل قبل الفحوص القائمة (ن١-١١).
// التشغيل في lots-warehouse وlots-import؛ هنا ما لا يُرى إلا في النصّ: الترتيب والشرط.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const slice = (src: string, from: string, to: string): string => {
  const s = src.indexOf(from);
  assert.ok(s >= 0, `مفقود: ${from}`);
  const e = src.indexOf(to, s + from.length);
  assert.ok(e > s, `نهاية مفقودة: ${to}`);
  return src.slice(s, e);
};
function ordered(text: string, needles: string[], label: string): void {
  let pos = -1;
  for (const n of needles) {
    const i = text.indexOf(n, pos + 1);
    assert.ok(i > pos, `${label}: «${n}» مفقود أو خارج الترتيب`);
    pos = i;
  }
}

test('B3 الوارد: العلم من استعلام حارس التفعيل نفسه، ودوال اللوط بعد مخرج المسار القائم وحده (R1)، وlockLotProducts قبل الخطة والإنشاء', () => {
  const w = read('routes/warehouse.ts');
  assert.ok(w.includes("select: { warehouseEnabled: true, accountingEnabled: true, lotTrackingEnabled: true } });"), 'العلم في الاستعلام نفسه');
  const post = slice(w, "router.post('/entries'", "router.get('/entries'");
  ordered(post, [
    'const withLots = lotsOn(req);',
    'const preTracked = withLots ? products.filter((p) => p.lotTracked === true)',
    // «الوحدة الرئيسية» §2.8: المسار القائم مطفأً صار معاملةً لقفل الأساس (lockBases) بمهلة BASE_GUARD_TX، ومسار اللوط يقارن
    // الأساس من صفوف lockLotProducts نفسها (assertBasesUnchanged)، وتبدّل الأساس لا يمرّ من asLotBusy
    'if (!preTracked.length) {', 'await lockBases(tx, tid, expected);', 'tx.warehouseEntry.create({ data: entryData(null), include: entryInclude });',
    '}, BASE_GUARD_TX);', 'return;',
    'await companyDay(prisma, tid)', 'await acquireLotQueue(tid, preTracked)', 'prisma.$transaction(async (tx) => {',
    'await lockLotProducts(tx, tid, productIds)', 'assertBasesUnchanged(expected, locked.units);', 'await planWarehouseEntryInTx(tx,',
    'tx.warehouseEntry.create({ data: entryData(plan.lotIdByLine)',
    '{ maxWait: 10_000, timeout: 20_000 }', 'if (e instanceof ProductUnitsChangedError) throw e;', 'throw asLotBusy(e) ?? e;', 'release();',
  ], 'POST /entries');
  // لا دالّة لوط قبل مخرج المسار القائم
  const before = post.slice(0, post.indexOf('if (!preTracked.length) {'));
  assert.doesNotMatch(before, /acquireLotQueue|lockLotProducts|planWarehouseEntryInTx|companyDay\(/);
  // ثلاثة: المسار القائم مطفأً، ومفعّلاً بإعادة قراءة التتبّع (D25، tx.warehouseEntry.create)، ومسار اللوط
  assert.equal((post.match(/warehouseEntry\.create\(/g) ?? []).length, 3, 'إنشاءٌ في كل فرع لا رابع');
  assert.ok(post.includes('await assertStillUntracked(tx, tid, productIds);'), 'D25: إعادة قراءة التتبّع في المسار غير المتتبَّع والميزة مفعّلة');
  // ما في السيارات: داخل الشرط وحده، والردّ القائم حرفياً خارجه
  const vans = slice(w, "router.get('/vans'", 'const entrySchema');
  ordered(vans, ['if (lotsOn(req)) {', 'await vansLotUnsellable(prisma, tid, repIds,', 'return;', 'res.json({ success: true, data: { ...summarizeVansStock(perRep, layers, avgCost, dec), deletedVans } });'], 'GET /vans');
  // السجلّ: lot في include حين العلم وحده
  assert.ok(slice(w, "router.get('/entries'", 'export default router').includes('...(lotsOn(req) && { lot: ENTRY_LOT_SELECT })'));
  // معالج الأخطاء قبل التصدير، ولا يحوّل إلا LotError (P2028 خارج مسار اللوط لا يصير LOT_BUSY)
  const handler = slice(w, 'router.use((err: unknown', 'export default router');
  assert.ok(handler.includes('const lh = err instanceof LotError ? lotHttpError(err) : null;'));
});

test('B3 الخطة: lockLotProducts (أو أقفال المسار) قبل أول قراءة رصيد لوط وأول إنشاء، والنقص قبل الزيادة، ولا config/database', () => {
  const s = read('services/lotsWarehouse.ts');
  assert.doesNotMatch(s, /config\/database/);
  const plan = slice(s, 'export async function planWarehouseEntryInTx', '// ═══ ما لا يُباع');
  ordered(plan, [
    'input.locked ?? await lockLotProducts(tx, tid, pids)', 'isLotQty(Math.abs(l.qty))',
    'await placeViews(tx, tid, { warehouse: true', 'aggregateRequest(', "pickOutSources(view, 'SELLABLE', g.qty, refsOfByLot(g.byLot), lookup)",
    'await resolveOrCreateLot(tx, tid',
  ], 'planWarehouseEntryInTx');
  const revert = slice(s, 'export async function assertOpeningRevertKeepsLots', 'export async function deleteOrphanOpeningLots');
  ordered(revert, ['locked ?? await lockLotProducts(tx, tid, entry.productIds)', 'tx.vanLoadItemLot.count(', 'tx.lotRelabel.count(', 'qty: { lt: 0 }', 'lotRemovalsOf(', 'removalKeepsLots('], 'assertOpeningRevertKeepsLots');
  assert.ok(revert.includes('baseQtyOf(l)'), 'الطرح بالأساس (D22)');
});

test('B3 الاستيراد: العلم من استعلام الشركة القائم، والطابور قبل المعاملة بشرطه، وlockLotProducts بعد gl-post وقبل فحص الحركات والكتابة', () => {
  const src = read('routes/import.ts');
  const body = slice(src, "router.post('/opening-stock'", "\nrouter.");
  assert.ok(body.includes("select: { warehouseEnabled: true, lotTrackingEnabled: true } });"));
  ordered(body, [
    'const lotsOn = tenant.lotTrackingEnabled === true;', 'resolveOpeningStockRows(rows, openingStockProductMatcher(products), body.pricesIncludeTax, { lotsOn })',
    'const trackedIds = new Set(lotsOn ?', 'if (lotProducts.length) releaseLots = await acquireLotQueue(tid, lotProducts);', 'prisma.$transaction(async tx => {',
    'acquirePostLock(tx, tid)', 'const lotLocks = lotsOn ? await lockLotProducts(tx, tid, productIds) : null;', 'tx.warehouseEntryItem.groupBy(',
    'openingStockMovementConflicts(', 'const entryId = lotLocks && lotLocks.tracked.size > 0 && checked.lines.length ? randomUUID() : null;', 'await planOpeningLotsInTx(tx,',
    'tx.warehouseEntry.create(', 'lotId: lotPlan.lotIdByRow.get(l.row)', 'releaseLots?.();',
  ], '/opening-stock');
  assert.match(body, /const lotBusy = lotsOn \? asLotBusy\(e\) : null;[\s\S]*?'OPENING_STOCK_LEDGER_BUSY'/, 'الانشغال يبقى 409 القائم (§٣.٣)');
  // القفل في المعاملة بالعلم وحده لا بالقراءة المسبقة: صنفٌ صار متتبَّعاً بين القراءتين يُقفل في القاعدة (§٣.١)، والطابور بشرطه
  assert.doesNotMatch(body, /releaseLots \? await lockLotProducts/);
});

test('B3 التراجع: lockLotProducts بعد صفّ الحركة FOR UPDATE وقبل الفحوص القائمة (ن١-١١)، ثم حارس التشغيلات، ثم الحذف فاليتيم', () => {
  const src = read('routes/import.ts');
  const branch = slice(src, '} else if (batch.kind === OPENING_STOCK_KIND) {', "if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)");
  ordered(branch, [
    'for (const eid of ids)', 'if (lotsOn) {', 'releaseLots = await acquireLotQueue(tid,', 'acquirePostLock(tx, tid)', 'FOR UPDATE',
    'const lotLocks = lotsOn && productIds.length ? await lockLotProducts(tx, tid, productIds) : null;',
    'openingStockRevertBlockReason(', 'await assertOpeningRevertKeepsLots(tx, tid, { id: eid, createdAt: entry.createdAt, productIds }, lotLocks);',
    'tx.warehouseEntryItem.deleteMany(', 'tx.warehouseEntry.deleteMany(', 'if (lotsOn || entry.items.some(i => i.lotId != null)) await deleteOrphanOpeningLots(tx, tid, eid,',
    'if (e instanceof LotError) { blocked.push(', 'releaseLots?.();',
  ], 'revert opening_stock');
  assert.ok(branch.includes('select: { createdAt: true, items: { select: { productId: true, lotId: true } } } });'), 'lotId في قراءة الحركة القائمة: اليتيم يُحذف والميزة مطفأة بلا استعلام زائد');
  assert.ok(src.includes('select: { accountingEnabled: true, lotTrackingEnabled: true } });'), 'العلم من استعلام الأنواع المحاسبية القائم');
  const products = slice(src, "} else if (batch.kind === 'products') {", "} else if (batch.kind === 'balances'");
  assert.ok(products.includes('productLots: lotsOn ? await tx.productLot.count({ where: { tenantId: tid, productId: pid } }) : 0,'), 'صنفٌ له تشغيلات لا يُحذف');
});
