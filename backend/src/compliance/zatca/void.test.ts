// ZATCA المرحلة الثانية (Z5.4) — قواعد إبطال المرفوضة وسحب المعلّقة (نقيّة).
//
// ما تحرسه هذه الاختبارات:
//   ١) **المبسّطة لا تُبطل أبداً**: ورقتها عند المشتري فعلاً؛ إبطالها يمحو ديناً حقيقياً ويعيد بضاعةً لم تعد.
//   ٢) نقد 7: المرآة `rejected` تُكتب **قبل** الخطّاف في المعاملة نفسها — فلو اشترط القرارُ مرآةً «معلّقة» لما
//      أُبطلت فاتورةٌ واحدة أبداً. لذلك rejected/withdrawn ضمن المرايا التي يجوز الإبطال منها.
//   ٣) قرار المالك Q1: النقدية المرفوضة يُعكس شقّ الفاتورة وحده — التحصيل لا يُعكس، ويبقى رصيداً دائناً للعميل.
//   ٤) نقد 11: السحب **دليلٌ لا ظنّ**: أيّ محاولة قد تكون وصلت الهيئة تمنعه، والمهلة وانقطاع الشبكة يُحسبان «قد وصلت».
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOT_RECEIVED_HTTP_STATUSES, VOIDABLE_MIRRORS, VOID_NOTIFICATION_TYPES, WITHDRAWABLE_DOCUMENT_STATUSES,
  WITHDRAWABLE_MIRRORS, WITHDRAW_REFUSAL_MESSAGES, reversalKindOf, voidDecision, voidNotificationText, withdrawDecision,
  type VoidableInvoiceRow, type WithdrawDocumentView, type WithdrawInvoiceView,
} from './void';
import { DOCUMENT_STATUSES, FINAL_DOCUMENT_STATUSES, INVOICE_MIRROR_STATUSES, type DocumentStatus } from './status';

const NOW = new Date('2026-12-01T10:00:00.000Z');
const TENANT = 't-1';

const invoiceRow = (o: Partial<VoidableInvoiceRow> = {}): VoidableInvoiceRow => ({
  id: 'inv-1', tenantId: TENANT, status: 'CONFIRMED', type: 'CREDIT', zatcaPhase: 2, invoiceSubtype: '01',
  einvoiceStatus: 'rejected', customerId: 'c-1', total: 115, ...o,
});

// ═══ الإبطال ═══

test('القياسية المرفوضة تُبطل، والمبسّطة لا تُبطل أبداً (ورقتها مع المشتري)', () => {
  assert.deepEqual(voidDecision(invoiceRow(), { tenantId: TENANT, subtype: '01' }), { ok: true, reversal: 'CREDIT' });
  assert.deepEqual(
    voidDecision(invoiceRow({ invoiceSubtype: '02' }), { tenantId: TENANT, subtype: '02' }),
    { ok: false, refusal: 'SIMPLIFIED_KEPT' },
  );
});

test('نقد 7: الإبطال يجوز من المرآة المكتوبة توّاً (rejected) — وإلّا لم تُبطل فاتورةٌ أبداً', () => {
  for (const m of VOIDABLE_MIRRORS) {
    assert.deepEqual(voidDecision(invoiceRow({ einvoiceStatus: m }), { tenantId: TENANT, subtype: '01' }), { ok: true, reversal: 'CREDIT' }, m);
  }
  assert.ok(VOIDABLE_MIRRORS.includes('rejected'), 'المرآة التي يكتبها المحرّك قبل الخطّاف ليست ضمن المسموح');
  for (const m of INVOICE_MIRROR_STATUSES) {
    if (VOIDABLE_MIRRORS.includes(m)) continue;
    assert.deepEqual(
      voidDecision(invoiceRow({ einvoiceStatus: m }), { tenantId: TENANT, subtype: '01' }),
      { ok: false, refusal: 'MIRROR_NOT_VOIDABLE' }, m,
    );
  }
});

test('المرآة الفارغة (NULL) تمرّ: فاتورةٌ كُتبت قبل المرآة لا تُترك قائمةً بعد رفضها', () => {
  assert.deepEqual(voidDecision(invoiceRow({ einvoiceStatus: null }), { tenantId: TENANT, subtype: '01' }), { ok: true, reversal: 'CREDIT' });
});

