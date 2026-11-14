// مهمة معاينة «ربط الدفاتر» (P5 — العقد scratchpad/l23_contract.md §14.2 و§17 P5):
//   دورة المهمة بـrunPreview مزيّف (QUEUED ⇒ RUNNING ⇒ DONE/FAILED)، الجارية تُعاد، حدّ المعدّل، المفعّلة، النبض المتقادم
//   ⇒ INTERRUPTED، المهلة ⇒ TIMEOUT، طابور واحد على المنصّة، قصّ النتيجة ≤ PREVIEW_RESULT_MAX_BYTES، وتفريغ result لما بعد
//   الخمس الأخيرة عدا المعتمدة — وتجسّس: لا كتابة إلا gl_link_previews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  capResult, getPreview, jobFailureCodeOf, listPreviews, previewWorkerIdle, pruneOldResults, startPreview, PreviewJobTimeoutError,
  PROTECTED_LIST_FRACTION, type PreviewJobDeps,
} from '../services/gl/linking/jobs';
import { PREVIEW_ERROR_MESSAGES, PreviewRunError } from '../services/gl/linking/preview';
import { ShadowGlAccessError } from '../services/gl/linking/shadowClient';
import { ShadowTooLargeError } from '../services/gl/linking/shadowStore';
import { toJsonMilli } from '../services/gl/reports/incomeStatement';
import {
  PREVIEW_KEEP_RESULTS, PREVIEW_LIST_CAPS, PREVIEW_RATE_LIMIT_PER_HOUR, PREVIEW_RESULT_MAX_BYTES, PREVIEW_STALE_MS,
  type LinkingDraft, type PreviewHooks, type PreviewOptions, type PreviewResult, type PreviewResultJson,
} from '../services/gl/linking/types';
import { createFakeLinkingDb, fakeClock, type FakeLinkingDb, type Row } from './p5-linking-jobs-fake';
import { makePreviewResult } from './p5-linking-result-factory';

// ═══ التهيئة ═══

const NOW = '2026-11-14T09:00:00.000Z';

function settingsRow(tenantId: string, over: Row = {}): Row {
  return {
    id: `gs-${tenantId}`, tenantId, templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh',
    fiscalYearEndMonth: 12, fiscalYearEndDay: 31, weekStartsOn: 0, taxPeriodicity: 'QUARTERLY', cutoverDate: null, inventoryMode: 'PERIODIC',
    perpetualFromDate: null, salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null, receiptRouting: null,
    cashInvoiceRouting: 'MAIN_CASH', activatedAt: null, setupMethod: null, linkPreviewId: null,
    setupDraft: { step1: { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 } },
    ...over,
  };
}

function seedTenant(f: FakeLinkingDb, tenantId: string, opts: { settings?: Row | null; warehouse?: boolean; country?: string } = {}): void {
  if (opts.settings !== null) f.settings.set(tenantId, settingsRow(tenantId, opts.settings ?? {}));
  f.tenants.set(tenantId, { id: tenantId, accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: opts.warehouse ?? true });
  f.companies.set(tenantId, { tenantId, countryCode: opts.country ?? 'SA', currency: 'SAR', currencyOverride: null });
}

type RunImpl = (tenantId: string, opts: PreviewOptions, hooks: PreviewHooks) => Promise<PreviewResult>;

interface Harness {
  f: FakeLinkingDb;
  clock: ReturnType<typeof fakeClock>;
  deps: PreviewJobDeps;
  runs: { tenantId: string; opts: PreviewOptions }[];
  logs: { message: string; meta: Record<string, unknown> }[];
  setRun(fn: RunImpl): void;
}

const previewDbFake = { $transaction: async () => { throw new Error('runPreview المزيّف لا يفتح معاملة'); } };

function harness(timing: PreviewJobDeps['timing'] = {}): Harness {
  const f = createFakeLinkingDb();
  const clock = fakeClock(NOW);
  const runs: Harness['runs'] = [];
  const logs: Harness['logs'] = [];
  let impl: RunImpl = async (tenantId, opts) => makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom, basis: opts.basis });
  const deps: PreviewJobDeps = {
    db: f.db as unknown as PreviewJobDeps['db'],
    previewDb: () => previewDbFake as unknown as ReturnType<PreviewJobDeps['previewDb']>,
    runPreview: (async (_db: unknown, tenantId: string, opts: PreviewOptions, hooks: PreviewHooks = {}) => {
      runs.push({ tenantId, opts });
      return impl(tenantId, opts, hooks);
    }) as unknown as PreviewJobDeps['runPreview'],
    now: clock.now,
    parseDraft: (raw) => (raw && typeof raw === 'object' ? (raw as LinkingDraft) : null),
    env: {},
    timing: { progressMinMs: 0, heartbeatMs: 60_000, queueRetryMs: 20, ...timing },
    log: (message, meta) => { logs.push({ message, meta }); },
  };
  return { f, clock, deps, runs, logs, setRun: (fn) => { impl = fn; } };
}

const row = (f: FakeLinkingDb, id: string) => f.previews.find((r) => r.id === id) as Row;

function assertOnlyPreviewWrites(f: FakeLinkingDb): void {
  const others = f.writes.filter((w) => !w.startsWith('glLinkPreview.'));
  assert.deepEqual(others, [], 'لا كتابة إلا gl_link_previews');
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('انتهت مهلة الانتظار');
    await sleep(5);
  }
  await previewWorkerIdle();
}

const START = { requestedBy: 'admin-1', basis: 'FY_RESTATED' as const };

// ═══ دورة المهمة ═══

