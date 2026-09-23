// اختبارات Z5.0 لآلة حالات المستند ومرآة الفاتورة (status.ts): كل نتيجة ⇒ حالة، عدّادا التصعيد لسببيهما وحدهما، الجدولة
// وسقف Retry-After، إيقاف الاعتماد ومهلته (نقد الخطة 10)، المطالبة، المرآة والرمز والطباعة والتأخر، وتأكيد 401 (نقد الخطة 18).
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_FLIGHT_DOCUMENT_STATUSES as ONBOARDING_IN_FLIGHT } from './onboarding';
import type { Msg, Outcome, RetryReason } from './responses';
import {
  BACKOFF_STEADY_MS, DOCUMENT_STATUSES, FINAL_DOCUMENT_STATUSES, INVOICE_MIRROR_STATUSES, IN_FLIGHT_DOCUMENT_STATUSES, REPORT_WINDOW_MS,
  RETRY_AFTER_CAP_MS, authFailureConfirmed, flowForSubtype, isClaimable, isOverdue, isPrintableMirror, manualRetryWrite, mirrorQrOf,
  mirrorStatusOf, reportDeadlineFor, retryDelayMs, subtypeOfTypeName, transitionForOutcome, type DocumentStatus, type OutcomeContext,
} from './status';

const NOW = new Date('2026-12-01T09:00:00.000Z');
const ISSUED = new Date('2026-12-01T08:30:00.000Z');
const msg = (type: Msg['type'], message: string): Msg => ({ type, code: 'C', category: null, message, status: null });

function ctx(over: Partial<OutcomeContext> = {}): OutcomeContext {
  return { flow: 'REPORTING', attempts: 1, priorEmpty400: 0, priorPayload413: 0, issuedAt: ISSUED, reportDeadline: new Date(ISSUED.getTime() + REPORT_WINDOW_MS), now: NOW, ...over };
}

test('الحالات الجارية = IN_FLIGHT_DOCUMENT_STATUSES من onboarding حرفياً، وكلها من القائمة', () => {
  assert.equal(IN_FLIGHT_DOCUMENT_STATUSES, ONBOARDING_IN_FLIGHT);
  assert.deepEqual([...IN_FLIGHT_DOCUMENT_STATUSES], ['SIGNED', 'SUBMITTING', 'RETRY_WAIT']);
  for (const s of [...IN_FLIGHT_DOCUMENT_STATUSES, ...FINAL_DOCUMENT_STATUSES]) assert.ok((DOCUMENT_STATUSES as readonly string[]).includes(s), s);
  for (const s of IN_FLIGHT_DOCUMENT_STATUSES) assert.ok(!(FINAL_DOCUMENT_STATUSES as readonly string[]).includes(s));
});

test('التدفّق والنوع والمهلة', () => {
  assert.equal(flowForSubtype('01'), 'CLEARANCE');
  assert.equal(flowForSubtype('02'), 'REPORTING');
  assert.equal(subtypeOfTypeName('0100000'), '01');
  assert.equal(subtypeOfTypeName('0211010'), '02');
  for (const bad of ['0300000', '010000', '01000000', '', null, undefined]) assert.equal(subtypeOfTypeName(bad), null, String(bad));
  assert.equal(reportDeadlineFor('REPORTING', ISSUED)?.toISOString(), '2026-12-02T08:30:00.000Z');
  assert.equal(reportDeadlineFor('CLEARANCE', ISSUED), null);
});

test('الجدولة: 30ث، 2د، 5د، 10د، 15د ثم كل 30د؛ Retry-After الأكبر يغلب حتى سقف ساعة', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(n => retryDelayMs(n)), [30_000, 120_000, 300_000, 600_000, 900_000, BACKOFF_STEADY_MS, BACKOFF_STEADY_MS, BACKOFF_STEADY_MS]);
  assert.equal(retryDelayMs(1, 90), 90_000);
  assert.equal(retryDelayMs(3, 10), 300_000, 'الأصغر لا يقصّر الجدولة');
  assert.equal(retryDelayMs(1, 999_999), RETRY_AFTER_CAP_MS);
  for (const bad of [0, -1, 1.5, NaN]) assert.equal(retryDelayMs(bad), 30_000, String(bad));
  assert.equal(retryDelayMs(2, NaN), 120_000);
});

