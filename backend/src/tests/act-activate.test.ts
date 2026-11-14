// «ربط الدفاتر» — زرّ الاعتماد (L7 مبسّطة) وتحويل الدفاتر اليدوية (L9 مبسّطة): services/gl/linking/activate.ts بلا قاعدة.
//   ١) صرفة: تاريخ الربط = بداية السنة المالية، مطابقة اسم الشركة حرفياً، الإقفال «حتى تاريخه شاملاً»، نافذة القيود اليدوية.
//   ٢) شروط المنع على قاعدة مزيّفة بالترتيب: الاسم (422) ⇒ العملة (409) ⇒ الإقفال (409) ⇒ القيود اليدوية للتحويل وحده (409
//      LINKING_MANUAL_MOVES برسالة عربية بعددها) — والتفعيل الجديد لا يقرأ gl_moves أصلاً.
//   ٣) المثال المحلول بالأرقام (L9): افتتاح يدوي قديم 70,000.00 يُعكس بتاريخه سطراً بسطر (صافي كل حساب صفر بالملّي)، ثم افتتاح مشتقّ
//      جديد بتاريخ linkedFrom − 1 متوازن بالملّي و319002 = −Σ المشتقّ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINKING_AUDIT_ENABLE, LINKING_AUDIT_RESTATE, LINKING_CONVERSION_AVAILABLE, LINKING_CONVERSION_UNAVAILABLE_CODE, LINKING_CONVERSION_UNAVAILABLE_MESSAGE,
  LINKING_RESTATE_REASON, buildLinkedOpening, companyNameMatches, countManualMoves, earliestDate,
  linkedManualOptions, linkingCommitHooks, linkingFromDate, linkingManualMovesMessage, linkingPreconditions, lockIssues, manualMovesFrom, restateOpenings,
  type ActivateDb, type PreconditionsInput, type RestateDeps,
} from '../services/gl/linking/activate';
import { LINKED_DEFAULT_RECEIPT_ROUTING } from '../services/gl/linking/types';
import { buildOpeningMove, openingCutoff, openingSnapshotFromDbNow, type DerivedOpening } from '../services/gl/opening';
import { accountIdOf, saContext } from '../services/gl/testing/fixtures';
import { isAuditAction } from '../services/gl/audit';
import type { MoveDraft } from '../services/gl/types';
import type { LedgerContext } from '../services/gl/resolve';
import type { PostMoveOptions, PostedMove } from '../services/gl/post';

// ═══ ١) صرفة ═══

test('تاريخ الربط = بداية السنة المالية لليوم المحلي (FY_RESTATED)', () => {
  assert.equal(linkingFromDate('2026-11-14', 12, 31), '2026-01-01');
  assert.equal(linkingFromDate('2026-01-01', 12, 31), '2026-01-01', 'أول يوم في السنة');
  assert.equal(linkingFromDate('2026-11-14', 6, 30), '2026-07-01');
  assert.equal(linkingFromDate('2026-11-14', 10, 31), '2026-11-01');
  assert.equal(linkingFromDate('2026-10-31', 10, 31), '2025-11-01', 'آخر يوم في السنة');
});

test('اسم الشركة حرفياً: قصّ الطرفين وحده — لا تجاهل لحالة الأحرف ولا للتشكيل، والفارغ لا يطابق', () => {
  assert.equal(companyNameMatches('شركة النور', 'شركة النور'), true);
  assert.equal(companyNameMatches(' شركة النور ', '  شركة النور'), true);
  assert.equal(companyNameMatches('شركة النور', 'شركة  النور'), false);
  assert.equal(companyNameMatches('شركة النور', 'شركه النور'), false);
  assert.equal(companyNameMatches('Acme Co', 'acme co'), false);
  assert.equal(companyNameMatches('', ''), false);
  assert.equal(companyNameMatches(null, 'x'), false);
  assert.equal(companyNameMatches('x', undefined), false);
});

test('الإقفال «حتى تاريخه شاملاً»: إقفال يوم القيد الافتتاحي يمنع، وما قبله لا', () => {
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
  assert.deepEqual(lockIssues({ hardLockDate: day('2025-12-30') }, '2025-12-31'), []);
  const issues = lockIssues({ salesLockDate: day('2025-12-31'), taxLockDate: day('2026-03-31'), purchaseLockDate: null }, '2025-12-31');
  assert.deepEqual(issues.map((i) => [i.field, i.date]), [['salesLockDate', '2025-12-31'], ['taxLockDate', '2026-03-31']]);
  assert.match(issues[0].label, /إقفال المبيعات 2025-12-31/);
  assert.deepEqual(lockIssues(null, '2025-12-31'), []);
});

