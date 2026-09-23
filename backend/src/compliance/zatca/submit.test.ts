// ZATCA المرحلة الثانية (Z5.3) — اختبارات محرّك الإرسال فوق منصّة «فاتورة» مزيّفة (لا شبكة ولا قاعدة بيانات).
// يُثبت: كل نتيجة ⇒ حالة ومرآة وإشعار؛ عدّادات التصعيد لا تتحرّك إلا بسببها؛ إيقاف الاعتماد (303) يعيد المستند للإبلاغ
// ويمنحه مهلة 24 ساعة ويجعله قابلاً للطباعة بعد الإبلاغ؛ التكرار بلا مستند معتمد CLEARED_NO_XML بتنبيه؛ التسييج يمنع عاملاً
// متأخراً من الكتابة؛ الانهيار بين كتابة النتيجة والإبطال لا يترك فاتورة نصف محسومة؛ 401 لا يوقف الشركة إلا بتأكيد؛
// 429 يوقف وحدةً واحدة؛ الوحدة قيد التجديد ترسل والوحدة المسحوبة تُصرَّف؛ انحراف نسخة المفتاح يفرّق بين المبسّطة والقياسية؛
// ولا سرّ في سجلّ الطلبات.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSubmitHarness, PCSID_SECRET, type SubmitHarness } from './__fixtures__/z5-submit';
import { FAKE_REPLIES, type FakeReply } from './__fixtures__/z5-fakezatca';
import { gunzipXml } from './documentStore';
import { extractQrFromXml } from './qr';
import { retryDocumentNow, submitClaimedDocument, submitDocument, type SubmitDone, type SubmitResult } from './submit';
import { runZatcaSweep } from './sweep';

const HOUR = 3_600_000;

function done(r: SubmitResult): SubmitDone {
  assert.equal(r.kind, 'done', `expected done, got ${r.kind === 'skipped' ? r.reason : r.kind}`);
  return r as SubmitDone;
}

async function send(h: SubmitHarness, ref: { documentId: string; invoiceId: string }, opts: Record<string, unknown> = {}): Promise<SubmitResult> {
  return submitDocument(h.deps, { documentId: ref.documentId, tenantId: h.tenantId }, { ignoreSchedule: true, ...opts });
}

// ═══ المسار السعيد ═══

test('مبسّطة: 200 REPORTED ⇒ الحالة REPORTED والمرآة reported ورمز QR ختمُنا وسجلّ طلب بمعرّف المستند', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  const r = done(await send(h, issued));

  assert.equal(r.status, 'REPORTED');
  assert.equal(r.mirror, 'reported');
  assert.equal(r.outcome, 'ACCEPTED');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.applied, true);
  const d = h.doc(issued.documentId);
  assert.equal(d.status, 'REPORTED');
  assert.ok(d.finalizedAt);
  assert.equal(d.leaseUntil, null);
  assert.equal(d.attempts, 1);
  const inv = h.invoice(issued.invoiceId);
  assert.equal(inv.einvoiceStatus, 'reported');
  assert.equal(inv.einvoiceQr, issued.qr);
  assert.deepEqual(h.published, [h.tenantId]);
  assert.deepEqual(h.fake.violations, []);
  // سجلّ الطلب: صفّ واحد بمعرّف المستند، وبلا رمز أو سرّ
  assert.equal(h.docs.apiLogs.length, 1);
  assert.equal(h.docs.apiLogs[0].documentId, issued.documentId);
  assert.equal(h.docs.apiLogs[0].endpoint, 'reporting');
  const logText = JSON.stringify(h.docs.apiLogs);
  assert.ok(!logText.includes(PCSID_SECRET));
  assert.ok(!logText.includes(h.keys.token.slice(0, 40)));
});

test('مبسّطة: 202 بتحذيرات ⇒ REPORTED_WARN والتحذيرات في مرآة الفاتورة', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.warn202() } });
  const issued = await h.issue();
  const r = done(await send(h, issued));

  assert.equal(r.status, 'REPORTED_WARN');
  assert.equal(r.mirror, 'reported_warn');
  const inv = h.invoice(issued.invoiceId);
  const warns = JSON.parse(inv.einvoiceWarnings as string) as Array<{ type: string; code: string }>;
  assert.ok(warns.length >= 1);
  assert.ok(warns.every(w => w.type === 'WARNING'));
});

