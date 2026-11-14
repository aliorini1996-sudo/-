// مسارات «ربط الدفاتر» (P5 — routes/ledger/linking.ts، العقد §14.3 و§17 P5) سلوكياً عبر سلسلة الموجّه الحقيقية
// (router.stack: requireLedgerPermission الإنتاجي ثم requireCompanyOwner ثم ledgerHandler) فوق Prisma مزيّف في الذاكرة —
// بلا قاعدة ولا شبكة ولا خادم. runPreview وrunPreflight مزيّفان (وحدتاهما مختبرتان في P1/P3)؛ المهمة وحلّ الخيارات حقيقيان.
//   ١) الحرّاس: غير المالك (ADMIN بلا canManageCompanyUsers، أو محاسب بـcanConfigureLedger وحده) ⇒ 403 OWNER_ONLY؛ مقيّد النطاق
//      ⇒ 403؛ مفتاح API ⇒ 403 INTERACTIVE_ONLY؛ جلسة مالك المنصّة ⇒ تمرّ.
//   ٢) POST: 202 جديدة، 200 الجارية، 409 المفعّلة، 429 بـretryAfterSeconds وRetry-After، 422 إعدادات بلا قالب.
//   ٣) GET لمعاينة شركة أخرى ⇒ 404؛ القائمة بلا نتائج وبحدّ ≤ 20؛ الـpreflight LIGHT داخل لقطة READ ONLY بمهلة 30 ثانية.
//   ٤) تجسّس: لا كتابة إلا gl_link_previews. ٥) index.ts لم يتغيّر فيه إلا سطرا الاستيراد والتركيب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';
import { ZodError } from 'zod';
import { createFakeLinkingDb, type Row } from './p5-linking-jobs-fake';
import { makePreviewResult } from './p5-linking-result-factory';
import type { PreflightInput, PreflightReport, PreviewOptions, PreviewResult } from '../services/gl/linking/types';

// لا عميل معاينة حقيقي: previewDb() يسقط إلى Prisma المزيّف
delete process.env.DATABASE_URL;

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const f = createFakeLinkingDb();
stub('config/database', { default: f.db });

