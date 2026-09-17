// M3 — مجدول المزامنة (DESIGN.md §5.1، §5.6، §5.9، §9.3): إصلاحات المراجعة.
//  - اتصالات SSE طويلة العمر لا تُعدّ طلبات جارية (وإلا تخطّى المعالج كل نبضة بتبويبات مفتوحة فقط).
//  - «مزامنة الآن» تحترم LEDGER_WORKER_ENABLED=0 وقفل العامل المشترك والضغط.
//  - الإيقاف المؤقت لا يقرأ شيئاً، وRUNNING ⇒ DONE يُكتب من المجدول وتُشغَّل الفحوص.
//  - الفحوص الليلية مرة لكل شركة في اليوم المحلي، والإشعار الأحمر بلا تكرار خلال 24 ساعة.
//  - حد تشغيل الفحوص يشمل `only`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  LEDGER_WORKER_MUTEX, createLedgerSyncScheduler, guardedManualSync, inFlightRequestCount, isLongLivedRequest, runLedgerManualSync,
  runNightlyChecksRound, trackLedgerRequestLoad,
} from '../services/gl/sync/scheduler';
import { backfillReconcilerFn } from '../services/gl/backfill';
import { createSyncBudget } from '../services/gl/sync/poster';
import { runTenantTick } from '../services/gl/sync/tick';
import type { ReconcilerStore } from '../services/gl/sync/reconciler';
import { recordChecksReport, notifiedKeys, type ChecksNotifyDb } from '../services/gl/checks/notify';
import type { ChecksReport } from '../services/gl/checks/types';
import { checksRunThrottle, normalizeOnly } from '../routes/ledger/checks';
import { CHECK_KEYS } from '../services/gl/checks/types';
import { FakePostingStore } from './gl-fake-posting-store';

const quiet = { log: () => undefined };

class FakeRes extends EventEmitter {
  headers: Record<string, unknown> = {};
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
}
const req = (p: { path: string; originalUrl?: string; accept?: string }) =>
  ({ path: p.path, originalUrl: p.originalUrl ?? `/api${p.path}`, url: p.path, headers: p.accept ? { accept: p.accept } : {} }) as unknown as Request;
const track = (r: Request) => {
  const res = new FakeRes();
  let nexted = false;
  trackLedgerRequestLoad(r, res as unknown as Response, () => { nexted = true; });
  assert.ok(nexted);
  return res;
};

test('SSE: 25 اتصال /live/stream مفتوحاً لا تُعدّ، والمجدول الافتراضي لا يتخطى بـREQUEST_PRESSURE', async () => {
  const base = inFlightRequestCount();
  for (let i = 0; i < 25; i++) track(req({ path: '/live/stream' }));
  track(req({ path: '/invoices', accept: 'text/event-stream' }));
  assert.equal(inFlightRequestCount(), base);
  assert.ok(isLongLivedRequest(req({ path: '/x', originalUrl: '/api/live/stream' })));
  const s = new FakePostingStore({ settings: { activatedAt: null } });
  const r = await createLedgerSyncScheduler({ store: s, ...quiet }).tick();
  assert.notEqual(r.skipped, 'REQUEST_PRESSURE');
});

test('ضابط: 21 طلباً عادياً لم ينتهِ ⇒ REQUEST_PRESSURE، وتنقص بالانتهاء؛ ورد يتحوّل SSE بعد العدّ يخرج منه', async () => {
  const base = inFlightRequestCount();
  const open = Array.from({ length: 21 }, () => track(req({ path: '/invoices' })));
  assert.equal(inFlightRequestCount(), base + 21);
  const logs: string[] = [];
  const sch = createLedgerSyncScheduler({ store: new FakePostingStore(), log: (m) => logs.push(m), pressureLogAfter: 2 });
  assert.equal((await sch.tick()).skipped, 'REQUEST_PRESSURE');
  assert.equal((await sch.tick()).skipped, 'REQUEST_PRESSURE');
  assert.deepEqual(logs, ['ticks skipped under request pressure'], 'تسجيل بعد تخطيات متتالية');
  open[0].setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  assert.equal(inFlightRequestCount(), base + 20);
  open[0].emit('close');
  assert.equal(inFlightRequestCount(), base + 20, 'لا نقص مزدوج');
  for (const r of open.slice(1)) r.emit('finish');
  assert.equal(inFlightRequestCount(), base);
});