test('بدء معاينة: صفّ QUEUED بـlinkedFrom بداية السنة ونبضٍ وخيارات، ثم RUNNING ثم DONE بالبصمتين والحجم واللقطة', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  const seen: Row[] = [];
  h.setRun(async (tenantId, opts, hooks) => {
    seen.push({ ...row(h.f, h.f.previews[0].id as string) });
    await hooks.onProgress?.('COSTING', 10);
    await hooks.onProgress?.('POST', 55.6);
    seen.push({ ...row(h.f, h.f.previews[0].id as string) });
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START, requestedVia: 'COMPANY_OWNER' });
  assert.ok('id' in out && out.existing === false && out.status === 'QUEUED');
  const created = h.f.previews[0];
  assert.equal(created.tenantId, 't-1');
  assert.equal(created.basis, 'FY_RESTATED');
  assert.equal((created.linkedFrom as Date).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(created.options, { basis: 'FY_RESTATED', requestedVia: 'COMPANY_OWNER' });
  assert.equal(created.requestedBy, 'admin-1');
  assert.equal((created.createdAt as Date).toISOString(), NOW);

  await previewWorkerIdle();
  // داخل التشغيل: RUNNING بـstartedAt والنبض والمرحلة
  assert.equal(seen[0].status, 'RUNNING');
  assert.equal((seen[0].startedAt as Date).toISOString(), NOW);
  assert.equal(seen[0].phase, 'READ');
  assert.equal(seen[1].phase, 'POST');
  assert.equal(seen[1].progressPct, 56);

  const done = row(h.f, out.id);
  assert.equal(done.status, 'DONE');
  assert.equal(done.phase, 'DONE');
  assert.equal(done.progressPct, 100);
  assert.equal(done.dataHash, 'd'.repeat(64));
  assert.equal(done.resultHash, 'r'.repeat(64));
  assert.equal((done.snapshotAt as Date).toISOString(), '2026-11-14T08:50:00.000Z');
  assert.ok(done.finishedAt instanceof Date);
  assert.equal(done.errorCode, null);
  // المبالغ في JSON نصوص ملّي، والحجم = بايتات JSON المخزّن حرفياً
  const json = done.result as PreviewResultJson;
  assert.equal(json.opening.totals.debitMilli, '3690');
  assert.equal(json.parity[0].expectedMilli, '1000');
  assert.equal(done.resultBytes, Buffer.byteLength(JSON.stringify(json), 'utf8'));
  // الخيارات المحلولة لحظة التشغيل
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].opts.linkedFrom, '2026-01-01');
  assert.equal(h.runs[0].opts.inventoryMode, 'PERPETUAL');
  assert.deepEqual(h.runs[0].opts.receiptRouting, { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' });
  assertOnlyPreviewWrites(h.f);
});

test('FROM_ACTIVATION: linkedFrom اليوم المحلي للشركة', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  h.clock.set('2026-11-14T22:30:00.000Z'); // 01:30 يوم 15 بتوقيت الرياض
  const out = await startPreview(h.deps, { tenantId: 't-1', requestedBy: 'a', basis: 'FROM_ACTIVATION' });
  assert.ok('id' in out);
  await previewWorkerIdle();
  assert.equal((row(h.f, out.id).linkedFrom as Date).toISOString(), '2026-11-15T00:00:00.000Z');
  assert.equal(h.runs[0].opts.linkedFrom, '2026-11-15');
});

test('معاينة جارية حيّة ⇒ تُعاد هي بلا صفّ جديد؛ وطلبان متزامنان لا ينشئان صفّين', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  const gate = deferred();
  h.setRun(async (tenantId, opts) => { await gate.promise; return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom }); });
  const [a, b] = await Promise.all([
    startPreview(h.deps, { tenantId: 't-1', ...START }),
    startPreview(h.deps, { tenantId: 't-1', ...START }),
  ]);
  assert.ok('id' in a && 'id' in b);
  assert.equal(a.existing, false);
  assert.equal(b.existing, true);
  assert.equal(b.id, a.id);
  const c = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in c && c.existing === true && c.id === a.id && c.status === 'RUNNING');
  assert.equal(h.f.previews.length, 1);
  // الاستطلاع كل ثانيتين لصفّ حيّ: قراءة واحدة بلا أي كتابة
  const mark = h.f.calls.length;
  const polled = await getPreview(h.deps, 't-1', a.id);
  assert.equal(polled?.status, 'RUNNING');
  assert.equal(polled?.result, null);
  assert.deepEqual(h.f.calls.slice(mark), ['glLinkPreview.findFirst']);
  gate.resolve();
  await previewWorkerIdle();
  assert.equal(row(h.f, a.id).status, 'DONE');
  assertOnlyPreviewWrites(h.f);
});

test('حدّ المعدّل: ست معاينات في الساعة ⇒ rateLimited حتى خروج السادسة الأحدث من النافذة؛ وما خرج منها لا يُحسب', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  const t0 = new Date(NOW).getTime();
  const mk = (minAgo: number, i: number) => h.f.previews.push({
    id: `old-${i}`, tenantId: 't-1', status: 'FAILED', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date(t0 - minAgo * 60_000), heartbeatAt: new Date(t0 - minAgo * 60_000), result: null, progressPct: 0, phase: 'READ',
  });
  [50, 40, 30, 20, 10, 5].forEach(mk);
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.deepEqual(out, { rateLimited: true, retryAfterSeconds: 600 });
  assert.equal(h.f.previews.length, PREVIEW_RATE_LIMIT_PER_HOUR, 'لا صفّ جديد');
  assert.equal(h.f.calls.includes('glLinkPreview.create'), false);
  // أقدمها خرج من النافذة (61 دقيقة) ⇒ خمس فقط ⇒ مسموح
  (h.f.previews[0] as Row).createdAt = new Date(t0 - 61 * 60_000);
  const ok = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in ok && ok.existing === false);
  await previewWorkerIdle();
  // شركة أخرى لا تتأثر بحدّ الأولى
  seedTenant(h.f, 't-2');
  const other = await startPreview(h.deps, { tenantId: 't-2', ...START });
  assert.ok('id' in other);
  await previewWorkerIdle();
});

