// فوترة ZATCA المرحلة الثانية (Z5.6c) — منطق شاشة متابعة المستندات: نقيّ فيُختبر بلا رسم ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MESSAGE_CHARS, STALL_MS, ZATCA_QUEUE_BUCKETS, zatcaActionConfirm, zatcaDocMessages, zatcaLastMessage,
  zatcaQueueAlerts, zatcaQueueBucket, zatcaQueueCounts, zatcaQueueFilterRows, zatcaQueueRows,
} from './docQueue';
import { zatcaDocView, ZATCA_MIRROR_STATUSES, type ZatcaMirrorStatus } from './docStatus';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', number: 'INV-1', zatcaPhase: 2, invoiceSubtype: '02', documentKind: 'INVOICE',
  einvoiceStatus: 'signed', issuedAt: ago(60_000), total: 115, customer: { name: 'بقالة الأمل' },
  salesRep: { name: 'سعد' }, ...over,
});

const viewOf = (over: Record<string, unknown> = {}) => {
  const v = zatcaDocView(row(over), NOW);
  assert.ok(v, 'عرضٌ فارغ لصفّ مرحلة ثانية');
  return v;
};

test('الدلو لكلّ مرآة: المُبطلة ثمّ تجاوز المهلة ثمّ ما يحتاج تدخّلاً ثمّ المحسومة', () => {
  const want: Record<ZatcaMirrorStatus, string> = {
    signed: 'pending', clearance_pending: 'pending',
    report_blocked: 'blocked', clearance_blocked: 'blocked', cleared_no_xml: 'blocked',
    reported: 'done', reported_warn: 'done', cleared: 'done', cleared_warn: 'done',
    rejected: 'rejected', withdrawn: 'rejected',
  };
  for (const m of ZATCA_MIRROR_STATUSES) {
    const subtype = m.startsWith('clear') ? '01' : '02';
    assert.equal(zatcaQueueBucket(viewOf({ einvoiceStatus: m, invoiceSubtype: subtype })), want[m], m);
  }
  // تجاوز المهلة يسبق «تحتاج تدخّلاً»: المخالفة النظامية أعجل من سببها
  const overdue = viewOf({ einvoiceStatus: 'report_blocked', issuedAt: ago(25 * 60 * 60 * 1000) });
  assert.equal(overdue.overdue, true);
  assert.equal(zatcaQueueBucket(overdue), 'overdue');
  // كلّ دلوٍ معلن مُنتَجٌ فعلاً (لا دلو ميّت في المرشِّحات)
  const produced = new Set(ZATCA_MIRROR_STATUSES.map(m => zatcaQueueBucket(viewOf({ einvoiceStatus: m, invoiceSubtype: m.startsWith('clear') ? '01' : '02' }))));
  produced.add('overdue');
  assert.deepEqual([...ZATCA_QUEUE_BUCKETS].sort(), [...produced].sort());
});

test('صفوف المرحلة الأولى تسقط من الطابور كلّه', () => {
  const rows = zatcaQueueRows([
    { id: 'a', number: 'A', zatcaPhase: 1, einvoiceStatus: 'generated' },
    null, 'nope', { id: 'b' },
    row({ id: 'c', number: 'C' }),
  ], { allowed: true, now: NOW });
  assert.deepEqual(rows.map(r => r.id), ['c']);
  assert.equal(rows[0].customerName, 'بقالة الأمل');
  assert.equal(rows[0].repName, 'سعد');
  assert.equal(rows[0].total, 115);
});