// runPreview/runPreflight مزيّفان فوق الوحدتين الحقيقيتين (رموز الأخطاء ورسائلها حقيقية)
type RunImpl = (tenantId: string, opts: PreviewOptions) => Promise<PreviewResult>;
let runImpl: RunImpl = async (tenantId, opts) => makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom, basis: opts.basis });
const runs: { tenantId: string; opts: PreviewOptions }[] = [];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realPreview = require('../services/gl/linking/preview');
const fakeRunPreview = async (_db: unknown, tenantId: string, opts: PreviewOptions) => { runs.push({ tenantId, opts }); return runImpl(tenantId, opts); };
stub('services/gl/linking/preview', { ...realPreview, runPreview: fakeRunPreview });
// المسار يشغّل المعاينة معزولةً في عملية فرعية (previewIsolate.ts) — هنا بلا عملية: المشغّل المزيّف نفسه (العزل مختبرٌ في linking-isolate)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realIsolate = require('../services/gl/linking/previewIsolate');
stub('services/gl/linking/previewIsolate', { ...realIsolate, isolatedRunPreview: fakeRunPreview });
type PreflightImpl = (tx: unknown, tenantId: string, input: PreflightInput) => Promise<PreflightReport>;
const preflightCalls: { tenantId: string; input: PreflightInput }[] = [];
let preflightImpl: PreflightImpl = async (_tx, _tenantId, input) => ({
  mode: input.mode, linkedFrom: input.linkedFrom, basis: input.basis, blocking: 1, warnings: 0,
  checks: [{ code: 'P10', level: 'W', ok: true, titleAr: 'تسعير الوارد', details: 'كامل', count: 2, valueMilli: 123_450n, mode: input.mode }],
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realPreflight = require('../services/gl/linking/preflight');
stub('services/gl/linking/preflight', {
  ...realPreflight,
  runPreflight: async (tx: unknown, tenantId: string, input: PreflightInput) => { preflightCalls.push({ tenantId, input }); return preflightImpl(tx, tenantId, input); },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkingModule = require('../routes/ledger/linking');
const linkingRouter = linkingModule.default as Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { previewWorkerIdle } = require('../services/gl/linking/jobs') as typeof import('../services/gl/linking/jobs');

// ═══ سلسلة المسار الحقيقية + req/res مقلَّدان ═══

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handle }[] } }

function handlersFor(method: 'get' | 'post', routePath: string): Handle[] {
  for (const layer of (linkingRouter as unknown as { stack: RouteLayer[] }).stack) {
    const r = layer.route;
    if (r && r.path === routePath && r.methods[method] === true) return r.stack.map((s) => s.handle);
  }
  throw new Error(`نقطة غير مسجَّلة: ${method.toUpperCase()} ${routePath}`);
}

interface MockRes {
  statusCode: number; body: Record<string, unknown> | null; locals: Record<string, unknown>; headers: Record<string, unknown>;
  onSend: (() => void) | null;
  status(code: number): MockRes; json(payload: unknown): MockRes; setHeader(k: string, v: unknown): void; getHeader(k: string): unknown;
}

function mockRes(tenantId: string, actorId: string): MockRes {
  return {
    statusCode: 200, body: null, headers: {}, onSend: null,
    locals: { ledger: { tenantId, actorId, impersonated: false } },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload as Record<string, unknown>; this.onSend?.(); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
  };
}

async function runChain(handlers: Handle[], req: Row, res: MockRes): Promise<{ status: number; body: Record<string, unknown> | null; reached: number }> {
  let reached = 0;
  for (const handle of handlers) {
    reached += 1;
    const outcome = await new Promise<'next' | 'sent'>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('المعالج لم يردّ ولم يمرّر')), 5_000);
      res.onSend = () => { clearTimeout(timer); resolve('sent'); };
      const next = (err?: unknown) => { clearTimeout(timer); if (err) reject(err); else resolve('next'); };
      Promise.resolve().then(() => handle(req, res, next)).catch((err) => { clearTimeout(timer); reject(err); });
    });
    if (outcome === 'sent') break;
  }
  return { status: res.statusCode, body: res.body, reached };
}

// ═══ البيانات ═══

const T1 = 't-1';
const T2 = 't-2';

function adminRow(id: string, over: Row = {}): Row {
  return {
    id, isActive: true, tenantId: T1, role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: false,
    canViewLedger: false, canPostJournals: false, canManagePayables: false, canManageBank: false, canCloseLedgerPeriods: false, canConfigureLedger: false,
    ...over,
  };
}

function seed(): void {
  f.reset();
  runs.length = 0;
  preflightCalls.length = 0;
  linkingModule.resetPreflightCacheForTests();
  runImpl = async (tenantId, opts) => makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom, basis: opts.basis });
  for (const [tid, settings] of [[T1, true], [T2, true]] as const) {
    if (settings) {
      f.settings.set(tid, {
        tenantId: tid, templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12,
        fiscalYearEndDay: 31, weekStartsOn: 0, taxPeriodicity: 'QUARTERLY', activatedAt: null, setupMethod: null, linkPreviewId: null, receiptRouting: null,
        cashInvoiceRouting: 'MAIN_CASH', salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null,
        setupDraft: { step1: { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 }, step3: { cashInvoiceRouting: 'MAIN_CASH' }, junk: 1 },
      });
    }
    f.tenants.set(tid, { id: tid, accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: true });
    f.companies.set(tid, { tenantId: tid, countryCode: 'SA', currency: 'SAR', currencyOverride: null });
  }
  f.admins.set('owner-1', adminRow('owner-1'));
  f.admins.set('admin-noowner', adminRow('admin-noowner', { canManageCompanyUsers: false, canConfigureLedger: true }));
  f.admins.set('acct-1', adminRow('acct-1', { role: 'ACCOUNTANT', canManageCompanyUsers: false, canConfigureLedger: true }));
  f.admins.set('mgr-owner', adminRow('mgr-owner', { role: 'MANAGER', canManageCompanyUsers: true }));
  f.admins.set('scoped-owner', adminRow('scoped-owner', { scopeEnabled: true }));
  f.admins.set('inactive-owner', adminRow('inactive-owner', { isActive: false }));
  f.admins.set('owner-2', adminRow('owner-2', { tenantId: T2 }));
}

