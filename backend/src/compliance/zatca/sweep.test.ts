// ZATCA المرحلة الثانية (Z5.3) — اختبارات المسح الدوري: كلفة الخمول، والعدل بين الوحدات، واستبعاد الشركات الموقوفة،
// وحصص التزامن ومقعد الطلب الحيّ، وإيقاف 429 لوحدة واحدة، ودرجات تنبيه التأخّر مرّةً لكل درجة، ومفتاح الإطفاء وتشغيلٌ واحد.
// لا شبكة ولا قاعدة بيانات: مخزن ذاكرة ومنصّة «فاتورة» مزيّفة.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryZatcaDocumentStore, type MemoryZatcaDocumentStore, type SignedDocumentInput } from './documentStore';
import { createSubmitHarness, type SubmitHarness } from './__fixtures__/z5-submit';
import { FAKE_REPLIES } from './__fixtures__/z5-fakezatca';
import {
  MAX_OVERDUE_LEVEL, OVERDUE_LEVEL_1_BEFORE_MS, SubmitSlots, ZatcaSweepRunner, isBusy, newSweepState, overdueDocumentLabel,
  overdueLevelFor, overdueNotification, runOverduePass, runZatcaSweep, sweepEnabled, sweepIntervalMs,
} from './sweep';
import { SUBMIT_UNIT_STATUSES } from './submit';

const HOUR = 3_600_000;
const T0 = new Date('2026-12-01T09:00:00.000Z');

// ═══ الاستيلاء الجماعي: العدل والاستبعاد (نقد 16) ═══

function syntheticStore(now: () => Date): MemoryZatcaDocumentStore {
  return memoryZatcaDocumentStore({ now });
}

function addUnit(store: MemoryZatcaDocumentStore, id: string, status = 'ACTIVE', tenantId = 'tenant-a'): void {
  store.units.set(id, {
    id, tenantId, status, environment: 'production', keyVersion: 1, vatNumber: '399999999900003', lastIcv: 0,
    lastInvoiceHash: null, updatedAt: T0,
  });
}

async function addDoc(store: MemoryZatcaDocumentStore, unitId: string, icv: number, over: Partial<SignedDocumentInput> = {}): Promise<string> {
  const unit = store.units.get(unitId);
  const doc: SignedDocumentInput = {
    tenantId: unit?.tenantId ?? 'tenant-a', egsUnitId: unitId, invoiceId: `inv-${unitId}-${icv}`, attemptNo: 1, icv,
    uuid: `${unitId}-${icv}-0000-0000-000000000000`.slice(0, 36), pih: 'PIH', invoiceHash: 'HASH', typeCode: '388',
    typeName: '0200000', issueDate: '2026-12-01', issueTime: '12:00:00', xml: `<Invoice>${unitId}-${icv}</Invoice>`,
    qr: 'QR', issuedAt: T0, keyVersion: 1, ...over,
  };
  const r = await store.insertSigned(null, doc);
  return r.id;
}

test('الاستيلاء الجماعي عادل بين الوحدات (حدّ لكل وحدة) ويستبعد الشركات الموقوفة والوحدات خارج حالات الإرسال', async () => {
  const store = syntheticStore(() => T0);
  addUnit(store, 'unit-a');
  addUnit(store, 'unit-b');
  addUnit(store, 'unit-paused', 'ACTIVE', 'tenant-paused');
  addUnit(store, 'unit-draft', 'CSR_READY');
  for (let i = 1; i <= 5; i++) await addDoc(store, 'unit-a', i);
  for (let i = 1; i <= 5; i++) await addDoc(store, 'unit-b', i);
  await addDoc(store, 'unit-paused', 1);
  await addDoc(store, 'unit-draft', 1);
  store.pausedTenants.add('tenant-paused');

  const batch = await store.claimBatch({ limit: 10, perUnit: 2, leaseMs: 60_000, unitStatuses: SUBMIT_UNIT_STATUSES, excludePausedTenants: true });
  const byUnit = new Map<string, number[]>();
  for (const c of batch) byUnit.set(c.egsUnitId, [...(byUnit.get(c.egsUnitId) ?? []), c.icv]);
  assert.equal(batch.length, 4, 'وحدتان × مستندان');
  assert.deepEqual(byUnit.get('unit-a'), [1, 2]);
  assert.deepEqual(byUnit.get('unit-b'), [1, 2]);
  assert.equal(byUnit.has('unit-paused'), false, 'شركة موقوفة لا يُستولى على مستنداتها');
  assert.equal(byUnit.has('unit-draft'), false, 'وحدة خارج حالات الإرسال لا تُستولى');
  // المستندات غير المُستولى عليها لم تُمسّ (لا محاولة ولا عقد)
  const paused = [...store.documents.values()].find(d => d.egsUnitId === 'unit-paused');
  assert.equal(paused?.status, 'SIGNED');
  assert.equal(paused?.attempts, 0);
});

