// حركات مفتاح الربط لا تُرفض باللوط (طلب المالك ١٦ نوفمبر ٢٠٢٦ — موصِل Odoo كان يُرفض 422/409 مراراً فيبقى رصيد التشغيلات في
// فيلد): الإنقاص برقمٍ مجهول سحبٌ تلقائي (LOT_NUMBER_UNKNOWN)، والنقص حصرٌ بالمتاح (LOT_CLAMPED)، والزيادة برقمٍ جديد إنشاءٌ
// (LOT_CREATED)، وتشغيلةٌ لصنفٍ غير متتبَّع تُهمل (LOT_IGNORED)، والكسر الخامس يُقرَّب — ولا سالب أبداً (I1، I2). والواجهة كما كانت
// حرفياً. ومعها المستودع (planWarehouseEntryInTx بـlenient) وسطر [api-reject]. فوق مزيّف lots-van-fake.ts — بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  API, ADMIN, FAR1, FAR2, T, codeOf, db, lastLoad, lot, lotRowsOf, post, receive, reset, seedMove, st, usableOf, views, warnCodes,
} from './lots-van-fake';
import { planWarehouseEntryInTx } from '../services/lotsWarehouse';
import { lenientTakeLines } from '../services/lotsVan';
import { LotError, type PlaceLotView } from '../services/lots';
import type { LotTx } from '../services/lotsDb';
import { apiRejectLine, apiRejectLog } from '../services/apiRejectLog';

const itemsOf = (loadId: string) => st().vanItems.filter((i) => i.vanLoadId === loadId).map((i) => [i.productId, i.baseQty ?? i.qty]);
const warning = (r: { body: Record<string, unknown> | null }, code: string) =>
  ((r.body?.warnings as { code: string; detail?: Record<string, unknown> }[] | undefined) ?? []).find((w) => w.code === code);
/** سيارة r1 فيها L1 ٧٠ (حُمّل ٧٠ بلا مستودع) */
function van70(): void {
  reset({ warehouse: false });
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  seedMove('r1', 'LOAD', 'pB', 70, [{ lotId: 'l1', qty: 70 }], { via: false });
}

test('النقص: مفتاح الربط ADJUST −١٠٠ على ٧٠ ⇒ 201 بكمية ٧٠ وLOT_CLAMPED {requested 100, applied 70} والكل صفر؛ والواجهة 409 بلا كتابة كما كانت', async () => {
  van70();
  const n0 = st().vanLoads.length;
  const ui = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -100 }] }, ADMIN);
  assert.deepEqual([ui.statusCode, codeOf(ui)], [409, 'LOT_STOCK_INSUFFICIENT']);
  assert.equal(st().vanLoads.length, n0);
  const r = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -100 }] }, API);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(itemsOf(lastLoad().id), [['pB', -70]], 'البند بكميته المطبَّقة');
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [['l1', -70]], 'Σ الصفوف = البند (I3)');
  const w = warning(r, 'LOT_CLAMPED');
  assert.deepEqual([w?.detail?.requested, w?.detail?.applied], [100, 70]);
  const v = (await views('pB')).van;
  assert.deepEqual([v.total?.SELLABLE, usableOf(v, 'l1'), v.unknownUsable?.SELLABLE], [0, 0, 0]);
  // لا شيء بقي يُنقص ⇒ 200 noop بالتحذير لا حركةٌ بلا بنود
  const empty = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 5 }] }, API);
  assert.deepEqual([empty.statusCode, empty.body?.noop], [200, true], JSON.stringify(empty.body));
  assert.ok(warnCodes(empty).includes('LOT_CLAMPED'));
});

test('رقمٌ مجهول في الإنقاص (ODOO/1) ⇒ سحبٌ تلقائي بالأقرب انتهاءً بتحذير LOT_NUMBER_UNKNOWN؛ والواجهة 422 LOT_NOT_FOUND كما كانت', async () => {
  van70();
  const ui = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -5, lotNumber: 'ODOO/1' }] }, ADMIN);
  assert.deepEqual([ui.statusCode, codeOf(ui)], [422, 'LOT_NOT_FOUND']);
  const r = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -5, lotNumber: 'ODOO/1' }] }, API);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(warning(r, 'LOT_NUMBER_UNKNOWN')?.detail?.fallback, 'FEFO');
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [['l1', -5]]);
  // ومعرّف لوطٍ مجهول في lots[] كذلك، ومعرّف صنفٍ آخر
  lot('la', 'pA', FAR1);
  const r2 = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 2, lots: [{ lotId: 'la', qty: 2 }] }] }, API);
  assert.equal(r2.statusCode, 201, JSON.stringify(r2.body));
  assert.equal(warning(r2, 'LOT_NUMBER_UNKNOWN')?.detail?.reason, 'PRODUCT_MISMATCH');
  assert.equal(usableOf((await views('pB')).van, 'l1'), 63);
});