const user = (id: string, over: Row = {}): Row => ({ id, role: (f.admins.get(id)?.role as string) ?? 'ADMIN', tenantId: T1, name: 'مستخدم', impersonated: false, ...over });

function req(id: string, over: Row = {}, userOver: Row = {}): Row {
  return { params: {}, query: {}, body: {}, headers: {}, ip: '127.0.0.1', user: user(id, userOver), ...over };
}

const ENDPOINTS: { method: 'get' | 'post'; path: string; req: Row }[] = [
  { method: 'post', path: '/linking/preview', req: { body: {} } },
  { method: 'get', path: '/linking/preview/:id', req: { params: { id: 'pv-x' } } },
  { method: 'get', path: '/linking/previews', req: { query: {} } },
  { method: 'get', path: '/linking/preflight', req: { query: {} } },
];

const call = (method: 'get' | 'post', p: string, r: Row, tenantId = T1) =>
  runChain(handlersFor(method, p), r, mockRes(tenantId, String((r.user as Row | undefined)?.id ?? '')));

function assertOnlyPreviewWrites(): void {
  assert.deepEqual(f.writes.filter((w) => !w.startsWith('glLinkPreview.')), [], 'لا كتابة إلا gl_link_previews');
}

// ═══ ١) الحرّاس ═══

test('غير المالك (ADMIN بلا canManageCompanyUsers، محاسب أو مدير بـcanConfigureLedger) ⇒ 403 LEDGER_LINKING_OWNER_ONLY على كل المسارات', async () => {
  for (const id of ['admin-noowner', 'acct-1']) {
    for (const e of ENDPOINTS) {
      seed();
      const out = await call(e.method, e.path, req(id, e.req));
      assert.equal(out.status, 403, `${id} ${e.path}`);
      assert.equal(out.body?.code, 'LEDGER_LINKING_OWNER_ONLY');
      assert.equal(out.body?.message, 'ربط الدفاتر بالنظام لمالك الشركة وحده');
      assert.equal(out.reached, 2, 'تجاوز canConfigureLedger ووقف عند حارس المالك');
      assert.equal(f.calls.some((c) => c.startsWith('glLinkPreview') || c.startsWith('glSettings') || c === '$transaction'), false);
    }
  }
  // MANAGER بـcanManageCompanyUsers: يرى الدفاتر كمالك لكنه ليس ADMIN ⇒ ليس مالك الشركة
  seed();
  f.admins.set('mgr-owner', adminRow('mgr-owner', { role: 'MANAGER', canManageCompanyUsers: true, canConfigureLedger: true }));
  const m = await call('post', '/linking/preview', req('mgr-owner'));
  assert.equal(m.body?.code, 'LEDGER_LINKING_OWNER_ONLY');
});

test('مقيّد النطاق ⇒ 403 (LEDGER_SCOPED_ADMIN من الحارس الأول)، والمعطَّل ⇒ 403 — بلا أي قراءة دفاتر', async () => {
  for (const e of ENDPOINTS) {
    seed();
    const out = await call(e.method, e.path, req('scoped-owner', e.req));
    assert.equal(out.status, 403);
    assert.equal(out.body?.code, 'LEDGER_SCOPED_ADMIN');
    seed();
    const ina = await call(e.method, e.path, req('inactive-owner', e.req));
    assert.equal(ina.status, 403);
    assert.equal(f.calls.some((c) => c.startsWith('glLinkPreview')), false);
  }
});

test('مفتاح API ⇒ 403 LEDGER_LINKING_INTERACTIVE_ONLY ولو كان صاحبه المالك أو أصدره الدعم الفني', async () => {
  for (const e of ENDPOINTS) {
    for (const extra of [{ apiKeyId: 'key-1' }, { apiKeyId: 'key-2', ownerIssuedKey: true }]) {
      seed();
      const out = await call(e.method, e.path, req('owner-1', e.req, extra));
      assert.equal(out.status, 403);
      assert.equal(out.body?.code, 'LEDGER_LINKING_INTERACTIVE_ONLY');
      assert.equal(out.reached, 2);
      assert.equal(f.calls.some((c) => c.startsWith('glLinkPreview')), false);
    }
  }
});

