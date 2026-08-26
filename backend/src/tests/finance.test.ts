/**
 * اختبارات المحرّك المالي.
 *
 * كُتبت بعد أن أظهر تدقيقٌ أن اللوحة تعرض «إيراد شهري متكرّر ١١٩٧ ر.س» بلا
 * ريال واحد خلفه: كان MRR يُشتقّ من حقل `plan` الذي افتراضه "basic" ولا تعرضه
 * واجهة إنشاء الشركة، فكل شركة أُنشئت يدوياً — ولو تجريبية مجانية — صارت ٢٩٩
 * ر.س شهرياً إلى الأبد. الوحدة كلّها كانت بلا اختبار واحد، وهذا سبب مرور الخلل.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  vatFromInclusive, gatewayFee, round2, monthBounds, recurringAppliesTo,
  VAT_PCT, GATEWAY_FEE_PCT, staleDaysOf, EXPENSE_STALE_DAYS,
} from '../services/finance';

const SRC = readFileSync(join(__dirname, '..', 'services', 'finance.ts'), 'utf8');

test('الضريبة تُستخرَج من مبلغ شامل لا تُضاف إليه', () => {
  // ١١٥٠ شاملة ١٥٪ ← الضريبة ١٥٠ والوعاء ١٠٠٠. الإضافة كانت ستعطي ١٧٢٫٥
  assert.equal(vatFromInclusive(1150), 150);
  assert.notEqual(vatFromInclusive(1150), round2(1150 * 0.15));
  assert.equal(vatFromInclusive(299), 39);
  assert.equal(vatFromInclusive(0), 0);
});

test('استخراج الضريبة يحترم النسبة المُمرَّرة لا الثابتة فقط', () => {
  assert.equal(VAT_PCT, 15);
  assert.equal(vatFromInclusive(110, 10), 10);
});

test('عمولة البوابة نسبة من الإجمالي المحصّل', () => {
  assert.equal(GATEWAY_FEE_PCT, 3);
  assert.equal(gatewayFee(1000), 30);
  assert.equal(gatewayFee(0), 0);
});

test('التقريب نصف-لأعلى إلى منزلتين', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(-0), 0);
});

test('حدود الشهر بتوقيت الرياض لا UTC', () => {
  const { from, to } = monthBounds(2026, 9);
  // أول سبتمبر ٠٠:٠٠ بالرياض = ٣١ أغسطس ٢١:٠٠ UTC
  assert.equal(from.toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(to.toISOString(), '2026-09-30T21:00:00.000Z');
});

test('دفعة فجر أول الشهر تُحتسب في شهرها لا في السابق', () => {
  // العميل دفع ١ سبتمبر الساعة ١:٠٠ فجراً بالرياض
  const paidAt = new Date('2026-08-31T22:00:00.000Z');
  const sep = monthBounds(2026, 9);
  const aug = monthBounds(2026, 8);
  assert.ok(paidAt >= sep.from && paidAt < sep.to, 'يجب أن تقع في سبتمبر');
  assert.ok(!(paidAt >= aug.from && paidAt < aug.to), 'يجب ألّا تقع في أغسطس');
});

test('حدود الشهر لا تترك ثغرة ولا تتداخل بين شهرين متتاليين', () => {
  for (let m = 1; m <= 11; m++) {
    assert.equal(monthBounds(2026, m).to.getTime(), monthBounds(2026, m + 1).from.getTime());
  }
  assert.equal(monthBounds(2026, 12).to.toISOString(), '2026-12-31T21:00:00.000Z');
});

test('حلقة الأشهر الستّة تعبر رأس السنة بلا انزلاق', () => {
  const y = 2026, m = 1; // يناير
  const got: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    got.push(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
  }
  assert.deepEqual(got, ['2025-8', '2025-9', '2025-10', '2025-11', '2025-12', '2026-1']);
});

test('سريان المصروف المتكرّر على الشهر', () => {
  const { from, to } = monthBounds(2026, 8);
  const d = (s: string) => new Date(s);
  assert.ok(recurringAppliesTo(d('2026-01-01'), null, from, to), 'بدأ قبله ومستمرّ');
  assert.ok(recurringAppliesTo(d('2026-08-15'), null, from, to), 'بدأ خلاله');
  assert.ok(!recurringAppliesTo(d('2026-09-05'), null, from, to), 'بدأ بعده');
  assert.ok(!recurringAppliesTo(d('2026-01-01'), d('2026-07-10'), from, to), 'انتهى قبله');
  assert.ok(recurringAppliesTo(d('2026-01-01'), d('2026-08-20'), from, to), 'انتهى خلاله');
});

test('الربح يقارن صافياً بصافٍ فلا تُخصم المدخلات مرّتين', () => {
  // إيراد ١١٥٠ شامل · مصروف ٥٧٥ نقداً منه ٧٥ ضريبة مدخلات قابلة للخصم
  const revenue = 1150, expenses = 575, vatPaid = 75;
  const vatCollected = vatFromInclusive(revenue);      // ١٥٠
  const revenueNet = round2(revenue - vatCollected);   // ١٠٠٠
  const fee = gatewayFee(revenue);                     // ٣٤٫٥
  const expensesNet = round2(expenses - vatPaid);      // ٥٠٠
  const profit = round2(revenueNet - expensesNet - fee);

  assert.equal(profit, 465.5);
  // المستحقّ للهيئة يخصم المدخلات مرّة واحدة — فلو خُصمت داخل المصروف أيضاً
  // لظهر الربح أقلّ بـ٧٥ ر.س بلا سبب
  assert.equal(round2(vatCollected - vatPaid), 75);
  assert.notEqual(profit, round2(revenueNet - expenses - fee));
});

test('حارس: MRR لا يُشتقّ من حقل الباقة إطلاقاً', () => {
  // هذا هو الخلل الذي أنتج ١١٩٧: لافتة باقة افتراضها "basic" لا يقف خلفها دفع
  assert.ok(!/PLAN_MONTHLY_SAR/.test(SRC), 'جدول أسعار الباقات عاد إلى المحرّك المالي');
  assert.ok(!/\bt\.plan\b/.test(SRC), 'MRR يقرأ tenant.plan مجدداً');
  assert.ok(!/select:\s*\{[^}]*\bplan:\s*true/.test(SRC), 'المحرّك يجلب حقل plan');
});

test('حارس: MRR يقوم على دفعة اشتراك مؤكَّدة عبر ميسر', () => {
  assert.ok(/status:\s*'paid'/.test(SRC), 'لا شرط على حالة الدفع');
  assert.ok(/months:\s*\{\s*gt:\s*0\s*\}/.test(SRC), 'لا شرط على كون الدفعة تمدّد اشتراكاً');
  assert.ok(/latestSubscriptionPayments/.test(SRC), 'اختفى مصدر الاشتراكات المدفوعة');
});

test('حارس: التكلفة المتكرّرة الحالية تحترم تاريخ البداية', () => {
  // مصروف مجدول بعد ثلاثة أشهر كان يضخّم تكلفة اليوم فيُنذر بعجز وهميّ
  assert.ok(/startsOn\s*<=\s*now/.test(SRC), 'فلتر المتكرّر السّاري يتجاهل البداية');
});

test('حارس: قائمة الإيرادات تُعلن اقتطاعها ومجموعها الكامل', () => {
  assert.ok(/truncated/.test(SRC), 'لا إعلان عن اقتطاع القائمة');
  assert.ok(/totalSar/.test(SRC), 'لا مجموع كامل يطابق ما يجمعه المالك');
});

// ————— الموجة الثانية: الأتمتة المضافة —————

const PAY_SRC = readFileSync(join(__dirname, '..', 'routes', 'payments.ts'), 'utf8');
const INV_SRC = readFileSync(join(__dirname, '..', 'services', 'platformInvoice.ts'), 'utf8');

test('التقادم يُقاس بالأيام من آخر مراجعة', () => {
  const now = new Date('2026-08-26T00:00:00Z');
  assert.equal(staleDaysOf(new Date('2026-08-26T00:00:00Z'), now), 0);
  assert.equal(staleDaysOf(new Date('2026-06-27T00:00:00Z'), now), 60);
  assert.ok(staleDaysOf(new Date('2026-06-27T00:00:00Z'), now) >= EXPENSE_STALE_DAYS);
  assert.ok(staleDaysOf(new Date('2026-08-01T00:00:00Z'), now) < EXPENSE_STALE_DAYS);
});

test('حارس: الاسترداد يُتحقَّق منه بجلب الدفعة من ميسر لا بجسم الإشعار', () => {
  assert.ok(/fetchPayment/.test(PAY_SRC), 'العكس لا يجلب الدفعة من ميسر');
  assert.ok(/payment_refunded/.test(PAY_SRC), 'حدث الاسترداد غير مُعالَج');
  // الردّ الجزئي يبقي جزءاً من المال عندنا — عكسه كلياً يمحو إيراداً محصّلاً
  assert.ok(/PARTIAL refund/.test(PAY_SRC), 'الردّ الجزئي غير محروس');
  // قطع خدمة عن شركة تعمل قرار المالك لا قرار webhook
  assert.ok(/subscription NOT shortened/.test(PAY_SRC), 'العكس قد يقلّص اشتراك العميل تلقائياً');
});

test('حارس: الفاتورة الضريبية لا تُصدَر بلا رقم ضريبي صالح', () => {
  assert.ok(INV_SRC.includes('{15}'), 'لا تحقّق من طول الرقم الضريبي (١٥ رقماً)');
  assert.ok(/paymentLinkId/.test(INV_SRC) && /@unique/.test(
    readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8')
      .split('model PlatformInvoice')[1].split('}')[0]), 'لا حارس ضدّ فاتورتين لدفعة واحدة');
});

test('حارس: إصدار الفاتورة لا يُسقط معاملة الدفع', () => {
  // إسقاط الدفع بسبب فشل الإصدار كان سيُرجع الرابط «غير مدفوع» فيُعاد تحصيله
  assert.ok(/issueForPayment\(link\.id\)\.catch/.test(PAY_SRC), 'فشل الإصدار قد يُسقط الدفع');
  assert.ok(!/await issueForPayment[^;]*\n\s*\}\);/.test(PAY_SRC), 'الإصدار داخل المعاملة');
});

test('الربع السنوي يجمع ثلاثة أشهر بحدودها الصحيحة', () => {
  // الربع الثالث = يوليو..سبتمبر؛ حدّه الأول أول يوليو بالرياض وآخره أول أكتوبر
  const first = (3 - 1) * 3 + 1;
  assert.equal(first, 7);
  assert.equal(monthBounds(2026, first).from.toISOString(), '2026-06-30T21:00:00.000Z');
  assert.equal(monthBounds(2026, first + 2).to.toISOString(), '2026-09-30T21:00:00.000Z');
});

test('حارس: المصروف يحفظ مبلغه الأصلي بعملته', () => {
  const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const model = SCHEMA.split('model OperatingExpense')[1].split('\n}')[0];
  assert.ok(/amountOriginal/.test(model), 'لا حفظ للمبلغ الأصلي');
  assert.ok(/currency/.test(model), 'لا حفظ للعملة');
  assert.ok(/reviewedAt/.test(model), 'لا تاريخ مراجعة — التقادم غير قابل للقياس');
});