test('الحرّاس: صفّ مفقود، شركة أخرى، مرحلة أولى، فاتورة ملغاة سلفاً', () => {
  assert.deepEqual(voidDecision(null, { tenantId: TENANT, subtype: '01' }), { ok: false, refusal: 'NOT_FOUND' });
  assert.deepEqual(voidDecision(invoiceRow({ tenantId: 'other' }), { tenantId: TENANT, subtype: '01' }), { ok: false, refusal: 'TENANT_MISMATCH' });
  for (const p of [null, 1]) {
    assert.deepEqual(voidDecision(invoiceRow({ zatcaPhase: p }), { tenantId: TENANT, subtype: '01' }), { ok: false, refusal: 'NOT_PHASE2' }, String(p));
  }
  assert.deepEqual(voidDecision(invoiceRow({ status: 'CANCELLED' }), { tenantId: TENANT, subtype: '01' }), { ok: false, refusal: 'NOT_CONFIRMED' });
});

test('قرار المالك Q1: النقدية تُعكس بشقّ الفاتورة وحده والتحصيل يبقى رصيداً دائناً', () => {
  assert.equal(reversalKindOf('CASH'), 'CASH_KEEP_COLLECTION');
  assert.equal(reversalKindOf('CREDIT'), 'CREDIT');
  assert.equal(reversalKindOf('RETURN'), 'RETURN');
  const d = voidDecision(invoiceRow({ type: 'CASH' }), { tenantId: TENANT, subtype: '01' });
  assert.deepEqual(d, { ok: true, reversal: 'CASH_KEEP_COLLECTION' });
  // المقسَّطة آجلةٌ بجدول لا نوعٌ رابع — تُعكس عكس الآجلة
  assert.deepEqual(voidDecision(invoiceRow({ type: 'CREDIT' }), { tenantId: TENANT, subtype: '01' }), { ok: true, reversal: 'CREDIT' });
});

test('الإشعار يُسمّي السبب ويبقى مهمّةً مفتوحة حتى يُصدَر البديل (نقد 14)', () => {
  const rejected = voidNotificationText('REJECTED', 'INV-2612-000007');
  assert.ok(rejected.body.includes('INV-2612-000007'));
  assert.ok(/أصدر فاتورة (جديدة|بديلة)/.test(rejected.body));
  const withdrawn = voidNotificationText('WITHDRAWN', 'INV-2612-000008');
  assert.ok(withdrawn.title.includes('سحب'));
  assert.ok(withdrawn.body.includes('INV-2612-000008'));
  assert.notEqual(VOID_NOTIFICATION_TYPES.REJECTED, VOID_NOTIFICATION_TYPES.WITHDRAWN);
});

// ═══ السحب (نقد 11) ═══

const doc = (o: Partial<WithdrawDocumentView> = {}): WithdrawDocumentView =>
  ({ status: 'CONFIG_ERROR', flow: 'CLEARANCE', firstSubmitAt: null, leaseUntil: null, ...o });
const inv = (o: Partial<WithdrawInvoiceView> = {}): WithdrawInvoiceView =>
  ({ status: 'CONFIRMED', zatcaPhase: 2, invoiceSubtype: '01', einvoiceStatus: 'clearance_blocked', ...o });

const decide = (o: {
  invoice?: Partial<WithdrawInvoiceView>; document?: Partial<WithdrawDocumentView> | null; attempts?: number; logged?: number;
} = {}) =>
  withdrawDecision({
    invoice: inv(o.invoice ?? {}),
    document: o.document === null ? null : doc(o.document ?? {}),
    possiblyDeliveredAttempts: o.attempts ?? 0,
    loggedAttempts: o.logged ?? 0,
    now: NOW,
  });

test('السحب يمرّ حين لم تُرسل قطّ، ويُسمّي دليله', () => {
  const d = decide();
  assert.deepEqual(d, { ok: true, proof: 'NEVER_SENT' });
});