test('lotNumber داخل صفوف lots[] (رقم Odoo بحالة أحرفٍ أخرى) يُطابَق داخل الشركة والصنف — ونقص التشغيلة المسمّاة يُكمَل من غيرها بتحذير LOT_EXPLICIT_FALLBACK', async () => {
  van70();
  seedMove('r1', 'LOAD', 'pB', 4, [{ lotId: 'l2', qty: 4 }], { via: false });
  const r = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 3, lots: [{ lotNumber: ' l2 ', qty: 3 }] }] }, API);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [['l2', 3]]);
  // l2 بقي ١ — المطلوب ٤ منه: ١ منه ثم ٣ من l1
  const short = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -4, lots: [{ lotNumber: 'L2', qty: 4 }] }] }, API);
  assert.equal(short.statusCode, 201, JSON.stringify(short.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]).sort(), [['l1', -3], ['l2', -1]]);
  assert.ok(warnCodes(short).includes('LOT_EXPLICIT_FALLBACK'));
  const v = (await views('pB')).van;
  assert.deepEqual([usableOf(v, 'l1'), usableOf(v, 'l2')], [67, 0]);
});

test('الزيادة برقمٍ جديد (تحميلٌ بلا مستودع وتسويةٌ موجبة) ⇒ تُنشأ التشغيلة بتحذير LOT_CREATED؛ والكسر الخامس يُقرَّب بتحذير', async () => {
  van70();
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 5, lots: [{ lotNumber: 'odoo-77', qty: 5 }] }] }, API);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(warnCodes(r).includes('LOT_CREATED'));
  const created = st().lots.find((l) => l.lotNumber === 'ODOO-77');
  assert.ok(created);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [[created!.id, 5]]);
  const dec = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -2.00001 }] }, API);
  assert.equal(dec.statusCode, 201, JSON.stringify(dec.body));
  assert.equal(warning(dec, 'LOT_CLAMPED')?.detail?.reason, 'DECIMALS');
  assert.deepEqual(itemsOf(lastLoad().id), [['pB', -2]]);
  const ui = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -2.00001 }] }, ADMIN);
  assert.equal(ui.statusCode, 422, 'الواجهة كما كانت');
});

test('تشغيلةٌ لصنفٍ غير متتبَّع ⇒ تُهمل بتحذير LOT_IGNORED ويتحرّك الصنف (الواجهة 422)، وسطر صفري بين أسطر ⇒ ZERO_QTY_IGNORED، ومستندٌ مختلط يُكتب سطره غير المتتبَّع', async () => {
  van70();
  const ui = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pU', qty: 4, lotNumber: 'X1' }] }, ADMIN);
  assert.equal(ui.statusCode, 422);
  const r = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pU', qty: 4, lotNumber: 'X1' }, { productId: 'pB', qty: 0 }] }, API);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(warnCodes(r).includes('LOT_IGNORED'));
  assert.equal((r.body?.warnings as { code: string; index?: number }[]).find((w) => w.code === 'ZERO_QTY_IGNORED')?.index, 1, 'بموضع السطر في الطلب');
  assert.deepEqual(itemsOf(lastLoad().id), [['pU', 4]]);
  // مختلط: المتتبَّع ناقص (يُحصر) وغير المتتبَّع يُكتب
  const mixed = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -500 }, { productId: 'pU', qty: -1 }] }, API);
  assert.equal(mixed.statusCode, 201, JSON.stringify(mixed.body));
  assert.deepEqual(itemsOf(lastLoad().id), [['pB', -70], ['pU', -1]]);
});

test('lenientTakeLines (صرفة): المفضَّل الموقوف يُنقص (تشغيلةٌ حقيقية)، ثم الأقرب انتهاءً، ثم غير المسمّى حتى max(0)، والزائد يُحصر — بلا سالب', () => {
  const b = { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 };
  const lotRow = (lotId: string, u: number, status = 'ACTIVE') => ({
    lotId, usable: { ...b, SELLABLE: u }, held: { ...b }, raw: { ...b, SELLABLE: u },
    meta: { id: lotId, productId: 'p', lotNumber: lotId.toUpperCase(), expiryDate: null, status, blockKind: null },
  });
  const view = { productId: 'p', place: 'VAN', vanKey: 'r1', total: { ...b, SELLABLE: 9 }, lots: [lotRow('a', 3), lotRow('blk', 2, 'BLOCKED')], unknown: { ...b, SELLABLE: 4 },
    unknownUsable: { ...b, SELLABLE: 4 }, deficits: [], firstInAt: new Map(), approximate: false } as unknown as PlaceLotView;
  const g = lenientTakeLines(view, 'SELLABLE', [{ idx: 0, qty: 20, prefs: [{ lotId: 'blk', qty: 20 }] }]);
  assert.deepEqual(g.lines.get(0)!.map((r) => [r.lotId, r.qty]), [['blk', 2], ['a', 3], [null, 4]]);
  assert.equal(g.applied.get(0), 9);
  assert.deepEqual(g.warnings.map((w) => w.code).sort(), ['LOT_CLAMPED', 'LOT_EXPLICIT_FALLBACK']);
  // غير المسمّى السالب لا يُنقص (I2)، ولا يُصرف فوق رصيد الصنف
  const neg = { ...view, total: { ...b, SELLABLE: 1 }, lots: [lotRow('a', 3)], unknown: { ...b, SELLABLE: -2 }, unknownUsable: { ...b, SELLABLE: -2 } } as unknown as PlaceLotView;
  const g2 = lenientTakeLines(neg, 'SELLABLE', [{ idx: 0, qty: 5 }]);
  assert.equal(g2.applied.get(0), 1, 'رصيد الصنف ١ وحده');
});

