// فوترة ZATCA المرحلة الثانية (Z5.6b) — قراءة حالة المستند في العميل: نقيّة فتُختبر بلا رسم ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrintableMirror, isReportOverdue, isZatcaPhase2Row, REPORT_WINDOW_MS, zatcaChipOf, zatcaDocView, zatcaRowActions,
  zatcaStatusChip, ZATCA_MIRROR_STATUSES, type ZatcaMirrorStatus,
} from './docStatus';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ISSUED = new Date('2026-09-23T06:00:00.000Z').toISOString();

test('صفّ المرحلة الأولى: كلّ شيء null — لا شارة ولا عرض ولا إجراء', () => {
  for (const row of [null, undefined, {}, { zatcaPhase: 1 }, { zatcaPhase: null, einvoiceStatus: 'generated' }]) {
    assert.equal(isZatcaPhase2Row(row), false, JSON.stringify(row));
    assert.equal(zatcaDocView(row, NOW), null, JSON.stringify(row));
    assert.equal(zatcaStatusChip(row, NOW), null, JSON.stringify(row));
    assert.deepEqual(zatcaRowActions(row, { allowed: true }), { retry: false, withdraw: false, reissue: false });
  }
  // حتى «einvoice» من مزوّد آخر (مصر/بيبول) لا يجعل الصفّ مرحلةً ثانية
  assert.equal(zatcaDocView({ einvoice: { phase: 1 } }, NOW), null);
});

test('isPrintableMirror نسخةٌ مطابقة لقاعدة الخادم: المبسّطة عدا المُبطلة، والقياسية بعد الاعتماد أو الإبلاغ', () => {
  const want02: Record<ZatcaMirrorStatus, boolean> = {
    signed: true, report_blocked: true, reported: true, reported_warn: true,
    clearance_pending: false, clearance_blocked: false, cleared: false, cleared_warn: false, cleared_no_xml: false,
    rejected: false, withdrawn: false,
  };
  const want01: Record<ZatcaMirrorStatus, boolean> = {
    cleared: true, cleared_warn: true, reported: true, reported_warn: true,
    signed: false, clearance_pending: false, clearance_blocked: false, report_blocked: false, cleared_no_xml: false,
    rejected: false, withdrawn: false,
  };
  for (const m of ZATCA_MIRROR_STATUSES) {
    assert.equal(isPrintableMirror(m, '02'), want02[m], `02/${m}`);
    assert.equal(isPrintableMirror(m, '01'), want01[m], `01/${m}`);
  }
  for (const bad of [null, undefined, '', 'generated', 'pending', 'CLEARED']) {
    assert.equal(isPrintableMirror(bad as string, '02'), false, String(bad));
    assert.equal(isPrintableMirror(bad as string, '01'), false, String(bad));
  }
});

test('«متأخرة» للمبسّطة غير النهائية وحدها وبعد ٢٤ ساعة — والقياسية بلا مهلة', () => {
  const late = new Date(Date.parse(ISSUED) + REPORT_WINDOW_MS + 1000);
  const early = new Date(Date.parse(ISSUED) + REPORT_WINDOW_MS - 1000);
  assert.equal(isReportOverdue({ subtype: '02', mirror: 'signed', issuedAt: ISSUED }, late), true);
  assert.equal(isReportOverdue({ subtype: '02', mirror: 'report_blocked', issuedAt: ISSUED }, late), true);
  assert.equal(isReportOverdue({ subtype: '02', mirror: 'signed', issuedAt: ISSUED }, early), false);
  assert.equal(isReportOverdue({ subtype: '02', mirror: 'reported', issuedAt: ISSUED }, late), false, 'نهائية لا تتأخّر');
  assert.equal(isReportOverdue({ subtype: '01', mirror: 'clearance_pending', issuedAt: ISSUED }, late), false, 'القياسية بلا مهلة إبلاغ');
  assert.equal(isReportOverdue({ subtype: '02', mirror: 'signed', issuedAt: null }, late), false, 'بلا تاريخ إصدار لا حكم');
  assert.equal(isReportOverdue({ subtype: null, mirror: 'signed', issuedAt: ISSUED }, late), false);
});

