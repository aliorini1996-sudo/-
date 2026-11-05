// مراجعة المخزون نوفمبر ٢٠٢٦ — حرّاس سيارة المندوب للأصناف غير المتتبَّعة (services/repSaleStock.ts):
//   • البند ٩: عجز «البيع بدون مخزون» على المتبقّي (vanShortage) وقفل السيارة بترتيبٍ ثابت.
//   • D5: جسم الحجز 409 VAN_STOCK_REPLAY_HELD وإشعار إدارةٍ واحد لكل clientRef.
//   • D10 (البندان ٨ و١٦): ما يسحبه إلغاء المرتجع/إطفاء العودة من دلاء السيارة، والسطور التي يصير بها الدلو سالباً،
//     وجسم 409 RETURN_CANCEL_STOCK_SHORT، والحارس داخل المعاملة على عميلٍ مزيّف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETURN_CANCEL_STOCK_SHORT, ReturnCancelStockShort, VAN_STOCK_REPLAY_HELD, assertReturnRemovalKeepsVan, bucketBalance,
  lockVanBuckets, preLockReturnOutBuckets, recordVanStockHeld, returnCancelShortLines, returnItemBucket, returnRemovals, vanLockKey, vanShortage,
  vanStockHeldBody,
} from '../services/repSaleStock';
import type { StockBucket } from '../routes/vanStock';
import fs from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);
const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split(String.fromCharCode(13) + NL).join(NL);

const AFTER_DAMAGED = new Date('2026-11-01T10:00:00.000Z'); // بعد DAMAGED_VAN_SINCE
const BEFORE_DAMAGED = new Date('2026-10-01T10:00:00.000Z');
const bucket = (o: Partial<StockBucket> = {}): StockBucket => ({
  loaded: 0, unloaded: 0, adjusted: 0, sold: 0, returned: 0, expiredIn: 0, expiredOut: 0, damagedIn: 0, damagedOut: 0, ...o,
});

test('البند ٩: أول صنفٍ يتجاوز مطلوبُه متبقّيه — والمتتبَّع (skip) لا يُفحص، والغائب متبقّيه صفر', () => {
  const want = new Map([['a', 5], ['b', 3], ['c', 1]]);
  assert.equal(vanShortage(want, new Map([['a', 5], ['b', 3], ['c', 1]])), null, 'المساواة تكفي');
  assert.deepEqual(vanShortage(want, new Map([['a', 5], ['b', 2.5], ['c', 1]])), { productId: 'b', wanted: 3, available: 2.5 });
  assert.deepEqual(vanShortage(want, new Map([['a', 5], ['b', 3]])), { productId: 'c', wanted: 1, available: 0 });
  assert.equal(vanShortage(want, new Map([['a', 5]]), new Set(['b', 'c'])), null);
  // غبار العائمة لا يرفض
  assert.equal(vanShortage(new Map([['a', 0.30000000000000004]]), new Map([['a', 0.3]])), null);
});

test('القفل: مفاتيح الدلاء كما في routes/vanStock.ts، وبترتيبٍ ثابت (التالف ثم المنتهي ثم المتاح) بلا تكرار', async () => {
  assert.equal(vanLockKey('sellable', 'r1'), 'van-sellable:r1');
  assert.equal(vanLockKey('expired', 'r1'), 'van-expired:r1');
  assert.equal(vanLockKey('damaged', 'r1'), 'van-damaged:r1');
  const keys: unknown[] = [];
  const tx = { $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => { keys.push(v[0]); return 0; } };
  await lockVanBuckets(tx as never, 'r1', ['sellable', 'damaged', 'sellable', 'expired']);
  assert.deepEqual(keys, ['van-damaged:r1', 'van-expired:r1', 'van-sellable:r1']);
});

test('D5: جسم الحجز — رمزٌ ورسالةٌ عربية والصنف بمتاحه ومطلوبه بأربع خانات', () => {
  const b = vanStockHeldBody('شاي', 'p1', 2.123456, 5);
  assert.equal(b.success, false);
  assert.equal(b.code, VAN_STOCK_REPLAY_HELD);
  assert.match(b.message, /«شاي»/);
  assert.match(b.message, /بانتظار الإدارة/);
  assert.deepEqual(b.detail, { productId: 'p1', availableBase: 2.1235, requestedBase: 5 });
});