test('قياسية: الاعتماد ⇒ CLEARED مع حفظ المستند المعتمد واستخراج رمزه (يختلف عن ختمنا)', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue({ standard: true });
  assert.equal(h.invoice(issued.invoiceId).einvoiceStatus, 'clearance_pending');
  assert.equal(h.invoice(issued.invoiceId).einvoiceQr, null);

  const r = done(await send(h, issued));
  assert.equal(r.status, 'CLEARED');
  assert.equal(r.mirror, 'cleared');
  const d = h.doc(issued.documentId);
  assert.ok(d.clearedXmlGz);
  const clearedXml = gunzipXml(d.clearedXmlGz as Buffer);
  assert.equal(extractQrFromXml(clearedXml), d.clearedQr);
  assert.notEqual(d.clearedQr, issued.qr);
  assert.equal(h.invoice(issued.invoiceId).einvoiceQr, d.clearedQr);
  assert.equal(h.fake.calls[0].endpoint, 'clearance');
  assert.deepEqual(h.fake.violations, []);
});

test('التكرار: إرسال البايتات نفسها ثانيةً ⇒ 409 للإبلاغ و208 للاعتماد، وكلاهما نجاح', async () => {
  const h = createSubmitHarness();
  const simple = await h.issue();
  done(await send(h, simple));
  // إعادة المستند إلى قابلية المطالبة يدوياً (كعامل مات بعد الإرسال قبل الكتابة)
  const d = h.doc(simple.documentId);
  d.status = 'RETRY_WAIT';
  d.finalizedAt = null;
  const again = done(await send(h, simple));
  assert.equal(again.outcome, 'DUPLICATE');
  assert.equal(again.status, 'REPORTED');

  const std = await h.issue({ standard: true });
  done(await send(h, std));
  const sd = h.doc(std.documentId);
  sd.status = 'RETRY_WAIT';
  sd.finalizedAt = null;
  sd.clearedXmlGz = null;
  const dup = done(await send(h, std));
  assert.equal(dup.outcome, 'DUPLICATE');
  assert.equal(dup.status, 'CLEARED');
  assert.ok(h.doc(std.documentId).clearedXmlGz);
});

test('تكرار بلا مستند معتمد ⇒ CLEARED_NO_XML مع تنبيه المالك', async () => {
  const h = createSubmitHarness({ fake: { onClear: () => FAKE_REPLIES.duplicateNoXml208() } });
  const issued = await h.issue({ standard: true });
  const r = done(await send(h, issued));
  assert.equal(r.status, 'CLEARED_NO_XML');
  assert.equal(r.mirror, 'cleared_no_xml');
  assert.equal(r.alert, 'CLEARED_NO_XML');
  const note = h.notifications.find(n => n.kind === 'CLEARED_NO_XML');
  assert.ok(note && note.owner);
});

test('اعتماد 200 بلا clearedInvoice ⇒ CONFIG_ERROR (لا يُعلَن اعتماد بلا نسخته)', async () => {
  const h = createSubmitHarness({ fake: { onClear: () => FAKE_REPLIES.clearedMissing200() } });
  const issued = await h.issue({ standard: true });
  const r = done(await send(h, issued));
  assert.equal(r.outcome, 'CONFIG');
  assert.equal(r.status, 'CONFIG_ERROR');
  assert.equal(r.mirror, 'clearance_blocked');
});

test('2xx متناقض (REPORTED مع NOT_REPORTED) ⇒ CONFIG_ERROR لا قبول', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.contradictory200() } });
  const issued = await h.issue();
  const r = done(await send(h, issued));
  assert.equal(r.outcome, 'CONFIG');
  assert.equal(r.status, 'CONFIG_ERROR');
  assert.equal(r.mirror, 'report_blocked');
  // المبسّطة المحجوبة تبقى ذات مهلة ⇒ متأخّرة لاحقاً
  assert.ok(h.doc(issued.documentId).reportDeadline);
});

// ═══ الرفض والإبطال الذرّي (نقد 7) ═══

