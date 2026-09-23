// البند 30 (مراجعة استيراد البيانات 2026-09-17): استيراد المنتجات لا يتخطى بصمت — المتخطى برقم الصف والسبب، والمكرر في الملف
// ببيانات مختلفة والكود المؤرشف أخطاء صفوف ظاهرة. منطق صرف + حارس ثابت، بلا قاعدة بيانات.
// والدفعة 3: البند 36 (رفض شكل الصف يدلّ على سطره وخانته) والبندان 43 و44 (تكرار أزواج الأسعار والأصناف المؤرشفة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  IMPORT_ROWS_OVER_LIMIT, IMPORT_ROW_MESSAGES, SCHEMA_FIELD_REQUIRED, SCHEMA_FIELD_TOO_BIG, SCHEMA_FIELD_TOO_SMALL, SCHEMA_FIELD_TYPE,
  importRowLimitError, parseImportRows, planPriceImportRows, planProductImportRows, resolveImportDates,
} from '../services/importLedger';
// إغلاق الدفعة 3 (البند 39): قاعدة «التاريخ المستقبلي» الواحدة كما يستعملها الاستيراد
import { isImportDateTooFarAhead, maxImportEntryDate } from '../services/gl/opening';
import { DEFAULT_TIMEZONE } from '../services/gl/dates';
import { buildCustomerMatcher } from '../services/importMatch';
// البند 31: ردّ السعر الشامل إلى صافيه بالدالّتين الماليتين اللتين يستعملهما المسار عينهما
import { netFromInclusive, roundHalfUp } from '../lib/money';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const row = (r: { code: string; name: string; unit?: string; basePrice?: number; taxPct?: number; barcode?: string; category?: string }) =>
  ({ unit: 'حبة', basePrice: 0, ...r });
/** ضريبة الشركة الافتراضية (companySettings.defaultVatPct ?? 15) كما يمرّرها المسار */
const VAT = 15;

test('سيناريو البند 30: «ماء» حبة و«ماء» كرتون بلا كود (code=name) ⇒ الأول يُنشأ والثاني خطأ PRODUCT_DUPLICATE_IN_FILE لا تخطٍّ صامت', () => {
  const plan = planProductImportRows([
    row({ code: 'ماء', name: 'ماء', unit: 'حبة', basePrice: 1 }),
    row({ code: 'ماء', name: 'ماء', unit: 'كرتون', basePrice: 20 }),
    row({ code: 'ماء', name: 'ماء', unit: 'حبة', basePrice: 1 }),
  ], [], VAT);
  assert.deepEqual(plan.creates.map((c) => c.row), [2]);
  assert.deepEqual(plan.errors, [{ row: 3, code: 'PRODUCT_DUPLICATE_IN_FILE', message: IMPORT_ROW_MESSAGES.PRODUCT_DUPLICATE_IN_FILE, value: 'ماء' }]);
  assert.deepEqual(plan.skippedRows, [{ row: 4, reason: 'DUPLICATE_IN_FILE', code: 'ماء' }]);
  assert.equal(IMPORT_ROW_MESSAGES.PRODUCT_DUPLICATE_IN_FILE, 'كود الصنف مكرر في الملف ببيانات مختلفة، أضف عمود الكود أو صحّح التكرار');
});

test('كود مؤرشف ⇒ PRODUCT_CODE_ARCHIVED؛ كود قائم (نشط أو موقوف) ⇒ skippedRows CODE_EXISTS برقم الصف؛ ونسبة الضريبة الكسرية تبقى خطأ', () => {
  const plan = planProductImportRows([
    row({ code: 'OLD', name: 'قديم' }),
    row({ code: 'P1', name: 'قائم' }),
    row({ code: 'NEW', name: 'جديد', taxPct: 0.15 }),
    row({ code: 'NEW2', name: 'جديد 2', taxPct: 15 }),
  ], [{ code: 'OLD', deletedAt: new Date('2026-01-01T00:00:00Z') }, { code: 'P1', deletedAt: null }], VAT);
  assert.deepEqual(plan.errors.map((e) => [e.row, e.code, e.value]), [[2, 'PRODUCT_CODE_ARCHIVED', 'OLD'], [4, 'TAX_PCT_FRACTION', undefined]]);
  assert.equal(IMPORT_ROW_MESSAGES.PRODUCT_CODE_ARCHIVED, 'الكود مستخدم بصنف مؤرشف، استخدم كوداً مختلفاً');
  assert.deepEqual(plan.skippedRows, [{ row: 3, reason: 'CODE_EXISTS', code: 'P1' }]);
  assert.deepEqual(plan.creates.map((c) => c.row), [5]);
});

