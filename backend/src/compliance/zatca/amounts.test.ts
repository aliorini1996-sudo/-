// اختبارات مبالغ Z1 — مطابقة المحرّك، برهان بقية التقريب الشامل، وخصائص BR-CO على مدخلات عشوائية.
// المُتحقِّقات هنا مكتوبة **مستقلّةً** عن amounts.ts/decimal.ts (تحليل نصوص وتقريب بـBigInt من جديد)
// كي لا يحرس الاختبار الخطأ نفسه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoiceTotals } from '../../lib/invoiceCalc';
import {
  computeUblAmounts, computeUblAmountsDetailed, largestRemainder, splitInclusive, solvePrice, AmountInput, AmountLineInput,
} from './amounts';
import {
  decFromNumber, divRoundHalfUp, formatDec, formatUnits, mulDec, parseAmount, roundDecToScale, toHalalas, decFromString,
} from './decimal';
import { ZatcaInputError, VatCategory } from './model';

// ─── مولّد عشوائي حتمي (mulberry32) ───
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── أدوات تحقق مستقلة ───
const AMT = /^\d+\.\d{2}$/;
function amt(s: string | undefined, what: string): bigint {
  assert.ok(s !== undefined && AMT.test(s), `${what}: مبلغ غير صالح أو سالب «${s}»`);
  return BigInt(s!.replace('.', ''));
}
function dec(s: string): { u: bigint; s: number } {
  assert.match(s, /^\d+(\.\d+)?$/);
  const [i, f = ''] = s.split('.');
  return { u: BigInt(i + f), s: f.length };
}
const p10 = (n: number) => 10n ** BigInt(n);
const roundHU = (num: bigint, den: bigint) => (2n * num + den) / (2n * den); // num ≥ 0
const halalasOf = (x: number) => Math.round(x * 100);
/** مساواة برسالة كسولة — لا تُبنى رسالة السياق (JSON للفاتورة كاملة) إلا عند الفشل. */
function eq<T>(actual: T, expected: T, msg: () => string) {
  if (actual !== expected) assert.fail(`${msg()} — actual=${String(actual)} expected=${String(expected)}`);
}

// ════════════════════════════════════════════════════════════════════════════
// decimal.ts
// ════════════════════════════════════════════════════════════════════════════

test('decimal: التحويل من number يأخذ أقصر تمثيل عشري (بلا غبار العائمة)', () => {
  assert.deepEqual(decFromNumber(0.1), { units: 1n, scale: 1 });
  assert.deepEqual(decFromNumber(1e-7), { units: 1n, scale: 7 });
  assert.deepEqual(decFromNumber(1.5e21), { units: 1500000000000000000000n, scale: 0 });
  assert.deepEqual(decFromNumber(-2.5), { units: -25n, scale: 1 });
  assert.deepEqual(decFromNumber(33.333333333333336), { units: 33333333333333336n, scale: 15 });
  assert.deepEqual(decFromNumber(12.50), { units: 125n, scale: 1 });
  assert.throws(() => decFromNumber(NaN), RangeError);
  assert.throws(() => decFromNumber(Infinity), RangeError);
});

test('decimal: التقريب نصف-لأعلى بعيداً عن الصفر على حدود الأنصاف', () => {
  assert.equal(divRoundHalfUp(5n, 10n), 1n);
  assert.equal(divRoundHalfUp(4n, 10n), 0n);
  assert.equal(divRoundHalfUp(15n, 10n), 2n);
  assert.equal(divRoundHalfUp(-5n, 10n), -1n);
  assert.equal(divRoundHalfUp(-4n, 10n), 0n);
  // [XML §10]: 123.4949 → 123.49 و123.4950 → 123.50؛ و1.005/2.675 التي تكسرها العائمة الساذجة
  assert.equal(toHalalas(decFromString('123.4949')), 12349n);
  assert.equal(toHalalas(decFromString('123.4950')), 12350n);
  assert.equal(toHalalas(decFromNumber(1.005)), 101n);
  assert.equal(toHalalas(decFromNumber(2.675)), 268n);
  assert.equal(roundDecToScale(decFromString('0.125'), 2), 13n);
});

test('decimal: التنسيق بخانات ثابتة والتحليل الصارم', () => {
  assert.equal(formatUnits(5n, 2), '0.05');
  assert.equal(formatUnits(-5n, 2), '-0.05');
  assert.equal(formatUnits(123456n, 2), '1234.56');
  assert.equal(formatDec(decFromNumber(33), 6), '33.000000');
  assert.equal(formatDec(decFromNumber(12.3456), 2), '12.3456');
  assert.equal(formatDec(decFromString('1.500'), 2), '1.50');
  assert.equal(parseAmount('0.00'), 0n);
  assert.equal(parseAmount('1234.56'), 123456n);
  assert.throws(() => parseAmount('1.5'), RangeError);
  assert.throws(() => parseAmount('1,000.00'), RangeError);
  assert.throws(() => parseAmount('1e3'), RangeError);
});

// ════════════════════════════════════════════════════════════════════════════
// لبنات التوزيع وحلّ السعر
// ════════════════════════════════════════════════════════════════════════════

test('largestRemainder: المجموع تامّ، الأوزان الصفرية صفر، والتعادل للفهرس الأصغر', () => {
  assert.deepEqual(largestRemainder(10n, [1n, 1n, 1n]), [4n, 3n, 3n]);
  assert.deepEqual(largestRemainder(7n, [0n, 5n, -3n, 5n]), [0n, 4n, 0n, 3n]);
  assert.deepEqual(largestRemainder(0n, [3n, 4n]), [0n, 0n]);
  assert.deepEqual(largestRemainder(9n, [0n, 0n]), [0n, 0n]);
  const r = rng(7);
  for (let k = 0; k < 2000; k++) {
    const w = Array.from({ length: 1 + Math.floor(r() * 9) }, () => BigInt(Math.floor(r() * 50000) - 5000));
    const total = BigInt(Math.floor(r() * 100000));
    const out = largestRemainder(total, w);
    const positive = w.some(x => x > 0n);
    assert.equal(out.reduce((s, v) => s + v, 0n), positive ? total : 0n);
    w.forEach((x, i) => { if (x <= 0n) assert.equal(out[i], 0n); else assert.ok(out[i] >= 0n); });
  }
});