test('الترتيب: الأعجل دلواً ثمّ الأقدم إصداراً داخل الدلو', () => {
  const rows = zatcaQueueRows([
    row({ id: 'done', einvoiceStatus: 'reported' }),
    row({ id: 'pending-new', issuedAt: ago(60_000) }),
    row({ id: 'blocked', einvoiceStatus: 'report_blocked' }),
    row({ id: 'pending-old', issuedAt: ago(20 * 60_000) }),
    row({ id: 'overdue', issuedAt: ago(30 * 60 * 60 * 1000) }),
    row({ id: 'rejected', einvoiceStatus: 'rejected' }),
  ], { allowed: false, now: NOW });
  assert.deepEqual(rows.map(r => r.id), ['overdue', 'blocked', 'pending-old', 'pending-new', 'rejected', 'done']);
});

test('«تأخّر الإرسال» يُحسب من الوقت لا يُدّعى من عمودٍ لا يصل العميل', () => {
  const fresh = zatcaQueueRows([row({ id: 'fresh', issuedAt: ago(STALL_MS - 1000) })], { allowed: false, now: NOW });
  const stale = zatcaQueueRows([row({ id: 'stale', issuedAt: ago(STALL_MS + 1000) })], { allowed: false, now: NOW });
  assert.equal(fresh[0].stalled, false);
  assert.equal(stale[0].stalled, true);
  // والمحسوم لا يُوصف بالتأخّر مهما قدُم
  const old = zatcaQueueRows([row({ id: 'old', einvoiceStatus: 'reported', issuedAt: ago(90 * 60_000) })], { allowed: false, now: NOW });
  assert.equal(old[0].stalled, false);
});

test('العدادات والمرشِّح والتنبيهات — ولا تنبيه بعدد صفر', () => {
  const rows = zatcaQueueRows([
    row({ id: '1' }),
    row({ id: '2', issuedAt: ago(STALL_MS + 1000) }),
    row({ id: '3', einvoiceStatus: 'report_blocked' }),
    row({ id: '4', issuedAt: ago(26 * 60 * 60 * 1000) }),
    row({ id: '5', einvoiceStatus: 'rejected' }),
    row({ id: '6', einvoiceStatus: 'reported' }),
  ], { allowed: false, now: NOW });
  const c = zatcaQueueCounts(rows);
  assert.deepEqual(c, { all: 6, stalled: 1, noXml: 0, pending: 2, overdue: 1, blocked: 1, rejected: 1, done: 1 });
  assert.deepEqual(zatcaQueueFilterRows(rows, 'blocked').map(r => r.id), ['3']);
  assert.equal(zatcaQueueFilterRows(rows, 'all').length, 6);
  assert.deepEqual(zatcaQueueAlerts(rows).map(a => [a.key, a.count, a.tone]), [
    ['overdue', 1, 'danger'], ['blocked', 1, 'danger'], ['stalled', 1, 'warning'], ['rejected', 1, 'warning'],
  ]);
  assert.deepEqual(zatcaQueueAlerts(zatcaQueueRows([row({ einvoiceStatus: 'reported' })], { allowed: false, now: NOW })), []);
});

test('«اعتمدت بلا نسخة معتمدة» تنبيهٌ مستقلّ لا «أعد الإرسال» — والخادم لا يقبل عليها إعادة', () => {
  const rows = zatcaQueueRows([
    row({ id: 'noxml', invoiceSubtype: '01', einvoiceStatus: 'cleared_no_xml' }),
    row({ id: 'blocked', einvoiceStatus: 'report_blocked' }),
  ], { allowed: true, now: NOW });
  const c = zatcaQueueCounts(rows);
  assert.equal(c.blocked, 2, 'كلاهما في دلو «تحتاج تدخّلاً»');
  assert.equal(c.noXml, 1);
  const alerts = zatcaQueueAlerts(rows);
  // تنبيه التوقّف يعدّ المتوقّف وحده، ولـ«بلا نسخة معتمدة» تنبيهها ونصّها
  assert.deepEqual(alerts.map(a => [a.key, a.count]), [['blocked', 1], ['noXml', 1]]);
  assert.ok(!alerts.find(a => a.key === 'noXml')!.body.includes('أعد الإرسال'));
  // ولا زرّ إعادةٍ عليها أصلاً (حالةٌ نهائية عند الخادم)
  assert.equal(rows.find(r => r.id === 'noxml')!.actions.retry, false);
  assert.equal(rows.find(r => r.id === 'blocked')!.actions.retry, true);
});

