/**
 * الحارس الحتمي لوكيل واتساب — اختبار السلوك.
 *
 * لماذا هذا الحارس أصلاً: سابقة Air Canada القضائية — الشركة مسؤولة قانونا عن أي
 * سعر أو سياسة ينطق بها بوتها. لذلك القرار لا يُترك للنموذج: `guardReply` يفحص كل
 * رد قبل خروجه، ويحجب ما خرج عن القائمة البيضاء السعرية أو الادعاءات المسموحة.
 *
 * الحارس يقلب السؤال: لا يسأل «هل الرد لطيف؟» بل **«هل التزم بما اعتمده المالك؟»**.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { guardReply, safeFallback } from '../services/wa-agent/guard';
import { OFFER, PLANS, priceForReps } from '../services/wa-agent/pricing';

test('يمرر ردا طبيعيا بالأسعار المعتمدة', () => {
  const v = guardReply('هلا والله 🙌 عرض سبتمبر 20 ريال لكل مندوب شهريا.\nكم مندوب عندك؟');
  assert.strictEqual(v.ok, true, `حُجب رد سليم: ${v.violations.join(' | ')}`);
  assert.strictEqual(v.forceEscalate, false);
});

test('يمرر حاصل ضرب تكلفة الفريق', () => {
  const total = priceForReps(5); // 5 × 20 = 100
  const v = guardReply(`تمام، 5 مناديب يعني ${total} ريال بالشهر لفريقك كامل.`);
  assert.strictEqual(v.ok, true, `حُجب حساب سليم: ${v.violations.join(' | ')}`);
});

test('يحجب سعرا مخترعا خارج القائمة البيضاء', () => {
  const v = guardReply('أقدر أعطيك الباقة بـ 150 ريال بس لك.');
  assert.strictEqual(v.ok, false, 'مرّ سعر غير معتمد');
  assert.strictEqual(v.forceEscalate, true);
  assert.ok(v.violations.some((x) => /القائمة البيضاء/.test(x)));
});

test('يحجب وعد خصم', () => {
  const v = guardReply('خصم خاص لك 🎁 لأنك أول عميل.');
  assert.strictEqual(v.ok, false, 'مرّ وعد خصم');
  assert.strictEqual(v.forceEscalate, true);
});

test('يحجب ادعاء ZATCA المرحلة الثانية والربط بالهيئة', () => {
  const v = guardReply('نعم النظام يدعم المرحلة الثانية ومرتبط مع هيئة الزكاة.');
  assert.strictEqual(v.ok, false, 'مرّ ادعاء تنظيمي كاذب');
  assert.strictEqual(v.forceEscalate, true);
});

test('يحجب ذكر منافس بالاسم', () => {
  const v = guardReply('نحن أفضل من repzo بمراحل.');
  assert.strictEqual(v.ok, false);
  assert.ok(v.violations.some((x) => /منافس/.test(x)));
});

test('يحجب طلب بيانات حساسة', () => {
  const v = guardReply('أرسل لي رقم البطاقة والرقم السري عشان أفعّل لك.');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.forceEscalate, true);
});

test('يحجب التزاما بموعد تسليم', () => {
  const v = guardReply('خلال 24 ساعة نسلّم لك النظام جاهز.');
  assert.strictEqual(v.ok, false, 'مرّ التزام بموعد');
});

test('يلتقط وسم التصعيد ولا يسربه للعميل', () => {
  const v = guardReply('ثواني أحوّلك لصاحب المنصّة 🙌 [[ESCALATE]]');
  assert.strictEqual(v.forceEscalate, true);
  assert.ok(!/ESCALATE/i.test(v.text), 'وسم التصعيد الداخلي تسرب إلى نص العميل');
});

test('يقص الرد الطويل ويجرده من الماركداون', () => {
  const long = '## عنوان\n**مهم**\n' + Array.from({ length: 20 }, (_, i) => `- سطر ${i}`).join('\n');
  const v = guardReply(long);
  assert.ok(!/^#/m.test(v.text), 'بقي عنوان ماركداون يظهر خاما في واتساب');
  assert.ok(!/\*\*/.test(v.text), 'بقي تعليم عريض مزدوج');
  assert.ok(v.text.split('\n').filter((l) => l.trim()).length <= 8, 'لم تُقص الأسطر الزائدة');
});

test('لا يخلط عدد المناديب وأيام التجربة بالأرقام المالية', () => {
  const v = guardReply('عندك 12 مندوب؟ تمام. التجربة 10 أيام مجانا بلا بطاقة.');
  assert.strictEqual(v.ok, true, `حُجب رد بلا مال: ${v.violations.join(' | ')}`);
});

test('يرفض الرد الفارغ ويصعد بدل إرسال فراغ', () => {
  const v = guardReply('   ');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.forceEscalate, true);
});

test('رسالة السقوط الآمن تمر بالحارس نفسه في كل لهجة', () => {
  (['gulf', 'egypt', 'levant', 'maghreb', 'msa'] as const).forEach((d) => {
    const msg = safeFallback(d);
    assert.ok(msg.length > 20, `لهجة بلا رسالة سقوط: ${d}`);
    assert.strictEqual(guardReply(msg).ok, true, `رسالة السقوط نفسها محجوبة في ${d}`);
  });
});

test('التسعير المعتمد لم يتغير خلسة', () => {
  assert.deepStrictEqual(PLANS.map((p) => p.priceSar), [299, 599], 'تغير التسعير المعتمد');
  assert.strictEqual(OFFER.pricePerRepSar, 20, 'تغير سعر العرض');
});