test('رفض 400 ⇒ REJECTED ومرآة rejected وخطّاف الإبطال داخل المعاملة نفسها', async () => {
  const seen: string[] = [];
  const h = createSubmitHarness({
    fake: { onClear: () => FAKE_REPLIES.reject400() },
    onRejectedInTx: async (_tx, info) => {
      // داخل المعاملة: حالة المستند والمرآة مكتوبتان فعلاً
      seen.push(`${info.invoiceId}:${info.subtype}:${info.errors.length}`);
    },
  });
  const issued = await h.issue({ standard: true });
  const r = done(await send(h, issued));

  assert.equal(r.status, 'REJECTED');
  assert.equal(r.mirror, 'rejected');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith(`${issued.invoiceId}:01:`));
  assert.ok(h.notifications.some(n => n.kind === 'REJECTED'));
  const inv = h.invoice(issued.invoiceId);
  assert.equal(inv.einvoiceStatus, 'rejected');
  const msgs = JSON.parse(inv.einvoiceWarnings as string) as Array<{ type: string }>;
  assert.ok(msgs.some(m => m.type === 'ERROR'));
});

test('انهيار بين كتابة النتيجة والإبطال ⇒ لا شيء يُكتب، والمستند يُعاد إرساله لاحقاً ويُحسم (نقد 7)', async () => {
  const h = createSubmitHarness({
    fake: { onClear: () => FAKE_REPLIES.reject400() },
    onRejectedInTx: async () => { throw new Error('void failed'); },
  });
  const issued = await h.issue({ standard: true });
  await assert.rejects(() => send(h, issued), /void failed/);

  // لا نصف حسم: المستند ما يزال قيد الإرسال والفاتورة على حالها
  const d = h.doc(issued.documentId);
  assert.equal(d.status, 'SUBMITTING');
  assert.equal(h.invoice(issued.invoiceId).einvoiceStatus, 'clearance_pending');

  // بعد انتهاء عقد الإيجار يُستولى عليه من جديد ويُحسم (الإبطال نجح هذه المرّة)
  const voided: string[] = [];
  (h.deps as { onRejectedInTx?: unknown }).onRejectedInTx = async (_tx: unknown, info: { invoiceId: string }) => { voided.push(info.invoiceId); };
  h.clock.advance(120_000);
  const r = done(await send(h, issued));
  assert.equal(r.status, 'REJECTED');
  assert.deepEqual(voided, [issued.invoiceId]);
  assert.equal(h.invoice(issued.invoiceId).einvoiceStatus, 'rejected');
});

// ═══ إيقاف الاعتماد 303 (نقد 10) ═══

test('303 ⇒ المستند يعود SIGNED على تدفّق الإبلاغ بمهلة 24 ساعة، ثم يُبلَّغ فيصير قابلاً للطباعة برمز ختمنا', async () => {
  let clears = 0;
  const h = createSubmitHarness({ fake: { onClear: () => { clears++; return FAKE_REPLIES.clearanceOff303(); } } });
  const issued = await h.issue({ standard: true });

  const r1 = done(await send(h, issued));
  assert.equal(r1.outcome, 'CLEARANCE_OFF');
  assert.equal(r1.status, 'SIGNED');
  const d1 = h.doc(issued.documentId);
  assert.equal(d1.flow, 'REPORTING');
  assert.ok(d1.reportDeadline);
  assert.equal((d1.reportDeadline as Date).getTime(), d1.createdAt.getTime() + 24 * HOUR);
  assert.equal(h.invoice(issued.invoiceId).einvoiceStatus, 'clearance_pending');
  assert.equal(clears, 1);

  const r2 = done(await send(h, issued));
  assert.equal(r2.status, 'REPORTED');
  assert.equal(r2.mirror, 'reported');
  assert.equal(h.fake.calls[1].endpoint, 'reporting');
  // القياسية المُبلَّغة تُطبع بختمنا (وإلا بقيت معلّقة إلى الأبد)
  assert.equal(h.invoice(issued.invoiceId).einvoiceQr, issued.qr);
});

// ═══ التصعيد وإعادة المحاولة ═══

