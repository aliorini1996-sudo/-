// فوترة ZATCA المرحلة الثانية (Z5.6b) — جدول قرار الطباعة: النظام × حالة المستند ⇒ ما يُطبع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zatcaDocView, type ZatcaDocView } from './docStatus';
import { DELIVERY_NOTE_TITLE, phase1Title, REHEARSAL_WATERMARK, zatcaPrintDecision } from './docPrint';

const ISSUED = '2026-09-23T06:00:00.000Z';
const NOW = new Date('2026-09-23T12:00:00.000Z');

const view = (mirror: string, subtype: string, extra: Record<string, unknown> = {}): ZatcaDocView => {
  const v = zatcaDocView({ zatcaPhase: 2, einvoiceStatus: mirror, invoiceSubtype: subtype, issuedAt: ISSUED, einvoiceQr: 'STAMPED-QR', ...extra }, NOW);
  assert.ok(v, `${subtype}/${mirror}`);
  return v;
};

test('المرحلة الأولى: عناوين اليوم حرفاً بحرف، ورمزٌ مبنيّ محلياً، وتفصيل ضريبة', () => {
  assert.equal(phase1Title({ isReturn: true }), 'إشعار دائن مرتجع');
  assert.equal(phase1Title({ saudi: false }), 'فاتورة');
  assert.equal(phase1Title({ saudi: true, buyerHasTaxNumber: false }), 'فاتورة ضريبية مبسطة');
  assert.equal(phase1Title({ saudi: true, buyerHasTaxNumber: true }), 'فاتورة ضريبية');
  // المرتجع يسبق الدولة كما في القالب اليوم
  assert.equal(phase1Title({ isReturn: true, saudi: false }), 'إشعار دائن مرتجع');

  for (const z of [null, undefined]) {
    const d = zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, z);
    assert.equal(d.phase, 1);
    assert.equal(d.kind, 'phase1');
    assert.equal(d.title, 'فاتورة ضريبية');
    assert.equal(d.qr.source, 'phase1');
    assert.equal(d.showTaxBreakdown, true);
    assert.equal(d.printable, true);
    assert.equal(d.canPrint, true);
    assert.equal(d.notice, null);
    assert.equal(d.watermark, null);
    assert.equal(d.shareLabel, 'مشاركة / حفظ PDF');
    assert.equal(d.confirmText, 'تم الإصدار بنجاح');
  }
});

test('جدول القرار للمرحلة الثانية', () => {
  type Row = [string, string, string, string, string];
  // [النوع، المرآة، النوع الناتج، مصدر الرمز، العنوان]
  const table: Row[] = [
    ['02', 'signed', 'tax', 'stamped', 'فاتورة ضريبية مبسطة'],
    ['02', 'report_blocked', 'tax', 'stamped', 'فاتورة ضريبية مبسطة'],
    ['02', 'reported', 'tax', 'stamped', 'فاتورة ضريبية مبسطة'],
    ['02', 'reported_warn', 'tax', 'stamped', 'فاتورة ضريبية مبسطة'],
    ['02', 'rejected', 'void', 'none', 'مستند ملغى — لا يعتمد للخصم الضريبي'],
    ['02', 'withdrawn', 'void', 'none', 'مستند ملغى — لا يعتمد للخصم الضريبي'],
    ['01', 'cleared', 'tax', 'stamped', 'فاتورة ضريبية'],
    ['01', 'cleared_warn', 'tax', 'stamped', 'فاتورة ضريبية'],
    ['01', 'reported', 'tax', 'stamped', 'فاتورة ضريبية'],
    ['01', 'clearance_pending', 'deliveryNote', 'none', DELIVERY_NOTE_TITLE],
    ['01', 'clearance_blocked', 'deliveryNote', 'none', DELIVERY_NOTE_TITLE],
    ['01', 'cleared_no_xml', 'deliveryNote', 'none', DELIVERY_NOTE_TITLE],
    ['01', 'rejected', 'void', 'none', 'مستند ملغى — لا يعتمد للخصم الضريبي'],
    ['01', 'withdrawn', 'void', 'none', 'مستند ملغى — لا يعتمد للخصم الضريبي'],
  ];
  for (const [subtype, mirror, kind, qrSource, title] of table) {
    const d = zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: subtype === '01' }, view(mirror, subtype));
    assert.equal(d.phase, 2, `${subtype}/${mirror}`);
    assert.equal(d.kind, kind, `${subtype}/${mirror} النوع`);
    assert.equal(d.qr.source, qrSource, `${subtype}/${mirror} مصدر الرمز`);
    assert.equal(d.title, title, `${subtype}/${mirror} العنوان`);
    // لا مسار يعيد رمز المرحلة الأولى لصفّ مرحلة ثانية — وهو أصل نقد الخطة 6
    assert.notEqual(d.qr.source, 'phase1', `${subtype}/${mirror} بنى رمز المرحلة الأولى`);
    // الضريبة تُفصَّل على المستند الضريبي وحده
    assert.equal(d.showTaxBreakdown, kind === 'tax', `${subtype}/${mirror} تفصيل الضريبة`);
    assert.equal(d.printable, kind === 'tax', `${subtype}/${mirror} قابلية التسليم`);
  }
});