test('البند 30: خانة ضريبة فارغة = ضريبة الشركة الافتراضية في التوقيع ⇒ تخطٍّ صامت للمكرر لا خطأ صف كاذب', () => {
  // الصفّان يُكتبان في القاعدة بالقيم نفسها (taxPct: r.taxPct ?? defaultVat) فلا فرق بينهما يراه المالك
  const rows = [row({ code: 'P1', name: 'ماء', basePrice: 1 }), row({ code: 'P1', name: 'ماء', basePrice: 1, taxPct: VAT })];
  const plan = planProductImportRows(rows, [], VAT);
  assert.deepEqual(plan.errors, [], 'خطأ صف كاذب: الصفّان متطابقان بعد كتابة الضريبة الافتراضية');
  assert.deepEqual(plan.skippedRows, [{ row: 3, reason: 'DUPLICATE_IN_FILE', code: 'P1' }]);
  assert.deepEqual(plan.creates.map((c) => c.row), [2]);
  // وبالترتيب المعكوس كذلك (أيّهما سبق)
  const rev = planProductImportRows([rows[1], rows[0]], [], VAT);
  assert.deepEqual(rev.errors, []);
  assert.deepEqual(rev.skippedRows, [{ row: 3, reason: 'DUPLICATE_IN_FILE', code: 'P1' }]);
  // اختلاف حقيقي في الضريبة يبقى خطأ صف: 5٪ ليست الافتراضية 15٪
  const diff = planProductImportRows([rows[0], row({ code: 'P1', name: 'ماء', basePrice: 1, taxPct: 5 })], [], VAT);
  assert.deepEqual(diff.errors.map((e) => [e.row, e.code, e.value]), [[3, 'PRODUCT_DUPLICATE_IN_FILE', 'P1']]);
  // ولو كانت ضريبة الشركة 5٪ فالصف المكتوب فيه 15 يختلف عن الفارغ
  const vat5 = planProductImportRows(rows, [], 5);
  assert.deepEqual(vat5.errors.map((e) => [e.row, e.code]), [[3, 'PRODUCT_DUPLICATE_IN_FILE']]);
  // بلا ضريبة افتراضية: الفارغ null كما كان
  const none = planProductImportRows([rows[0], row({ code: 'P1', name: 'ماء', basePrice: 1 })], [], null);
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.skippedRows, [{ row: 3, reason: 'DUPLICATE_IN_FILE', code: 'P1' }]);
});

test('حارس ثابت: /products يجلب deletedAt ويخطط بـplanProductImportRows ويعيد skippedRows', () => {
  const src = read('routes/import.ts');
  const i = src.indexOf("router.post('/products'");
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /select: \{ code: true, deletedAt: true \}/);
  // البند 30: التوقيع يُقارَن بالقيم كما تُكتب — الضريبة الافتراضية نفسها تصل إلى المخطِّط
  assert.match(body, /planProductImportRows\(rows, existing, defaultVat\)/);
  assert.match(body, /taxPct: r\.taxPct \?\? defaultVat/);
  assert.match(body, /skippedRows: plan\.skippedRows\.slice\(0, 500\)/);
  assert.doesNotMatch(body, /if \(codes\.has\(r\.code\)\) \{ result\.skipped\+\+; return; \}/);
});

// ═══ الدفعة 3 (البند 36): رفض الشكل صفاً صفاً برقم الصف والخانة ═══

// مخططا الصف كما في routes/import.ts حرفياً (الحارس أدناه يثبّت قيودهما)
const zCustomerRow = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional().default(''),
  creditLimit: z.number().nonnegative().optional(),
  paymentDays: z.number().int().nonnegative().optional(),
});
const zProductRow = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unit: z.string().trim().optional().default('حبة'),
  taxPct: z.number().min(0).max(100).optional(),
});