test('عرض صفّ القائمة يُبنى من أعمدة المرآة وحدها (لا einvoice في القائمة)', () => {
  const v = zatcaDocView({ zatcaPhase: 2, einvoiceStatus: 'signed', invoiceSubtype: '02', documentKind: 'INVOICE', issuedAt: ISSUED, einvoiceQr: 'QR' }, NOW);
  assert.ok(v);
  assert.deepEqual(
    { mirror: v.mirror, subtype: v.subtype, printable: v.printable, qr: v.qr, overdue: v.overdue, documentStatus: v.documentStatus, mode: v.mode },
    { mirror: 'signed', subtype: '02', printable: true, qr: 'QR', overdue: false, documentStatus: null, mode: 'live' },
  );
});

test('einvoice من الخادم مقدَّم على أعمدة الصفّ، ورمز مستندٍ غير قابل للطباعة لا يُمرَّر', () => {
  const v = zatcaDocView({
    zatcaPhase: 2, einvoiceStatus: 'signed', invoiceSubtype: '02', einvoiceQr: 'OLD', issuedAt: ISSUED,
    einvoice: { phase: 2, mode: 'rehearsal', status: 'reported', documentStatus: 'REPORTED', subtype: '02', qr: 'NEW', printable: true, overdue: false, icv: 7, uuid: 'u-1', warnings: [{ code: 'W' }] },
  }, NOW);
  assert.ok(v);
  assert.equal(v.mirror, 'reported');
  assert.equal(v.qr, 'NEW');
  assert.equal(v.mode, 'rehearsal');
  assert.equal(v.icv, 7);
  assert.equal(v.warnings, 1);

  // القياسية «بانتظار الاعتماد» يصل رمزها null من الخادم؛ ولو وصل بخطأ لا يُمرَّر (حزام ثانٍ)
  const pending = zatcaDocView({ zatcaPhase: 2, einvoiceStatus: 'clearance_pending', invoiceSubtype: '01', einvoiceQr: 'LEAKED', issuedAt: ISSUED }, NOW);
  assert.equal(pending?.printable, false);
  assert.equal(pending?.qr, null, 'رمز قياسية لم تُعتمد وصل إلى الطباعة');
});

test('الشارة: نصّ وشرح ولون لكلّ مرآة، والمُبطلة تسبق كلّ شيء', () => {
  const chipFor = (einvoiceStatus: string, invoiceSubtype: string, extra: Record<string, unknown> = {}) =>
    zatcaStatusChip({ zatcaPhase: 2, einvoiceStatus, invoiceSubtype, issuedAt: ISSUED, ...extra }, NOW);

  assert.equal(chipFor('clearance_pending', '01')?.key, 'clearance_pending');
  assert.equal(chipFor('clearance_pending', '01')?.tone, 'pending');
  assert.equal(chipFor('cleared', '01')?.tone, 'ok');
  assert.equal(chipFor('cleared_warn', '01')?.tone, 'warn');
  assert.equal(chipFor('cleared_no_xml', '01')?.tone, 'warn');
  assert.equal(chipFor('reported', '02')?.tone, 'ok');
  assert.equal(chipFor('report_blocked', '02')?.tone, 'danger');
  assert.equal(chipFor('clearance_blocked', '01')?.tone, 'danger');
  assert.equal(chipFor('rejected', '02')?.tone, 'danger');
  assert.equal(chipFor('withdrawn', '01')?.tone, 'muted');
  assert.equal(chipFor('signed', '02')?.key, 'signed');

  // كلّ مرآة تُنتج شارةً بنصّين غير فارغين — لا حالة صامتة
  for (const m of ZATCA_MIRROR_STATUSES) {
    for (const st of ['01', '02'] as const) {
      const c = chipFor(m, st);
      assert.ok(c && c.label.length > 0 && c.hint.length > 0, `${st}/${m}`);
    }
  }
  // مرآة غائبة (إسقاط ناقص) لا تُسكت الشارة
  assert.equal(zatcaStatusChip({ zatcaPhase: 2 }, NOW)?.key, 'phase2');
});

