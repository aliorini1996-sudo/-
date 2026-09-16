// M1 — تواريخ الإقفال (DESIGN.md §2.5، ADR‑7، G3 §9.5): الإزاحة، الرفض، التغيير، وlockSyncBlockers الصرفة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCK_DATE_FIELDS, LOCK_BLOCKING_EVENT_STATUSES, LOCK_SYNC_EVENT_LIMIT, LOCK_SYNC_HEARTBEAT_MS,
  LOCK_SYNC_LATE_COMMIT_WINDOW_MS, activeSyncSources, applicableLockFields, applyAutoLockShift,
  assertManualDateOpen, assertNoDraftsBeforeLock, assertNoLockSyncBlockers, autoReversalDate, draftsBeforeLock,
  effectiveLockDate, firstOpenDate, isCursorLagging, isDateLocked, lockScopeOf, lockScopeOfDraft,
  lockSyncBlockers, lockSyncEventCutoff, lockSyncEventWhere, manualReversalDate, planLockDateChange,
  shiftAutoMoveDate, type LockDates, type LockScope, type LockSyncInput, type SourceEventSnapshot,
  type SyncCursorSnapshot,
} from '../services/gl/locks';
import {
  LedgerError, createBuildContext, isLedgerError, type AccountRef, type JournalRef, type MoveDraft,
} from '../services/gl/types';

const NO_LOCKS: LockDates = { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null };
const GENERAL: LockScope = { journalType: 'GENERAL', touchesReceivable: false, touchesPayable: false, touchesTax: false };
const SALE: LockScope = { journalType: 'SALE', touchesReceivable: true, touchesPayable: false, touchesTax: true };
const PURCHASE: LockScope = { journalType: 'PURCHASE', touchesReceivable: false, touchesPayable: true, touchesTax: true };

function locks(p: Partial<LockDates>): LockDates {
  return { ...NO_LOCKS, ...p };
}

function throwsLedger(fn: () => unknown, code: string, check?: (e: LedgerError) => void) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isLedgerError(e), `ليس LedgerError: ${String(e)}`);
    assert.equal(e.code, code);
    check?.(e);
    return true;
  });
}

// ═══ النطاق وتاريخ الإقفال الفعّال ═══

test('النطاق: الدفتر وسطور الذمم والضريبة', () => {
  assert.deepEqual(lockScopeOf({ journalType: 'GENERAL', lines: [{ controlKind: null, accountType: 'asset_cash' }] }), GENERAL);
  const rcpt = lockScopeOf({
    journalType: 'GENERAL',
    lines: [{ controlKind: null, accountType: 'asset_cash' }, { controlKind: 'AR', accountType: 'asset_receivable' }],
  });
  assert.equal(rcpt.touchesReceivable, true);
  assert.equal(rcpt.touchesTax, false);
  // 113003 (عجز عهدة) من نوع asset_receivable بلا controlKind يبقى ذمة عميل
  assert.equal(lockScopeOf({ journalType: 'GENERAL', lines: [{ accountType: 'asset_receivable' }] }).touchesReceivable, true);
  assert.equal(lockScopeOf({ journalType: 'GENERAL', lines: [{ controlKind: 'AP' }] }).touchesPayable, true);
  assert.equal(lockScopeOf({ journalType: 'GENERAL', lines: [{ accountType: 'liability_payable' }] }).touchesPayable, true);
  // سطر ضريبي بأي من: taxRole (ومنها MARKER)، taxId، taxCode، vatBox، حساب VAT_OUT/VAT_IN
  for (const l of [{ taxRole: 'MARKER' as const }, { taxRole: 'BASE' as const }, { taxId: 't' }, { taxCode: 'S15_SALE' }, { vatBox: 'SA_1' }, { controlKind: 'VAT_OUT' as const }, { controlKind: 'VAT_IN' as const }]) {
    assert.equal(lockScopeOf({ journalType: 'GENERAL', lines: [l] }).touchesTax, true, JSON.stringify(l));
  }
  assert.equal(lockScopeOf({ journalType: 'GENERAL', lines: [{ controlKind: 'CUSTODY' }] }).touchesTax, false);
});

test('الحقول المنطبقة: hardLockDate دائماً', () => {
  assert.deepEqual(applicableLockFields(GENERAL), ['hardLockDate']);
  assert.deepEqual(applicableLockFields({ ...GENERAL, journalType: 'SALE' }), ['salesLockDate', 'hardLockDate']);
  assert.deepEqual(applicableLockFields({ ...GENERAL, journalType: 'PURCHASE' }), ['purchaseLockDate', 'hardLockDate']);
  assert.deepEqual(applicableLockFields({ ...GENERAL, touchesTax: true }), ['taxLockDate', 'hardLockDate']);
  assert.deepEqual(applicableLockFields(SALE), ['salesLockDate', 'taxLockDate', 'hardLockDate']);
  assert.deepEqual(applicableLockFields({ journalType: null, touchesReceivable: true, touchesPayable: true, touchesTax: true }), [...LOCK_DATE_FIELDS]);
});

