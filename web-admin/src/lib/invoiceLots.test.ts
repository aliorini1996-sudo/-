// «تتبّع اللوط» — W4 (lib/invoiceLots.ts): الورقة من ردّ الخادم، والمرتجع، ورسالة النقص، وتقرير «حسب التشغيلة»،
// وحرّاسٌ نصّية على الشاشات الثلاث (الميزة المطفأة بلا جلبٍ ولا تغيير مرئي — §١٠.١)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  docLotsText, freeReturnLotRows, groupLotSales, lotErrorText, returnableLotsOf, saleLineLots, uncertainSold, withDocLots,
  withFreeReturnLots, type LotSalesProductDto, type LotSalesRowDto,
} from './invoiceLots';
import { lotErrorOf } from './lots';

const tr = (s: string) => s;
const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');

// كما يضمّه الخادم (ITEM_LOTS_INCLUDE): expiryDate الصفّ لقطة الإصدار، وهي للمسمّى انتهاء لوطه يومها
const lotRow = (lotId: string | null, quantity: number, lotNumber?: string, expiryDate?: string) => ({
  id: `r-${lotId ?? 'u'}-${quantity}`, lotId, quantity, certainty: lotId ? 'CONFIRMED' : 'UNKNOWN', expiryDate: lotId ? expiryDate ?? null : null,
  lot: lotId ? { lotNumber: lotNumber ?? lotId, expiryDate: expiryDate ?? null } : null,
});

test('withDocLots: تشغيلات كل بند من ردّه بالترتيب، والعدد المختلف لا يُنسب شيئاً', () => {
  const doc = [{ name: 'أ' }, { name: 'ب' }] as { name: string; lots?: { lotNumber: string | null; qty: number }[] }[];
  const raw = [{ lots: [lotRow('L1', 5, 'A12', '2026-12-01T00:00:00.000Z'), lotRow(null, 2)] }, { lots: [] }];
  const out = withDocLots(doc, raw);
  assert.deepEqual(out[0].lots, [{ lotNumber: 'A12', qty: 5, expiryDate: '2026-12-01' }, { lotNumber: null, qty: 2, expiryDate: null }]);
  assert.equal(out[1].lots, undefined, 'بندٌ بلا صفوف لا يطبع شيئاً');
  assert.equal(withDocLots(doc, [raw[0]]), doc, 'عددٌ مختلف: البنود كما هي');
  assert.equal(withDocLots(doc, undefined), doc);
  const pre = [{ name: 'أ', lots: [{ lotNumber: 'X', qty: 1 }] }, { name: 'ب' }];
  assert.deepEqual(withDocLots(pre, raw)[0].lots, [{ lotNumber: 'X', qty: 1 }], 'البند الذي يحمل lots لا يُمسّ');
});

test('saleLineLots: المطابقة بالصنف والمعامل لا بالترتيب، وكل بندٍ مرّة', () => {
  const lines = [{ productId: 'p1', unitFactor: 24 }, { productId: 'p1', unitFactor: 1 }, { productId: 'p2', unitFactor: 1 }];
  const raw = [
    { productId: 'p1', unitFactor: 1, lots: [lotRow('L2', 5, 'B')] },
    { productId: 'p2', unitFactor: 1, lots: [] },
    { productId: 'p1', unitFactor: 24, lots: [lotRow('L1', 48, 'A')] },
  ];
  const out = saleLineLots(lines, raw);
  assert.equal(out[0]?.[0].lotNumber, 'A');
  assert.equal(out[0]?.[0].qty, 48, 'كمية التشغيلة بالأساس');
  assert.equal(out[1]?.[0].lotNumber, 'B');
  assert.equal(out[2], undefined, 'صنفٌ غير متتبَّع بلا صفوف');
  assert.deepEqual(saleLineLots(lines, null), [undefined, undefined, undefined]);
  // المعامل التالف (٠ أو غائب) ١
  assert.equal(saleLineLots([{ productId: 'p1', unitFactor: 0 }], [{ productId: 'p1', unitFactor: null, lots: [lotRow('L', 1)] }])[0]?.length, 1);
});