test('المتأخّر عن المهلة يُعرض له زرّ إعادة الإرسال — وإلا أمرَ التنبيهُ بما لا سبيل إليه', () => {
  const [late] = zatcaQueueRows([row({ id: 'late', issuedAt: ago(26 * 60 * 60 * 1000) })], { allowed: true, now: NOW });
  assert.equal(late.bucket, 'overdue');
  assert.equal(late.view.mirror, 'signed', 'المرآة تبقى كما هي — التأخّر محسوب لا مخزَّن');
  assert.equal(late.actions.retry, true);
  // والصلاحية تسبق كلّ شيء: المندوب لا يرى زرّاً يُردّ عليه 403
  assert.equal(zatcaQueueRows([row({ id: 'late', issuedAt: ago(26 * 60 * 60 * 1000) })], { allowed: false, now: NOW })[0].actions.retry, false);
});

test('رسائل الهيئة: تُقرأ نصّاً ومصفوفة، ويُقدَّم الخطأ، وتُنقّى وتُقصّ', () => {
  const raw = JSON.stringify([
    { type: 'WARNING', code: 'W1', message: 'تنبيه' },
    { type: 'ERROR', code: 'E1', message: 'رفض الحقل' },
  ]);
  assert.deepEqual(zatcaDocMessages(raw).map(m => m.kind), ['warning', 'error']);
  assert.deepEqual(zatcaLastMessage(raw), { kind: 'error', code: 'E1', text: 'رفض الحقل' });
  // مصفوفة مباشرة (من التفصيل) كالنصّ
  assert.deepEqual(zatcaLastMessage([{ type: 'WARNING', code: 'W9', message: 'ملاحظة' }]), { kind: 'warning', code: 'W9', text: 'ملاحظة' });
  // مدخلات فاسدة لا ترمي ولا تُظهر شيئاً
  for (const bad of [null, undefined, '', '{{', '"نصّ"', 42, [{}], [{ message: '   ' }]]) {
    assert.deepEqual(zatcaDocMessages(bad), [], JSON.stringify(bad));
    assert.equal(zatcaLastMessage(bad), null, JSON.stringify(bad));
  }
  // نصّ خارجيّ: بلا محارف تحكّم وبطولٍ محدود
  const dirty = zatcaLastMessage([{ type: 'ERROR', code: 'E2', message: `سطر\u0000أول\nثانٍ${'ط'.repeat(400)}` }]);
  assert.ok(dirty);
  assert.equal(dirty.text.length, MAX_MESSAGE_CHARS);
  assert.ok(!/[\u0000-\u001F]/.test(dirty.text));
});

test('الإجراءات تتبع صلاحية المستخدم، والسحب وحده يستلزم كتابة كلمة', () => {
  const blocked = row({ einvoiceStatus: 'clearance_blocked', invoiceSubtype: '01' });
  assert.deepEqual(zatcaQueueRows([blocked], { allowed: false, now: NOW })[0].actions, { retry: false, withdraw: false, reissue: false });
  assert.deepEqual(zatcaQueueRows([blocked], { allowed: true, now: NOW })[0].actions, { retry: true, withdraw: true, reissue: false });

  assert.equal(zatcaActionConfirm('withdraw').typed, 'سحب');
  assert.equal(zatcaActionConfirm('withdraw').danger, true);
  for (const k of ['retry', 'reissue'] as const) {
    assert.equal(zatcaActionConfirm(k).typed, null, k);
    assert.equal(zatcaActionConfirm(k).danger, false, k);
    assert.ok(zatcaActionConfirm(k).title && zatcaActionConfirm(k).body, k);
  }
});