test('400 فارغ: ثلاث إعادات ثم الرفض، والعدّاد priorEmpty400 وحده يتحرّك', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.empty400() } });
  const issued = await h.issue();
  for (const expected of [1, 2, 3]) {
    const r = done(await send(h, issued));
    assert.equal(r.status, 'RETRY_WAIT');
    assert.equal(h.doc(issued.documentId).priorEmpty400, expected);
    assert.equal(h.doc(issued.documentId).priorPayload413, 0);
    assert.ok(r.nextAttemptAt);
  }
  const last = done(await send(h, issued));
  assert.equal(last.status, 'REJECTED');
  assert.equal(last.mirror, 'rejected');
});

test('413: إعادة واحدة ثم CONFIG_ERROR، والعدّاد priorPayload413 وحده يتحرّك', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.payload413() } });
  const issued = await h.issue();
  const first = done(await send(h, issued));
  assert.equal(first.status, 'RETRY_WAIT');
  assert.equal(h.doc(issued.documentId).priorPayload413, 1);
  assert.equal(h.doc(issued.documentId).priorEmpty400, 0);
  const second = done(await send(h, issued));
  assert.equal(second.status, 'CONFIG_ERROR');
});

test('المهلة و5xx والشبكة ⇒ إعادة بلا تحريك أي عدّاد تصعيد', async () => {
  const replies: FakeReply[] = [FAKE_REPLIES.timeout(5000), FAKE_REPLIES.server500(), FAKE_REPLIES.server503(), FAKE_REPLIES.network()];
  let i = 0;
  const h = createSubmitHarness({ fake: { onReport: () => replies[i++] } });
  const issued = await h.issue();
  for (let n = 0; n < replies.length; n++) {
    const r = done(await send(h, issued, { timeoutMs: 1000 }));
    assert.equal(r.status, 'RETRY_WAIT', `reply ${n}`);
    assert.equal(r.outcome, 'RETRY');
    assert.equal(h.doc(issued.documentId).priorEmpty400, 0);
    assert.equal(h.doc(issued.documentId).priorPayload413, 0);
  }
  // التراجع يتصاعد مع رقم المحاولة
  const d = h.doc(issued.documentId);
  assert.equal(d.attempts, 4);
  assert.ok((d.nextAttemptAt as Date).getTime() > h.clock.now().getTime());
});

test('406 ⇒ CONFIG_ERROR بتنبيه المالك', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.notAcceptable406() } });
  const issued = await h.issue();
  const r = done(await send(h, issued));
  assert.equal(r.status, 'CONFIG_ERROR');
  assert.ok(h.notifications.some(n => n.kind === 'CONFIG_ERROR' && n.owner));
});

test('429 ⇒ إعادة بعد Retry-After، ويوقف الوحدة فلا يُستدعى لها مستند آخر', async () => {
  const h = createSubmitHarness({ fake: { onReport: (_c, n) => (n === 1 ? FAKE_REPLIES.rate429(120) : undefined) } });
  const a = await h.issue();
  const b = await h.issue();
  const r1 = done(await send(h, a));
  assert.equal(r1.status, 'RETRY_WAIT');
  assert.ok((r1.nextAttemptAt as Date).getTime() - h.clock.now().getTime() >= 120_000);
  assert.equal(h.deps.pauses?.pausedUntil(h.unitId, h.clock.now()) !== null, true);

  const r2 = await send(h, b);
  assert.equal(r2.kind, 'skipped');
  assert.equal((r2 as { reason: string }).reason, 'RATE_PAUSED');
  assert.equal(h.fake.calls.length, 1, 'لا استدعاء ثانٍ والوحدة موقوفة');

  // بعد انقضاء الإيقاف يُرسل بلا عائق
  h.clock.advance(121_000);
  const r3 = done(await send(h, b));
  assert.equal(r3.status, 'REPORTED');
});

// ═══ 401 (نقد 18) ═══

