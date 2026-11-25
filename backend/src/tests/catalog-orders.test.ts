// «طلب من المنيو» (طلب المالك ٢٤ نوفمبر ٢٠٢٦) — المنطق الصافي (services/catalogOrders.ts)، والمساران الحقيقيان فوق Prisma
// مزيّف في الذاكرة بلا قاعدة ولا شبكة: الإرسال العلني POST /api/public/catalog/:tenantId/:repId/orders (routes/publicCatalog.ts)
// وطلبات المندوب /api/catalog-orders (routes/catalogOrders.ts)، وحرّاس ثابتة في المصدر. يثبت:
//   • الأسعار لقطةٌ من القاعدة لا من العميل، والنسبة صفرٌ للشركة «بلا ضريبة»، وصنفٌ أو وحدةٌ غير صالحة تردّ الطلب كله.
//   • المصيدة، وإعادة المحاولة بالمرجع نفسه (ومنها سباق P2002)، وسقف المندوب، والحجم، وبوّابات ٤٠٤ كالمنيو.
//   • المندوب لا يرى ولا يغيّر إلا طلباته في شركته، ومطابقة الجوال بعميلٍ يصل إليه وحده (عزل العملاء).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG_ORDER_CODES, MAX_ORDER_BODY_BYTES, asciiDigits, canDecide, hasAtMost3Decimals, isHoneypotHit, matchableKey, menuPriceOf,
  mergeOrderLines, openCapReached, openCounts, orderBodyTooLarge, orderPhoneKey, orderPushPayload, parseOrderBody,
  parseStatusBody, phoneTail, pickMatchedCustomer, priceOrderLines, shapeOrder, type CatalogProductRow, type MenuPriceList,
} from '../services/catalogOrders';
import { CATALOG_ORDERS_PER_REP_PER_HOUR, ipRateKey } from '../middleware/rateLimits';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const T = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';
const CREF = '44444444-4444-4444-8444-444444444444';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const P3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const PX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
const U1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const U3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const ORDER = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

// ═══════════════ المنطق الصافي ═══════════════

const validBody = (over: Row = {}): Row => ({
  clientRef: CREF, name: '  أبو   محمد ', phone: '٠٥٠١٢٣٤٥٦٧', note: '  بعد العصر ',
  items: [{ productId: P1, unitId: U1, qty: 2 }, { productId: P2, qty: 3 }],
  ...over,
});

test('جسم الطلب: الاسم سطرٌ واحد، والجوال بأرقامٍ لاتينية، والملاحظة الفارغة null، والوحدة الغائبة أساس', () => {
  const r = parseOrderBody(validBody());
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.value, {
    clientRef: CREF, name: 'أبو محمد', phone: '0501234567', note: 'بعد العصر',
    items: [{ productId: P1, unitId: U1, qty: 2 }, { productId: P2, unitId: null, qty: 3 }],
  });
  const blank = parseOrderBody(validBody({ note: '   ' }));
  assert.ok(blank.ok && blank.value.note === null);
  const none = parseOrderBody(validBody({ note: undefined }));
  assert.ok(none.ok && none.value.note === null);
  // ما لا يعرفه الجسم يُسقط — ومنه سعرٌ يرسله العميل
  const priced = parseOrderBody(validBody({ items: [{ productId: P1, unitId: null, qty: 1, unitPrice: 0.01 }], total: 1 }));
  assert.ok(priced.ok);
  assert.deepEqual(priced.ok && priced.value.items, [{ productId: P1, unitId: null, qty: 1 }]);
});

test('جسم الطلب المعيب: أول حقلٍ معيب يُسمّى', () => {
  const field = (over: Row) => { const r = parseOrderBody(validBody(over)); return r.ok ? null : r.field; };
  assert.equal(field({ clientRef: 'abc' }), 'clientRef');
  assert.equal(field({ clientRef: undefined }), 'clientRef');
  assert.equal(field({ name: ' أ ' }), 'name');
  assert.equal(field({ name: 'م'.repeat(81) }), 'name');
  assert.equal(field({ phone: 'abcde' }), 'phone', 'بلا أرقامٍ لا اتصال');
  assert.equal(field({ phone: '1234' }), 'phone');
  assert.equal(field({ phone: '1'.repeat(31) }), 'phone');
  assert.equal(field({ note: 'ن'.repeat(301) }), 'note');
  assert.equal(field({ items: [] }), 'items');
  assert.equal(field({ items: Array.from({ length: 101 }, () => ({ productId: P1, unitId: null, qty: 1 })) }), 'items');
  for (const qty of [0, -1, 100000.5, 1.0005, Number.NaN, '2']) assert.equal(field({ items: [{ productId: P1, unitId: null, qty }] }), 'items', String(qty));
  assert.equal(parseOrderBody(null).ok, false);
  assert.equal(parseOrderBody('x').ok, false);
});

test('الكمية: ثلاث منازل عشرية على الأكثر، والسقف ١٠٠٠٠٠', () => {
  for (const q of [1, 0.001, 1.005, 2.125, 100000]) assert.ok(hasAtMost3Decimals(q), String(q));
  for (const q of [0.0001, 1.0005, Number.NaN, Infinity]) assert.ok(!hasAtMost3Decimals(q), String(q));
  const r = parseOrderBody(validBody({ items: [{ productId: P1, unitId: null, qty: 100000 }, { productId: P2, unitId: null, qty: 0.001 }] }));
  assert.ok(r.ok);
});

test('المصيدة: الحقل المخفي الممتلئ أو غير النصّي روبوت، والفارغ والغائب إنسان', () => {
  for (const w of [undefined, null, '', '   ']) assert.equal(isHoneypotHit({ website: w }), false, String(w));
  for (const w of ['x', 'https://spam', 0, false, {}, []]) assert.equal(isHoneypotHit({ website: w }), true, JSON.stringify(w));
  assert.equal(isHoneypotHit(null), false);
  assert.equal(isHoneypotHit('str'), false);
});

test('الحجم: البايتات الخام أولاً وإلا Content-Length، والحدّ ٢٠ ك.ب', () => {
  assert.equal(MAX_ORDER_BODY_BYTES, 20 * 1024);
  assert.equal(orderBodyTooLarge(20480, undefined), false);
  assert.equal(orderBodyTooLarge(20481, undefined), true);
  assert.equal(orderBodyTooLarge(100, '999999'), false, 'الخام يغلب الترويسة');
  assert.equal(orderBodyTooLarge(undefined, '30000'), true);
  assert.equal(orderBodyTooLarge(undefined, undefined), false);
});

test('الأسطر المكرّرة (الصنف بوحدته) تُجمع بترتيب أول ظهور، والوحدتان سطران، وما تجاوز السقف بعد الجمع معيب', () => {
  assert.deepEqual(mergeOrderLines([
    { productId: P1, unitId: U1, qty: 2 }, { productId: P2, unitId: null, qty: 0.1 }, { productId: P1, unitId: null, qty: 1 },
    { productId: P1, unitId: U1, qty: 3 }, { productId: P2, unitId: null, qty: 0.2 },
  ]), [{ productId: P1, unitId: U1, qty: 5 }, { productId: P2, unitId: null, qty: 0.3 }, { productId: P1, unitId: null, qty: 1 }]);
  assert.equal(mergeOrderLines([{ productId: P1, unitId: null, qty: 60000 }, { productId: P1, unitId: null, qty: 60000 }]), null);
});