test('الشارة: حالة المستند الجارية تُقدَّم على المرآة، والتأخّر يسبقها', () => {
  const late = new Date(Date.parse(ISSUED) + REPORT_WINDOW_MS + 1000);
  const row = (documentStatus: string) => ({
    zatcaPhase: 2, invoiceSubtype: '02', issuedAt: ISSUED,
    einvoice: { phase: 2, status: 'signed', subtype: '02', documentStatus, printable: true, overdue: false },
  });
  assert.equal(zatcaStatusChip(row('SUBMITTING'), NOW)?.key, 'submitting');
  assert.equal(zatcaStatusChip(row('RETRY_WAIT'), NOW)?.key, 'retry_wait');
  assert.equal(zatcaStatusChip(row('SIGNED'), NOW)?.key, 'signed');
  // التأخّر أخطر من «إعادة المحاولة مجدولة»: ٢٤ ساعة مخالفةٌ مؤكّدة
  const overdue = zatcaChipOf({ ...zatcaDocView({ zatcaPhase: 2, einvoiceStatus: 'signed', invoiceSubtype: '02', issuedAt: ISSUED }, late)!, documentStatus: 'RETRY_WAIT' });
  assert.equal(overdue.key, 'overdue');
});

test('الإجراءات: للمصرَّح له وحده، وبشرط الخادم لا أوسع منه', () => {
  const row = (einvoiceStatus: string, invoiceSubtype: string, documentStatus?: string) => ({
    zatcaPhase: 2, einvoiceStatus, invoiceSubtype, issuedAt: ISSUED,
    ...(documentStatus ? { einvoice: { phase: 2, status: einvoiceStatus, subtype: invoiceSubtype, documentStatus } } : {}),
  });
  const none = { retry: false, withdraw: false, reissue: false };

  // المندوب (غير مصرَّح) لا يرى شيئاً ولو كانت الحالة تسمح
  assert.deepEqual(zatcaRowActions(row('clearance_blocked', '01'), { allowed: false }), none);

  assert.deepEqual(zatcaRowActions(row('report_blocked', '02'), { allowed: true }), { retry: true, withdraw: false, reissue: false });
  assert.deepEqual(zatcaRowActions(row('clearance_blocked', '01'), { allowed: true }), { retry: true, withdraw: true, reissue: false });
  assert.deepEqual(zatcaRowActions(row('clearance_pending', '01'), { allowed: true }), { retry: false, withdraw: true, reissue: false });
  assert.deepEqual(zatcaRowActions(row('rejected', '02'), { allowed: true }), { retry: false, withdraw: false, reissue: true });
  // القياسية المرفوضة أُبطلت تلقائياً: لا إعادة إصدار من هنا (الخادم يرفضها)
  assert.deepEqual(zatcaRowActions(row('rejected', '01'), { allowed: true }), none);
  // مبسّطة سليمة أو معتمدة: لا إجراء
  assert.deepEqual(zatcaRowActions(row('signed', '02'), { allowed: true }), none, 'signed يحتمل «قيد الإرسال» فلا زرّ من القائمة');
  assert.deepEqual(zatcaRowActions(row('reported', '02'), { allowed: true }), none);
  assert.deepEqual(zatcaRowActions(row('cleared', '01'), { allowed: true }), none);
  // حالة المستند من التفصيل تفتح الإعادة لـRETRY_WAIT
  assert.equal(zatcaRowActions(row('signed', '02', 'RETRY_WAIT'), { allowed: true }).retry, true);
  assert.equal(zatcaRowActions(row('signed', '02', 'SUBMITTING'), { allowed: true }).retry, false);
});

