// فوترة ZATCA (Z5.1a) — الفئة الضريبية للصنف: التطبيع والفحص مرآةً لفحص البنود في preflight.ts (فلا يُحفظ صنف سيرفضه الإصدار).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_VAT_FIELDS, ProductVatState, bodyTouchesProductVat, normalizeProductVat, validateProductVat } from './productVat';
import { VATEX_CATEGORY } from './validators';

const state = (over: Partial<ProductVatState>): ProductVatState => ({ vatCategory: null, vatExemptionCode: null, vatExemptionReason: null, taxPct: 15, ...over });
const fields = (xs: { field: string }[]) => xs.map(x => x.field).sort();

test('التطبيع: قصّ، الفئة والرمز بأحرف كبيرة، \'\' ⇒ null، والسبب نصّ كما هو بعد القصّ؛ غير النصّ خطأ', () => {
  assert.deepEqual(normalizeProductVat({ vatCategory: ' z ', vatExemptionCode: 'vatex-sa-32', vatExemptionReason: '  صادرات  ', taxPct: 0 }).patch,
    { vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-32', vatExemptionReason: 'صادرات' });
  assert.deepEqual(normalizeProductVat({ vatCategory: '', vatExemptionCode: null }).patch, { vatCategory: null, vatExemptionCode: null });
  assert.deepEqual(fields(normalizeProductVat({ vatCategory: 1 }).errors), ['vatCategory']);
  assert.equal(bodyTouchesProductVat({ name: 'x', taxPct: 0 }), false);
  assert.equal(bodyTouchesProductVat({ vatExemptionReason: null }), true);
  assert.deepEqual([...PRODUCT_VAT_FIELDS], ['vatCategory', 'vatExemptionCode', 'vatExemptionReason']);
});

test('الفئة الفارغة مقبولة (تُستنتج S عند نسبة > 0) إلا مع رمز أو سبب إعفاء؛ وغير S/Z/E/O خطأ', () => {
  assert.deepEqual(validateProductVat(state({})), []);
  assert.deepEqual(validateProductVat(state({ taxPct: 0 })), [], '0% بلا فئة يُعدّ في الجاهزية ولا يمنع الحفظ');
  assert.deepEqual(fields(validateProductVat(state({ vatExemptionCode: 'VATEX-SA-32' }))), ['vatCategory']);
  assert.deepEqual(fields(validateProductVat(state({ vatCategory: 'X' }))), ['vatCategory']);
});

test('S: النسبة 15% أو 5% وبلا رمز ولا سبب (BR-KSA-84، BR-S-10)', () => {
  assert.deepEqual(validateProductVat(state({ vatCategory: 'S', taxPct: 15 })), []);
  assert.deepEqual(validateProductVat(state({ vatCategory: 'S', taxPct: 5 })), []);
  assert.deepEqual(fields(validateProductVat(state({ vatCategory: 'S', taxPct: 10 }))), ['taxPct']);
  assert.deepEqual(fields(validateProductVat(state({ vatCategory: 'S', vatExemptionReason: 'x' }))), ['vatExemptionCode']);
});

test('Z/E/O: النسبة 0% ورمز من فئتها نفسها ونصّ سبب (BR-x-05، BR-KSA-CL-04، BR-KSA-24)', () => {
  for (const [code, cat] of Object.entries(VATEX_CATEGORY)) {
    assert.deepEqual(validateProductVat(state({ vatCategory: cat, vatExemptionCode: code, vatExemptionReason: 'سبب', taxPct: 0 })), [], code);
  }
  assert.deepEqual(fields(validateProductVat(state({ vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-29', vatExemptionReason: 'x', taxPct: 0 }))), ['vatExemptionCode']);
  assert.deepEqual(fields(validateProductVat(state({ vatCategory: 'E', taxPct: 15 }))), ['taxPct', 'vatExemptionCode', 'vatExemptionReason']);
  assert.deepEqual(fields(validateProductVat(state({ vatCategory: 'O', vatExemptionCode: 'VATEX-SA-OOS', vatExemptionReason: 'x', taxPct: 0 }))), ['vatExemptionReason']);
});
