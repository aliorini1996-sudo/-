// M2 — تواريخ الإقفال (DESIGN.md §2.5، LOCK‑01، §9.5 G3، §10.1 صف M2: gl-lock-dates.test.ts).
// الإقفال النهائي لا يتراجع، لا تاريخ مستقبلي، المسودات قبل الإقفال؛ lockSyncBlockers صرفة بلا قاعدة؛
// وحراس ثابتة: routes/ledger/lockDates تستورد lockSyncBlockers وتأخذ قفل الترحيل أولاً وتدقّق داخل المعاملة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertNoDraftsBeforeLock, draftsBeforeLock, lockSyncBlockers, planLockDateChange,
  type LockDates, type LockSyncInput, type SourceEventSnapshot, type SyncCursorSnapshot,
} from '../services/gl/locks';
import { LedgerError, isLedgerError } from '../services/gl/types';
import { ledgerErrorResponse } from '../routes/ledger/errors';
import { loadLockSyncInput } from '../routes/ledger/lockDates';

const ROUTES = path.join(__dirname, '../routes/ledger');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const routeCode = (f: string) => stripComments(fs.readFileSync(path.join(ROUTES, f), 'utf8'));

const NO_LOCKS: LockDates = { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null };
const TODAY = '2026-09-16';

function throwsLedger(fn: () => unknown, code: string, check?: (e: LedgerError) => void) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isLedgerError(e), `ليس LedgerError: ${String(e)}`);
    assert.equal(e.code, code);
    check?.(e);
    return true;
  });
}

// ═══ قواعد التغيير (planLockDateChange) ═══

test('الإقفال النهائي لا يتراجع ولا يُمسح ⇒ LEDGER_LOCK_DATE_BACKWARD (422)', () => {
  const current = { ...NO_LOCKS, hardLockDate: '2026-06-30' };
  throwsLedger(() => planLockDateChange({ current, next: { hardLockDate: '2026-05-31' }, today: TODAY }), 'LEDGER_LOCK_DATE_BACKWARD',
    (e) => assert.deepEqual(e.details, { field: 'hardLockDate', from: '2026-06-30', to: '2026-05-31' }));
  throwsLedger(() => planLockDateChange({ current, next: { hardLockDate: null }, today: TODAY }), 'LEDGER_LOCK_DATE_BACKWARD');
  // المساواة ليست تراجعاً ولا تقدماً
  const same = planLockDateChange({ current, next: { hardLockDate: '2026-06-30' }, today: TODAY });
  assert.deepEqual(same.advancing, []);
  assert.equal(new LedgerError('LEDGER_LOCK_DATE_BACKWARD').httpStatus, 422);
});

test('لا تاريخ إقفال في المستقبل بتوقيت الشركة — واليوم نفسه مسموح', () => {
  for (const field of ['salesLockDate', 'purchaseLockDate', 'taxLockDate', 'hardLockDate'] as const) {
    throwsLedger(() => planLockDateChange({ current: NO_LOCKS, next: { [field]: '2026-09-17' }, today: TODAY }), 'LEDGER_PERIOD_LOCKED',
      (e) => assert.equal(e.details.reason, 'LOCK_DATE_IN_FUTURE'));
    const ok = planLockDateChange({ current: NO_LOCKS, next: { [field]: TODAY }, today: TODAY });
    assert.deepEqual(ok.advancing, [{ field, newDate: TODAY }]);
  }
});

test('تراجع إقفال المبيعات أو المشتريات أو الضريبة لا يُفحص، والتقدم وحده يمرّ على العوائق', () => {
  const current = { salesLockDate: '2026-08-31', purchaseLockDate: '2026-08-31', taxLockDate: '2026-06-30', hardLockDate: '2026-03-31' };
  const back = planLockDateChange({ current, next: { salesLockDate: '2026-07-31', purchaseLockDate: null, taxLockDate: '2026-03-31' }, today: TODAY });
  assert.deepEqual(back.advancing, [], 'التراجع لا يدخل advancing فلا يُفحص بـlockSyncBlockers ولا بالمسودات');
  assert.deepEqual(back.changes.filter((c) => c.direction === 'BACKWARD').map((c) => c.field), ['salesLockDate', 'purchaseLockDate', 'taxLockDate']);
  assert.equal(back.result.purchaseLockDate, null);

  const adv = planLockDateChange({ current, next: { salesLockDate: '2026-09-15', hardLockDate: '2026-06-30' }, today: TODAY });
  assert.deepEqual(adv.advancing, [{ field: 'salesLockDate', newDate: '2026-09-15' }, { field: 'hardLockDate', newDate: '2026-06-30' }]);
  // الحقل الغائب يبقى كما هو، وnull القائم ثم تاريخ = تقدم
  const first = planLockDateChange({ current: NO_LOCKS, next: { taxLockDate: '2026-06-30' }, today: TODAY });
  assert.deepEqual(first.advancing, [{ field: 'taxLockDate', newDate: '2026-06-30' }]);
  assert.equal(first.result.salesLockDate, null);
});

