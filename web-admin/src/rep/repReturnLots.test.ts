// «تتبّع اللوط» — تشغيلة المرتجع الحرّ في تطبيق المندوب (طلب المالك ١٦ نوفمبر ٢٠٢٦ «عالجها»، الشكوى ١: «المرتجع يدخل كـLOT
// جديد غير مسمى»): المنطق الصرف (rep/returnLots.ts) وحرّاسٌ نصّية على مواضعه في التطبيق — الافتراض «تلقائي» بلا حقل، والمختار
// items[i].lots من الحمولة نفسها التي يحفظها الصندوق الأوف‑لاين، والبيع والمرتجع المربوط بلا تغيير.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_LOT_HISTORY_MAX, CUSTOMER_LOT_HISTORY_PATH, customerLotHistoryOf, lotRejectLine, returnLineLots, returnLotLine,
  returnLotOptions, returnLotPickOf, returnPickDocLots, withReturnPick, type CustomerLotRow, type ReturnLotPick,
} from './returnLots';
import type { VanLotSnapshotDto } from '../lib/lots';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const hist = (lotId: string, over: Partial<CustomerLotRow> = {}): CustomerLotRow => ({
  lotId, lotNumber: `N-${lotId}`, expiryDate: '2027-01-01', status: 'ACTIVE', blockKind: null,
  lastSoldAt: '2026-11-10T08:00:00.000Z', soldBase: 10, returnedBase: 0, ...over,
});

const snap = (lots: { productId: string; lotId: string; status?: 'ACTIVE' | 'BLOCKED'; blockKind?: 'HOLD' | 'RECALL' | null; expiryDate?: string | null }[]): VanLotSnapshotDto => {
  const byProduct = new Map<string, VanLotSnapshotDto['products'][number]>();
  for (const l of lots) {
    const p = byProduct.get(l.productId) ?? {
      productId: l.productId, available: 0, availableNamed: 0, unknownUsable: 0, quarantined: 0, held: 0,
      expiredUnsold: 0, expiredReturned: 0, damaged: 0, lots: [],
    };
    p.lots.push({
      lotId: l.lotId, lotNumber: `V-${l.lotId}`, expiryDate: l.expiryDate ?? '2027-06-01', status: l.status ?? 'ACTIVE',
      blockKind: l.blockKind ?? null, usable: 5,
    });
    byProduct.set(l.productId, p);
  }
  return { serverTime: '2026-11-18T08:00:00.000Z', day: '2026-11-18', tracked: [...byProduct.keys()], allowUnknown: true, products: [...byProduct.values()] };
};

// ─── ردّ GET /lots/customer-history ───

test('customerLotHistoryOf: مصفوفة الخادم بترتيبها، والصفّ المعطوب يُسقط، والمكرّر يبقى أوّله', () => {
  const rows = customerLotHistoryOf([
    { lotId: 'L2', lotNumber: ' B-2 ', expiryDate: '2027-02-01T00:00:00.000Z', status: 'ACTIVE', blockKind: 'HOLD', lastSoldAt: '2026-11-12T00:00:00.000Z', soldBase: '12', returnedBase: 2 },
    { lotId: 'L1', lotNumber: 'A-1', expiryDate: null, status: 'BLOCKED', blockKind: 'RECALL', lastSoldAt: null, soldBase: null, returnedBase: 'x' },
    { lotId: 'L2', lotNumber: 'dup', expiryDate: null, status: 'ACTIVE' },
    { lotId: '', lotNumber: 'no-id', status: 'ACTIVE' },
    { lotId: 'L3', lotNumber: '   ', status: 'ACTIVE' },
    { lotId: 'L4', lotNumber: 'D-4', status: 'GONE' },
    null, 7, ['L5'],
  ]);
  assert.deepEqual(rows, [
    // blockKind للموقوفة وحدها، والكميات أرقام أو null، والتاريخ يوماً
    { lotId: 'L2', lotNumber: 'B-2', expiryDate: '2027-02-01', status: 'ACTIVE', blockKind: null, lastSoldAt: '2026-11-12T00:00:00.000Z', soldBase: 12, returnedBase: 2 },
    { lotId: 'L1', lotNumber: 'A-1', expiryDate: null, status: 'BLOCKED', blockKind: 'RECALL', lastSoldAt: null, soldBase: null, returnedBase: null },
  ]);
});