test('requireCompanyOwner مباشرةً: مالكٌ من شركة أخرى أو بلا جلسة ⇒ OWNER_ONLY، وجلسة مالك المنصّة تمرّ بلا قراءة صفّ الحساب', async () => {
  const { requireCompanyOwner } = linkingModule as { requireCompanyOwner: Handle };
  seed();
  const other = await runChain([requireCompanyOwner], req('owner-2'), mockRes(T1, 'owner-2'));
  assert.equal(other.body?.code, 'LEDGER_LINKING_OWNER_ONLY');
  const none = await runChain([requireCompanyOwner], { params: {}, query: {}, body: {} }, mockRes(T1, ''));
  assert.equal(none.body?.code, 'LEDGER_LINKING_OWNER_ONLY');
  seed();
  let passed = false;
  await runChain([requireCompanyOwner, (_q: unknown, r: unknown) => { passed = true; (r as MockRes).json({ ok: true }); }],
    req('admin-noowner', {}, { impersonated: true }), mockRes(T1, 'admin-noowner'));
  assert.equal(passed, true);
  assert.equal(f.calls.includes('admin.findUnique'), false, 'جلسة المالك لا تُقرأ من صفّ الحساب');
});

test('جلسة مالك المنصّة ⇒ تمرّ وتُسجَّل OWNER:<id> وOWNER_SESSION', async () => {
  seed();
  const out = await call('post', '/linking/preview', req('admin-noowner', {}, { impersonated: true }));
  assert.equal(out.status, 202);
  await previewWorkerIdle();
  const r = f.previews[0];
  assert.equal(r.requestedBy, 'OWNER:admin-noowner');
  assert.deepEqual(r.options, { basis: 'FY_RESTATED', requestedVia: 'OWNER_SESSION' });
  assertOnlyPreviewWrites();
});

// ═══ ٢) POST /linking/preview ═══

test('POST: 202 جديدة ثم 200 للجارية بالمعرّف نفسه، ثم DONE بالمهمة', async () => {
  seed();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  runImpl = async (tenantId, opts) => { await gate; return makePreviewResult({ tenantId, linkedFrom: opts.linkedFrom }); };
  const a = await call('post', '/linking/preview', req('owner-1', { body: {} }));
  assert.equal(a.status, 202);
  const data = a.body?.data as Row;
  assert.deepEqual(Object.keys(data).sort(), ['existing', 'id', 'status']);
  assert.equal(data.status, 'QUEUED');
  assert.equal(data.existing, false);
  const b = await call('post', '/linking/preview', req('owner-1', { body: { basis: 'FROM_ACTIVATION' } }));
  assert.equal(b.status, 200);
  assert.equal((b.body?.data as Row).id, data.id);
  assert.equal((b.body?.data as Row).existing, true);
  assert.equal(f.previews.length, 1);
  release();
  await previewWorkerIdle();
  assert.equal(f.previews[0].status, 'DONE');
  assert.equal(f.previews[0].requestedBy, 'owner-1');
  assert.equal(runs[0].opts.linkedFrom.slice(5), '01-01', 'الافتراضي FY_RESTATED');
  // المسودة المخزّنة بمحلّل المعالج: المفتاح المجهول junk يسقط ويبقى ما يصحّ
  assert.deepEqual(runs[0].opts.draft, { step1: { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 }, step3: { cashInvoiceRouting: 'MAIN_CASH' } });
  assertOnlyPreviewWrites();
});

test('POST: الجسم صارم (أساس مجهول أو حقل زائد ⇒ ZodError ⇒ 400 من المعالج العام)', async () => {
  seed();
  await assert.rejects(call('post', '/linking/preview', req('owner-1', { body: { basis: 'YESTERDAY' } })), ZodError);
  await assert.rejects(call('post', '/linking/preview', req('owner-1', { body: { basis: 'FY_RESTATED', force: true } })), ZodError);
  assert.equal(f.previews.length, 0);
});