test('الإقفال الفعّال = أكبر المنطبق، والشمول: التاريخ = الإقفال مقفل', () => {
  const l = locks({ salesLockDate: '2026-06-30', purchaseLockDate: '2026-08-31', taxLockDate: '2026-03-31', hardLockDate: '2025-12-31' });
  assert.deepEqual(effectiveLockDate(l, SALE), { lockDate: '2026-06-30', fields: ['salesLockDate'] });
  assert.deepEqual(effectiveLockDate(l, PURCHASE), { lockDate: '2026-08-31', fields: ['purchaseLockDate'] });
  assert.deepEqual(effectiveLockDate(l, GENERAL), { lockDate: '2025-12-31', fields: ['hardLockDate'] });
  // إقفال المبيعات لا يمسّ قيداً عاماً بلا ذمم ولا ضريبة
  assert.equal(isDateLocked('2026-05-01', l, GENERAL), false);
  assert.equal(isDateLocked('2026-06-30', l, SALE), true);
  assert.equal(isDateLocked('2026-07-01', l, SALE), false);
  assert.equal(firstOpenDate(l, SALE), '2026-07-01');
  assert.equal(firstOpenDate(NO_LOCKS, SALE), null);
  assert.deepEqual(effectiveLockDate(NO_LOCKS, SALE), { lockDate: null, fields: [] });
  // تساوي حقلين
  assert.deepEqual(effectiveLockDate(locks({ taxLockDate: '2026-03-31', hardLockDate: '2026-03-31' }), SALE).fields, ['taxLockDate', 'hardLockDate']);
  // نهاية الشهر وفبراير الكبيس
  assert.equal(firstOpenDate(locks({ hardLockDate: '2028-02-28' }), GENERAL), '2028-02-29');
  assert.equal(firstOpenDate(locks({ hardLockDate: '2026-12-31' }), GENERAL), '2027-01-01');
  assert.throws(() => effectiveLockDate(locks({ hardLockDate: '2026-02-30' }), GENERAL), RangeError);
});

test('نطاق مسودة: الدفتر بـsystemKey والحساب بـid ثم code ثم key', () => {
  const accounts: AccountRef[] = [
    { id: 'a-ar', code: '113001', name: 'ذمم العملاء', type: 'asset_receivable', isActive: true, reconcile: true, controlKind: 'AR' },
    { id: 'a-rev', code: '411001', name: 'المبيعات', type: 'income', isActive: true, reconcile: false, controlKind: null },
    { id: 'a-vat', code: '212001', name: 'ضريبة المخرجات', type: 'liability_current', isActive: true, reconcile: false, controlKind: 'VAT_OUT' },
    { id: 'a-cash', code: '111001', name: 'الصندوق', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null },
  ];
  const j = (code: string, type: JournalRef['type'], systemKey: JournalRef['systemKey']): JournalRef => ({
    id: `j-${code}`, code, name: code, type, systemKey, defaultAccountId: null, suspenseAccountId: null,
    useOutstandingAccounts: false, sequenceReset: 'YEARLY', isActive: true,
  });
  const ctx = createBuildContext({
    accounts, mappings: { AR_CONTROL: 'a-ar', OUTPUT_VAT: 'a-vat', MAIN_CASH: 'a-cash' },
    journals: [j('SALES1', 'SALE', 'SALES'), j('MISC', 'GENERAL', 'MISC')],
  });
  const base: Omit<MoveDraft, 'lines'> = {
    kind: 'MOVE', journalCode: 'INV', journalSystemKey: 'SALES', moveType: 'OUT_INVOICE', origin: 'AUTO', date: '2026-09-16',
    narration: 'x', needsAttention: false, currencyCode: 'SAR', currencyDecimals: 2,
  };
  const inv: MoveDraft = {
    ...base,
    lines: [
      { accountKey: 'AR_CONTROL', label: 'ذمة', debitMilli: 115_000n, creditMilli: 0n, customerId: 'c1' },
      { accountCode: '411001', label: 'إيراد', debitMilli: 0n, creditMilli: 100_000n },
      { accountId: 'a-vat', label: 'ضريبة', debitMilli: 0n, creditMilli: 15_000n, taxRole: 'TAX' },
    ],
  };
  // الرمز INV غير موجود لكن systemKey يحلّ الدفتر (رمزه المعدّل SALES1)
  assert.deepEqual(lockScopeOfDraft(inv, ctx), SALE);
  const misc: MoveDraft = {
    ...base, journalCode: 'MISC', journalSystemKey: undefined, moveType: 'ENTRY',
    lines: [
      { accountKey: 'MAIN_CASH', label: 'نقد', debitMilli: 1000n, creditMilli: 0n },
      { accountCode: '411001', label: 'إيراد', debitMilli: 0n, creditMilli: 1000n },
    ],
  };
  assert.deepEqual(lockScopeOfDraft(misc, ctx), GENERAL);
  // دفتر غير محلول ⇒ journalType null
  assert.equal(lockScopeOfDraft({ ...misc, journalCode: 'NOPE' }, ctx).journalType, null);
});