test('سيناريو البند 36: حد ائتمان سالب في صف واحد ⇒ خطأ صف برقمه وخانته وقيمته، لا «بيانات غير صحيحة» للملف كله', () => {
  const out = parseImportRows(zCustomerRow, [
    { name: 'مؤسسة النور', creditLimit: 1500 },
    { name: 'تموينات الخير', creditLimit: -1500 },
    { name: 'بقالة الحي', creditLimit: 0 },
  ]);
  assert.deepEqual(out.errors, [{ row: 3, message: SCHEMA_FIELD_TOO_SMALL, value: '-1500', field: 'creditLimit' }]);
  assert.equal(SCHEMA_FIELD_TOO_SMALL, 'القيمة أقل من المسموح في هذه الخانة');
  // الخانة تُترجم في الويب (FIELD_LABELS: creditLimit ⇒ «الحد الائتماني») فيعرف المالك عموده
  assert.equal(out.errors[0].field, 'creditLimit');
  assert.deepEqual(out.rows.map((r) => r.name), ['مؤسسة النور', 'بقالة الحي']);
});

test('البند 36: ضريبة 115 ⇒ «أكبر من المسموح»، والخانة المطلوبة الفارغة «مطلوبة»، والنص في خانة رقمية «نوع القيمة»', () => {
  const out = parseImportRows(zProductRow, [
    { code: 'P1', name: 'ماء', taxPct: 115 },
    { code: 'P2', name: '   ' },
    { code: 'P3', name: 'عصير', taxPct: 'خمسة عشر' },
    { name: 'بلا كود' },
    'صف ليس كائناً',
  ]);
  assert.deepEqual(out.errors.map((e) => [e.row, e.message, e.field, e.value]), [
    [2, SCHEMA_FIELD_TOO_BIG, 'taxPct', '115'],
    [3, SCHEMA_FIELD_REQUIRED, 'name', undefined],
    [4, SCHEMA_FIELD_TYPE, 'taxPct', 'خمسة عشر'],
    [5, SCHEMA_FIELD_REQUIRED, 'code', undefined],
    [6, SCHEMA_FIELD_TYPE, undefined, undefined],
  ]);
  assert.deepEqual(out.rows, []);
});

test('البند 36: الملف السليم لا يتغيّر — الناتج هو عين ما ينتجه parse (القصّ والافتراضات) فالبصمة والعدّ كما هما', () => {
  const raw = [{ code: ' P1 ', name: ' ماء ' }, { code: 'P2', name: 'عصير', taxPct: 15 }];
  const out = parseImportRows(zProductRow, raw);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.rows, z.array(zProductRow).parse(raw));
  assert.deepEqual(out.rows[0], { code: 'P1', name: 'ماء', unit: 'حبة' });
});

test('البند 36: ملف فوق حدّ الدفعة ⇒ خطأ صف على أول صف زائد بالعدد والحدّ، والحدّ نفسه يمرّ', () => {
  assert.deepEqual(importRowLimitError(7000, 5000), { row: 5002, message: IMPORT_ROWS_OVER_LIMIT, value: '7000 / 5000' });
  assert.equal(importRowLimitError(5000, 5000), null);
  assert.equal(importRowLimitError(0, 5000), null);
  assert.match(IMPORT_ROWS_OVER_LIMIT, /قسّمه إلى ملفات أصغر/);
});

test('حارس ثابت: قيود الصف في routes/import.ts هي التي تحاكيها مخططات هذا الملف', () => {
  const src = read('routes/import.ts');
  assert.match(src, /creditLimit: z\.number\(\)\.nonnegative\(\)\.optional\(\)/);
  assert.match(src, /taxPct: z\.number\(\)\.min\(0\)\.max\(100\)\.optional\(\)/);
  assert.match(src, /name: z\.string\(\)\.trim\(\)\.min\(1\)/);
});

// ═══ الدفعة 3 (البندان 43 و44): تخطيط صفوف /prices ═══

const priceMatcher = buildCustomerMatcher([
  { id: 'c1', code: 'K-1', phone: '0501234567', name: 'مؤسسة النور' },
  { id: 'c2', code: 'K-2', phone: '0559876543', name: 'تموينات الخير' },
]);
const priceProducts = [
  { id: 'p1', code: 'A', deletedAt: null },
  { id: 'p2', code: 'B', deletedAt: null },
  { id: 'p3', code: 'OLD', deletedAt: new Date('2026-01-01T00:00:00Z') },
];

