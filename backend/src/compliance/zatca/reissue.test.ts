// ZATCA المرحلة الثانية (Z5.4) — إعادة إصدار مستند مبسّط رفضته الهيئة (design Z5.9).
//
// الحقيقة التي تحرسها هذه الاختبارات: **الورقة عند المشتري فعلاً**. فالتصحيح مستندٌ جديد بالرقم والتاريخ نفسيهما
// (لا فاتورة ثانية ولا رقم ثانٍ)، مبنيٌّ من لقطة الإصدار لا من أسعار اليوم، بسلسلةٍ متّصلة (ICV لا يُعاد استعماله)،
// ومهلة الإبلاغ تبقى من الإصدار الأصلي — إخفاء التأخّر بتجديد المهلة كذبٌ على الإدارة (نقد 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSubmitHarness, type SubmitHarness } from './__fixtures__/z5-submit';
import { FAKE_REPLIES } from './__fixtures__/z5-fakezatca';
import { gunzipXml } from './documentStore';
import { REISSUE_REFUSAL_MESSAGES, documentFromSnapshot, reissueDecision, reissueInTx, type ReissueMirror } from './reissue';
import { submitDocument, type SubmitDone } from './submit';
import type { ZatcaSnapshotV1 } from './mapInvoice';

const done = (r: unknown): SubmitDone => {
  assert.equal((r as { kind: string }).kind, 'done', `النتيجة ليست حسماً: ${JSON.stringify(r)}`);
  return r as SubmitDone;
};

/** منصّة ترفض أوّل إبلاغ وتقبل ما بعده — الحالة التي تسبق كلّ إعادة إصدار ثمّ تنجح بعدها. */
const rejectFirst = (): SubmitHarness =>
  createSubmitHarness({ fake: { onReport: (_c, n) => (n === 1 ? FAKE_REPLIES.reject400() : undefined) } });

/** يُصدر مبسّطة ثمّ يُرسلها فتُرفض — الحالة التي تسبق كلّ إعادة إصدار. */
async function issueAndReject(h: SubmitHarness) {
  const issued = await h.issue();
  const r = done(await submitDocument(h.deps, { documentId: issued.documentId, tenantId: h.tenantId }));
  assert.equal(r.status, 'REJECTED');
  return issued;
}

async function reissue(h: SubmitHarness, issued: Awaited<ReturnType<SubmitHarness['issue']>>, attemptNo = 2) {
  const mirrors: ReissueMirror[] = [];
  const out = await reissueInTx<unknown>({ tx: true }, { chain: h.chain, documents: h.docs, now: () => h.clock.now() }, {
    tenantId: h.tenantId,
    invoiceId: issued.invoiceId,
    attemptNo,
    subtype: '02',
    snapshot: issued.result.snapshot,
    originalIssuedAt: issued.result.issuedAt,
    signing: await h.signing(),
    hooks: { remirror: async (_t, m) => { mirrors.push(m); } },
  });
  return { out, mirrors };
}

// ═══ بناء المستند من اللقطة ═══

test('اللقطة تُعاد كما هي وقيم السلسلة وحدها تُستبدَل (لا أسعار اليوم ولا بطاقة العميل اليوم)', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  const snap = issued.result.snapshot as ZatcaSnapshotV1;
  const doc = documentFromSnapshot(snap, { uuid: 'U-2', icv: 99, pih: 'P-2' });
  assert.equal(doc.uuid, 'U-2');
  assert.equal(doc.icv, 99);
  assert.equal(doc.pih, 'P-2');
  assert.equal(doc.id, issued.result.number, 'الرقم تغيّر — لا يجوز: الورقة مطبوعة بهذا الرقم');
  assert.equal(doc.issueDate, issued.result.issueDate, 'تاريخ الإصدار تغيّر');
  assert.equal(doc.issueTime, issued.result.issueTime, 'وقت الإصدار تغيّر');
  assert.deepEqual(doc.lines, (snap as unknown as { lines: unknown }).lines, 'البنود تغيّرت عن اللقطة');
  assert.ok(!('v' in doc), 'رقم نسخة اللقطة تسرّب إلى المستند');
});