const PRODUCTS: CatalogProductRow[] = [
  { id: P1, name: 'ماء', basePrice: 1, taxPct: 15, units: [
    { id: U1, name: 'كرتون', factor: 24, price: 20 }, { id: U2, name: 'شدة', factor: 6, price: null }, { id: U3, name: 'طبلية', factor: 1200, price: 900, isActive: false },
  ] },
  { id: P2, name: 'عصير', basePrice: 2.5, taxPct: 5, units: [] },
];

test('التسعير من القاعدة: الوحدة بسعرها (وإلا الأساس × المعامل) والأساس بسعره، واسم الصنف ونسبته من صفّه', () => {
  const r = priceOrderLines([
    { productId: P1, unitId: U1, qty: 2 }, { productId: P1, unitId: U2, qty: 1 }, { productId: P2, unitId: null, qty: 3 },
  ], PRODUCTS, { taxDisabled: false });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.lines, [
    { productId: P1, productName: 'ماء', unitName: 'كرتون', unitFactor: 24, qty: 2, unitPrice: 20, taxPct: 15 },
    { productId: P1, productName: 'ماء', unitName: 'شدة', unitFactor: 6, qty: 1, unitPrice: 6, taxPct: 15 },
    { productId: P2, productName: 'عصير', unitName: null, unitFactor: 1, qty: 3, unitPrice: 2.5, taxPct: 5 },
  ]);
});

test('التسعير لشركةٍ «بلا ضريبة»: النسبة صفر لكل سطر والسعر كما هو', () => {
  const r = priceOrderLines([{ productId: P1, unitId: U1, qty: 1 }, { productId: P2, unitId: null, qty: 1 }], PRODUCTS, { taxDisabled: true });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.lines.map((l) => [l.unitPrice, l.taxPct]), [[20, 0], [2.5, 0]]);
});

test('صنفٌ غائب (شركةٌ أخرى، موقوف، محذوف) أو وحدةٌ موقوفة أو لصنفٍ آخر ⇒ الطلب كله مرفوض', () => {
  const bad = (items: { productId: string; unitId: string | null; qty: number }[]) => priceOrderLines(items, PRODUCTS, null).ok;
  assert.equal(bad([{ productId: PX, unitId: null, qty: 1 }]), false);
  assert.equal(bad([{ productId: P2, unitId: null, qty: 1 }, { productId: PX, unitId: null, qty: 1 }]), false, 'لا نصف طلب');
  assert.equal(bad([{ productId: P1, unitId: U3, qty: 1 }]), false, 'الموقوفة');
  assert.equal(bad([{ productId: P2, unitId: U1, qty: 1 }]), false, 'وحدة صنفٍ آخر');
  assert.equal(bad([{ productId: P1, unitId: 'nope', qty: 1 }]), false);
});

test('سقف المندوب: مئة طلبٍ مفتوح ⇒ الجديد مرفوض', () => {
  assert.equal(openCapReached(99), false);
  assert.equal(openCapReached(100), true);
  assert.equal(openCapReached(150), true);
});

// ─── «الأسعار تظهر للعملاء حسب تسعير الشركة» (المالك ٢٤ نوفمبر ٢٠٢٦): قائمة المندوب الافتراضية ───

const CAT = 'cat-drinks';
/** ماء: أساس ١، كرتون ٢٤ بسعر ٢٠ رئيسيّ، شدة ٦ بلا سعر · عصير: أساس ٢٫٥ بلا وحدات، في فئة المشروبات */
const LP_WATER = { id: P1, basePrice: 1, categoryId: null, primaryUnitId: U1, units: [
  { id: U1, name: 'كرتون', factor: 24, price: 20 }, { id: U2, name: 'شدة', factor: 6, price: null },
] };
const LP_JUICE = { id: P2, basePrice: 2.5, categoryId: CAT, primaryUnitId: null, units: [] };
const W_CARTON = LP_WATER.units[0];
const W_SIX = LP_WATER.units[1];
const listOf = (over: Partial<MenuPriceList> = {}): MenuPriceList => ({ itemOf: new Map(), rules: [], day: '2026-11-24', ...over });

test('سعر المنيو بلا قائمة: سعر اليوم حرفاً — الأساس كما هو، والوحدة المحدَّد سعرها وإلا الأساس × المعامل', () => {
  assert.equal(menuPriceOf(LP_WATER, null, null), 1);
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, null), 20);
  assert.equal(menuPriceOf(LP_WATER, W_SIX, undefined), 6);
  assert.equal(menuPriceOf(LP_JUICE, null, null), 2.5);
  // قائمةٌ لا تقول شيئاً عن الصنف ⇒ سعر اليوم نفسه
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, listOf()), 20);
  assert.equal(menuPriceOf(LP_JUICE, null, listOf({ itemOf: new Map([[P1, 0.75]]) })), 2.5);
});

test('سعر المنيو بقائمة: الثابت لوحدة الأساس × معامل الوحدة، والنسبة من سعر اليوم، وقاعدة الفئة للرئيسية', () => {
  const fixed = listOf({ itemOf: new Map([[P1, 0.75]]) });
  assert.equal(menuPriceOf(LP_WATER, null, fixed), 0.75);
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, fixed), 18, '٠٫٧٥ × ٢٤ — لا سعر الكرتون المحدَّد');
  assert.equal(menuPriceOf(LP_WATER, W_SIX, fixed), 4.5);
  // نسبة ١٠٪ على كل الأصناف: من سعر اليوم لكل وحدة (الكرتون المحدَّد ٢٠ ⇒ ١٨، والشدة المشتقّة ٦ ⇒ ٥٫٤)
  const pct = listOf({ rules: [{ id: 'r-all', scope: 'all', kind: 'percent', percent: 10 }] });
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, pct), 18);
  assert.equal(menuPriceOf(LP_WATER, W_SIX, pct), 5.4);
  assert.equal(menuPriceOf(LP_JUICE, null, pct), 2.25);
  // قاعدة فئة بسعرٍ ثابت للرئيسية — العصير بلا رئيسية ⇒ سعرٌ لوحدة الأساس
  const cat = listOf({ rules: [{ id: 'r-cat', scope: 'category', categoryId: CAT, kind: 'fixed', primaryPrice: 2 }] });
  assert.equal(menuPriceOf(LP_JUICE, null, cat), 2);
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, cat), 20, 'الفئة لا تشمل الماء ⇒ سعر اليوم');
  // التقريب لأربع منازل كنموذج فاتورة المندوب: ٢٠ ÷ ٢٤ لوحدة الأساس (ستّ منازل) ثم × ٦
  const tiny = listOf({ itemOf: new Map([[P1, 0.833333]]) });
  assert.equal(menuPriceOf(LP_WATER, W_SIX, tiny), 5);
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, tiny), 20);
});

test('سعر المنيو بقائمة: كمية وحدةٍ رئيسيةٍ واحدة ويوم الشركة — شريحة الكمية الأعلى والعرض المنتهي لا يسريان', () => {
  const rules = [
    { id: 'r-bulk', scope: 'product', productId: P1, kind: 'fixed', basePrice: 0.5, minQty: 10 },
    { id: 'r-old', scope: 'product', productId: P1, kind: 'fixed', basePrice: 0.6, startsOn: '2026-11-01', endsOn: '2026-11-20' },
    { id: 'r-now', scope: 'product', productId: P1, kind: 'percent', percent: 25, startsOn: '2026-11-24', endsOn: '2026-11-30' },
  ];
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, listOf({ rules })), 15, 'العرض الساري اليوم: ٢٥٪ من ٢٠');
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, listOf({ rules, day: '2026-11-15' })), 14.4, 'العرض المؤقّت في فترته: ٠٫٦ × ٢٤');
  assert.equal(menuPriceOf(LP_WATER, W_CARTON, listOf({ rules, day: '2026-12-05' })), 20, 'لا شيء ساري ⇒ سعر اليوم');
});

