/**
 * «سجلّ العميل» — اختبارات الدمج النهائي في الواجهة (٢٧ نوفمبر ٢٠٢٦): ما يكتبه الخادم بعد جولة الإصلاح يُقرأ بالعربية بلا رمزٍ خام:
 *   C10 قيد اليومية على حساب العميل: رقمه ورقم قيد عكسه ومرجعه وبيانه وحساباته، و«إعادة إلى مسودة» بعنوانها.
 *   C15 التسويات والقيود بأثرها الموقَّع على الرصيد (+/−) وتسمية «أثر على رصيد العميل» — ومبلغ المستند بلا إشارة.
 *   C9  الحذف النهائي: ما سُحب مع مستندٍ آخر، وعدد ما حُذف مع العميل، ونوع القيد، والمبلغ الذي عاد إلى الفاتورة في التوزيع.
 *   C6  إغلاق دفعٍ موقوف بعد المراجعة بعنوانه، والحالة السابقة بأسمائها (لا رمزٌ مجهول).
 *   C16 زيارةٌ أو نتيجة مندوبٍ ذكي سُجّلت متأخّرةً (backdated): تاريخها الفعلي في التفاصيل؛ والمبلغ الأكبر من العمود (amountOutOfRange).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  actionLabel, allocationsOf, amountOf, amountSign, categoryOf, detailsOf, isBalanceEffect, type ActivityItem,
} from './customerActivity';
import { PHRASES } from '../i18n/strings';
import { formatCurrency } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';

const item = (over: Partial<ActivityItem> & { id: string; action: string }): ActivityItem => ({
  at: '2026-03-01T09:00:00Z', category: categoryOf(over.action), actor: { kind: 'ADMIN', name: 'سارة' }, refType: null, refId: null,
  refNo: null, amount: null, data: null, historical: false, ...over,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const pairs = (it: Parameters<typeof detailsOf>[0], opts: Parameters<typeof detailsOf>[1] = { accountingOn: true }) =>
  detailsOf(it, opts).map((d) => [d.label, d.value]);
const LATIN_CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

test('C10: «إعادة قيد يومية إلى مسودة» و«إغلاق دفع بالبطاقة بعد المراجعة» بعنوانيهما — وغيرهما بعنوان الإجراء', () => {
  assert.equal(actionLabel('LEDGER_JOURNAL_REVERSED', { data: { mode: 'RESET_DRAFT' } }), 'إعادة قيد يومية إلى مسودة');
  assert.equal(actionLabel('LEDGER_JOURNAL_REVERSED', { data: { mode: 'REVERSAL' } }), 'عكس قيد يومية على حساب العميل');
  assert.equal(actionLabel('CARD_PAYMENT_HELD', { data: { closedAfterReview: true } }), 'إغلاق دفع بالبطاقة بعد المراجعة');
  assert.equal(actionLabel('CARD_PAYMENT_HELD', { data: { status: 'review' } }), 'دفع بالبطاقة قيد المراجعة');
  for (const k of ['إعادة قيد يومية إلى مسودة', 'إغلاق دفع بالبطاقة بعد المراجعة']) assert.ok(PHRASES[k]?.zh && PHRASES[k]?.en, k);
});

test('C10: تفاصيل قيد اليومية — رقم القيد إن خالف رقم البند، ورقم قيد العكس، والمرجع والبيان والحسابات؛ وقيد التصحيح بلا رمز فحصه', () => {
  const journal = item({
    id: 'j', action: 'LEDGER_JOURNAL_REVERSED', refNo: 'JV-1', amount: -500,
    data: { kind: 'GL_JOURNAL', moveNo: 'JV-1', reversalNo: 'JV-2', reference: 'عقد ١٢', narration: 'تسوية خصم', accountCodes: ['1103', '4101'], mode: 'REVERSAL' },
  });
  assert.deepEqual(pairs(journal), [['رقم قيد العكس', 'JV-2'], ['المرجع', 'عقد ١٢'], ['البيان', 'تسوية خصم'], ['الحسابات', '1103, 4101']]);
  assert.deepEqual(pairs({ ...journal, refNo: 'X' }).slice(0, 1), [['رقم القيد', 'JV-1']]);
  const control = item({ id: 'c', action: 'LEDGER_JOURNAL_POSTED', refNo: 'JV-3', data: { kind: 'GL_JOURNAL', moveNo: 'JV-3', reference: 'C3', narration: 'قيد تصحيح', controlAdjustment: true, checkKey: 'C3' } });
  assert.deepEqual(pairs(control), [['البيان', 'قيد تصحيح']]);
});

test('C15: التسويات والقيود بأثرها الموقَّع (+ يزيد ما على العميل) وتسمية «أثر على رصيد العميل» — ومبلغ الفاتورة بلا إشارة', async () => {
  assert.ok(['ADJUSTMENT_CREATED', 'ADJUSTMENT_UPDATED', 'OPENING_BALANCE_SET', 'LEDGER_JOURNAL_POSTED', 'LEDGER_JOURNAL_REVERSED'].every(isBalanceEffect));
  assert.equal(isBalanceEffect('INVOICE_ISSUED'), false);
  assert.equal(amountSign({ action: 'ADJUSTMENT_CREATED' }, 200), '+');
  assert.equal(amountSign({ action: 'ADJUSTMENT_CREATED' }, -500), '', 'السالب يحمل إشارته من التنسيق');
  assert.equal(amountSign({ action: 'INVOICE_ISSUED' }, 200), '');
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const html = renderToStaticMarkup(React.createElement(ActivityList, { items: [
    item({ id: 'a', action: 'ADJUSTMENT_CREATED', amount: 200, data: { kind: 'DEBIT' } }),
    item({ id: 'w', action: 'ADJUSTMENT_CREATED', at: '2026-03-01T08:00:00Z', amount: -500, data: { kind: 'BAD_DEBT_WRITEOFF' } }),
    item({ id: 'i', action: 'INVOICE_ISSUED', at: '2026-03-01T07:00:00Z', amount: 300 }),
  ], accountingOn: true }));
  const text = textOf(html);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  assert.equal((text.match(/أثر على رصيد العميل/g) ?? []).length, 2, text);
  const plus = norm(formatCurrency(200)), minus = norm(formatCurrency(-500)), invoice = norm(formatCurrency(300));
  assert.ok(text.includes(`+ ${plus}`) || text.includes(`+${plus}`), `الموجب بإشارة +: ${text}`);
  assert.ok(text.includes(minus) && !text.includes(`+ ${minus}`) && !text.includes(`+${minus}`), `السالب بإشارته وحدها: ${text}`);
  assert.ok(text.includes(invoice) && !text.includes(`+ ${invoice}`) && !text.includes(`+${invoice}`), 'مبلغ المستند بلا إشارة');
  assert.ok(PHRASES['أثر على رصيد العميل']?.zh);
  // المحاسبة مطفأة: لا مبلغ ولا تسمية
  const off = textOf(renderToStaticMarkup(React.createElement(ActivityList, { items: [item({ id: 'a', action: 'ADJUSTMENT_CREATED', amount: 200 })], accountingOn: false })));
  assert.ok(!off.includes('أثر على رصيد العميل') && !off.includes(plus), off);
});

test('C9: الحذف النهائي — «ضمن حذف مستند مرتبط» وعدد ما حُذف مع العميل ونوع القيد بالعربية، والتوزيع يقول أين عاد المبلغ', async () => {
  assert.deepEqual(pairs(item({ id: 'r', action: 'RECEIPT_DELETED', data: { reason: 'OWNER_PURGE', cascade: true, purged: true } })),
    [['الحذف', 'ضمن حذف مستند مرتبط'], ['السبب', 'حذف نهائي بواسطة مالك المنصة']]);
  assert.deepEqual(pairs(item({ id: 'd', action: 'CUSTOMER_DELETED', data: { name: 'بقالة', invoicesDeleted: 3, receiptsDeleted: 2 } })),
    [['اسم العميل', 'بقالة'], ['الفواتير المحذوفة معه', 3], ['السندات المحذوفة معه', 2]]);
  const entry = pairs(item({ id: 'e', action: 'OTHER', data: { reason: 'OWNER_PURGE', newStatus: 'DELETED', entryType: 'ADJUSTMENT_CREDIT' } }));
  assert.ok(entry.some(([l, v]) => l === 'نوع القيد' && v === 'تسوية دائنة'), JSON.stringify(entry));
  assert.ok(!pairs(item({ id: 'x', action: 'OTHER', data: { entryType: 'SOMETHING_NEW' } })).some(([, v]) => v === 'SOMETHING_NEW'), 'رمزٌ مجهول لا يظهر');
  const rd = item({ id: 'rd', action: 'RECEIPT_DELETED', data: { allocations: [{ invoiceNo: 'INV-1', amount: 70, restored: true }, { invoiceNo: 'INV-2', amount: 5 }] } });
  assert.deepEqual(allocationsOf(rd).map((a) => [a.invoiceNo, a.restored]), [['INV-1', true], ['INV-2', false]]);
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const text = textOf(renderToStaticMarkup(React.createElement(ActivityList, { items: [rd], accountingOn: true })));
  assert.equal((text.match(/أعيد مبلغها إلى الفاتورة/g) ?? []).length, 1, text);
  // كل نموذجٍ يحذفه المالك بحدث «أخرى» له عنوانه — المستند المعلّق للفوترة الإلكترونية بلا ذكر الضريبة
  assert.equal(actionLabel('OTHER', { data: { kind: 'OWNER_PURGE', model: 'ZatcaCutoverReview' } }), 'حذف مستند معلق نهائيا');
  for (const k of ['ضمن حذف مستند مرتبط', 'الفواتير المحذوفة معه', 'السندات المحذوفة معه', 'تسوية دائنة', 'أعيد مبلغها إلى الفاتورة', 'الحذف', 'حذف مستند معلق نهائيا']) {
    assert.ok(PHRASES[k]?.zh && PHRASES[k]?.fr && PHRASES[k]?.tr, k);
  }
});

test('C6: الحالة السابقة للعملية بأسمائها (previousStatus/fromStatus) — ولا تتكرّر مع oldStatus، والمجهول لا يظهر', () => {
  assert.deepEqual(pairs(item({ id: 'h', action: 'CARD_PAYMENT_REVERSED', data: { status: 'reversed', fromStatus: 'review' } })).filter(([l]) => l === 'الحالة السابقة'),
    [['الحالة السابقة', 'قيد المراجعة']]);
  assert.deepEqual(pairs(item({ id: 'p', action: 'OTHER', data: { previousStatus: 'paid' } })), [['الحالة السابقة', 'مدفوع']]);
  assert.deepEqual(pairs(item({ id: 'o', action: 'CATALOG_ORDER_UPDATED', data: { oldStatus: 'NEW', previousStatus: 'paid' } })).filter(([l]) => l === 'الحالة السابقة').length, 1);
  assert.deepEqual(pairs(item({ id: 'u', action: 'OTHER', data: { fromStatus: 'weird_state' } })), []);
});

test('لا رمز لاتيني خام في تفاصيل الأحداث الجديدة كما يكتبها الخادم', async () => {
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const text = textOf(renderToStaticMarkup(React.createElement(ActivityList, { items: [
    item({ id: '1', action: 'LEDGER_JOURNAL_REVERSED', refNo: 'JV-1', amount: -10, data: { kind: 'GL_JOURNAL', moveNo: 'JV-1', mode: 'RESET_DRAFT', reason: 'خطأ' } }),
    item({ id: '2', action: 'CARD_PAYMENT_HELD', amount: 90, data: { status: 'failed', closedAfterReview: true, fromStatus: 'review' } }),
    item({ id: '3', action: 'INVOICE_DELETED', amount: 90, data: { reason: 'OWNER_PURGE', status: 'CONFIRMED', cascade: true } }),
  ], accountingOn: true })));
  assert.doesNotMatch(text, LATIN_CODE, text);
  assert.ok(text.includes('إعادة قيد يومية إلى مسودة') && text.includes('إغلاق دفع بالبطاقة بعد المراجعة'), text);
});

test('C16: ما سُجّل متأخّراً (backdated) يذكر تاريخه الفعلي — الزيارة (visitAt) ونتيجة المندوب الذكي (occurredAt) — وغيره لا', async () => {
  const LABEL = 'التاريخ الفعلي (سجل متأخرا)';
  const visitAt = '2026-01-10T07:30:00.000Z';
  const late = item({ id: 'v', action: 'VISIT_RECORDED', data: { visitAt, backdated: true, durationSec: 600 } });
  assert.deepEqual(pairs(late).filter(([l]) => l === LABEL), [[LABEL, visitAt]]);
  const ai = item({ id: 's', action: 'SMART_REP_OUTCOME', data: { via: 'AI_REP', kind: 'NOT_INTERESTED', occurredAt: visitAt, backdated: true } });
  assert.deepEqual(pairs(ai).filter(([l]) => l === LABEL), [[LABEL, visitAt]]);
  // لحظةٌ داخل النافذة (بلا backdated) أو تاريخٌ لا يُقرأ: لا سطر
  assert.ok(!pairs(item({ id: 'n', action: 'VISIT_RECORDED', data: { visitAt } })).some(([l]) => l === LABEL));
  assert.ok(!pairs(item({ id: 'b', action: 'VISIT_RECORDED', data: { visitAt: 'not-a-date', backdated: true } })).some(([l]) => l === LABEL));
  const p = PHRASES[LABEL];
  assert.ok(p?.en && p?.fr && p?.tr && p?.zh, LABEL);
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const text = textOf(renderToStaticMarkup(React.createElement(ActivityList, { items: [late], accountingOn: false })));
  assert.ok(text.includes(LABEL) && text.includes('يناير') && /2026|٢٠٢٦/.test(text), `التاريخ الفعلي ميلاديّاً: ${text}`);
  assert.doesNotMatch(text, /1447|١٤٤٧/, 'تقويمٌ هجري');
});

test('المبلغ الأكبر من عمود السجلّ: يُقرأ من data.amountOutOfRange نصّاً — وamount الحاضر مقدَّم عليه', () => {
  assert.equal(amountOf({ amount: null, data: { amountOutOfRange: '123456789012345.5' } }), 123456789012345.5);
  assert.equal(amountOf({ amount: 10, data: { amountOutOfRange: '99' } }), 10);
  assert.equal(amountOf({ amount: null, data: { amountOutOfRange: 'x' } }), null);
});