// ═══ القيود الآلية: ADR‑7 ═══

test('ADR‑7: date = max(docDate, lock+1) مع lateArrival وoriginalDate', () => {
  const l = locks({ salesLockDate: '2026-06-30', taxLockDate: '2026-03-31', hardLockDate: '2025-12-31' });
  // فاتورة مندوب مطبوعة دون اتصال بتاريخ 2026-06-15 تصل بعد إقفال يونيو
  assert.deepEqual(shiftAutoMoveDate('2026-06-15', l, SALE), { date: '2026-07-01', lateArrival: true, originalDate: '2026-06-15' });
  // على حد الإقفال تماماً
  assert.deepEqual(shiftAutoMoveDate('2026-06-30', l, SALE), { date: '2026-07-01', lateArrival: true, originalDate: '2026-06-30' });
  // أول يوم مفتوح لا يُزاح
  assert.deepEqual(shiftAutoMoveDate('2026-07-01', l, SALE), { date: '2026-07-01', lateArrival: false, originalDate: null });
  assert.deepEqual(shiftAutoMoveDate('2026-09-16', l, SALE), { date: '2026-09-16', lateArrival: false, originalDate: null });
  // قيد عام (عهدة بلا ذمم ولا ضريبة) لا يحكمه إلا النهائي
  assert.deepEqual(shiftAutoMoveDate('2026-06-15', l, GENERAL), { date: '2026-06-15', lateArrival: false, originalDate: null });
  assert.deepEqual(shiftAutoMoveDate('2025-11-02', l, GENERAL), { date: '2026-01-01', lateArrival: true, originalDate: '2025-11-02' });
  // سند (ذمة بلا ضريبة) يحكمه إقفال المبيعات
  const rcpt: LockScope = { ...GENERAL, touchesReceivable: true };
  assert.equal(shiftAutoMoveDate('2026-05-01', l, rcpt).date, '2026-07-01');
  // قيد ضريبي فقط يحكمه إقفال الضريبة
  const taxOnly: LockScope = { ...GENERAL, touchesTax: true };
  assert.equal(shiftAutoMoveDate('2026-02-10', l, taxOnly).date, '2026-04-01');
  assert.equal(shiftAutoMoveDate('2026-05-10', l, taxOnly).lateArrival, false);
  // بلا إقفال لا شيء
  assert.deepEqual(shiftAutoMoveDate('2020-01-01', NO_LOCKS, SALE), { date: '2020-01-01', lateArrival: false, originalDate: null });
  assert.throws(() => shiftAutoMoveDate('2026/06/15', l, SALE), RangeError);
});

test('applyAutoLockShift: نسخة مُزاحة، ويُحفظ originalDate الأقدم', () => {
  const draft: MoveDraft = {
    kind: 'MOVE', journalCode: 'INV', moveType: 'OUT_INVOICE', origin: 'AUTO', date: '2026-06-15', narration: 'x',
    needsAttention: false, currencyCode: 'SAR', currencyDecimals: 2, lines: [],
  };
  const l = locks({ salesLockDate: '2026-06-30' });
  const out = applyAutoLockShift(draft, l, SALE);
  assert.equal(out.date, '2026-07-01');
  assert.equal(out.lateArrival, true);
  assert.equal(out.originalDate, '2026-06-15');
  assert.equal(draft.date, '2026-06-15', 'لا تعديل على الأصل');
  // غير مُزاح
  const same = applyAutoLockShift({ ...draft, date: '2026-08-01' }, l, SALE);
  assert.equal(same.date, '2026-08-01');
  assert.equal(same.lateArrival, false);
  assert.equal(same.originalDate, null);
  // مُزاح مسبقاً لتاريخ البدء (§5.6): originalDate الأقدم يبقى
  const cut = applyAutoLockShift({ ...draft, date: '2026-06-01', lateArrival: true, originalDate: '2026-05-20' }, l, SALE);
  assert.deepEqual([cut.date, cut.lateArrival, cut.originalDate], ['2026-07-01', true, '2026-05-20']);
  const cutOpen = applyAutoLockShift({ ...draft, date: '2026-08-01', lateArrival: true, originalDate: '2026-05-20' }, l, SALE);
  assert.deepEqual([cutOpen.date, cutOpen.lateArrival, cutOpen.originalDate], ['2026-08-01', true, '2026-05-20']);
});

