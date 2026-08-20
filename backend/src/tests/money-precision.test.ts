// اختبارات دقة الكسور — متجهات مأخوذة حرفيا من تدقيق أغسطس ٢٠٢٦ (28 نتيجة مؤكدة)
// تحرس: التقريب الموحد نصف-لأعلى، توزيع أكبر الباقي، المحرك الشامل، وسلال الضريبة.
import { test } from 'node:test';
import assert from 'node:assert';
import { roundHalfUp, distributeAmount, netFromInclusive } from '../lib/money';
import { computeInvoiceTotals } from '../lib/invoiceCalc';

test('roundHalfUp: انصاف الهللات تصعد دائما مهما كانت ضوضاء الطفو', () => {
  assert.equal(roundHalfUp(1.005, 2), 1.01);   // كانت 1.00 (1.005×100=100.4999…)
  assert.equal(roundHalfUp(2.005, 2), 2.01);
  assert.equal(roundHalfUp(0.615, 2), 0.62);
  assert.equal(roundHalfUp(2.135, 2), 2.14);   // كانت 2.13
  assert.equal(roundHalfUp(0.145, 2), 0.15);
  assert.equal(roundHalfUp(6.7 * 0.15, 2), 1.01); // ضريبة 6.70@15% — كانت 1.00
  assert.equal(roundHalfUp(0.1 + 0.2, 2), 0.3);
  assert.equal(roundHalfUp(10.155, 2), 10.16);
  assert.equal(roundHalfUp(1.0005, 3), 1.001); // عملات 3 خانات
  assert.equal(roundHalfUp(-1.005, 2), -1.01); // السوالب بعيدا عن الصفر
});

test('distributeAmount: المجموع الموزع يساوي الهدف بالضبط ولا يهمل الصغار', () => {
  // 10 بنود × 1.09 بخصم 5% — الهدف 0.55 (كان يتوزع 0.50 فقط)
  const w = Array(10).fill(1.09);
  const shares = distributeAmount(0.55, w, 2);
  assert.equal(roundHalfUp(shares.reduce((s, v) => s + v, 0), 2), 0.55);
  // اوزان صفرية وسالبة لا تكسر التوزيع
  assert.deepEqual(distributeAmount(1, [0, -5, 0], 2), [0, 0, 0]);
  assert.deepEqual(distributeAmount(0, [3, 7], 2), [0, 0]);
});