test('عاملان متزامنان لا يأخذان المستند نفسه', async () => {
  const store = syntheticStore(() => T0);
  addUnit(store, 'unit-a');
  for (let i = 1; i <= 6; i++) await addDoc(store, 'unit-a', i);
  const opts = { limit: 3, perUnit: 6, leaseMs: 60_000, unitStatuses: SUBMIT_UNIT_STATUSES };
  const [one, two] = await Promise.all([store.claimBatch(opts), store.claimBatch(opts)]);
  const ids = new Set([...one, ...two].map(c => c.id));
  assert.equal(ids.size, one.length + two.length, 'لا تقاطع بين العاملين');
});

test('الوحدات المتوقّفة (مسحوبة/منتهية/موقوفة التفويض) تُصرَّف مستنداتها', async () => {
  const store = syntheticStore(() => T0);
  addUnit(store, 'unit-revoked', 'REVOKED');
  addUnit(store, 'unit-expired', 'EXPIRED');
  addUnit(store, 'unit-auth', 'AUTH_FAILED');
  await addDoc(store, 'unit-revoked', 1);
  await addDoc(store, 'unit-expired', 1);
  await addDoc(store, 'unit-auth', 1);
  const batch = await store.claimBatch({ limit: 10, perUnit: 5, leaseMs: 60_000, unitStatuses: SUBMIT_UNIT_STATUSES });
  assert.equal(batch.length, 3);
});

// ═══ الدورة ═══

test('دورة خاملة = استعلام واحد بالضبط، ولا جولة تأخّر قبل رؤية أي مستند', async () => {
  const h = createSubmitHarness();
  const state = newSweepState();
  const r = await runZatcaSweep(h.deps, {}, state);
  assert.equal(r.claimed, 0);
  assert.equal(r.batches, 0);
  assert.equal(r.queries, 1);
  assert.equal(r.overdueChecked, false);
  assert.equal(h.queries.claimBatch, 1);
  assert.equal(h.queries.gate, 0);
  assert.equal(h.queries.overdue, 0);
  assert.equal(h.queries.total, 1);
});

test('الدورة تستولي وترسل وتبثّ، وجولة التأخّر تُفحص بعد دفعة غير فارغة ثم كل N دورة', async () => {
  const h = createSubmitHarness();
  await h.issue();
  await h.issue();
  await h.issue();
  const state = newSweepState();
  const r = await runZatcaSweep(h.deps, { limit: 10, overdueEveryTicks: 3 }, state);

  assert.equal(r.claimed, 3);
  assert.equal(r.submitted, 3);
  assert.equal(r.byStatus.REPORTED, 3);
  assert.equal(r.batches, 1);
  assert.equal(h.queries.claimBatch, 2, 'دفعة ثم دفعة فارغة تكسر الحلقة');
  assert.equal(h.queries.gate, 1, 'بوّابة الشركة تُقرأ مرّة لكل شركة');
  assert.equal(r.overdueChecked, true);
  assert.equal(h.published.length, 3);
  for (const d of h.docs.documents.values()) assert.equal(d.status, 'REPORTED');

  // دورة خاملة تالية: لا جولة تأخّر (الدورة ليست من مضاعفات N)
  const idle = await runZatcaSweep(h.deps, { limit: 10, overdueEveryTicks: 3 }, state);
  assert.equal(idle.queries, 1);
  assert.equal(idle.overdueChecked, false);
  // الدورة الثالثة: تُفحص
  const third = await runZatcaSweep(h.deps, { limit: 10, overdueEveryTicks: 3 }, state);
  assert.equal(third.overdueChecked, true);
});