test('أُرسلت مرّةً قد تكون وصلت ⇒ لا سحب (السحب بعد الوصول مخالفة)', () => {
  const d = decide({ document: { firstSubmitAt: new Date(NOW.getTime() - 60_000) }, attempts: 1 });
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.refusal, 'MAY_HAVE_BEEN_RECEIVED');
});

test('أُرسلت ولم تصل قطّ (401/403/429 فقط) ⇒ سحبٌ بدليل ALL_ATTEMPTS_REFUSED: كل محاولة لها سجلّها', () => {
  const d = decide({ document: { sentAttempts: 2, firstSubmitAt: new Date(NOW.getTime() - 60_000) }, attempts: 0, logged: 2 });
  assert.deepEqual(d, { ok: true, proof: 'ALL_ATTEMPTS_REFUSED' });
  assert.deepEqual([...NOT_RECEIVED_HTTP_STATUSES].sort(), [401, 403, 429]);
});

/* مراجعة عدائية: العملية ماتت بعد إرسال البايتات وقبل الردّ (نشر Render) — لا صفّ سجلّ يُخلَّف، والمستند يحمل
 * أثر الإرسال. السحب هنا قد يُبطل فاتورةً اعتمدتها الهيئة فعلاً، فيُرفض. */
test('محاولةٌ غادرت ولم تخلّف سجلّاً (موت العملية) ⇒ لا سحب ولو كان عدّ «قد وصلت» صفراً', () => {
  const d = decide({ document: { sentAttempts: 1, firstSubmitAt: new Date(NOW.getTime() - 120_000) }, attempts: 0, logged: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.refusal, 'MAY_HAVE_BEEN_RECEIVED');
  // ولو نقص سجلٌّ واحد عن عدّاد ما غادر
  const partial = decide({ document: { sentAttempts: 3, firstSubmitAt: new Date(NOW.getTime() - 120_000) }, attempts: 0, logged: 2 });
  assert.equal(partial.ok, false);
});

/* مراجعة عدائية ٢ (النتائج 3/4/8): `attempts` يرفعه الاستيلاء **قبل** أيّ فحص، وكلّ حسمٍ محلّيّ يعود بلا نداء ولا
 * سجلّ. لو كان هو الدليل لبقيت الفاتورة القياسية محبوسةً أبداً: لا سحب، ولا موعد استرداد (الاعتماد null)، ولا
 * إعادة إصدار (01). الدليل الآن ما غادر فعلاً — وهذه هي الحالات التشغيلية بعينها. */
test('حُسم محلياً بعد الاستيلاء (شهادة مجدَّدة أو بيانات اعتماد ناقصة) ⇒ لم يغادر شيء ⇒ NEVER_SENT', () => {
  // STALE_KEY بعد تجديد الشهادة: claim رفع attempts وضبط firstSubmitAt، ولا نداء ولا سجلّ
  const stale = decide({ document: { status: 'CONFIG_ERROR', sentAttempts: 0, firstSubmitAt: new Date(NOW.getTime() - 3_600_000) } });
  assert.deepEqual(stale, { ok: true, proof: 'NEVER_SENT' });
  // وبعد إعادةٍ يدوية ثانية (استيلاء آخر بلا نداء) لا يتغيّر الحكم
  const retried = decide({ document: { status: 'CONFIG_ERROR', sentAttempts: 0, firstSubmitAt: new Date(NOW.getTime() - 3_600_000) }, logged: 0 });
  assert.deepEqual(retried, { ok: true, proof: 'NEVER_SENT' });
  // 401 حقيقيّ (سجلّ واحد) ثمّ استيلاءٌ أُجّل بلا نداء ⇒ كلّ ما غادر رُدّ برفضٍ يُثبت عدم المعالجة
  const auth = decide({ document: { status: 'AUTH_BLOCKED', sentAttempts: 1, firstSubmitAt: new Date(NOW.getTime() - 600_000) }, logged: 1 });
  assert.deepEqual(auth, { ok: true, proof: 'ALL_ATTEMPTS_REFUSED' });
});

/* الوسم يسبق النداء، لكنّه قد يسقط (عطل قاعدة) بينما النداء جرى وخلّف سجلّاً: السجلّ أثبتُ من غياب الوسم — لا
 * يُقال «لم يُرسل قطّ» وفي السجلّ ردّ من الهيئة. */
test('سجلٌّ بلا وسم إرسال ⇒ ليس NEVER_SENT', () => {
  const d = decide({ document: { sentAttempts: 0, firstSubmitAt: NOW }, attempts: 0, logged: 1 });
  assert.equal(d.ok, true);
  assert.equal(d.ok === true && d.proof, 'ALL_ATTEMPTS_REFUSED');
  // وردٌّ قد يكون وصل يبقى مانعاً مطلقاً
  const delivered = decide({ document: { sentAttempts: 0, firstSubmitAt: NOW }, attempts: 1, logged: 1 });
  assert.equal(delivered.ok, false);
});

test('مستند يرسله عاملٌ الآن (عقدٌ حيّ) ⇒ لا سحب من تحته، ولا بعد انقضاء عقده', () => {
  const d = decide({ document: { status: 'SUBMITTING', leaseUntil: new Date(NOW.getTime() + 30_000) } });
  assert.equal(d.ok === false && d.refusal, 'IN_FLIGHT');
  // عقدٌ منتهٍ: البايتات غادرت فعلاً (SUBMITTING) — يُترك للمسح حتى يحسمه ردّ الهيئة أو تكرارها، ولا يُسحب
  const expired = decide({ document: { status: 'SUBMITTING', sentAttempts: 1, firstSubmitAt: NOW, leaseUntil: new Date(NOW.getTime() - 1) } });
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.refusal, 'MAY_HAVE_BEEN_RECEIVED');
  assert.equal(WITHDRAWABLE_DOCUMENT_STATUSES.includes('SUBMITTING' as DocumentStatus), false, 'SUBMITTING ليست حالة سحب');
});