test('العكس الآلي: max(اليوم، الأصل) ثم الإزاحة', () => {
  const l = locks({ salesLockDate: '2026-08-31' });
  assert.deepEqual(autoReversalDate('2026-09-16', '2026-07-10', l, SALE), { date: '2026-09-16', lateArrival: false, originalDate: null });
  // أصل مؤرخ مستقبلاً
  assert.equal(autoReversalDate('2026-09-16', '2026-10-01', l, SALE).date, '2026-10-01');
  // اليوم داخل الفترة المقفلة (إقفال مسبق لتاريخ اليوم غير ممكن عادةً لكن الدالة تحرسه)
  assert.deepEqual(autoReversalDate('2026-08-20', '2026-07-10', l, SALE), { date: '2026-09-01', lateArrival: true, originalDate: '2026-08-20' });
});

// ═══ القيود اليدوية ═══

test('اليدوي في فترة مقفلة ⇒ LEDGER_PERIOD_LOCKED (422)', () => {
  const l = locks({ purchaseLockDate: '2026-07-31', hardLockDate: '2026-03-31' });
  throwsLedger(() => assertManualDateOpen('2026-07-31', l, PURCHASE), 'LEDGER_PERIOD_LOCKED', e => {
    assert.equal(e.httpStatus, 422);
    assert.deepEqual(e.details, { date: '2026-07-31', lockDate: '2026-07-31', lockFields: ['purchaseLockDate'], firstOpenDate: '2026-08-01' });
  });
  assert.doesNotThrow(() => assertManualDateOpen('2026-08-01', l, PURCHASE));
  assert.doesNotThrow(() => assertManualDateOpen('2026-05-01', l, GENERAL));
  throwsLedger(() => assertManualDateOpen('2026-03-31', l, GENERAL), 'LEDGER_PERIOD_LOCKED');
  assert.doesNotThrow(() => assertManualDateOpen('1999-01-01', NO_LOCKS, SALE));
});

test('العكس اليدوي (JE‑06): ≥ الأصل وخارج المقفل، والافتراضي max(اليوم، الأصل)', () => {
  const l = locks({ hardLockDate: '2026-06-30' });
  assert.equal(manualReversalDate({ today: '2026-09-16', originalMoveDate: '2026-05-10', locks: l, scope: GENERAL }), '2026-09-16');
  assert.equal(manualReversalDate({ today: '2026-09-16', originalMoveDate: '2026-10-01', locks: l, scope: GENERAL }), '2026-10-01');
  assert.equal(manualReversalDate({ requested: '2026-07-01', today: '2026-09-16', originalMoveDate: '2026-05-10', locks: l, scope: GENERAL }), '2026-07-01');
  throwsLedger(() => manualReversalDate({ requested: '2026-06-30', today: '2026-09-16', originalMoveDate: '2026-05-10', locks: l, scope: GENERAL }), 'LEDGER_PERIOD_LOCKED');
  throwsLedger(
    () => manualReversalDate({ requested: '2026-07-05', today: '2026-09-16', originalMoveDate: '2026-07-10', locks: l, scope: GENERAL }),
    'LEDGER_PERIOD_LOCKED',
    e => assert.equal(e.details.reason, 'BEFORE_ORIGINAL_DATE'),
  );
});

// ═══ تغيير تواريخ الإقفال ═══

test('الإقفال النهائي لا يتراجع ⇒ LEDGER_LOCK_DATE_BACKWARD، ولا يُمسح', () => {
  const current = locks({ hardLockDate: '2026-06-30' });
  throwsLedger(() => planLockDateChange({ current, next: { hardLockDate: '2026-06-29' }, today: '2026-09-16' }), 'LEDGER_LOCK_DATE_BACKWARD', e => {
    assert.equal(e.httpStatus, 422);
    assert.deepEqual(e.details, { field: 'hardLockDate', from: '2026-06-30', to: '2026-06-29' });
  });
  throwsLedger(() => planLockDateChange({ current, next: { hardLockDate: null }, today: '2026-09-16' }), 'LEDGER_LOCK_DATE_BACKWARD');
  // الثبات والتقدم مسموحان
  assert.deepEqual(planLockDateChange({ current, next: { hardLockDate: '2026-06-30' }, today: '2026-09-16' }).advancing, []);
  assert.deepEqual(planLockDateChange({ current, next: { hardLockDate: '2026-07-31' }, today: '2026-09-16' }).advancing, [{ field: 'hardLockDate', newDate: '2026-07-31' }]);
});