test('لقطة الطلب بقائمة: priceOrderLines يسعّر بـmenuPriceOf نفسها — ما يحفظه الطلب هو ما عرضه المنيو', () => {
  const list = listOf({ itemOf: new Map([[P1, 0.75]]), rules: [{ id: 'r-all', scope: 'all', kind: 'percent', percent: 10 }] });
  const rows: CatalogProductRow[] = [{ ...LP_WATER, name: 'ماء', taxPct: 15 }, { ...LP_JUICE, name: 'عصير', taxPct: 5 }];
  const r = priceOrderLines([
    { productId: P1, unitId: U1, qty: 2 }, { productId: P1, unitId: U2, qty: 1 }, { productId: P1, unitId: null, qty: 4 }, { productId: P2, unitId: null, qty: 3 },
  ], rows, { taxDisabled: false }, list);
  assert.ok(r.ok);
  const prices = r.ok ? r.lines.map((l) => l.unitPrice) : [];
  assert.deepEqual(prices, [menuPriceOf(LP_WATER, W_CARTON, list), menuPriceOf(LP_WATER, W_SIX, list), menuPriceOf(LP_WATER, null, list), menuPriceOf(LP_JUICE, null, list)]);
  // ثابت الصنف (قاعدة صنف) يغلب نسبة «كل الأصناف»، والعصير بلا ثابت ⇒ النسبة
  assert.deepEqual(prices, [18, 4.5, 0.75, 2.25]);
  // بلا قائمة ⇒ كما كان حرفاً
  const plain = priceOrderLines([{ productId: P1, unitId: U1, qty: 1 }, { productId: P2, unitId: null, qty: 1 }], rows, null);
  assert.deepEqual(plain.ok && plain.lines.map((l) => l.unitPrice), [20, 2.5]);
});

// ─── حدّ المعدّل: IPv6 بشبكته، ولكل مندوب ───