test('429 على وحدة يوقفها وحدها: بقيّة مستنداتها تُؤجَّل بلا استدعاء', async () => {
  // حصّة مسحٍ واحدة (سقف 2 ⇒ مقعد للحيّ ومقعد للمسح): الإرسال متتابع فيظهر أثر الإيقاف على التالي مباشرة
  const h = createSubmitHarness({
    slots: new SubmitSlots({ total: 2 }), fake: { onReport: (_c, n) => (n === 1 ? FAKE_REPLIES.rate429(60) : undefined) },
  });
  await h.issue();
  await h.issue();
  await h.issue();
  const r = await runZatcaSweep(h.deps, { limit: 10 });
  assert.equal(r.claimed, 3);
  assert.equal(h.fake.calls.length, 1, 'استدعاء واحد فقط ثم الإيقاف');
  assert.equal(r.deferred, 2);
  for (const d of h.docs.documents.values()) {
    assert.equal(d.status, 'RETRY_WAIT');
    assert.ok((d.nextAttemptAt as Date).getTime() >= h.clock.now().getTime());
  }
});

test('فشل مستند لا يُسقط الدورة', async () => {
  const h = createSubmitHarness();
  const good = await h.issue();
  const bad = await h.issue();
  const original = h.docs.loadDocumentXml.bind(h.docs);
  (h.deps.documents as { loadDocumentXml: (id: string) => Promise<unknown> }).loadDocumentXml = async (id: string) => {
    if (id === bad.documentId) throw new Error('boom');
    return original(id);
  };
  const r = await runZatcaSweep(h.deps, { limit: 10 });
  assert.equal(r.claimed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.submitted, 1);
  assert.equal(h.doc(good.documentId).status, 'REPORTED');
});

// ═══ الحصص ═══

test('الحصص: المسح لا يتجاوز سقفه، ومقعد الطلب الحيّ محجوز ويسبق طابور المسح', async () => {
  const slots = new SubmitSlots({ total: 2 });
  assert.equal(slots.sweepMax, 1);
  const order: string[] = [];
  const release: Array<() => void> = [];
  const task = (name: string, kind: 'inline' | 'sweep') => slots.run(kind, async () => {
    order.push(name);
    await new Promise<void>(res => release.push(res));
  });

  const a = task('sweep-a', 'sweep');
  const b = task('sweep-b', 'sweep');
  const c = task('inline-c', 'inline');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['sweep-a', 'inline-c'], 'المسح واحد، والحيّ يأخذ المقعد الثاني');
  assert.equal(slots.inFlight, 2);
  assert.equal(slots.sweepInFlight, 1);

  const d = task('inline-d', 'inline');
  await Promise.resolve();
  assert.deepEqual(order, ['sweep-a', 'inline-c'], 'لا مقعد ثالث');

  release.shift()!(); // ينتهي sweep-a
  await a;
  await new Promise(res => setImmediate(res));
  assert.equal(order[2], 'inline-d', 'الحيّ المنتظر يسبق المسح المنتظر');

  // تصريف: كل تحرير قد يُدخل منتظراً جديداً يُضيف تحريره بدوره
  for (let i = 0; i < 20 && slots.inFlight > 0; i++) {
    while (release.length) release.shift()!();
    await new Promise(res => setImmediate(res));
  }
  await Promise.all([b, c, d]);
  assert.equal(slots.inFlight, 0);
  assert.equal(slots.sweepInFlight, 0);
});

test('دورة المسح لا تتجاوز حصّتها أثناء التنفيذ', async () => {
  const slots = new SubmitSlots({ total: 3 });
  const h = createSubmitHarness({ slots });
  for (let i = 0; i < 6; i++) await h.issue();
  let peak = 0;
  const original = h.docs.loadDocumentXml.bind(h.docs);
  (h.deps.documents as { loadDocumentXml: (id: string) => Promise<unknown> }).loadDocumentXml = async (id: string) => {
    peak = Math.max(peak, slots.sweepInFlight);
    await new Promise(res => setImmediate(res));
    return original(id);
  };
  const r = await runZatcaSweep(h.deps, { limit: 10, perUnit: 10 });
  assert.equal(r.submitted, 6);
  assert.ok(peak <= slots.sweepMax, `الذروة ${peak} ≤ ${slots.sweepMax}`);
});

// ═══ تنبيهات التأخّر ═══