test('نافذة القيود اليدوية: linkedFrom، أو اليوم التالي لافتتاحٍ يدويٍّ سبقه', () => {
  assert.equal(manualMovesFrom('2026-01-01', ['2026-09-30']), '2026-01-01');
  assert.equal(manualMovesFrom('2026-11-01', ['2026-10-04']), '2026-10-05');
  assert.equal(manualMovesFrom('2026-01-01', []), '2026-01-01');
  assert.equal(earliestDate('2025-12-31', ['2026-09-30', '2025-06-30']), '2025-06-30');
  assert.equal(linkingManualMovesMessage(3, '2026-01-01').includes('3 قيداً يدوياً مؤرّخاً منذ 2026-01-01'), true);
});

test('الخطّافات: الأساس FY_RESTATED وتوجيه المعاينة الافتراضي، وإجراء تدقيق معروف لـappendAudit', () => {
  const h = linkingCommitHooks('شركة');
  assert.equal(h.basis, 'FY_RESTATED');
  assert.equal(h.typedCompanyName, 'شركة');
  assert.deepEqual(h.defaultReceiptRouting, LINKED_DEFAULT_RECEIPT_ROUTING);
  // LINKING_ENABLE/LINKING_RESTATE متى عرفهما audit.ts، وإلا الأقرب القائم — appendAudit لا يرمي أبداً
  assert.equal(isAuditAction(LINKING_AUDIT_ENABLE), true);
  assert.equal(isAuditAction(LINKING_AUDIT_RESTATE), true);
  assert.equal(h.auditAction, LINKING_AUDIT_ENABLE);
});

// ═══ ٢) شروط المنع على قاعدة مزيّفة ═══

interface FakeOpts { name?: string | null; currencies?: { currency: string | null; n: number }[]; openings?: { id: string; number: string; date: Date }[]; manualCount?: number }

function fakeDb(o: FakeOpts) {
  const calls: string[] = [];
  const args: Record<string, unknown> = {};
  const db = {
    companySettings: { findUnique: async (a: unknown) => { calls.push('companySettings.findUnique'); args.cs = a; return o.name === undefined ? null : { name: o.name }; } },
    invoice: { groupBy: async (a: unknown) => { calls.push('invoice.groupBy'); args.inv = a; return (o.currencies ?? []).map((c) => ({ currency: c.currency, _count: { _all: c.n } })); } },
    glMove: {
      findMany: async (a: unknown) => { calls.push('glMove.findMany'); args.findMany = a; return o.openings ?? []; },
      count: async (a: unknown) => { calls.push('glMove.count'); args.count = a; return o.manualCount ?? 0; },
    },
  };
  return { db: db as unknown as ActivateDb, calls, args };
}

const BASE: PreconditionsInput = {
  tenantId: 't1', linkedFrom: '2026-01-01', converting: false, settingsRow: null,
  glCurrency: 'SAR', companyCurrency: 'SAR', typedCompanyName: 'شركة النور',
};

test('الاسم المخالف ⇒ 422 LINKING_NAME_MISMATCH قبل أي قراءة أخرى', async () => {
  const f = fakeDb({ name: 'شركة النور للتجارة' });
  const r = await linkingPreconditions(f.db, BASE);
  assert.ok('block' in r);
  assert.equal(r.block.status, 422);
  assert.equal(r.block.code, 'LINKING_NAME_MISMATCH');
  assert.deepEqual(f.calls, ['companySettings.findUnique']);
  // لا صفّ إعدادات للشركة ⇒ لا اسم ⇒ لا مطابقة
  const g = fakeDb({});
  const r2 = await linkingPreconditions(g.db, BASE);
  assert.ok('block' in r2 && r2.block.code === 'LINKING_NAME_MISMATCH');
});

test('العملة ثابتة: فاتورة بعملة أخرى أو عملة شركة تخالف الدفاتر ⇒ 409 LINKING_CURRENCY', async () => {
  const f = fakeDb({ name: 'شركة النور', currencies: [{ currency: 'SAR', n: 40 }, { currency: 'USD', n: 2 }] });
  const r = await linkingPreconditions(f.db, BASE);
  assert.ok('block' in r);
  assert.equal(r.block.status, 409);
  assert.equal(r.block.code, 'LINKING_CURRENCY');
  assert.match(r.block.message, /2 فاتورة بعملة غير عملة الدفاتر/);
  const g = fakeDb({ name: 'شركة النور', currencies: [{ currency: 'SAR', n: 40 }] });
  const r2 = await linkingPreconditions(g.db, { ...BASE, companyCurrency: 'USD' });
  assert.ok('block' in r2 && r2.block.code === 'LINKING_CURRENCY');
  // التفعيل الجديد لا يقرأ gl_moves
  assert.equal(f.calls.includes('glMove.findMany') || f.calls.includes('glMove.count'), false);
});

