// رسالة «رابط المشتري» في واتساب (ثغرة G2 — ٤ نوفمبر ٢٠٢٦): كانت تقول «فاتورتكم الضريبية» و«نسخة معتمدة من هيئة الزكاة والضريبة
// والجمارك» لكلّ مستند — حتى الإشعار الدائن، وحتى المبسّطة التي أُبلغت ولم تُعتمد. يُحرَس هنا:
//   ١) «معتمدة» للقياسية المعتمدة وحدها، وعبارة «مبلغة» نفسها التي تعرضها صفحة المشتري للمبسّطة المُبلَّغة.
//   ٢) المرحلة الأولى وما لا مرآة نهائية له: لا ادّعاء باسم الهيئة إطلاقاً.
//   ٣) العنوان من «نصوص المطبوعات» (inv.title / inv.returnTitle / inv.debitTitle)، وبلا نصوص عنوان قرار الطباعة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareMessageOf, shareStatusNote, parsePublicDoc } from './shareView';
import { shareMessageTitle, sharePhase2DecidedTitle } from './shareTitle';

const LINK = 'https://fieldsa.net/e/tok';
const CLEARED = 'معتمدة';
const AUTHORITY = /الهيئة|هيئة الزكاة/;

const texts = (edits: Record<string, { text: string | null; alt: string | null; hidden: boolean }>) => ({
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits,
});

test('القياسية المعتمدة: عبارة الاعتماد كما كانت حرفاً', () => {
  const m = shareMessageOf({ number: 'INV-1', title: 'فاتورة ضريبية', mirror: 'cleared', phase: 2 }, LINK);
  assert.equal(m, `فاتورة ضريبية رقم INV-1\nنسخة معتمدة من هيئة الزكاة والضريبة والجمارك:\n${LINK}`);
  const w = shareMessageOf({ number: 'INV-1', title: 'فاتورة ضريبية', mirror: 'cleared_warn' }, LINK);
  assert.ok(w.includes(CLEARED));
});

test('المبسّطة المُبلَّغة: لا «معتمدة» — وعبارة الإبلاغ هي عبارة صفحة المشتري نفسها', () => {
  for (const mirror of ['reported', 'reported_warn'] as const) {
    const m = shareMessageOf({ number: 'INV-2', title: 'فاتورة ضريبية مبسطة', mirror }, LINK);
    assert.equal(m.includes(CLEARED), false, mirror);
    assert.equal(m.includes('اعتمد'), false, mirror);
    const doc = parsePublicDoc({ document: { kind: 'INVOICE', subtype: '02', uuid: 'u-1', status: mirror } });
    assert.ok(doc);
    assert.ok(m.includes(shareStatusNote(doc!).label), mirror);
    assert.ok(m.startsWith('فاتورة ضريبية مبسطة رقم INV-2'), mirror);
    assert.ok(m.endsWith(LINK));
  }
});

test('المرحلة الأولى وما لا مرآة نهائية له: لا ادّعاء باسم الهيئة', () => {
  const cases = [
    shareMessageOf({ number: 'INV-3' }, LINK),
    shareMessageOf({ number: 'INV-3', sellerName: 'شركة', mirror: null }, LINK),
    shareMessageOf({ number: 'INV-3', mirror: 'cleared', phase: 1 }, LINK),
    shareMessageOf({ number: 'INV-3', mirror: 'pending' }, LINK),
    shareMessageOf({ number: 'INV-3', mirror: 'rejected', phase: 2 }, LINK),
  ];
  for (const m of cases) {
    assert.equal(AUTHORITY.test(m), false, m);
    assert.equal(m.includes(CLEARED), false, m);
    assert.ok(m.includes('INV-3'));
    assert.ok(m.endsWith(LINK));
    assert.equal(m.includes('undefined') || m.includes('null'), false);
  }
});