test('«مزامنة الآن»: مطفأ ⇒ LEDGER_WORKER_UNAVAILABLE؛ نبضة جارية أو ضغط ⇒ running:true بلا تشغيل', async () => {
  const prev = process.env.LEDGER_WORKER_ENABLED;
  process.env.LEDGER_WORKER_ENABLED = '0';
  try {
    await assert.rejects(runLedgerManualSync('t1'), /LEDGER_WORKER_UNAVAILABLE/);
  } finally {
    if (prev === undefined) delete process.env.LEDGER_WORKER_ENABLED; else process.env.LEDGER_WORKER_ENABLED = prev;
  }
  const s = new FakePostingStore();
  await assert.rejects(guardedManualSync({ store: s }, 't1', { enabled: false }), /LEDGER_WORKER_UNAVAILABLE/);
  const mutex = { busy: true };
  const busy = await guardedManualSync({ store: s }, 't1', { mutex, inFlightRequests: () => 0 });
  assert.equal(busy.running, true);
  assert.equal(s.lockCalls, 0);
  const pressured = await guardedManualSync({ store: s }, 't1', { mutex: { busy: false }, inFlightRequests: () => 99, pressureThreshold: 20 });
  assert.equal(pressured.running, true);
  // المجدول يحترم القفل نفسه
  const r = await createLedgerSyncScheduler({ store: s, mutex, inFlightRequests: () => 0, ...quiet }).tick();
  assert.equal(r.skipped, 'TICK_IN_PROGRESS');
  assert.equal(LEDGER_WORKER_MUTEX.busy, false);
});

function countingReconcilerStore(): { store: ReconcilerStore; calls: string[] } {
  const calls: string[] = [];
  const store = new Proxy({}, { get: (_t, prop) => async () => { calls.push(String(prop)); return null; } }) as unknown as ReconcilerStore;
  return { store, calls };
}

test('الإيقاف المؤقت: المُطابِق وشبكة الأمان لا يقرآن شيئاً', async () => {
  const { store, calls } = countingReconcilerStore();
  const fn = backfillReconcilerFn(store);
  const s = new FakePostingStore({ settings: { backfillState: 'PAUSED' } });
  let safety = 0;
  const r = await runTenantTick({ store: s, reconcile: fn, safetyNet: async () => { safety++; }, inProcess: new Set(), ...quiet }, 't1', createSyncBudget({ timeMs: 60_000 }));
  assert.equal(r.leaseAcquired, true);
  assert.deepEqual(calls, []);
  assert.equal(safety, 0);
});

test('RUNNING ⇒ DONE من المجدول بلا GET /setup، وتُشغَّل الفحوص مرة، والتقييم بفاصل', async () => {
  const s = new FakePostingStore({ settings: { backfillState: 'RUNNING' } });
  let t = 1_000_000;
  let refreshed = 0;
  const done: string[] = [];
  const sch = createLedgerSyncScheduler({
    store: s, clock: () => t, inFlightRequests: () => 0, inProcess: new Set(), mutex: { busy: false }, ...quiet,
    refreshBackfill: async () => { refreshed++; return { state: 'DONE', caughtUp: true }; },
    onBackfillDone: async (id) => { done.push(id); },
  });
  await sch.tick();
  assert.equal(refreshed, 1);
  assert.deepEqual(done, ['t1']);
  t += 1000;
  await sch.tick();
  assert.equal(refreshed, 1, 'لا تقييم قبل الفاصل');
});

