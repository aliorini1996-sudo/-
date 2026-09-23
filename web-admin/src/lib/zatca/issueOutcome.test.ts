// فوترة ZATCA المرحلة الثانية (Z5.6c) — قراءة ردّ الإصدار (201 / 202 / 426) بلا رسم ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isZatcaOutdatedClient, zatcaIssueOutcome, zatcaReloadForUpdate, ZATCA_OUTDATED_CODE,
} from './issueOutcome';

const FALLBACK = 'رسالة احتياطية';

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 'inv-9', number: 'INV-9', zatcaPhase: 2, invoiceSubtype: '01', documentKind: 'INVOICE',
  einvoiceStatus: 'clearance_pending', issuedAt: '2026-09-23T09:00:00.000Z', ...over,
});

test('201 ⇒ تُطبع كما اليوم (لا قرار جديد هنا)', () => {
  assert.deepEqual(zatcaIssueOutcome({ status: 201, data: { data: pendingRow() } }, FALLBACK), { kind: 'issued' });
});

test('202 لقياسية لم تُعتمد ⇒ سند تسليم من الصفّ المرفق ورسالة الخادم', () => {
  const res = { status: 202, data: { code: 'ZATCA_CLEARANCE_PENDING', message: 'بانتظار اعتماد الهيئة', data: pendingRow() } };
  const out = zatcaIssueOutcome(res, FALLBACK);
  assert.equal(out.kind, 'deliveryNote');
  if (out.kind !== 'deliveryNote') return;
  assert.equal(out.message, 'بانتظار اعتماد الهيئة');
  assert.equal(out.view.printable, false);
  assert.equal(out.view.qr, null, 'رمزٌ مختوم على ورقة غير معتمدة');
  assert.equal((out.row as { number: string }).number, 'INV-9');
  // اعتمدت الهيئة ولم تصل نسختها: سند تسليم أيضاً (U8)
  const noXml = zatcaIssueOutcome({ status: 202, data: { data: pendingRow({ einvoiceStatus: 'cleared_no_xml' }) } }, FALLBACK);
  assert.equal(noXml.kind, 'deliveryNote');
});

test('202 بلا ورقةٍ مشروعة ⇒ رسالة وحدها: مستند مُبطل، أو إشعار معلّق، أو صفّ ناقص، أو مرحلة أولى', () => {
  const cases: Array<[string, unknown]> = [
    ['مُبطل', pendingRow({ einvoiceStatus: 'rejected' })],
    ['إشعار دائن معلّق', pendingRow({ documentKind: 'CREDIT_NOTE' })],
    ['بلا رقم', pendingRow({ number: '' })],
    ['مرحلة أولى', { id: 'x', number: 'A', zatcaPhase: 1 }],
    ['بلا صفّ', undefined],
    ['صفّ ليس كائناً', [1, 2]],
  ];
  for (const [label, data] of cases) {
    const out = zatcaIssueOutcome({ status: 202, data: { message: 'رسالة الخادم', data } }, FALLBACK);
    assert.equal(out.kind, 'halt', label);
    if (out.kind === 'halt') assert.equal(out.message, 'رسالة الخادم', label);
  }
  // بلا رسالة خادم يُستعمل النصّ المترجَم الذي يمرّره المستدعي
  const out = zatcaIssueOutcome({ status: 202, data: { data: null } }, FALLBACK);
  assert.deepEqual(out, { kind: 'halt', message: FALLBACK });
  assert.deepEqual(zatcaIssueOutcome(null, FALLBACK), { kind: 'halt', message: FALLBACK });
});

test('426 يُعرف بالرمز وبالحالة معاً، وغيره لا', () => {
  assert.equal(isZatcaOutdatedClient({ response: { status: 426, data: { code: ZATCA_OUTDATED_CODE } } }), true);
  assert.equal(isZatcaOutdatedClient({ response: { status: 426, data: null } }), true, 'وسيطٌ ابتلع الجسم');
  assert.equal(isZatcaOutdatedClient({ response: { status: 200, data: { code: ZATCA_OUTDATED_CODE } } }), true);
  for (const bad of [null, undefined, {}, 'err', { response: { status: 409, data: { code: 'ZATCA_REJECTED' } } }]) {
    assert.equal(isZatcaOutdatedClient(bad), false, JSON.stringify(bad));
  }
});

test('زرّ التحديث: يُلغي تسجيل عامل الخدمة ثمّ يعيد التحميل — ويعيد التحميل ولو فشل الإلغاء', async () => {
  const order: string[] = [];
  await zatcaReloadForUpdate({
    sw: { getRegistrations: async () => [{ unregister: async () => { order.push('unregister'); return true; } }] },
    reload: () => order.push('reload'),
  });
  assert.deepEqual(order, ['unregister', 'reload']);

  const only: string[] = [];
  await zatcaReloadForUpdate({ sw: { getRegistrations: async () => { throw new Error('no sw'); } }, reload: () => only.push('reload') });
  assert.deepEqual(only, ['reload']);

  const none: string[] = [];
  await zatcaReloadForUpdate({ sw: null, reload: () => none.push('reload') });
  assert.deepEqual(none, ['reload']);
});
