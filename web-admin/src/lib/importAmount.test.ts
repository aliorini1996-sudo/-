import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parsePercent, columnDecimalStyle, currencyDecimalFallback } from './importAmount';

const v = (raw: unknown) => {
  const r = parseAmount(raw);
  assert.ok(r.ok, `متوقع قبول ${String(raw)}`);
  return r.value;
};
const bad = (raw: unknown) => {
  const r = parseAmount(raw);
  assert.equal(r.ok, false, `متوقع رفض ${String(raw)}`);
  return r;
};

test('parseAmount: الأرقام العربية لا تصير صفراً (البند 1)', () => {
  assert.equal(v('١٥٠٠'), 1500);
  assert.equal(v('۱۲۵'), 125);
  assert.equal(v(5), 5);
  assert.equal(v(-2.5), -2.5);
});

test('parseAmount: الفارغ والشرطة ⇒ undefined، وغير المفهوم خطأ بقيمته لا صفر', () => {
  for (const x of [null, undefined, '', '  ', '-', '—', '–']) assert.equal(v(x), undefined);
  assert.deepEqual(bad('N/A'), { ok: false, raw: 'N/A' });
  bad('abc'); bad('12abc'); bad(NaN); bad(Infinity); bad('ر.س'); bad('--5'); bad('(-5)'); bad('5 مدين دائن');
});

test('parseAmount: السالب المحاسبي (x) وx- و−x ودائن/Cr، ومدين/Dr موجب', () => {
  assert.equal(v('(1,500.00)'), -1500);
  assert.equal(v('1500 دائن'), -1500);
  assert.equal(v('−1500'), -1500);
  assert.equal(v('500-'), -500);
  assert.equal(v('-500'), -500);
  assert.equal(v('1,200 Cr'), -1200);
  assert.equal(v('CR 30'), -30);
  assert.equal(v('700 مدين'), 700);
  assert.equal(v('700 Dr'), 700);
});

test('parseAmount: الفواصل العربية والملتبسة', () => {
  assert.equal(v('1٬500٫50'), 1500.5);
  assert.equal(v('12,5'), 12.5);
  assert.equal(v('12,50'), 12.5);
  assert.equal(v('1,234'), 1234);
  assert.equal(v('1,234,567.89'), 1234567.89);
  assert.equal(v('1.234,56'), 1234.56);
  assert.equal(v('1.234.567'), 1234567);
  assert.equal(v('12.5'), 12.5);
  assert.equal(v('1 500'), 1500);
  assert.equal(v('1 500 000'), 1500000);
  bad('1,2345');
  bad('0,123');
  // التجميع الهندي «1,23,456» مقبول (الدفعة 2، البند 6/و)؛ المجموعات غير المنتظمة مرفوضة
  assert.equal(v('1,23,456'), 123456);
  bad('1,2,3456');
  bad('12,3,456');
  bad('1.23.456');
  bad('1,234.5.6');
});

test('parseAmount: رموز العملة كلمةً كاملة', () => {
  assert.equal(v('ر.س 12'), 12);
  assert.equal(v('12 ر.س.'), 12);
  assert.equal(v('SAR 1,250.00'), 1250);
  assert.equal(v('1250 sar'), 1250);
  assert.equal(v('$99'), 99);
  assert.equal(v('99 ريال'), 99);
  assert.equal(v('﷼ 10'), 10);
  assert.equal(v('10 د.إ'), 10);
  assert.equal(v('(1,000.00) SAR'), -1000);
});

test('parsePercent: «15%» ⇒ 15، و«٪» العربية، والنص غير المفهوم خطأ', () => {
  assert.deepEqual(parsePercent('15%'), { ok: true, value: 15 });
  assert.deepEqual(parsePercent('١٥٪'), { ok: true, value: 15 });
  assert.deepEqual(parsePercent(0.15), { ok: true, value: 0.15 });
  assert.deepEqual(parsePercent(''), { ok: true, value: undefined });
  // اسم المعفاة بلا رقم ⇒ 0 (الدفعة 2، البند 4)، والنص غير المفهوم خطأ
  assert.deepEqual(parsePercent('معفى'), { ok: true, value: 0 });
  assert.equal(parsePercent('ضريبة ما').ok, false);
});