test('401 واحد ⇒ AUTH_BLOCKED والوحدة تبقى ACTIVE؛ 401 ثانٍ على مستند آخر بعد 60 ثانية ⇒ AUTH_FAILED بتنبيه', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.auth401() } });
  const a = await h.issue();
  const b = await h.issue();

  const r1 = done(await send(h, a));
  assert.equal(r1.status, 'AUTH_BLOCKED');
  assert.equal(r1.mirror, 'report_blocked');
  assert.equal(r1.authConfirmed, false);
  assert.equal(h.units.units.get(h.unitId)?.status, 'ACTIVE');
  assert.ok(h.notifications.some(n => n.kind === 'AUTH_BLOCKED'));

  // المستند نفسه من جديد (إعادة يدوية من AUTH_BLOCKED): لا تأكيد — العطل قد يكون في مستند واحد
  h.clock.advance(90_000);
  const same = done(await retryDocumentNow(h.deps, { documentId: a.documentId, tenantId: h.tenantId }));
  assert.equal(same.authConfirmed, false);
  assert.equal(h.units.units.get(h.unitId)?.status, 'ACTIVE');

  h.clock.advance(90_000);
  const r2 = done(await send(h, b));
  assert.equal(r2.status, 'AUTH_BLOCKED');
  assert.equal(r2.authConfirmed, true);
  assert.equal(h.units.units.get(h.unitId)?.status, 'AUTH_FAILED');
  assert.ok(h.notifications.some(n => n.kind === 'UNIT_AUTH_FAILED' && n.owner));
});

/* مراجعة عدائية: 401 عابر واحد (أو غياب مفتاح التشفير لحظةً بعد نشر) كان يجمّد المبسّطة إلى الأبد — لا المسح
 * يطالب بها (AUTH_BLOCKED/CONFIG_ERROR خارج حالات الاستيلاء) ولا مسار HTTP يعيدها — فتفوت مهلة الـ24 ساعة يقيناً. */
test('حجب المبسّطة مؤقّت: موعد استرداد يلتقطه المسح بعد إصلاح العطل (ولا يُستولى عليه قبل موعده)', async () => {
  let failing = true;
  const h = createSubmitHarness({ fake: { onReport: () => (failing ? FAKE_REPLIES.auth401() : undefined) } });
  const issued = await h.issue();
  const first = done(await send(h, issued));
  assert.equal(first.status, 'AUTH_BLOCKED');
  const blocked = h.doc(issued.documentId);
  assert.ok(blocked.nextAttemptAt, 'مستند إبلاغ محجوب بلا موعد استرداد = فوات المهلة بصمت');
  assert.ok((blocked.nextAttemptAt as Date).getTime() > h.clock.now().getTime());

  const early = await runZatcaSweep(h.deps, { limit: 5 });
  assert.equal(early.claimed, 0, 'استُولي عليه قبل موعده (قصف الهيئة)');

  h.clock.advance(16 * 60 * 1000);
  failing = false;
  const late = await runZatcaSweep(h.deps, { limit: 5 });
  assert.equal(late.claimed, 1);
  assert.equal(h.doc(issued.documentId).status, 'REPORTED');
  assert.equal(h.invoice(issued.invoiceId).einvoiceStatus, 'reported');
});

test('عطل إعداد قابل للإصلاح على مبسّطة يُجدوَل، والعطل الدائم (بايتات مفقودة) لا يُجدوَل', async () => {
  const h = createSubmitHarness();
  const fixable = await h.issue();
  const u = h.units.units.get(h.unitId);
  const secret = u?.productionSecretEnc ?? null;
  if (u) u.productionSecretEnc = null;
  assert.equal(done(await send(h, fixable)).local, 'CREDENTIALS_MISSING');
  assert.ok(h.doc(fixable.documentId).nextAttemptAt, 'عطلٌ يزول بإصلاح الإعداد بلا موعد استرداد');
  if (u) u.productionSecretEnc = secret;

  const permanent = await h.issue();
  const original = h.docs.loadDocumentXml.bind(h.docs);
  (h.deps.documents as { loadDocumentXml: (id: string) => Promise<unknown> }).loadDocumentXml =
    async (id: string) => (id === permanent.documentId ? null : original(id));
  const r = done(await send(h, permanent));
  assert.equal(r.local, 'BYTES_MISSING');
  assert.equal(h.doc(permanent.documentId).nextAttemptAt, null, 'عطلٌ دائم يُعاد إلى ما لا نهاية');
});