test('كل نتيجة ⇒ حالة (إبلاغ واعتماد)', () => {
  const w = [msg('WARNING', 'تحذير')];
  const e = [msg('ERROR', 'خطأ')];
  const cases: Array<[Outcome, 'REPORTING' | 'CLEARANCE', DocumentStatus, string | null]> = [
    [{ kind: 'ACCEPTED', warnings: [] }, 'REPORTING', 'REPORTED', null],
    [{ kind: 'ACCEPTED', warnings: w }, 'REPORTING', 'REPORTED_WARN', null],
    [{ kind: 'ACCEPTED', warnings: [], clearedXmlB64: 'PFg+' }, 'CLEARANCE', 'CLEARED', null],
    [{ kind: 'ACCEPTED', warnings: w, clearedXmlB64: 'PFg+' }, 'CLEARANCE', 'CLEARED_WARN', null],
    [{ kind: 'ACCEPTED', warnings: [] }, 'CLEARANCE', 'CLEARED_NO_XML', 'CLEARED_NO_XML'],
    [{ kind: 'DUPLICATE' }, 'REPORTING', 'REPORTED', null],
    [{ kind: 'DUPLICATE', clearedXmlB64: 'PFg+' }, 'CLEARANCE', 'CLEARED', null],
    [{ kind: 'DUPLICATE' }, 'CLEARANCE', 'CLEARED_NO_XML', 'CLEARED_NO_XML'],
    [{ kind: 'REJECTED', errors: e, warnings: w }, 'REPORTING', 'REJECTED', 'REJECTED'],
    [{ kind: 'REJECTED', errors: e, warnings: [] }, 'CLEARANCE', 'REJECTED', 'REJECTED'],
    [{ kind: 'AUTH' }, 'CLEARANCE', 'AUTH_BLOCKED', 'AUTH'],
    [{ kind: 'CONFIG', detail: 'unexpected-status:406' }, 'REPORTING', 'CONFIG_ERROR', 'CONFIG'],
    [{ kind: 'CLEARANCE_OFF' }, 'REPORTING', 'CONFIG_ERROR', 'CONFIG'],
  ];
  for (const [o, flow, status, alert] of cases) {
    const t = transitionForOutcome(o, ctx({ flow }));
    assert.equal(t.status, status, `${o.kind}/${flow}`);
    assert.equal(t.alert, alert, `${o.kind}/${flow} alert`);
    assert.equal(t.leaseUntil, null);
    assert.equal(t.authFailure, o.kind === 'AUTH');
    const final = (FINAL_DOCUMENT_STATUSES as readonly string[]).includes(status);
    assert.equal(t.finalizedAt?.getTime(), final ? NOW.getTime() : undefined, `${o.kind} finalizedAt`);
  }
  const cleared = transitionForOutcome({ kind: 'ACCEPTED', warnings: w, clearedXmlB64: 'PFg+' }, ctx({ flow: 'CLEARANCE' }));
  assert.equal(cleared.clearedXmlB64, 'PFg+');
  assert.deepEqual(cleared.warnings, w);
  assert.deepEqual(transitionForOutcome({ kind: 'REJECTED', errors: e, warnings: w }, ctx()).errors, e);
});

test('إيقاف الاعتماد (303): القياسية تتحوّل إلى الإبلاغ بالبايتات نفسها فوراً، ومهلتها تُضبط (نقد الخطة 10)', () => {
  const t = transitionForOutcome({ kind: 'CLEARANCE_OFF' }, ctx({ flow: 'CLEARANCE', reportDeadline: null }));
  assert.equal(t.status, 'SIGNED');
  assert.equal(t.flow, 'REPORTING');
  assert.equal(t.nextAttemptAt, null);
  assert.equal(t.reportDeadline?.toISOString(), new Date(ISSUED.getTime() + REPORT_WINDOW_MS).toISOString());
  assert.equal(t.finalizedAt, undefined);
  // القياسية المُبلَّغة قابلة للطباعة بختمنا
  assert.equal(mirrorStatusOf('REPORTED', '01'), 'reported');
  assert.equal(mirrorStatusOf('REPORTED_WARN', '01'), 'reported_warn');
  assert.equal(isPrintableMirror('reported', '01'), true);
  assert.equal(mirrorQrOf({ subtype: '01', status: 'REPORTED', qr: 'our', clearedQr: null }), 'our');
});