test('D5: إشعار الإدارة مرّةً لكل clientRef، ولا يرمي إن تعذّر', async () => {
  const created: Record<string, unknown>[] = [];
  let prior: unknown = null;
  const db = {
    notification: {
      findFirst: async (a: { where: { type: string; data: { contains: string } } }) => {
        assert.equal(a.where.type, VAN_STOCK_REPLAY_HELD);
        assert.equal(a.where.data.contains, 'ref-1');
        return prior;
      },
      create: async (a: { data: Record<string, unknown> }) => { created.push(a.data); prior = { id: 'n1' }; return a.data; },
    },
  };
  const input = { tenantId: 'T1', clientRef: 'ref-1', salesRepId: 'r1', customerId: 'c1', productName: 'شاي', detail: { productId: 'p1' } };
  await recordVanStockHeld(db as never, input);
  await recordVanStockHeld(db as never, input);
  assert.equal(created.length, 1, 'إشعارٌ واحد');
  assert.equal(created[0].type, VAN_STOCK_REPLAY_HELD);
  assert.equal(JSON.parse(String(created[0].data)).clientRef, 'ref-1');
  const broken = { notification: { findFirst: async () => { throw new Error('down'); }, create: async () => null } };
  await recordVanStockHeld(broken as never, input); // لا يرمي
});

test('D10: دلو بند المرتجع كطيّ foldStock — المنتهي أولاً، ثم التالف بعد DAMAGED_VAN_SINCE، ثم المتاح إن عاد، وإلا لا أثر', () => {
  assert.equal(returnItemBucket({ returnToStock: false }, { returnExpired: true }), 'expired');
  assert.equal(returnItemBucket({ returnToStock: true, returnReason: 'DAMAGED', createdAt: AFTER_DAMAGED }, {}), 'damaged');
  assert.equal(returnItemBucket({ returnToStock: true, returnReason: 'DAMAGED', createdAt: BEFORE_DAMAGED }, {}), 'sellable', 'التالف القديم متاح كما كان');
  assert.equal(returnItemBucket({ returnToStock: true }, { returnExpired: false }), 'sellable');
  assert.equal(returnItemBucket({ returnToStock: false }, {}), null);
  assert.equal(returnItemBucket({ returnToStock: null, returnReason: 'DAMAGED', createdAt: BEFORE_DAMAGED }, {}), null);
});

test('D10: ما يُسحب — الإلغاء كل الدلاء، وإطفاء العودة المتاح وحده، بالأساس ومجموعاً للصنف، والمتتبَّع خارجه', () => {
  const inv = { returnToStock: true, returnReason: null, createdAt: AFTER_DAMAGED };
  const items = [
    { productId: 'a', qty: 2, unitFactor: 24, baseQty: 48 }, // كرتونان
    { productId: 'a', qty: 3, unitFactor: null, baseQty: null }, // ٣ حبّات
    { productId: 'b', qty: 4, returnExpired: true },
    { productId: 'lot', qty: 1 },
    { productId: null, qty: 9 },
  ];
  assert.deepEqual(returnRemovals(inv, items, 'CANCEL', new Set(['lot'])), [
    { productId: 'a', bucket: 'sellable', base: 51 },
    { productId: 'b', bucket: 'expired', base: 4 },
  ]);
  assert.deepEqual(returnRemovals(inv, items, 'RESTOCK_OFF', new Set(['lot'])), [{ productId: 'a', bucket: 'sellable', base: 51 }],
    'المنتهي لا تحكمه returnToStock');
  // مرتجعٌ لا يعود: الإلغاء لا يسحب من المتاح شيئاً
  assert.deepEqual(returnRemovals({ returnToStock: false }, [{ productId: 'a', qty: 2 }], 'CANCEL'), []);
  // التالف: من دلوه
  assert.deepEqual(returnRemovals({ returnToStock: true, returnReason: 'DAMAGED', createdAt: AFTER_DAMAGED }, [{ productId: 'a', qty: 2 }], 'CANCEL'),
    [{ productId: 'a', bucket: 'damaged', base: 2 }]);
});