test('customerLotHistoryOf: { lots: [...] } احتياطاً، وما ليس ردّاً مفهوماً ⇒ []، والسقف ٥٠', () => {
  assert.equal(customerLotHistoryOf({ lots: [{ lotId: 'a', lotNumber: 'A', status: 'ACTIVE' }] }).length, 1);
  for (const raw of [undefined, null, 'x', 5, {}, { lots: 'x' }]) assert.deepEqual(customerLotHistoryOf(raw), []);
  const many = Array.from({ length: 80 }, (_, i) => ({ lotId: `L${i}`, lotNumber: `N${i}`, status: 'ACTIVE' }));
  const got = customerLotHistoryOf(many);
  assert.equal(CUSTOMER_LOT_HISTORY_MAX, 50);
  assert.equal(got.length, 50);
  assert.equal(got[0].lotId, 'L0', 'ترتيب الخادم (الأحدث أولاً) يبقى');
});

// ─── خيارات المنتقي ───

test('returnLotOptions: ما اشتراه العميل أولاً ثم تشغيلات السيارة لهذا الصنف — كل تشغيلة مرة', () => {
  const s = snap([
    { productId: 'P', lotId: 'V1' }, { productId: 'P', lotId: 'C1' }, { productId: 'P', lotId: 'V2', status: 'BLOCKED', blockKind: 'HOLD' },
    { productId: 'Q', lotId: 'Q1' },
  ]);
  const opts = returnLotOptions([hist('C1'), hist('C2', { status: 'BLOCKED', blockKind: 'RECALL' })], s, 'P');
  assert.deepEqual(opts.map((o) => [o.lotId, o.source]), [['C1', 'CUSTOMER'], ['C2', 'CUSTOMER'], ['V1', 'VAN'], ['V2', 'VAN']]);
  assert.equal(opts[1].blockKind, 'RECALL');
  assert.equal(opts[3].blockKind, 'HOLD');
  assert.equal(opts[2].blockKind, null);
  assert.ok(!opts.some((o) => o.lotId === 'Q1'), 'تشغيلات صنفٍ آخر لا تظهر');
});

test('returnLotOptions: دون اتصال (لا سجلّ) تشغيلات السيارة وحدها، وبلا لقطة ولا سجلّ ⇒ [] («تلقائي» وحده)', () => {
  const s = snap([{ productId: 'P', lotId: 'V1' }]);
  assert.deepEqual(returnLotOptions(null, s, 'P').map((o) => o.source), ['VAN']);
  assert.deepEqual(returnLotOptions(undefined, null, 'P'), []);
  assert.deepEqual(returnLotOptions([], s, 'X'), []);
});

test('returnLotOptions: الاختيار القائم الغائب عن القائمتين يبقى ظاهراً آخراً (PICKED)، والحاضر لا يتكرّر', () => {
  const pick = { lotId: 'OLD', lotNumber: 'O-1', expiryDate: '2027-03-03T00:00:00.000Z' };
  const opts = returnLotOptions([hist('C1')], null, 'P', pick);
  assert.deepEqual(opts.map((o) => [o.lotId, o.source]), [['C1', 'CUSTOMER'], ['OLD', 'PICKED']]);
  assert.equal(opts[1].expiryDate, '2027-03-03');
  assert.equal(returnLotOptions([hist('C1')], null, 'P', { lotId: 'C1', lotNumber: 'x', expiryDate: null }).length, 1);
});

test('returnLotPickOf / withReturnPick: الرقم والانتهاء على السطر، وnull يعيده «تلقائي» بحذف المفتاح', () => {
  const o = returnLotOptions([hist('C1', { expiryDate: '2027-01-01' })], null, 'P')[0];
  const pick = returnLotPickOf(o);
  assert.deepEqual(pick, { lotId: 'C1', lotNumber: 'N-C1', expiryDate: '2027-01-01' });
  const line: { productId: string; qty: number; retLot?: ReturnLotPick | null } = { productId: 'P', qty: 2 };
  const picked = withReturnPick(line, pick);
  assert.deepEqual(picked, { productId: 'P', qty: 2, retLot: pick });
  const auto = withReturnPick(picked, null);
  assert.ok(!('retLot' in auto), 'لا أثر للمفتاح في الجسم ولا في مفتاح المحاولة');
  assert.equal(withReturnPick(line, null), line, 'سطرٌ بلا اختيار يبقى هو نفسه');
});

// ─── متى يظهر المنتقي ───