test('مفتاح IP لحدّ المعدّل: IPv4 كما هو، والمعيَّن عنوانه الرابع، وIPv6 بشبكته /56', () => {
  assert.equal(ipRateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipRateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipRateKey('2001:db8:abcd:12ff::1'), '2001:db8:abcd:1200:0:0:0:0/56');
  // عنوانان في الشبكة /56 نفسها ⇒ دلوٌ واحد مهما اختلف ذيلهما
  assert.equal(ipRateKey('2001:db8:abcd:1201:aaaa:bbbb:cccc:dddd'), ipRateKey('2001:db8:abcd:12fe::9'));
  assert.notEqual(ipRateKey('2001:db8:abcd:1300::1'), ipRateKey('2001:db8:abcd:1200::1'));
  assert.equal(ipRateKey('::1'), '0:0:0:0:0:0:0:0/56');
  assert.equal(ipRateKey('2001:db8::1', 64), '2001:db8:0:0:0:0:0:0/64');
  assert.equal(ipRateKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0:0:0:0:0/56', 'الذيل IPv4 داخل IPv6');
  assert.equal(ipRateKey(undefined), '');
  assert.equal(ipRateKey('not-an-ip'), 'not-an-ip');
});

test('حدّ المندوب: ثلاثون طلباً في الساعة لكل مندوب مهما بدّل المرسل عنوانه ⇒ 429 CATALOG_ORDER_LIMIT، ومندوبٌ آخر بدلوه', async () => {
  const { catalogOrderRepLimiter: lim } = require('../middleware/rateLimits') as typeof import('../middleware/rateLimits');
  const hit = async (repId: string, i: number): Promise<{ next: boolean; status: number; body: unknown }> => {
    const res: Row = { statusCode: 200, headers: {}, writableEnded: false, headersSent: false };
    res.setHeader = (k: string, v: unknown) => { res.headers[k.toLowerCase()] = v; };
    res.getHeader = (k: string) => res.headers[k.toLowerCase()];
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.send = (b: unknown) => { res.body = b; res.writableEnded = true; return res; };
    res.json = res.send;
    res.on = () => res;
    let next = false;
    const req = { params: { repId }, ip: `2001:db8:${i.toString(16)}::1`, headers: {}, method: 'POST', app: { get: () => 1 } };
    await (lim as unknown as (q: Row, s: Row, n: () => void) => Promise<void>)(req, res, () => { next = true; });
    return { next, status: res.statusCode, body: res.body };
  };
  const repA = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  for (let i = 0; i < CATALOG_ORDERS_PER_REP_PER_HOUR; i++) assert.ok((await hit(repA, i)).next, `الطلب ${i + 1}`);
  const over = await hit(repA, 999);
  assert.equal(over.next, false);
  assert.equal(over.status, 429);
  assert.equal((over.body as Row).code, 'CATALOG_ORDER_LIMIT');
  assert.ok((await hit('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 0)).next, 'دلو كل مندوبٍ مستقلّ');
});

test('إشعار المندوب: نصّ العقد حرفاً وفتح شاشة الطلبات', () => {
  assert.deepEqual(orderPushPayload('أبو محمد', 3), { title: 'طلب جديد من المنيو', body: 'أبو محمد — 3 صنف', tag: 'catalog-order', url: '/rep?screen=orders' });
});

test('مفتاح الجوال: الأرقام الهندية والصيغ المحلية والدولية مفتاحٌ واحد، والفارغ null', () => {
  assert.equal(asciiDigits('٠٥٥ ۱۲۳'), '055 123');
  for (const p of ['0501234567', '+966 50 123 4567', '00966501234567', '٠٥٠١٢٣٤٥٦٧', '501234567']) assert.equal(orderPhoneKey(p), '966501234567', p);
  assert.equal(orderPhoneKey(''), null);
  assert.equal(orderPhoneKey(null), null);
  assert.equal(orderPhoneKey('abc'), null);
  assert.equal(phoneTail('966501234567'), '01234567');
});

test('المطابقة: أحدث عميلٍ يصل إليه المندوب بالمفتاح نفسه — والمفتاح القصير أو المكرّر لا يطابق شيئاً', () => {
  const key = orderPhoneKey('0501234567');
  const cands = [
    { id: 'C-old', name: 'بقالة قديمة', phone: '+966501234567', createdAt: new Date('2026-01-01') },
    { id: 'C-new', name: 'بقالة جديدة', phone: '050 123 4567', createdAt: new Date('2026-06-01') },
    { id: 'C-other', name: 'غيره', phone: '0559999999', createdAt: new Date('2026-09-01') },
    { id: 'C-tail', name: 'ذيلٌ مشترك', phone: '0601234567', createdAt: new Date('2026-10-01') },
  ];
  assert.deepEqual(pickMatchedCustomer(key, cands, () => true), { id: 'C-new', name: 'بقالة جديدة' });
  assert.deepEqual(pickMatchedCustomer(key, cands, (id) => id !== 'C-new'), { id: 'C-old', name: 'بقالة قديمة' }, 'العزل يسقط غير المُسنَد');
  assert.equal(pickMatchedCustomer(key, cands, () => false), null);
  assert.equal(pickMatchedCustomer(orderPhoneKey('0000000000'), [{ id: 'Z', name: 'ز', phone: '0000000000', createdAt: new Date() }], () => true), null);
  assert.equal(pickMatchedCustomer(orderPhoneKey('12345'), [{ id: 'S', name: 'س', phone: '12345', createdAt: new Date() }], () => true), null);
  assert.equal(pickMatchedCustomer(null, cands, () => true), null);
  assert.ok(matchableKey('96650123'));
  assert.ok(!matchableKey('9665012'));
  assert.ok(!matchableKey('11111111'));
});

test('الإغلاق: DONE أو CANCELLED من مفتوحٍ وحده، والفاتورة مع «تم» وحدها', () => {
  assert.ok(canDecide('NEW') && canDecide('SEEN'));
  assert.ok(!canDecide('DONE') && !canDecide('CANCELLED') && !canDecide(undefined));
  assert.deepEqual(parseStatusBody({ status: 'DONE', invoiceId: 'INV-1' }), { ok: true, status: 'DONE', invoiceId: 'INV-1' });
  assert.deepEqual(parseStatusBody({ status: 'DONE' }), { ok: true, status: 'DONE', invoiceId: null });
  assert.deepEqual(parseStatusBody({ status: 'CANCELLED' }), { ok: true, status: 'CANCELLED', invoiceId: null });
  assert.deepEqual(parseStatusBody({ status: 'CANCELLED', invoiceId: 'INV-1' }), { ok: false, field: 'invoiceId' });
  assert.deepEqual(parseStatusBody({ status: 'SEEN' }), { ok: false, field: 'status' });
  assert.deepEqual(parseStatusBody({}), { ok: false, field: 'status' });
});

test('عدّادا الأيقونة: المفتوح كله والجديد منه، والمغلق لا يُعدّ', () => {
  assert.deepEqual(openCounts([{ status: 'NEW', _count: { _all: 2 } }, { status: 'SEEN', _count: { _all: 3 } }, { status: 'DONE', _count: { _all: 9 } }]), { open: 5, fresh: 2 });
  assert.deepEqual(openCounts([]), { open: 0, fresh: 0 });
});

test('شكل الطلب للمندوب: بلا مفاتيح داخلية', () => {
  const o = shapeOrder({
    id: 'O', status: 'NEW', customerName: 'أ', customerPhone: '0501234567', note: null, invoiceId: null, decidedAt: null,
    createdAt: new Date(0), items: [{ id: 'I', productId: P1, productName: 'ماء', unitName: null, unitFactor: 1, qty: 1, unitPrice: 1, taxPct: 15 }],
    ...({ tenantId: T, salesRepId: R, clientRef: CREF, phoneKey: '966501234567' } as Row),
  } as any, null);
  for (const k of ['tenantId', 'salesRepId', 'clientRef', 'phoneKey']) assert.ok(!(k in o), k);
  assert.equal(o.matchedCustomer, null);
});

// ═══════════════ Prisma مزيّف والمساران الحقيقيان ═══════════════

process.env.JWT_SECRET = process.env.JWT_SECRET || 'catalog-orders-test-secret';

interface State {
  tenant: Row | null; company: Row | null; rep: Row | null; isolation: boolean;
  products: Row[]; orders: Row[]; openCount: number; createError: unknown; raceRow: Row | null;
  list: Row[]; groups: Row[]; updateCount: number; found: Row | null; invoice: Row | null;
  candidates: Row[]; visible: string[]; listItems: Row[]; listRules: Row[];
  calls: { op: string; args: Row }[]; pushes: [string, Row][]; pushError: boolean;
}
let st: State;
const reset = (over: Partial<State> = {}) => {
  st = {
    tenant: { isActive: true, catalogEnabled: true }, company: { name: 'شركة', logo: null, primaryColor: null, currency: 'SAR', phone: null, taxDisabled: false },
    rep: { id: R, name: 'خالد', phone: '0500000000' }, isolation: false,
    products: [
      { id: P1, tenantId: T, status: 'ACTIVE', deletedAt: null, name: 'ماء', unit: 'حبة', basePrice: 1, taxPct: 15, image: null, primaryUnitId: U1, category: { name: 'مشروبات' },
        units: [{ id: U1, name: 'كرتون', factor: 24, price: 20, isActive: true }, { id: U2, name: 'شدة', factor: 6, price: null, isActive: true }, { id: U3, name: 'طبلية', factor: 1200, price: 900, isActive: false }] },
      { id: P2, tenantId: T, status: 'ACTIVE', deletedAt: null, name: 'عصير', unit: 'علبة', basePrice: 2.5, taxPct: 15, image: null, primaryUnitId: null, category: null, units: [] },
      { id: P3, tenantId: T, status: 'INACTIVE', deletedAt: null, name: 'موقوف', unit: 'حبة', basePrice: 1, taxPct: 15, image: null, primaryUnitId: null, category: null, units: [] },
      { id: PX, tenantId: 'other', status: 'ACTIVE', deletedAt: null, name: 'غريب', unit: 'حبة', basePrice: 1, taxPct: 15, image: null, primaryUnitId: null, category: null, units: [] },
    ],
    orders: [], openCount: 0, createError: null, raceRow: null,
    list: [], groups: [], updateCount: 1, found: null, invoice: null, candidates: [], visible: [], listItems: [], listRules: [],
    calls: [], pushes: [], pushError: false,
    ...over,
  };
};
reset();
const log = (op: string, args: Row) => { st.calls.push({ op, args }); };
const calls = (op: string) => st.calls.filter((c) => c.op === op);

const db: Row = {
  tenant: { async findUnique(a: Row) { log('tenant.findUnique', a); return st.tenant; } },
  companySettings: {
    async findUnique(a: Row) {
      log('companySettings.findUnique', a);
      if (a.select?.customerIsolationEnabled) return { customerIsolationEnabled: st.isolation };
      return st.company;
    },
  },
  salesRep: { async findFirst(a: Row) { log('salesRep.findFirst', a); return st.rep && a.where.id === st.rep.id && a.where.tenantId === T && a.where.isActive === true ? st.rep : null; } },
  workChannel: { async findFirst() { return null; } },
  product: {
    async findMany(a: Row) {
      log('product.findMany', a);
      const w = a.where;
      return st.products
        .filter((p) => p.tenantId === w.tenantId && p.status === w.status && p.deletedAt === w.deletedAt && (!w.id || w.id.in.includes(p.id)))
        .map((p) => ({ ...p, units: p.units.filter((u: Row) => u.isActive === a.select.units.where.isActive) }));
    },
  },
  catalogOrder: {
    async findUnique(a: Row) {
      log('catalogOrder.findUnique', a);
      const k = a.where.tenantId_clientRef;
      return st.orders.find((o) => o.tenantId === k.tenantId && o.clientRef === k.clientRef) ?? null;
    },
    async count(a: Row) { log('catalogOrder.count', a); return st.openCount; },
    async create(a: Row) {
      log('catalogOrder.create', a);
      if (st.createError) {
        const e = st.createError;
        st.createError = null;
        if (st.raceRow) st.orders.push(st.raceRow);
        throw e;
      }
      const row = { id: 'O-NEW', ...a.data };
      st.orders.push(row);
      return { id: row.id };
    },
    async findMany(a: Row) { log('catalogOrder.findMany', a); return st.list; },
    async groupBy(a: Row) { log('catalogOrder.groupBy', a); return st.groups; },
    async updateMany(a: Row) { log('catalogOrder.updateMany', a); return { count: st.updateCount }; },
    async findFirst(a: Row) { log('catalogOrder.findFirst', a); return st.found; },
  },
  invoice: { async findFirst(a: Row) { log('invoice.findFirst', a); return st.invoice; } },
  priceListItem: {
    async findMany(a: Row) {
      log('priceListItem.findMany', a);
      const w = a.where;
      return st.listItems.filter((i) => i.tenantId === w.tenantId && i.priceListId === w.priceListId && w.productId.in.includes(i.productId));
    },
  },
  glSettings: { async findUnique() { return null; } },
  customer: {
    async findMany(a: Row) { log('customer.findMany', a); return st.visible.filter((id) => a.where.id.in.includes(id)).map((id) => ({ id })); },
  },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?').replace(/\s+/g, ' ');
    log('$queryRaw', { sql, values });
    // قواعد القائمة (rulesOfLists في routes/priceLists.ts) — وغيرها مرشّحو مطابقة الجوال
    if (sql.includes('FROM price_list_rules')) return st.listRules;
    return st.candidates;
  },
};
stub('config/database', { default: db });
stub('services/webPush', {
  async sendPushToRep(repId: string, payload: Row) {
    st.pushes.push([repId, payload]);
    if (st.pushError) throw new Error('push down');
    return 1;
  },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const publicRouter = (require('../routes/publicCatalog') as typeof import('../routes/publicCatalog')).default;
const repRouter = (require('../routes/catalogOrders') as typeof import('../routes/catalogOrders')).default;
const { catalogOrderLimiter, catalogOrderRepLimiter } = require('../middleware/rateLimits') as typeof import('../middleware/rateLimits');
/* eslint-enable @typescript-eslint/no-var-requires */

const routeLayer = (router: unknown, method: 'get' | 'post', p: string): Row => {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  return layer!;
};
/** معالج المسار الأخير وحده (بعد حدّ المعدّل وحرّاس الموجّه) */
async function call(router: unknown, method: 'get' | 'post', p: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = routeLayer(router, method, p);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  let err: unknown = null;
  await (layer.route.stack as Row[]).at(-1)!.handle({ query: {}, params: {}, headers: {}, body: {}, ...req }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}
const tick = () => new Promise((r) => setImmediate(r));

// ─── الإرسال العلني ───

const ORDER_PATH = '/catalog/:tenantId/:repId/orders';
const submit = (body: Row, extra: Row = {}) => call(publicRouter, 'post', ORDER_PATH, { params: { tenantId: T, repId: R }, body, ...extra });

test('العلن: حدّ IP أوّل المسار ثم حدّ المندوب ثم المعالج — والمنيو GET أوّل مسارات الموجّه كما كان', () => {
  const layer = routeLayer(publicRouter, 'post', ORDER_PATH);
  assert.equal(layer.route.stack.length, 3);
  assert.equal(layer.route.stack[0].handle, catalogOrderLimiter);
  assert.equal(layer.route.stack[1].handle, catalogOrderRepLimiter);
  const first = (publicRouter as unknown as { stack: Row[] }).stack.find((l) => l.route);
  assert.equal(first!.route.path, '/catalog/:tenantId/:repId');
  assert.ok(first!.route.methods.get);
  const rl = read('middleware', 'rateLimits.ts');
  assert.match(rl, /export const catalogOrderLimiter = rateLimit\(\{\n {2}\.\.\.base,\n {2}windowMs: 10 \* 60 \* 1000,\n {2}limit: 5,/, '٥ كل ١٠ دقائق لكل IP بترويسات قياسية');
  // IPv6 بشبكته لا بعنوانه — وإلا بدّل المهاجم عنوانه داخل شبكته مع كل طلب
  assert.match(rl, /export const catalogOrderLimiter = rateLimit\(\{[^}]*keyGenerator: \(req\) => `catalog-order:\$\{ipRateKey\(req\.ip\)\}`/);
  // ولكل مندوب: ٣٠ في الساعة بمعرّف الرابط، بترويسات قياسية (base) والرمز الذي تعرض به الصفحة «طلبات كثيرة»
  assert.match(rl, /export const catalogOrderRepLimiter = rateLimit\(\{\n {2}\.\.\.base,\n {2}windowMs: 60 \* 60 \* 1000,\n {2}limit: CATALOG_ORDERS_PER_REP_PER_HOUR,\n {2}keyGenerator: \(req\) => `catalog-order-rep:\$\{String\(req\.params\?\.repId \?\? ''\)\}`,\n {2}message: \{ success: false, code: 'CATALOG_ORDER_LIMIT'/);
  assert.equal(CATALOG_ORDERS_PER_REP_PER_HOUR, 30);
});

test('العلن: طلبٌ صالح ⇒ 201 بالمعرّف واسم المندوب، والأسطر مسعّرة من القاعدة لا من العميل، والإشعار بعد الحفظ', async () => {
  reset();
  const r = await submit(validBody({
    items: [{ productId: P1, unitId: U1, qty: 2, unitPrice: 0.01, productName: 'مجاني' }, { productId: P1, unitId: U2, qty: 1 }, { productId: P2, unitId: null, qty: 3 }],
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, data: { id: 'O-NEW', repName: 'خالد' } });
  const created = calls('catalogOrder.create')[0].args.data;
  assert.deepEqual(created, {
    tenantId: T, salesRepId: R, clientRef: CREF, customerName: 'أبو محمد', customerPhone: '0501234567', phoneKey: '966501234567', note: 'بعد العصر',
    items: { create: [
      { productId: P1, productName: 'ماء', unitName: 'كرتون', unitFactor: 24, qty: 2, unitPrice: 20, taxPct: 15 },
      { productId: P1, productName: 'ماء', unitName: 'شدة', unitFactor: 6, qty: 1, unitPrice: 6, taxPct: 15 },
      { productId: P2, productName: 'عصير', unitName: null, unitFactor: 1, qty: 3, unitPrice: 2.5, taxPct: 15 },
    ] },
  });
  const pq = calls('product.findMany')[0].args;
  assert.deepEqual(pq.where, { tenantId: T, id: { in: [P1, P2] }, status: 'ACTIVE', deletedAt: null }, 'شروط المنيو نفسها');
  assert.deepEqual(pq.select.units.where, { isActive: true });
  assert.deepEqual(calls('catalogOrder.count')[0].args.where, { tenantId: T, salesRepId: R, status: { in: ['NEW', 'SEEN'] } });
  assert.deepEqual(calls('salesRep.findFirst')[0].args.where, { id: R, tenantId: T, isActive: true });
  await tick();
  assert.deepEqual(st.pushes, [[R, { title: 'طلب جديد من المنيو', body: 'أبو محمد — 3 صنف', tag: 'catalog-order', url: '/rep?screen=orders' }]]);
});

test('العلن: الشركة «بلا ضريبة» ⇒ نسبة كل سطرٍ صفر', async () => {
  reset({ company: { taxDisabled: true } });
  const r = await submit(validBody());
  assert.equal(r.status, 201);
  assert.deepEqual(calls('catalogOrder.create')[0].args.data.items.create.map((l: Row) => l.taxPct), [0, 0]);
  assert.deepEqual(calls('companySettings.findUnique')[0].args.select, { taxDisabled: true });
});

test('العلن: المصيدة ⇒ 201 بمعرّفٍ وهميّ ولا شيء يُحفظ ولا إشعار', async () => {
  reset();
  const r = await submit(validBody({ website: 'http://spam.example' }));
  assert.equal(r.status, 201);
  assert.match(r.body.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.data.repName, 'خالد');
  assert.equal(calls('catalogOrder.create').length, 0);
  assert.equal(calls('product.findMany').length, 0);
  await tick();
  assert.equal(st.pushes.length, 0);
});

test('العلن: المرجع نفسه ⇒ 200 بالطلب نفسه بلا إنشاء؛ ومرجع طلب مندوبٍ آخر ⇒ 400 بلا كشف معرّفه', async () => {
  reset({ orders: [{ id: ORDER, tenantId: T, salesRepId: R, clientRef: CREF }] });
  const same = await submit(validBody());
  assert.equal(same.status, 200);
  assert.deepEqual(same.body, { success: true, data: { id: ORDER, repName: 'خالد' } });
  assert.equal(calls('catalogOrder.create').length, 0);
  reset({ orders: [{ id: ORDER, tenantId: T, salesRepId: R2, clientRef: CREF }] });
  const other = await submit(validBody());
  assert.equal(other.status, 400);
  assert.deepEqual(other.body, { success: false, code: CATALOG_ORDER_CODES.BAD_INPUT, field: 'clientRef' });
  assert.ok(!JSON.stringify(other.body).includes(ORDER));
});

test('العلن: سباق إرسالين بالمرجع نفسه (P2002) ⇒ الثاني يُجاب بالطلب الأول', async () => {
  reset({ createError: Object.assign(new Error('unique'), { code: 'P2002' }), raceRow: { id: ORDER, tenantId: T, salesRepId: R, clientRef: CREF } });
  const r = await submit(validBody());
  assert.equal(r.status, 200);
  assert.equal(r.body.data.id, ORDER);
  await tick();
  assert.equal(st.pushes.length, 0, 'الإشعار لصاحب الإنشاء وحده');
  // خطأٌ آخر يمرّ إلى معالج الأخطاء
  reset({ createError: Object.assign(new Error('boom'), { code: 'P2003' }) });
  await assert.rejects(submit(validBody()), /boom/);
});

test('العلن: صنفٌ أو وحدةٌ غير صالحة ⇒ 400 CATALOG_ORDER_INVALID بلا إنشاء', async () => {
  for (const items of [
    [{ productId: PX, unitId: null, qty: 1 }],
    [{ productId: P3, unitId: null, qty: 1 }],
    [{ productId: P1, unitId: U3, qty: 1 }],
    [{ productId: P2, unitId: U1, qty: 1 }],
    [{ productId: P2, unitId: null, qty: 1 }, { productId: 'gone', unitId: null, qty: 1 }],
  ]) {
    reset();
    const r = await submit(validBody({ items }));
    assert.equal(r.status, 400, JSON.stringify(items));
    assert.deepEqual(r.body, { success: false, code: CATALOG_ORDER_CODES.INVALID });
    assert.equal(calls('catalogOrder.create').length, 0);
  }
});

test('العلن: جسمٌ معيب ⇒ 400 BAD_INPUT بحقله قبل أي استعلام طلبات', async () => {
  reset();
  const r = await submit(validBody({ phone: 'abcde' }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { success: false, code: CATALOG_ORDER_CODES.BAD_INPUT, field: 'phone' });
  assert.equal(st.calls.filter((c) => c.op.startsWith('catalogOrder.')).length, 0);
  reset();
  const merged = await submit(validBody({ items: [{ productId: P1, unitId: null, qty: 60000 }, { productId: P1, unitId: null, qty: 60000 }] }));
  assert.deepEqual(merged.body, { success: false, code: CATALOG_ORDER_CODES.BAD_INPUT, field: 'items' });
});

test('العلن: بوّابات المنيو نفسها ⇒ 404 بلا أي كتابة', async () => {
  const cases: [Partial<State>, Row?][] = [
    [{ tenant: { isActive: true, catalogEnabled: false } }],
    [{ tenant: { isActive: false, catalogEnabled: true } }],
    [{ tenant: null }],
    [{ company: null }],
    [{ rep: null }],
    [{}, { params: { tenantId: T, repId: 'not-a-uuid' } }],
    [{}, { params: { tenantId: T, repId: R2 } }],
  ];
  for (const [over, extra] of cases) {
    reset(over);
    const r = await submit(validBody(), extra ?? {});
    assert.equal(r.status, 404, JSON.stringify(over) + JSON.stringify(extra));
    assert.deepEqual(r.body, { success: false });
    assert.equal(calls('catalogOrder.create').length, 0);
  }
});

test('العلن: مئة طلبٍ مفتوح للمندوب ⇒ 429 CATALOG_ORDER_LIMIT، و٩٩ ⇒ يُقبل', async () => {
  reset({ openCount: 100 });
  const r = await submit(validBody());
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { success: false, code: CATALOG_ORDER_CODES.LIMIT });
  assert.equal(calls('catalogOrder.create').length, 0);
  reset({ openCount: 99 });
  assert.equal((await submit(validBody())).status, 201);
});

test('العلن: جسمٌ فوق ٢٠ ك.ب ⇒ 413 قبل أي استعلام', async () => {
  reset();
  const big = await submit(validBody(), { rawBody: Buffer.alloc(MAX_ORDER_BODY_BYTES + 1) });
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { success: false, code: CATALOG_ORDER_CODES.TOO_LARGE });
  assert.equal(st.calls.length, 0);
  const hdr = await submit(validBody(), { headers: { 'content-length': '30000' } });
  assert.equal(hdr.status, 413);
  reset();
  assert.equal((await submit(validBody(), { rawBody: Buffer.alloc(MAX_ORDER_BODY_BYTES) })).status, 201);
});

test('العلن: تعذّر الإشعار لا يردّ العميل ولا يرمي خارج الطلب', async () => {
  reset({ pushError: true });
  const origErr = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const r = await submit(validBody());
    assert.equal(r.status, 201);
    await tick();
    await tick();
  } finally { console.error = origErr; }
  assert.equal(st.pushes.length, 1);
  assert.equal(logged.length, 1);
});

test('المنيو GET: معرّف كل صنفٍ وكل وحدة و orderEnabled في الجذر — والباقي كما كان', async () => {
  reset();
  const r = await call(publicRouter, 'get', '/catalog/:tenantId/:repId', { params: { tenantId: T, repId: R } });
  assert.equal(r.status, 200);
  const data = r.body.data;
  assert.equal(data.orderEnabled, true);
  assert.deepEqual(Object.keys(data), ['company', 'rep', 'products', 'orderEnabled']);
  assert.deepEqual(data.products[0], {
    id: P1, name: 'ماء', unit: 'حبة', basePrice: 1, taxPct: 15, image: null, category: 'مشروبات',
    units: [{ id: U1, name: 'كرتون', factor: 24, price: 20, isPrimary: true }, { id: U2, name: 'شدة', factor: 6, price: 6 }],
  });
  assert.deepEqual(data.products[1], { id: P2, name: 'عصير', unit: 'علبة', basePrice: 2.5, taxPct: 15, image: null, category: null, units: [] });
});

test('المنيو GET والطلب POST بقائمة المندوب الافتراضية: السعر نفسه في العرض واللقطة، بشركة الرابط وقائمته', async () => {
  const L = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
  reset({
    rep: { id: R, name: 'خالد', phone: '0500000000', defaultPriceListId: L },
    listItems: [
      { tenantId: T, priceListId: L, productId: P1, price: 0.75 },
      { tenantId: T, priceListId: 'other-list', productId: P2, price: 0.01 },
      { tenantId: 'other', priceListId: L, productId: P2, price: 0.02 },
    ],
    listRules: [{ id: 'r-all', priceListId: L, scope: 'all', productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 10, minQty: 0, startsOn: null, endsOn: null, updatedAt: null }],
  });
  const g = await call(publicRouter, 'get', '/catalog/:tenantId/:repId', { params: { tenantId: T, repId: R } });
  assert.equal(g.status, 200);
  const [water, juice] = g.body.data.products;
  assert.equal(water.basePrice, 0.75);
  assert.deepEqual(water.units.map((u: Row) => [u.id, u.price]), [[U1, 18], [U2, 4.5]]);
  assert.equal(juice.basePrice, 2.25, 'بلا ثابتٍ في القائمة ⇒ نسبتها من سعر اليوم');
  assert.deepEqual(Object.keys(g.body.data), ['company', 'rep', 'products', 'orderEnabled'], 'الشكل كما كان');
  const iq = calls('priceListItem.findMany')[0].args;
  assert.deepEqual(iq.where, { tenantId: T, priceListId: L, productId: { in: [P1, P2] } }, 'أسعار القائمة بشركة الرابط ولأصناف المنيو');
  const rq = calls('$queryRaw').find((c) => c.args.sql.includes('FROM price_list_rules'));
  // Prisma.join(ids) قطعة SQL بقيمها — تُسطَّح
  const vals = (rq?.args.values ?? []).flatMap((v: unknown) => (v && typeof v === 'object' && Array.isArray((v as Row).values) ? (v as Row).values : [v]));
  assert.ok(rq && vals.includes(T) && vals.includes(L) && !vals.includes('other'), 'القواعد بشركة الرابط وقائمته');

  const r = await submit(validBody({ items: [{ productId: P1, unitId: U1, qty: 2 }, { productId: P1, unitId: U2, qty: 1 }, { productId: P2, qty: 3 }] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = calls('catalogOrder.create')[0].args.data.items.create as Row[];
  assert.deepEqual(lines.map((l) => l.unitPrice), [water.units[0].price, water.units[1].price, juice.basePrice], 'اللقطة = ما عرضه المنيو');
  assert.deepEqual(calls('salesRep.findFirst').map((c) => c.args.select.defaultPriceListId), [true, true]);
});

test('المنيو بلا قائمة للمندوب: لا استعلام قائمةٍ أبداً — والأسعار كما كانت', async () => {
  reset();
  await call(publicRouter, 'get', '/catalog/:tenantId/:repId', { params: { tenantId: T, repId: R } });
  await submit(validBody());
  assert.equal(calls('priceListItem.findMany').length, 0);
  assert.equal(calls('$queryRaw').length, 0);
});

// ─── طلبات المندوب ───

const REP_USER = { id: R, role: 'SALES_REP', tenantId: T, name: 'خالد' };
const asRep = (req: Row = {}): Row => ({ user: REP_USER, ...req });

test('المندوب: authenticate ثم حارس الدور قبل كل مسار — وغير المندوب ٤٠٣', () => {
  const src = read('routes', 'catalogOrders.ts');
  const auth = src.indexOf('router.use(authenticate);');
  assert.ok(auth > 0 && auth < src.indexOf('router.get('), 'authenticate قبل المسارات');
  const guards = (repRouter as unknown as { stack: Row[] }).stack.filter((l) => !l.route);
  assert.equal(guards.length, 2);
  const run = (role: string) => {
    let nexted = false;
    const res: Row = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = () => res;
    guards[1].handle({ user: { ...REP_USER, role } }, res, () => { nexted = true; });
    return { nexted, status: res.statusCode };
  };
  assert.deepEqual(run('SALES_REP'), { nexted: true, status: 200 });
  for (const role of ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'SUPER_ADMIN']) assert.deepEqual(run(role), { nexted: false, status: 403 }, role);
  assert.match(read('index.ts'), /app\.use\('\/api\/catalog-orders', catalogOrdersRouter\);/);
});

const orderRow = (over: Row = {}): Row => ({
  id: ORDER, status: 'NEW', customerName: 'أبو محمد', customerPhone: '0501234567', phoneKey: '966501234567', note: null,
  invoiceId: null, decidedAt: null, createdAt: new Date('2026-11-24T08:00:00Z'),
  items: [{ id: 'I1', productId: P1, productName: 'ماء', unitName: 'كرتون', unitFactor: 24, qty: 2, unitPrice: 20, taxPct: 15 }],
  ...over,
});

test('المندوب GET /mine: المفتوح افتراضياً، الأحدث أولاً وحتى ١٠٠، بشركته وبه نفسه — و«all» بلا قيد الحالة', async () => {
  reset({ list: [orderRow()] });
  const r = await call(repRouter, 'get', '/mine', asRep());
  assert.equal(r.status, 200);
  const q = calls('catalogOrder.findMany')[0].args;
  assert.deepEqual(q.where, { tenantId: T, salesRepId: R, status: { in: ['NEW', 'SEEN'] } });
  assert.deepEqual(q.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(q.take, 100);
  assert.equal(r.body.data.length, 1);
  assert.ok(!('phoneKey' in r.body.data[0]));
  assert.deepEqual(r.body.data[0].items, orderRow().items);
  reset({ list: [] });
  await call(repRouter, 'get', '/mine', asRep({ query: { status: 'all' } }));
  assert.deepEqual(calls('catalogOrder.findMany')[0].args.where, { tenantId: T, salesRepId: R });
});

test('المندوب GET /mine: matchedCustomer أحدث عميلٍ مطابق يصل إليه — والعزل يُسقط غير المُسنَد باستعلامٍ واحد', async () => {
  const candidates = [
    { id: 'C-new', name: 'بقالة جديدة', phone: '0501234567', createdAt: new Date('2026-06-01') },
    { id: 'C-old', name: 'بقالة قديمة', phone: '+966 50 123 4567', createdAt: new Date('2026-01-01') },
  ];
  const list = [orderRow(), orderRow({ id: 'O-junk', phoneKey: '00000' }), orderRow({ id: 'O-none', phoneKey: null })];
  reset({ list, candidates, isolation: false });
  let r = await call(repRouter, 'get', '/mine', asRep());
  assert.deepEqual(r.body.data.map((o: Row) => o.matchedCustomer), [{ id: 'C-new', name: 'بقالة جديدة' }, null, null]);
  const raw = calls('$queryRaw')[0].args;
  assert.match(raw.sql, /FROM customers WHERE "tenantId" = \? AND status <> 'DELETED'/);
  assert.equal(raw.values[0], T, 'المرشّحون من الشركة نفسها');
  assert.equal(calls('customer.findMany').length, 0, 'بلا عزلٍ لا استعلام وصول');

  reset({ list, candidates, isolation: true, visible: ['C-old'] });
  r = await call(repRouter, 'get', '/mine', asRep());
  assert.deepEqual(r.body.data[0].matchedCustomer, { id: 'C-old', name: 'بقالة قديمة' });
  const acc = calls('customer.findMany');
  assert.equal(acc.length, 1);
  assert.deepEqual(acc[0].args.where, { id: { in: ['C-new', 'C-old'] }, tenantId: T, assignments: { some: { salesRepId: R } } });

  // بلا مفتاحٍ صالح لا مسح للعملاء أصلاً
  reset({ list: [orderRow({ phoneKey: '12345' })], candidates });
  r = await call(repRouter, 'get', '/mine', asRep());
  assert.equal(r.body.data[0].matchedCustomer, null);
  assert.equal(calls('$queryRaw').length, 0);
});

test('المندوب: المنيو مطفأ للشركة ⇒ القائمة فارغة والعدّاد صفر والكتابة ٤٠٤ — بلا استعلام طلبات', async () => {
  reset({ tenant: { isActive: true, catalogEnabled: false }, list: [orderRow()], groups: [{ status: 'NEW', _count: { _all: 4 } }] });
  assert.deepEqual((await call(repRouter, 'get', '/mine', asRep())).body, { success: true, data: [] });
  assert.deepEqual((await call(repRouter, 'get', '/mine/count', asRep())).body, { success: true, data: { open: 0, fresh: 0 } });
  assert.equal((await call(repRouter, 'post', '/:id/seen', asRep({ params: { id: ORDER } }))).status, 404);
  assert.equal((await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'DONE' } }))).status, 404);
  assert.equal(st.calls.filter((c) => c.op.startsWith('catalogOrder.')).length, 0);
});

test('المندوب GET /mine/count: { open, fresh } لطلباته المفتوحة', async () => {
  reset({ groups: [{ status: 'NEW', _count: { _all: 2 } }, { status: 'SEEN', _count: { _all: 1 } }] });
  const r = await call(repRouter, 'get', '/mine/count', asRep());
  assert.deepEqual(r.body, { success: true, data: { open: 3, fresh: 2 } });
  const g = calls('catalogOrder.groupBy')[0].args;
  assert.deepEqual(g.where, { tenantId: T, salesRepId: R, status: { in: ['NEW', 'SEEN'] } });
  assert.deepEqual(g.by, ['status']);
});

test('المندوب POST /:id/seen: NEW ⇒ SEEN بشرطٍ في التحديث نفسه، ومتكرّرٌ بلا أثر، وغير الموجود ٤٠٤', async () => {
  reset({ updateCount: 1 });
  let r = await call(repRouter, 'post', '/:id/seen', asRep({ params: { id: ORDER } }));
  assert.deepEqual(r.body, { success: true, data: { id: ORDER, status: 'SEEN' } });
  assert.deepEqual(calls('catalogOrder.updateMany')[0].args, { where: { id: ORDER, tenantId: T, salesRepId: R, status: 'NEW' }, data: { status: 'SEEN' } });
  reset({ updateCount: 0, found: { id: ORDER, status: 'DONE' } });
  r = await call(repRouter, 'post', '/:id/seen', asRep({ params: { id: ORDER } }));
  assert.deepEqual(r.body, { success: true, data: { id: ORDER, status: 'DONE' } });
  reset({ updateCount: 0, found: null });
  assert.equal((await call(repRouter, 'post', '/:id/seen', asRep({ params: { id: ORDER } }))).status, 404);
  reset();
  assert.equal((await call(repRouter, 'post', '/:id/seen', asRep({ params: { id: 'x' } }))).status, 404);
  assert.equal(calls('catalogOrder.updateMany').length, 0);
});

test('المندوب POST /:id/status: من مفتوحٍ وحده (وإلا ٤٠٩ بحالته)، والفاتورة له في شركته، وdecidedAt', async () => {
  reset({ invoice: { id: 'INV-1' } });
  let r = await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'DONE', invoiceId: 'INV-1' } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'DONE');
  assert.equal(r.body.data.invoiceId, 'INV-1');
  assert.ok(r.body.data.decidedAt instanceof Date);
  assert.deepEqual(calls('invoice.findFirst')[0].args.where, { id: 'INV-1', tenantId: T, salesRepId: R });
  const u = calls('catalogOrder.updateMany')[0].args;
  assert.deepEqual(u.where, { id: ORDER, tenantId: T, salesRepId: R, status: { in: ['NEW', 'SEEN'] } });
  assert.equal(u.data.status, 'DONE');
  assert.equal(u.data.invoiceId, 'INV-1');
  assert.ok(u.data.decidedAt instanceof Date);

  reset({ invoice: null });
  r = await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'DONE', invoiceId: 'INV-OTHER' } }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { success: false, code: CATALOG_ORDER_CODES.INVOICE_INVALID });
  assert.equal(calls('catalogOrder.updateMany').length, 0);

  reset();
  r = await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'CANCELLED', invoiceId: 'INV-1' } }));
  assert.deepEqual(r.body, { success: false, code: CATALOG_ORDER_CODES.BAD_INPUT, field: 'invoiceId' });

  reset({ updateCount: 0, found: { status: 'CANCELLED' } });
  r = await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'DONE' } }));
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { success: false, code: CATALOG_ORDER_CODES.CLOSED, status: 'CANCELLED' });

  reset({ updateCount: 0, found: null });
  assert.equal((await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'CANCELLED' } }))).status, 404);
});

