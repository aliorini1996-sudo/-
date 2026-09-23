// ZATCA المرحلة الثانية (Z5.4) — قرار «الاعتماد قبل المشاركة»: من حالة المستند إلى ردّ المسار.
//
// ما تحرسه هذه الاختبارات:
//   ١) **القرار من الحالة المخزَّنة وحدها**: كل حالة مستند لها ردٌّ واحد معروف، ولا حالة تسقط في «غير معرَّف».
//   ٢) نقد 10: القياسية بعد إيقاف الاعتماد (303) تصير مُبلَّغة **قابلة للطباعة** — لولا ذلك بقيت معلّقة إلى الأبد
//      ومعها تحصيلها.
//   ٣) الرسائل المخزَّنة تُقرأ متساهلةً ومنقّحةً: لا نصّ خام، ولا انهيار على شكلٍ غير متوقَّع، وبسقف.
//   ٤) الحدّ الزمنيّ لا يرمي أبداً ولا يترك وعداً مرفوضاً بلا التقاط: الفاتورة التُزمت فعلاً، وانقضاء مهلتنا
//      ليس خطأً بل «بانتظار الاعتماد».
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEARANCE_PENDING_REASONS, INLINE_CLEARANCE_CALL_TIMEOUT_MS, INLINE_CLEARANCE_TIMEOUT_MS, clearanceOutcome,
  clearancePendingError, clearanceRejectedError, clearanceWithdrawnError, clearedNoXmlError, storedZatcaErrors, storedZatcaWarnings,
  withDeadline,
} from './clearance';
import { DOCUMENT_STATUSES, type DocumentStatus } from './status';

// ═══ الجدول الكامل ═══

test('كل حالة مستند لها ردٌّ معروف للقياسية — لا حالة بلا قرار', () => {
  const expected: Record<DocumentStatus, [string, boolean]> = {
    SIGNED: ['pending', false], SUBMITTING: ['pending', false], RETRY_WAIT: ['pending', false],
    AUTH_BLOCKED: ['pending', false], CONFIG_ERROR: ['pending', false],
    REPORTED: ['cleared', true], REPORTED_WARN: ['cleared', true],
    CLEARED: ['cleared', true], CLEARED_WARN: ['cleared', true],
    CLEARED_NO_XML: ['cleared_no_xml', false], REJECTED: ['rejected', false], WITHDRAWN: ['withdrawn', false],
  };
  for (const s of DOCUMENT_STATUSES) {
    const o = clearanceOutcome(s, '01');
    assert.equal(o.kind, expected[s][0], `01 ${s}`);
    assert.equal(o.printable, expected[s][1], `طباعة 01 ${s}`);
    assert.equal(o.documentStatus, s);
  }
});

test('نقد 10: الإبلاغ بعد إيقاف الاعتماد (303) يجعل القياسية قابلة للطباعة لا معلّقة للأبد', () => {
  for (const s of ['REPORTED', 'REPORTED_WARN'] as DocumentStatus[]) {
    const o = clearanceOutcome(s, '01');
    assert.equal(o.kind, 'cleared', s);
    assert.equal(o.printable, true, s);
    assert.ok(o.mirror === 'reported' || o.mirror === 'reported_warn', s);
  }
});

test('حالة مجهولة أو مفقودة ⇒ معلّقة بسبب UNKNOWN (فشل مغلق: لا تُسلَّم فاتورة)', () => {
  for (const bad of [null, undefined, '', 'SOMETHING_NEW']) {
    const o = clearanceOutcome(bad, '01');
    assert.equal(o.kind, 'pending', String(bad));
    assert.equal(o.printable, false, String(bad));
    assert.equal(o.pendingReason, 'UNKNOWN', String(bad));
  }
  assert.equal(clearanceOutcome(null, '01').documentStatus, null);
});