test('المسودات قبل الإقفال ⇒ LEDGER_DRAFTS_BEFORE_LOCK بـ{ids, count, listUrl}، والتاريخ نفسه يُحتسب', () => {
  const drafts = [
    { id: 'd1', date: '2026-06-30' },
    { id: 'd2', date: '2026-07-01' },
    { id: 'd3', date: '2026-01-15' },
  ];
  assert.deepEqual(draftsBeforeLock(drafts, '2026-06-30'), {
    ids: ['d1', 'd3'], count: 2, listUrl: '/app/ledger/entries?state=DRAFT&dateTo=2026-06-30',
  });
  assert.equal(draftsBeforeLock(drafts, '2026-01-14'), null);
  throwsLedger(() => assertNoDraftsBeforeLock(drafts, '2026-07-01'), 'LEDGER_DRAFTS_BEFORE_LOCK', (e) => assert.equal(e.details.count, 3));
  assert.doesNotThrow(() => assertNoDraftsBeforeLock([], '2026-07-01'));
});

// ═══ lockSyncBlockers — صرفة بلا قاعدة ═══

const NOW = new Date('2026-09-16T09:00:00.000Z');
const fresh = (source: string, extra: Partial<SyncCursorSnapshot> = {}): SyncCursorSnapshot => ({
  source, watermarkAt: new Date(NOW.getTime() - 30_000), lastRunAt: new Date(NOW.getTime() - 30_000), hasUnreadRows: false, ...extra,
});
const FRESH_CURSORS = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'].map((s) => fresh(s));
const ev = (status: string, effectAt: string, id = `e-${status}`): SourceEventSnapshot => ({ id, sourceKey: `INVOICE:${id}:POST`, status, effectAt: new Date(effectAt), lastError: null });

function input(p: Partial<LockSyncInput> & { settings?: Partial<LockSyncInput['settings']> } = {}): LockSyncInput {
  return {
    settings: { timezone: 'Asia/Riyadh', inventoryMode: 'PERIODIC', activatedAt: new Date('2026-01-01T00:00:00Z'), backfillState: 'DONE', ...(p.settings ?? {}) },
    cursors: p.cursors ?? FRESH_CURSORS,
    eventSummary: p.eventSummary ?? { events: [] },
    newDate: p.newDate ?? '2026-08-31',
    now: p.now ?? NOW,
  };
}

test('الحالة السليمة ⇒ null', () => {
  assert.equal(lockSyncBlockers(input()), null);
});

test('activatedAt فارغ ⇒ LEDGER_NOT_SETUP (حال كل M2) ولو بلا مؤشرات ولا أحداث', () => {
  const b = lockSyncBlockers(input({ settings: { activatedAt: null, backfillState: 'NONE' }, cursors: [] }));
  assert.ok(b);
  assert.equal(b.code, 'LEDGER_NOT_SETUP');
  assert.equal(new LedgerError('LEDGER_NOT_SETUP').httpStatus, 409);
});

test('backfillState بقيمة RUNNING أو PAUSED أو NONE ⇒ محجوب LEDGER_SYNC_PENDING', () => {
  for (const backfillState of ['RUNNING', 'PAUSED', 'NONE'] as const) {
    const b = lockSyncBlockers(input({ settings: { backfillState } }));
    assert.ok(b, backfillState);
    assert.equal(b.code, 'LEDGER_SYNC_PENDING');
    assert.equal(b.backfillState, backfillState);
  }
});