test('حجب القياسية نهائيّ (لا استرداد تلقائيّ): إعادة بايتاتٍ قد تُرفض فتُبطل فاتورة سليمة', async () => {
  const h = createSubmitHarness({ fake: { onClear: () => FAKE_REPLIES.auth401() } });
  const issued = await h.issue({ standard: true });
  assert.equal(done(await send(h, issued)).status, 'AUTH_BLOCKED');
  assert.equal(h.doc(issued.documentId).nextAttemptAt, null);
  h.clock.advance(6 * HOUR);
  assert.equal((await runZatcaSweep(h.deps, { limit: 5 })).claimed, 0, 'أُعيد إرسال قياسية محجوبة تلقائياً');
  // مخرجها الإعادة اليدوية (أو السحب)
  const manual = done(await retryDocumentNow(h.deps, { documentId: issued.documentId, tenantId: h.tenantId }));
  assert.equal(manual.status, 'AUTH_BLOCKED');
  assert.equal(h.fake.calls.length, 2);
});

// ═══ التسييج (نقد 34) ═══

test('عامل متأخّر لا يكتب فوق نتيجة أحدث (التسييج برمز المطالبة)', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  const stale = await h.docs.claim(issued.documentId, { leaseMs: 1000, ignoreSchedule: true });
  assert.ok(stale);
  // عامل آخر يستولي عليه بعد انتهاء عقده ويحسمه
  h.clock.advance(5000);
  const fresh = done(await send(h, issued));
  assert.equal(fresh.status, 'REPORTED');
  assert.equal(h.doc(issued.documentId).attempts, 2);

  // عقد المتأخّر انقضى: لا يُنادى الهيئة أصلاً (لا إرسال مزدوج ببايتات صار غيرُه يملكها)
  const calls = h.fake.calls.length;
  const expired = await submitClaimedDocument(h.deps, stale!, {});
  assert.equal(expired.kind, 'skipped');
  assert.equal(expired.kind === 'skipped' && expired.reason, 'LEASE_EXPIRED');
  assert.equal(h.fake.calls.length, calls, 'نودِيت الهيئة ببايتات انقضى عقدها');

  // وإن انقضى العقد **أثناء** الاستدعاء: يُرسل (تكرار) ولا يكتب، ويُنبَّه المالك أنّ نتيجةً ضاعت
  const inFlight = { ...stale!, leaseUntil: new Date(h.clock.now().getTime() + 60_000) };
  const late = done(await submitClaimedDocument(h.deps, inFlight, {}));
  assert.equal(late.applied, false);
  assert.equal(h.doc(issued.documentId).status, 'REPORTED');
  assert.equal(h.doc(issued.documentId).attempts, 2);
  assert.ok(h.notifications.some(n => n.kind === 'OUTCOME_LOST' && n.owner), 'ضاعت نتيجة هيئة بلا تنبيه');
});

// ═══ حالات الوحدة والبوّابة ═══

test('الوحدة قيد التجديد تُرسل (تصريف الجاري)، والمسحوبة تُصرَّف بتنبيه، وحالة غير صالحة ⇒ CONFIG_ERROR بلا استدعاء', async () => {
  const h = createSubmitHarness();
  // كل المستندات تُصدر والوحدة ACTIVE، ثم تتبدّل حالتها (الإصدار نفسه لا يجوز إلا ACTIVE)
  const a = await h.issue();
  const b = await h.issue();
  const c = await h.issue();

  h.setUnitStatus('RENEWING');
  assert.equal(done(await send(h, a)).status, 'REPORTED');

  h.setUnitStatus('REVOKED');
  const r = done(await send(h, b));
  assert.equal(r.status, 'REPORTED');
  assert.ok(h.notifications.some(n => n.kind === 'DRAINING_UNIT' && n.owner));

  h.setUnitStatus('CSR_READY');
  const calls = h.fake.calls.length;
  const bad = done(await send(h, c));
  assert.equal(bad.status, 'CONFIG_ERROR');
  assert.equal(bad.local, 'UNIT_NOT_SUBMITTABLE');
  assert.equal(h.fake.calls.length, calls, 'لا استدعاء لوحدة غير صالحة');
});

test('شركة موقوفة: لا مطالبة ولا استدعاء (المستند يبقى SIGNED بلا محاولة)', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  h.gates.set(h.tenantId, { live: true, pausedAt: h.clock.now() });
  const r = await send(h, issued);
  assert.equal(r.kind, 'skipped');
  assert.equal((r as { reason: string }).reason, 'PAUSED');
  assert.equal(h.doc(issued.documentId).status, 'SIGNED');
  assert.equal(h.doc(issued.documentId).attempts, 0);
  assert.equal(h.fake.calls.length, 0);
});