test('الإقفال قبل linkedFrom: إقفال يوم القيد الافتتاحي (آخر السنة السابقة) ⇒ 409 LINKING_LOCKED، وما قبله يمرّ', async () => {
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
  const f = fakeDb({ name: 'شركة النور', currencies: [{ currency: 'SAR', n: 1 }] });
  const r = await linkingPreconditions(f.db, { ...BASE, settingsRow: { hardLockDate: day('2025-12-31') } });
  assert.ok('block' in r);
  assert.equal(r.block.code, 'LINKING_LOCKED');
  assert.equal(r.block.status, 409);
  assert.equal((r.block.details as { from: string }).from, '2025-12-31');
  const ok = await linkingPreconditions(fakeDb({ name: 'شركة النور' }).db, { ...BASE, settingsRow: { hardLockDate: day('2025-12-30') } });
  assert.ok('plan' in ok);
  assert.deepEqual(ok.plan, { linkedFrom: '2026-01-01', converting: false, openings: [] });
});

test('التحويل (L9) موقوف: الدفاتر اليدوية المفعّلة ⇒ 409 LINKING_CONVERSION_UNAVAILABLE قبل أي قراءة — لا تغيير على الدفاتر', async () => {
  assert.equal(LINKING_CONVERSION_AVAILABLE, false);
  const openings = [{ id: 'm-open', number: 'OPEN/2026/0001', date: new Date('2026-09-30T00:00:00.000Z') }];
  for (const o of [{ manualCount: 7 }, { manualCount: 0 }]) {
    const f = fakeDb({ name: 'شركة النور', openings, ...o });
    const r = await linkingPreconditions(f.db, { ...BASE, converting: true });
    assert.ok('block' in r);
    assert.equal(r.block.status, 409);
    assert.equal(r.block.code, LINKING_CONVERSION_UNAVAILABLE_CODE);
    assert.equal(r.block.message, LINKING_CONVERSION_UNAVAILABLE_MESSAGE);
    assert.equal(r.block.message, 'تحويل الدفاتر اليدوية القائمة إلى مربوطة يُتاح قريباً مع إدخال أرصدة بداية السنة — لا تغيير على دفاترك');
    assert.deepEqual(r.block.details, { reason: 'CONVERSION_UNAVAILABLE' });
    assert.deepEqual(f.calls, [], 'لا قراءة قبل الرفض');
  }
  // أدوات التحويل باقية بلا وصول (تُفعَّل مع أرصدة بداية السنة)
  const g = fakeDb({ name: 'شركة النور', openings, manualCount: 7 });
  assert.equal(await countManualMoves(g.db, 't1', '2026-01-01'), 7);
  assert.deepEqual(g.args.count, { where: { tenantId: 't1', moveType: { not: 'OPENING' }, date: { gte: new Date('2026-01-01T00:00:00.000Z') } } });
  assert.equal(manualMovesFrom('2026-11-01', ['2026-10-04']), '2026-10-05');
});

// ═══ ٣) المثال المحلول بالأرقام: عكس الافتتاح القديم ثم الافتتاح المشتقّ ═══

const sum = (lines: readonly { debitMilli: bigint; creditMilli: bigint }[], k: 'debitMilli' | 'creditMilli') => lines.reduce((s, l) => s + l[k], 0n);

function oldOpeningRecord(over: Partial<{ state: string; reversal: { id: string } | null }> = {}) {
  const line = (accountCode: string, debitMilli: bigint, creditMilli: bigint, customerId: string | null = null) => ({
    accountId: accountIdOf(accountCode), label: `رصيد ${accountCode}`, debitMilli, creditMilli, customerId, vendorId: null, salesRepId: null,
    partnerName: null, analyticAccountId: null, productId: null, quantity: null, taxId: null, taxRole: null, taxBaseMilli: null, vatBox: null,
    vatAdjustment: false, dueDate: null,
  });
  return {
    id: 'm-open', number: 'OPEN/2026/0001', state: over.state ?? 'POSTED', reversal: over.reversal ?? null,
    moveType: 'OPENING', origin: 'AUTO', date: new Date('2026-09-30T00:00:00.000Z'), originalDate: null, lateArrival: false, ref: null,
    narration: 'القيد الافتتاحي', needsAttention: false, attentionReason: null, customerId: null, vendorId: null, salesRepId: null,
    sourceType: null, sourceId: null, currencyCode: 'SAR', currencyDecimals: 2,
    journal: { code: 'OPEN', systemKey: 'OPENING' },
    lines: [
      line('111101', 50_000_000n, 0n),
      line('113001', 20_000_000n, 0n, 'c1'),
      line('319002', 0n, 70_000_000n),
    ],
  };
}