// ═══ إعادة الإصدار داخل المعاملة ═══

test('محاولة ثانية: رقمٌ وتاريخٌ كما هما، وUUID/ICV/PIH جديدة، وسلسلة متّصلة', async () => {
  const h = rejectFirst();
  const issued = await issueAndReject(h);
  const before = h.doc(issued.documentId);
  const { out, mirrors } = await reissue(h, issued);

  assert.equal(out.attemptNo, 2);
  assert.equal(out.icv, before.icv + 1, 'ICV لم يتقدّم — إعادة استعماله تكسر السلسلة');
  assert.equal(out.pih, before.invoiceHash, 'PIH ليس تجزئة سابقتها — السلسلة منقطعة');
  assert.notEqual(out.uuid, issued.uuid);
  assert.equal(out.issueDate, before.issueDate, 'تاريخ المستند الجديد يخالف المطبوع');
  assert.equal(out.issueTime, before.issueTime);
  assert.equal(out.typeName, before.typeName);
  assert.equal(h.docs.units.get(h.unitId)?.lastIcv, out.icv, 'رأس السلسلة لم يتقدّم');
  assert.equal(mirrors.length, 1, 'مرآة الفاتورة لم تُحدَّث للمحاولة الجديدة');
  assert.equal(mirrors[0].einvoiceStatus, 'signed');
  assert.equal(mirrors[0].einvoiceIcv, out.icv);
  assert.equal(mirrors[0].einvoiceQr, out.qr, 'رمز المبسّطة يتغيّر مع المستند الجديد');
  assert.equal(mirrors[0].einvoiceSubmittedAt, null);
});

test('نقد 15: مهلة الإبلاغ من الإصدار الأصلي لا من الآن — التأخّر لا يُخفى بتجديد المهلة', async () => {
  const h = rejectFirst();
  const issued = await issueAndReject(h);
  const original = h.doc(issued.documentId);
  h.clock.advance(20 * 60 * 60 * 1000); // بعد عشرين ساعة
  const { out } = await reissue(h, issued);
  assert.ok(out.reportDeadline && original.reportDeadline);
  assert.equal(out.reportDeadline.getTime(), original.reportDeadline.getTime(), 'المهلة جُدّدت فاختفى التأخّر من الإدارة');
});

test('المستند الجديد مختوم وقابل للإرسال، ويُقبل فيصير المبسّطة مُبلَّغة', async () => {
  const h = rejectFirst();
  const issued = await issueAndReject(h);
  const { out } = await reissue(h, issued);
  const xml = gunzipXml(h.doc(out.documentId).xmlGz);
  assert.ok(xml.includes(out.uuid), 'المستند لا يحمل UUID الجديد');
  const r = done(await submitDocument(h.deps, { documentId: out.documentId, tenantId: h.tenantId }));
  assert.equal(r.status, 'REPORTED');
  assert.equal(r.mirror, 'reported');
});

test('المحاولة الأولى مرفوضة والثانية مقبولة: مستندان على الفاتورة نفسها بمحاولتين مختلفتين', async () => {
  const h = rejectFirst();
  const issued = await issueAndReject(h);
  const { out } = await reissue(h, issued);
  const rows = [...h.docs.documents.values()].filter(d => d.invoiceId === issued.invoiceId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(d => d.attemptNo).sort(), [1, 2]);
  assert.equal(rows.filter(d => d.status === 'REJECTED').length, 1);
  assert.equal(out.documentId !== issued.documentId, true);
});