test('parseAmount: «1.500» ملتبسة خطأ صف ما لم يحسمها العمود، و«٬» بمجموعات ثلاثية فقط (مراجعة ثانية للبند 1)', () => {
  const amb = parseAmount('1.500');
  assert.deepEqual(amb, { ok: false, raw: '1.500', reason: 'ambiguous' });
  assert.equal(parseAmount('1,500').ok, true); // القاعدة القائمة: 1,234 = 1234
  // سياق العمود
  assert.equal(columnDecimalStyle(['1.500', '1.500.000']), ',');
  assert.equal(columnDecimalStyle(['1.500', '2.750,00']), ',');
  assert.equal(columnDecimalStyle(['1.500', '12.25']), '.');
  assert.equal(columnDecimalStyle(['1.500', '12.25', '1.500.000']), undefined);
  assert.equal(columnDecimalStyle([1500, '1.500']), undefined);
  assert.deepEqual(parseAmount('1.500', ','), { ok: true, value: 1500 });
  assert.deepEqual(parseAmount('1.500', '.'), { ok: true, value: 1.5 });
  assert.deepEqual(parseAmount('2.750,00', ','), { ok: true, value: 2750 });
  assert.deepEqual(parseAmount('12,5', ','), { ok: true, value: 12.5 });
  assert.deepEqual(parseAmount('0.500'), { ok: true, value: 0.5 });
  assert.deepEqual(parseAmount('1234.500'), { ok: true, value: 1234.5 });
  // «٬» آلاف بمجموعات صحيحة فقط
  bad('15٬00'); bad('1٬5'); bad('1٬500,5');
  assert.equal(v('1٬500'), 1500);
  assert.equal(v('1٬500٬000٫25'), 1500000.25);
});

test('parseAmount: عبارات العملة الكاملة وCr. وDr. والصيغة العلمية ورموز ISO (مراجعة ثانية للبند 1)', () => {
  assert.equal(v('1500 ريال سعودي'), 1500);
  assert.equal(v('1500 ريال'), 1500);
  assert.equal(v('20 درهم إماراتي'), 20);
  assert.equal(v('1500 Cr.'), -1500);
  assert.equal(v('700 Dr.'), 700);
  assert.equal(v('1.5E+3'), 1500);
  assert.equal(v('2e-2'), 0.02);
  assert.equal(v('EUR 10'), 10);
  assert.equal(v('10 CHF'), 10);
  // القائم يبقى
  assert.equal(v('ر.س 12'), 12);
  assert.equal(v('SAR 1,250.00'), 1250);
  assert.equal(v('(1,500.00)'), -1500);
  assert.equal(v('1,234'), 1234);
  assert.equal(v('12,5'), 12.5);
  bad('abc'); bad('NIL'); bad('12abc'); bad('10CHFX');
});

test('parsePercent: اسم ضريبة برقم واحد ملاصق لعلامة النسبة (مراجعة ثانية للبند 14)', () => {
  assert.deepEqual(parsePercent('VAT 15%'), { ok: true, value: 15 });
  assert.deepEqual(parsePercent('15% S'), { ok: true, value: 15 });
  assert.deepEqual(parsePercent('ضريبة القيمة المضافة ١٥٪'), { ok: true, value: 15 });
  assert.equal(parsePercent('5% + 15%').ok, false);
  assert.equal(parsePercent('VAT15').ok, false);
  // رقم واحد فقط بعلامة نسبة يحسم ولو جاورته سنة (الدفعة 2، البند 4)
  assert.deepEqual(parsePercent('VAT 2023 15%'), { ok: true, value: 15 });
});