test('وحدة إنتاج لشركة غير مفعّلة ⇒ حسم محلّي بلا استدعاء (فشل مغلق)', async () => {
  const h = createSubmitHarness({ live: false });
  const issued = await h.issue();
  const r = done(await send(h, issued));
  assert.equal(r.status, 'CONFIG_ERROR');
  assert.equal(r.local, 'TENANT_NOT_LIVE');
  assert.equal(h.fake.calls.length, 0);
});

test('وحدة البروفة (simulation) ترسل ولو لم تكن الشركة مفعّلة', async () => {
  const h = createSubmitHarness({ environment: 'simulation', live: false });
  const issued = await h.issue();
  const r = done(await send(h, issued));
  assert.equal(r.status, 'REPORTED');
});

test('سرّ الاعتماد مفقود ⇒ CONFIG_ERROR بلا استدعاء', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  const u = h.units.units.get(h.unitId);
  if (u) u.productionSecretEnc = null;
  const r = done(await send(h, issued));
  assert.equal(r.status, 'CONFIG_ERROR');
  assert.equal(r.local, 'CREDENTIALS_MISSING');
  assert.equal(h.fake.calls.length, 0);
});

// ═══ انحراف نسخة المفتاح (نقد 9/40) ═══

test('بايتات وُقّعت قبل التجديد: المبسّطة تُرسل مع تنبيه، والقياسية تُوقَف بانتظار إعادة الإصدار', async () => {
  const h = createSubmitHarness();
  const simple = await h.issue();
  const standard = await h.issue({ standard: true });
  h.setKeyVersion(2);

  const r1 = done(await send(h, simple));
  assert.equal(r1.status, 'REPORTED');
  assert.ok(h.notifications.some(n => n.kind === 'STALE_KEY' && n.documentId === simple.documentId));

  const calls = h.fake.calls.length;
  const r2 = done(await send(h, standard));
  assert.equal(r2.status, 'CONFIG_ERROR');
  assert.equal(r2.local, 'STALE_KEY');
  assert.equal(h.fake.calls.length, calls, 'لا اعتماد ببايتات قد تُرفض فتُبطل فاتورة سليمة');
  /* مراجعة عدائية ٢ (النتيجة 6): مستند اعتماد بشهادة سابقة لا موعد استرداد له (blockedNextAttemptAt للاعتماد null)
   * ومخرجه بيد إنسان — فلا يمرّ صامتاً بإشعارٍ لإدارة الشركة وحدها. */
  const note = h.notifications.filter(n => n.kind === 'STALE_KEY' && n.documentId === standard.documentId);
  assert.equal(note.length, 1, 'لا إشعار لمستند اعتماد عالق بشهادة سابقة');
  assert.equal(note[0].owner, true, 'العطل الذي لا مخرج تلقائيّ له لا يصل مالك المنصّة');
  assert.equal(h.doc(standard.documentId).nextAttemptAt, null, 'حُجب الاعتماد بموعد — البايتات قد تُرفض');
  // والمبسّطة تُرسل فعلاً فيبقى إشعارها لإدارة الشركة (ليس عطلاً بلا مخرج)
  assert.equal(h.notifications.find(n => n.kind === 'STALE_KEY' && n.documentId === simple.documentId)?.owner, false);
});

// ═══ دليل الإرسال (sentAttempts) — مراجعة عدائية ٢، النتائج 3/4/8 ═══

test('حسمٌ محلّيّ بعد الاستيلاء: attempts يرتفع وsentAttempts يبقى صفراً (لم تغادر بايتة)', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue({ standard: true });
  h.setKeyVersion(2);
  assert.equal(done(await send(h, issued)).local, 'STALE_KEY');
  const d = h.doc(issued.documentId);
  assert.equal(d.attempts, 1, 'الاستيلاء لم يرفع عدّاد المطالبة');
  assert.equal(d.sentAttempts, 0, 'عُدّ إرسالٌ لم يقع — السحب سيظنّ أنّ الهيئة ربّما استلمت');
  assert.equal(h.fake.calls.length, 0);
  assert.equal(h.docs.apiLogs.length, 0);
  // وإعادةٌ يدوية أخرى ترفع المطالبة وحدها
  await retryDocumentNow(h.deps, { documentId: issued.documentId, tenantId: h.tenantId });
  assert.equal(h.doc(issued.documentId).attempts, 2);
  assert.equal(h.doc(issued.documentId).sentAttempts, 0);
});