test('القياسية المحوَّلة إلى الإبلاغ (ردّ ٣٠٣) تُقرأ متأخّرة — لا «بانتظار اعتماد الهيئة»', () => {
  const NOW2 = new Date('2026-09-23T12:00:00.000Z');
  const old = new Date(NOW2.getTime() - 26 * 60 * 60 * 1000).toISOString();
  // الخادم يقولها في التفصيل: overdue محسوبةٌ من reportDeadline والمرآة تبقى clearance_pending
  const fromServer = zatcaDocView({
    zatcaPhase: 2, einvoiceStatus: 'clearance_pending', invoiceSubtype: '01', issuedAt: old,
    einvoice: { phase: 2, status: 'clearance_pending', subtype: '01', overdue: true, printable: false },
  }, NOW2);
  assert.ok(fromServer);
  assert.equal(fromServer.overdue, true);
  assert.equal(zatcaChipOf(fromServer).key, 'overdue', 'الشارة تقرأ المرآة وتتجاهل حكم الخادم بالتأخّر');

  // ومن مهلةٍ على الصفّ (متى أعادها الخادم) بلا حاجةٍ إلى النوع '02'
  const byDeadline = isReportOverdue(
    { subtype: '01', mirror: 'clearance_pending', issuedAt: old, reportDeadline: new Date(NOW2.getTime() - 1000).toISOString() },
    NOW2,
  );
  assert.equal(byDeadline, true);
  // مهلةٌ لم تحلّ بعد: لا تأخّر
  assert.equal(isReportOverdue(
    { subtype: '01', mirror: 'clearance_pending', issuedAt: old, reportDeadline: new Date(NOW2.getTime() + 1000).toISOString() },
    NOW2,
  ), false);
  // ومحسومةٌ لا مهلة عليها مهما قدُمت مهلتها
  assert.equal(isReportOverdue(
    { subtype: '01', mirror: 'cleared', issuedAt: old, reportDeadline: old },
    NOW2,
  ), false);
  // وبلا مهلة: القياسية في مسار الاعتماد بلا تأخّر كما اليوم، والمبسّطة تُحسب من إصدارها
  assert.equal(isReportOverdue({ subtype: '01', mirror: 'clearance_pending', issuedAt: old }, NOW2), false);
  assert.equal(isReportOverdue({ subtype: '02', mirror: 'signed', issuedAt: old }, NOW2), true);
});

test('المُبطلة تسبق التأخّر في الشارة — لا «تأخر الإبلاغ» على مستندٍ أُبطل', () => {
  const NOW2 = new Date('2026-09-23T12:00:00.000Z');
  for (const mirror of ['rejected', 'withdrawn'] as const) {
    const v = zatcaDocView({
      zatcaPhase: 2, einvoiceStatus: mirror, invoiceSubtype: '02',
      issuedAt: new Date(NOW2.getTime() - 40 * 60 * 60 * 1000).toISOString(),
      einvoice: { phase: 2, status: mirror, subtype: '02', overdue: true },
    }, NOW2);
    assert.ok(v);
    assert.equal(zatcaChipOf(v).key, mirror);
  }
});

test('المتأخّر يُفتح له زرّ إعادة الإرسال ولو كانت مرآته «بانتظار»', () => {
  const NOW2 = new Date('2026-09-23T12:00:00.000Z');
  const late = { zatcaPhase: 2, einvoiceStatus: 'signed', invoiceSubtype: '02', documentKind: 'INVOICE', issuedAt: new Date(NOW2.getTime() - 26 * 60 * 60 * 1000).toISOString() };
  assert.equal(zatcaRowActions(late, { allowed: true }).retry, true);
  // والمعلّق في مهلته يبقى بلا زرّ (يُردّ 409 بلا فائدة)
  const fresh = { ...late, issuedAt: new Date(NOW2.getTime() - 60_000).toISOString() };
  assert.equal(zatcaRowActions(fresh, { allowed: true }).retry, false);
  // والصلاحية أوّلاً
  assert.equal(zatcaRowActions(late, { allowed: false }).retry, false);
});