test('سبب الانتظار يميّز «في الطريق» من «تُعاد المحاولة» من «محجوب»', () => {
  assert.equal(clearanceOutcome('SIGNED', '01').pendingReason, 'IN_FLIGHT');
  assert.equal(clearanceOutcome('SUBMITTING', '01').pendingReason, 'IN_FLIGHT');
  assert.equal(clearanceOutcome('RETRY_WAIT', '01').pendingReason, 'RETRY');
  assert.equal(clearanceOutcome('AUTH_BLOCKED', '01').pendingReason, 'BLOCKED');
  assert.equal(clearanceOutcome('CONFIG_ERROR', '01').pendingReason, 'BLOCKED');
  for (const [, text] of Object.entries(CLEARANCE_PENDING_REASONS)) assert.ok(text.length > 5 && /[؀-ۿ]/.test(text));
});

test('المبسّطة لا تمرّ بالاعتماد: كل حالاتها غير المرفوضة قابلة للطباعة', () => {
  assert.equal(clearanceOutcome('SIGNED', '02').printable, true);
  assert.equal(clearanceOutcome('REPORTED', '02').printable, true);
  assert.equal(clearanceOutcome('REJECTED', '02').printable, false);
  assert.equal(clearanceOutcome('REJECTED', '02').kind, 'rejected');
});

// ═══ ردود المسار ═══

test('202 «بانتظار الاعتماد» تحمل السبب بالعربية والبيانات، وsuccess = true (الفاتورة صدرت فعلاً)', () => {
  const e = clearancePendingError('RETRY', { id: 'inv-1' });
  assert.equal(e.status, 202);
  assert.equal(e.code, 'ZATCA_CLEARANCE_PENDING');
  const b = e.body();
  assert.equal(b.success, true);
  assert.equal(b.reason, 'RETRY');
  assert.deepEqual(b.data, { id: 'inv-1' });
  assert.ok(String(b.message).includes(CLEARANCE_PENDING_REASONS.RETRY));
});

test('422 الرفض يسرد رسائل الهيئة ويطلب إصدار فاتورة جديدة', () => {
  const validation = { errors: [{ code: 'BR-KSA-01', message: 'الرقم الضريبي غير صالح' }, { code: 'X', message: null }] };
  const e = clearanceRejectedError(validation, { id: 'inv-2' });
  assert.equal(e.status, 422);
  assert.equal(e.code, 'ZATCA_REJECTED');
  assert.ok(e.messageAr.includes('الرقم الضريبي غير صالح'));
  assert.ok(e.messageAr.includes('أصدر فاتورة جديدة'));
  assert.equal((e.body().errors as unknown[]).length, 2);
});

test('202 «اعتماد بلا نسخة» رسالةٌ صريحة تنهى عن التسليم (U8)', () => {
  const e = clearedNoXmlError({ id: 'inv-3' });
  assert.equal(e.status, 202);
  assert.equal(e.code, 'ZATCA_CLEARED_NO_XML');
  assert.equal(e.body().success, true);
  assert.ok(e.messageAr.includes('لا تُسلِّم'));
});

/* مراجعة عدائية ٢ (النتيجة 10): WITHDRAWN كان يسقط في الفرع العامّ فيقول ردُّ إعادة الرفع «بانتظار حسم الهيئة»
 * عن مستندٍ لن يُرسل أبداً وفاتورةٍ أُلغيت — عكسُ الحقيقة تماماً. */
test('409 السحب: لا «بانتظار الحسم» عن مستند سُحب وفاتورةٍ أُلغيت', () => {
  const o = clearanceOutcome('WITHDRAWN', '01');
  assert.equal(o.kind, 'withdrawn');
  assert.equal(o.pendingReason, null, 'سببُ انتظارٍ لحالةٍ لا انتظار فيها');
  assert.equal(o.mirror, 'withdrawn');
  assert.equal(o.printable, false);
  const e = clearanceWithdrawnError({ id: 'inv-4' });
  assert.equal(e.status, 409);
  assert.equal(e.code, 'ZATCA_WITHDRAWN');
  assert.ok(e.messageAr.includes('سُحبت') && e.messageAr.includes('جديدة'), 'الرسالة لا تقول ما جرى ولا ما يُفعل');
  assert.deepEqual(e.body().data, { id: 'inv-4' });
  // والمبسّطة لا تُسحب أصلاً، فإن وُجدت الحالة فالردّ نفسه لا «معلّقة»
  assert.equal(clearanceOutcome('WITHDRAWN', '02').kind, 'withdrawn');
});