test('POST: الشركة المفعّلة ⇒ 409 LEDGER_LINK_ALREADY_ACTIVATED بلا صفّ', async () => {
  seed();
  (f.settings.get(T1) as Row).activatedAt = new Date('2026-10-01T00:00:00Z');
  const out = await call('post', '/linking/preview', req('owner-1'));
  assert.equal(out.status, 409);
  assert.equal(out.body?.code, 'LEDGER_LINK_ALREADY_ACTIVATED');
  assert.equal(out.body?.success, false);
  assert.equal(f.previews.length, 0);
});

test('POST: حدّ المعدّل ⇒ 429 LEDGER_LINK_PREVIEW_RATE_LIMITED بـretryAfterSeconds ورأس Retry-After', async () => {
  seed();
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    f.previews.push({
      id: `old-${i}`, tenantId: T1, status: 'DONE', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date(now - (50 - i * 5) * 60_000), heartbeatAt: new Date(now - (50 - i * 5) * 60_000), result: null,
    });
  }
  const res = mockRes(T1, 'owner-1');
  const out = await runChain(handlersFor('post', '/linking/preview'), req('owner-1'), res);
  assert.equal(out.status, 429);
  assert.equal(out.body?.code, 'LEDGER_LINK_PREVIEW_RATE_LIMITED');
  const retry = out.body?.retryAfterSeconds as number;
  assert.ok(retry > 590 && retry <= 600, `retryAfterSeconds=${retry}`);
  assert.equal(res.headers['Retry-After'], String(retry));
  assert.equal(f.previews.length, 6);
});

test('POST: دولة بلا قالب ⇒ 422 LEDGER_LINK_PARAMS_INVALID بسبب TEMPLATE_UNAVAILABLE', async () => {
  seed();
  f.settings.delete(T1);
  f.companies.set(T1, { tenantId: T1, countryCode: 'ZZ', currency: 'USD', currencyOverride: null });
  const out = await call('post', '/linking/preview', req('owner-1'));
  assert.equal(out.status, 422);
  assert.equal(out.body?.code, 'LEDGER_LINK_PARAMS_INVALID');
  assert.equal(out.body?.reason, 'TEMPLATE_UNAVAILABLE');
  assert.equal(f.previews.length, 0);
});

// ═══ ٣) القراءة ═══

test('GET /linking/preview/:id: معاينة شركة أخرى ⇒ 404، ومعاينة الشركة ⇒ الحالة والنتيجة', async () => {
  seed();
  const a = await call('post', '/linking/preview', req('owner-2', {}, { tenantId: T2 }), T2);
  assert.equal(a.status, 202);
  await previewWorkerIdle();
  const foreignId = (a.body?.data as Row).id as string;
  const nf = await call('get', '/linking/preview/:id', req('owner-1', { params: { id: foreignId } }));
  assert.equal(nf.status, 404);
  assert.equal(nf.body?.code, 'LEDGER_LINK_PREVIEW_NOT_FOUND');
  const own = await call('get', '/linking/preview/:id', req('owner-2', { params: { id: foreignId } }, { tenantId: T2 }), T2);
  assert.equal(own.status, 200);
  const v = own.body?.data as Row;
  assert.equal(v.status, 'DONE');
  assert.equal(v.linkedFrom, (runs[0].opts.linkedFrom));
  assert.equal(typeof v.createdAt, 'string');
  assert.equal(((v.result as Row).opening as Row & { totals: Row }).totals.debitMilli, '3690');
  for (const k of ['id', 'status', 'phase', 'progressPct', 'basis', 'linkedFrom', 'snapshotAt', 'dataHash', 'resultHash', 'resultBytes', 'errorCode',
    'error', 'createdAt', 'startedAt', 'finishedAt', 'heartbeatAt', 'result']) assert.ok(k in v, k);
});