test('returnableLotsOf: صفوف كل بند بيعٍ من شاشة القابل للإرجاع، والبند بلا صفوف غائب', () => {
  const m = returnableLotsOf({
    lines: [
      { saleItemId: 's1', lots: [{ lotId: 'L1', lotNumber: 'A', expiryDate: '2026-11-03', sold: 10, returned: 4, returnable: 6, certainty: 'ASSUMED' },
        { lotId: null, lotNumber: null, expiryDate: null, sold: 2, returned: 3, returnable: -1, certainty: 'WAT' }] },
      { saleItemId: 's2', lots: [] },
      { saleItemId: 's3' },
    ],
  });
  assert.deepEqual([...m.keys()], ['s1']);
  assert.deepEqual(m.get('s1')![0], { lotId: 'L1', lotNumber: 'A', expiryDate: '2026-11-03', sold: 10, returned: 4, returnable: 6, certainty: 'ASSUMED' });
  assert.equal(m.get('s1')![1].returnable, 0, 'المتاح لا يقلّ عن صفر');
  assert.equal(m.get('s1')![1].certainty, 'UNKNOWN', 'يقينٌ مجهول أضعفها');
  assert.equal(returnableLotsOf(null).size, 0);
});

test('المرتجع الحرّ: تشغيلةٌ للسطر كله بالكمية الأساسية، والفارغ «غير معروف» لا يُرسل شيئاً', () => {
  assert.deepEqual(freeReturnLotRows({ qty: 2, unitFactor: 12 }, 'L1'), [{ lotId: 'L1', qty: 24 }]);
  assert.equal(freeReturnLotRows({ qty: 2, unitFactor: 12 }, ''), undefined);
  assert.equal(freeReturnLotRows({ qty: 2, unitFactor: 12 }, null), undefined);
  assert.equal(freeReturnLotRows({ qty: 0, unitFactor: 1 }, 'L1'), undefined);

  const lines = [{ productId: 'p1', qty: 1.5, unitFactor: 1 }, { productId: 'p2', qty: 3, unitFactor: 6 }];
  const payload = { type: 'RETURN', items: [{ productId: 'p1', qty: 1.5 }, { productId: 'p2', qty: 3, unitId: 'u6' }] };
  const out = withFreeReturnLots(payload, lines, (l) => (l.productId === 'p2' ? 'L9' : undefined));
  assert.deepEqual(out.items, [{ productId: 'p1', qty: 1.5 }, { productId: 'p2', qty: 3, unitId: 'u6', lots: [{ lotId: 'L9', qty: 18 }] }]);
  assert.equal(withFreeReturnLots(payload, lines, () => undefined), payload, 'بلا اختيار: الجسم كما هو حرفياً');
  // صنفٌ لا يطابق بنده (ترتيبٌ مختلف) لا يأخذ تشغيلة غيره
  const swapped = { items: [{ productId: 'p2' }, { productId: 'p1' }] };
  assert.equal(withFreeReturnLots(swapped, lines, () => 'L9'), swapped);
});

test('lotErrorText: النقص بالاسم والمطلوب والمتاح، ورفض الإلغاء وإطفاء العودة بالتشغيلة، والانشغال', () => {
  const err = (code: string, detail: Record<string, unknown>, message = 'رسالة الخادم') =>
    lotErrorOf({ response: { status: 409, data: { success: false, code, message, detail } } })!;
  const ctx = { nameOf: (id: string) => (id === 'p1' ? 'حليب' : null), qtyText: (_: string | null, n: number) => `${n} حبة` };
  assert.equal(lotErrorText(err('LOT_STOCK_INSUFFICIENT', { productId: 'p1', wanted: 30, available: 12 }), tr, ctx),
    'الكمية أكبر من المتاح في تشغيلات سيارة المندوب «حليب» · الكمية 30 حبة · المتاح في السيارة 12 حبة');
  assert.equal(lotErrorText(err('LOT_STOCK_INSUFFICIENT', { mode: 'CANCEL', lotId: 'L1', lotNumber: 'A12' }), tr),
    'لا يلغى المرتجع لأن بضاعته بيعت من: التشغيلة A12');
  assert.equal(lotErrorText(err('LOT_STOCK_INSUFFICIENT', { mode: 'RESTOCK_OFF', lotId: null }), tr),
    'لا تطفأ عودة المرتجع للمخزون لأن بضاعته بيعت من: غير مسمى');
  assert.equal(lotErrorText(err('LOT_BUSY', {}), tr), 'التشغيلة مشغولة بعملية أخرى أعد المحاولة بعد لحظات');
  assert.equal(lotErrorText(err('LOT_NOT_FOUND', {}, 'التشغيلة غير موجودة'), tr), 'التشغيلة غير موجودة', 'غيرها رسالة الخادم');
  // المتاح السالب (عجزٌ تاريخي) يُعرض صفراً
  assert.match(lotErrorText(err('LOT_STOCK_INSUFFICIENT', { productId: 'p1', wanted: 3, available: -2 }), tr), /المتاح في السيارة 0$/);
});