test('solvePrice: أقصر سعر يحقق r2(الكمية × السعر) = الهدف، ولا مقياس أقصر يحققه', () => {
  assert.deepEqual(solvePrice(decFromNumber(2), 869n), { text: '4.345', exact: true });
  assert.deepEqual(solvePrice(decFromNumber(3), 3000n), { text: '10.00', exact: true });
  assert.deepEqual(solvePrice(decFromNumber(0), 0n), { text: '0.00', exact: true });
  const r = rng(11);
  for (let k = 0; k < 20000; k++) {
    const qty = [1 + Math.floor(r() * 500), Math.floor(r() * 100000) / 1000 + 0.001, Math.floor(r() * 1e6) + 1][k % 3];
    const q = decFromNumber(qty);
    const target = BigInt(Math.floor(r() * 5_000_000));
    const { text, exact } = solvePrice(q, target);
    assert.equal(exact, true, `qty ≤ 10^6 يجب أن يُحلّ دائماً: ${qty} ${target}`);
    const p = dec(text);
    assert.ok(p.s >= 2 && p.s <= 8);
    assert.equal(roundHU(q.units * p.u * 100n, p10(q.scale + p.s)), target, `r2(${qty}×${text}) ≠ ${target}`);
    if (p.s > 2) assert.equal(solvePrice(q, target, p.s - 1).exact, false, `يوجد سعر أقصر من ${text}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// برهان بقية التقريب في الوضع الشامل
// ════════════════════════════════════════════════════════════════════════════

// الحدّ الشامل: كل إجمالي من 0.01 إلى 100,000.00 ريال (10^7 هللة) لكل من 5% و15%.
const EXHAUSTIVE_MAX_HALALAS = 10_000_000;

test(`برهان شامل: |البقية| ≤ 0.01 وغير سالبة لكل إجمالي 0.01..100,000.00 ريال عند 5% و15%`, () => {
  // مرجع مستقلّ بأعداد صحيحة داخل Number (كل الجداءات < 2^53 فالقسمة الأرضية دقيقة)
  for (const R of [5, 15]) {
    const den2 = 2 * (100 + R);
    let deviations = 0, withResidual = 0;
    for (let G = 1; G <= EXHAUSTIVE_MAX_HALALAS; G++) {
      const t0 = Math.floor((200 * G + 100 + R) / den2);             // round(G×100/(100+R))
      let bestT = -1, bestRes = 0, bestAbs = Infinity;
      for (const T of [t0, t0 - 1, t0 + 1]) {
        if (T < 0) continue;
        const res = G - T - Math.floor((2 * T * R + 100) / 200);     // G − T − round(T×R/100)
        const abs = res < 0 ? -res : res;
        if (abs < bestAbs || (abs === bestAbs && res >= 0 && bestRes < 0)) { bestT = T; bestRes = res; bestAbs = abs; }
      }
      if (bestRes < 0 || bestRes > 1) assert.fail(`R=${R} G=${G}: بقية ${bestRes}`);
      if (bestRes !== 0) withResidual++;
      if (bestT !== t0) deviations++;
    }
    // التغطية: البقية غير الصفرية شائعة فعلاً (وإلا فالبرهان لا يختبر شيئاً)
    // f تقفز هللتين مرة كل 100/R خطوة ⇒ البقية غير الصفرية في نحو R/(100+R) من القيم (4.8% عند 5، 13% عند 15)
    assert.ok(withResidual > (EXHAUSTIVE_MAX_HALALAS * R) / (100 + R) * 0.95, `R=${R}: ${withResidual}`);
    assert.ok(deviations > 0, `R=${R}: حالات الاختيار بعيداً عن t0 = ${deviations}`);
  }
});

test('splitInclusive يطابق المرجع المستقلّ شاملاً حتى 5,000.00 ريال لكل من 5% و15%', () => {
  for (const R of [5n, 15n]) {
    const rate = { units: R, scale: 0 };
    for (let G = 0n; G <= 500_000n; G++) {
      const s = splitInclusive(G, rate);
      const tax = roundHU(s.taxable * R, 100n);
      if (s.tax !== tax || s.residual !== G - s.taxable - tax || s.residual < 0n || s.residual > 1n) {
        assert.fail(`R=${R} G=${G}: ${JSON.stringify({ ...s, taxable: String(s.taxable), tax: String(s.tax), residual: String(s.residual) })}`);
      }
    }
  }
});

test('splitInclusive = max{T : T + r2(T×R/100) ≤ G} (بحث ثنائي مستقلّ) لإجماليات حتى 10^10 ريال ونِسب غير صحيحة', () => {
  const r = rng(2026);
  for (let k = 0; k < 20000; k++) {
    const [ru, rs] = [[15n, 0], [5n, 0], [75n, 1], [100n, 0], [1n, 2]][k % 5] as [bigint, number];
    const G = BigInt(Math.floor(r() * 1e12)) * (k % 2 ? 1n : 1000n) + BigInt(k % 7);
    const den = 100n * p10(rs);
    const f = (T: bigint) => T + roundHU(T * ru, den);
    let lo = 0n, hi = G; // f(0)=0 ≤ G ، f(G) ≥ G
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (f(mid) <= G) lo = mid; else hi = mid - 1n; }
    const s = splitInclusive(G, { units: ru, scale: rs });
    assert.equal(s.taxable, lo, `R=${ru}e-${rs} G=${G}`);
    assert.ok(s.residual >= 0n && s.residual <= 1n);
  }
});

test('دورية البقية: G و G+k(100+R) لهما نفس البقية والوعاء يزيد 100k (أساس كفاية الدورة الواحدة)', () => {
  const r = rng(99);
  for (const R of [5n, 15n]) {
    for (let k = 0; k < 5000; k++) {
      const G = BigInt(Math.floor(r() * 1e7));
      const m = BigInt(1 + Math.floor(r() * 1e6));
      const a = splitInclusive(G, { units: R, scale: 0 });
      const b = splitInclusive(G + m * (100n + R), { units: R, scale: 0 });
      assert.equal(b.residual, a.residual);
      assert.equal(b.taxable, a.taxable + 100n * m);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// أمثلة ذهبية
// ════════════════════════════════════════════════════════════════════════════

test('ذهبي حصري: خصم بند + خصم فاتورة 5% + بند صفري — مبالغ مدقّقة يدوياً', () => {
  const r = computeUblAmounts({
    pricesIncludeTax: false, invoiceDiscountPct: 5,
    lines: [
      { qty: 10, unitPrice: 45.5, discountPct: 10, vatPct: 15, category: 'S' },
      { qty: 12.5, unitPrice: 3.35, discountPct: 0, vatPct: 15, category: 'S' },
      { qty: 4, unitPrice: 19.99, discountPct: 0, vatPct: 0, category: 'Z' },
    ],
  });
  assert.deepEqual(r.totals, {
    lineExtension: '531.34', taxExclusive: '504.77', taxInclusive: '569.09', allowanceTotal: '26.57',
    prepaid: '0.00', payable: '569.09', taxTotal: '64.32',
  });
  assert.deepEqual(r.docAllowances.map(a => [a.category, a.amount]), [['S', '22.57'], ['Z', '4.00']]);
  assert.deepEqual(r.subtotals, [
    { taxable: '428.81', tax: '64.32', category: 'S', percent: '15.00' },
    { taxable: '75.96', tax: '0.00', category: 'Z', percent: '0.00' },
  ]);
  assert.deepEqual(r.lines[0], {
    quantity: '10.000000', priceAmount: '45.50', lineExtension: '409.50', taxAmount: '58.35', roundingAmount: '467.85',
    allowance: { amount: '45.50', reason: 'discount', baseAmount: '455.00', multiplier: '10.00' },
  });
  assert.equal(r.lines[1].lineExtension, '41.88'); // 12.5 × 3.35 = 41.875 ⇒ 41.88
  assert.equal(r.lines[1].taxAmount, '5.97');
});

test('ذهبي شامل: 10.00 + 31.05 = 41.05 ⇒ وعاء 35.69 وضريبة 5.35 وتقريب 0.01 والعميل يدفع السعر المعلن', () => {
  const r = computeUblAmounts({
    pricesIncludeTax: true, invoiceDiscountPct: 0,
    lines: [
      { qty: 2, unitPrice: 5, discountPct: 0, vatPct: 15, category: 'S' },
      { qty: 3, unitPrice: 11.5, discountPct: 10, vatPct: 15, category: 'S' },
    ],
  });
  assert.equal(r.totals.taxExclusive, '35.69');
  assert.equal(r.totals.taxTotal, '5.35');
  assert.equal(r.totals.taxInclusive, '41.04');
  assert.equal(r.totals.payableRounding, '0.01');
  assert.equal(r.totals.payable, '41.05');
  assert.deepEqual(r.lines.map(l => [l.lineExtension, l.taxAmount, l.roundingAmount, l.priceAmount]), [
    ['8.69', '1.30', '9.99', '4.345'],
    ['27.00', '4.05', '31.05', '10.00'],
  ]);
  assert.deepEqual(r.lines[1].allowance, { amount: '3.00', reason: 'discount' }); // مبلغ فقط بلا Base/Multiplier
});

test('شامل بلا بقية: لا يُكتب PayableRoundingAmount إطلاقاً', () => {
  const r = computeUblAmounts({ pricesIncludeTax: true, invoiceDiscountPct: 0, lines: [{ qty: 1, unitPrice: 115, discountPct: 0, vatPct: 15, category: 'S' }] });
  assert.equal(r.totals.taxExclusive, '100.00');
  assert.equal(r.totals.taxTotal, '15.00');
  assert.equal('payableRounding' in r.totals, false);
  assert.equal(r.lines[0].priceAmount, '100.00');
});

test('الفئات الصفرية في الشامل: الوعاء = الإجمالي والضريبة صفر', () => {
  const r = computeUblAmounts({
    pricesIncludeTax: true, invoiceDiscountPct: 0,
    lines: [{ qty: 3, unitPrice: 7.33, discountPct: 0, vatPct: 0, category: 'E' }, { qty: 1, unitPrice: 2.3, discountPct: 0, vatPct: 15, category: 'S' }],
  });
  assert.deepEqual(r.subtotals.map(s => [s.category, s.taxable, s.tax]), [['E', '21.99', '0.00'], ['S', '2.00', '0.30']]);
  assert.equal(r.totals.payable, '24.29');
});

test('مطابقة المحرّك في تعادل البواقي التامّ: خصم 92% على [1.80، 3.40، 0.30] يوزَّع كما يوزّعه invoiceCalc', () => {
  const lines: AmountLineInput[] = [1.8, 3.4, 0.3].map(p => ({ qty: 1, unitPrice: p, discountPct: 0, vatPct: 15, category: 'S' as VatCategory }));
  const { trace } = computeUblAmountsDetailed({ pricesIncludeTax: false, invoiceDiscountPct: 92, lines });
  const eng = computeInvoiceTotals(lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: 0, taxPct: 15 })), { companyVat: 15, decimals: 2, invoiceDiscountPct: 92 });
  const engineNets = eng.items.map(i => halalasOf(i.lineTotal - i.taxAmt));
  assert.deepEqual(trace.nets.map(Number), engineNets);
  assert.deepEqual(trace.headShares, [165n, 313n, 28n]);
  // التعادل الحقيقي (باقيان 0.6 و0.6): الفهرس وحده كان سيعطي [166، 313، 27] ويخالف المحرّك
  assert.deepEqual(largestRemainder(506n, [180n, 340n, 30n]), [166n, 313n, 27n]);
});

test('قاعدة المحرّك: سعر مشتقّ بقسمة عائمة يُقرَّب على قيمته المقصودة، والسعر المكتوب يحقق الضرب الدقيق', () => {
  // 23917/3 = 7972.333… ؛ × 7.305 = 58237.895 بالضبط (نصف هللة) — تمثيل العائمة يعطي .8949999…
  const q = decFromNumber(7.305), p = decFromNumber(7972.333333333333);
  assert.equal(toHalalas(mulDec(q, p)), 5823789n, 'الضرب الدقيق للتمثيل العشري وحده كان سيخالف المحرّك (58237.90)');
  const line = { qty: 7.305, unitPrice: 7972.333333333333, discountPct: 0, vatPct: 15, category: 'S' as VatCategory };
  const r = computeUblAmounts({ pricesIncludeTax: false, invoiceDiscountPct: 0, lines: [line] });
  const eng = computeInvoiceTotals([{ qty: line.qty, unitPrice: line.unitPrice, discountPct: 0, taxPct: 15 }], { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 });
  assert.equal(r.lines[0].lineExtension, '58237.90');
  assert.equal(amt(r.totals.payable, 'payable'), BigInt(halalasOf(eng.total)));
  const price = dec(r.lines[0].priceAmount);
  assert.ok(price.s <= 8, `السعر يُحلّ عكسياً بخانات مقبولة: ${r.lines[0].priceAmount}`);
  assert.equal(roundHU(7305n * price.u * 100n, p10(3 + price.s)), 5823790n, 'BR-KSA-EN16931-11 بالضرب الدقيق');
});

test('خصم فاتورة على أسعار شاملة مرفوض برمز صريح (422 ZATCA_INCLUSIVE_HEAD_DISCOUNT)', () => {
  assert.throws(
    () => computeUblAmounts({ pricesIncludeTax: true, invoiceDiscountPct: 2, lines: [{ qty: 1, unitPrice: 10, discountPct: 0, vatPct: 15, category: 'S' }] }),
    (e: unknown) => e instanceof ZatcaInputError && e.code === 'INCLUSIVE_HEAD_DISCOUNT' && e.issues[0].field === 'discountPct',
  );
});

test('مدخلات خارج النطاق تُرفض بقائمة حقول عربية لا بخطأ عائم', () => {
  assert.throws(
    () => computeUblAmounts({
      pricesIncludeTax: false, invoiceDiscountPct: 0,
      lines: [
        { qty: -1, unitPrice: 10, discountPct: 0, vatPct: 15, category: 'S' },
        { qty: 1, unitPrice: NaN, discountPct: 120, vatPct: 15, category: 'X' as VatCategory },
      ],
    }),
    (e: unknown) => {
      if (!(e instanceof ZatcaInputError) || e.code !== 'AMOUNT_INPUT') return false;
      assert.deepEqual(e.issues.map(i => i.field).sort(), ['items[0].qty', 'items[1].discountPct', 'items[1].unitPrice', 'items[1].vatCategory'].sort());
      assert.ok(e.issues.every(i => /البند/.test(i.messageAr)));
      return true;
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// مطابقة computeInvoiceTotals على مدخلات عشوائية
// ════════════════════════════════════════════════════════════════════════════

function genQty(r: () => number) {
  const k = r();
  if (k < 0.6) return 1 + Math.floor(r() * 60);
  if (k < 0.8) return (1 + Math.floor(r() * 9999)) / 1000;  // وزن بثلاث خانات
  if (k < 0.95) return (1 + Math.floor(r() * 400)) / 4;
  return 100 + Math.floor(r() * 5000);
}
function genPrice(r: () => number) {
  const k = r();
  if (k < 0.6) return (1 + Math.floor(r() * 300000)) / 100;
  if (k < 0.75) return (1 + Math.floor(r() * 99999)) / 10000;
  if (k < 0.9) return (1 + Math.floor(r() * 30000)) / 100 / 1.15;        // سعر مشتقّ بقسمة عائمة (كتطبيق المندوب)
  return (1 + Math.floor(r() * 90000)) / 3;
}
function genPct(r: () => number) {
  const k = r();
  if (k < 0.55) return 0;
  if (k < 0.85) return 1 + Math.floor(r() * 50);
  if (k < 0.97) return Math.floor(r() * 10000) / 100;
  return 100;
}
function genLines(r: () => number, max: number): AmountLineInput[] {
  return Array.from({ length: 1 + Math.floor(r() * max) }, () => {
    const vat = [15, 15, 15, 5, 0][Math.floor(r() * 5)];
    const category: VatCategory = vat > 0 ? 'S' : (['Z', 'E', 'O'] as VatCategory[])[Math.floor(r() * 3)];
    return { qty: genQty(r), unitPrice: genPrice(r), discountPct: genPct(r), vatPct: vat, category };
  });
}

test('الوضع الحصري = computeInvoiceTotals حرفياً (40,000 فاتورة عشوائية: الإجمالي والضريبة وكل بند)', () => {
  const r = rng(20260914);
  let withHead = 0, multiBucket = 0;
  for (let k = 0; k < 40000; k++) {
    const lines = genLines(r, 10);
    const head = genPct(r) === 100 ? 0 : genPct(r);
    if (head > 0) withHead++;
    if (new Set(lines.map(l => l.vatPct)).size > 1) multiBucket++;
    const eng = computeInvoiceTotals(lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.vatPct })), { companyVat: 15, decimals: 2, invoiceDiscountPct: head, pricesIncludeTax: false });
    const { result, trace } = computeUblAmountsDetailed({ pricesIncludeTax: false, invoiceDiscountPct: head, lines });
    const ctx = () => JSON.stringify({ k, head, lines });
    eq(amt(result.totals.payable, 'payable'), BigInt(halalasOf(eng.total)), ctx);
    eq(amt(result.totals.taxTotal, 'taxTotal'), BigInt(halalasOf(eng.taxAmt)), ctx);
    eq(trace.bases.reduce((s, v) => s + v, 0n), BigInt(halalasOf(eng.subtotal)), ctx);
    eq(amt(result.totals.allowanceTotal, 'allow') + trace.lineDiscounts.reduce((s, v) => s + v, 0n), BigInt(halalasOf(eng.discountAmt)), ctx);
    eng.items.forEach((it, i) => {
      eq(amt(result.lines[i].taxAmount, 'KSA-11'), BigInt(halalasOf(it.taxAmt)), () => `KSA-11 ${ctx()}`);
      eq(trace.lineDiscounts[i], BigInt(halalasOf(it.discountAmt)), ctx);
      eq(trace.nets[i] + trace.lineTaxes[i], BigInt(halalasOf(it.lineTotal)), () => `lineTotal ${ctx()}`);
    });
  }
  assert.ok(withHead > 10000 && multiBucket > 15000, `تغطية: خصم فاتورة ${withHead}، نِسب متعددة ${multiBucket}`);
});

test('الوضع الشامل: ما يدفعه العميل ΣN_i = إجمالي المحرّك حرفياً، والضريبة لا تبتعد عنه أكثر من هللة لكل نسبة (D6)', () => {
  const r = rng(1447);
  let taxDiffers = 0;
  const N = 20000;
  for (let k = 0; k < N; k++) {
    const lines = genLines(r, 8);
    const eng = computeInvoiceTotals(lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.vatPct })), { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
    const { result, trace } = computeUblAmountsDetailed({ pricesIncludeTax: true, invoiceDiscountPct: 0, lines });
    assert.equal(amt(result.totals.payable, 'payable'), BigInt(halalasOf(eng.total)));
    eng.items.forEach((it, i) => assert.equal(trace.nets[i], BigInt(halalasOf(it.lineTotal))));
    const diff = amt(result.totals.taxTotal, 'tax') - BigInt(halalasOf(eng.taxAmt));
    const positiveBuckets = BigInt(trace.buckets.filter(b => b.percent !== '0.00').length);
    assert.ok(diff <= positiveBuckets && -diff <= positiveBuckets, `فرق الضريبة ${diff}`);
    if (diff !== 0n) taxDiffers++;
  }
  assert.ok(taxDiffers > 0 && taxDiffers < N / 2, `فواتير اختلفت ضريبتها عن المحرّك: ${taxDiffers}/${N}`);
});

// ════════════════════════════════════════════════════════════════════════════
// خصائص BR-CO-10..17 · BR-KSA-51 · BR-KSA-EN16931-11 على 200,000 فاتورة عشوائية
// ════════════════════════════════════════════════════════════════════════════

const PCT_KEY: Record<number, string> = { 15: '15.00', 5: '5.00', 0: '0.00' };

function checkRules(input: AmountInput, res: ReturnType<typeof computeUblAmounts>, ctx: () => string) {
  const t = res.totals;
  let sumExt = 0n;
  const netByKey = new Map<string, bigint>();
  input.lines.forEach((l, i) => {
    const line = res.lines[i];
    const ext = amt(line.lineExtension, 'BT-131');
    const tax = amt(line.taxAmount, 'KSA-11');
    eq(amt(line.roundingAmount, 'KSA-12'), ext + tax, () => `BR-KSA-51 ${ctx()}`);
    const q = dec(line.quantity);
    const p = dec(line.priceAmount);
    assert.ok(p.s >= 2 && p.s <= 8, `خانات السعر ${line.priceAmount}`);
    const gross = roundHU(q.u * p.u * 100n, p10(q.s + p.s));
    let allowance = 0n;
    if (line.allowance) {
      allowance = amt(line.allowance.amount, 'BT-136');
      assert.ok(allowance > 0n, 'لا خصم بقيمة صفر');
      assert.equal(line.allowance.baseAmount === undefined, line.allowance.multiplier === undefined, 'BR-KSA-EN16931-04/05');
      if (line.allowance.multiplier !== undefined) {
        const m = dec(line.allowance.multiplier);
        assert.ok(m.s <= 2, 'BR-KSA-DEC-01');
        eq(allowance, roundHU(amt(line.allowance.baseAmount, 'BT-137') * m.u, 100n * p10(m.s)), () => `BR-KSA-EN16931-03 ${ctx()}`);
      }
    }
    eq(gross - allowance, ext, () => `BR-KSA-EN16931-11 ${ctx()}`);
    sumExt += ext;
    const key = `${l.category}|${PCT_KEY[l.vatPct]}`;
    netByKey.set(key, (netByKey.get(key) ?? 0n) + ext);
  });
  const lineExt = amt(t.lineExtension, 'BT-106');
  const allowTotal = amt(t.allowanceTotal, 'BT-107');
  const taxExcl = amt(t.taxExclusive, 'BT-109');
  const taxTotal = amt(t.taxTotal, 'BT-110');
  const taxIncl = amt(t.taxInclusive, 'BT-112');
  const prepaid = amt(t.prepaid, 'BT-113');
  const rounding = t.payableRounding === undefined ? 0n : amt(t.payableRounding, 'BT-114');
  const payable = amt(t.payable, 'BT-115');
  eq(lineExt, sumExt, () => `BR-CO-10 ${ctx()}`);
  const allowByKey = new Map<string, bigint>();
  let sumAllow = 0n;
  for (const a of res.docAllowances) {
    const v = amt(a.amount, 'BT-92');
    assert.ok(v > 0n);
    sumAllow += v;
    const key = `${a.category}|${a.percent}`;
    allowByKey.set(key, (allowByKey.get(key) ?? 0n) + v);
  }
  eq(allowTotal, sumAllow, () => `BR-CO-11 ${ctx()}`);
  eq(taxExcl, lineExt - allowTotal, () => `BR-CO-13 ${ctx()}`);
  let sumTax = 0n;
  const seen = new Set<string>();
  for (const s of res.subtotals) {
    const key = `${s.category}|${s.percent}`;
    assert.ok(!seen.has(key), 'BR-CO-18 تفصيل مكرر');
    seen.add(key);
    const taxable = amt(s.taxable, 'BT-116');
    const tax = amt(s.tax, 'BT-117');
    const pct = dec(s.percent);
    eq(tax, roundHU(taxable * pct.u, 100n * p10(pct.s)), () => `BR-CO-17 ${ctx()}`);
    eq(taxable, (netByKey.get(key) ?? 0n) - (allowByKey.get(key) ?? 0n), () => `BR-S/Z/E/O-08 ${ctx()}`);
    if (s.category !== 'S') assert.equal(tax, 0n);
    sumTax += tax;
  }
  assert.equal(seen.size, netByKey.size, 'تفصيل لكل (فئة، نسبة) مستعملة');
  eq(taxTotal, sumTax, () => `BR-CO-14 ${ctx()}`);
  eq(taxIncl, taxExcl + taxTotal, () => `BR-CO-15 ${ctx()}`);
  assert.equal(prepaid, 0n);
  eq(payable, taxIncl - prepaid + rounding, () => `BR-CO-16 ${ctx()}`);
  assert.equal(res.lines.reduce((s, l) => s + amt(l.taxAmount, 'KSA-11'), 0n), taxTotal, 'Σ KSA-11 = BT-110');
  return { rounding, buckets: seen.size };
}

test('خصائص: 200,000 فاتورة عشوائية (نصفها شامل) تحقق BR-CO-10..17 وBR-KSA-51 وBR-KSA-EN16931-11 حرفياً', () => {
  const r = rng(314159);
  let roundingSeen = 0;
  for (let k = 0; k < 200000; k++) {
    const inclusive = k % 2 === 0;
    const lines = genLines(r, 6);
    const input: AmountInput = { pricesIncludeTax: inclusive, invoiceDiscountPct: inclusive ? 0 : genPct(r), lines };
    const res = computeUblAmounts(input);
    const { rounding } = checkRules(input, res, () => JSON.stringify({ k, input }));
    if (inclusive) {
      // ما يدفعه العميل = إجمالي المحرّك (المرجع الذي يُطبع ويُقيَّد)
      const eng = computeInvoiceTotals(lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.vatPct })), { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
      assert.equal(amt(res.totals.payable, 'BT-115'), BigInt(halalasOf(eng.total)));
      const positive = new Set(lines.filter(l => l.vatPct > 0).map(l => l.vatPct)).size;
      assert.ok(rounding >= 0n && rounding <= BigInt(positive), `BT-114 = ${rounding}`);
      if (rounding > 0n) roundingSeen++;
    } else {
      assert.equal(res.totals.payableRounding, undefined, 'الحصري بلا تقريب');
    }
  }
  assert.ok(roundingSeen > 5000, `حالات BT-114 غير الصفرية: ${roundingSeen}`);
});

// ════════════════════════════════════════════════════════════════════════════
// نقاط قصّ toPrecision(12): ناتج دقيق من 13 رقماً معنوياً آخره 5 — ضجيج العائمة يحسم اتجاه المحرّك
// ════════════════════════════════════════════════════════════════════════════

function modInverse(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  assert.equal(r0, 1n, 'غير قابل للعكس');
  return ((s0 % m) + m) % m;
}

/**
 * b بحيث a×b عدد من 13 رقماً بالضبط وخاناته الـ f الأخيرة «4…95»: ككسر هللة (f خانة) هو 0.4…95 —
 * أقل من النصف، لكن قصّه إلى 12 رقماً معنوياً يعطي 0.5 تماماً. a يجب ألا يقبل القسمة على 2 أو 5.
 */
function tieCofactor(r: () => number, a: bigint, f: number): bigint {
  const m = p10(f);
  const b0 = (BigInt(`4${'9'.repeat(f - 2)}5`) * modInverse(a, m)) % m;
  const lo = (p10(12) + a - 1n) / a, hi = (p10(13) - 1n) / a;
  const kMin = lo > b0 ? (lo - b0 + m - 1n) / m : 0n;
  const kMax = (hi - b0) / m;
  assert.ok(kMax >= kMin);
  const b = b0 + (kMin + BigInt(Math.floor(r() * Number(kMax - kMin + 1n)))) * m;
  assert.equal(String(a * b).length, 13);
  assert.equal((a * b) % m, BigInt(`4${'9'.repeat(f - 2)}5`));
  return b;
}
/** عدد صحيح عشوائي في [lo, hi] لا يقبل القسمة على 2 ولا 5. */
function coprime10(r: () => number, lo: number, hi: number): bigint {
  for (;;) { const v = lo + Math.floor(r() * (hi - lo + 1)); if (v % 2 && v % 5) return BigInt(v); }
}
/** units/10^scale كعدد، مع التحقق أن أقصر تمثيل عشري له هو القيمة المقصودة بالضبط. */
function numOf(units: bigint, scale: number): number {
  const n = Number(units) / 10 ** scale;
  const d = decFromNumber(n);
  assert.equal(d.units * p10(scale - d.scale), units, `تمثيل ${n}`);
  return n;
}

/** مطابقة حرفية للمحرّك + قواعد الهيئة. */
function parityCase(lines: AmountLineInput[], head: number, inclusive: boolean, ctx: () => string) {
  const eng = computeInvoiceTotals(lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.vatPct })), { companyVat: 15, decimals: 2, invoiceDiscountPct: head, pricesIncludeTax: inclusive });
  const input: AmountInput = { pricesIncludeTax: inclusive, invoiceDiscountPct: head, lines };
  const { result, trace } = computeUblAmountsDetailed(input);
  eq(amt(result.totals.payable, 'payable'), BigInt(halalasOf(eng.total)), () => `payable ${ctx()}`);
  if (!inclusive) eq(amt(result.totals.taxTotal, 'tax'), BigInt(halalasOf(eng.taxAmt)), () => `tax ${ctx()}`);
  eng.items.forEach((it, i) => {
    eq(trace.lineDiscounts[i], BigInt(halalasOf(it.discountAmt)), () => `discount ${ctx()}`);
    if (inclusive) {
      eq(trace.nets[i], BigInt(halalasOf(it.lineTotal)), () => `N_i ${ctx()}`);
    } else {
      eq(amt(result.lines[i].taxAmount, 'KSA-11'), BigInt(halalasOf(it.taxAmt)), () => `KSA-11 ${ctx()}`);
      eq(trace.nets[i] + trace.lineTaxes[i], BigInt(halalasOf(it.lineTotal)), () => `lineTotal ${ctx()}`);
    }
  });
  checkRules(input, result, ctx);
  return { eng, result, trace };
}

test('نقاط القصّ الموثّقة: 1.0029 × 10023.9655 و928.617 × 172.5235 وخصم 41.82% = المحرّك في الوضعين، والسعر المُدخل يبقى', () => {
  const line = (qty: number, unitPrice: number, discountPct = 0): AmountLineInput => ({ qty, unitPrice, discountPct, vatPct: 15, category: 'S' });
  // الناتج الدقيق 10053.03499995: المحرّك 10053.03 (نموذج القصّ الدقيق كان يعطي .04 ويعيد كتابة السعر 10023.97)
  const a = parityCase([line(1.0029, 10023.9655)], 0, false, () => 'A');
  assert.equal(a.result.lines[0].lineExtension, '10053.03');
  assert.equal(a.result.totals.payable, '11560.98');
  assert.equal(a.result.lines[0].priceAmount, '10023.9655', 'r2(الكمية × السعر المُدخل) = أساس المحرّك ⇒ لا حلّ عكسي');
  assert.equal(parityCase([line(1.0029, 10023.9655)], 0, true, () => 'A-incl').result.totals.payable, '10053.03');
  const b = parityCase([line(928.617, 172.5235)], 0, false, () => 'B');
  assert.equal(b.result.totals.payable, '184239.49');
  assert.equal(b.result.lines[0].priceAmount, '172.5235');
  assert.equal(parityCase([line(1, 42971672.25, 41.82)], 0, false, () => 'C').result.totals.payable, '28751056.76');
  assert.equal(parityCase([line(1, 42971672.25)], 41.82, false, () => 'D').result.totals.payable, '28751056.76');
});

test('نقاط القصّ المولَّدة: 4,000 نمط (كمية×سعر 4×4 و3×4، خصم بند، خصم فاتورة) = المحرّك حرفياً، والمحرّك يقرّب في الاتجاهين', () => {
  const r = rng(13);
  const S = (qty: number, unitPrice: number, discountPct = 0): AmountLineInput => ({ qty, unitPrice, discountPct, vatPct: 15, category: 'S' });
  const dirs: Record<string, { up: number; down: number }> = {};
  const record = (kind: string, engine: bigint, product: bigint, f: number) => {
    const floor = product / p10(f); // الكسر 0.4…95 أقل من النصف: التقريب الدقيق = الأرضية
    const d = (dirs[kind] ??= { up: 0, down: 0 });
    if (engine === floor + 1n) d.up++; else { assert.equal(engine, floor, kind); d.down++; }
  };
  for (let k = 0; k < 1000; k++) {
    // 4×4: مقياس 8 ⇒ كسر الهللة 6 خانات
    const q4 = coprime10(r, 10001, 99999), p4 = tieCofactor(r, q4, 6);
    const l4 = S(numOf(q4, 4), numOf(p4, 4));
    record('4x4', BigInt(halalasOf(parityCase([l4], 0, false, () => JSON.stringify(l4)).eng.subtotal)), q4 * p4, 6);
    parityCase([l4], 0, true, () => `incl ${JSON.stringify(l4)}`);
    // 3×4: مقياس 7 ⇒ 5 خانات
    const q3 = coprime10(r, 1001, 999999), p3 = tieCofactor(r, q3, 5);
    const l3 = S(numOf(q3, 3), numOf(p3, 4));
    record('3x4', BigInt(halalasOf(parityCase([l3], 0, false, () => JSON.stringify(l3)).eng.subtotal)), q3 * p3, 5);
    parityCase([l3], 0, true, () => `incl ${JSON.stringify(l3)}`);
    // خصم بند بخانتين على أساس بخانتين ⇒ 4 خانات (النسبة ≥ 10% كي يبقى الوعاء × 15 دون 10^12)
    const d = coprime10(r, 1001, 9999), base = tieCofactor(r, d, 4);
    const ld = S(1, numOf(base, 2), numOf(d, 2));
    record('line-discount', BigInt(halalasOf(parityCase([ld], 0, false, () => JSON.stringify(ld)).eng.items[0].discountAmt)), base * d, 4);
    parityCase([ld], 0, true, () => `incl ${JSON.stringify(ld)}`);
    // خصم فاتورة بنفس النمط
    const h = coprime10(r, 1001, 9999), hb = tieCofactor(r, h, 4);
    const lh = S(1, numOf(hb, 2));
    record('head-discount', BigInt(halalasOf(parityCase([lh], numOf(h, 2), false, () => `head ${numOf(h, 2)} ${JSON.stringify(lh)}`).eng.discountAmt)), hb * h, 4);
  }
  // لو قرّب المحرّك دائماً في اتجاه واحد لكفى نموذج دقيق؛ الاتجاهان معاً يثبتان أن القيمة يجب أن تُؤخذ من المحرّك نفسه
  assert.deepEqual(Object.keys(dirs).sort(), ['3x4', '4x4', 'head-discount', 'line-discount']);
  for (const [kind, d] of Object.entries(dirs)) assert.ok(d.up > 50 && d.down > 50, `${kind}: ${JSON.stringify(d)}`);
});

test('ضريبة نسبة يخالف فيها عائمُ المحرّك التقريبَ الدقيق (وعاء × 15 من 13 رقماً) تُرفض ENGINE_ROUNDING_CONFLICT، وإلا تطابق', () => {
  const r = rng(5);
  let conflicts = 0, matches = 0;
  for (let k = 0; k < 3000; k++) {
    // الوعاء ≡ 3 (mod 20) ⇒ الوعاء × 15 ينتهي بـ 45 ⇒ ضريبة بالهللات كسرها .45 وقصّها إلى 12 رقماً .5
    const taxable = BigInt(Math.floor((6.7e10 + r() * 5e9) / 20)) * 20n + 3n;
    assert.equal(String(taxable * 15n).length, 13);
    const line: AmountLineInput = { qty: 1, unitPrice: numOf(taxable, 2), discountPct: 0, vatPct: 15, category: 'S' };
    const eng = computeInvoiceTotals([{ qty: 1, unitPrice: line.unitPrice, discountPct: 0, taxPct: 15 }], { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 });
    if (BigInt(halalasOf(eng.taxAmt)) !== roundHU(taxable * 15n, 100n)) {
      assert.throws(() => computeUblAmounts({ pricesIncludeTax: false, invoiceDiscountPct: 0, lines: [line] }),
        (e: unknown) => e instanceof ZatcaInputError && e.code === 'ENGINE_ROUNDING_CONFLICT' && e.issues[0].rule === 'BR-CO-17');
      conflicts++;
    } else {
      parityCase([line], 0, false, () => JSON.stringify(line));
      matches++;
    }
  }
  assert.ok(conflicts > 100 && matches > 100, `تعارض ${conflicts} ، تطابق ${matches}`);
});

// ════════════════════════════════════════════════════════════════════════════
// الوضع الشامل مع خصم البند: الأساس من الإجمالي قبل الخصم (انحراف موثّق عن الخطوة 4)
// ════════════════════════════════════════════════════════════════════════════

test('شامل بخصم بند: السعر الصافي المكتوب ثابت 86.96 لسلعة 100.00 شاملة أياً كان الخصم (بلا قفزة قرب 100%)', () => {
  for (const d of [0.01, 10, 50, 99.5, 99.9, 99.99, 100]) {
    const l = computeUblAmounts({ pricesIncludeTax: true, invoiceDiscountPct: 0, lines: [{ qty: 1, unitPrice: 100, discountPct: d, vatPct: 15, category: 'S' }] }).lines[0];
    assert.equal(l.priceAmount, '86.96', `d=${d}`);
    assert.ok(l.allowance && l.allowance.baseAmount === undefined && l.allowance.multiplier === undefined, 'مبلغ فقط');
    assert.equal(amt(l.allowance!.amount, 'A') + amt(l.lineExtension, 'BT-131'), 8696n, `d=${d}: السعر − الخصم = BT-131`);
  }
  // خصم بند يُقرَّب إلى صفر هللة ليس خصماً: لا AllowanceCharge
  const tiny = computeUblAmounts({ pricesIncludeTax: true, invoiceDiscountPct: 0, lines: [{ qty: 1, unitPrice: 0.3, discountPct: 1, vatPct: 15, category: 'S' }] });
  assert.equal(tiny.lines[0].allowance, undefined);
});

test('شامل بخصم بند (20,000 فاتورة): r2(الكمية × السعر) = max(r2(G×100/(100+R)), BT-131) وتبعد عن r2(G×100/(100+R)) هللتين على الأكثر', () => {
  const r = rng(271828);
  let discounted = 0;
  for (let k = 0; k < 20000; k++) {
    const lines = genLines(r, 5);
    const input: AmountInput = { pricesIncludeTax: true, invoiceDiscountPct: 0, lines };
    const { result, trace } = computeUblAmountsDetailed(input);
    checkRules(input, result, () => JSON.stringify({ k, lines }));
    lines.forEach((l, i) => {
      if (trace.lineDiscounts[i] === 0n) { assert.equal(result.lines[i].allowance, undefined); return; }
      discounted++;
      const R = BigInt(l.vatPct);
      const g = roundHU(trace.bases[i] * 100n, 100n + R);
      const ext = amt(result.lines[i].lineExtension, 'BT-131');
      const q = dec(result.lines[i].quantity), p = dec(result.lines[i].priceAmount);
      const gross = roundHU(q.u * p.u * 100n, p10(q.s + p.s));
      eq(gross, g > ext ? g : ext, () => `B_i ${JSON.stringify({ k, i, lines })}`);
      assert.ok(gross - g <= 2n, `B − r2(G/(1+R)) = ${gross - g}`);
    });
  }
  assert.ok(discounted > 10000, `بنود بخصم: ${discounted}`);
});