test('الإشعار الدائن والمدين: عنوانهما لا «فاتورتكم الضريبية»', () => {
  const credit = shareMessageTitle({ documentKind: 'CREDIT_NOTE', subtype: '02', mirror: 'reported' }, null);
  assert.equal(credit, 'إشعار دائن');
  const m = shareMessageOf({ number: 'CN-1', title: credit, mirror: 'reported' }, LINK);
  assert.ok(m.startsWith('إشعار دائن رقم CN-1'));
  assert.equal(m.includes('فاتورتكم'), false);
  assert.equal(m.includes(CLEARED), false);
  // مرتجعٌ بلا documentKind (صفّ قديم) ⇒ إشعار دائن أيضاً
  assert.equal(shareMessageTitle({ isReturn: true, mirror: 'cleared' }, null), 'إشعار دائن');
  assert.equal(shareMessageTitle({ documentKind: 'DEBIT_NOTE', mirror: 'cleared' }, null), 'إشعار مدين');
});

test('بلا نصوص: عنوان قرار الطباعة — والقياسية/المبسّطة من subtype أو من المرآة', () => {
  assert.equal(shareMessageTitle({ documentKind: 'INVOICE', subtype: '01', mirror: 'cleared' }, null), 'فاتورة ضريبية');
  assert.equal(shareMessageTitle({ documentKind: 'INVOICE', subtype: '02', mirror: 'reported' }, null), 'فاتورة ضريبية مبسطة');
  assert.equal(shareMessageTitle({ mirror: 'cleared_warn' }, null), 'فاتورة ضريبية');
  assert.equal(shareMessageTitle({ mirror: 'reported_warn' }, undefined), 'فاتورة ضريبية مبسطة');
  // لا يُعرف المستند ⇒ null فتبقى الرسالة بعنوانها العامّ
  assert.equal(sharePhase2DecidedTitle({}), null);
  assert.equal(shareMessageTitle({}, null), null);
  // إعدادٌ معطوب يُعامل كشركةٍ بلا نصوص
  assert.equal(shareMessageTitle({ subtype: '02' }, { version: 99 }), 'فاتورة ضريبية مبسطة');
});

test('صياغة الشركة للعنوان تظهر في الرسالة (inv.title / inv.returnTitle / inv.debitTitle)', () => {
  const pt = texts({
    'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false },
    'inv.returnTitle': { text: 'إشعار مرتجع', alt: null, hidden: false },
    'inv.debitTitle': { text: 'إشعار إضافة', alt: null, hidden: false },
  });
  const t = shareMessageTitle({ documentKind: 'INVOICE', subtype: '02', mirror: 'reported' }, pt);
  assert.equal(t, 'فاتورة مبيعات');
  const m = shareMessageOf({ number: 'INV-5', title: t, mirror: 'reported' }, LINK);
  assert.ok(m.startsWith('فاتورة مبيعات رقم INV-5'));
  assert.equal(shareMessageTitle({ documentKind: 'CREDIT_NOTE', mirror: 'cleared' }, pt), 'إشعار مرتجع');
  assert.equal(shareMessageTitle({ documentKind: 'DEBIT_NOTE', mirror: 'cleared' }, pt), 'إشعار إضافة');
  // عنوانٌ حذفته الشركة من الورقة: الرسالة تبقى بعنوان القرار (لا رسالة بلا اسم مستند)
  const hidden = texts({ 'inv.title': { text: null, alt: null, hidden: true } });
  assert.equal(shareMessageTitle({ subtype: '01', mirror: 'cleared' }, hidden), 'فاتورة ضريبية');
});

test('رسالةٌ بلا رقم ولا عنوان لا تكتب undefined ولا null', () => {
  const m = shareMessageOf({ number: null, title: null, mirror: 'reported' }, LINK);
  assert.equal(m.includes('undefined') || m.includes('null'), false);
  assert.ok(m.endsWith(LINK));
  const t = shareMessageOf({ number: null, title: 'إشعار دائن', mirror: 'cleared' }, LINK);
  assert.ok(t.startsWith('إشعار دائن\n'));
});