test('D10: الرصيد بعد السحب — المساواة تكفي، والسالب سطرٌ بدلوه ومتاحه ومطلوبه', () => {
  const buckets = new Map<string, StockBucket>([
    ['a', bucket({ loaded: 10, sold: 9, returned: 2 })], // متاح ٣
    ['b', bucket({ expiredIn: 4, expiredOut: 4 })], // منتهي ٠ — أُزيل
    ['c', bucket({ damagedIn: 5, damagedOut: 2 })], // تالف ٣
  ]);
  assert.equal(bucketBalance(buckets.get('a'), 'sellable'), 3);
  assert.equal(bucketBalance(buckets.get('b'), 'expired'), 0);
  assert.equal(bucketBalance(buckets.get('c'), 'damaged'), 3);
  assert.equal(bucketBalance(undefined, 'sellable'), 0);
  assert.deepEqual(returnCancelShortLines(buckets, [
    { productId: 'a', bucket: 'sellable', base: 3 },
    { productId: 'b', bucket: 'expired', base: 4 },
    { productId: 'c', bucket: 'damaged', base: 3 },
    { productId: 'z', bucket: 'sellable', base: 1 },
  ]), [
    { productId: 'b', availableBase: 0, requiredBase: 4, bucket: 'expired' },
    { productId: 'z', availableBase: 0, requiredBase: 1, bucket: 'sellable' },
  ]);
});

test('D10: جسم 409 — الرمز والسطور ورسالة عربية باسم الصنف ودلوه', () => {
  const e = new ReturnCancelStockShort([{ productId: 'a', availableBase: 0, requiredBase: 12, bucket: 'sellable' }], new Map([['a', 'شاي']]));
  const b = e.body();
  assert.equal(b.success, false);
  assert.equal(b.code, RETURN_CANCEL_STOCK_SHORT);
  assert.deepEqual(b.lines, [{ productId: 'a', availableBase: 0, requiredBase: 12, bucket: 'sellable' }]);
  assert.match(b.message, /«شاي»/);
  assert.match(b.message, /المتاح للبيع/);
  assert.match(b.message, /سالباً/);
  assert.match(new ReturnCancelStockShort([{ productId: 'x', availableBase: 1, requiredBase: 2, bucket: 'damaged' }], new Map()).body().message, /«الصنف» \(التالف\)/);
  // UX9: كل الأصناف القاصرة في الرسالة لا أوّلها وحده
  const two = new ReturnCancelStockShort([
    { productId: 'a', availableBase: 0, requiredBase: 12, bucket: 'sellable' },
    { productId: 'b', availableBase: 1, requiredBase: 3, bucket: 'expired' },
  ], new Map([['a', 'شاي'], ['b', 'قهوة']])).body().message;
  assert.match(two, /«شاي» \(المتاح للبيع\): الموجود 0 والمطلوب سحبه 12/);
  assert.match(two, /«قهوة» \(منتهي الصلاحية\): الموجود 1 والمطلوب سحبه 3/);
  assert.match(two, /أولاً$/);
});

/** عميل معاملةٍ مزيّف: المرتجع وبنوده والحركات كما يقرؤها الحارس، وتسجيل الأقفال */
function fakeTx(o: {
  inv: Record<string, unknown> | null;
  items: Record<string, unknown>[];
  loads?: Record<string, unknown>[];
  invItems?: Record<string, unknown>[];
}) {
  const locks: unknown[] = [];
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => { locks.push(v[0]); return 0; },
    invoice: { findFirst: async () => o.inv },
    invoiceItem: {
      findMany: async (a: { where: { invoiceId?: string } }) => (a.where.invoiceId ? o.items : (o.invItems ?? [])),
    },
    vanLoadItem: { findMany: async () => o.loads ?? [] },
    product: { findMany: async () => [{ id: 'pW', name: 'ماء' }] },
  };
  return { tx, locks };
}

const D = new Date('2026-11-02T08:00:00.000Z');
const loadRow = (qty: number, type = 'LOAD') => ({ productId: 'pW', qty, unitFactor: null, baseQty: null, vanLoad: { type, createdAt: D } });
const invRow = (type: string, qty: number, extra: Record<string, unknown> = {}) => ({
  productId: 'pW', qty, unitFactor: null, baseQty: null, returnExpired: null,
  invoice: { type, returnToStock: true, invoiceDate: D, returnReason: null, createdAt: D, ...extra },
});

