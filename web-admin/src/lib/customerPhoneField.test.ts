// جوال العميل حرّ في لوحة الإدارة (أمر المالك ٧ نوفمبر ٢٠٢٦): اختياريّ، بلا حدّ أدنى ولا صيغة، سقف ٣٠ وحده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_PHONE_MAX, customerPhoneEditError, customerPhoneError, customerPhoneText, hasCustomerPhone, joinCustomerHint, trimCustomerPhone,
} from './customerPhoneField';
import { CUSTOMER_PHONE_MAX as REP_PHONE_MAX } from '../rep/customerPhone';
import { M_CUSTOMER_PHONE_MAX } from '../m/mCustomerPhone';
import { PHRASES } from '../i18n/strings';

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

test('بلا حدّ أدنى ولا صيغة: رقمٌ قصير أو نصّ حرّ مقبولان', () => {
  for (const v of ['', '1', '12', '0500', 'abc', '+1 (555) 010', '٠٥٠١٢٣٤٥٦٧', '05-0123-4567 ext 9']) {
    assert.equal(customerPhoneError(v), null, `رُفض «${v}» وهو حرّ`);
  }
});

test('سقف الأمان ٣٠ خانة وحده — بعد قصّ الطرفين', () => {
  assert.equal(CUSTOMER_PHONE_MAX, 30);
  assert.equal(customerPhoneError('1'.repeat(30)), null);
  assert.equal(customerPhoneError(`  ${'1'.repeat(30)}  `), null, 'الفراغ في الطرفين لا يُحسب');
  assert.equal(customerPhoneError('1'.repeat(31)), 'رقم الجوال أطول من 30 خانة');
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

test('تعديل عميلٍ قائم: جواله المحفوظ كما هو لا يُفحص بالسقف (كالخادم keepStoredPhone)، والمُغيَّر يُفحص', () => {
  const longOld = '0501234567 / 0551234567 / 0561234567';
  assert.ok(longOld.length > CUSTOMER_PHONE_MAX);
  assert.equal(customerPhoneEditError(longOld, longOld), null, 'رقمٌ قديم أطول يمنع تعديل باقي البطاقة');
  assert.equal(customerPhoneEditError(` ${longOld} `, longOld), null, 'الفراغ في الطرفين لا يُعدّ تغييراً');
  assert.equal(customerPhoneEditError(longOld + '9', longOld), 'رقم الجوال أطول من 30 خانة', 'الطويل المُغيَّر مرّ');
  assert.equal(customerPhoneEditError('', longOld), null, 'تفريغه مقبول');
  // عميلٌ جديد (بلا محفوظ) ⇒ الفحص كاملاً
  assert.equal(customerPhoneEditError(longOld), 'رقم الجوال أطول من 30 خانة');
  assert.equal(customerPhoneEditError(longOld, null), 'رقم الجوال أطول من 30 خانة');
  assert.equal(customerPhoneEditError('0501', undefined), null);
});

test('السقف ٣٠ معرَّفٌ مرّةً للويب ويطابق الخادم (البطاقة والاستيراد) — فلا تقبل واجهةٌ ما يرفضه الخادم', () => {
  assert.equal(REP_PHONE_MAX, CUSTOMER_PHONE_MAX);
  assert.equal(M_CUSTOMER_PHONE_MAX, CUSTOMER_PHONE_MAX);
  assert.match(src('rep', 'customerPhone.ts'), /export \{ CUSTOMER_PHONE_MAX \} from '\.\.\/lib\/customerPhoneField';/);
  assert.match(src('m', 'mCustomerPhone.ts'), /export const M_CUSTOMER_PHONE_MAX = CUSTOMER_PHONE_MAX;/);
  const serverMax = /export const CUSTOMER_PHONE_MAX = (\d+);/.exec(backendSrc('services', 'importMatch.ts'));
  assert.ok(serverMax, 'تعريف السقف غاب من importMatch.ts');
  assert.equal(Number(serverMax![1]), CUSTOMER_PHONE_MAX, 'سقف الويب افترق عن سقف الخادم');
  const route = backendSrc('routes', 'customers.ts');
  assert.match(route, /import \{ CUSTOMER_PHONE_MAX \} from '\.\.\/services\/importMatch';/);
  assert.doesNotMatch(route, /const CUSTOMER_PHONE_MAX\s*=/, 'نسخةٌ ثانية للسقف في routes/customers.ts');
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

test('نصّ الخطأ مترجمٌ بلغاته الخمس', () => {
  const e = PHRASES['رقم الجوال أطول من 30 خانة'] as Record<string, string> | undefined;
  assert.ok(e, 'المفتاح غائب عن القاموس');
  for (const l of ['en', 'fr', 'tr', 'zh']) assert.ok(e[l] && e[l].trim(), `ترجمة ${l} غائبة`);
});

test('نموذج العميل: الجوال بلا required ولا نجمة، ويُرسل مقصوصاً', () => {
  const m = src('components', 'forms', 'CustomerModal.tsx');
  assert.doesNotMatch(m, /register\('phone',\s*\{\s*required/, 'الجوال ما زال إلزامياً');
  // خيارات register('phone', {...}) كلّها: لا required ولا minLength ولا pattern في أيّ موضع — والسقف بفحص التعديل وحده
  const opts = /register\('phone',\s*(\{[^\n]*\})\s*\)\}/.exec(m);
  assert.ok(opts, 'تسجيل خانة الجوال غاب أو تغيّر شكله');
  assert.doesNotMatch(opts![1], /\brequired\b|\bminLength\b|\bpattern\b|\bmin\b/, `قيدٌ عاد على الجوال: ${opts![1]}`);
  assert.match(opts![1], /customerPhoneEditError\(v, customer\?\.phone\)/, 'الجوال المحفوظ القديم يمنع تعديل البطاقة');
  assert.doesNotMatch(m, /tr\('رقم الجوال'\)\}\s*\*/, 'النجمة ما زالت بجانب الجوال');
  assert.match(m, /maxLength=\{CUSTOMER_PHONE_MAX\}/);
  assert.match(m, /phone:\s*trimCustomerPhone\(raw\.phone\)/);
  // الاسم يبقى إلزامياً — فكّ القيد للجوال وحده
  assert.match(m, /register\('name',\s*\{\s*required:\s*true/);
});

test('شاشات الإدارة لا تعرض فاصلاً يتيماً ولا خانةً بيضاء لعميلٍ بلا جوال', () => {
  assert.doesNotMatch(src('components', 'forms', 'CustomerStatementModal.tsx'), /\{customer\.name\} • \{customer\.phone\}/);
  assert.doesNotMatch(src('components', 'forms', 'InvoiceModal.tsx'), /hint:\s*c\.phone\s*\+/);
  assert.match(src('pages', 'CustomersPage.tsx'), /customerPhoneText\(c\.phone, '-'\)/);
});