test('GET /linking/previews: الأحدث أولاً بلا نتائج، وlimit ≤ 20 (21 ⇒ ZodError)', async () => {
  seed();
  for (let i = 0; i < 3; i++) {
    f.previews.push({
      id: `p-${i}`, tenantId: T1, status: 'DONE', basis: 'FY_RESTATED', linkedFrom: new Date('2026-01-01T00:00:00Z'), phase: 'DONE', progressPct: 100,
      createdAt: new Date(Date.now() - (3 - i) * 60_000), heartbeatAt: new Date(), result: { big: true },
    });
  }
  f.previews.push({ id: 'p-other', tenantId: T2, status: 'DONE', basis: 'FY_RESTATED', linkedFrom: new Date(), createdAt: new Date(), heartbeatAt: new Date(), result: null });
  const out = await call('get', '/linking/previews', req('owner-1', { query: { limit: '2' } }));
  assert.equal(out.status, 200);
  const list = out.body?.data as Row[];
  assert.deepEqual(list.map((x) => x.id), ['p-2', 'p-1']);
  assert.ok(list.every((x) => !('result' in x)));
  await assert.rejects(call('get', '/linking/previews', req('owner-1', { query: { limit: '21' } })), ZodError);
  await assert.rejects(call('get', '/linking/previews', req('owner-1', { query: { limit: '0' } })), ZodError);
});