test('رقم محاولة غير صالح يُرفض داخلياً قبل أن يُستهلك ICV', async () => {
  const h = rejectFirst();
  const issued = await issueAndReject(h);
  const icvBefore = h.docs.units.get(h.unitId)?.lastIcv;
  for (const bad of [1, 0, -1, 1.5]) {
    await assert.rejects(() => reissue(h, issued, bad), /ZATCA_INTERNAL/);
  }
  assert.equal(h.docs.units.get(h.unitId)?.lastIcv, icvBefore, 'استُهلك ICV رغم رفض المدخل');
});

// ═══ الأهليّة ═══

const invoiceView = (o: Record<string, unknown> = {}) => ({
  status: 'CONFIRMED', zatcaPhase: 2, invoiceSubtype: '02', einvoiceStatus: 'rejected',
  einvoiceSnapshot: { v: 1 }, issuedAt: new Date('2026-12-01T09:00:00Z'), ...o,
}) as Parameters<typeof reissueDecision>[0]['invoice'];

test('الأهليّة: مبسّطة مرفوضة بلقطة ومستند مرفوض — لا غير', () => {
  const ok = reissueDecision({ invoice: invoiceView(), document: { attemptNo: 1, status: 'REJECTED' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.attemptNo, 2);

  const cases: [Record<string, unknown>, { attemptNo: number; status: string } | null, string][] = [
    [{ zatcaPhase: null }, { attemptNo: 1, status: 'REJECTED' }, 'NOT_PHASE2'],
    [{ invoiceSubtype: '01' }, { attemptNo: 1, status: 'REJECTED' }, 'NOT_SIMPLIFIED'],
    [{ status: 'CANCELLED' }, { attemptNo: 1, status: 'REJECTED' }, 'NOT_CONFIRMED'],
    [{ einvoiceStatus: 'reported' }, { attemptNo: 1, status: 'REJECTED' }, 'NOT_REJECTED'],
    [{}, null, 'NO_DOCUMENT'],
    [{}, { attemptNo: 1, status: 'REPORTED' }, 'NOT_REJECTED'],
    [{ einvoiceSnapshot: null }, { attemptNo: 1, status: 'REJECTED' }, 'NO_SNAPSHOT'],
    [{ einvoiceSnapshot: { v: 2 } }, { attemptNo: 1, status: 'REJECTED' }, 'NO_SNAPSHOT'],
    [{ issuedAt: null }, { attemptNo: 1, status: 'REJECTED' }, 'NO_SNAPSHOT'],
  ];
  for (const [inv, doc, refusal] of cases) {
    const d = reissueDecision({ invoice: invoiceView(inv), document: doc });
    assert.equal(d.ok, false, refusal);
    assert.equal((d as { refusal?: string }).refusal, refusal);
    assert.equal((d as { messageAr?: string }).messageAr, REISSUE_REFUSAL_MESSAGES[refusal as keyof typeof REISSUE_REFUSAL_MESSAGES]);
  }
});

test('المحاولة التالية تُبنى على آخر محاولة لا على الأولى (لا تصادم على القيد الفريد)', () => {
  const d = reissueDecision({ invoice: invoiceView(), document: { attemptNo: 4, status: 'REJECTED' } });
  assert.equal(d.ok === true && d.attemptNo, 5);
});

test('القياسية المرفوضة لا تُعاد من هنا — أُبطلت وتُصدَر فاتورة جديدة', () => {
  const d = reissueDecision({ invoice: invoiceView({ invoiceSubtype: '01' }), document: { attemptNo: 1, status: 'REJECTED' } });
  assert.equal((d as { refusal?: string }).refusal, 'NOT_SIMPLIFIED');
  assert.ok(REISSUE_REFUSAL_MESSAGES.NOT_SIMPLIFIED.includes('تُبطل'));
});

test('كل رسالة رفض عربية ومفهومة', () => {
  for (const [code, msg] of Object.entries(REISSUE_REFUSAL_MESSAGES)) {
    assert.ok(msg.length > 10 && /[؀-ۿ]/.test(msg), code);
  }
  assert.ok(FAKE_REPLIES.reject400, 'تجهيزة الرفض مفقودة');
});