test('الشركة المفعّلة ⇒ alreadyActivated بلا صفّ ولا تشغيل (D7)', async () => {
  const h = harness();
  seedTenant(h.f, 't-1', { settings: { activatedAt: new Date('2026-10-01T00:00:00Z'), setupMethod: 'CLEAN' } });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.deepEqual(out, { alreadyActivated: true });
  assert.equal(h.f.previews.length, 0);
  await previewWorkerIdle();
  assert.equal(h.runs.length, 0);
});

test('إعدادات بلا قالب (دولة غير معروفة) ⇒ LinkingParamsError قبل إنشاء أي صفّ', async () => {
  const h = harness();
  seedTenant(h.f, 't-1', { settings: null, country: 'ZZ' });
  await assert.rejects(startPreview(h.deps, { tenantId: 't-1', ...START }), (e: Error) => e.name === 'LinkingParamsError');
  assert.equal(h.f.previews.length, 0);
});

test('بلا صفّ إعدادات: القالب من الدولة وlinkedFrom بالافتراضيات (نهاية السنة 31/12)', async () => {
  const h = harness();
  seedTenant(h.f, 't-1', { settings: null, country: 'KW', warehouse: false });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  const o = h.runs[0].opts;
  assert.equal(o.templateKey, 'GENERIC_6D');
  assert.equal(o.currency, 'KWD');
  assert.equal(o.currencyDecimals, 3);
  assert.equal(o.inventoryMode, 'PERIODIC');
  assert.equal(o.linkedFrom, '2026-01-01');
});

// ═══ الفشل ورموزه ═══

test('الفشل ⇒ FAILED برمزه ورسالة عربية ثابتة (التفاصيل التقنية في السجلّ وحده)', async () => {
  const cases: { err: unknown; code: string }[] = [
    { err: new ShadowGlAccessError('glMove.findMany'), code: 'SHADOW_GL_ACCESS' },
    { err: new PreviewRunError('TOO_LARGE', 'x'), code: 'TOO_LARGE' },
    { err: new ShadowTooLargeError(400_000, 300_000), code: 'TOO_LARGE' },
    { err: Object.assign(new Error('Transaction already closed: secret-tx'), { code: 'P2028' }), code: 'TIMEOUT' },
    { err: new Error('boom secret-detail'), code: 'INTERNAL' },
  ];
  for (const c of cases) {
    const h = harness();
    seedTenant(h.f, 't-1');
    h.setRun(async () => { throw c.err; });
    const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
    assert.ok('id' in out);
    await previewWorkerIdle();
    const r = row(h.f, out.id);
    assert.equal(r.status, 'FAILED', c.code);
    assert.equal(r.errorCode, c.code);
    assert.equal(r.error, PREVIEW_ERROR_MESSAGES[c.code as keyof typeof PREVIEW_ERROR_MESSAGES]);
    assert.doesNotMatch(String(r.error), /secret/);
    assert.equal(r.result, null);
    assert.ok(r.finishedAt instanceof Date);
    assert.ok(h.logs.some((l) => l.message === 'preview failed' && l.meta.code === c.code), 'التفاصيل في سجلّ الخادم');
    assertOnlyPreviewWrites(h.f);
  }
});

test('runPreview يرمي متزامناً ⇒ FAILED(INTERNAL) لا انهيار العامل', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  h.deps.runPreview = (() => { throw new Error('sync throw'); }) as unknown as PreviewJobDeps['runPreview'];
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  assert.equal(row(h.f, out.id).errorCode, 'INTERNAL');
});

test('jobFailureCodeOf: المهلة وP2028 ⇒ TIMEOUT', () => {
  assert.equal(jobFailureCodeOf(new PreviewJobTimeoutError(5)), 'TIMEOUT');
  assert.equal(jobFailureCodeOf({ code: 'P2028' }), 'TIMEOUT');
  assert.equal(jobFailureCodeOf(new PreviewRunError('ALREADY_ACTIVATED', 'x')), 'ALREADY_ACTIVATED');
  assert.equal(jobFailureCodeOf(null), 'INTERNAL');
});