test('D10 داخل المعاملة: مرتجعٌ بيعت بضاعته ⇒ ReturnCancelStockShort بعد قفل المتاح؛ والرصيد الكافي يمرّ', async () => {
  const inv = { type: 'RETURN', status: 'CONFIRMED', salesRepId: 'r1', returnToStock: true, returnReason: null, createdAt: D };
  // حُمّل ٢، ورجع ١ (هذا المرتجع)، وبيع ٣ ⇒ المتاح ٠؛ الإلغاء يسحب ١ ⇒ −١
  const short = fakeTx({ inv, items: [{ productId: 'pW', qty: 1 }], loads: [loadRow(2)], invItems: [invRow('RETURN', 1), invRow('CASH', 3)] });
  await assert.rejects(assertReturnRemovalKeepsVan(short.tx as never, 'T1', 'inv1', 'CANCEL'), (e: unknown) => {
    assert.ok(e instanceof ReturnCancelStockShort);
    assert.deepEqual(e.lines, [{ productId: 'pW', availableBase: 0, requiredBase: 1, bucket: 'sellable' }]);
    assert.match(e.body().message, /«ماء»/);
    return true;
  });
  assert.deepEqual(short.locks, ['van-sellable:r1']);
  // تحميلٌ إضافي ⇒ المتاح ١ ⇒ يُلغى إلى صفر
  const ok = fakeTx({ inv, items: [{ productId: 'pW', qty: 1 }], loads: [loadRow(2), loadRow(1)], invItems: [invRow('RETURN', 1), invRow('CASH', 3)] });
  await assertReturnRemovalKeepsVan(ok.tx as never, 'T1', 'inv1', 'CANCEL');
  // إطفاء العودة يقيس المتاح نفسه
  await assert.rejects(assertReturnRemovalKeepsVan(short.tx as never, 'T1', 'inv1', 'RESTOCK_OFF'), ReturnCancelStockShort);
});

test('D10 داخل المعاملة: المنتهي المُزال يرفض الإلغاء بدلوه، وإطفاء العودة لا يمسّه', async () => {
  const inv = { type: 'RETURN', status: 'CONFIRMED', salesRepId: 'r1', returnToStock: true, returnReason: null, createdAt: D };
  const w = fakeTx({
    inv, items: [{ productId: 'pW', qty: 4, returnExpired: true }],
    // رجع ٤ منتهية ثم أُزيلت بـEXPIRED_OUT ⇒ رصيد المنتهي ٠
    loads: [loadRow(4, 'EXPIRED_OUT')], invItems: [{ ...invRow('RETURN', 4), returnExpired: true }],
  });
  await assert.rejects(assertReturnRemovalKeepsVan(w.tx as never, 'T1', 'inv1', 'CANCEL'), (e: unknown) => {
    assert.ok(e instanceof ReturnCancelStockShort);
    assert.deepEqual(e.lines, [{ productId: 'pW', availableBase: 0, requiredBase: 4, bucket: 'expired' }]);
    return true;
  });
  assert.deepEqual(w.locks, ['van-expired:r1']);
  w.locks.length = 0;
  await assertReturnRemovalKeepsVan(w.tx as never, 'T1', 'inv1', 'RESTOCK_OFF');
  assert.deepEqual(w.locks, [], 'لا سحب من المتاح ⇒ لا قفل');
});

test('D10 داخل المعاملة: غير المرتجع أو الملغى أو بلا مندوب أو المتتبَّع وحده — لا قراءة حركات ولا قفل', async () => {
  for (const inv of [
    { type: 'CASH', status: 'CONFIRMED', salesRepId: 'r1', returnToStock: null },
    { type: 'RETURN', status: 'CANCELLED', salesRepId: 'r1', returnToStock: true },
    { type: 'RETURN', status: 'CONFIRMED', salesRepId: null, returnToStock: true },
    null,
  ]) {
    const f = fakeTx({ inv, items: [{ productId: 'pW', qty: 1 }], invItems: [invRow('CASH', 9)] });
    await assertReturnRemovalKeepsVan(f.tx as never, 'T1', 'inv1', 'CANCEL');
    assert.deepEqual(f.locks, []);
  }
  const lot = fakeTx({ inv: { type: 'RETURN', status: 'CONFIRMED', salesRepId: 'r1', returnToStock: true }, items: [{ productId: 'pW', qty: 1 }], invItems: [invRow('CASH', 9)] });
  await assertReturnRemovalKeepsVan(lot.tx as never, 'T1', 'inv1', 'CANCEL', new Set(['pW']));
  assert.deepEqual(lot.locks, [], 'المتتبَّع حارسه حارس اللوط');
});