test('L9 بالأرقام: الافتتاح اليدوي القديم 70,000.00 يُعكس بتاريخه (2026-09-30) سطراً بسطر — صافي كل حساب صفر بالملّي', async () => {
  const posts: { draft: MoveDraft; opts: PostMoveOptions }[] = [];
  const deps: RestateDeps = {
    requireMoveRecord: async () => oldOpeningRecord() as never,
    postMove: (async (_tx: unknown, draft: MoveDraft, opts: PostMoveOptions): Promise<PostedMove> => {
      posts.push({ draft, opts });
      return { id: 'm-rev', number: 'OPEN/2026/0002', date: draft.date } as PostedMove;
    }) as RestateDeps['postMove'],
  };
  const out = await restateOpenings({} as never, {
    tenantId: 't1', actor: { actorType: 'USER', actorId: 'owner' } as never, context: {} as LedgerContext, now: new Date('2026-11-14T08:00:00Z'),
    openings: [{ id: 'm-open', number: 'OPEN/2026/0001', date: '2026-09-30' }],
  }, deps);
  assert.deepEqual(out, [{ originalId: 'm-open', originalNumber: 'OPEN/2026/0001', reversalId: 'm-rev', reversalNumber: 'OPEN/2026/0002', date: '2026-09-30' }]);
  assert.equal(posts.length, 1);
  const { draft, opts } = posts[0];
  assert.equal(draft.date, '2026-09-30', 'بتاريخ الأصل لا اليوم');
  assert.equal(draft.moveType, 'OPENING', 'النوع نفسه: مجاميع «الافتتاح» في الفحوص = الافتتاح الجديد وحده');
  assert.equal(opts.reversedMoveId, 'm-open');
  assert.equal(opts.reversalReason, LINKING_RESTATE_REASON);
  assert.equal(opts.validationMode, 'SYSTEM');
  assert.equal(opts.lockPolicy, 'REJECT');
  assert.equal(opts.auditAction, LINKING_AUDIT_RESTATE);
  // سطراً بسطر بالجانب المقلوب، ومتوازن بالملّي
  assert.deepEqual(draft.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli, l.customerId ?? null]), [
    [accountIdOf('111101'), 0n, 50_000_000n, null],
    [accountIdOf('113001'), 0n, 20_000_000n, 'c1'],
    [accountIdOf('319002'), 70_000_000n, 0n, null],
  ]);
  assert.equal(sum(draft.lines, 'debitMilli'), sum(draft.lines, 'creditMilli'));
  const net = new Map<string, bigint>();
  for (const l of [...oldOpeningRecord().lines, ...draft.lines]) net.set(l.accountId, (net.get(l.accountId) ?? 0n) + l.debitMilli - l.creditMilli);
  for (const [acc, v] of net) assert.equal(v, 0n, `صافي ${acc}`);

  // افتتاح معكوس سلفاً أو غير مرحّل ⇒ لا قيد (لا عكس مزدوج)
  for (const rec of [oldOpeningRecord({ reversal: { id: 'x' } }), oldOpeningRecord({ state: 'DRAFT' })]) {
    posts.length = 0;
    const skipped = await restateOpenings({} as never, {
      tenantId: 't1', actor: {} as never, context: {} as LedgerContext, now: new Date(), openings: [{ id: 'm-open', number: null, date: '2026-09-30' }],
    }, { ...deps, requireMoveRecord: async () => rec as never });
    assert.deepEqual(skipped, []);
    assert.equal(posts.length, 0);
  }
});