test('المهلة ⇒ FAILED(TIMEOUT)، والإنجاز المتأخر لا يكتب فوقها، ولا تبدأ التالية قبل أن تتحرّر الأولى', async () => {
  const h = harness({ timeoutMs: 30 });
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  let firstSettledAt = 0;
  let secondStartedAt = 0;
  h.setRun(async (tenantId, opts) => {
    if (tenantId === 't-1') {
      await sleep(150);
      firstSettledAt = Date.now();
    } else {
      secondStartedAt = Date.now();
    }
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  const a = await startPreview(h.deps, { tenantId: 't-1', ...START });
  const b = await startPreview(h.deps, { tenantId: 't-2', ...START });
  assert.ok('id' in a && 'id' in b);
  await previewWorkerIdle();
  const ra = row(h.f, a.id);
  assert.equal(ra.status, 'FAILED');
  assert.equal(ra.errorCode, 'TIMEOUT');
  assert.equal(ra.result, null, 'الإنجاز بعد المهلة لا يُحفظ');
  assert.equal(row(h.f, b.id).status, 'DONE');
  assert.ok(secondStartedAt >= firstSettledAt, 'الثانية بعد تحرّر الأولى');
});

test('معاينة عالقة بعد المهلة لا توقف طابور المنصّة: مهلة سماح ثم التالية، ويُسجَّل ذلك', async () => {
  const h = harness({ timeoutMs: 20, abandonGraceMs: 30 });
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  h.setRun(async (tenantId, opts) => {
    if (tenantId === 't-1') await new Promise(() => undefined); // لا تنتهي أبداً
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  const a = await startPreview(h.deps, { tenantId: 't-1', ...START });
  const b = await startPreview(h.deps, { tenantId: 't-2', ...START });
  assert.ok('id' in a && 'id' in b);
  await previewWorkerIdle();
  assert.equal(row(h.f, a.id).errorCode, 'TIMEOUT');
  assert.equal(row(h.f, b.id).status, 'DONE');
  assert.ok(h.logs.some((l) => /still running after grace/.test(l.message)));
});

test('النبض المتقادم ⇒ FAILED(INTERRUPTED) عند القراءة، ومهمة هذه العملية الجارية لا تُعلَّم ولو تأخّر نبضها', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  const t0 = new Date(NOW).getTime();
  // صفّ من عملية سابقة (أُعيد تشغيل الخادم): RUNNING بنبضٍ قبل ثلاث دقائق
  h.f.previews.push({
    id: 'stale-1', tenantId: 't-1', status: 'RUNNING', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'), phase: 'POST',
    progressPct: 50, createdAt: new Date(t0 - 10 * 60_000), startedAt: new Date(t0 - 10 * 60_000), heartbeatAt: new Date(t0 - PREVIEW_STALE_MS - 60_000),
    result: null,
  });
  const v = await getPreview(h.deps, 't-1', 'stale-1');
  assert.ok(v);
  assert.equal(v.status, 'FAILED');
  assert.equal(v.errorCode, 'INTERRUPTED');
  assert.equal(v.error, PREVIEW_ERROR_MESSAGES.INTERRUPTED);
  assert.equal(v.phase, 'POST', 'المرحلة الأخيرة تبقى للتشخيص');

  // الجارية في هذه العملية: الساعة تتقدّم عشر دقائق داخل التشغيل ثم تُقرأ ⇒ تبقى RUNNING
  let during: string | null = null;
  h.setRun(async (tenantId, opts) => {
    h.clock.advance(10 * 60_000);
    const id = h.f.previews.find((r) => r.status === 'RUNNING')!.id as string;
    during = (await getPreview(h.deps, 't-1', id))!.status;
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out && out.existing === false, 'المنقطعة لا تُعدّ جارية');
  await previewWorkerIdle();
  assert.equal(during, 'RUNNING');
  assert.equal(row(h.f, out.id).status, 'DONE');
});

test('QUEUED منقطع (نبض متقادم) ⇒ INTERRUPTED لا يُلتقط؛ وQUEUED حيّ بلا عامل (إعادة تشغيل) يستأنفه الاستطلاع', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  const t0 = new Date(NOW).getTime();
  h.f.previews.push({
    id: 'q-old', tenantId: 't-1', status: 'QUEUED', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'), phase: 'QUEUED',
    progressPct: 0, createdAt: new Date(t0 - 5 * 60_000), heartbeatAt: new Date(t0 - 5 * 60_000), result: null,
  });
  h.f.previews.push({
    id: 'q-live', tenantId: 't-2', status: 'QUEUED', basis: 'FROM_ACTIVATION', linkedFrom: new Date('2026-11-14T00:00:00Z'), phase: 'QUEUED',
    progressPct: 0, createdAt: new Date(t0 - 30_000), heartbeatAt: new Date(t0 - 30_000), result: null,
  });
  const v = await getPreview(h.deps, 't-2', 'q-live');
  assert.equal(v?.status, 'QUEUED');
  await previewWorkerIdle();
  assert.equal(row(h.f, 'q-live').status, 'DONE');
  assert.equal(row(h.f, 'q-old').status, 'FAILED');
  assert.equal(row(h.f, 'q-old').errorCode, 'INTERRUPTED');
  assert.deepEqual(h.runs.map((r) => r.tenantId), ['t-2']);
  assert.equal(h.runs[0].opts.basis, 'FROM_ACTIVATION');
});

test('الشركة فُعّلت بين الطلب والتشغيل ⇒ FAILED(ALREADY_ACTIVATED) بلا تشغيل المعاينة', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  const gate = deferred();
  h.setRun(async (tenantId, opts) => { if (tenantId === 't-2') await gate.promise; return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom }); });
  const blocker = await startPreview(h.deps, { tenantId: 't-2', ...START });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out && 'id' in blocker);
  (h.f.settings.get('t-1') as Row).activatedAt = new Date(NOW);
  gate.resolve();
  await previewWorkerIdle();
  const r = row(h.f, out.id);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.errorCode, 'ALREADY_ACTIVATED');
  assert.deepEqual(h.runs.map((x) => x.tenantId), ['t-2']);
});

// ═══ الطابور والنبض والتقدّم ═══