test('GET /linking/preflight: LIGHT داخل لقطة REPEATABLE READ READ ONLY (أول عبارة) بمهلة 30 ثانية، والملّي نصوص', async () => {
  seed();
  const out = await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(out.status, 200);
  assert.match(f.rawStatements[0], /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
  assert.match(f.rawStatements[1], /SHOW transaction_read_only/);
  assert.deepEqual(f.txOpts[0], { timeout: 30_000, maxWait: 10_000 });
  assert.equal(preflightCalls.length, 1);
  const input = preflightCalls[0].input;
  assert.equal(input.mode, 'LIGHT');
  assert.equal(input.basis, 'FY_RESTATED');
  // ساعة القاعدة داخل اللقطة (2026-11-14) ⇒ بداية السنة
  assert.equal(input.linkedFrom, '2026-01-01');
  assert.equal(input.now.toISOString(), f.dbNow.toISOString());
  assert.equal('costing' in input, false);
  const data = out.body?.data as Row & { checks: Row[] };
  assert.equal(data.checks[0].valueMilli, '123450');
  assert.equal(data.mode, 'LIGHT');
  // FROM_ACTIVATION ⇒ اليوم المحلي
  const fa = await call('get', '/linking/preflight', req('owner-1', { query: { basis: 'FROM_ACTIVATION' } }));
  assert.equal(fa.status, 200);
  assert.equal(preflightCalls[1].input.linkedFrom, '2026-11-14');
  await assert.rejects(call('get', '/linking/preflight', req('owner-1', { query: { basis: 'X' } })), ZodError);
  assertOnlyPreviewWrites();
  assert.equal(f.writes.length, 0, 'الـpreflight لا يكتب شيئاً');
});

test('GET /linking/preflight: الطلبات المتزامنة للشركة والأساس نفسيهما تتشارك تشغيلاً واحداً', async () => {
  seed();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const base = preflightImpl;
  preflightImpl = async (tx, tid, input) => { await gate; return base(tx, tid, input); };
  try {
    const p1 = call('get', '/linking/preflight', req('owner-1'));
    const p2 = call('get', '/linking/preflight', req('owner-1'));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(preflightCalls.length, 1);
  } finally {
    preflightImpl = base;
  }
});

test('GET /linking/preflight: التقرير الخفيف يُحفظ PREFLIGHT_LIGHT_CACHE_MS لكل (شركة، أساس) ببصمة الإعدادات — فتح الصفحة لا يعيد المسح', async () => {
  seed();
  let t = 1_000_000;
  linkingModule.resetPreflightCacheForTests(() => t);
  const TTL = linkingModule.PREFLIGHT_LIGHT_CACHE_MS as number;
  const first = await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(preflightCalls.length, 1);
  const txBefore = f.txOpts.length;
  // داخل المدّة: من الذاكرة — لا لقطة ولا مسح، والردّ نفسه
  t += TTL - 1;
  const again = await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(preflightCalls.length, 1);
  assert.equal(f.txOpts.length, txBefore, 'لا معاملة لقطة');
  assert.deepEqual(again.body, first.body);
  // أساسٌ آخر وشركةٌ أخرى مفتاحان مستقلان
  await call('get', '/linking/preflight', req('owner-1', { query: { basis: 'FROM_ACTIVATION' } }));
  assert.equal(preflightCalls.length, 2);
  await call('get', '/linking/preflight', req('owner-2', {}, { tenantId: T2 }), T2);
  assert.equal(preflightCalls.length, 3);
  assert.equal(preflightCalls[2].tenantId, T2);
  // تعديل المعالج (بصمة الإعدادات) يُبطل المحفوظ فوراً
  const st = f.settings.get(T1)!;
  f.settings.set(T1, { ...st, setupDraft: { ...(st.setupDraft as Row), step3: { cashInvoiceRouting: 'CUSTODY' } } });
  await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(preflightCalls.length, 4);
  await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(preflightCalls.length, 4);
  // وانقضاء المدّة يعيد التشغيل
  t += TTL;
  await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(preflightCalls.length, 5);
  // الفشل لا يُحفظ
  const base = preflightImpl;
  preflightImpl = async () => { throw new Error('boom'); };
  try {
    t += TTL;
    await assert.rejects(call('get', '/linking/preflight', req('owner-1')));
  } finally {
    preflightImpl = base;
  }
  await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(preflightCalls.length, 7);
  linkingModule.resetPreflightCacheForTests();
  assert.equal(f.writes.length, 0);
});

test('GET /linking/preflight: دولة بلا قالب ⇒ 422 LEDGER_LINK_PARAMS_INVALID', async () => {
  seed();
  f.settings.delete(T1);
  f.companies.set(T1, { tenantId: T1, countryCode: 'ZZ', currency: 'USD', currencyOverride: null });
  const out = await call('get', '/linking/preflight', req('owner-1'));
  assert.equal(out.status, 422);
  assert.equal(out.body?.code, 'LEDGER_LINK_PARAMS_INVALID');
  assert.equal(preflightCalls.length, 0);
});

// ═══ ٤) حرّاس ثابتة على النصوص ═══

const ROUTES = path.join(SRC, 'routes', 'ledger');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('كل مسار في linking.ts يحمل حرفياً requireLedgerPermission(\'canConfigureLedger\') ثم requireCompanyOwner', () => {
  const s = stripComments(read(path.join(ROUTES, 'linking.ts')));
  const regs = [...s.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'([^\n]*)/g)];
  assert.deepEqual(regs.map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort(),
    ['GET /linking/preflight', 'GET /linking/preview/:id', 'GET /linking/previews', 'POST /linking/commit', 'POST /linking/preview']);
  for (const m of regs) {
    assert.match(m[3], /^,\s*requireLedgerPermission\('canConfigureLedger'\),\s*requireCompanyOwner,\s*ledgerHandler\(/, `${m[1]} ${m[2]}`);
  }
  // لا كتابة مباشرة من المسار (الصفّ تكتبه المهمة وحدها)
  assert.doesNotMatch(s, /prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
  assert.doesNotMatch(s, /\$executeRaw/);
});

test('jobs.ts: كل كتابة على glLinkPreview وحده، ولا SQL خام', () => {
  const s = stripComments(read(path.join(SRC, 'services', 'gl', 'linking', 'jobs.ts')));
  const writes = [...s.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g)].map((m) => m[1]);
  assert.ok(writes.length >= 5);
  assert.deepEqual([...new Set(writes)], ['glLinkPreview']);
  assert.doesNotMatch(s, /\$executeRaw|\$queryRaw/);
});

test('index.ts: سطرا الاستيراد والتركيب وحدهما — بعد سلسلة الحراسة وبعد setupRouter مباشرةً', () => {
  const idx = read(path.join(ROUTES, 'index.ts'));
  const lines = idx.split(/\r?\n/);
  const mentions = lines.filter((l) => /linking/i.test(l));
  assert.deepEqual(mentions, ["import linkingRouter from './linking';", 'router.use(linkingRouter);']);
  assert.equal(lines[lines.indexOf("import setupRouter from './setup';") + 1], "import linkingRouter from './linking';");
  assert.equal(lines[lines.indexOf('router.use(setupRouter);') + 1], 'router.use(linkingRouter);');
  const chain = idx.indexOf('router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext)');
  assert.ok(chain >= 0 && idx.indexOf('router.use(linkingRouter)') > chain);
});