test('حدث PENDING/BLOCKED/ERROR/HELD تاريخه المحلي = التاريخ الجديد ⇒ محجوب؛ DONE وSKIPPED ⇒ مسموح', () => {
  for (const status of ['PENDING', 'BLOCKED', 'ERROR', 'HELD']) {
    const b = lockSyncBlockers(input({ eventSummary: { events: [ev(status, '2026-08-31T09:00:00.000Z')] } }));
    assert.ok(b, status);
    assert.equal(b.code, 'LEDGER_SYNC_PENDING');
    assert.equal(b.eventCount, 1);
    assert.deepEqual(b.events.map((e) => [e.id, e.status, e.effectAt]), [[`e-${status}`, status, '2026-08-31T09:00:00.000Z']]);
  }
  for (const status of ['DONE', 'SKIPPED']) {
    assert.equal(lockSyncBlockers(input({ eventSummary: { events: [ev(status, '2026-08-31T09:00:00.000Z')] } })), null, status);
  }
});

test('فخ المنطقة: 23:59 بالرياض يوم الإقفال ⇒ محجوب؛ 00:00 بالرياض يوم الإقفال+1 (ما زال يوم الإقفال بـUTC) ⇒ مسموح', () => {
  // 2026-08-31 23:59 بتوقيت الرياض = 20:59Z
  assert.ok(lockSyncBlockers(input({ eventSummary: { events: [ev('PENDING', '2026-08-31T20:59:00.000Z')] } })));
  // 2026-09-01 00:00 بتوقيت الرياض = 2026-08-31T21:00Z — تاريخه بـUTC يوم الإقفال، ومحلياً اليوم التالي
  assert.equal(lockSyncBlockers(input({ eventSummary: { events: [ev('PENDING', '2026-08-31T21:00:00.000Z')] } })), null);
  // والعكس: حدث قبل منتصف الليل UTC لكنه صباح اليوم التالي في منطقة شرقية بعيدة
  assert.equal(lockSyncBlockers(input({ settings: { timezone: 'Asia/Tokyo' }, eventSummary: { events: [ev('ERROR', '2026-08-31T15:30:00.000Z')] } })), null);
});

test('eventCount من القاعدة يحجب ولو كانت القائمة المقطوعة فارغة، والمعروض ≤ 50', () => {
  const b = lockSyncBlockers(input({ eventSummary: { events: [], eventCount: 120 } }));
  assert.ok(b);
  assert.equal(b.eventCount, 120);
  const many = Array.from({ length: 80 }, (_, i) => ev('HELD', `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00.000Z`, `h${i}`));
  const m = lockSyncBlockers(input({ eventSummary: { events: many } }));
  assert.ok(m);
  assert.equal(m.events.length, 50);
  assert.equal(m.eventCount, 80);
});

test('المؤشرات: lastRunAt أقدم من نبضتين ⇒ محجوب؛ صفوف غير مقروءة مع watermarkAt متأخر ⇒ محجوب؛ مؤشر قديم بلا صفوف غير مقروءة ⇒ مسموح', () => {
  const stale = [fresh('ACCOUNT_ENTRY', { lastRunAt: new Date(NOW.getTime() - 3 * 60_000) }), ...FRESH_CURSORS.slice(1)];
  const b1 = lockSyncBlockers(input({ cursors: stale }));
  assert.ok(b1);
  assert.deepEqual(b1.laggingSources.map((s) => s.source), ['ACCOUNT_ENTRY']);

  const behind = [fresh('ACCOUNT_ENTRY', { watermarkAt: new Date(NOW.getTime() - 60 * 60_000), hasUnreadRows: true }), ...FRESH_CURSORS.slice(1)];
  const b2 = lockSyncBlockers(input({ cursors: behind }));
  assert.ok(b2);
  assert.equal(b2.code, 'LEDGER_SYNC_PENDING');
  assert.deepEqual(b2.laggingSources.map((s) => s.source), ['ACCOUNT_ENTRY']);

  const quiet = [fresh('ACCOUNT_ENTRY', { watermarkAt: new Date('2025-01-01T00:00:00Z'), hasUnreadRows: false }), ...FRESH_CURSORS.slice(1)];
  assert.equal(lockSyncBlockers(input({ cursors: quiet })), null, 'شركة هادئة: المؤشر عند آخر صف قديم ليس متأخراً');

  // مؤشر نشط غائب ⇒ متأخر؛ ومصادر المخزون نشطة في الجرد المستمر وحده
  assert.ok(lockSyncBlockers(input({ cursors: FRESH_CURSORS.slice(0, 2) })));
  assert.equal(lockSyncBlockers(input({ settings: { inventoryMode: 'PERIODIC' } })), null);
  const perp = lockSyncBlockers(input({ settings: { inventoryMode: 'PERPETUAL' } }));
  assert.ok(perp);
  assert.deepEqual(perp.laggingSources.map((s) => s.source), ['WAREHOUSE_ENTRY', 'VAN_LOAD', 'RETURN_RESTOCK']);
});

