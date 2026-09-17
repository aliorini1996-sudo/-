// البند 30 (مراجعة استيراد البيانات 2026-09-17): استيراد المنتجات لا يتخطى بصمت — المتخطى برقم الصف والسبب، والمكرر في الملف
// ببيانات مختلفة والكود المؤرشف أخطاء صفوف ظاهرة. منطق صرف + حارس ثابت، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IMPORT_ROW_MESSAGES, planProductImportRows } from '../services/importLedger';

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