test('المستودع (planWarehouseEntryInTx بـlenient): رقمٌ مجهول في تسوية النقص ⇒ سحبٌ تلقائي، والنقص يُحصر بالمتاح (splitByLine)، والمرتجع المسعَّر (clamp false) يبقى 409، وبلا lenient LOT_NOT_FOUND كما كان', async () => {
  reset();
  lot('w1', 'pB', FAR1); lot('w2', 'pB', FAR2);
  receive('pB', 6, 'w1'); receive('pB', 4, 'w2');
  const base = { tenantId: T, actor: 'API_KEY' as const, createdBy: null, day: '2026-11-18', allowUnknown: true };
  const line = (qty: number, extra: Record<string, unknown> = {}) => [{ idx: 0, productId: 'pB', productName: 'عصير', shelfLifeOn: false, qty, ...extra }];
  await assert.rejects(planWarehouseEntryInTx(db as unknown as LotTx, { ...base, type: 'ADJUST', lines: line(-3, { lotNumber: 'odoo/9' }) }),
    (e: unknown) => e instanceof LotError && e.code === 'LOT_NOT_FOUND');
  const p = await planWarehouseEntryInTx(db as unknown as LotTx, { ...base, type: 'ADJUST', lines: line(-15, { lotNumber: 'odoo/9' }), lenient: { clamp: true } });
  const codes = p.warnings.map((w) => w.code);
  assert.ok(codes.includes('LOT_NUMBER_UNKNOWN') && codes.includes('LOT_CLAMPED'), codes.join());
  assert.deepEqual(p.splitByLine?.get(0)?.map((r) => [r.lotId, r.qty]), [['w1', 6], ['w2', 4]]);
  await assert.rejects(planWarehouseEntryInTx(db as unknown as LotTx, { ...base, type: 'RETURN', lines: line(-15), lenient: { clamp: false } }),
    (e: unknown) => e instanceof LotError && e.code === 'LOT_STOCK_INSUFFICIENT');
  // معرّف تشغيلةٍ لشركةٍ أخرى في الزيادة ⇒ رقمٌ تلقائي بتحذير، لا كشف ولا رفض
  lot('wx', 'pB', FAR1, { tenantId: 'other' });
  const inc = await planWarehouseEntryInTx(db as unknown as LotTx, { ...base, type: 'ADJUST', lines: line(2, { lotId: 'wx' }), lenient: { clamp: true } });
  assert.ok(inc.warnings.some((w) => w.code === 'LOT_NUMBER_UNKNOWN'));
  assert.notEqual(inc.lotIdByLine.get(0), 'wx');
});

test('[api-reject]: سطرٌ واحد لمفتاح API بـ4xx — المسار بلا استعلام ورمز الجسم وأول ستة أحرف من المفتاح، ولا سطر للجلسة ولا لـ2xx أو 5xx', () => {
  assert.equal(apiRejectLine('POST', '/api/van-stock/loads', 422, 'LOT_NOT_FOUND', 'keyABCDEF123'), '[api-reject] POST /api/van-stock/loads 422 LOT_NOT_FOUND key=keyABC');
  const lines: string[] = [];
  const mw = apiRejectLog((l) => lines.push(l));
  const run = (user: unknown, status: number, body: unknown) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status, json(b: unknown) { return this; } }) as unknown as import('express').Response & EventEmitter;
    const req = { method: 'POST', originalUrl: '/api/van-stock/loads?salesRepId=secret', baseUrl: '/api/van-stock', path: '/loads', user } as unknown as import('express').Request;
    mw(req, res, () => undefined);
    (res as unknown as { json: (b: unknown) => unknown }).json(body);
    res.emit('finish');
  };
  run({ ...ADMIN, apiKeyId: 'keyABCDEF123' }, 409, { success: false, code: 'LOT_STOCK_INSUFFICIENT', message: 'x' });
  run({ ...ADMIN, apiKeyId: 'keyABCDEF123' }, 400, { success: false, error: { code: 'BASE_UNIT_REQUIRED' } });
  run({ ...ADMIN }, 409, { code: 'LOT_STOCK_INSUFFICIENT' });
  run({ ...ADMIN, apiKeyId: 'keyABCDEF123' }, 201, { success: true });
  run({ ...ADMIN, apiKeyId: 'keyABCDEF123' }, 503, { code: 'LOT_BUSY' });
  assert.deepEqual(lines, [
    '[api-reject] POST /api/van-stock/loads 409 LOT_STOCK_INSUFFICIENT key=keyABC',
    '[api-reject] POST /api/van-stock/loads 400 BASE_UNIT_REQUIRED key=keyABC',
  ]);
  assert.ok(!lines.join().includes('secret'), 'بلا استعلام');
});