test('RETRY: الجدولة، وعدّادا التصعيد يزيدان لسببيهما وحدهما (لا للمهلة ولا 5xx ولا 429 ولا الشبكة)', () => {
  const reasons: RetryReason[] = ['rate', 'server', 'timeout', 'network', 'empty400', 'payload'];
  for (const reason of reasons) {
    const t = transitionForOutcome({ kind: 'RETRY', reason }, ctx({ attempts: 2, priorEmpty400: 1, priorPayload413: 0 }));
    assert.equal(t.status, 'RETRY_WAIT');
    assert.equal(t.nextAttemptAt?.getTime(), NOW.getTime() + 120_000, reason);
    assert.equal(t.priorEmpty400, reason === 'empty400' ? 2 : undefined, reason);
    assert.equal(t.priorPayload413, reason === 'payload' ? 1 : undefined, reason);
    assert.equal(t.alert, null);
  }
  const ra = transitionForOutcome({ kind: 'RETRY', reason: 'rate', retryAfterSeconds: 600 }, ctx({ attempts: 1 }));
  assert.equal(ra.nextAttemptAt?.getTime(), NOW.getTime() + 600_000);
});

test('المطالبة: SIGNED/RETRY_WAIT حان موعدها بلا عقد حيّ، أو SUBMITTING انتهى عقده', () => {
  const past = new Date(NOW.getTime() - 1);
  const future = new Date(NOW.getTime() + 1);
  assert.equal(isClaimable({ status: 'SIGNED', nextAttemptAt: null, leaseUntil: null }, NOW), true);
  assert.equal(isClaimable({ status: 'RETRY_WAIT', nextAttemptAt: NOW, leaseUntil: null }, NOW), true, 'الحدّ نفسه حان');
  assert.equal(isClaimable({ status: 'RETRY_WAIT', nextAttemptAt: future, leaseUntil: null }, NOW), false);
  assert.equal(isClaimable({ status: 'RETRY_WAIT', nextAttemptAt: future, leaseUntil: null }, NOW, { ignoreSchedule: true }), true);
  assert.equal(isClaimable({ status: 'SIGNED', nextAttemptAt: null, leaseUntil: future }, NOW), false);
  assert.equal(isClaimable({ status: 'SIGNED', nextAttemptAt: null, leaseUntil: future }, NOW, { ignoreSchedule: true }), false, 'لا تجاوز لعقد حيّ');
  assert.equal(isClaimable({ status: 'SUBMITTING', nextAttemptAt: null, leaseUntil: past }, NOW), true);
  assert.equal(isClaimable({ status: 'SUBMITTING', nextAttemptAt: null, leaseUntil: NOW }, NOW), false);
  assert.equal(isClaimable({ status: 'SUBMITTING', nextAttemptAt: null, leaseUntil: null }, NOW), false);
  for (const s of [...FINAL_DOCUMENT_STATUSES, 'AUTH_BLOCKED', 'CONFIG_ERROR']) {
    assert.equal(isClaimable({ status: s, nextAttemptAt: null, leaseUntil: null }, NOW, { ignoreSchedule: true }), false, s);
  }
});

test('الإعادة اليدوية من RETRY_WAIT/AUTH_BLOCKED/CONFIG_ERROR وحدها', () => {
  for (const s of DOCUMENT_STATUSES) {
    const w = manualRetryWrite(s, NOW);
    if (['RETRY_WAIT', 'AUTH_BLOCKED', 'CONFIG_ERROR'].includes(s)) assert.deepEqual(w, { status: 'RETRY_WAIT', nextAttemptAt: NOW, leaseUntil: null }, s);
    else assert.equal(w, null, s);
  }
});