test('تراجع المبيعات أو المشتريات أو الضريبة ⇒ لا فحص؛ التقدم أو من null ⇒ يُفحص', () => {
  const current = locks({ salesLockDate: '2026-06-30', purchaseLockDate: '2026-06-30', taxLockDate: '2026-06-30', hardLockDate: '2026-03-31' });
  const back = planLockDateChange({
    current, today: '2026-09-16',
    next: { salesLockDate: '2026-05-31', purchaseLockDate: null, taxLockDate: '2026-03-31' },
  });
  assert.deepEqual(back.advancing, []);
  assert.deepEqual(back.changes.map(c => c.direction), ['BACKWARD', 'BACKWARD', 'BACKWARD', 'UNCHANGED']);
  assert.deepEqual(back.result, { salesLockDate: '2026-05-31', purchaseLockDate: null, taxLockDate: '2026-03-31', hardLockDate: '2026-03-31' });

  const fwd = planLockDateChange({
    current: locks({ salesLockDate: '2026-06-30' }), today: '2026-09-16',
    next: { salesLockDate: '2026-08-31', taxLockDate: '2026-06-30' },
  });
  assert.deepEqual(fwd.advancing, [{ field: 'salesLockDate', newDate: '2026-08-31' }, { field: 'taxLockDate', newDate: '2026-06-30' }]);
  // الحقل الغائب يبقى كما هو
  assert.equal(fwd.result.purchaseLockDate, null);
  assert.equal(planLockDateChange({ current, next: {}, today: '2026-09-16' }).result.salesLockDate, '2026-06-30');
});

test('لا تاريخ إقفال في المستقبل (بعد اليوم المحلي)', () => {
  throwsLedger(
    () => planLockDateChange({ current: NO_LOCKS, next: { salesLockDate: '2026-09-17' }, today: '2026-09-16' }),
    'LEDGER_PERIOD_LOCKED',
    e => assert.deepEqual(e.details, { reason: 'LOCK_DATE_IN_FUTURE', field: 'salesLockDate', date: '2026-09-17', today: '2026-09-16' }),
  );
  // اليوم نفسه مسموح
  assert.equal(planLockDateChange({ current: NO_LOCKS, next: { hardLockDate: '2026-09-16' }, today: '2026-09-16' }).advancing.length, 1);
  assert.throws(() => planLockDateChange({ current: NO_LOCKS, next: { taxLockDate: '2026-9-1' }, today: '2026-09-16' }), RangeError);
});

test('المسودات قبل الإقفال ⇒ LEDGER_DRAFTS_BEFORE_LOCK مع ids وcount وlistUrl', () => {
  const drafts = [{ id: 'd1', date: '2026-06-30' }, { id: 'd2', date: '2026-07-01' }, { id: 'd3', date: '2026-01-15' }];
  assert.deepEqual(draftsBeforeLock(drafts, '2026-06-30'), {
    ids: ['d1', 'd3'], count: 2, listUrl: '/app/ledger/entries?state=DRAFT&dateTo=2026-06-30',
  });
  assert.equal(draftsBeforeLock(drafts, '2026-01-14'), null);
  throwsLedger(() => assertNoDraftsBeforeLock(drafts, '2026-07-01'), 'LEDGER_DRAFTS_BEFORE_LOCK', e => {
    assert.equal(e.httpStatus, 422);
    assert.equal(e.details.count, 3);
  });
  assert.doesNotThrow(() => assertNoDraftsBeforeLock([], '2026-07-01'));
});

// ═══ lockSyncBlockers (§2.5) ═══

const NOW = new Date('2026-09-16T12:00:00Z');
const MIN = 60_000;

function cursor(source: string, p: Partial<SyncCursorSnapshot> = {}): SyncCursorSnapshot {
  return {
    source,
    watermarkAt: new Date(NOW.getTime() - 11 * MIN),
    lastRunAt: new Date(NOW.getTime() - 30_000),
    hasUnreadRows: false,
    ...p,
  };
}

const HEALTHY = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'].map(s => cursor(s));

