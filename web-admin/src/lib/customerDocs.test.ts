import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CUSTOMER_DOC_KINDS, docKindLabel, docKindsFor, docsPayload } from './customerDocs';
import { PHRASES } from '../i18n/strings';

// «استديو العميل» (طلب المالك ١٣ نوفمبر ٢٠٢٦)

test('بلا صور: جسم إنشاء العميل كما كان حرفياً (لا مفتاح documents)', () => {
  assert.deepEqual(docsPayload([]), {});
  assert.deepEqual(docsPayload([{ kind: 'CR', data: 'data:image/jpeg;base64,AAAA' }]), { documents: [{ kind: 'CR', data: 'data:image/jpeg;base64,AAAA' }] });
});

test('«إزالة الضريبة»: لا نوع «الشهادة الضريبية»، وغيرها الأنواع كلها', () => {
  assert.equal(docKindsFor(true).some((k) => k.code === 'VAT'), false);
  assert.equal(docKindsFor(false).length, CUSTOMER_DOC_KINDS.length);
  assert.equal(docKindLabel('UNKNOWN'), 'وثيقة أخرى');
});

test('أسماء الأنواع مترجمة في القاموس', () => {
  for (const k of CUSTOMER_DOC_KINDS) assert.ok(PHRASES[k.label]?.en, k.label);
});

test('الإضافة من الويب وتطبيق المندوب ترسل الوثائق في جسم العميل نفسه', () => {
  const web = fs.readFileSync(new URL('../components/forms/CustomerModal.tsx', import.meta.url), 'utf8');
  assert.match(web, /save\(customer \? d : \{ \.\.\.d, \.\.\.docsPayload\(docs\) \}\);/);
  // «حفظ» أثناء تجهيز الصور ينتظرها ثم يحفظ بها — لا يُحفظ العميل بلا ما لم يُجهَّز
  assert.match(web, /if \(!customer && docsBusy\) \{ setPendingSave\(d\); return; \}/);
  const rep = fs.readFileSync(new URL('../rep/RepApp.tsx', import.meta.url), 'utf8');
  const add = rep.slice(rep.indexOf('function AddCustomer('), rep.indexOf('function EditCustomer('));
  assert.match(add, /\.\.\.docsPayload\(docs\),\n\s*\};\n\s*attempt\.current = attemptClientRef/);
  // دون اتصال: العميل يُصفّ بلا الصور، وصوره مدخلٌ مستقلّ (customerDocs) بمفتاح الدفعة نفسه — والعميل المحلي بلا الصور
  assert.match(add, /const \{ documents: queuedDocs, \.\.\.custPayload \} = payload;/);
  assert.match(add, /kind: 'customer', payload: custPayload/);
  assert.match(add, /kind: 'customerDocs'/);
  assert.match(add, /onCreated\(\{ \.\.\.custPayload,/);
});