test('returnLotLine: مرتجعٌ والميزة مفعّلة وسطرٌ حرّ بصنفٍ متتبَّع — وغير ذلك لا', () => {
  const tracked = new Set(['P']);
  assert.equal(returnLotLine(true, true, { productId: 'P' }, tracked), true);
  assert.equal(returnLotLine(false, true, { productId: 'P' }, tracked), false, 'الميزة مطفأة');
  assert.equal(returnLotLine(true, false, { productId: 'P' }, tracked), false, 'البيع لا يمرّ هنا');
  assert.equal(returnLotLine(true, true, { productId: 'P', saleItemId: 'SI' }, tracked), false, 'بند فاتورة البيع يرث تشغيلات بيعه');
  assert.equal(returnLotLine(true, true, { productId: 'U' }, tracked), false, 'صنفٌ غير متتبَّع');
  assert.equal(returnLotLine(true, true, { productId: 'P' }, null), false);
});

// ─── الحمولة ───

test('returnLineLots: [{lotId, qty أساسية}] صفٌّ واحد يساوي كمية السطر — بوحدة البند', () => {
  const pick = { lotId: 'L1', lotNumber: 'A', expiryDate: null };
  assert.deepEqual(returnLineLots(pick, { qty: 3 }), [{ lotId: 'L1', qty: 3 }]);
  assert.deepEqual(returnLineLots(pick, { qty: 2, unitFactor: 12 }), [{ lotId: 'L1', qty: 24 }], 'كرتونان × ١٢ = ٢٤ أساسية');
  assert.deepEqual(returnLineLots(pick, { qty: '1.5', unitFactor: 1 }), [{ lotId: 'L1', qty: 1.5 }]);
});

test('returnLineLots: «تلقائي» (undefined، لا حقل) بلا اختيار أو لبند فاتورة بيع أو كمية غير موجبة أو خارج شبكة الأربع خانات', () => {
  const pick = { lotId: 'L1', lotNumber: 'A', expiryDate: null };
  assert.equal(returnLineLots(null, { qty: 3 }), undefined);
  assert.equal(returnLineLots(undefined, { qty: 3 }), undefined);
  assert.equal(returnLineLots(pick, { qty: 3, saleItemId: 'SI' }), undefined);
  assert.equal(returnLineLots(pick, { qty: 0 }), undefined);
  assert.equal(returnLineLots(pick, { qty: -1 }), undefined);
  assert.equal(returnLineLots(pick, { qty: 'abc' }), undefined);
  assert.equal(returnLineLots(pick, { qty: 1.00005 }), undefined, 'الخادم يحكم على الكمية نفسها، ولا نكون سبب الرفض');
  assert.equal(returnLineLots({ lotId: '', lotNumber: 'A', expiryDate: null }, { qty: 1 }), undefined);
});

test('returnPickDocLots: رقم التشغيلة على الورقة دون اتصال من الحمولة نفسها — ما لم يُرسَل لا يُطبع', () => {
  const pick = { lotId: 'L1', lotNumber: 'A-1', expiryDate: '2027-01-01' };
  assert.deepEqual(returnPickDocLots(pick, [{ lotId: 'L1', qty: 24 }]), [{ lotNumber: 'A-1', qty: 24, expiryDate: '2027-01-01' }]);
  assert.equal(returnPickDocLots(pick, undefined), undefined);
  assert.equal(returnPickDocLots(null, [{ lotId: 'L1', qty: 1 }]), undefined);
  assert.equal(returnPickDocLots(pick, [{ lotId: 'L2', qty: 1 }]), undefined);
  assert.equal(returnPickDocLots(pick, [{ lotId: 'L1', qty: 1 }, { lotId: 'L1', qty: 1 }]), undefined);
});

// ─── رفض الخادم الحيّ ───