// ═══ الرسائل المخزَّنة ═══

test('الرسائل تُقرأ متساهلةً: شكلٌ غير متوقَّع ⇒ قائمة فارغة لا انهيار', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { errors: 'nope' }, { errors: [1, null, 'x'] }]) {
    assert.deepEqual(storedZatcaErrors(bad), bad && typeof bad === 'object' && Array.isArray((bad as { errors?: unknown }).errors) ? [] : []);
  }
  assert.deepEqual(storedZatcaWarnings({ warnings: [{ code: 'W1', message: 'تحذير' }] }), [{ code: 'W1', message: 'تحذير' }]);
});

test('السقف ست رسائل — عطلٌ واحد لا يملأ ردّ المسار', () => {
  const many = { errors: Array.from({ length: 20 }, (_, i) => ({ code: `E${i}`, message: `خطأ ${i}` })) };
  assert.equal(storedZatcaErrors(many).length, 6);
});

test('الحقول غير النصّية تصير null لا تُنقل كما هي (لا نصّ خام في الردّ)', () => {
  const raw = { errors: [{ code: 5, message: { nested: true } }] };
  assert.deepEqual(storedZatcaErrors(raw), [{ code: null, message: null }]);
});

// ═══ الحدّ الزمنيّ ═══

test('انقضاء المهلة ⇒ timedOut بلا رمي، والعمل يكمل في الخلفية', async () => {
  let finished = false;
  const slow = new Promise<string>(resolve => { setTimeout(() => { finished = true; resolve('late'); }, 60); });
  const r = await withDeadline(slow, 10);
  assert.equal(r.timedOut, true);
  assert.equal(r.value, null);
  assert.equal(finished, false);
  await slow;
  assert.equal(finished, true);
});

test('رفض الوعد يُلتقط ولا يُسقط الطلب (الفاتورة التُزمت فعلاً)', async () => {
  const r = await withDeadline(Promise.reject(new Error('boom')), 1000);
  assert.equal(r.timedOut, false);
  assert.equal(r.value, null);
  assert.equal((r.error as Error).message, 'boom');
});

test('رفضٌ بعد انقضاء المهلة لا يصير unhandled rejection', async () => {
  const rejects = new Promise<string>((_r, reject) => { setTimeout(() => reject(new Error('late boom')), 30); });
  const r = await withDeadline(rejects, 5);
  assert.equal(r.timedOut, true);
  await new Promise(res => setTimeout(res, 60)); // لو لم يُلتقط لسقطت العملية هنا
});

test('القيمة تعود حين تسبق المهلة، والمهل متّسقة (نداء أقصر من نافذتنا)', async () => {
  const r = await withDeadline(Promise.resolve(7), 1000);
  assert.deepEqual([r.timedOut, r.value, r.error], [false, 7, null]);
  assert.ok(INLINE_CLEARANCE_CALL_TIMEOUT_MS < INLINE_CLEARANCE_TIMEOUT_MS, 'مهلة النداء ليست أقصر من نافذة الانتظار');
  assert.ok(INLINE_CLEARANCE_TIMEOUT_MS <= 25_000, 'نافذة الانتظار أطول من صبر المستخدم');
});

test('مهلة غير صالحة تُعامَل كأقصر مهلة لا كانتظارٍ بلا نهاية', async () => {
  const r = await withDeadline(new Promise<number>(() => { /* لا يُحسم أبداً */ }), 0);
  assert.equal(r.timedOut, true);
});