function input(p: Partial<LockSyncInput> & { settings?: Partial<LockSyncInput['settings']> } = {}): LockSyncInput {
  return {
    newDate: '2026-08-31',
    now: NOW,
    cursors: HEALTHY,
    eventSummary: { events: [] },
    ...p,
    settings: { timezone: 'Asia/Riyadh', inventoryMode: 'PERIODIC', activatedAt: new Date('2026-01-01T00:00:00Z'), backfillState: 'DONE', ...p.settings },
  };
}

function ev(id: string, status: string, effectAt: string, p: Partial<SourceEventSnapshot> = {}): SourceEventSnapshot {
  return { id, sourceKey: `INVOICE:${id}:POST`, status, effectAt: new Date(effectAt), lastError: null, ...p };
}

test('بلا عوائق ⇒ null', () => {
  assert.equal(lockSyncBlockers(input()), null);
  assert.doesNotThrow(() => assertNoLockSyncBlockers(input()));
});

test('(أ) activatedAt فارغ ⇒ LEDGER_NOT_SETUP؛ backfillState ≠ DONE ⇒ محجوب', () => {
  const ns = lockSyncBlockers(input({ settings: { activatedAt: null } }));
  assert.equal(ns?.code, 'LEDGER_NOT_SETUP');
  throwsLedger(() => assertNoLockSyncBlockers(input({ settings: { activatedAt: null } })), 'LEDGER_NOT_SETUP', e => assert.equal(e.httpStatus, 409));
  for (const s of ['RUNNING', 'PAUSED', 'NONE'] as const) {
    const b = lockSyncBlockers(input({ settings: { backfillState: s } }));
    assert.ok(b, s);
    assert.equal(b.code, 'LEDGER_SYNC_PENDING');
    assert.equal(b.backfillState, s);
    assert.deepEqual([b.laggingSources, b.events, b.eventCount], [[], [], 0]);
  }
  throwsLedger(() => assertNoLockSyncBlockers(input({ settings: { backfillState: 'RUNNING' } })), 'LEDGER_SYNC_PENDING', e => {
    assert.equal(e.httpStatus, 409);
    assert.deepEqual(Object.keys(e.details).sort(), ['backfillState', 'eventCount', 'events', 'laggingSources']);
    assert.doesNotThrow(() => JSON.stringify(e.details));
  });
});

test('(ب) حدث PENDING/BLOCKED/ERROR/HELD تاريخه المحلي = التاريخ الجديد ⇒ محجوب؛ DONE/SKIPPED ⇒ مسموح', () => {
  assert.deepEqual([...LOCK_BLOCKING_EVENT_STATUSES], ['PENDING', 'BLOCKED', 'ERROR', 'HELD']);
  // 2026-08-31 12:00 بالرياض
  for (const s of LOCK_BLOCKING_EVENT_STATUSES) {
    const b = lockSyncBlockers(input({ eventSummary: { events: [ev('e1', s, '2026-08-31T09:00:00Z', { lastError: s === 'ERROR' ? 'boom' : null })] } }));
    assert.ok(b, s);
    assert.equal(b.code, 'LEDGER_SYNC_PENDING');
    assert.equal(b.eventCount, 1);
    assert.deepEqual(b.events[0], { id: 'e1', sourceKey: 'INVOICE:e1:POST', status: s, effectAt: '2026-08-31T09:00:00.000Z', lastError: s === 'ERROR' ? 'boom' : null });
  }
  for (const s of ['DONE', 'SKIPPED']) {
    assert.equal(lockSyncBlockers(input({ eventSummary: { events: [ev('e1', s, '2026-08-31T09:00:00Z')] } })), null, s);
  }
  // حدث قديم جداً محجوب أيضاً
  assert.ok(lockSyncBlockers(input({ eventSummary: { events: [ev('old', 'HELD', '2024-01-01T00:00:00Z')] } })));
});