test('الطابور واحد على المنصّة: معاينة واحدة في كل لحظة، بترتيب الإنشاء', async () => {
  const h = harness();
  const tenants = ['t-1', 't-2', 't-3', 't-4'];
  for (const t of tenants) seedTenant(h.f, t);
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  h.setRun(async (tenantId, opts) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(tenantId);
    await sleep(15);
    active -= 1;
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  for (const t of tenants) {
    await startPreview(h.deps, { tenantId: t, ...START });
    h.clock.advance(1_000);
  }
  await previewWorkerIdle();
  assert.equal(maxActive, 1);
  assert.deepEqual(order, tenants);
  assert.ok(h.f.previews.every((r) => r.status === 'DONE'));
  assertOnlyPreviewWrites(h.f);
});

test('عملية أخرى تشغّل معاينة حيّة ⇒ لا تبدأ ثانية؛ وحين تنتهي تُلتقط المنتظرة', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  h.f.previews.push({
    id: 'other-proc', tenantId: 't-9', status: 'RUNNING', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'), phase: 'POST',
    progressPct: 40, createdAt: new Date(NOW), heartbeatAt: new Date(NOW), result: null,
  });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  assert.equal(row(h.f, out.id).status, 'QUEUED');
  assert.equal(h.runs.length, 0);
  row(h.f, 'other-proc').status = 'DONE';
  await waitFor(() => row(h.f, out.id).status === 'DONE');
  assert.equal(h.runs.length, 1);
});

test('النبض المستقل: الجارية والمنتظرة الحيّة تتجدّدان أثناء مرحلة طويلة بلا تقدّم', async () => {
  const h = harness({ heartbeatMs: 10 });
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  let queuedId = '';
  h.setRun(async (tenantId, opts) => {
    if (tenantId === 't-1') {
      const q = await startPreview(h.deps, { tenantId: 't-2', ...START });
      assert.ok('id' in q);
      queuedId = q.id;
      h.clock.advance(60_000);
      await sleep(80);
    }
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  const beats = h.f.updateLog.filter((u) => Array.isArray(u.where?.OR) && Object.keys(u.data).join() === 'heartbeatAt');
  assert.ok(beats.length >= 2, `نبضات: ${beats.length}`);
  assert.ok(beats.some((b) => b.count === 2), 'النبضة تمسّ الجارية والمنتظرة معاً');
  const advanced = new Date(new Date(NOW).getTime() + 60_000).toISOString();
  assert.ok(beats.some((b) => (b.data.heartbeatAt as Date).toISOString() === advanced));
  assert.equal(row(h.f, queuedId).status, 'DONE');
});

test('كتابات التقدّم: ≤ مرة كل ثانيتين بساعة التطبيق، والنسبة 0..99 أثناء التشغيل، وDONE تكتبه النتيجة', async () => {
  const h = harness({ progressMinMs: 2_000 });
  seedTenant(h.f, 't-1');
  h.setRun(async (tenantId, opts, hooks) => {
    for (let i = 0; i < 10; i++) {
      await hooks.onProgress?.('POST', 40 + i * 5);
      h.clock.advance(500);
    }
    await hooks.onProgress?.('DONE', 100);
    return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom });
  });
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  const progressWrites = h.f.updateLog.filter((u) => 'progressPct' in u.data && !('status' in u.data));
  // نداءات عند 0 و2000 و4000 ملّي ثانية من ساعة التطبيق
  assert.deepEqual(progressWrites.map((u) => u.data.progressPct), [40, 60, 80]);
  assert.ok(progressWrites.every((u) => (u.data.progressPct as number) <= 99));
  assert.ok(!progressWrites.some((u) => u.data.phase === 'DONE'));
  assert.equal(row(h.f, out.id).progressPct, 100);
  // لا كتابة مؤجّلة بعد الإنجاز
  await sleep(50);
  assert.equal(row(h.f, out.id).status, 'DONE');
});

// ═══ القراءة ═══

test('getPreview: معاينة شركة أخرى ⇒ null؛ listPreviews الأحدث أولاً بلا result وبحدّ ≤ 20 واستعلامين فقط', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  const a = await startPreview(h.deps, { tenantId: 't-1', ...START });
  await previewWorkerIdle();
  h.clock.advance(1_000);
  const b = await startPreview(h.deps, { tenantId: 't-1', ...START });
  await previewWorkerIdle();
  assert.ok('id' in a && 'id' in b);
  assert.equal(await getPreview(h.deps, 't-2', a.id), null);
  const v = await getPreview(h.deps, 't-1', a.id);
  assert.ok(v?.result);
  assert.equal(v.linkedFrom, '2026-01-01');
  assert.equal(typeof v.createdAt, 'string');

  h.f.calls.length = 0;
  const list = await listPreviews(h.deps, 't-1', 50);
  assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);
  assert.ok(list.every((x) => !('result' in x)));
  assert.deepEqual(h.f.calls, ['glLinkPreview.updateMany', 'glLinkPreview.findMany'], 'تعليم المنقطعة ثم قراءة واحدة — بلا N+1');
  for (let i = 0; i < 25; i++) h.f.previews.push({ ...h.f.previews[0], id: `x-${i}`, createdAt: new Date(new Date(NOW).getTime() - (i + 1) * 3_600_000) });
  assert.equal((await listPreviews(h.deps, 't-1', 50)).length, 20);
  assert.equal((await listPreviews(h.deps, 't-1')).length, 10);
});

// ═══ تفريغ النتائج القديمة ═══