// ═══ مدخلات المسار من القاعدة (مخزن مزيّف) ═══

test('loadLockSyncInput: الأحداث بشرط التاريخ المحلي على الفهرس والعدد، والصفوف غير المقروءة حتى الأفق فعلياً (M3)', async () => {
  const calls: { model: string; op: string; args: any }[] = [];
  const events = [ev('PENDING', '2026-08-31T20:59:00.000Z')];
  const fake = {
    glSyncCursor: {
      findMany: async (args: any) => {
        calls.push({ model: 'cursor', op: 'findMany', args });
        return [
          { source: 'ACCOUNT_ENTRY', watermarkAt: new Date('2025-01-01T00:00:00Z'), watermarkId: 'w1', lastRunAt: new Date(NOW.getTime() - 10_000) },
          { source: 'REP_SETTLEMENT', watermarkAt: new Date('2025-01-01T00:00:00Z'), watermarkId: '', lastRunAt: new Date(NOW.getTime() - 10_000) },
          { source: 'WAREHOUSE_ENTRY', watermarkAt: new Date('2025-01-01T00:00:00Z'), watermarkId: '', lastRunAt: null },
        ];
      },
    },
    accountEntry: { findFirst: async (args: any) => { calls.push({ model: 'accountEntry', op: 'findFirst', args }); return { id: 'e1' }; } },
    repSettlement: { findFirst: async (args: any) => { calls.push({ model: 'repSettlement', op: 'findFirst', args }); return null; } },
    glSourceEvent: {
      findMany: async (args: any) => { calls.push({ model: 'event', op: 'findMany', args }); return events; },
      count: async (args: any) => { calls.push({ model: 'event', op: 'count', args }); return 7; },
    },
  };
  const settings = {
    timezone: 'Asia/Riyadh', inventoryMode: 'PERIODIC', activatedAt: null, backfillState: 'NONE',
    salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null,
  };
  const inp = await loadLockSyncInput(fake as any, 't1', settings, '2026-08-31', NOW);
  const find = calls.find((c) => c.model === 'event' && c.op === 'findMany')!;
  assert.equal(find.args.where.tenantId, 't1');
  assert.deepEqual(find.args.where.status, { in: ['PENDING', 'BLOCKED', 'ERROR', 'HELD'] });
  assert.equal(find.args.where.effectAt.lt.toISOString(), '2026-08-31T21:00:00.000Z', 'effectAt < بداية اليوم التالي بتوقيت الشركة');
  assert.equal(find.args.take, 50);
  assert.equal(calls.find((c) => c.model === 'cursor')!.args.where.tenantId, 't1');
  assert.equal(inp.eventSummary.eventCount, 7);
  // M3 (الالتزام 2): EXISTS … ("createdAt","id") > المؤشر AND "createdAt" <= horizon (dbNow − 10 دقائق)
  const unread = calls.find((c) => c.model === 'accountEntry')!;
  assert.equal(unread.args.where.tenantId, 't1');
  assert.equal(unread.args.where.createdAt.lte.toISOString(), new Date(NOW.getTime() - 10 * 60_000).toISOString());
  assert.deepEqual(unread.args.where.OR, [
    { createdAt: { gt: new Date('2025-01-01T00:00:00Z') } },
    { createdAt: new Date('2025-01-01T00:00:00Z'), id: { gt: 'w1' } },
  ]);
  assert.deepEqual(inp.cursors.map((c) => [c.source, c.hasUnreadRows]), [
    ['ACCOUNT_ENTRY', true], ['REP_SETTLEMENT', false], ['WAREHOUSE_ENTRY', true],
  ], 'مصدر المخزون بلا مُطابِق بعد يبقى محافظاً');
  const b = lockSyncBlockers(inp);
  assert.ok(b);
  assert.equal(b.code, 'LEDGER_NOT_SETUP', 'M2: activatedAt فارغ ⇒ LEDGER_NOT_SETUP');
});

// ═══ ترجمة الأخطاء إلى HTTP ═══