test('(ب) حدود اليوم بتوقيت الشركة لا UTC', () => {
  // 23:59 بالرياض يوم الإقفال (20:59Z) ⇒ محجوب
  assert.ok(lockSyncBlockers(input({ eventSummary: { events: [ev('a', 'PENDING', '2026-08-31T20:59:00Z')] } })));
  // 23:59:59.999 بالرياض ⇒ محجوب
  assert.ok(lockSyncBlockers(input({ eventSummary: { events: [ev('a', 'PENDING', '2026-08-31T20:59:59.999Z')] } })));
  // 00:00 بالرياض يوم الإقفال+1 (21:00Z من يوم الإقفال بـUTC) ⇒ مسموح
  assert.equal(lockSyncBlockers(input({ eventSummary: { events: [ev('b', 'PENDING', '2026-08-31T21:00:00Z')] } })), null);
  // 01:30Z يوم الإقفال+1 بـUTC = 04:30 بالرياض يوم الإقفال+1 ⇒ مسموح
  assert.equal(lockSyncBlockers(input({ eventSummary: { events: [ev('c', 'ERROR', '2026-09-01T01:30:00Z')] } })), null);
  // بتوقيت UTC نفسه يصبح 21:00Z يوم الإقفال محجوباً
  assert.ok(lockSyncBlockers(input({ settings: { timezone: 'UTC' }, eventSummary: { events: [ev('b', 'PENDING', '2026-08-31T21:00:00Z')] } })));
  // منطقة غرب UTC: 2026-09-01T03:00Z = 2026-08-31 23:00 بنيويورك ⇒ محجوب
  assert.ok(lockSyncBlockers(input({ settings: { timezone: 'America/New_York' }, eventSummary: { events: [ev('d', 'PENDING', '2026-09-01T03:00:00Z')] } })));
  // الحد الجاهز للاستعلام
  assert.equal(lockSyncEventCutoff('2026-08-31', 'Asia/Riyadh').toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(lockSyncEventCutoff('2026-12-31', 'Asia/Riyadh').toISOString(), '2026-12-31T21:00:00.000Z');
  const w = lockSyncEventWhere('2026-08-31', 'Asia/Riyadh');
  assert.deepEqual(w.status.in, ['PENDING', 'BLOCKED', 'ERROR', 'HELD']);
  assert.equal(w.effectAt.lt.toISOString(), '2026-08-31T21:00:00.000Z');
});

test('(ب) أول 50 مرتبة بـeffectAt ثم sourceKey، وeventCount من القاعدة إن كان أكبر', () => {
  const events: SourceEventSnapshot[] = [];
  for (let i = 0; i < 70; i++) {
    const t = new Date(Date.parse('2026-08-01T00:00:00Z') + (69 - i) * MIN).toISOString();
    events.push(ev(`e${i}`, 'PENDING', t));
  }
  events.push(ev('late', 'PENDING', '2026-09-10T00:00:00Z'));
  events.push(ev('done', 'DONE', '2026-08-01T00:00:00Z'));
  const b = lockSyncBlockers(input({ eventSummary: { events } }));
  assert.ok(b);
  assert.equal(LOCK_SYNC_EVENT_LIMIT, 50);
  assert.equal(b.events.length, 50);
  assert.equal(b.eventCount, 70);
  assert.equal(b.events[0].id, 'e69');
  assert.ok(b.events.every((e, i) => i === 0 || e.effectAt >= b.events[i - 1].effectAt));
  // الاستعلام أعاد 50 فقط والعدّ الكلي 1234
  const b2 = lockSyncBlockers(input({ eventSummary: { events: events.slice(0, 50), eventCount: 1234 } }));
  assert.equal(b2?.eventCount, 1234);
  // تعادل effectAt ⇒ sourceKey
  const tie = lockSyncBlockers(input({ eventSummary: { events: [ev('z', 'PENDING', '2026-08-01T00:00:00Z', { sourceKey: 'RECEIPT:z:POST' }), ev('a', 'PENDING', '2026-08-01T00:00:00Z', { sourceKey: 'INVOICE:a:POST' })] } }));
  assert.deepEqual(tie?.events.map(e => e.id), ['a', 'z']);
});

test('(ج) المؤشرات: lastRunAt قديم، أو صفوف غير مقروءة مع watermarkAt متأخر ⇒ محجوب؛ مؤشر قديم بلا صفوف ⇒ مسموح', () => {
  assert.equal(LOCK_SYNC_HEARTBEAT_MS, 60_000);
  assert.equal(LOCK_SYNC_LATE_COMMIT_WINDOW_MS, 600_000);
  // lastRunAt أقدم من نبضتين
  const stale = lockSyncBlockers(input({ cursors: [cursor('ACCOUNT_ENTRY', { lastRunAt: new Date(NOW.getTime() - 2 * MIN - 1) }), ...HEALTHY.slice(1)] }));
  assert.ok(stale);
  assert.equal(stale.code, 'LEDGER_SYNC_PENDING');
  assert.deepEqual(stale.laggingSources.map(s => s.source), ['ACCOUNT_ENTRY']);
  assert.equal(stale.laggingSources[0].lastRunAt, new Date(NOW.getTime() - 2 * MIN - 1).toISOString());
  // نبضتان تماماً ليست أقدم
  assert.equal(lockSyncBlockers(input({ cursors: [cursor('ACCOUNT_ENTRY', { lastRunAt: new Date(NOW.getTime() - 2 * MIN) }), ...HEALTHY.slice(1)] })), null);
  // لم يعمل قط
  assert.ok(lockSyncBlockers(input({ cursors: [cursor('ACCOUNT_ENTRY', { lastRunAt: null }), ...HEALTHY.slice(1)] })));
  // صفوف غير مقروءة و watermarkAt متأخر أكثر من 10 دقائق + نبضتين
  const lag = cursor('REP_SETTLEMENT', { hasUnreadRows: true, watermarkAt: new Date(NOW.getTime() - 12 * MIN - 1) });
  const b = lockSyncBlockers(input({ cursors: [HEALTHY[0], lag, HEALTHY[2]] }));
  assert.ok(b);
  assert.deepEqual(b.laggingSources, [{ source: 'REP_SETTLEMENT', watermarkAt: lag.watermarkAt!.toISOString(), lastRunAt: lag.lastRunAt!.toISOString() }]);
  // صفوف غير مقروءة لكن ضمن الهامش ⇒ مسموح
  assert.equal(lockSyncBlockers(input({ cursors: [HEALTHY[0], cursor('REP_SETTLEMENT', { hasUnreadRows: true, watermarkAt: new Date(NOW.getTime() - 12 * MIN) }), HEALTHY[2]] })), null);
  // مؤشر شركة هادئة: watermarkAt قديم جداً بلا صفوف غير مقروءة ⇒ مسموح
  assert.equal(lockSyncBlockers(input({ cursors: HEALTHY.map(c => ({ ...c, watermarkAt: new Date('2025-01-01T00:00:00Z') })) })), null);
  // مؤشر نشط غائب ⇒ متأخر
  const missing = lockSyncBlockers(input({ cursors: HEALTHY.slice(0, 2) }));
  assert.deepEqual(missing?.laggingSources, [{ source: 'SETTLEMENT_ENTRY', watermarkAt: null, lastRunAt: null }]);
  assert.equal(isCursorLagging(undefined, NOW), true);
});

test('(ج) المؤشرات النشطة: مصادر المخزون في الجرد المستمر وحده', () => {
  assert.deepEqual(activeSyncSources('PERIODIC'), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
  assert.deepEqual(activeSyncSources('PERPETUAL'), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'WAREHOUSE_ENTRY', 'VAN_LOAD', 'RETURN_RESTOCK']);
  const deadVan = cursor('VAN_LOAD', { lastRunAt: new Date('2026-01-01T00:00:00Z') });
  // الجرد الدوري: مؤشر VAN_LOAD متوقف لا يحجب
  assert.equal(lockSyncBlockers(input({ cursors: [...HEALTHY, deadVan] })), null);
  // الجرد المستمر: يحجب، والمؤشرات الغائبة تُعدّ متأخرة
  const b = lockSyncBlockers(input({ settings: { inventoryMode: 'PERPETUAL' }, cursors: [...HEALTHY, deadVan, cursor('WAREHOUSE_ENTRY'), cursor('RETURN_RESTOCK')] }));
  assert.deepEqual(b?.laggingSources.map(s => s.source), ['VAN_LOAD']);
});

test('العوائق تُجمع كلها في استجابة واحدة', () => {
  const b = lockSyncBlockers(input({
    settings: { backfillState: 'PAUSED' },
    cursors: [cursor('ACCOUNT_ENTRY', { lastRunAt: null }), ...HEALTHY.slice(1)],
    eventSummary: { events: [ev('x', 'BLOCKED', '2026-08-15T10:00:00Z')] },
  }));
  assert.ok(b);
  assert.equal(b.backfillState, 'PAUSED');
  assert.equal(b.laggingSources.length, 1);
  assert.equal(b.eventCount, 1);
  assert.throws(() => lockSyncBlockers(input({ newDate: '2026-02-30' })), RangeError);
});

test('تقدّم تاريخين في طلب واحد: كلٌّ يُفحص بتاريخه', () => {
  const plan = planLockDateChange({ current: NO_LOCKS, next: { salesLockDate: '2026-06-30', hardLockDate: '2026-03-31' }, today: '2026-09-16' });
  const events = [ev('m', 'PENDING', '2026-05-10T08:00:00Z')];
  const results = plan.advancing.map(a => [a.field, lockSyncBlockers(input({ newDate: a.newDate, eventSummary: { events } })) != null]);
  assert.deepEqual(results, [['salesLockDate', true], ['hardLockDate', false]]);
});

test('locks.ts صرف: لا prisma ولا I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/gl/locks.ts'), 'utf8');
  assert.doesNotMatch(src, /from ['"][^'"]*prisma[^'"]*['"]|@prisma\/client|from ['"](node:)?fs['"]|process\.env/);
});