test('درجات التأخّر: 12 ساعة ثمّ 4 ثمّ الفوات، كلٌّ مرّة واحدة، والمالك من الدرجة الثانية', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.server503() } });
  const issued = await h.issue();
  await runZatcaSweep(h.deps, { limit: 5 });
  const deadline = h.doc(issued.documentId).reportDeadline as Date;
  assert.ok(deadline);

  const at = (msBefore: number): Date => new Date(deadline.getTime() - msBefore);
  assert.equal(overdueLevelFor(deadline, at(13 * HOUR)), 0);
  assert.equal(overdueLevelFor(deadline, at(11 * HOUR)), 1);
  assert.equal(overdueLevelFor(deadline, at(3 * HOUR)), 2);
  assert.equal(overdueLevelFor(deadline, at(-HOUR)), MAX_OVERDUE_LEVEL);

  const alerts = () => h.notifications.filter(n => n.kind === 'OVERDUE');
  // قبل الدرجة الأولى: لا شيء
  assert.equal((await runOverduePass(h.deps, { now: at(13 * HOUR), limit: 10 })).alerts, 0);
  assert.equal(alerts().length, 0);

  assert.equal((await runOverduePass(h.deps, { now: at(11 * HOUR), limit: 10 })).alerts, 1);
  assert.equal((await runOverduePass(h.deps, { now: at(10 * HOUR), limit: 10 })).alerts, 0, 'الدرجة نفسها لا تتكرّر');
  assert.equal(h.doc(issued.documentId).overdueAlertLevel, 1);
  assert.equal(alerts()[0].owner, false);

  assert.equal((await runOverduePass(h.deps, { now: at(3 * HOUR), limit: 10 })).alerts, 1);
  assert.equal(h.doc(issued.documentId).overdueAlertLevel, 2);
  assert.equal(alerts()[1].owner, true);

  assert.equal((await runOverduePass(h.deps, { now: at(-HOUR), limit: 10 })).alerts, 1);
  assert.equal(h.doc(issued.documentId).overdueAlertLevel, 3);
  assert.equal(alerts()[2].level, 3);
  assert.equal((await runOverduePass(h.deps, { now: at(-2 * HOUR), limit: 10 })).alerts, 0, 'بعد الدرجة الثالثة لا تنبيه رابع');
});

test('المستند المحسوم لا يُنبَّه عنه، والقياسية بلا مهلة لا تدخل الجولة', async () => {
  const h = createSubmitHarness();
  const simple = await h.issue();
  const standard = await h.issue({ standard: true });
  await runZatcaSweep(h.deps, { limit: 5 });
  assert.equal(h.doc(simple.documentId).status, 'REPORTED');
  assert.equal(h.doc(standard.documentId).status, 'CLEARED');
  const deadline = h.doc(simple.documentId).reportDeadline as Date;
  const r = await runOverduePass(h.deps, { now: new Date(deadline.getTime() + HOUR), limit: 10 });
  assert.equal(r.alerts, 0);
  assert.equal(r.scanned, 0);
  assert.equal(h.doc(standard.documentId).reportDeadline, null);
});

/* مراجعة عدائية: جولة التأخّر كانت محروسةً بعلمٍ في الذاكرة لا يُضبط إلا بدفعة استيلاء غير فارغة — فالشركة الموقوفة
 * (مستنداتها مستبعَدة من الاستيلاء في SQL) أو خادمٌ أُعيد نشره لا يريان شيئاً، فتمضي الـ24 ساعة بلا تنبيه واحد:
 * التنبيه يعمل حين لا يُحتاج إليه، ويصمت حين يُحتاج. */
test('التأخّر يُفحص ولو لم يُستولَ على شيء قطّ: شركة موقوفة وخادمٌ أُعيد تشغيله', async () => {
  const h = createSubmitHarness();
  const issued = await h.issue();
  h.docs.pausedTenants.add(h.tenantId);
  h.clock.advance(25 * HOUR);

  const state = newSweepState(); // حالة فريش = إعادة نشر
  let alerts = 0;
  let claimed = 0;
  for (let i = 0; i < 10; i++) {
    const r = await runZatcaSweep(h.deps, { limit: 5, overdueEveryTicks: 10 }, state);
    alerts += r.overdueAlerts;
    claimed += r.claimed;
  }
  assert.equal(claimed, 0, 'استُولي على مستند شركة موقوفة');
  assert.equal(state.sawDocuments, false, 'العلم لم يُضبط — وهذا بيت القصيد');
  assert.equal(alerts, 1, 'مضت 24 ساعة على مستند ولم يصل تنبيه واحد');
  assert.equal(h.doc(issued.documentId).overdueAlertLevel, MAX_OVERDUE_LEVEL);
  const note = h.notifications.find(n => n.kind === 'OVERDUE');
  assert.ok(note && note.owner && note.level === MAX_OVERDUE_LEVEL);
});