const row = (productId: string, lotId: string | null, sold: number, extra: Partial<LotSalesRowDto> = {}): LotSalesRowDto => ({
  productId, productName: productId, productCode: null, unit: 'حبة', units: [], lotId, lotNumber: lotId, productionDate: null,
  expiryDate: null, status: lotId ? 'ACTIVE' : null, blockKind: null, sold, returned: 0, net: sold, customers: 1, invoices: 1,
  returnInvoices: 0, soldByCertainty: { CONFIRMED: sold, ASSUMED: 0, UNKNOWN: 0 }, ...extra,
});

test('groupLotSales: الصنف بتشغيلاته بترتيب الخادم ومجموعه من products', () => {
  const rows = [row('p1', 'A', 5), row('p1', null, 2), row('p2', 'C', 1)];
  const products = [{ ...row('p1', null, 7), lots: 1 }, { ...row('p2', null, 1), lots: 1 }] as unknown as LotSalesProductDto[];
  const g = groupLotSales(rows, products);
  assert.deepEqual(g.map((x) => [x.productId, x.rows.map((r) => r.lotId), x.product?.sold]), [['p1', ['A', null], 7], ['p2', ['C'], 1]]);
  assert.equal(groupLotSales(rows, [])[0].product, null);
});

test('uncertainSold وdocLotsText', () => {
  assert.deepEqual(uncertainSold({ soldByCertainty: { CONFIRMED: 1, ASSUMED: 2.5, UNKNOWN: 0.0000001 } }), { assumed: 2.5, unknown: 0 });
  assert.equal(docLotsText([{ lotNumber: 'A12', qty: 5, expiryDate: '2026-12-01' }, { lotNumber: null, qty: 2 }], 'غير معروف', String),
    'A12 ×5 (2026-12-01)، غير معروف ×2');
  assert.equal(docLotsText(undefined, 'x', String), '');
});

// ─── حرّاسٌ نصّية: الميزة المطفأة بلا جلبٍ ولا تغيير مرئي (§١٠.١)، وwithLots حين تُفعَّل وحدها (D11) ───

test('نافذة الفاتورة: لوطات البيع وقائمة التشغيلات تُجلب مع الميزة وحدها، والورقة من ردّ الخادم', () => {
  const s = src('components', 'forms', 'InvoiceModal.tsx');
  assert.match(s, /const lotOn = lotFlagsOf\(company\)\.on;/);
  assert.match(s, /invoiceApi\.returnable\(saleId, \{ withLots: lotOn \}\)/);
  assert.match(s, /invoiceApi\.returnable\(sale\.id, \{ withLots: lotOn \}\)/);
  assert.match(s, /enabled: lotOn && !!productId/, 'قائمة تشغيلات الصنف خلف العلم');
  assert.match(s, /withDocLots\(returnDocItems\(inv\.items, sources\), inv\.items\)/, 'ورقة المرتجع من ردّ الخادم');
  assert.match(s, /saleLineLots\(lines, inv\.items\)/, 'ورقة البيع من ردّ الخادم');
  assert.match(s, /lotOn \? withFreeReturnLots\(/, 'تشغيلة المرتجع الحرّ خلف العلم');
});

test('صفحة الفواتير: withLots مع الميزة وحدها، ورفض الإلغاء وإطفاء العودة برسالة التشغيلة', () => {
  const s = src('pages', 'InvoicesPage.tsx');
  assert.match(s, /invoiceApi\.get\(id, \{ withLots: lotOn \}\)/);
  assert.match(s, /const lotOn = lotFlagsOf\(company\)\.on;/);
  assert.equal((s.match(/lotErrorOf\(err\)/g) ?? []).length, 2, 'الإلغاء وعودة المرتجع');
});

test('صفحة التقارير: «حسب التشغيلة» وwithLots للمرتجع خلف العلم، ولا جلب والميزة مطفأة', () => {
  const s = src('pages', 'ReportsPage.tsx');
  assert.match(s, /const lotOn = lotFlagsOf\(companyQ\.data\)\.on;/);
  assert.match(s, /\{lotOn && <option value="lots">/, 'الخيار لا يظهر والميزة مطفأة');
  assert.match(s, /enabled: accountingReady && accountingOn && lotOn && tab === 'sales' && salesType === 'lots'/);
  assert.match(s, /reportApi\.returns\(\{ from, to, \.\.\.tp, \.\.\.\(lotOn && \{ withLots: '1' \}\) \}\)/);
  assert.match(s, /queryKey: \['report-returns', from, to, teamFilter, lotOn\]/, 'الكاش لا يخلط ردّاً بلوطاتٍ بردٍّ بلا لوطات');
  // نوعٌ محفوظ «حسب التشغيلة» بعد إطفاء الميزة يسقط إلى التجميعة لا إلى صفحةٍ فارغة
  assert.match(s, /const salesType = salesTypeState === 'lots' && !lotOn \? 'summary' : salesTypeState;/);
});