test('المندوب: كل استعلامٍ على الطلبات مقيَّدٌ بالشركة والمندوب نفسه (لا findUnique بالمعرّف وحده)', async () => {
  reset({ list: [orderRow()], groups: [], updateCount: 0, found: { id: ORDER, status: 'SEEN' }, invoice: { id: 'INV-1' } });
  await call(repRouter, 'get', '/mine', asRep());
  await call(repRouter, 'get', '/mine', asRep({ query: { status: 'all' } }));
  await call(repRouter, 'get', '/mine/count', asRep());
  await call(repRouter, 'post', '/:id/seen', asRep({ params: { id: ORDER } }));
  await call(repRouter, 'post', '/:id/status', asRep({ params: { id: ORDER }, body: { status: 'DONE', invoiceId: 'INV-1' } }));
  const orderCalls = st.calls.filter((c) => c.op.startsWith('catalogOrder.'));
  assert.ok(orderCalls.length >= 7);
  for (const c of orderCalls) {
    assert.equal(c.args.where.tenantId, T, c.op);
    assert.equal(c.args.where.salesRepId, R, c.op);
  }
  assert.doesNotMatch(read('routes', 'catalogOrders.ts'), /catalogOrder\.(findUnique|update|delete)\(/);
});

test('مصدر الإرسال العلني: المصيدة قبل الفحص والاستعلام، والإشعار بعد الردّ بلا انتظار، ولا سعر من الجسم', () => {
  const src = read('routes', 'publicCatalog.ts');
  const h = src.slice(src.indexOf("router.post('/catalog/:tenantId/:repId/orders'"));
  const at = (s: string) => { const i = h.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('orderBodyTooLarge(') < at('prisma.tenant.findUnique'));
  assert.ok(at('isHoneypotHit(req.body)') < at('parseOrderBody(req.body)'));
  assert.ok(at('parseOrderBody(req.body)') < at('prisma.catalogOrder.findUnique'));
  assert.ok(at("res.status(201).json({ success: true, data: { id: order.id") < at('sendPushToRep('));
  assert.doesNotMatch(h, /await sendPushToRep/);
  assert.match(h, /sendPushToRep\([^;]*\)\.catch\(/);
  assert.doesNotMatch(h, /req\.body\.(items|unitPrice|price|taxPct)/);
  assert.match(h, /items: \{ create: priced\.lines \}/);
});