test('تفريغ result لما بعد آخر خمس معاينات منجزة للشركة عدا المعتمدة (linkPreviewId)، وشركة أخرى لا تُمسّ', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  seedTenant(h.f, 't-2');
  const t0 = new Date(NOW).getTime();
  const done = (id: string, tenantId: string, hoursAgo: number) => h.f.previews.push({
    id, tenantId, status: 'DONE', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'), phase: 'DONE', progressPct: 100,
    createdAt: new Date(t0 - hoursAgo * 3_600_000), heartbeatAt: new Date(t0 - hoursAgo * 3_600_000), result: { version: 1, id }, resultBytes: 20,
  });
  for (let i = 1; i <= 7; i++) done(`d-${i}`, 't-1', i * 2);
  done('other', 't-2', 30);
  h.f.previews.push({ id: 'f-1', tenantId: 't-1', status: 'FAILED', basis: 'FY_RESTATED', linkedFrom: new Date(), createdAt: new Date(t0 - 3_600_000), result: null });
  (h.f.settings.get('t-1') as Row).linkPreviewId = 'd-7';
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  const withResult = h.f.previews.filter((r) => r.tenantId === 't-1' && r.result != null).map((r) => r.id).sort();
  // الجديدة + d-1..d-4 (الخمس الأحدث) + d-7 (المعتمدة)
  assert.deepEqual(withResult, [out.id, 'd-1', 'd-2', 'd-3', 'd-4', 'd-7'].sort());
  assert.equal(PREVIEW_KEEP_RESULTS, 5);
  assert.ok(row(h.f, 'other').result, 'شركة أخرى لا تُمسّ');
  // الصفّ يبقى بحالته وبصمته — النتيجة وحدها تُفرَّغ
  assert.equal(row(h.f, 'd-5').status, 'DONE');
  assert.equal(row(h.f, 'd-5').resultBytes, 20);
  // عبارة التفريغ لا تمسّ إلا ما يحمل نتيجة، وتكرارها بلا أثر
  const again = await pruneOldResults(h.deps, 't-1');
  assert.equal(again, 0);
  const pruneCall = h.f.updateLog.find((u) => u.data.result === Prisma.DbNull);
  assert.ok(pruneCall, 'التفريغ بـPrisma.DbNull');
  assertOnlyPreviewWrites(h.f);
});

// ═══ قصّ النتيجة ═══

function bigJson(sizes: Parameters<typeof makePreviewResult>[1]): PreviewResultJson {
  return toJsonMilli(makePreviewResult({}, sizes)) as PreviewResultJson;
}

const LONG = 'وصف طويل جداً لبند المعاينة '.repeat(12);
const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

test('capResult: تحت السقف ⇒ النتيجة نفسها بلا قصّ، والحجم بايتات JSON', () => {
  const j = bigJson({});
  const c = capResult(j, PREVIEW_RESULT_MAX_BYTES);
  assert.equal(c.truncated, false);
  assert.equal(c.json, j);
  assert.equal(c.bytes, Buffer.byteLength(JSON.stringify(j), 'utf8'));
});

test('capResult: فوق السقف ⇒ ≤ PREVIEW_RESULT_MAX_BYTES بقصّ القوائم المحدودة وعدّاداتها، والمجاميع والحالات لا تُمسّ، وحتمي', () => {
  const sizes = {
    openingLines: PREVIEW_LIST_CAPS.openingLines, drillPerCheck: PREVIEW_LIST_CAPS.drillRows, heldLines: PREVIEW_LIST_CAPS.heldLines,
    itemsPerCheck: PREVIEW_LIST_CAPS.preflightItems, uncosted: 3_000, label: LONG,
  };
  const j = bigJson(sizes);
  const before = JSON.stringify(j);
  assert.ok(Buffer.byteLength(before, 'utf8') > PREVIEW_RESULT_MAX_BYTES, 'المدخل يتجاوز السقف');
  const c = capResult(j, PREVIEW_RESULT_MAX_BYTES);
  assert.equal(c.truncated, true);
  assert.ok(c.bytes <= PREVIEW_RESULT_MAX_BYTES);
  assert.equal(c.bytes, Buffer.byteLength(JSON.stringify(c.json), 'utf8'));
  assert.equal(JSON.stringify(j), before, 'المدخل لا يُعدَّل');
  // العدّادات: المحفوظ + المقصوص = الأصل لكل قائمة
  assert.equal(c.json.opening.lines.length + c.json.opening.linesTruncated, sizes.openingLines);
  assert.equal(c.json.heldLines.length + c.json.heldTruncated, sizes.heldLines);
  for (const p of c.json.parity) assert.equal(p.drill.length + p.drillTruncated, sizes.drillPerCheck);
  for (const ch of c.json.preflight.checks) assert.equal((ch.items ?? []).length + (ch.itemsTruncated ?? 0), sizes.itemsPerCheck);
  // ما لا يُقصّ: المطابقة وحالاتها ومجاميعها، والفحوص، والبصمتان، والمجاميع
  assert.deepEqual(c.json.parity.map((p) => [p.code, p.status, p.expectedMilli, p.actualMilli, p.diffMilli]),
    j.parity.map((p) => [p.code, p.status, p.expectedMilli, p.actualMilli, p.diffMilli]));
  assert.deepEqual(c.json.preflight.checks.map((x) => [x.code, x.ok, x.level]), j.preflight.checks.map((x) => [x.code, x.ok, x.level]));
  assert.deepEqual(c.json.opening.totals, j.opening.totals);
  assert.equal(c.json.dataHash, j.dataHash);
  assert.equal(c.json.resultHash, j.resultHash);
  assert.equal(c.json.costing.summary.uncostedAtCutoverTotalQty, 3_000);
  const w = c.json.warnings.find((x) => x.code === 'RESULT_TRUNCATED');
  assert.ok(w && (w.count ?? 0) > 0);
  assert.match(w.message, /قُصّت/);
  // حتمي
  assert.equal(JSON.stringify(capResult(j, PREVIEW_RESULT_MAX_BYTES)), JSON.stringify(c));
  // القوائم المحدودة تُقصّ قبل صفوف الميزان
  assert.equal(c.json.trialBalanceByMonth.rows.length, j.trialBalanceByMonth.rows.length);
});