// ═══ دفعة الإصلاحات 2 (الانحدار 6 والبند 1) ═══
test('parseAmount: صيغ كان المحلل القديم يقبلها — اختصارات عملة وبادئة Excel ونقطة ختامية وتجميع هندي', () => {
  const cases: [string, number][] = [
    ['1500 KD', 1500], ['KD 1,500.000', 1500], ['1500 BD', 1500], ['RO 1500', 1500], ['QR 1500', 1500], ['Dh 1500', 1500],
    ['Dhs. 1,500', 1500], ['1500 JD', 1500], ['1500 LE', 1500], ['1500 L.E', 1500], ['1500 SR.', 1500], ['1500.', 1500],
    ["'1500", 1500], ['= 1500', 1500], ['="1500"', 1500], ['1,50,000', 150000], ['12,34,567.50', 1234567.5], ['(1,50,000)', -150000],
  ];
  for (const [raw, want] of cases) assert.equal(v(raw), want, raw);
  // القائم لا يتغير
  for (const [raw, want] of [['1,500.00', 1500], ['SAR 1,500', 1500], ['(1,500)', -1500], ['1500-', -1500], ['١٬٥٠٠٫٥٠', 1500.5], ['1 500', 1500],
    ['1.500,00', 1500], ['12,5', 12.5], ['SR1500', 1500], ['1.5E+3', 1500], ['AED1,500', 1500], ['1500 د.ك', 1500]] as [string, number][]) {
    assert.equal(v(raw), want, raw);
  }
  // كلمات لاتينية ليست عملة ما زالت خطأ، والتجميع غير المنتظم خطأ
  bad('1500 KDXY'); bad('Kdx 1500'); bad('ABCD 1500'); bad('1,5,00'); bad('1500..');
});

test('parseAmount: «٫» العربي صريح لا يلتبس ولا يتأثر بنمط العمود', () => {
  assert.deepEqual(parseAmount('١٫٥٠٠'), { ok: true, value: 1.5 });
  assert.deepEqual(parseAmount('١٫٥٠٠', ','), { ok: true, value: 1.5 });
  assert.deepEqual(parseAmount('1٫500', '.'), { ok: true, value: 1.5 });
  assert.deepEqual(parseAmount('١٬٢٣٤٫٥'), { ok: true, value: 1234.5 });
  assert.equal(columnDecimalStyle(['١٫٥٠٠', '1.500.000']), ',');
  assert.equal(parseAmount('1٫5٫0').ok, false);
  assert.equal(parseAmount('٫').ok, false);
});

test('parseAmount/columnDecimalStyle: منازل الدينار الثلاث — رمز الخلية ثم افتراض عملة الشركة', () => {
  assert.deepEqual(parseAmount('12.500 KWD'), { ok: true, value: 12.5 });
  assert.deepEqual(parseAmount('12.500 د.ك'), { ok: true, value: 12.5 });
  assert.deepEqual(parseAmount('OMR 150.750'), { ok: true, value: 150.75 });
  assert.equal(parseAmount('12.500').ok, false);
  assert.equal(columnDecimalStyle(['12.500', '150.750']), undefined);
  assert.equal(columnDecimalStyle(['12.500', '150.750'], '.'), '.');
  assert.equal(columnDecimalStyle(['1.500', '1.500.000'], '.'), ',');
  assert.equal(columnDecimalStyle(['1.500', '12.25', '1.500.000'], '.'), undefined); // التعارض لا يُحسم بالافتراض
  assert.equal(currencyDecimalFallback(3), '.');
  assert.equal(currencyDecimalFallback(2), undefined);
  assert.equal(currencyDecimalFallback(null), undefined);
});

test('parsePercent: أسماء المعفاة والصفرية بلا رقم ⇒ 0، ورقم واحد بعلامة نسبة يحسم', () => {
  for (const t of ['Exempt', 'معفى', 'معفاة', 'Zero Rated', 'zero-rated', 'خاضعة للصفر', 'VAT Exempt', 'ضريبة صفرية', 'E', 'Z']) {
    assert.deepEqual(parsePercent(t), { ok: true, value: 0 }, t);
  }
  assert.deepEqual(parsePercent('VAT 5% 2018'), { ok: true, value: 5 });
  for (const t of ['S', 'Standard', 'Exempt 2', 'VAT']) assert.equal(parsePercent(t).ok, false, t);
});