test('L9 بالأرقام: الافتتاح المشتقّ الجديد بتاريخ 2025-12-31 — ذمم 12,345.67 + عهدة 1,500.50 + أمانات 379.50 ⇒ 319002 دائن 14,225.67، متوازن بالملّي', () => {
  const linkedFrom = '2026-01-01';
  const cut = openingCutoff(linkedFrom, 'Asia/Riyadh', openingSnapshotFromDbNow(new Date('2026-11-14T08:00:00.000Z')));
  const opening: DerivedOpening = {
    cutoff: cut,
    receivables: [{ customerId: 'c1', customerName: 'مؤسسة النور', balanceMilli: 12_345_670n, rows: 3 }],
    receivablesTotalMilli: 12_345_670n,
    custody: [{
      salesRepId: 'r1', salesRepName: 'حسام', ledgerCustodyMilli: 1_500_500n, onlineUnclearedMilli: 0n, nonCustodyClearedMilli: 0n,
      suspenseClearedMilli: 0n, cashSalesOutsideCustodyMilli: 0n, opsOutstandingMilli: 1_500_500n,
    }],
    custodyTotalMilli: 1_500_500n,
    paylinkHeldMilli: 379_500n,
    warehouse: { valueMilli: 0n, uncostedQty: 0, uncostedProducts: 0 },
    settlementSplits: {},
    counts: { accountEntriesIncluded: 3, accountEntriesExcluded: 0, settlementsIncluded: 0, settlementEntriesIncluded: 0, warehouseMovesIncluded: 0 },
  };
  // الخطّاف نفسه الذي يستدعيه الاعتماد (بلا مخزون) = buildOpeningMove بالسطور المشتقّة
  const res = buildLinkedOpening({ openingDate: cut.openingDate, manual: [], ctx: saContext(), salesRepNames: {} }, opening);
  assert.deepEqual(res, buildOpeningMove({ openingDate: cut.openingDate, manual: [], ctx: saContext(), salesRepNames: {}, derived: { opening, inventory: null } }));
  assert.deepEqual(linkedManualOptions(false), { midVatPeriod: false, derivedAccounts: true, derivedInventory: false, derivedPayables: false });
  // «ربط الدفاتر» L7: الجرد المستمر ⇒ المخزون والدائنون و211002 مشتقّة (مرفوضة يدوياً)
  assert.deepEqual(linkedManualOptions(true, 'PERPETUAL'), { midVatPeriod: true, derivedAccounts: true, derivedInventory: true, derivedPayables: true });
  assert.equal(cut.openingDate, '2025-12-31');
  const draft = res.draft!;
  assert.equal(draft.date, '2025-12-31');
  assert.equal(res.derivedLineCount, 3, 'بلا مخزون (جرد دوري حتى L6)');
  assert.equal(sum(draft.lines, 'debitMilli'), 14_225_670n);
  assert.equal(sum(draft.lines, 'creditMilli'), 14_225_670n);
  const eq = draft.lines[draft.lines.length - 1];
  assert.equal(eq.creditMilli, 14_225_670n);
  assert.equal(eq.debitMilli, 0n);

  // «ربط الدفاتر» L7 — الجرد المستمر: مخزون المستودع 5,000 + سيارة حسام 750 مدين، ومورّد له 2,000 دائن 211001 بمورّده، و211002 دائن 300
  const perp = buildLinkedOpening({ openingDate: cut.openingDate, manual: [], ctx: saContext(), salesRepNames: {} }, opening, {
    inventory: [
      { location: 'WH', qty: 10, valueMilli: 5_000_000n },
      { location: 'VAN:r1', qty: 2, valueMilli: 750_000n },
    ] as never,
    salesRepNames: { r1: 'حسام' },
    payables: { vendors: [{ vendorId: 'v1', vendorName: 'مصنع الخليج', balanceMilli: 2_000_000n }], grniMilli: 300_000n },
  });
  const pd = perp.draft!;
  assert.equal(perp.derivedLineCount, 7);
  const ap = pd.lines.find((l) => l.accountKey === 'AP_CONTROL')!;
  assert.deepEqual([ap.vendorId, ap.partnerName, ap.creditMilli, ap.debitMilli], ['v1', 'مصنع الخليج', 2_000_000n, 0n]);
  const grni = pd.lines.find((l) => l.accountKey === 'GRNI')!;
  assert.equal(grni.creditMilli, 300_000n);
  assert.equal(pd.lines.find((l) => l.accountKey === 'INVENTORY_VAN')!.salesRepId, 'r1');
  assert.equal(sum(pd.lines, 'debitMilli'), sum(pd.lines, 'creditMilli'));
  // 319002 = −(14,225.67 + 5,750 − 2,000 − 300)
  assert.equal(pd.lines[pd.lines.length - 1].creditMilli, 17_675_670n);
});