test('كل حالة نهائية ⇒ DOCUMENT_FINAL، وحالات السحب هي غير النهائية عدا قيد الإرسال', () => {
  for (const s of FINAL_DOCUMENT_STATUSES) {
    const d = decide({ document: { status: s } });
    assert.equal(d.ok, false, s);
    assert.equal((d as { refusal?: string }).refusal, 'DOCUMENT_FINAL', s);
  }
  for (const s of DOCUMENT_STATUSES) {
    const final = (FINAL_DOCUMENT_STATUSES as readonly string[]).includes(s);
    assert.equal(WITHDRAWABLE_DOCUMENT_STATUSES.includes(s as DocumentStatus), !final && s !== 'SUBMITTING', s);
  }
});

test('الحرّاس: مرحلة أولى، مبسّطة، ملغاة، مرآة ليست معلّقة، بلا مستند', () => {
  assert.equal((decide({ invoice: { zatcaPhase: null } }) as { refusal?: string }).refusal, 'NOT_PHASE2');
  assert.equal((decide({ invoice: { invoiceSubtype: '02' } }) as { refusal?: string }).refusal, 'NOT_STANDARD');
  assert.equal((decide({ invoice: { status: 'CANCELLED' } }) as { refusal?: string }).refusal, 'NOT_CONFIRMED');
  assert.equal((decide({ invoice: { einvoiceStatus: 'cleared' } }) as { refusal?: string }).refusal, 'MIRROR_NOT_PENDING');
  assert.equal((decide({ invoice: { einvoiceStatus: null } }) as { refusal?: string }).refusal, 'MIRROR_NOT_PENDING');
  assert.equal((decide({ document: null }) as { refusal?: string }).refusal, 'NO_DOCUMENT');
});

test('المرايا التي يُسحب منها هي المعلّقة وحدها — لا معتمدة ولا مُبلَّغة', () => {
  assert.deepEqual([...WITHDRAWABLE_MIRRORS].sort(), ['clearance_blocked', 'clearance_pending']);
  for (const m of WITHDRAWABLE_MIRRORS) assert.equal(decide({ invoice: { einvoiceStatus: m } }).ok, true, m);
});

test('لكل سبب رفض رسالةٌ عربية مفهومة (تصل المستخدم كما هي)', () => {
  for (const [code, msg] of Object.entries(WITHDRAW_REFUSAL_MESSAGES)) {
    assert.ok(msg.length > 10 && /[؀-ۿ]/.test(msg), code);
  }
});