test('الأخطاء إلى HTTP: 409 للمزامنة وعدم الإعداد، 422 للتراجع والمسودات، والتفاصيل بجانب الرمز دون الكتابة فوقه', () => {
  const b = lockSyncBlockers(input({ settings: { backfillState: 'RUNNING' } }))!;
  const { code, ...details } = b;
  const r = ledgerErrorResponse(new LedgerError(code, { ...details, field: 'hardLockDate' }))!;
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LEDGER_SYNC_PENDING');
  assert.equal(r.body.backfillState, 'RUNNING');
  assert.deepEqual(r.body.laggingSources, []);
  assert.equal(r.body.success, false);
  assert.equal(ledgerErrorResponse(new LedgerError('LEDGER_NOT_SETUP'))!.status, 409);
  assert.equal(ledgerErrorResponse(new LedgerError('LEDGER_LOCK_DATE_BACKWARD'))!.status, 422);
  assert.equal(ledgerErrorResponse(new LedgerError('LEDGER_DRAFTS_BEFORE_LOCK', { ids: ['d'], count: 1 }))!.status, 422);
  // تفصيل اسمه code (رمز الدفتر) لا يكتب فوق رمز الخطأ ويبقى في details
  const conflict = ledgerErrorResponse(new LedgerError('LEDGER_JOURNAL_CODE_CONFLICT', { code: 'INV', conflictsWith: 'RINV' }))!;
  assert.equal(conflict.body.code, 'LEDGER_JOURNAL_CODE_CONFLICT');
  assert.equal((conflict.body.details as any).code, 'INV');
  assert.equal(ledgerErrorResponse(new Error('x')), null);
});

// ═══ حراس ثابتة ═══

test('routes/ledger/lockDates تستورد lockSyncBlockers من services/gl/locks وتستدعيه لكل تاريخ يتقدم', () => {
  const src = routeCode('lockDates.ts');
  assert.match(src, /import\s*\{[^}]*\blockSyncBlockers\b[^}]*\}\s*from\s*'\.\.\/\.\.\/services\/gl\/locks'/);
  assert.match(src, /import\s*\{[^}]*\bplanLockDateChange\b[^}]*\}\s*from\s*'\.\.\/\.\.\/services\/gl\/locks'/);
  assert.match(src, /for \(const adv of plan\.advancing\)[\s\S]*?lockSyncBlockers\(/);
  assert.match(src, /draftsBeforeLock\(/);
});

test('PUT /lock-dates: قفل الترحيل أول عبارة، ثم الخطة ثم العوائق ثم المسودات ثم الكتابة ثم التدقيق — في معاملة واحدة', () => {
  const src = routeCode('lockDates.ts');
  const start = src.indexOf("router.put('/lock-dates'");
  assert.ok(start >= 0, 'PUT /lock-dates مفقود');
  const body = src.slice(start, src.indexOf('\n}));', start));
  assert.match(body, /requireLedgerPermission|PERM/);
  const tx = body.indexOf('prisma.$transaction(async (tx) => {');
  assert.ok(tx > 0, 'لا معاملة');
  const inner = body.slice(tx);
  const firstStmt = inner.slice(inner.indexOf('{') + 1).trim();
  assert.ok(firstStmt.startsWith('await acquirePostLock(tx, tenantId);'), 'acquirePostLock ليست أول عبارة في المعاملة');
  const order = ['acquirePostLock(tx', 'tx.glSettings.findUnique(', 'planLockDateChange(', 'lockSyncBlockers(', 'draftsBeforeLock(', 'tx.glSettings.update(', "action: 'LOCK_DATE_CHANGE'", 'tx.notification.create('];
  let last = -1;
  for (const n of order) {
    const i = inner.indexOf(n, last + 1);
    assert.ok(i > last, `«${n}» مفقود أو خارج الترتيب`);
    last = i;
  }
  assert.match(inner, /appendAudit\(tx,/, 'التدقيق داخل المعاملة نفسها');
  assert.match(src, /const PERM = requireLedgerPermission\('canCloseLedgerPeriods'\)/);
  assert.match(src, /router\.get\('\/lock-dates', PERM/);
});

test('الموجّه مسجَّل في routes/ledger/index.ts بعد سلسلة الحراسة، ومعه التهيئة والقيود والمفضلات والتصدير', () => {
  const src = routeCode('index.ts');
  const guard = src.indexOf('router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext)');
  assert.ok(guard > 0);
  for (const [name, file] of [['lockDatesRouter', 'lockDates'], ['configRouter', 'config'], ['movesRouter', 'moves'], ['savedFiltersRouter', 'savedFilters'], ['listsRouter', 'lists']]) {
    assert.match(src, new RegExp(`import ${name} from '\\./${file}'`), `${file} غير مستورد`);
    const use = src.indexOf(`router.use(${name})`);
    assert.ok(use > guard, `${name} غير مسجَّل بعد سلسلة الحراسة`);
  }
});
