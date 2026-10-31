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
  const list = repApp.indexOf('const res = await repApi.get(`${endpoint}/${id}`');
  assert.ok(list > 0, 'فتح مستند من القائمة لم يعد بهذا الشكل — راجع الحارس');
  const listTail = repApp.slice(list, list + 400);
  assert.match(listTail, /catch \(err: any\)/, 'الخطأ ما زال يُبتلع في catch فارغ');
  assert.match(listTail, /setOpenErr\(String\(err\?\.response\?\.data\?\.message/, 'رسالة الخادم لا تُعرض');
  assert.match(repApp, /\{openErr && </, 'الرسالة لا تُرسم في واجهة القائمة');

  // كشف الحساب (الفتح من الحركة)
  const stmt = repApp.indexOf('const res = await repApi.get(`/invoices/${invId}`');
  assert.ok(stmt > 0, 'فتح مستند من الكشف لم يعد بهذا الشكل — راجع الحارس');
  const stmtTail = repApp.slice(stmt, stmt + 700);
  assert.match(stmtTail, /catch \(err: any\)/, 'الخطأ ما زال يُبتلع في catch فارغ');
  assert.match(stmtTail, /setDocError\(String\(err\?\.response\?\.data\?\.message/, 'رسالة الخادم لا تُعرض');
  assert.match(repApp, /\{docError && </, 'الرسالة لا تُرسم في واجهة الكشف');
});

// ═══ «اشتراط اختيار فاتورة البيع للمرتجع» وسبب الإشعار الدائن (طلب المالك ٣١ أكتوبر ٢٠٢٦) — مسار الإصدار ═══
const submitSrc = repApp.slice(repApp.indexOf('const submit = async () => {'), repApp.indexOf("const res = await repApi.post('/invoices', payload);"));

test('إصدار المرتجع: حارس مصدر الفاتورة للإعداد الصريح وحده، وسبب الإشعار الدائن لكل مرتجعٍ في المرحلة الثانية — قبل الرفع', () => {
  assert.ok(submitSrc.length > 500, 'دالّة الإصدار لم تعد بهذا الشكل — راجع الحارس');
  // الافتراض (null): لا حارس على الجهاز — retLinkOnly وretManualOk كلاهما false (saleInvoicePicker.test.ts)
  assert.match(submitSrc, /if \(retLinkOnly \|\| retManualOk\) \{\n\s+const why = returnSourceProblem\(\{ phase2: retPhase2, linkRequired: retLinkRequired, linked: !!saleRef, manual: manualRef \}\);\n\s+if \(why\) \{ setMsg\(tr\(why\)\); return; \}/);
  assert.match(submitSrc, /const manualRef = retManual \? \{ number: manualNo, paymentType: manualPay \} : null;/);
  // الإصلاح: الخادم يردّ كل إشعارٍ دائن بلا سبب ٣–١٠٠٠ حرف — المندوب لم يكن يرسله أصلاً
  assert.match(submitSrc, /if \(retPhase2\) \{\n\s+const why = noteReasonProblem\(noteReasonText\);\n\s+if \(why\) \{ setMsg\(tr\(why\)\); return; \}/);
  // والحارسان قبل منع الإصدار دون اتصال وقبل بناء الجسم
  assert.ok(submitSrc.indexOf('returnSourceProblem(') < submitSrc.indexOf('const body = {'));
  assert.ok(submitSrc.indexOf('noteReasonProblem(') < submitSrc.indexOf('if (zatcaPhase2 && !navigator.onLine)'));
});

test('جسم المرتجع: noteReason في المرحلة الثانية (مرتبطاً أو يدوياً)، والرقم اليدويّ بلا originalInvoiceId، والأولى كما كانت', () => {
  const body = submitSrc.slice(submitSrc.indexOf('const body = {'), submitSrc.indexOf('attempt.current = attemptClientRef('));
  assert.match(body, /\.\.\.\(isReturn && saleRef && \{ originalInvoiceId: saleRef\.id \}\),/, 'الفاتورة المختارة وحدها تُرسل معرّفها');
  assert.match(body, /\.\.\.\(isReturn && repReturnPolicyFields\(\{ phase2: retPhase2, linked: !!saleRef, manual: manualRef, noteReason: noteReasonText \}\)\),/);
  // retManual يشترط !saleRef ⇒ الرقم اليدويّ لا يجتمع مع originalInvoiceId أبداً
  assert.match(repApp, /const retManual = retManualOk && manualMode && !saleRef;/);
  // السبب يبدأ من نصّ رقاقة السبب ويُعدَّل في المراجعة
  assert.match(repApp, /const noteReasonText = noteReasonTyped \?\? returnReasonLabel\(returnReason\);/);
  assert.match(repApp, /\{retPhase2 && \(\n\s+<div className="bg-white rounded-xl p-3 mt-2 border border-amber-100 space-y-2">/);
  assert.match(repApp, /maxLength=\{NOTE_REASON_MAX\} value=\{noteReasonText\}\n\s+onChange=\{e => setNoteReasonTyped\(e\.target\.value\)\}/);
});

test('ورقة الإشعار الدائن: مرجع الأصل وسببه في مساري 201 و202 — من ردّ الخادم وإلا ممّا أُرسل، والأولى بلاهما', () => {
  const post = repApp.indexOf("const res = await repApi.post('/invoices', payload);");
  const tail = repApp.slice(post, repApp.indexOf('} catch (err: any) {', post));
  assert.match(submitSrc, /const noteDoc = \(r: any\) => \(retPhase2 \? \{/);
  assert.match(submitSrc, /billingReference: txtOr\(r\?\.billingReference, manualRef \? normalizeReturnRef\(manualRef\.number\) : saleRef\?\.number\),/);
  assert.match(submitSrc, /noteReason: txtOr\(r\?\.noteReason, noteReasonText\.trim\(\)\),\n\s+\} : \{\}\);/);
  assert.match(tail, /zatca: out\.view,\n\s+\.\.\.noteDoc\(row\),/, 'مسار 202');
  // وبينهما سطر buyerNotice (فكّ قيد بيانات المشتري) — شاشة النتيجة وحدها، لا يمسّ الورقة
  assert.match(tail, /zatca: zatcaDocView\(inv\),\n(?:\s+\.\.\.\(notice && \{ buyerNotice: buyerNoticeText\(notice, tr\) \}\),\n)?\s+\.\.\.noteDoc\(inv\),/, 'مسار 201');
});

test('رفض الخادم لسياسة المرتجع يُعرض بعبارة القاموس بلغة المندوب', () => {
  assert.match(repApp, /if \(isReturn && RETURN_POLICY_CODES\.has\(err\?\.response\?\.data\?\.code\)\) \{ setMsg\(tr\(returnIssueError\(err\)\.message\)\); setLoading\(false\); return; \}/);
});

test('نصوص الحرّاس مترجمة في القاموس (لا عربية مسرَّبة للغات الأخرى)', () => {
  const strings = read('i18n/strings.ts');
  for (const phrase of [
    'صدرت الفاتورة وبانتظار اعتماد الهيئة لا تسلم فاتورة ضريبية الآن',
    'تعذر فتح المستند تحقق من الاتصال',
    // «اشتراط اختيار فاتورة البيع للمرتجع»
    'الشركة تشترط اختيار فاتورة البيع للمرتجع — اختر الفاتورة أولا',
    'اختر فاتورة البيع الأصلية أو فاتورة من خارج النظام',
    'من فاتورة بيع في النظام',
    'فاتورة من خارج النظام',
    'رقم الفاتورة الأصلية',
    'طريقة الدفع في الفاتورة الأصلية',
    'الفاتورة الأصلية',
    'سبب الإشعار الدائن',
  ]) {
    assert.ok(repApp.includes(`tr('${phrase}')`), `النصّ غير مستعمل في RepApp: ${phrase}`);
    const at = strings.indexOf(`'${phrase}':`);
    assert.ok(at > 0, `النصّ غير مترجم في strings.ts: ${phrase}`);
    const entry = strings.slice(at, strings.indexOf('\n', at));
    for (const lang of ['en', 'fr', 'tr', 'zh']) assert.match(entry, new RegExp(`\\b${lang}:`), `${phrase} بلا ${lang}`);
  }
});

test('مراجعة: ورقة الإشعار الدائن بعد الإصدار من ردّ الخادم — بند البيع في creditedItemId (المرحلة الثانية) وسعر الأصل وخصمه', () => {
  const src = read('rep/RepApp.tsx');
  // المرحلة الثانية تربط بند البيع في creditedItemId لا returnOfItemId — وإلا طُبعت معاينة الجهاز وخالفت رمز QR بفلس
  assert.match(src, /const linkOf = \(r: any\) => r\.returnOfItemId \?\? r\.creditedItemId;/);
  assert.match(src, /srvRows\.find\(r => linkOf\(r\) && linkOf\(r\) === l\.saleItemId\)/);
  // والإشعار برقمٍ يدويّ بلا فاتورة بيع يُطابَق بالموضع والصنف
  assert.match(src, /srvRows\[i\] && srvRows\[i\]\.productId === l\.productId/);
  // والخصم من صفّ الخادم (الإشعار يحفظ خصم بند الأصل)
  assert.match(src, /discountPct: Number\(r\.discountPct \?\? it\.discountPct\)/);
  // والإجماليات من الخادم حين تُطابَق البنود
  assert.match(src, /subtotal: Number\(inv\.subtotal\), discount: Number\(inv\.discountAmt\), tax: Number\(inv\.taxAmt\), total: Number\(inv\.total\)/);
});
