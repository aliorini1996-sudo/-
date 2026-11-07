import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// نموذج العميل في لوحة الإدارة وموقع العميل (تدقيق نطاق ٥٠ متراً، ٧ نوفمبر ٢٠٢٦ — «أصلح الخلل فقط»):
// النموذج بلا خانة إحداثيات، وقيمه الافتراضية صفّ القائمة كما حُمّل — فكان كل حفظٍ يعيد lat/lng الصفّ. صفٌّ قديم (أعاد المندوب
// التقاط الدبوس عند الباب بعد تحميل القائمة) كان يعيد الدبوس القديم بتعديل الاسم أو الجوال. الآن لا يُرسلان، والرابط الملصوق
// يحدّث الموقع كما كان (يحلّه الخادم في PUT /customers/:id).

const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'forms', 'CustomerModal.tsx'), 'utf8');

test('نموذج العميل لا يعيد lat/lng صفّ القائمة — تعديل الحقول الأخرى لا يحرّك الدبوس، والرابط وحده يغيّره', () => {
  const submit = src.slice(src.indexOf('const submit = (raw: CustomerForm) => {'), src.indexOf('const legacyBuyerErrors'));
  assert.match(submit, /const data: CustomerForm = \{ \.\.\.raw, phone: trimCustomerPhone\(raw\.phone\) \};\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*delete data\.lat; delete data\.lng;\n\s*if \(!zatcaCollect\) \{ onSave\(data\); return; \}/);
  // المساران كلاهما (بلا بيانات المشتري ومعها) يرسلان data بعد الحذف
  assert.ok(submit.indexOf('delete data.lat') < submit.indexOf('onSave({ ...data, ...pickPhase2(buyer) }'));
  // لا خانة إحداثيات في النموذج — الرابط وحده
  assert.doesNotMatch(src, /register\('lat'|register\('lng'/);
  assert.match(src, /\{\.\.\.register\('locationUrl'\)\}/);
});