test('نداءٌ فعليّ (ولو رُدّ 401) يرفع sentAttempts قبل النداء — فالعدّاد أثرٌ دائم ولو مات العامل بعده', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.auth401() } });
  const issued = await h.issue();
  assert.equal(done(await send(h, issued)).status, 'AUTH_BLOCKED');
  assert.equal(h.doc(issued.documentId).sentAttempts, 1);
  assert.equal(h.fake.calls.length, 1);
});

test('تعذّر وسم الإرسال ⇒ لا نداء للهيئة أصلاً (مستندٌ يُؤجَّل، لا بايتات بلا أثر)', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  const store = h.deps.documents as unknown as { markDispatched: (id: string) => Promise<boolean> };
  const original = store.markDispatched;
  store.markDispatched = async () => false;
  const r = await send(h, issued);
  assert.equal(r.kind, 'skipped');
  assert.equal(r.kind === 'skipped' && r.reason, 'DISPATCH_UNMARKED');
  assert.equal(h.fake.calls.length, 0, 'نُوديت الهيئة بلا أثرٍ دائم على المستند');
  assert.equal(h.doc(issued.documentId).status, 'RETRY_WAIT');
  assert.ok(h.doc(issued.documentId).nextAttemptAt, 'أُجّل بلا موعد فلا يلتقطه المسح');
  store.markDispatched = original;
});

test('السياسة never توقف المبسّطة أيضاً، وalways ترسل القياسية', async () => {
  const never = createSubmitHarness({ env: { ZATCA_SUBMIT_STALE_KEY: 'never' } as NodeJS.ProcessEnv });
  const a = await never.issue();
  never.setKeyVersion(3);
  assert.equal(done(await send(never, a)).local, 'STALE_KEY');
  assert.equal(never.fake.calls.length, 0);

  const always = createSubmitHarness({ env: { ZATCA_SUBMIT_STALE_KEY: 'always' } as NodeJS.ProcessEnv });
  const b = await always.issue({ standard: true });
  always.setKeyVersion(3);
  assert.equal(done(await send(always, b)).status, 'CLEARED');
});

// ═══ الإعادة اليدوية ═══

test('الإعادة اليدوية تستولي على مستند CONFIG_ERROR وترسله من جديد', async () => {
  let fail = true;
  const h = createSubmitHarness({ fake: { onReport: () => (fail ? FAKE_REPLIES.notAcceptable406() : undefined) } });
  const issued = await h.issue();
  assert.equal(done(await send(h, issued)).status, 'CONFIG_ERROR');
  fail = false;
  const r = done(await retryDocumentNow(h.deps, { documentId: issued.documentId, tenantId: h.tenantId }));
  assert.equal(r.status, 'REPORTED');
  assert.equal(h.invoice(issued.invoiceId).einvoiceStatus, 'reported');
});

test('المطالبة تحترم الموعد: بلا ignoreSchedule لا يُرسل مستند مؤجَّل', async () => {
  const h = createSubmitHarness({ fake: { onReport: (_c, n) => (n === 1 ? FAKE_REPLIES.server503() : undefined) } });
  const issued = await h.issue();
  done(await send(h, issued));
  const r = await submitDocument(h.deps, { documentId: issued.documentId, tenantId: h.tenantId }, {});
  assert.equal(r.kind, 'skipped');
  assert.equal((r as { reason: string }).reason, 'NOT_CLAIMED');
  assert.equal(h.fake.calls.length, 1);

  h.clock.advance(31_000);
  assert.equal(done(await submitDocument(h.deps, { documentId: issued.documentId, tenantId: h.tenantId }, {})).status, 'REPORTED');
});

test('شركة أخرى لا تُرسل مستند غيرها', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  const r = await submitDocument(h.deps, { documentId: issued.documentId, tenantId: 'tenant-other' }, { ignoreSchedule: true, gate: { live: true, pausedAt: null } });
  assert.equal(r.kind, 'skipped');
  assert.equal((r as { reason: string }).reason, 'TENANT_MISMATCH');
  assert.equal(h.fake.calls.length, 0);
});