test('capResult: بعد القوائم المحدودة تُسقط صفوف ميزان الشهور الصفرية وحدها، ثم ملاذ أخير يضمن السقف', () => {
  const j = bigJson({ openingLines: 0, drillPerCheck: 0, heldLines: 0, itemsPerCheck: 0, uncosted: 0, tbRows: 20, tbZeroRows: 6_000, label: LONG });
  assert.ok(Buffer.byteLength(JSON.stringify(j), 'utf8') > PREVIEW_RESULT_MAX_BYTES);
  const c = capResult(j, PREVIEW_RESULT_MAX_BYTES);
  assert.ok(c.bytes <= PREVIEW_RESULT_MAX_BYTES);
  assert.equal(c.json.trialBalanceByMonth.rows.length, 20, 'الصفوف غير الصفرية كلها باقية');
  assert.ok(c.json.trialBalanceByMonth.rows.every((r) => r.closingMilli !== '0'));
  assert.deepEqual(c.json.trialBalanceByMonth.totals, j.trialBalanceByMonth.totals);

  // ميزان كبير غير صفري يكفيه النصف ⇒ يبقى النصف الأكبر حركةً بترتيبه الأصلي
  const mid = bigJson({ openingLines: 0, drillPerCheck: 0, heldLines: 0, itemsPerCheck: 0, uncosted: 0, tbRows: 2_400, label: LONG });
  assert.ok(Buffer.byteLength(JSON.stringify(mid), 'utf8') > PREVIEW_RESULT_MAX_BYTES);
  const m = capResult(mid, PREVIEW_RESULT_MAX_BYTES);
  assert.ok(m.bytes <= PREVIEW_RESULT_MAX_BYTES);
  assert.equal(m.json.trialBalanceByMonth.rows.length, 1_200);
  assert.deepEqual(m.json.trialBalanceByMonth.rows.map((r) => r.accountId),
    Array.from({ length: 1_200 }, (_, k) => `acc-${1_200 + k}`), 'الأكبر إقفالاً بترتيبها');

  // ميزان ضخم غير صفري ⇒ الملاذ الأخير يبقي السقف
  const huge = bigJson({ openingLines: 0, drillPerCheck: 0, heldLines: 0, itemsPerCheck: 0, uncosted: 0, tbRows: 8_000, label: LONG });
  const h = capResult(huge, PREVIEW_RESULT_MAX_BYTES);
  assert.ok(h.bytes <= PREVIEW_RESULT_MAX_BYTES);
  assert.ok(h.json.trialBalanceByMonth.rows.length < 8_000);
  assert.deepEqual(h.json.parity.map((p) => p.status), huge.parity.map((p) => p.status));
});