test('مرآة الفاتورة: الجدول كاملاً، والمستحيل null', () => {
  const expect: Record<DocumentStatus, [string | null, string | null]> = {
    SIGNED: ['signed', 'clearance_pending'], SUBMITTING: ['signed', 'clearance_pending'], RETRY_WAIT: ['signed', 'clearance_pending'],
    AUTH_BLOCKED: ['report_blocked', 'clearance_blocked'], CONFIG_ERROR: ['report_blocked', 'clearance_blocked'],
    REPORTED: ['reported', 'reported'], REPORTED_WARN: ['reported_warn', 'reported_warn'],
    CLEARED: [null, 'cleared'], CLEARED_WARN: [null, 'cleared_warn'], CLEARED_NO_XML: [null, 'cleared_no_xml'], REJECTED: ['rejected', 'rejected'],
    // Z5.4 (نقد 11): السحب قبل أن تستلم الهيئة المستند — الفاتورة مُبطلة فمرآتها withdrawn لكلا النوعين
    WITHDRAWN: ['withdrawn', 'withdrawn'],
  };
  for (const s of DOCUMENT_STATUSES) {
    assert.equal(mirrorStatusOf(s, '02'), expect[s][0], `02 ${s}`);
    assert.equal(mirrorStatusOf(s, '01'), expect[s][1], `01 ${s}`);
  }
  for (const m of Object.values(expect).flat()) if (m) assert.ok((INVOICE_MIRROR_STATUSES as readonly string[]).includes(m), m);
});

test('رمز المرآة: المبسّطة ختمنا؛ القياسية clearedQr بعد الاعتماد فقط (لا رمز لقياسية معلّقة أو مرفوضة)', () => {
  for (const s of DOCUMENT_STATUSES) assert.equal(mirrorQrOf({ subtype: '02', status: s, qr: 'our', clearedQr: 'zatca' }), 'our', s);
  const b2b = (status: DocumentStatus, clearedQr: string | null = 'zatca') => mirrorQrOf({ subtype: '01', status, qr: 'our', clearedQr });
  assert.equal(b2b('CLEARED'), 'zatca');
  assert.equal(b2b('CLEARED_WARN'), 'zatca');
  assert.equal(b2b('CLEARED', null), null);
  for (const s of ['SIGNED', 'SUBMITTING', 'RETRY_WAIT', 'AUTH_BLOCKED', 'CONFIG_ERROR', 'REJECTED', 'CLEARED_NO_XML', 'WITHDRAWN'] as DocumentStatus[]) assert.equal(b2b(s), null, s);
});

test('قابلية الطباعة: المبسّطة عدا المرفوضة؛ القياسية معتمدة أو مُبلَّغة فقط', () => {
  for (const m of INVOICE_MIRROR_STATUSES) {
    const b2c = mirrorStatusValidFor02(m);
    // Z5.4: المسحوبة كالمرفوضة — الفاتورة تحتها مُبطلة فلا تُطبع ولو كانت مبسّطة
    assert.equal(isPrintableMirror(m, '02'), b2c && m !== 'rejected' && m !== 'withdrawn', `02 ${m}`);
    assert.equal(isPrintableMirror(m, '01'), ['cleared', 'cleared_warn', 'reported', 'reported_warn'].includes(m), `01 ${m}`);
  }
  for (const bad of [null, undefined, '', 'generated', 'pending']) {
    assert.equal(isPrintableMirror(bad, '02'), false, String(bad));
    assert.equal(isPrintableMirror(bad, '01'), false, String(bad));
  }
});

function mirrorStatusValidFor02(m: string): boolean {
  return DOCUMENT_STATUSES.some(s => mirrorStatusOf(s, '02') === m);
}

test('التأخر محسوب: مهلة + غير نهائية + تجاوز', () => {
  const deadline = new Date(NOW.getTime() - 1);
  for (const s of DOCUMENT_STATUSES) {
    const final = (FINAL_DOCUMENT_STATUSES as readonly string[]).includes(s);
    assert.equal(isOverdue({ status: s, reportDeadline: deadline }, NOW), !final, s);
  }
  assert.equal(isOverdue({ status: 'SIGNED', reportDeadline: NOW }, NOW), false);
  assert.equal(isOverdue({ status: 'SIGNED', reportDeadline: null }, NOW), false);
});

test('تأكيد 401: سابق على مستند آخر منذ 60 ثانية على الأقل (نقد الخطة 18)', () => {
  const cur = { documentId: 'd2', at: NOW };
  assert.equal(authFailureConfirmed(null, cur), false);
  assert.equal(authFailureConfirmed(undefined, cur), false);
  assert.equal(authFailureConfirmed({ documentId: 'd2', at: new Date(NOW.getTime() - 3_600_000) }, cur), false, 'المستند نفسه');
  assert.equal(authFailureConfirmed({ documentId: 'd1', at: new Date(NOW.getTime() - 59_999) }, cur), false, 'قبل 60 ثانية');
  assert.equal(authFailureConfirmed({ documentId: 'd1', at: new Date(NOW.getTime() - 60_000) }, cur), true);
});