test('الرمز المختوم يصل كما هو من الخادم، ولا رمز مع سند التسليم ولا مع المُبطل', () => {
  const ok = zatcaPrintDecision({ saudi: true }, view('reported', '02'));
  assert.equal(ok.qr.value, 'STAMPED-QR');
  assert.equal(ok.qr.caption, 'رمز الاستجابة السريعة للفاتورة الضريبية');
  const b2b = zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, view('cleared', '01'));
  assert.equal(b2b.qr.caption, 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك');
  for (const d of [
    zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, view('clearance_pending', '01')),
    zatcaPrintDecision({ saudi: true }, view('rejected', '02')),
  ]) {
    assert.equal(d.qr.value, null);
    assert.equal(d.qr.caption, null);
  }
  // مستند قابل للطباعة بلا رمز (ردّ ناقص): لا يُبنى بديل محليّ
  const noQr = zatcaPrintDecision({ saudi: true }, { ...view('reported', '02'), qr: null });
  assert.equal(noQr.qr.source, 'none');
});

test('سند التسليم (قرار المالك D5): ورقةٌ تُطبع بلا ضريبة ولا رمز، ونصّها يقول إنها ليست فاتورة', () => {
  const d = zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, view('clearance_pending', '01'));
  assert.equal(d.canPrint, true, 'البضاعة خرجت ولا بدّ من ورقة');
  assert.equal(d.printable, false);
  assert.equal(d.showTaxBreakdown, false);
  assert.match(d.title, /ليست فاتورة ضريبية/);
  assert.equal(d.shareLabel, 'مشاركة / حفظ سند التسليم');
  assert.ok(d.notice && d.notice.length > 0);
  // «اعتُمدت بلا نسخة معتمدة» سببها مختلف فنصّها مختلف
  const noXml = zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, view('cleared_no_xml', '01'));
  assert.notEqual(noXml.notice, d.notice);
});

test('المُبطل والمعلَّق: لا ورقة أصلاً', () => {
  for (const d of [
    zatcaPrintDecision({ saudi: true }, view('rejected', '02')),
    zatcaPrintDecision({ saudi: true }, view('withdrawn', '01')),
    // إشعار دائن قياسيّ لم يُعتمد: لا سند تسليم له (لا بضاعة تُسلَّم بإشعار)
    zatcaPrintDecision({ saudi: true }, view('clearance_pending', '01', { documentKind: 'CREDIT_NOTE' })),
  ]) {
    assert.equal(d.canPrint, false);
    assert.equal(d.printable, false);
    assert.equal(d.qr.source, 'none');
    assert.ok(d.notice);
  }
});

test('الإشعارات: عناوينها من documentKind لا من النوع', () => {
  assert.equal(zatcaPrintDecision({ saudi: true }, view('reported', '02', { documentKind: 'CREDIT_NOTE' })).title, 'إشعار دائن');
  assert.equal(zatcaPrintDecision({ saudi: true }, view('reported', '02', { documentKind: 'DEBIT_NOTE' })).title, 'إشعار مدين');
  assert.equal(zatcaPrintDecision({ saudi: true }, view('cleared', '01', { documentKind: 'CREDIT_NOTE' })).title, 'إشعار دائن');
});

test('وضع البروفة يُوسم على كل مستند من بيئة المحاكاة', () => {
  const rehearsal = (mirror: string, subtype: string) => zatcaPrintDecision(
    { saudi: true },
    view(mirror, subtype, { einvoice: { phase: 2, mode: 'rehearsal', status: mirror, subtype } }),
  );
  assert.equal(rehearsal('reported', '02').watermark, REHEARSAL_WATERMARK);
  assert.equal(rehearsal('clearance_pending', '01').watermark, REHEARSAL_WATERMARK);
  assert.equal(rehearsal('rejected', '02').watermark, REHEARSAL_WATERMARK);
  // الإنتاج بلا وسم
  assert.equal(zatcaPrintDecision({ saudi: true }, view('reported', '02')).watermark, null);
});

test('تصنيف الورقة (سعر الوحدة قبل الضريبة) من الخادم لا من رقم المشتري الضريبي', () => {
  // مشترٍ «منشأة» بلا رقم ضريبي: الخادم يصنّفه 01 (classifySubtype) فالورقة قياسية ولو خمّن القالب خلاف ذلك
  const std = zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: false }, view('cleared', '01'));
  assert.equal(std.title, 'فاتورة ضريبية');
  assert.equal(std.standardLayout, true, 'عنوانٌ قياسيّ وجسمٌ مبسّط — مستندٌ يخالف عنوانه');
  // ومشترٍ له رقم ضريبيّ صنّفه الخادم مبسّطاً: العبرة بالخادم
  assert.equal(zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, view('reported', '02')).standardLayout, false);
  // والمرحلة الأولى كما اليوم: من رقم المشتري وحده
  assert.equal(zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: true }, null).standardLayout, true);
  assert.equal(zatcaPrintDecision({ saudi: true, buyerHasTaxNumber: false }, null).standardLayout, false);
});

test('«معتمد من الهيئة» لا يُكتب إلا تحت رمزٍ اعتمدته الهيئة', () => {
  const caption = (mirror: string, subtype: string) => zatcaPrintDecision({ saudi: true }, view(mirror, subtype)).qr.caption;
  assert.equal(caption('cleared', '01'), 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك');
  assert.equal(caption('cleared_warn', '01'), 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك');
  // قياسيةٌ أُبلغ عنها بعد إيقاف الاعتماد (٣٠٣): الرمز ختمنا لا رمز الهيئة — فلا ادّعاءَ اعتماد
  assert.equal(caption('reported', '01'), 'رمز الاستجابة السريعة للفاتورة الضريبية');
  assert.equal(caption('reported_warn', '01'), 'رمز الاستجابة السريعة للفاتورة الضريبية');
  assert.equal(caption('reported', '02'), 'رمز الاستجابة السريعة للفاتورة الضريبية');
});