test('نصّ التنبيه يسمّي نوع المستند: القياسية المُحوَّلة للإبلاغ بعد 303 ليست «مبسّطة»', () => {
  const at = new Date(T0.getTime());
  const base = {
    id: 'd', tenantId: 'tenant-a', egsUnitId: 'u', invoiceId: 'i', status: 'SIGNED', flow: 'REPORTING' as const,
    icv: 1, reportDeadline: new Date(at.getTime() - HOUR), overdueAlertLevel: 0,
  };
  assert.equal(overdueDocumentLabel('0200000'), 'فاتورة مبسّطة');
  assert.ok(overdueNotification({ ...base, typeName: '0100000' }, 3, at).bodyAr.includes('فاتورة ضريبية'));
  assert.ok(!overdueNotification({ ...base, typeName: '0100000' }, 3, at).bodyAr.includes('مبسّطة'));
  assert.ok(overdueNotification({ ...base, typeName: '0200000' }, 1, at).bodyAr.includes('مبسّطة'));
});

test('نافذة الجولة 12 ساعة: لا يُقرأ مستند مهلته أبعد', async () => {
  const h = createSubmitHarness({ fake: { onReport: () => FAKE_REPLIES.server503() } });
  const issued = await h.issue();
  await runZatcaSweep(h.deps, { limit: 5 });
  const deadline = h.doc(issued.documentId).reportDeadline as Date;
  const far = new Date(deadline.getTime() - OVERDUE_LEVEL_1_BEFORE_MS - 60_000);
  assert.equal((await runOverduePass(h.deps, { now: far, limit: 10 })).scanned, 0);
});

// ═══ المشغّل ومفاتيح البيئة ═══

test('تشغيل واحد في كل لحظة (لا تراكب)', async () => {
  const h: SubmitHarness = createSubmitHarness();
  await h.issue();
  const runner = new ZatcaSweepRunner(h.deps, { limit: 5 });
  const first = runner.runOnce();
  const second = await runner.runOnce();
  assert.ok(isBusy(second), 'الدورة الثانية تُلغى ما دامت الأولى تعمل');
  const r = await first;
  assert.ok(!isBusy(r));
  assert.equal((r as { claimed: number }).claimed, 1);
  assert.equal(runner.isRunning, false);
  assert.equal(runner.lastReport?.submitted, 1);
});

test('مفتاح الإطفاء والفترة: الافتراضات آمنة بلا أي متغيّر بيئة', () => {
  assert.equal(sweepEnabled({}), true);
  assert.equal(sweepEnabled({ ZATCA_SWEEP_ENABLED: 'false' }), false);
  assert.equal(sweepEnabled({ ZATCA_SWEEP_ENABLED: '0' }), false);
  assert.equal(sweepEnabled({ ZATCA_SWEEP_ENABLED: 'true' }), true);
  assert.equal(sweepIntervalMs({}), 60_000);
  assert.equal(sweepIntervalMs({ ZATCA_SWEEP_INTERVAL_MS: '1000' }), 60_000, 'أقلّ من الحدّ الأدنى ⇒ الافتراضي');
  assert.equal(sweepIntervalMs({ ZATCA_SWEEP_INTERVAL_MS: '120000' }), 120_000);
  assert.equal(sweepIntervalMs({ ZATCA_SWEEP_INTERVAL_MS: 'abc' }), 60_000);
});

test('المؤقّت يبدأ ويتوقّف بلا تسريب', async () => {
  const h = createSubmitHarness();
  const runner = new ZatcaSweepRunner(h.deps, { limit: 5 });
  runner.start(10_000);
  runner.start(10_000); // لا مؤقّت ثانٍ
  runner.stop();
  runner.stop();
  assert.equal(runner.isRunning, false);
});