test('lotRejectLine: فهرس البند من detail.line، وبلاه أول سطرٍ اختار detail.lotId — وغير رموز اللوط null', () => {
  assert.equal(lotRejectLine({ code: 'LOT_NOT_FOUND', detail: { line: 1, lotId: 'X' } }, 3), 1);
  assert.equal(lotRejectLine({ code: 'LOT_PRODUCT_MISMATCH', detail: { line: 5 } }, 3), null, 'خارج المدى');
  assert.equal(lotRejectLine({ code: 'LOT_NOT_FOUND', detail: { line: 1.5 } }, 3), null);
  assert.equal(lotRejectLine({ code: 'PRICE_BELOW', detail: { line: 0 } }, 3), null);
  assert.equal(lotRejectLine(null, 3), null);
  assert.equal(lotRejectLine('x', 3), null);
  // خادمٌ بلا فهرس: المعرّف المرفوض
  assert.equal(lotRejectLine({ code: 'LOT_NOT_FOUND', detail: { lotId: 'L2' } }, 3, [undefined, 'L2', 'L2']), 1);
  assert.equal(lotRejectLine({ code: 'LOT_NOT_FOUND', detail: { lotId: 'L9' } }, 3, [undefined, 'L2', null]), null);
  assert.equal(lotRejectLine({ code: 'LOT_NOT_FOUND', detail: { lotId: 'L2' } }, 3), null);
  assert.equal(lotRejectLine({ code: 'LOT_NOT_FOUND', detail: { lotId: 'L2' } }, 1, [null, 'L2']), null, 'فهرسٌ خارج أسطر السلّة');
});

// ─── حرّاس نصّية على التطبيق ───

test('RepApp: المنتقي للمرتجع الحرّ وحده — لا للبيع ولا للمرتجع المربوط، والبيع على حاله', () => {
  const s = read('src', 'rep', 'RepApp.tsx');
  assert.match(s, /const retLotOn = lotOn && isReturn && !saleRef;/);
  // التلميح والمتاح المحلي للبيع وحده كما كان
  assert.match(s, /const lotCapsOn = lotOn && !isReturn;/);
  assert.match(s, /const retLotShown = \(l: any\): boolean => returnLotLine\(retLotOn, isReturn, l, retTracked\);/);
  // الحقل يُبنى من الاختيار وحده عبر retLotShown — «تلقائي» بلا مفتاح
  assert.match(s, /const r = retLotShown\(l\) \? returnLineLots\(l\.retLot, l\) : undefined;\n\s*return r \? \{ lots: r \} : \{\};/);
  // الافتراض «تلقائي» قيمةٌ فارغة في المنتقي
  assert.match(s, /<option value="">\{tr\('تلقائي'\)\}<\/option>/);
});

test('RepApp: الحمولة تحمل lots في بنودها، والصندوق الأوف‑لاين يحفظ الحمولة نفسها', () => {
  const s = read('src', 'rep', 'RepApp.tsx');
  const start = s.indexOf('items: lines.map(l => ({\n        productId: l.productId, qty: l.qty, unitPrice: l.unitPrice');
  assert.ok(start > 0, 'بنود حمولة الفاتورة');
  const body = s.slice(start, s.indexOf('})),', start));
  assert.match(body, /\.\.\.retLotsOf\(l\),/);
  // المسار الأوف‑لاين: الحمولة (بلا تحويلٍ للمرتجع) هي ما يُصفّ
  const off = s.slice(s.indexOf("const lotPlan = await lotOfflinePlan(payload.items, printItems);"), s.indexOf("await outboxAdd({ clientRef, repId: currentRepId(), kind: 'invoice', payload,"));
  assert.ok(off.length > 0);
  assert.match(off, /returnPickDocLots\(lines\[i\]\?\.retLot, sent\[i\]\?\.lots\)/);
  assert.doesNotMatch(off, /payload\.items = [^;]*retLot/, 'لا يُعاد بناء بنود المرتجع في الصفّ');
});

test('RepApp: السجلّ متصلاً من المسار الجديد لعميلٍ خادمي، ودون اتصال لقطة السيارة', () => {
  const s = read('src', 'rep', 'RepApp.tsx');
  assert.equal(CUSTOMER_LOT_HISTORY_PATH, '/lots/customer-history');
  assert.match(s, /repApi\.get\(CUSTOMER_LOT_HISTORY_PATH, \{ params: \{ customerId: customer\.id, productId: pid \}, background: true \}\)/);
  assert.match(s, /if \(!retPids \|\| !showCart \|\| customer\?\._offline \|\| !customer\?\.id \|\| String\(customer\.id\)\.startsWith\('local-'\) \|\| !navigator\.onLine\) return;/);
  assert.match(s, /returnLotOptions\(retHistory\[l\.productId\] \?\? null, retStored\?\.snap \?\? null, l\.productId, l\.retLot \?\? null\)/);
  // رفضٌ حيّ لتشغيلةٍ اختارها المندوب يعيد سطرها «تلقائي»
  assert.match(s, /lotRejectLine\(err\?\.response\?\.data, lines\.length, lines\.map\(x => x\.retLot\?\.lotId\)\)/);
});