test('سيناريو البند 43: صفّان لنفس العميل والصنف بسعرين ⇒ كتابة واحدة بآخر سعر صراحةً، والملغى متخطٍّ معدود بتنبيه تعارض', () => {
  const plan = planPriceImportRows([
    { customerCode: 'K-1', productCode: 'A', price: 10 },
    { customerCode: 'K-1', productCode: 'A', price: 12 },
    { customerCode: 'K-2', productCode: 'B', price: 7 },
  ], priceMatcher, priceProducts, false);
  assert.deepEqual(plan.writes, [
    { row: 3, customerId: 'c1', productId: 'p1', price: 12 },
    { row: 4, customerId: 'c2', productId: 'p2', price: 7 },
  ]);
  assert.deepEqual(plan.duplicates, [{ rows: [2, 3], kept: 3, prices: [10, 12], conflict: true, code: 'A', customerName: 'K-1' }]);
  assert.deepEqual(plan.skippedRows, [{ row: 2, reason: 'DUPLICATE_PAIR', code: 'A' }]);
  assert.deepEqual(plan.errors, []);
  // السعران المتطابقان تكرار بلا تعارض (يُعدّ ولا يُنذر بخلاف)
  const same = planPriceImportRows([
    { customerName: 'مؤسسة النور', productCode: 'A', price: 10 },
    { customerName: 'مؤسسة النور', productCode: 'A', price: 10 },
  ], priceMatcher, priceProducts, false);
  assert.deepEqual(same.writes.map((w) => [w.row, w.price]), [[3, 10]]);
  assert.deepEqual(same.duplicates, [{ rows: [2, 3], kept: 3, prices: [10, 10], conflict: false, code: 'A', customerName: 'مؤسسة النور' }]);
});

test('سيناريو البند 44: سعر لصنف مؤرشف ⇒ تخطٍّ معدود بكوده لا «أضيف» ولا «الصنف غير موجود»', () => {
  const plan = planPriceImportRows([
    { customerCode: 'K-1', productCode: 'OLD', price: 5 },
    { customerCode: 'K-1', productCode: 'A', price: 9 },
  ], priceMatcher, priceProducts, false);
  assert.deepEqual(plan.skippedRows, [{ row: 2, reason: 'PRODUCT_ARCHIVED', code: 'OLD' }]);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.writes.map((w) => [w.row, w.productId]), [[3, 'p1']]);
});

test('البندان 43 و44: العدّ يستقيم — كل صف مُنسَب (كتابة أو تخطٍّ أو خطأ)، والصفري والمفقود والعميل غير المطابق أخطاء صفوف', () => {
  const rows = [
    { customerCode: 'K-1', productCode: 'A', price: 10 },   // 2 مكرر ملغى
    { customerCode: 'K-1', productCode: 'A', price: 12 },   // 3 الفائز
    { customerCode: 'K-1', productCode: 'OLD', price: 5 },  // 4 مؤرشف
    { customerCode: 'K-1', productCode: 'NOPE', price: 5 }, // 5 صنف غير موجود
    { customerCode: 'ZZZ', productCode: 'A', price: 5 },    // 6 عميل غير مطابق
    { customerCode: 'K-1', productCode: 'B', price: 0 },    // 7 سعر صفري بلا إقرار
  ];
  const plan = planPriceImportRows(rows, priceMatcher, priceProducts, false);
  assert.deepEqual(plan.errors.map((e) => [e.row, e.code]), [[5, 'PRODUCT_NOT_FOUND'], [6, 'CUSTOMER_NOT_FOUND'], [7, 'ZERO_PRICE']]);
  assert.deepEqual(plan.skippedRows, [{ row: 2, reason: 'DUPLICATE_PAIR', code: 'A' }, { row: 4, reason: 'PRODUCT_ARCHIVED', code: 'OLD' }]);
  assert.equal(plan.writes.length + plan.skippedRows.length + plan.errors.length, rows.length, 'صف بلا نسبة: العدد المعروض يضخّم «أضيف»');
  // الإقرار يقبل الصفر: الزوج يُكتب ولا يبقى خطأً
  const zero = planPriceImportRows([rows[5]], priceMatcher, priceProducts, true);
  assert.deepEqual(zero.errors, []);
  assert.deepEqual(zero.writes.map((w) => w.price), [0]);
});

// ═══ الدفعة 3: توصيل العقود في المسار (البنود 36 و43 و44 و31) ═══

/** جسم مُعالِج المسار كما في بقية الحراس الثابتة */
function routeBody(src: string, marker: string): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, marker);
  const end = src.indexOf('\nrouter.', i + marker.length);
  return src.slice(i, end < 0 ? undefined : end);
}

