// جوال العميل حرّ في لوحة الإدارة (أمر المالك ٧ نوفمبر ٢٠٢٦): اختياريّ، بلا حدّ أدنى ولا صيغة — ثمّ ٩ نوفمبر ٢٠٢٦ «بلا قيود على
// العميل»: لا فحص يمنع الحفظ (لا سقف ٣٠ ولا اسم مطلوب)، وطول الخانة بقدر ما يحفظه الخادم (يقصّ إلى ٢٠٠ لا يرفض).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_PHONE_MAX, customerPhoneText, hasCustomerPhone, joinCustomerHint, trimCustomerPhone,
} from './customerPhoneField';
import * as phoneField from './customerPhoneField';
import { CUSTOMER_PHONE_MAX as REP_PHONE_MAX } from '../rep/customerPhone';
import { M_CUSTOMER_PHONE_MAX } from '../m/mCustomerPhone';

const src = (...p: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', ...p), 'utf8');
const backendSrc = (...p: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend', 'src', ...p), 'utf8');

test('القصّ: الفارغ والغائب وغير النصّي = \'\' (العمود لا يقبل null)', () => {
  assert.equal(trimCustomerPhone(undefined), '');
  assert.equal(trimCustomerPhone(null), '');
  assert.equal(trimCustomerPhone(''), '');
  assert.equal(trimCustomerPhone('   '), '');
  assert.equal(trimCustomerPhone({}), '');
  assert.equal(trimCustomerPhone('  0501234567 '), '0501234567');
  assert.equal(trimCustomerPhone(501234567), '501234567');
});

test('بلا قيود (٩ نوفمبر): لا فحص للجوال يمنع الحفظ — أُزيل customerPhoneError وcustomerPhoneEditError', () => {
  assert.equal('customerPhoneError' in phoneField, false, 'فحص الجوال المانع عاد');
  assert.equal('customerPhoneEditError' in phoneField, false, 'فحص الجوال المانع في التعديل عاد');
  // نصّ حرّ وقصير وطويل يُرسل مقصوص الطرفين كما كُتب
  for (const v of ['1', '12', '0500', 'abc', '+1 (555) 010', '٠٥٠١٢٣٤٥٦٧', '05-0123-4567 ext 9', '0501234567 / 0551234567 / 0561234567']) {
    assert.equal(trimCustomerPhone(` ${v} `), v);
  }
});

test('hasCustomerPhone: الفارغ والفراغات وحدها ليست جوالاً', () => {
  assert.equal(hasCustomerPhone(''), false);
  assert.equal(hasCustomerPhone('  '), false);
  assert.equal(hasCustomerPhone(null), false);
  assert.equal(hasCustomerPhone('5'), true);
});

test('«—» القديمة (علامة «بلا جوال» من استيرادٍ سابق) تُعامل فارغةً في العرض، والنصّ الحرّ يُعرض كما كُتب', () => {
  for (const v of ['—', ' - ', '–', '--', '.']) {
    assert.equal(hasCustomerPhone(v), false, `«${v}» عُدّ جوالاً`);
    assert.equal(customerPhoneText(v, '-'), '-');
  }
  assert.equal(joinCustomerHint('—', 'رصيد 50'), 'رصيد 50', 'فاصلٌ يتيم بعد «—»');
  assert.equal(joinCustomerHint('أحمد', '—'), 'أحمد');
  // الحرّ (ولو بلا أرقام) والقصير ليسا علامة فراغ
  assert.equal(hasCustomerPhone('لا يوجد'), true);
  assert.equal(hasCustomerPhone('٠٥٠'), true);
  assert.equal(customerPhoneText('12'), '12');
});

test('طول خانة الجوال معرَّفٌ مرّةً للويب ويساوي ما يحفظه الخادم (يقصّ إلى ٢٠٠) — فلا تقصّ واجهةٌ ما يقبله الخادم', () => {
  assert.equal(REP_PHONE_MAX, CUSTOMER_PHONE_MAX);
  assert.equal(M_CUSTOMER_PHONE_MAX, CUSTOMER_PHONE_MAX);
  assert.match(src('rep', 'customerPhone.ts'), /export \{ CUSTOMER_PHONE_MAX \} from '\.\.\/lib\/customerPhoneField';/);
  assert.match(src('m', 'mCustomerPhone.ts'), /export const M_CUSTOMER_PHONE_MAX = CUSTOMER_PHONE_MAX;/);
  const route = backendSrc('routes', 'customers.ts');
  const serverSlice = /phone: z\.preprocess\(\(v\) => \(v == null \? v : String\(v\)\.trim\(\)\.slice\(0, (\d+)\)\)/.exec(route);
  assert.ok(serverSlice, 'قصّ الجوال غاب من مخطّط routes/customers.ts');
  assert.equal(Number(serverSlice![1]), CUSTOMER_PHONE_MAX, 'طول خانة الويب افترق عن قصّ الخادم');
  assert.equal(CUSTOMER_PHONE_MAX, 200);
});

test('المطبوعات لا تطبع «الجوال: —» لعميلٍ بلا جوال أو بعلامة الاستيراد القديمة', () => {
  const docs = src('rep', 'RepDocuments.tsx');
  assert.doesNotMatch(docs, /doc\.customer\.phone &&/);
  assert.doesNotMatch(docs, /!!doc\.customer\.phone/);
  assert.equal((docs.match(/hasCustomerPhone\(doc\.customer\.phone\)/g) ?? []).length, 4);
  assert.match(src('rep', 'printGrid.tsx'), /if \(hasCustomerPhone\(customer\.phone\)\) buyerRows\.push\(\{ keys: \['rcp\.phone'\]/);
});

test('العرض: الفارغ شرطة لا خانة بيضاء', () => {
  assert.equal(customerPhoneText(''), '—');
  assert.equal(customerPhoneText('', '-'), '-');
  assert.equal(customerPhoneText(' 0501 '), '0501');
});

test('التلميح: لا فاصل يتيم حين يغيب الجوال، وundefined حين لا يبقى شيء', () => {
  assert.equal(joinCustomerHint('', 'رصيد 50'), 'رصيد 50');
  assert.equal(joinCustomerHint('0501', 'رصيد 50'), '0501 • رصيد 50');
  assert.equal(joinCustomerHint('0501', false), '0501');
  assert.equal(joinCustomerHint('أحمد', '  '), 'أحمد');
  assert.equal(joinCustomerHint('', false), undefined);
  assert.equal(joinCustomerHint(null, undefined), undefined);
});

test('نموذج العميل بلا قيود (٩ نوفمبر): لا اسم مطلوب ولا فحص للجوال ولا منعٌ من المتصفح — يُرسل دائماً، والجوال مقصوصاً', () => {
  const m = src('components', 'forms', 'CustomerModal.tsx');
  // الجوال: تسجيلٌ بلا خيارات (لا required ولا validate ولا pattern) ولا نجمة
  assert.match(m, /\{\.\.\.register\('phone'\)\}/, 'خانة الجوال عادت بخيارات فحص');
  assert.doesNotMatch(m, /customerPhoneEditError|customerPhoneError/, 'فحص الجوال المانع عاد');
  assert.doesNotMatch(m, /tr\('رقم الجوال'\)\}\s*\*/, 'النجمة ما زالت بجانب الجوال');
  assert.match(m, /maxLength=\{CUSTOMER_PHONE_MAX\}/);
  assert.match(m, /phone:\s*trimCustomerPhone\(raw\.phone\)/);
  // الاسم: لا required ولا نجمة — الخادم يملأ الفارغ ببديل
  assert.match(m, /\{\.\.\.register\('name'\)\}/, 'الاسم عاد إلزامياً');
  assert.doesNotMatch(m, /tr\('اسم العميل'\)\}\s*\*/, 'النجمة ما زالت بجانب الاسم');
  // لا required ولا pattern ولا validate في أيّ تسجيل — ولا منع المتصفح (noValidate، والبريد نصٌّ حرّ)
  assert.doesNotMatch(m, /register\('[^']+',\s*\{[^}]*\b(required|pattern|validate|minLength|maxLength)\b/, 'فحصٌ مانع عاد على خانة');
  assert.match(m, /<form noValidate onSubmit=\{handleSubmit\(submit\)\}/, 'المتصفح يمنع الحفظ من جديد');
  assert.doesNotMatch(m, /type="email"/, 'البريد بصيغةٍ يمنع بها المتصفح الحفظ');
  assert.match(m, /type="text" inputMode="email" dir="ltr" \{\.\.\.register\('email'\)\}/);
  assert.doesNotMatch(m, /errors\.(name|phone|email)/);
});

test('شاشات الإدارة لا تعرض فاصلاً يتيماً ولا خانةً بيضاء لعميلٍ بلا جوال', () => {
  assert.doesNotMatch(src('components', 'forms', 'CustomerStatementModal.tsx'), /\{customer\.name\} • \{customer\.phone\}/);
  assert.doesNotMatch(src('components', 'forms', 'InvoiceModal.tsx'), /hint:\s*c\.phone\s*\+/);
  assert.match(src('pages', 'CustomersPage.tsx'), /customerPhoneText\(c\.phone, '-'\)/);
});