test('الوضع الشامل: السعر المعلن للعميل لا يتغير قرشا واحدا', () => {
  // 10.00 شامل الضريبة — كان يصير 10.01 عبر round2(preTax)
  const r1 = computeInvoiceTotals(
    [{ qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(r1.total, 10.00);
  assert.equal(r1.items[0].lineTotal, 10.00);
  assert.equal(r1.taxAmt, 1.30); // 10×15/115

  // كمية 100 — كان الفرق يتضخم الى +0.50 ريال
  const r2 = computeInvoiceTotals(
    [{ qty: 100, unitPrice: 10, discountPct: 0, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(r2.total, 1000.00);

  // الحالة القصوى من التدقيق: صنف 0.02 شامل × 100 كان يخزن 2.30 (+15% مكررة)
  const r3 = computeInvoiceTotals(
    [{ qty: 100, unitPrice: 0.02, discountPct: 0, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(r3.total, 2.00);
});

test('الثابت الحاكم: الاجمالي = مجموع اجماليات البنود حرفيا (الوضعان)', () => {
  const items = [
    { qty: 3, unitPrice: 0.1, discountPct: 0, taxPct: 15 },
    { qty: 7, unitPrice: 6.7, discountPct: 10, taxPct: 15 },
    { qty: 1, unitPrice: 0.09, discountPct: 0, taxPct: 0 },
    { qty: 2.5, unitPrice: 1.999, discountPct: 33.33, taxPct: 15 },
  ];
  for (const inclusive of [false, true]) {
    const r = computeInvoiceTotals(items, {
      companyVat: 15, decimals: 2, invoiceDiscountPct: 5, pricesIncludeTax: inclusive });
    const sum = roundHalfUp(r.items.reduce((s, i) => s + i.lineTotal, 0), 2);
    assert.equal(sum, r.total, `الوضع ${inclusive ? 'الشامل' : 'الحصري'}: مجموع البنود ${sum} != الاجمالي ${r.total}`);
  }
});

test('سلة الضريبة: 100 بند صغير لا تنحرف عن نسبة 15% المعلنة', () => {
  // كانت الضريبة المجمعة 15.00 بدل 15.45 (نسبة فعلية 14.56%)
  const items = Array.from({ length: 100 }, () => ({ qty: 1, unitPrice: 1.03, discountPct: 0, taxPct: 15 }));
  const r = computeInvoiceTotals(items, { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 });
  assert.equal(r.taxAmt, 15.45);
  assert.equal(r.total, 118.45);
  // ومجموع ضرائب البنود يساوي ضريبة السلة بالضبط
  assert.equal(roundHalfUp(r.items.reduce((s, i) => s + i.taxAmt, 0), 2), 15.45);
});

test('خصم الفاتورة الكلي: النسبة الفعلية تطابق المعلنة (اكبر الباقي)', () => {
  // 10 بنود × 1.09 بخصم 5%: كان discountAmt=0.50 (خصم فعلي 4.59%) — الصحيح 0.55
  const items = Array.from({ length: 10 }, () => ({ qty: 1, unitPrice: 1.09, discountPct: 0, taxPct: 15 }));
  const r = computeInvoiceTotals(items, { companyVat: 15, decimals: 2, invoiceDiscountPct: 5 });
  assert.equal(r.discountAmt, 0.55);
  // 3 بنود × 33.33 بخصم 5%: كان 5.01 — الصحيح 5.00
  const items2 = Array.from({ length: 3 }, () => ({ qty: 1, unitPrice: 33.33, discountPct: 0, taxPct: 15 }));
  const r2 = computeInvoiceTotals(items2, { companyVat: 15, decimals: 2, invoiceDiscountPct: 5 });
  assert.equal(r2.discountAmt, 5.00);
});

test('عملة 3 خانات: لا فقد للفلس الثالث', () => {
  // كويتي: 1.999 د.ك × 3 = 5.997 (كان round2 يرسل 2.00 فيخزن 6.000)
  const r = computeInvoiceTotals(
    [{ qty: 3, unitPrice: 1.999, discountPct: 0, taxPct: 0 }],
    { companyVat: 0, decimals: 3, invoiceDiscountPct: 0 });
  assert.equal(r.total, 5.997);
});

test('حارس الصلاحية: رد السعر الشامل لا يتجاوز هامش 0.01 لاي سعر او نسبة', () => {
  // المندوب يرى round(basePrice×(1+t)) ويرسله كما هو؛ الخادم يرده ليقارنه بـbasePrice.
  // ان تجاوز الفرق هامش الحارس (0.01) رُفض مندوب لم يمس السعر — وهذا ما حدث فعلا.
  const TOL = 0.01;
  for (const taxPct of [0, 5, 14, 15, 20]) {
    for (const dec of [2, 3]) {
      for (const base of [0.02, 1, 1.03, 6.7, 33.33, 199.99, 11000.25, 87654.31]) {
        const shown = roundHalfUp(base * (1 + taxPct / 100), dec); // ما يعرضه التطبيق ويرسله
        const back = netFromInclusive(shown, taxPct);
        assert.ok(Math.abs(back - base) < TOL,
          `base=${base} tax=${taxPct}% dec=${dec}: رجع ${back} بفارق ${Math.abs(back - base)}`);
      }
    }
  }
  // الحالة الحرفية من بلاغ الميدان: صنف 1.00 ريال @15% يعرض 1.15 ويجب ان يرجع 1.00 تماما
  assert.equal(roundHalfUp(netFromInclusive(1.15, 15), 2), 1.00);
  // ضريبة صفر: الشامل هو الصافي نفسه
  assert.equal(netFromInclusive(7.5, 0), 7.5);
});

test('الثابت المحاسبي: subtotal − discountAmt + taxAmt = total في الوضعين', () => {
  // العمودان المخزنان يحملان معنى واحدا (صافٍ قبل الضريبة) مهما كان وضع التسعير،
  // والا جمع تقرير المبيعات خصوما بمقياسين وطبعت شاشة الفاتورة كتلة لا تتزن.
  const cases = [
    [[{ qty: 1, unitPrice: 1.15, discountPct: 0, taxPct: 15 }], 0],
    [[{ qty: 10, unitPrice: 115, discountPct: 0, taxPct: 15 }], 5],
    [[{ qty: 10, unitPrice: 115, discountPct: 10, taxPct: 15 }], 0],
    [[{ qty: 3, unitPrice: 1.15, discountPct: 0, taxPct: 15 },
      { qty: 2, unitPrice: 9, discountPct: 0, taxPct: 0 },
      { qty: 1, unitPrice: 5.7, discountPct: 25, taxPct: 14 }], 7],
  ] as const;
  for (const [items, discPct] of cases) {
    for (const inclusive of [false, true]) {
      const r = computeInvoiceTotals(items as any, {
        companyVat: 15, decimals: 2, invoiceDiscountPct: discPct, pricesIncludeTax: inclusive });
      assert.equal(roundHalfUp(r.subtotal - r.discountAmt + r.taxAmt, 2), r.total,
        `الوضع ${inclusive ? 'الشامل' : 'الحصري'}: ${r.subtotal} − ${r.discountAmt} + ${r.taxAmt} != ${r.total}`);
    }
  }
});

test('البيعة الواحدة تسجل الخصم نفسه من المندوب ومن اللوحة', () => {
  // 10 قطع بـ100 صافٍ @15% وخصم 10%: المندوب يرسل 115 شاملا واللوحة 100 صافيا،
  // والعميل يدفع المبلغ نفسه — فلا يجوز ان يخرج تقرير المبيعات بخصمين مختلفين.
  const rep = computeInvoiceTotals(
    [{ qty: 10, unitPrice: 115, discountPct: 10, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  const admin = computeInvoiceTotals(
    [{ qty: 10, unitPrice: 100, discountPct: 10, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 });
  assert.equal(rep.total, admin.total);         // 1035
  assert.equal(rep.taxAmt, admin.taxAmt);       // 135
  assert.equal(rep.discountAmt, admin.discountAmt); // 100 — كان 115 قبل الاصلاح
  assert.equal(rep.subtotal, admin.subtotal);   // 1000 — كان 1150 قبل الاصلاح
});