test('الفحوص الليلية: مرة لكل شركة في اليوم المحلي بعد الساعة 2، وخطأ شركة لا يوقف غيرها', async () => {
  const ran: string[] = [];
  let now = new Date('2027-03-01T23:30:00.000Z').getTime(); // 02:30 بالرياض يوم 03-02
  const lastRun = new Map<string, string>();
  const deps = {
    listTenants: async () => [{ tenantId: 'bad' }, { tenantId: 't1' }, { tenantId: 'off' }],
    timezoneOf: async (id: string) => (id === 'off' ? null : 'Asia/Riyadh'),
    runAndRecord: async (id: string) => { if (id === 'bad') throw new Error('x'); ran.push(id); },
    clock: () => now, lastRun, mutex: { busy: false }, inFlightRequests: () => 0, ...quiet,
  };
  assert.deepEqual(await runNightlyChecksRound(deps), ['t1']);
  assert.deepEqual(await runNightlyChecksRound(deps), [], 'اليوم نفسه');
  now = new Date('2027-03-02T20:00:00.000Z').getTime(); // 23:00 يوم 03-02
  assert.deepEqual(await runNightlyChecksRound(deps), []);
  now = new Date('2027-03-02T22:00:00.000Z').getTime(); // 01:00 يوم 03-03 — قبل الساعة 2
  assert.deepEqual(await runNightlyChecksRound(deps), []);
  now = new Date('2027-03-03T00:00:00.000Z').getTime(); // 03:00 يوم 03-03
  assert.deepEqual(await runNightlyChecksRound(deps), ['t1']);
  assert.deepEqual(await runNightlyChecksRound({ ...deps, mutex: { busy: true } }), [], 'نبضة جارية');
});

const report = (c8: 'RED' | 'GREEN'): ChecksReport => ({
  tenantId: 't1', ranAt: '2027-03-01T00:00:00.000Z', durationMs: 1, overall: c8,
  results: [{ key: 'C8', status: c8, title: 'أحداث', summary: 'حدث عالق', metrics: {}, rows: [], rowCount: 0, fix: null }],
});

test('recordChecksReport: إشعار أحمر جديد مرة، ولا يتكرر بعد إعادة التشغيل خلال 24 ساعة', async () => {
  const created: { data: string }[] = [];
  const db: ChecksNotifyDb = {
    notification: {
      findMany: async () => created.map((c) => ({ data: c.data })),
      create: async (a) => { created.push({ data: a.data.data }); return a; },
    },
  };
  const cache = new Map();
  assert.deepEqual(await recordChecksReport(db, 't1', report('RED'), { cache }), ['C8']);
  assert.deepEqual(await recordChecksReport(db, 't1', report('RED'), { cache }), [], 'الكاش أحمر');
  assert.deepEqual(await recordChecksReport(db, 't1', report('RED'), { cache: new Map() }), [], 'بعد إعادة التشغيل: من القاعدة');
  assert.equal(created.length, 1);
  assert.deepEqual([...notifiedKeys([{ data: 'x' }, { data: null }, { data: '{"keys":["C15"]}' }])], ['C15']);
});

test('حد تشغيل الفحوص يشمل only، وonly الكامل تشغيل كامل', () => {
  assert.equal(checksRunThrottle(undefined, 1000), null);
  assert.equal(checksRunThrottle(1000, 2000), 59);
  assert.equal(checksRunThrottle(1000, 61_000), null);
  assert.deepEqual(normalizeOnly(['C3', 'zz', 'C3']), ['C3']);
  assert.equal(normalizeOnly([...CHECK_KEYS]), undefined);
  assert.equal(normalizeOnly([]), undefined);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'checks.ts'), 'utf8');
  const body = route.slice(route.indexOf("router.post('/checks/run'"), route.indexOf("router.post('/checks/rebuild-balances'"));
  assert.ok(body.indexOf('checksRunThrottle(') < body.indexOf('runChecks('), 'الحد قبل التشغيل');
  assert.doesNotMatch(body, /!only\?\.length && cached/, 'لا تجاوز للحد بـonly');
  assert.ok(body.indexOf('LEDGER_CHECKS_LAST_RUN.set(') < body.indexOf('runChecks('));
});

test('حارس ثابت: المجدول يربط backfillReconcilerFn وrefreshBackfillState ويشغّل الفحوص الليلية عبر recordChecksReport', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'sync', 'scheduler.ts'), 'utf8');
  assert.match(s, /reconcile: backfillReconcilerFn\(reconcilerStore\)/);
  assert.match(s, /refreshBackfillState\(client, id\)/);
  assert.match(s, /runChecks\(createPrismaCheckStore\(client\), tenantId\)/);
  assert.match(s, /recordChecksReport\(client, tenantId, report\)/);
  assert.match(s, /runNightlyChecksRound\(/);
  const manual = s.slice(s.indexOf('export async function runLedgerManualSync'));
  assert.ok(manual.indexOf('isLedgerWorkerEnabled()') < manual.indexOf('ledgerWorkerDeps()'), 'مفتاح الإطفاء قبل إنشاء عميل المعالج');
});
