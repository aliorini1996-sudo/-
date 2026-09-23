// حرّاس تطبيق المندوب أمام ردود ZATCA المرحلة الثانية (Z5.2) — نصّية على مصدر RepApp.tsx.
//
// السبب أنّ كلا العطبين «ينجح» في زمن التنفيذ بلا استثناء يُرمى:
//   ١) 202 ZATCA_CLEARANCE_PENDING يصل بـ success: true، وأكسيوس لا يرمي على 2xx — فكان يُفتح مستند الطباعة
//      («فاتورة ضريبية») لمستندٍ لم تعتمده الهيئة بعد، وتُسلَّم الورقة للعميل.
//   ٢) 426 على قراءة فاتورة مرحلة ثانية من حزمة قديمة كان يُبتلع في `catch { }` — نقرةٌ لا تفعل شيئاً بلا تفسير،
//      وهو عين ما اختير الـ426 (برسالته العربية) لتفاديه.
// المكوّن ضخمٌ يعتمد على IndexedDB والكاميرا والموقع فلا يُرسَم هنا؛ والحارس يثبت موضع الشرط في المصدر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep/RepApp.tsx');

test('إصدار الفاتورة: ردٌّ غير 201 لا يفتح مستند الطباعة (202 بانتظار اعتماد الهيئة)', () => {
  const post = repApp.indexOf("const res = await repApi.post('/invoices', payload);");
  assert.ok(post > 0, 'نداء إصدار الفاتورة لم يعد بهذا الشكل — راجع الحارس');
  const guard = repApp.indexOf('if (res.status !== 201) {', post);
  const done = repApp.indexOf('onDone({', post);
  assert.ok(guard > post, 'لا حارس على حالة الردّ بعد الإصدار: 202 (بانتظار الاعتماد) يُطبع فاتورةً ضريبية');
  assert.ok(done > guard, 'مستند الطباعة يُفتح قبل التحقّق من حالة الردّ');
  // الحارس يخرج فعلاً (لا يكتفي برسالة ثم يسقط إلى الطباعة)
  const block = repApp.slice(guard, done);
  assert.match(block, /setLoading\(false\);/);
  assert.match(block, /setMsg\(/, 'الحارس صامت — رسالة الخادم لا تصل المندوب');
  assert.match(block, /return;/, 'الحارس لا يُوقف المسار');
  // نصّ الخادم أوّلاً (يحمل سبب التعليق)، ثمّ نصّنا المترجم
  assert.match(block, /res\.data\?\.message/, 'رسالة الخادم مُهمَلة');
});

test('قراءة مستند: رسالة الخادم (426 «حدّث التطبيق») تظهر ولا تُبتلع', () => {
  // قائمة المستندات
  const list = repApp.indexOf('const res = await repApi.get(`${endpoint}/${id}`);');
  assert.ok(list > 0, 'فتح مستند من القائمة لم يعد بهذا الشكل — راجع الحارس');
  const listTail = repApp.slice(list, list + 400);
  assert.match(listTail, /catch \(err: any\)/, 'الخطأ ما زال يُبتلع في catch فارغ');
  assert.match(listTail, /setOpenErr\(String\(err\?\.response\?\.data\?\.message/, 'رسالة الخادم لا تُعرض');
  assert.match(repApp, /\{openErr && </, 'الرسالة لا تُرسم في واجهة القائمة');

  // كشف الحساب (الفتح من الحركة)
  const stmt = repApp.indexOf('const res = await repApi.get(`/invoices/${invId}`);');
  assert.ok(stmt > 0, 'فتح مستند من الكشف لم يعد بهذا الشكل — راجع الحارس');
  const stmtTail = repApp.slice(stmt, stmt + 700);
  assert.match(stmtTail, /catch \(err: any\)/, 'الخطأ ما زال يُبتلع في catch فارغ');
  assert.match(stmtTail, /setDocError\(String\(err\?\.response\?\.data\?\.message/, 'رسالة الخادم لا تُعرض');
  assert.match(repApp, /\{docError && </, 'الرسالة لا تُرسم في واجهة الكشف');
});

test('نصوص الحرّاس مترجمة في القاموس (لا عربية مسرَّبة للغات الأخرى)', () => {
  const strings = read('i18n/strings.ts');
  for (const phrase of [
    'صدرت الفاتورة وبانتظار اعتماد الهيئة لا تسلم فاتورة ضريبية الآن',
    'تعذر فتح المستند تحقق من الاتصال',
  ]) {
    assert.ok(repApp.includes(`tr('${phrase}')`), `النصّ غير مستعمل في RepApp: ${phrase}`);
    const at = strings.indexOf(`'${phrase}':`);
    assert.ok(at > 0, `النصّ غير مترجم في strings.ts: ${phrase}`);
    const entry = strings.slice(at, strings.indexOf('\n', at));
    for (const lang of ['en', 'fr', 'tr', 'zh']) assert.match(entry, new RegExp(`\\b${lang}:`), `${phrase} بلا ${lang}`);
  }
});