test('حارس ثابت (البند 36): المسارات الخمسة تفحص الصفوف صفاً صفاً وتردّ أخطاءها قبل أي حجز أو كتابة', () => {
  const src = read('routes/import.ts');
  // الحدود هي عين ما كان في z.array(row).max(N) — لم يُرفع حدّ ولم يُخفض
  assert.match(src, /const IMPORT_ROW_LIMITS = \{ customers: 5000, products: 5000, balances: 10000, ledger: 20000, prices: 20000 \} as const;/);
  const routes: [string, string, string, string][] = [
    ["router.post('/customers'", 'customerRow', 'customers', 'reserveMasterBatch('],
    ["router.post('/products'", 'productRow', 'products', 'reserveMasterBatch('],
    ["router.post('/balances'", 'balanceRow', 'balances', 'resolveImportDates('],
    ["router.post('/ledger'", 'ledgerRow', 'ledger', 'resolveImportDates('],
    ["router.post('/prices'", 'priceRow', 'prices', 'reserveMasterBatch('],
  ];
  for (const [marker, schema, kind, firstEffect] of routes) {
    const body = routeBody(src, marker);
    assert.match(body, new RegExp(`parseImportBodyRows\\(${schema}, body\\.rows, IMPORT_ROW_LIMITS\\.${kind}\\)`), marker);
    // العدّ الكلي من الصفوف المرسلة لا من الناجية، فلا يُخفي الرفض عدد صفوف الملف
    assert.match(body, /total: body\.rows\.length, errors: \[\.\.\.parsedRows\.errors\]/, marker);
    const guard = body.indexOf('if (result.errors.length) {');
    assert.ok(guard > 0, `${marker}: لا ردّ مبكر بأخطاء الصفوف`);
    assert.ok(guard < body.indexOf(firstEffect), `${marker}: ${firstEffect} قبل ردّ أخطاء الصفوف`);
  }
  // الغلاف لم يعد يرفض الملف كله: لا .max على rows في أي مخطط غلاف (المخزون الافتتاحي وحده كما كان)
  for (const wrapper of ['customersBody', 'productsBody', 'balancesBody', 'ledgerBody', 'pricesBody']) {
    const start = src.indexOf(`const ${wrapper} = z.object({`);
    assert.ok(start > 0, wrapper);
    const w = src.slice(start, src.indexOf('});', start));
    assert.match(w, /rows: z\.array\(z\.unknown\(\)\),/, wrapper);
    assert.doesNotMatch(w, /\.max\(/, `${wrapper}: ما زال يرفض الملف كله`);
  }
});

test('البند 36: الحدّ يُنتج خطأ صفّ يذكر عدد صفوف الملف والحدّ معاً، ويتقدّم أخطاء المخطط', () => {
  // parseImportBodyRows = parseImportRows + خطأ الحدّ في مقدمة القائمة (منطق المسار نفسه)
  const schema = z.object({ name: z.string().trim().min(1) });
  const raw = [{ name: 'أ' }, { name: '' }, { name: 'ج' }];
  const parsed = parseImportRows(schema, raw);
  const over = importRowLimitError(raw.length, 2);
  assert.deepEqual(over, { row: 4, message: IMPORT_ROWS_OVER_LIMIT, value: '3 / 2' });
  const errors = over ? [over, ...parsed.errors] : parsed.errors;
  assert.deepEqual(errors.map((e) => e.row), [4, 3]);
  // ضمن الحدّ: لا خطأ حدّ أصلاً، والصفوف السليمة وحدها تمرّ
  assert.equal(importRowLimitError(raw.length, 3), null);
  assert.deepEqual(parsed.rows, [{ name: 'أ' }, { name: 'ج' }]);
});

test('حارس ثابت (البندان 43 و44): /prices يخطط بـplanPriceImportRows بالمؤرشف، ويعيد skippedRows وwarnings.duplicates', () => {
  const src = read('routes/import.ts');
  const body = routeBody(src, "router.post('/prices'");
  // المؤرشف يُقرأ ليُميَّز عن «الصنف غير موجود» (البند 44)، وضريبته للبند 31
  assert.match(body, /select: \{ id: true, code: true, deletedAt: true, taxPct: true \}/);
  assert.match(body, /plan = planPriceImportRows\(rows, matcher, prods, body\.allowZeroPrice === true\);/);
  assert.match(body, /result\.skipped = plan\.skippedRows\.length;/);
  assert.match(body, /skippedRows: plan\.skippedRows\.slice\(0, 500\)/);
  assert.match(body, /warnings: \{ duplicates: plan\.duplicates\.slice\(0, 500\) \}/);
  // خريطة الكود القديمة وحلقتها ذهبتا: الزوج المكرر كان يُكتب مرتين ويُعدّ مرتين
  assert.doesNotMatch(body, /prodByCode/, 'خريطة الأكواد القديمة بلا فلتر الأرشفة');
  assert.doesNotMatch(body, /rows\.forEach\(/, 'حلقة الكتابة القديمة');
  // «أضيف» ما زال يُعدّ على ما التُزم فعلاً (onCommitted) لا على ما خُطِّط
  assert.ok(body.indexOf('onCommitted:') < body.indexOf('result.created++'));
  assert.match(body, /if \(pairsCounted\.has\(x\.result\.id\)\) continue;/);
});

test('سيناريو البند 31: السعر الشامل يُردّ إلى صافيه بضريبة الصنف ويُقرَّب بمنازل العملة (نصف-لأعلى)', () => {
  // ١١٥ شاملة ١٥٪ ⇒ ١٠٠ صافية: المندوب يبيع بـ115 لا بـ132.25
  assert.equal(roundHalfUp(netFromInclusive(115, 15), 2), 100);
  assert.equal(roundHalfUp(netFromInclusive(115, 5), 2), 109.52);
  // ضريبة صفرية أو غائبة ⇒ السعر كما هو (لا قسمة ولا فقد)
  assert.equal(netFromInclusive(115, 0), 115);
  assert.equal(roundHalfUp(netFromInclusive(100, 0), 2), 100);
  // منازل العملة الثلاث لا تُقصّ إلى اثنتين (دينار)
  assert.equal(roundHalfUp(netFromInclusive(11.5, 15), 3), 10);
  assert.equal(roundHalfUp(netFromInclusive(1, 15), 3), 0.87);
  // العدّ: ما لم تتغيّر قيمته لا يُعدّ محوَّلاً (ضريبة صفرية)
  const rows = [{ price: 115, tax: 15 }, { price: 50, tax: 0 }];
  assert.equal(rows.filter((r) => roundHalfUp(netFromInclusive(r.price, r.tax), 2) !== r.price).length, 1);
});

test('حارس ثابت (البند 31): الخيار في جذر جسم /products و/prices، والضريبة من الصف ثم الشركة، ومن الصنف في الأسعار', () => {
  const src = read('routes/import.ts');
  // (1) الخيار بجانب rows وforce لا داخل الصف — في المخططين معاً
  for (const wrapper of ['productsBody', 'pricesBody']) {
    const start = src.indexOf(`const ${wrapper} = z.object({`);
    const w = src.slice(start, src.indexOf('});', start));
    assert.match(w, /pricesIncludeTax: z\.boolean\(\)\.optional\(\)\.default\(false\),/, wrapper);
  }
  assert.doesNotMatch(src.slice(src.indexOf('const productRow = z.object({'), src.indexOf('const productsBody')), /pricesIncludeTax/, 'الخيار في الصف لا في الجسم');
  // (2) /products: ضريبة الصف وإلا ضريبة الشركة الافتراضية — وهي عين ما يُخزَّن في taxPct
  const products = routeBody(src, "router.post('/products'");
  assert.match(products, /roundHalfUp\(netFromInclusive\(gross, c\.r\.taxPct \?\? defaultVat \?\? 0\), decimals\)/);
  assert.match(products, /basePrice: netPriceByRow\.get\(row\) \?\? r\.basePrice \?\? 0, taxPct: r\.taxPct \?\? defaultVat,/);
  assert.match(products, /const decimals = currencyDecimalsOf\(company\?\.currency\);/);
  // (3) /prices: ضريبة الصنف المطابَق من القاعدة لا من الصف
  const prices = routeBody(src, "router.post('/prices'");
  assert.match(prices, /taxByProduct\.get\(w\.productId\) \?\? company\?\.defaultVatPct \?\? 0/);
  // (4) البصمة على الصفوف وحدها في الاثنين (كالمخزون الافتتاحي): تبديل الخيار تكرار لا دفعة ثانية
  for (const [b, kind] of [[products, 'products'], [prices, 'prices']] as const) {
    assert.match(b, new RegExp(`importContentHash\\('${kind}', rows\\)`), kind);
    assert.doesNotMatch(b, /importContentHash\([^)]*pricesIncludeTax/, `${kind}: الخيار دخل البصمة`);
  }
  // (5) العدد المحوَّل في الرد (الواجهة تقرأ netFromInclusive)
  assert.match(products, /netFromInclusive: netFromInclusiveRows/);
  assert.match(prices, /netFromInclusive: netFromInclusiveRows/);
});

test('انحدار البند 36: صفوف الأرصدة والكشوف والأسعار السليمة تعطي عين ما كان يعطيه z.array(row).parse', () => {
  // المعالجة المسبقة للتاريخ كما في routes/import.ts حرفياً (الفارغ ⇒ بلا تاريخ)
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const importDate = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().regex(YMD, 'التاريخ بصيغة YYYY-MM-DD').optional());
  const zBalanceRow = z.object({
    customerName: z.string().trim().optional(), customerCode: z.string().trim().optional(), phone: z.string().trim().optional(),
    balance: z.number(), date: importDate,
  });
  const zLedgerRow = z.object({
    customerName: z.string().trim().optional(), customerCode: z.string().trim().optional(), phone: z.string().trim().optional(),
    date: importDate, description: z.string().trim().optional(), debit: z.number().optional(), credit: z.number().optional(),
  });
  const zPriceRow = z.object({
    customerName: z.string().trim().optional(), customerCode: z.string().trim().optional(), phone: z.string().trim().optional(),
    productCode: z.string().trim().min(1), price: z.number().nonnegative(),
  });
  const balances = [{ customerName: ' مؤسسة النور ', balance: 12.5, date: '2026-01-05' }, { customerCode: 'K-2', balance: -3, date: '' }];
  const ledger = [{ customerCode: ' K-1 ', date: '', description: ' قيد ', debit: 5 }, { phone: '0501234567', date: '2026-02-01', credit: 2 }];
  const prices = [{ customerCode: 'K-1', productCode: ' A ', price: 0 }, { customerName: 'تموينات', productCode: 'B', price: 9.75 }];
  for (const [schema, raw, label] of [[zBalanceRow, balances, 'balances'], [zLedgerRow, ledger, 'ledger'], [zPriceRow, prices, 'prices']] as const) {
    const out = parseImportRows(schema as never, raw as never[]);
    assert.deepEqual(out.errors, [], label);
    assert.deepEqual(out.rows, z.array(schema as never).parse(raw as never[]), label);
  }
  // الخانة الفارغة للتاريخ ما زالت «بلا تاريخ» صفاً صفاً (لا خطأ صفّ جديد على ملف كان يمرّ)
  assert.equal((parseImportRows(zBalanceRow, [{ balance: 1, date: '' }]).rows[0] as { date?: string }).date, undefined);
  // والخطأ الحقيقي يبقى خطأ صفّ بخانته لا رفضاً للملف
  const bad = parseImportRows(zPriceRow, [{ customerCode: 'K-1', productCode: '', price: 1 }]);
  assert.deepEqual(bad.rows, []);
  assert.deepEqual(bad.errors.map((e) => [e.row, e.field]), [[2, 'productCode']]);
});

// ═══ إغلاق الدفعة 3: البند 39 (قاعدة واحدة للتاريخ المستقبلي) والبند 36 (سقف أخطاء الردّ) ═══

test('البند 39: القاعدة الواحدة لا تنبّه على غدِ الشركة المحلي — النسخة الثانية بـUTC كانت تنبيهاً كاذباً', () => {
  // اللحظة التي أثبت بها المتشكّك الكذب: 21:30 UTC = يومٌ تالٍ بتوقيت الشركة (الرياض)
  const now = new Date('2026-09-23T21:30:00.000Z');
  const opts = { timezone: null, activated: false, now } as const;
  // شركة بلا توقيت مضبوط: الحدّ يُحسب بالافتراضي وصفُّ «غدٍ محلياً» ضمن الحدّ ⇒ لا تنبيه
  assert.equal(maxImportEntryDate(now, DEFAULT_TIMEZONE), '2026-09-25');
  assert.equal(resolveImportDates([{ date: '2026-09-25' }], opts).futureDates, null, 'تنبيه كاذب على غدِ الشركة');
  // والنسخة المحذوفة (اللحظة المكتوبة تُقاس بـUTC) كانت تنبّه على الصفّ نفسه — هذا عين الفرق الذي أُغلق
  assert.equal(isImportDateTooFarAhead(new Date('2026-09-25T00:00:00.000Z'), now, 'UTC'), true);
  // وخطأ السنة ما زال يُرى: التنبيه معدود لا مانع
  const yearTypo = resolveImportDates([{ date: '2026-09-25' }, { date: '2052-03-15' }], opts);
  assert.equal(yearTypo.futureDates?.count, 1);
  assert.deepEqual(yearTypo.futureDates?.rows, [{ row: 3, date: '2052-03-15' }]);
  assert.equal(yearTypo.dates.length, 2, 'لا صفّ يُسقط');
});

test('حارس ثابت (البند 39): لا نسخة ثانية للقاعدة في المسار — التنبيه من resolveImportDates وحدها', () => {
  const src = read('routes/import.ts');
  assert.doesNotMatch(src, /futureDatedWarning/, 'النسخة الثانية ما زالت في المسار');
  // ولا حساب ثانٍ للقاعدة في المسار أصلاً: لا استدعاء ولا استيراد لدالّتيها من وحدة الدفاتر
  assert.doesNotMatch(src, /isImportDateTooFarAhead\(/, 'حساب ثانٍ للقاعدة في المسار');
  assert.doesNotMatch(src, /import \{[^}]*maxImportEntryDate[^}]*\} from '\.\.\/services\/gl\/opening'/, 'المسار ما زال يستورد دالّتي القاعدة');
  for (const marker of ["router.post('/balances'", "router.post('/ledger'"]) {
    const body = routeBody(src, marker);
    assert.match(body, /const \{ dates, undatedAsToday, futureDates: futureDated \} = resolveImportDates\(rows, \{ timezone: ctx\.timezone,/, marker);
    assert.match(body, /\.\.\.\(futureDated \? \{ futureDated \} : \{\}\)/, marker);
  }
});

test('البند 36: 20000 صفّ بعمود «مدين» نصّي ⇒ الردّ مقصوص على 500 خطأ وعدده الكامل في errorsTotal', () => {
  const zLedgerRow = z.object({
    customerCode: z.string().trim().optional(), date: z.string().trim().optional(),
    description: z.string().trim().optional(), debit: z.number().nonnegative().optional(),
  });
  const raw = Array.from({ length: 20000 }, (_, i) => ({ customerCode: `K-${i + 1}`, date: '2026-01-05', description: 'قيد مستورد من نظام سابق', debit: 'غير محدد' }));
  const { rows, errors } = parseImportRows(zLedgerRow, raw as never[]);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 20000, 'كل صفّ خطأ — هذا عين الملف الذي انتفخ به الردّ');
  // منطق المسار نفسه (cappedErrors): القائمة على 500 كأخواتها، والعدد الكامل منفصل
  const capped = { errors: errors.slice(0, 500), errorsTotal: errors.length };
  assert.equal(capped.errors.length, 500);
  assert.equal(capped.errorsTotal, 20000);
  assert.deepEqual(capped.errors[0].row, 2, 'أوّل الأخطاء يبقى أوّلها — لا عيّنة عشوائية');
  // الحجم: ما كان ميغابايتات صار عشرات الكيلوبايتات، والعدّ الصادق باقٍ
  const before = Buffer.byteLength(JSON.stringify({ errors }), 'utf8');
  const after = Buffer.byteLength(JSON.stringify(capped), 'utf8');
  assert.ok(before > 2_000_000, `الردّ السابق ${before} بايت`);
  assert.ok(after < before / 20, `الردّ بعد القصّ ${after} بايت`);
});

test('حارس ثابت (البند 36): كل ردود الاستيراد تنشر cappedErrors بعد result — لا قائمة أخطاء بلا سقف', () => {
  const src = read('routes/import.ts');
  assert.match(src, /const IMPORT_ERRORS_CAP = 500;/);
  assert.match(src, /return \{ errors: errors\.slice\(0, IMPORT_ERRORS_CAP\), errorsTotal: errors\.length \};/);
  // كل ردّ ينشر النتيجة يقصّ أخطاءها بعدها مباشرةً (السقف يغلب `errors` القادمة من `...result`)
  const spreads = src.match(/\.\.\.result, /g) ?? [];
  const capped = src.match(/\.\.\.result, \.\.\.cappedErrors\(/g) ?? [];
  assert.equal(capped.length, spreads.length, 'ردّ ينشر result بلا سقف أخطاء');
  assert.ok(spreads.length >= 12, `عدد ردود الاستيراد ${spreads.length}`);
  // ولا ردّ يعيد تعيين errors بعد السقف فيلغيه
  assert.doesNotMatch(src, /cappedErrors\([^)]*\), errors:/);
});