/** ميزان ممتدّ إلى مستند مؤرّخ في 2061 (P11 تحذير لا يحجب): 432 شهراً لكل حساب — كثيف الخلايا كما يبنيه trialBalanceByMonth */
function wideTrialBalance(rowsN: number, busy: (row: number, month: number) => boolean): PreviewResultJson['trialBalanceByMonth'] {
  const months: string[] = [];
  for (let y = 2026; y < 2062; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  const rows = Array.from({ length: rowsN }, (_, i) => {
    const cells = months.map((month, k) => ({ month, debitMilli: busy(i, k) ? String(1_000 + i) : '0', creditMilli: '0' }));
    const debit = cells.reduce((s, c) => s + BigInt(c.debitMilli), 0n);
    return {
      accountId: `acc-${i}`, accountCode: String(100_000 + i), accountName: `حساب ${i}`, accountType: 'asset_current',
      openingMilli: '1000', months: cells, debitMilli: String(debit), creditMilli: '0', closingMilli: String(1_000n + debit),
    };
  });
  return { months, rows, totals: { openingMilli: String(1_000 * rowsN), debitMilli: '0', creditMilli: '0', closingMilli: '0' } };
}

/** نتيجة بقوائم مهمة صغيرة (12 محجوزاً، 40 صفّ تعمّق لكل مطابقة، 30 سطر افتتاح، 5 عناصر لكل فحص) وميزان عريض */
function wideJson(tb: PreviewResultJson['trialBalanceByMonth']): PreviewResultJson {
  const j = bigJson({ openingLines: 30, drillPerCheck: 40, heldLines: 12, itemsPerCheck: 5, uncosted: 0 });
  return { ...j, trialBalanceByMonth: tb };
}

test('capResult: ميزان 432 شهراً بخلايا صفرية ⇒ يُضغط بلا فقد والقوائم المهمة كاملة (لا «لا أحداث محجوزة» كاذبة)', () => {
  // كل حساب يتحرّك في يناير 2026 وفي مارس 2061 وحدهما — والبقية خلايا صفرية (≈ 2.4MB)
  const j = wideJson(wideTrialBalance(100, (_i, k) => k === 0 || k === 422));
  assert.ok(byteLen(j) > PREVIEW_RESULT_MAX_BYTES, 'المدخل يتجاوز السقف');
  const c = capResult(j, PREVIEW_RESULT_MAX_BYTES);
  assert.ok(c.bytes <= PREVIEW_RESULT_MAX_BYTES);
  assert.equal(c.bytes, byteLen(c.json));
  // لا شيء أُسقط: القوائم كلها كاملة بلا عدّاد قصّ، ولا تحذير RESULT_TRUNCATED
  assert.equal(c.truncated, false);
  assert.ok(!c.json.warnings.some((w) => w.code === 'RESULT_TRUNCATED'));
  assert.equal(c.json.heldLines.length, 12);
  assert.equal(c.json.heldTruncated, 0);
  for (const p of c.json.parity) assert.deepEqual([p.drill.length, p.drillTruncated], [40, 0], p.code);
  assert.deepEqual([c.json.opening.lines.length, c.json.opening.linesTruncated], [30, 0]);
  for (const ch of c.json.preflight.checks) assert.deepEqual([(ch.items ?? []).length, ch.itemsTruncated ?? 0], [5, 0], ch.code);
  // الميزان: الصفوف والأعمدة كلها، والخلايا غير الصفرية وحدها بمبالغها، ومجاميع الصفّ كما هي
  const tb = c.json.trialBalanceByMonth;
  assert.equal(tb.months.length, 432);
  assert.equal(tb.rows.length, 100);
  for (const [i, row] of tb.rows.entries()) {
    const src = j.trialBalanceByMonth.rows[i];
    assert.deepEqual(row.months.map((m) => m.month), ['2026-01', '2061-03']);
    assert.deepEqual(row.months, src.months.filter((m) => m.debitMilli !== '0' || m.creditMilli !== '0'));
    assert.deepEqual([row.debitMilli, row.creditMilli, row.closingMilli, row.openingMilli], [src.debitMilli, src.creditMilli, src.closingMilli, src.openingMilli]);
  }
  assert.equal(j.trialBalanceByMonth.rows[0].months.length, 432, 'المدخل لا يُعدَّل');
  assert.equal(JSON.stringify(capResult(j, PREVIEW_RESULT_MAX_BYTES)), JSON.stringify(c), 'حتمي');
});

test('capResult: ميزان عريض غير صفري ⇒ تُسقط صفوفه الأخفّ قبل أن تنزل القوائم المهمة دون حدّها المحميّ — لا تُفرَّغ إلى الصفر', () => {
  // 300 حساب × 432 شهراً كلها حركة (≈ 6.5MB): لا ضغط بلا فقد يكفي
  const j = wideJson(wideTrialBalance(300, () => true));
  assert.ok(byteLen(j) > PREVIEW_RESULT_MAX_BYTES);
  const c = capResult(j, PREVIEW_RESULT_MAX_BYTES);
  assert.ok(c.bytes <= PREVIEW_RESULT_MAX_BYTES);
  assert.equal(c.truncated, true);
  const guard = (base: number) => Math.floor(base * PROTECTED_LIST_FRACTION);
  // المحجوز (12 ≤ 50) والافتتاح (30 ≤ 200) والعناصر (5 ≤ 5) كاملة، والتعمّق عند حدّه المحميّ (20 من 40) بعدّاده
  assert.deepEqual([c.json.heldLines.length, c.json.heldTruncated], [12, 0]);
  assert.deepEqual([c.json.opening.lines.length, c.json.opening.linesTruncated], [30, 0]);
  for (const ch of c.json.preflight.checks) assert.equal((ch.items ?? []).length, Math.min(5, guard(PREVIEW_LIST_CAPS.preflightItems)), ch.code);
  for (const p of c.json.parity) {
    assert.equal(p.drill.length, guard(PREVIEW_LIST_CAPS.drillRows), p.code);
    assert.equal(p.drill.length + p.drillTruncated, 40, p.code);
  }
  // الميزان: الأثقل حركةً باقٍ بترتيبه الأصلي، والأعمدة كما هي، والمجاميع لا تُمسّ
  const kept = c.json.trialBalanceByMonth.rows.map((r) => r.accountId);
  assert.ok(kept.length > 0 && kept.length < 300, String(kept.length));
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, k) => `acc-${300 - kept.length + k}`));
  assert.equal(c.json.trialBalanceByMonth.months.length, 432);
  assert.deepEqual(c.json.trialBalanceByMonth.totals, j.trialBalanceByMonth.totals);
  const w = c.json.warnings.find((x) => x.code === 'RESULT_TRUNCATED');
  assert.ok(w && w.message.includes('صفوف ميزان المراجعة بالأشهر') && w.message.includes('تفاصيل المطابقة'), w?.message);
  assert.ok(!w.message.includes('السطور المحجوزة'), 'المحجوز لم يُقصّ');
  assert.equal(JSON.stringify(capResult(j, PREVIEW_RESULT_MAX_BYTES)), JSON.stringify(c), 'حتمي');
});

test('النتيجة الكبيرة تُحفظ مقصوصة ≤ السقف من المهمة نفسها', async () => {
  const h = harness();
  seedTenant(h.f, 't-1');
  h.setRun(async (tenantId, opts) => makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom }, {
    openingLines: 2_000, drillPerCheck: 200, heldLines: 500, itemsPerCheck: 50, uncosted: 3_000, label: LONG,
  }));
  const out = await startPreview(h.deps, { tenantId: 't-1', ...START });
  assert.ok('id' in out);
  await previewWorkerIdle();
  const r = row(h.f, out.id);
  assert.equal(r.status, 'DONE');
  assert.ok((r.resultBytes as number) <= PREVIEW_RESULT_MAX_BYTES);
  assert.equal(r.resultBytes, Buffer.byteLength(JSON.stringify(r.result), 'utf8'));
  assert.ok((r.result as PreviewResultJson).warnings.some((w) => w.code === 'RESULT_TRUNCATED'));
});