test('ترتيب الأقفال (المراجعة F4): إلغاء مرتجعٍ فيه متتبَّع يقفل دلوَي المنتهي والتالف لغير المتتبَّع قبل حارس اللوط — والمتاح لا', async () => {
  const inv = { type: 'RETURN', status: 'CONFIRMED', salesRepId: 'r1', returnToStock: true, returnReason: null, createdAt: D };
  const f = fakeTx({ inv, items: [{ productId: 'pQ', qty: 2, returnExpired: true }, { productId: 'pS', qty: 1 }, { productId: 'pL', qty: 3, returnExpired: true }] });
  await preLockReturnOutBuckets(f.tx as never, 'T1', 'inv1', new Set(['pL']));
  assert.deepEqual(f.locks, ['van-expired:r1'], 'المنتهي لغير المتتبَّع وحده، والمتاح بعد أقفال اللوط');
  const none = fakeTx({ inv, items: [{ productId: 'pS', qty: 1 }] });
  await preLockReturnOutBuckets(none.tx as never, 'T1', 'inv1');
  assert.deepEqual(none.locks, []);
  const src = read('routes/invoices.ts');
  const at = (m: string) => { const i = src.indexOf(m); assert.ok(i >= 0, m); return i; };
  assert.ok(at('if (lotCancel.length) await preLockReturnOutBuckets(tx, tid, invoice.id, new Set(lotCancel));')
    < at('if (lotCancel.length) await assertReturnCancelKeepsLots(tx, tid, invoice.id);'), 'الدلو قبل أقفال اللوط');
});

test('D10 (المراجعة F2/D10-W): سحب الإشعار الدائن يفحص السيارة داخل معاملة السحب (guardInTx) بعد قرار الأهلية — لا معاملة قبله', () => {
  const src = read('routes/invoices.ts');
  const i = src.indexOf("router.post('/:id/einvoice/withdraw'");
  const body = src.slice(i, src.indexOf(NL + '});', i));
  assert.match(body, /r = await withdrawPhase2Invoice\(\{ tenantId: tid, invoiceId: id, guardInTx \}\);/);
  assert.match(body, /await assertReturnRemovalKeepsVan\(tx, tid, id, 'CANCEL', lotSkip\);/);
  assert.ok(!body.includes('prisma.$transaction'), 'لا معاملة فحصٍ منفصلة قبل السحب');
  assert.match(body, /if \(e instanceof ReturnCancelStockShort\) \{ res\.status\(409\)\.json\(e\.body\(\)\); return; \}/);
  const svc = read('services/invoiceVoid.ts');
  const v = svc.slice(svc.indexOf('export async function voidInvoiceInTx'));
  assert.ok(v.indexOf('await lockInvoice(tx, input.invoiceId)') < v.indexOf('if (input.guardInTx) await input.guardInTx(tx);'));
  assert.ok(v.indexOf('if (input.guardInTx) await input.guardInTx(tx);') < v.indexOf('await tx.invoice.update('), 'الحارس قبل الإبطال');
});

test('D10 (المراجعة F3): التنزيل والتحميل/التسوية بسطرٍ سالب يأخذون قفل المتاح `van-sellable:` بعد أقفال الأصناف', () => {
  const src = read('routes/vanStock.ts');
  assert.match(src, /const sellOut = !outBucket && !gone && items\.some\(i => \(data\.type === 'UNLOAD' \? i\.qty > 0 : i\.qty < 0\)\);/);
  assert.match(src, /SELECT pg_advisory_xact_lock\(hashtext\(\$\{'van-sellable:' \+ salesRepId\}\)\)/);
  assert.equal(vanLockKey('sellable', 'r1'), 'van-sellable:r1', 'المفتاح نفسه');
  // في المسارات الثلاثة بعد قفل الأصناف وقبل الكتابة
  assert.equal(src.split('await sellGate(tx);').length - 1, 3);
  assert.ok(src.indexOf('assertBasesUnchanged(expected, locked.units);' + NL + '          await sellGate(tx);') > 0, 'مسار اللوط: بعد lockLotProducts');
  assert.match(src, /await lockBases\(tx, tid, expected\);\s+await assertStillUntracked\(tx, tid, productIds\);\s+await sellGate\(tx\);/);
  assert.match(src, /await lockBases\(tx, tid, expected\);\s+await sellGate\(tx\);\s+await whGate\(tx\);/);
});
