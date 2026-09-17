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
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
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

/** صيغ ZATCA المسموحة — تمرّ في الحارسين (البوت والموقع) */
const ZATCA_ALLOWED = [
  'نعم، ندعم ربط المرحلة الثانية مع منصة فاتورة.',
  'ندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك، والهيئة لا تعتمد مزوّدي البرمجيات.',
  'ربط المرحلة الثانية مع منصة فاتورة مفعّل.',
  'أما الشركات المفعّل لها ربط المرحلة الثانية فتحتاج الفاتورة الضريبية والمرتجع فيها اتصالاً لحظة الإصدار، ويبقى سند القبض متاحاً دون اتصال.',
];

/** ادّعاء اعتماد أو شراكة رسمية — يُحجب في الحارسين ولو بعد التفعيل */
const ZATCA_APPROVAL = [
  'نظامنا معتمد من هيئة الزكاة',
  'نظامنا مُعتمَد من الهيئة',
  'النظام مصادق من الهيئة',
  'نظامنا معتمد في منصة فاتورة',
  'معتمد عند الزكاة',
  'حاصلين على اعتماد هيئة الزكاة',
  'نظامنا معتمد من قبل هيئة الزكاة',
  'نحن معتمدين من قِبل الهيئة',
  'فواتيرنا معتمدة ZATCA',
  'نظامنا معتمد من فاتورة',
];
const ZATCA_PARTNER = ['شريك رسمي للهيئة', 'شريك رسمي لمنصة فاتورة', 'الشريك الرسمي لمنصة فاتورة', 'بالشراكة مع هيئة الزكاة'];

/**
 * موعد أو رقم مقرون بالمرحلة الثانية — بلا أرقام فوق 60: حارس المال يحجب «2027» وحده،
 * فكانت حالة «منذ يناير 2027» تنجح ولو حُذف نمط الموعد كله.
 */
const ZATCA_DATED = [
  'ربط المرحلة الثانية مفعّل منذ يناير',
  'منذ يناير وإحنا ندعم ربط المرحلة الثانية مع منصة فاتورة',
  'ندعم ربط المرحلة الثانية مع منصة فاتورة قبل الموجة ٢٥',
  'ندعم المرحلة الثانية قبل الموجة 25',
  'ربط المرحلة الثانية مفعّل عند أكثر من 40 شركة',
  'ربط المرحلة الثانية مفعّل عند أكثر من ٤٠ شركة',
  'Phase 2 live since January',
  'المرحله الثانيه مفعله من سنة ٢٠٢٦',
  'ربط المرحلة الثانية مفعل من يناير',
  'ربط المرحلة الثانية مفعل في مارس',
  'ربطنا المرحلة الثانية في الموجة ٢٤',
  'منذ ٢٠٢٦ ندعم ربط المرحلة الثانية',
  'سندعم ربط المرحلة الثانية قريباً',
];

const hasReason = (t: string, re: RegExp) => {
  const v = guardReply(t);
  assert.strictEqual(v.ok, false, `مرّ ادعاء تنظيمي ممنوع: ${t}`);
  assert.strictEqual(v.forceEscalate, true, `لم يُصعَّد: ${t}`);
  // سبب الحجب نفسه لا أي سبب: حارس المال وحده كان يُنجح حالة الموعد
  assert.ok(v.violations.some((x) => re.test(x)), `حُجب «${t}» بسبب آخر: ${v.violations.join(' | ')}`);
};

test('يمرر صيغة دعم ربط المرحلة الثانية مع منصة فاتورة وقيد الاتصال', () => {
  for (const t of ZATCA_ALLOWED) {
    const v = guardReply(t);
    assert.strictEqual(v.ok, true, `حُجبت الصيغة المعتمدة «${t}»: ${v.violations.join(' | ')}`);
    assert.strictEqual(v.forceEscalate, false);
  }
});

test('يحجب ادعاء الاعتماد والشراكة الرسمية — بسببه هو', () => {
  for (const t of ZATCA_APPROVAL) hasReason(t, /ادّعاء اعتماد رسمي/);
  for (const t of ZATCA_PARTNER) hasReason(t, /ادّعاء شراكة رسمية/);
  hasReason('المنصة مرتبطة مع هيئة الزكاة', /ارتباط مباشر بالهيئة/);
  // والربط مع منصة فاتورة التابعة للهيئة ليس ارتباطاً مباشراً بها
  assert.strictEqual(guardReply('المنصة مرتبطة بهيئة الزكاة عبر منصة فاتورة').ok, true);
});

test('يحجب أي موعد أو رقم للمرحلة الثانية — قبل المصطلح وبعده وبالأرقام الهندية', () => {
  for (const t of ZATCA_DATED) hasReason(t, /موعد أو رقم غير مثبت للمرحلة الثانية/);
});

test('الحارسان متسقان: جمل ZATCA نفسها تُحجب وتمرّ في حارس الموقع (claims-rules.mjs)', async () => {
  const rulesPath = path.join(process.cwd(), '..', 'web-admin', 'scripts', 'claims-rules.mjs');
  assert.ok(fs.existsSync(rulesPath), `قواعد حارس الموقع غير موجودة: ${rulesPath} — الاتساق لا يُختبر`);
  const site = await import(pathToFileURL(rulesPath).href);
  const siteIds = (t: string): string[] => site.checkText(t);
  for (const t of ZATCA_ALLOWED) assert.deepStrictEqual(siteIds(t), [], `حارس الموقع يحجب صيغة يمرّرها البوت: «${t}»`);
  for (const t of [...ZATCA_APPROVAL, ...ZATCA_PARTNER]) {
    assert.ok(siteIds(t).includes('zatca-approved'), `حارس الموقع يمرّر ادّعاء اعتماد يحجبه البوت: «${t}»`);
  }
  for (const t of ZATCA_DATED) {
    assert.ok(siteIds(t).includes('zatca-phase2-dated'), `حارس الموقع يمرّر موعداً يحجبه البوت: «${t}»`);
  }
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
  // الباقات الثلاث بقرار المالك (١٠ سبتمبر ٢٠٢٦ — انظر تعليق OFFER في pricing.ts)؛ كان الاختبار
  // يتوقّع باقتين فيفشل، فبقي الملف خارج npm test ولم يشغّله CI إطلاقاً.
  assert.deepStrictEqual(PLANS.map((p) => p.priceSar), [299, 399, 599], 'تغير التسعير المعتمد');
  assert.strictEqual(OFFER.pricePerRepSar, 20, 'تغير سعر العرض');
});
