// «ربط الدفاتر» L2 (P1) — الظلّ: اللقطة للقراءة فقط، والعميل الحارس، وسجلّ التراجع، والمُطابِق والمُرحِّل الحقيقيان فوق
// الظلّ على قاعدة مزيّفة (فواتير آجلة ونقدية ومرتجع، إلغاء فاتورة ما قبل السنة داخلها، وصول متأخر، مؤرّخ مستقبلاً قبل T0،
// سند نقدي وإلكتروني باسترداد، استلام مندوب، عمولة وتوريد، استيراد بعد البدء)، والتجميع، والسياق الافتراضي، والبصمتان.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { localDate, compareLocalDate, zonedStartOfDay } from '../services/gl/dates';
import { toMilli } from '../services/gl/money';
import { scanFutureDatedRows } from '../services/gl/backfill';
import { initialWatermarkAt } from '../services/gl/sync/classify';
import { RECONCILED_SOURCES, deriveAccountEntryEvents } from '../services/gl/sync/desired';
import { partnerRows } from '../services/gl/linking/parity';
import { reconcileTenant } from '../services/gl/sync/reconciler';
import { createSyncBudget, runPoster } from '../services/gl/sync/poster';
import { IMPORT_AFTER_CUTOVER_ATTENTION_REASON } from '../services/gl/sync/types';
import { SYSTEM_ACTOR } from '../services/gl/audit';
import { accountIdOf, taxIdOf } from '../services/gl/testing/fixtures';
import type { MoveDraft } from '../services/gl/types';
import { settingsSnapshotFromRow } from '../services/gl/resolve';
import { ReadOnlySnapshotError, withReadOnlySnapshot } from '../services/gl/linking/snapshot';
import { GL_DELEGATE_RE, GL_RELATION_FIELD_NAMES, ShadowGlAccessError, createShadowClient, glRelationPath } from '../services/gl/linking/shadowClient';
import {
  ShadowPostingStore, ShadowReconcilerStore, ShadowState, ShadowTooLargeError, createPreviewShadow, shadowBalanceView,
} from '../services/gl/linking/shadowStore';
import { ledgerContextFromInput, virtualContextInput, virtualLedgerContext, virtualSettingsRow } from '../services/gl/linking/virtualContext';
import {
  PREVIEW_HEADROOM_BYTES, etaAndStorage, eventCounts, heldByPartner, heldLines, openingPreview, pnlYtd, balanceSheetToday,
  trialBalanceByMonth, vatByPeriodBox, vatPeriodOf,
} from '../services/gl/linking/aggregate';
import {
  PRE_CUTOVER_PAGE, canonicalJson, computeDataHash, computeResultHash, loadPreCutoverSourceStats, type DataHashInput,
} from '../services/gl/linking/dataHash';
import { BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN, ROW_BYTES_ESTIMATE, type LinkingSettingsRow, type PreviewResult } from '../services/gl/linking/types';
import {
  FIX_DB_NOW, FIX_LINKED_FROM, FIX_TZ, FakeDb, TenantFixture, buildLinkingScenario, previewOptionsFor, type LinkingScenario,
} from './linking-fake-db';
import type { Prisma } from '@prisma/client';

const TID = 't1';
const at = (iso: string) => new Date(iso);
const T0 = new Date(FIX_DB_NOW.getTime() - 10 * 60_000);
const CUTOVER_START = zonedStartOfDay(FIX_LINKED_FROM, FIX_TZ);

function fakeDb(): FakeDb {
  return new FakeDb({ now: () => FIX_DB_NOW });
}

/** يشغّل fn داخل لقطة القراءة على القاعدة المزيّفة */
function inSnapshot<T>(db: FakeDb, fn: (tx: Prisma.TransactionClient, dbNow: Date) => Promise<T>): Promise<T> {
  return withReadOnlySnapshot(db.client as never, fn);
}

// ═══ اللقطة ═══

test('withReadOnlySnapshot: SET TRANSACTION … READ ONLY أول عبارة، ثم التحقق، ثم SELECT now()، ثم تصدير اللقطة، والمهلتان', async () => {
  const db = fakeDb();
  let seen: Date | null = null;
  await inSnapshot(db, async (_tx, now) => { seen = now; });
  assert.deepEqual(seen, FIX_DB_NOW);
  assert.match(db.stats.raw[0], /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
  assert.match(db.stats.raw[1], /^SHOW transaction_read_only$/);
  assert.match(db.stats.raw[2], /^SELECT now\(\)/);
  assert.match(db.stats.raw[3], /^SELECT pg_export_snapshot\(\)/);
  // بلا قراءات ⇒ لا معاملة دوّارة: المُصدِّرة وحدها
  assert.deepEqual(db.stats.transactions, [{ timeout: 14 * 60_000, maxWait: 10_000 }]);
  assert.equal(db.writeCount(), 0);
  await inSnapshot(db, async () => undefined).then(() => undefined);
  await withReadOnlySnapshot(db.client as never, async () => undefined, { timeoutMs: 1234 });
  assert.equal(db.stats.transactions[2].timeout, 1234);
});

/** يلفّ $transaction الفايك ليحصي المعاملات المفتوحة الآن (المُصدِّرة والدوّارة) */
function openTxTracker(fake: FakeDb) {
  const open = new Set<number>();
  let seq = 0;
  const base = fake.client as unknown as Record<string, unknown> & { $transaction: (fn: unknown, o?: unknown) => Promise<unknown> };
  const db = new Proxy(base, {
    get(t, p: string) {
      if (p !== '$transaction') return t[p];
      return async (fn: unknown, o?: unknown) => {
        const id = ++seq;
        open.add(id);
        try { return await t.$transaction(fn, o); } finally { open.delete(id); }
      };
    },
  });
  return { db: db as never, open };
}

test('withReadOnlySnapshot: القراءات على معاملات دوّارة قصيرة تستورد اللقطة المُصدَّرة — لا قفل جدول يُمسك طوال التشغيل (DDL يمرّ بينها)', async () => {
  const fake = fakeDb();
  seedBasics(fake).customer('أحمد');
  const { db, open } = openTxTracker(fake);
  let t = 0;
  const reads: number[] = [];
  await withReadOnlySnapshot(db, async (tx) => {
    // قراءتان داخل عمر المعاملة الدوّارة ⇒ معاملة واحدة
    reads.push(await tx.customer.count({ where: { tenantId: TID } }));
    reads.push(await tx.customer.count({ where: { tenantId: TID } }));
    assert.equal(fake.stats.snapshotImports, 1);
    assert.equal(open.size, 2, 'المُصدِّرة + دوّارة واحدة');
    // انقضى عمرها ⇒ تُغلق ويُفتح غيرها على اللقطة نفسها (أقفالها تتحرّر بين المعاملتين)
    t += 10;
    reads.push(await tx.customer.count({ where: { tenantId: TID } }));
    assert.equal(fake.stats.snapshotImports, 2);
    assert.equal(open.size, 2);
    // SQL خام كذلك
    const now = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
    assert.deepEqual(now[0].now, FIX_DB_NOW);
    // استدعاءات متزامنة تتشارك المعاملة الدوّارة نفسها
    await Promise.all([1, 2, 3].map(() => tx.customer.findMany({ where: { tenantId: TID }, select: { id: true } })));
    assert.equal(fake.stats.snapshotImports, 2);
  }, { leaseMs: 5, clock: () => t });
  assert.deepEqual(reads, [1, 1, 1]);
  assert.equal(open.size, 0, 'كل المعاملات أُغلقت');
  // كل معاملة دوّارة: SET TRANSACTION … READ ONLY ثم SET TRANSACTION SNAPSHOT بالمعرّف المُصدَّر ثم التحقق
  const exported = fake.stats.raw.filter((x) => /^SELECT pg_export_snapshot/.test(x)).length;
  assert.equal(exported, 1);
  const imports = fake.stats.raw.filter((x) => /^SET TRANSACTION SNAPSHOT '00000003-0000001B-\d+'$/.test(x));
  assert.equal(imports.length, 2);
  for (let i = 0; i < fake.stats.raw.length; i++) {
    if (!/^SET TRANSACTION SNAPSHOT/.test(fake.stats.raw[i])) continue;
    assert.match(fake.stats.raw[i - 1], /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
    assert.match(fake.stats.raw[i + 1], /^SHOW transaction_read_only$/);
  }
  assert.equal(fake.writeCount(), 0);
});

test('withReadOnlySnapshot: المعاملة الدوّارة الخاملة تُغلق عند نهاية عمرها ولو لم تأتِ قراءة — الأطوار الحسابية الطويلة لا تمسك أقفالاً', async () => {
  const fake = fakeDb();
  seedBasics(fake).customer('أحمد');
  const { db, open } = openTxTracker(fake);
  await withReadOnlySnapshot(db, async (tx) => {
    await tx.customer.count({ where: { tenantId: TID } });
    assert.equal(open.size, 2);
    // «طور حسابي» بلا قراءات أطول من عمر المعاملة الدوّارة
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(open.size, 1, 'المُصدِّرة وحدها (لا تقرأ جدولاً فلا تمسك قفل جدول)');
    await tx.customer.count({ where: { tenantId: TID } });
    assert.equal(fake.stats.snapshotImports, 2);
  }, { leaseMs: 15 });
  assert.equal(open.size, 0);
});

test('withReadOnlySnapshot: تجاوز المهلة الكلية ⇒ P2028 (TIMEOUT) من أول قراءة بعدها، ومعرّف لقطة غير صالح ⇒ رفض قبل fn', async () => {
  const fake = fakeDb();
  let t = 0;
  await assert.rejects(withReadOnlySnapshot(fake.client as never, async (tx) => {
    await tx.customer.count({ where: { tenantId: TID } });
    t = 1_001;
    await tx.customer.count({ where: { tenantId: TID } });
  }, { timeoutMs: 1_000, clock: () => t }), (e: unknown) => (e as { code?: string }).code === 'P2028');
  let called = false;
  const badTx = {
    $executeRaw: async () => 0,
    $queryRaw: async (s: TemplateStringsArray) => {
      const q = s.join('');
      if (q.includes('SHOW')) return [{ transaction_read_only: 'on' }];
      if (q.includes('pg_export_snapshot')) return [{ snapshot: "x'; DROP TABLE invoices; --" }];
      return [{ now: new Date() }];
    },
  };
  await assert.rejects(
    withReadOnlySnapshot({ $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(badTx) } as never, async () => { called = true; }),
    /معرّف لقطة غير صالح/,
  );
  assert.equal(called, false);
});

test('withReadOnlySnapshot: معاملة لم تصِر للقراءة فقط ⇒ ReadOnlySnapshotError ولا تُستدعى fn؛ والكتابة داخل اللقطة تفشل بالقاعدة', async () => {
  let called = false;
  const fakeTx = {
    $executeRaw: async () => 0,
    $queryRaw: async (s: TemplateStringsArray) => (s.join('').includes('SHOW') ? [{ transaction_read_only: 'off' }] : [{ now: new Date() }]),
  };
  const db = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(fakeTx) };
  await assert.rejects(withReadOnlySnapshot(db as never, async () => { called = true; }), ReadOnlySnapshotError);
  assert.equal(called, false);

  const fake = fakeDb();
  await assert.rejects(inSnapshot(fake, async (tx) => { await tx.invoice.create({ data: {} as never }); }), /read-only/);
  assert.deepEqual(fake.stats.writes, ['invoice.create']);
});

// ═══ العميل الحارس ═══

function seedBasics(db: FakeDb) {
  const f = new TenantFixture(db);
  f.tenant({ accountingSuiteEnabled: true, warehouseEnabled: true });
  f.company();
  return f;
}

test('العميل الحارس: التشغيلي يمرّ، وgl* بالقائمة المغلقة من الظلّ، وغيرها يرمي SHADOW_GL_ACCESS ويُسجَّل', async () => {
  const db = fakeDb();
  const f = seedBasics(db);
  const c = f.customer('أحمد');
  const r = f.rep('سالم');
  await inSnapshot(db, async (tx) => {
    const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
    const client = createShadowClient(tx, shadow);
    // التشغيلي كما هو
    const cs = await client.customer.findMany({ where: { tenantId: TID }, select: { id: true, name: true } });
    assert.deepEqual(cs, [{ id: c, name: 'أحمد' }]);
    // glSettings ⇐ الصفّ الافتراضي LINKED
    const s = await client.glSettings.findUnique({ where: { tenantId: TID }, select: { setupMethod: true, timezone: true, currencyDecimals: true, openingSnapshotAt: true } });
    assert.deepEqual(s, { setupMethod: 'LINKED', timezone: FIX_TZ, currencyDecimals: 2, openingSnapshotAt: T0 });
    // createMany ⇐ أحداث الظلّ (skipDuplicates)
    const row = {
      tenantId: TID, sourceKey: 'SETTLEMENT:s1:POST', sourceType: 'SETTLEMENT', sourceId: 's1', event: 'POST', effectAt: at('2027-02-01T00:00:00Z'),
      payload: { salesRepId: r, amount: '10.00', settledAt: '2027-02-01T00:00:00.000Z' }, status: 'SKIPPED', skipReason: 'OPENING',
      nonCustodyClearedMilli: 5n, shortageRecoveredMilli: 0n,
    };
    assert.deepEqual(await client.glSourceEvent.createMany({ data: [row as never, row as never], skipDuplicates: true }), { count: 1 });
    const evs = await client.glSourceEvent.findMany({
      where: { tenantId: TID, sourceType: 'SETTLEMENT', payload: { path: ['salesRepId'], equals: r } },
      select: { sourceId: true, status: true, nonCustodyClearedMilli: true },
    });
    assert.deepEqual(evs, [{ sourceId: 's1', status: 'SKIPPED', nonCustodyClearedMilli: 5n }]);
    // خارج القائمة المغلقة
    const denied: [string, () => Promise<unknown>][] = [
      ['glMove.findMany', () => client.glMove.findMany({ where: { tenantId: TID } })],
      ['glMoveLine.aggregate', () => client.glMoveLine.aggregate({ where: { tenantId: TID }, _sum: { debitMilli: true } })],
      ['glSettings.update', () => client.glSettings.update({ where: { tenantId: TID }, data: {} })],
      ['glSourceEvent.findFirst', () => client.glSourceEvent.findFirst({ where: { tenantId: TID } })],
      ['glSourceEvent.findMany(where)', () => client.glSourceEvent.findMany({ where: { tenantId: TID, status: 'PENDING' } })],
      ['glSettings.findUnique(where)', () => client.glSettings.findUnique({ where: { tenantId: 'other' } })],
      ['glSettings.findUnique(include|where)', () => client.glSettings.findUnique({ where: { tenantId: TID }, include: { tenant: true } })],
      ['$executeRaw', () => client.$executeRaw`UPDATE "invoices" SET "total" = 0`],
      ['$queryRaw', () => client.$queryRaw`SELECT * FROM "gl_moves"`],
      ['$executeRawUnsafe', () => client.$executeRawUnsafe('SET x = 1')],
    ];
    for (const [name, call] of denied) {
      await assert.rejects(call(), (e: unknown) => e instanceof ShadowGlAccessError && e.code === 'SHADOW_GL_ACCESS' && e.access.startsWith(name.split('(')[0]), name);
    }
    assert.equal(shadow.glViolations.length, denied.length);
    // نبض النشاط: القراءات التشغيلية وحدها
    let beats = 0;
    shadow.activity = () => { beats++; };
    await client.customer.count({ where: { tenantId: TID } });
    await client.glSettings.findUnique({ where: { tenantId: TID } });
    assert.equal(beats, 1);
    shadow.activity = null;
    // SQL خام بلا جداول الدفاتر يمرّ
    const now = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
    assert.deepEqual(now[0].now, FIX_DB_NOW);
    // معاملة متداخلة على الوكيل نفسه
    const nested = client as unknown as { $transaction: (fn: (t: Prisma.TransactionClient) => Promise<number>) => Promise<number> };
    assert.equal(await nested.$transaction(async (t) => t.customer.count({ where: { tenantId: TID } })), 1);
  });
  assert.equal(db.writeCount(), 0);
});

// ═══ السياق الافتراضي ═══

test('السياق الافتراضي: قالب SA بمعرّفاته وربطه، وربط فئات الدخل من المسودة، والرمز المجهول يُعدّ ولا يُربط', () => {
  const opts = previewOptionsFor({ categoryIncomeAccounts: [{ categoryId: 'cat1', accountCode: '411002' }, { categoryId: 'cat2', accountCode: '999999' }] });
  const row = virtualSettingsRow(opts, null, T0);
  const vci = virtualContextInput({ templateKey: 'SA_6D', countryCode: 'SA', settings: settingsSnapshotFromRow(row), categoryIncomeAccounts: opts.categoryIncomeAccounts });
  const ctx = ledgerContextFromInput(vci.contextInput);
  assert.equal(ctx.ctx.accounts.byKey('AR_CONTROL')?.id, accountIdOf('113001'));
  assert.equal(ctx.ctx.accounts.byKey('PAYLINK_CLEARING')?.code, '112005');
  assert.equal(ctx.ctx.journals.bySystemKey('OPENING')?.code !== undefined, true);
  assert.deepEqual(vci.unknownCategoryAccounts, ['999999']);
  const hasIncome = ctx.ctx.accounts.byCode('411002');
  if (hasIncome) assert.equal(ctx.ctx.categoryAccounts('cat1')?.incomeAccountId, accountIdOf('411002'));
  assert.equal(ctx.ctx.categoryAccounts('cat2'), null);
  assert.equal(virtualLedgerContext({ templateKey: 'SA_6D', countryCode: 'SA', settings: ctx.ctx.settings, categoryIncomeAccounts: [] }).accounts.length, ctx.accounts.length);
});

test('صفّ الإعدادات الافتراضي: LINKED عند T0 وتاريخ الربط، والإقفال وD2 من الصفّ الحقيقي، وضريبة الشراء من القالب', () => {
  const real = {
    salesLockDate: at('2026-12-31T00:00:00Z'), purchaseLockDate: null, taxLockDate: null, hardLockDate: null,
    paylinkFeeTaxInvoiceFrom: at('2026-05-01T00:00:00Z'), postSalesDiscountSeparately: false, taxDeadlineRule: 'END_OF_NEXT_MONTH',
    activatedAt: null, setupMethod: null,
  } as unknown as LinkingSettingsRow;
  const row = virtualSettingsRow(previewOptionsFor({ basis: 'FROM_ACTIVATION', inventoryMode: 'PERIODIC' }), real, T0);
  assert.equal(row.setupMethod, 'LINKED');
  assert.equal(row.backfillState, 'RUNNING');
  assert.deepEqual(row.activatedAt, T0);
  assert.deepEqual(row.openingSnapshotAt, T0);
  assert.equal(row.linkBasis, 'FROM_ACTIVATION');
  assert.equal(row.linkedFrom.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(row.cutoverDate?.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(row.perpetualFromDate, null);
  assert.deepEqual(row.salesLockDate, real.salesLockDate);
  assert.equal(row.postSalesDiscountSeparately, false);
  assert.equal(row.defaultPurchaseTaxId, taxIdOf('S15_PURCH'));
  assert.deepEqual(row.receiptRouting, { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' });
});

// ═══ سجلّ التراجع ═══

function simpleDraft(over: Partial<MoveDraft> = {}, amount = 1000n): MoveDraft {
  return {
    kind: 'MOVE', journalCode: 'MISC', moveType: 'ENTRY', origin: 'AUTO', date: '2027-02-01', narration: 'اختبار', needsAttention: false,
    currencyCode: 'SAR', currencyDecimals: 2, sourceType: 'INVOICE', sourceId: 'x', sourceKey: 'INVOICE:x:POST', sourceEvent: 'POST',
    lines: [
      { accountKey: 'MAIN_CASH', label: 'نقد', debitMilli: amount, creditMilli: 0n },
      { accountKey: 'SALES_REVENUE', label: 'إيراد', debitMilli: 0n, creditMilli: amount },
    ],
    ...over,
  };
}

test('سجلّ التراجع: كل تعديل داخل المعاملة يُعاد حرفياً (أحداث، حالات، قيود، مصادر، فهارس، ترقيم، ضرائب آلية)', () => {
  const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  shadow.insertDesired([{ sourceKey: 'INVOICE:a:POST', sourceType: 'INVOICE', sourceId: 'a', event: 'POST', effectAt: at('2027-02-01T00:00:00Z'), payload: { x: 1 } as never }]);
  const ev = shadow.events.get('INVOICE:a:POST')!;
  const first = shadow.postDraft(simpleDraft({ sourceKey: 'INVOICE:a:POST', sourceId: 'a' }));
  const before = {
    events: shadow.events.size, moves: shadow.moveList.length, sources: [...shadow.sources.keys()], status: ev.status,
    cash: shadowBalanceView(shadow).total([accountIdOf('111001')]), ctxTaxes: shadow.context.taxes.length,
  };
  shadow.begin();
  shadow.insertDesired([{ sourceKey: 'INVOICE:b:POST', sourceType: 'INVOICE', sourceId: 'b', event: 'POST', effectAt: at('2027-02-02T00:00:00Z'), payload: null }]);
  shadow.updateEventById(ev.id, { status: 'DONE', moveId: first.id, processedAt: FIX_DB_NOW });
  const second = shadow.postDraft(simpleDraft({ sourceKey: 'INVOICE:b:POST', sourceId: 'b' }, 500n));
  shadow.reverse({ moveId: first.id, actor: SYSTEM_ACTOR, reason: 'اختبار', mode: 'SYSTEM', requestedDate: '2027-03-01', sourceKey: 'INVOICE:a:REVERSE', sourceEvent: 'REVERSE' });
  const ensured = shadow.ensureAutoSaleTaxes([7.5]);
  assert.deepEqual(ensured.created, ['AUTO_SALE_7_5']);
  assert.equal(shadow.moves.get(first.id)!.reversalId !== null, true);
  assert.equal(second.number, 'MISC/2027-02/2');
  shadow.rollback();
  assert.equal(shadow.events.size, before.events);
  assert.equal(shadow.moveList.length, before.moves);
  assert.deepEqual([...shadow.sources.keys()], before.sources);
  assert.equal(ev.status, before.status);
  assert.equal(ev.moveId, null);
  assert.equal(shadow.moves.get(first.id)!.reversalId, null);
  assert.equal(shadowBalanceView(shadow).total([accountIdOf('111001')]), before.cash);
  assert.equal(shadow.context.taxes.length, before.ctxTaxes);
  assert.equal(shadow.autoSalePercents.size, 0);
  // الترقيم والمعرّفات تعود: القيد التالي يأخذ الرقم نفسه
  assert.equal(shadow.postDraft(simpleDraft({ sourceKey: 'INVOICE:c:POST', sourceId: 'c' })).number, 'MISC/2027-02/2');
});

test('سجلّ التراجع لا ينسخ الحالة: ألف معاملة ساقطة على ظلّ من ٢٠ ألف حدث بسرعة ثابتة', () => {
  const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  shadow.insertDesired(Array.from({ length: 20_000 }, (_, i) => ({
    sourceKey: `INVOICE:i${i}:POST`, sourceType: 'INVOICE' as const, sourceId: `i${i}`, event: 'POST' as const,
    effectAt: new Date(at('2027-02-01T00:00:00Z').getTime() + i * 1000), payload: null,
  })));
  const t = Date.now();
  for (let i = 0; i < 1000; i++) {
    shadow.begin();
    shadow.updateEventByKey(`INVOICE:i${i}:POST`, { status: 'DONE' });
    shadow.postDraft(simpleDraft({ sourceKey: `INVOICE:i${i}:POST`, sourceId: `i${i}` }));
    shadow.rollback();
  }
  const ms = Date.now() - t;
  assert.ok(ms < 1500, `1000 تراجع في ${ms}ms`);
  assert.equal(shadow.rollbacks, 1000);
  assert.equal([...shadow.events.values()].every((e) => e.status === 'PENDING'), true);
  assert.equal(shadow.moveList.length, 0);
});

test('postDraft: P2002 على sourceKey وعلى reversedMoveId قبل أي تعديل، ودفتر مفقود LEDGER_ACCOUNT_NOT_FOUND، وسقف الأحداث TOO_LARGE', () => {
  const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW, 3);
  const m = shadow.postDraft(simpleDraft());
  assert.throws(() => shadow.postDraft(simpleDraft()), (e: { code?: string; meta?: { target?: string[] } }) => e.code === 'P2002' && e.meta?.target?.join() === 'tenantId,sourceKey');
  shadow.reverse({ moveId: m.id, actor: SYSTEM_ACTOR, reason: 'ع', mode: 'SYSTEM', requestedDate: '2027-01-15' });
  assert.equal(shadow.moveList[1].date, '2027-02-01', 'العكس بتاريخ max(المطلوب، الأصل)');
  const again = shadow.reverse({ moveId: m.id, actor: SYSTEM_ACTOR, reason: 'ع', mode: 'SYSTEM', requestedDate: '2027-03-01' });
  assert.equal(again.alreadyReversed, true);
  assert.throws(() => shadow.postDraft(simpleDraft({ sourceKey: null, sourceEvent: null }), { reversedMoveId: m.id }), (e: { code?: string }) => e.code === 'P2002');
  assert.throws(() => shadow.postDraft(simpleDraft({ journalCode: 'NOPE', sourceKey: null })), (e: { code?: string }) => e.code === 'LEDGER_ACCOUNT_NOT_FOUND');
  assert.equal(shadow.moveList.length, 2);
  shadow.insertDesired([1, 2, 3].map((i) => ({ sourceKey: `K${i}`, sourceType: 'INVOICE' as const, sourceId: `${i}`, event: 'POST' as const, effectAt: FIX_DB_NOW, payload: null })));
  assert.throws(() => shadow.insertDesired([{ sourceKey: 'K4', sourceType: 'INVOICE', sourceId: '4', event: 'POST', effectAt: FIX_DB_NOW, payload: null }]), ShadowTooLargeError);
  assert.equal(shadow.tooLarge, true);
});

// ═══ المُطابِق والمُرحِّل الحقيقيان فوق الظلّ ═══

async function runEngine(s: LinkingScenario, opts = previewOptionsFor()) {
  return inSnapshot(s.db, async (tx, dbNow) => {
    const built = createPreviewShadow(TID, opts, dbNow);
    const { shadow } = built;
    const client = createShadowClient(tx, shadow);
    const wm = initialWatermarkAt({ method: 'OPENING', cutoverDate: FIX_LINKED_FROM, openingSnapshotAt: built.t0, timezone: FIX_TZ });
    for (const src of RECONCILED_SOURCES) shadow.setCursor(src, wm, '');
    await scanFutureDatedRows(client, TID, { watermarkAt: wm, cutoverStart: CUTOVER_START, settings: built.reconcileSettings });
    const rec = new ShadowReconcilerStore(shadow, client);
    for (let i = 0; i < 5; i++) {
      const r = await reconcileTenant(rec, TID, { pageSize: 2000, settings: built.reconcileSettings, dbNow: shadow.now(), log: () => undefined });
      if (r.reduce((a, x) => a + x.eventsInserted + x.tailEventsInserted, 0) === 0) break;
    }
    const store = new ShadowPostingStore(shadow, client);
    shadow.rebuildQueues();
    for (let i = 0; i < 20; i++) {
      const r = await runPoster(store, built.posterSettings, createSyncBudget({ timeMs: 1e12, events: 1e9 }), { actor: SYSTEM_ACTOR, log: () => undefined });
      if (r.stoppedBy === 'EMPTY') break;
    }
    return { shadow, built };
  });
}

test('المحرّك فوق الظلّ: 113001 لكل عميل = Σ قيود الحساب غير المشمولة بالافتتاح، و112005 = Σ قيود التسوية، وصفر كتابات', async () => {
  const s = buildLinkingScenario();
  const { shadow } = await runEngine(s);
  assert.deepEqual(shadow.glViolations, []);
  assert.equal(s.db.writeCount(), 0, 'لا كتابة في القاعدة');
  const view = shadowBalanceView(shadow);
  assert.deepEqual(view.unbalancedMoves(), []);
  const g = view.grandTotals();
  assert.equal(g.debitMilli, g.creditMilli);
  // الذمم لكل عميل
  const expected = new Map<string, bigint>();
  for (const row of s.db.rows('accountEntry')) {
    if (s.aeIncluded(row)) continue;
    const k = row.customerId as string;
    expected.set(k, (expected.get(k) ?? 0n) + toMilli(row.debit as number, 2) - toMilli(row.credit as number, 2));
  }
  const ar = view.balanceByPartner([view.accountIdByKey('AR_CONTROL')!], 'customerId');
  for (const [cust, v] of expected) assert.equal(ar.get(cust) ?? 0n, v, `ذمة ${cust}`);
  assert.equal([...ar.keys()].every((k) => expected.has(k)), true);
  // الأمانات
  let se = 0n;
  for (const row of s.db.rows('settlementEntry')) if ((row.createdAt as Date).getTime() >= CUTOVER_START.getTime()) se += toMilli(row.amount as number, 2);
  assert.equal(view.total([view.accountIdByKey('PAYLINK_CLEARING')!]), se);
  // الاستيراد بعد البدء على 319002 معلَّماً، والوصول المتأخر بتاريخ البدء
  const eq = view.linesOn(view.accountIdByKey('OPENING_EQUITY')!, 50);
  assert.equal(eq.length, 1);
  assert.equal(eq[0].needsAttention, true);
  assert.equal(eq[0].attentionReason, IMPORT_AFTER_CUTOVER_ATTENTION_REASON);
  const late = shadow.moveList.find((m) => m.lateArrival);
  assert.ok(late, 'قيد وصول متأخر');
  assert.equal(late!.date, FIX_LINKED_FROM);
  assert.equal(late!.originalDate, '2026-12-28');
  // المؤرّخ مستقبلاً قبل T0 رُحّل بتاريخه
  assert.ok(shadow.moveList.some((m) => m.date === '2027-01-05' && m.sourceType === 'INVOICE'));
  // إلغاء فاتورة ما قبل السنة: شقيق POST مدرج SKIPPED(OPENING) والعكس مبني من المصدر
  const preCancel = [...shadow.events.values()].find((e) => e.sourceType === 'INVOICE' && e.event === 'REVERSE' && e.effectAt.toISOString().startsWith('2027-02-15'));
  assert.equal(preCancel?.status, 'DONE');
  const sibling = shadow.events.get(preCancel!.sourceKey.replace(':REVERSE', ':POST'));
  assert.equal(sibling?.status, 'SKIPPED');
  assert.equal(sibling?.skipReason, 'OPENING');
  // الاستلام رُحّل (P7) والعهدة تقابله
  const st = [...shadow.events.values()].find((e) => e.sourceType === 'SETTLEMENT');
  assert.equal(st?.status, 'DONE');
  // لا محجوز في هذا السيناريو
  assert.deepEqual([...shadow.events.values()].filter((e) => !['DONE', 'SKIPPED'].includes(e.status)).map((e) => `${e.sourceKey}:${e.status}:${e.lastError}`), []);
});

test('المحجوز: صفّ بفاتورة وسند معاً HELD، وحساب ناقص HELD(MISSING_MAPPING)، وسند إلكتروني بلا رابط على 911001', async () => {
  const s = buildLinkingScenario();
  // صفّ يحمل فاتورة وسنداً معاً (لفاتورة لا صفوف أخرى لها كي لا يختلط بأحداثها)
  s.db.seed('accountEntry', [{ id: 'ae-bad', tenantId: TID, customerId: s.c1, invoiceId: 'inv-ghost', receiptId: s.db.rows('receipt')[0].id, type: 'RECEIPT_CREDIT', credit: 5, balance: 0, description: '', entryDate: at('2027-05-01T08:00:00Z'), createdAt: at('2027-05-01T08:00:00Z') }]);
  s.f.receipt({ customerId: s.c2, amount: 11, method: 'ONLINE', at: at('2027-05-02T08:00:00Z'), invoiceId: null });
  const { shadow } = await runEngine(s);
  const held = [...shadow.events.values()].filter((e) => e.status === 'HELD');
  assert.equal(held.length, 1);
  assert.match(held[0].lastError ?? '', /^HELD:UNEXPECTED_ENTRY_SHAPE/);
  const out = heldLines(shadow, 500);
  assert.equal(out.lines.filter((l) => l.kind === 'EVENT').length, 1);
  const susp = out.lines.filter((l) => l.kind === 'SUSPENSE_LINE');
  assert.equal(susp.length, 1);
  assert.equal(susp[0].amountMilli, 11_000n);
  assert.equal(susp[0].partnerType, 'CUSTOMER');
  // حمولة الصفّ غير المتوقّع فارغة (لا حقائق) ⇒ بلا شريك
  assert.equal(heldByPartner(shadow).size, 0);
  assert.equal(heldLines(shadow, 1).truncated, 1);
  // حدث محجوز بحمولة عميل ⇒ مفتاحه تحت العميل؛ والاستلام تحت المندوب
  shadow.insertDesired([
    { sourceKey: 'INVOICE:h1:POST', sourceType: 'INVOICE', sourceId: 'h1', event: 'POST', effectAt: FIX_DB_NOW, payload: { customerId: s.c1, total: '5.00' } as never, status: 'HELD', lastError: 'HELD:CURRENCY_MISMATCH|SAR≠USD' },
    { sourceKey: 'SETTLEMENT:h2:POST', sourceType: 'SETTLEMENT', sourceId: 'h2', event: 'POST', effectAt: FIX_DB_NOW, payload: { salesRepId: s.r1, amount: '3.00' } as never, status: 'HELD', lastError: 'HELD:MISSING_MAPPING' },
  ]);
  assert.deepEqual(heldByPartner(shadow).get(s.c1), ['INVOICE:h1:POST']);
  assert.deepEqual(heldByPartner(shadow).get(s.r1), ['SETTLEMENT:h2:POST']);
  const h1 = heldLines(shadow, 500).lines.find((l) => l.sourceKey === 'INVOICE:h1:POST')!;
  assert.equal(h1.amountMilli, 5000n);
  assert.equal(h1.reason, 'CURRENCY_MISMATCH');
  assert.equal(h1.detail, 'SAR≠USD');

  // حساب ناقص: ربط الأمانات أُزيل من السياق ⇒ السند الإلكتروني HELD(MISSING_MAPPING)
  const s2 = buildLinkingScenario();
  const r = await inSnapshot(s2.db, async (tx, dbNow) => {
    const built = createPreviewShadow(TID, previewOptionsFor(), dbNow);
    const input = { ...virtualContextInput({ templateKey: 'SA_6D', countryCode: 'SA', settings: built.posterSettings.snapshot, categoryIncomeAccounts: [] }).contextInput };
    input.mappings = { ...input.mappings };
    delete (input.mappings as Record<string, string>).PAYLINK_CLEARING;
    const shadow2 = new ShadowState({ tenantId: TID, settingsRow: built.shadow.settingsRow, contextInput: input, reconcileSettings: built.reconcileSettings, posterSettings: built.posterSettings, now: dbNow });
    const client = createShadowClient(tx, shadow2);
    const wm = initialWatermarkAt({ method: 'OPENING', cutoverDate: FIX_LINKED_FROM, openingSnapshotAt: built.t0, timezone: FIX_TZ });
    for (const src of RECONCILED_SOURCES) shadow2.setCursor(src, wm, '');
    await reconcileTenant(new ShadowReconcilerStore(shadow2, client), TID, { settings: built.reconcileSettings, dbNow, log: () => undefined });
    const store = new ShadowPostingStore(shadow2, client);
    await runPoster(store, built.posterSettings, createSyncBudget({ timeMs: 1e12, events: 1e9 }), { log: () => undefined });
    return shadow2;
  });
  const mm = [...r.events.values()].filter((e) => e.status === 'HELD' && /MISSING_MAPPING/.test(e.lastError ?? ''));
  assert.ok(mm.length >= 1, 'HELD(MISSING_MAPPING)');
  assert.ok(r.rollbacks >= 1, 'المعاملة الساقطة تراجعت');
  assert.ok(eventCounts(r).some((c) => c.status === 'HELD' && c.reason === 'MISSING_MAPPING'));
});

// ═══ التجميع ═══

test('ميزان المراجعة بالأشهر والقوائم والضريبة من الظلّ: متوازن، والمربع SA_1 بالوعاء والضريبة، والأشهر حتى اللقطة', async () => {
  const s = buildLinkingScenario();
  const { shadow } = await runEngine(s);
  const ctx = shadow.context;
  const tb = trialBalanceByMonth(shadow, ctx, FIX_LINKED_FROM, '2027-06-15');
  assert.deepEqual(tb.months, ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']);
  assert.equal(tb.totals.debitMilli, tb.totals.creditMilli);
  assert.equal(tb.totals.closingMilli, 0n);
  assert.equal(tb.rows.map((r) => r.accountCode).join(), [...tb.rows].map((r) => r.accountCode).sort().join());
  for (const r of tb.rows) assert.equal(r.closingMilli, r.openingMilli + r.debitMilli - r.creditMilli);
  const st = { asOf: '2027-06-15', fiscalYearEndMonth: 12, fiscalYearEndDay: 31 };
  const pnl = pnlYtd(shadow, ctx, st);
  assert.equal(pnl.from, '2027-01-01');
  const bs = balanceSheetToday(shadow, ctx, st);
  assert.equal(bs.balanced, true);
  assert.equal(bs.assetsMilli, bs.liabilitiesMilli + bs.equityMilli);
  const vat = vatByPeriodBox(shadow, ctx, 'QUARTERLY', { month: 12, day: 31 });
  assert.ok(vat.length > 0);
  for (const row of vat) assert.match(row.periodKey, /^2027-Q[12]$/);
  // ضريبة الربع الأول = Σ ضرائب سطور 212001 فيه (دائن − مدين)
  const vatAcc = ctx.ctx.accounts.byKey('OUTPUT_VAT')!.id;
  let q1 = 0n;
  for (const l of shadow.linesOn(vatAcc)) if (l.date >= '2027-01-01' && l.date <= '2027-03-31') q1 += l.creditMilli - l.debitMilli;
  assert.equal(vat.filter((r) => r.periodKey === '2027-Q1').reduce((a, r) => a + r.taxMilli, 0n), q1);
});

test('vatPeriodOf: كل الدوريات بمفاتيحها وحدودها', () => {
  const fy = { month: 12, day: 31 };
  assert.deepEqual(vatPeriodOf('2027-05-17', 'MONTHLY', fy), { key: '2027-05', from: '2027-05-01', to: '2027-05-31' });
  assert.deepEqual(vatPeriodOf('2027-05-17', 'BIMONTHLY', fy), { key: '2027-B3', from: '2027-05-01', to: '2027-06-30' });
  assert.deepEqual(vatPeriodOf('2027-05-17', 'QUARTERLY', fy), { key: '2027-Q2', from: '2027-04-01', to: '2027-06-30' });
  assert.deepEqual(vatPeriodOf('2027-05-17', 'FOUR_MONTHS', fy), { key: '2027-T2', from: '2027-05-01', to: '2027-08-31' });
  assert.deepEqual(vatPeriodOf('2027-05-17', 'SEMIANNUAL', fy), { key: '2027-H1', from: '2027-01-01', to: '2027-06-30' });
  assert.deepEqual(vatPeriodOf('2027-05-17', 'ANNUAL', fy), { key: '2027', from: '2027-01-01', to: '2027-12-31' });
  assert.deepEqual(vatPeriodOf('2027-05-17', 'FISCAL_YEAR', { month: 3, day: 31 }), { key: '2027', from: '2027-04-01', to: '2028-03-31' });
});

test('openingPreview: المشتقّ أولاً ثم اليدوي ثم 319002، والشركاء والمواقع، والمجاميع، والقصّ', () => {
  const ctx = virtualLedgerContext({ templateKey: 'SA_6D', countryCode: 'SA', settings: createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW).posterSettings.snapshot, categoryIncomeAccounts: [] });
  const draft: MoveDraft = {
    kind: 'MOVE', journalCode: 'OPEN', journalSystemKey: 'OPENING', moveType: 'OPENING', origin: 'AUTO', date: '2026-12-31', narration: 'افتتاحي',
    needsAttention: false, currencyCode: 'SAR', currencyDecimals: 2,
    lines: [
      { accountKey: 'AR_CONTROL', label: 'ذمة', debitMilli: 1000n, creditMilli: 0n, customerId: 'c1', partnerName: 'عميل' },
      { accountKey: 'REP_CUSTODY', label: 'عهدة', debitMilli: 300n, creditMilli: 0n, salesRepId: 'r1', partnerName: 'مندوب' },
      { accountKey: 'INVENTORY_WAREHOUSE', label: 'مستودع', debitMilli: 500n, creditMilli: 0n },
      { accountKey: 'INVENTORY_VAN', label: 'سيارة', debitMilli: 200n, creditMilli: 0n, salesRepId: 'r1', partnerName: 'مندوب' },
      { accountCode: '111001', label: 'نقد يدوي', debitMilli: 100n, creditMilli: 0n },
      { accountKey: 'OPENING_EQUITY', label: 'فرق', debitMilli: 0n, creditMilli: 2100n },
    ],
  };
  const result = { draft, equityDiffMilli: 2100n, totalDebitMilli: 2100n, manualDebitMilli: 100n, manualCreditMilli: 0n, lineCount: 6, derivedLineCount: 4 };
  const p = openingPreview(draft, result as never, ctx, [{ index: 2, accountCode: '113001', reason: 'DERIVED_ACCOUNT' }], 5);
  assert.deepEqual(p.lines.map((l) => l.origin), ['DERIVED', 'DERIVED', 'DERIVED', 'DERIVED', 'MANUAL']);
  assert.equal(p.linesTruncated, 1);
  assert.deepEqual(p.lines.map((l) => `${l.partnerType}:${l.partnerId}`), ['CUSTOMER:c1', 'REP:r1', 'LOCATION:WH', 'LOCATION:VAN:r1', 'null:null']);
  assert.equal(p.totals.debitMilli, 2100n);
  assert.equal(p.totals.creditMilli, 2100n);
  assert.equal(p.totals.derivedNetMilli, 2000n);
  assert.equal(p.totals.equityDiffMilli, 2100n);
  assert.deepEqual(p.byAccount.map((b) => b.accountCode), ['111001', '111003', '113001', '114001', '114002', '319002']);
  assert.deepEqual(p.manualIssues, [{ index: 2, accountCode: '113001', reason: 'DERIVED_ACCOUNT' }]);
  const full = openingPreview(draft, result as never, ctx, [], 100);
  assert.equal(full.lines[5].origin, 'EQUITY');
  assert.equal(openingPreview(null, { ...result, draft: null } as never, ctx, [], 10, '2026-12-31').date, '2026-12-31');
});

test('etaAndStorage: الوقت بـ40ms/حدث وميزانيتي الذروة، والتخزين بصفوفه وبايتاته وملاحظة الهامش', () => {
  const r = etaAndStorage({ eventsToPost: 30_000, events: 31_000, moves: 29_000, lines: 120_000, moveSources: 29_000, costSnapshots: 50_000 });
  assert.equal(r.eta.etaMinutesOffPeak, Math.ceil((30_000 * 40) / BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN));
  assert.equal(r.eta.etaMinutesPeakOnly, Math.ceil((30_000 * 40) / 5_000));
  assert.equal(r.storage.rows.audits, 29_000);
  assert.equal(r.storage.rows.total, 31_000 + 29_000 + 120_000 + 29_000 + 29_000 + 50_000);
  assert.equal(r.storage.bytesEstimate, (31_000 + 29_000 + 120_000 + 29_000 + 29_000) * ROW_BYTES_ESTIMATE + 50_000 * 300);
  assert.equal(r.storage.headroomNote, null);
  const big = etaAndStorage({ eventsToPost: 1, events: PREVIEW_HEADROOM_BYTES / ROW_BYTES_ESTIMATE + 1, moves: 0, lines: 0, moveSources: 0, costSnapshots: 0 });
  assert.match(big.storage.headroomNote ?? '', /ميغابايت/);
});

// ═══ البصمتان ═══

test('canonicalJson: ترتيب المفاتيح لا يغيّر النص، وBigInt نصّاً وDate بـISO وundefined يُسقط', () => {
  assert.equal(canonicalJson({ b: 1n, a: { d: at('2027-01-01T00:00:00Z'), c: undefined } }), '{"a":{"d":"2027-01-01T00:00:00.000Z"},"b":"1"}');
  assert.equal(canonicalJson({ x: [1, undefined, 2n] }), '{"x":[1,null,"2"]}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

function hashInput(over: Partial<DataHashInput> = {}): DataHashInput {
  return {
    settings: {
      basis: 'FY_RESTATED', linkedFrom: FIX_LINKED_FROM, timezone: FIX_TZ, currency: 'SAR', currencyDecimals: 2, templateKey: 'SA_6D', countryCode: 'SA',
      fyEnd: { month: 12, day: 31 }, receiptRouting: { CASH: 'CUSTODY' }, cashInvoiceRouting: 'MAIN_CASH', inventoryMode: 'PERPETUAL', categoryIncomeAccounts: [],
    },
    manualRows: [{ accountCode: '111001', debit: 100 }],
    derivedLines: [{ account: '113001', partner: 'c1', milli: 1000n }],
    costingOpening: [{ location: 'WH', qtyBase: 10, uncostedQty: 0, valueMilli: 50_000n }],
    preCutoverSources: { account_entries: { count: 1, maxCreatedAt: null, maxId: null, sumMilli: '10', sumEffectSec: 5 } },
    ...over,
  };
}

test('computeDataHash حتمي وحسّاس لكل مدخل؛ وcomputeResultHash يتجاهل التوقيتات واللقطة والساعة', () => {
  const h = computeDataHash(hashInput());
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(computeDataHash(hashInput()), h);
  assert.notEqual(computeDataHash(hashInput({ derivedLines: [{ account: '113001', partner: 'c1', milli: 1001n }] })), h);
  assert.notEqual(computeDataHash(hashInput({ manualRows: [] })), h);
  assert.notEqual(computeDataHash(hashInput({ costingOpening: [] })), h);
  assert.notEqual(computeDataHash(hashInput({ preCutoverSources: {} })), h);
  const r = { version: 1, tenantId: TID, dataHash: h } as unknown as PreviewResult;
  const a = computeResultHash({ ...r, timings: [{ phase: 'READ', ms: 5 }], snapshotAt: 'x', dbNow: 'y', resultHash: 'z' } as never);
  const b = computeResultHash({ ...r, timings: [], snapshotAt: 'q', dbNow: 'w' } as never);
  assert.equal(a, b);
  assert.notEqual(computeResultHash({ ...r, tenantId: 't2' } as never), a);
});

test('loadPreCutoverSourceStats: ما قبل البدء وحده أياً كان createdAt، بصفحات عبر الحدّ، ويتغيّر بصفٍّ قبل البدء لا بعده', async () => {
  const db = fakeDb();
  const f = seedBasics(db);
  const c = f.customer('عميل');
  const p = f.product('صنف');
  const n = PRE_CUTOVER_PAGE + 7;
  db.seed('accountEntry', Array.from({ length: n }, (_, i) => ({
    id: `pae-${String(i).padStart(6, '0')}`, tenantId: TID, customerId: c, type: 'ADJUSTMENT_DEBIT', debit: 1.005, credit: 0, balance: 0, description: '',
    entryDate: at('2026-06-01T00:00:00Z'), createdAt: new Date(at('2026-06-01T00:00:00Z').getTime() + (i % 50) * 1000),
  })));
  // وصول متأخر قبل البدء (أُنشئ في السنة) يدخل؛ وصفّ السنة لا يدخل
  f.importEntry({ customerId: c, debit: 7, entryDate: at('2026-12-30T00:00:00Z'), at: at('2027-03-01T00:00:00Z') });
  const inYear = f.importEntry({ customerId: c, debit: 9, entryDate: at('2027-02-01T00:00:00Z'), at: at('2027-02-01T00:00:00Z') });
  f.warehouse({ items: [{ productId: p, qty: 3, unitCost: 2.5 }, { productId: p, qty: 1, unitCost: null }], at: at('2026-11-01T00:00:00Z') });
  f.warehouse({ items: [{ productId: p, qty: 5, unitCost: 1 }], at: at('2027-02-01T00:00:00Z') });
  f.settlement({ repId: f.rep('م'), amount: 12.345, at: at('2026-10-01T00:00:00Z') });
  const read = () => inSnapshot(db, (tx) => loadPreCutoverSourceStats(tx, TID, CUTOVER_START, 2));
  const s1 = await read();
  assert.equal(s1.account_entries.count, n + 1);
  // كل صفّ يُقرَّب وحده: 1.005 ⇒ 1.01 (لا جمع Float ثم تقريب)
  assert.equal(s1.account_entries.sumMilli, String(BigInt(n) * 1010n + 7000n));
  assert.equal(s1.account_entries.maxCreatedAt, '2027-03-01T00:00:00.000Z');
  assert.equal(s1.warehouse_entry_items.count, 2);
  assert.equal(s1.warehouse_entry_items.sumMilli, '7500|4000000');
  assert.equal(s1.rep_settlements.sumMilli, '12350');
  assert.ok(db.readCount('accountEntry.findMany') >= 2, 'صفحات');
  // صفّ في السنة تغيّر ⇒ لا تغيّر
  db.patch('accountEntry', inYear, { debit: 99 });
  assert.equal(canonicalJson(await read()), canonicalJson(s1));
  // صفّ قبل البدء تغيّر ⇒ تغيّر
  db.patch('accountEntry', 'pae-000003', { debit: 2 });
  assert.notEqual(canonicalJson(await read()), canonicalJson(s1));
  assert.equal(db.writeCount(), 0);

  // صفحات صغيرة: النتيجة نفسها حرفياً، وكل صفحة بعد الأولى نافذتها createdAt ≥ المؤشّر صراحةً (حدّ نطاق الفهرس — Postgres لا
  // يشتقّه من OR فكانت كل صفحة تمسح من أول صفٍّ للشركة: تربيعي) مع الحدّ الأعلى cutoverStart حيث النافذة بـcreatedAt
  const full = await read();
  const wheres: Array<[string, Record<string, unknown>]> = [];
  const small = await inSnapshot(db, (tx) => {
    const spy = new Proxy(tx as unknown as Record<string, Record<string, (a: unknown) => unknown>>, {
      get(t, model: string) {
        const d = t[model];
        if (!d || typeof d !== 'object') return d;
        return new Proxy(d, {
          get(dd, m: string) {
            if (m !== 'findMany') return dd[m];
            return (a: { where?: Record<string, unknown> }) => { wheres.push([model, a.where ?? {}]); return dd.findMany(a); };
          },
        });
      },
    });
    return loadPreCutoverSourceStats(spy as never, TID, CUTOVER_START, 2, { page: 1_000, parentPage: 1 });
  });
  assert.equal(canonicalJson(small), canonicalJson(full));
  const paged = wheres.filter(([, w]) => Array.isArray(w.OR));
  const models = new Set(paged.map(([m]) => m));
  for (const m of ['accountEntry', 'warehouseEntry']) assert.ok(models.has(m), `صفحات ${m}`);
  for (const [m, w] of paged) {
    const cur = (w.OR as Array<{ createdAt: { gt: Date } }>)[0].createdAt.gt;
    const ca = w.createdAt as { gte?: Date; lt?: Date };
    assert.equal(ca.gte?.getTime(), cur.getTime(), `${m}: gte = المؤشّر`);
    if (['settlementEntry', 'warehouseEntry', 'vanLoad', 'invoiceRestockLog'].includes(m)) assert.equal(ca.lt?.getTime(), CUTOVER_START.getTime(), `${m}: lt`);
  }
});

test('heldByPartner/heldLines: حدث عكسٍ محجوز يفسّر فرق R2 بشركاء شقيقه POST ومبلغه سالباً، وسند مندوبٍ محجوز يفسّر فرق R3', () => {
  const d = (s: string) => new Date(s);
  // حمولات desired.ts الحقيقية: حمولة العكس بلا عميل ولا مندوب ولا مبلغ
  const inv = {
    id: 'inv1', number: 'I-1', type: 'CREDIT', customerId: 'C1', salesRepId: 'R1', pricesIncludeTax: false,
    subtotal: 1000, discountAmt: 0, taxAmt: 150, total: 1150, dueDate: null, customerName: 'عميل 1', salesRepName: 'مندوب 1',
    items: [{ productId: 'p', categoryId: null, qty: 1, unitPrice: 1000, taxPct: 15, taxAmt: 150, lineTotal: 1150, vatCategory: 'S' }],
  };
  const ret = { ...inv, id: 'ret1', number: 'RT-1', type: 'RETURN', total: 230, subtotal: 200, taxAmt: 30, items: [{ ...inv.items[0], unitPrice: 200, taxAmt: 30, lineTotal: 230 }] };
  const rc = { id: 'rc1', number: 'R-1', customerId: 'C2', salesRepId: 'R2', paymentMethod: 'CASH', amount: 500, customerName: 'عميل 2', salesRepName: 'مندوب 2', paylinkId: null, refund: null };
  const row = (id: string, o: Record<string, unknown>) => ({ id, description: null, debit: 0, credit: 0, invoiceId: null, receiptId: null, ...o });
  const evs = deriveAccountEntryEvents([
    row('e1', { customerId: 'C1', invoiceId: 'inv1', type: 'INVOICE_DEBIT', debit: 1150, entryDate: d('2027-03-01T10:00:00Z'), createdAt: d('2027-03-01T10:00:00Z') }),
    row('e2', { customerId: 'C1', invoiceId: 'inv1', type: 'INVOICE_CREDIT', credit: 1150, entryDate: d('2027-03-05T10:00:00Z'), createdAt: d('2027-03-05T10:00:00Z') }),
    row('e3', { customerId: 'C2', receiptId: 'rc1', type: 'RECEIPT_CREDIT', credit: 500, entryDate: d('2027-03-02T10:00:00Z'), createdAt: d('2027-03-02T10:00:00Z') }),
    row('e4', { customerId: 'C1', invoiceId: 'ret1', type: 'INVOICE_CREDIT', credit: 230, entryDate: d('2027-03-03T10:00:00Z'), createdAt: d('2027-03-03T10:00:00Z') }),
  ] as never, {
    timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2,
    invoices: new Map([['inv1', inv], ['ret1', ret]]), receipts: new Map([['rc1', rc]]),
  } as never);
  const rev = evs.find((e) => e.sourceKey === 'INVOICE:inv1:REVERSE')!;
  assert.equal((rev.payload as unknown as Record<string, unknown>).customerId, undefined, 'حمولة العكس بلا عميل (مقدّمة الاختبار)');
  const status: Record<string, string> = { 'INVOICE:inv1:POST': 'DONE', 'INVOICE:inv1:REVERSE': 'ERROR', 'RECEIPT:rc1:POST': 'HELD', 'INVOICE:ret1:POST': 'HELD' };
  const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  shadow.insertDesired(evs.map((e) => ({ ...e, status: status[e.sourceKey] ?? 'DONE', lastError: status[e.sourceKey] === 'HELD' ? 'HELD:UNEXPECTED_ENTRY_SHAPE' : status[e.sourceKey] === 'ERROR' ? 'LIVE_MOVE_NOT_FOUND' : null })) as never);

  const held = heldByPartner(shadow);
  // قبل الإصلاح: [['C2', ['RECEIPT:rc1:POST']]] وحده — لا C1 (العكس) ولا R2 (المندوب)
  assert.deepEqual([...held].sort((a, b) => (a[0] < b[0] ? -1 : 1)), [
    ['C1', ['INVOICE:inv1:REVERSE', 'INVOICE:ret1:POST']],
    ['C2', ['RECEIPT:rc1:POST']],
    ['R1', ['INVOICE:inv1:REVERSE', 'INVOICE:ret1:POST']],
    ['R2', ['RECEIPT:rc1:POST']],
  ]);
  // R2: الأستاذ +1,150 لـC1 (POST رُحِّل والعكس عالق) والتشغيل صفر ⇒ الفرق يفسّره العكس المحجوز
  const r2 = partnerRows(new Map([['C1', 0n]]), new Map([['C1', 1_150_000n]]), { partnerType: 'CUSTOMER', heldByPartner: held, explainDiffs: true });
  assert.deepEqual(r2.rows[0].refs, ['INVOICE:inv1:REVERSE', 'INVOICE:ret1:POST']);
  assert.doesNotMatch(r2.rows[0].note ?? '', /لا يفسّره/);
  // R3: عهدة R2 التشغيلية 500 والأستاذ صفر (استلام السند محجوز) ⇒ يفسّره السند
  const r3 = partnerRows(new Map([['R2', 500_000n]]), new Map(), { partnerType: 'REP', heldByPartner: held, explainDiffs: true });
  assert.deepEqual(r3.rows[0].refs, ['RECEIPT:rc1:POST']);
  assert.doesNotMatch(r3.rows[0].note ?? '', /لا يفسّره/);

  const lines = new Map(heldLines(shadow, 500).lines.filter((l) => l.kind === 'EVENT').map((l) => [l.sourceKey, l]));
  // العكس: شريك شقيقه ومبلغه سالباً (كان null وnull)
  const r = lines.get('INVOICE:inv1:REVERSE')!;
  assert.deepEqual([r.partnerType, r.partnerId, r.partnerName, r.amountMilli], ['CUSTOMER', 'C1', 'عميل 1', -1_150_000n]);
  // المرتجع دائنٌ للعميل ⇒ سالب؛ والسند بعميله (العرض) ومبلغه
  assert.equal(lines.get('INVOICE:ret1:POST')!.amountMilli, -230_000n);
  const s = lines.get('RECEIPT:rc1:POST')!;
  assert.deepEqual([s.partnerType, s.partnerId, s.amountMilli], ['CUSTOMER', 'C2', 500_000n]);
});

test('eventCounts وheldByPartner حتميان بلا ICU', async () => {
  const s = buildLinkingScenario();
  const { shadow } = await runEngine(s);
  const rows = eventCounts(shadow);
  const keys = rows.map((r) => `${r.sourceType}|${r.event}|${r.status}|${r.reason ?? ''}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(rows.reduce((a, r) => a + r.count, 0), shadow.events.size);
  assert.ok(rows.some((r) => r.sourceType === 'INVOICE' && r.status === 'SKIPPED' && r.reason === 'OPENING'));
});

test('طابور المستحق: الترتيب ومسارا العدالة وexcludeIds (ومنها مصفوفة ليست امتداداً) وBLOCKED حتى يحين موعده', () => {
  const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  const ev = (key: string, type: 'INVOICE' | 'AR_ENTRY' | 'RECEIPT', iso: string, event: 'POST' | 'REVERSE' = 'POST') =>
    ({ sourceKey: key, sourceType: type, sourceId: key, event, effectAt: at(iso), payload: null });
  shadow.insertDesired([
    ev('INVOICE:b:POST', 'INVOICE', '2027-02-02T00:00:00Z'), ev('INVOICE:a:REVERSE', 'INVOICE', '2027-02-01T00:00:00Z', 'REVERSE'),
    ev('INVOICE:a:POST', 'INVOICE', '2027-02-01T00:00:00Z'), ev('AR_ENTRY:x:POST', 'AR_ENTRY', '2027-01-15T00:00:00Z'),
    ev('RECEIPT:r:POST', 'RECEIPT', '2027-03-01T00:00:00Z'),
  ]);
  const live = { now: FIX_DB_NOW, limit: 10, sourceTypes: { notIn: ['AR_ENTRY'] as const } };
  assert.deepEqual(shadow.listDue(live).map((e) => e.sourceKey), ['INVOICE:a:POST', 'INVOICE:a:REVERSE', 'INVOICE:b:POST', 'RECEIPT:r:POST']);
  assert.deepEqual(shadow.listDue({ now: FIX_DB_NOW, limit: 10, sourceTypes: { in: ['AR_ENTRY'] } }).map((e) => e.sourceKey), ['AR_ENTRY:x:POST']);
  assert.deepEqual(shadow.listDue({ now: FIX_DB_NOW, limit: 2 }).map((e) => e.sourceKey), ['AR_ENTRY:x:POST', 'INVOICE:a:POST']);
  const idOf = (k: string) => shadow.events.get(k)!.id;
  const ex1 = [idOf('INVOICE:a:POST')];
  assert.deepEqual(shadow.listDue({ ...live, excludeIds: ex1 }).map((e) => e.sourceKey)[0], 'INVOICE:a:REVERSE');
  const ex2 = [...ex1, idOf('INVOICE:a:REVERSE')];
  assert.deepEqual(shadow.listDue({ ...live, excludeIds: ex2 }).map((e) => e.sourceKey)[0], 'INVOICE:b:POST');
  // مصفوفة جديدة ليست امتداداً (تشغيل مُرحِّل جديد) ⇒ تُبنى من جديد
  assert.deepEqual(shadow.listDue({ ...live, excludeIds: [idOf('INVOICE:b:POST')] }).map((e) => e.sourceKey), ['INVOICE:a:POST', 'INVOICE:a:REVERSE', 'RECEIPT:r:POST']);
  // BLOCKED بموعد لاحق لا يُدرج حتى تتقدّم الساعة؛ والنهائي لا يعود
  shadow.updateEventByKey('INVOICE:a:POST', { status: 'BLOCKED', nextAttemptAt: new Date(FIX_DB_NOW.getTime() + 60_000) });
  shadow.updateEventByKey('INVOICE:a:REVERSE', { status: 'DONE' });
  assert.deepEqual(shadow.listDue(live).map((e) => e.sourceKey), ['INVOICE:b:POST', 'RECEIPT:r:POST']);
  shadow.advanceClock(120_000);
  assert.deepEqual(shadow.listDue({ ...live, now: shadow.now() }).map((e) => e.sourceKey), ['INVOICE:a:POST', 'INVOICE:b:POST', 'RECEIPT:r:POST']);
  assert.equal(shadow.countPending(), 4);
  assert.equal(shadow.hasRetryable(), true);
  // إدراج داخل معاملة (شقيق POST) يدخل الطابور في موضعه، والتراجع يُسقطه
  shadow.begin();
  shadow.insertDesired([ev('INVOICE:0:POST', 'INVOICE', '2027-01-20T00:00:00Z')]);
  assert.equal(shadow.listDue({ ...live, now: shadow.now() })[0].sourceKey, 'INVOICE:0:POST');
  shadow.rollback();
  assert.equal(shadow.listDue({ ...live, now: shadow.now() })[0].sourceKey, 'INVOICE:a:POST');
});

// ═══ التكامل: العلاقات المتداخلة وأسماء الموردين والبصمة بعد حذف المندوب ═══

test('العميل الحارس: علاقةٌ متداخلة بجدول دفاتر في وسائط مندوبٍ تشغيلي مرفوضة قبل القاعدة، وأسماء الموردين وحدها تمرّ بشكلها', async () => {
  const db = fakeDb();
  seedBasics(db);
  db.seed('glVendor', [{ id: 'v1', tenantId: TID, name: 'مورّد الأسمنت' }, { id: 'v9', tenantId: 'other', name: 'مورّد غريب' }]);
  db.seed('supplierLedgerEntry', [
    { id: 'sl-1', tenantId: TID, vendorId: 'v1', kind: 'BILL', amountMilli: 1_000n, docDate: at('2027-02-01T00:00:00Z'), createdAt: at('2027-02-01T08:00:00Z') },
  ]);
  await inSnapshot(db, async (tx) => {
    const { shadow } = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
    const client = createShadowClient(tx, shadow);
    // الشكل الوحيد لقراءة gl_vendors: أسماءٌ بمعرّفاتها للشركة نفسها
    assert.deepEqual(await client.glVendor.findMany({ where: { tenantId: TID, id: { in: ['v1', 'v9'] } }, select: { id: true, name: true } }),
      [{ id: 'v1', name: 'مورّد الأسمنت' }]);
    // والتشغيلي بلا علاقة دفاتر يمرّ كما هو
    assert.deepEqual(await client.supplierLedgerEntry.findMany({ where: { tenantId: TID }, select: { vendorId: true } }), [{ vendorId: 'v1' }]);
    const readsBefore = db.readCount();
    const denied: [string, () => Promise<unknown>][] = [
      ['supplierLedgerEntry.findMany(select.vendor)', () => client.supplierLedgerEntry.findMany({ where: { tenantId: TID }, select: { vendorId: true, vendor: { select: { name: true } } } })],
      ['warehouseEntry.findMany(where.vendor)', () => client.warehouseEntry.findMany({ where: { tenantId: TID, vendor: { is: { name: 'x' } } } })],
      ['warehouseEntryItem.findMany(include.entry.include.vendor)', () => client.warehouseEntryItem.findMany({ where: { tenantId: TID } as never, include: { entry: { include: { vendor: true } } } })],
      ['tenant.findUnique(include.glSettings)', () => client.tenant.findUnique({ where: { id: TID }, include: { glSettings: true } })],
      ['tenant.findUnique(select._count.select.glMoves)', () => client.tenant.findUnique({ where: { id: TID }, select: { _count: { select: { glMoves: true } } } })],
      ['glVendor.findMany(where|select)', () => client.glVendor.findMany({ where: { tenantId: 'other', id: { in: ['v9'] } }, select: { id: true, name: true } })],
      ['glVendor.findMany(where|select)', () => client.glVendor.findMany({ where: { tenantId: TID }, select: { id: true, name: true } })],
      ['glVendor.findMany(where|select)', () => client.glVendor.findMany({ where: { tenantId: TID, id: { in: ['v1'] } }, select: { id: true, iban: true } })],
      ['glVendor.findMany(where|select)', () => client.glVendor.findMany({ where: { tenantId: TID, id: { in: ['v1'] } }, include: { tenant: true } } as never)],
      ['glVendor.findFirst', () => client.glVendor.findFirst({ where: { tenantId: TID } })],
    ];
    for (const [name, call] of denied) {
      await assert.rejects(call(), (e: unknown) => e instanceof ShadowGlAccessError && e.access === name, name);
    }
    assert.equal(shadow.glViolations.length, denied.length);
    assert.equal(db.readCount(), readsBefore, 'المرفوض لا يصل القاعدة');
  });
  assert.equal(db.writeCount(), 0);
});

test('العميل الحارس: كل علاقةٍ من نموذج تشغيلي إلى نموذج Gl* في المخطط يلتقطها الفحص المتداخل، ولا حقل تشغيلي آخر بأسمائها', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));
  const names = new Set(models.map((m) => m.name));
  const toGl: string[] = [];
  for (const m of models) {
    if (m.name.startsWith('Gl')) continue;
    for (const line of m.body.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t.length < 2 || !t[0] || t[0].startsWith('//') || t[0].startsWith('@@')) continue;
      const type = t[1].replace(/[[\]?]/g, '');
      const caught = GL_DELEGATE_RE.test(t[0]) || GL_RELATION_FIELD_NAMES.has(t[0]);
      if (type.startsWith('Gl') && names.has(type)) {
        toGl.push(`${m.name}.${t[0]}`);
        assert.ok(caught, `${m.name}.${t[0]} ⇒ ${type}: علاقة دفاتر لا يلتقطها glRelationPath — أضفها إلى GL_RELATION_FIELD_NAMES`);
      } else {
        assert.ok(!caught, `${m.name}.${t[0]} (${t[1]}) ليس علاقة دفاتر ويحمل اسماً يرفضه الحارس`);
      }
    }
  }
  for (const k of ['WarehouseEntry.vendor', 'SupplierLedgerEntry.vendor', 'SupplierPayment.vendor', 'Tenant.glSettings']) assert.ok(toGl.includes(k), k);
  assert.equal(glRelationPath({ where: { id: { in: ['glX', 'vendor'] } }, select: { payload: true } }), null, 'القيم لا تُفحص');
  assert.equal(glRelationPath({ where: { createdAt: new Date(0) } }), null);
});

test('loadPreCutoverSourceStats: استلامات مندوبٍ قائم وحدها كالأستاذ — حذف المندوب يغيّر البصمة', async () => {
  const db = fakeDb();
  const f = seedBasics(db);
  const st = f.settlement({ repId: f.rep('م'), amount: 10, at: at('2026-10-01T00:00:00Z') });
  f.settlement({ repId: f.rep('ن'), amount: 4, at: at('2026-10-02T00:00:00Z') });
  // استلام مندوبٍ محذوف قبلها (salesRepId = null) لا يُعدّ
  db.seed('repSettlement', [{ id: 'gone-st', tenantId: TID, salesRepId: null, deletedSalesRepId: 'gone', amount: 99, method: 'CASH', settledAt: at('2026-09-01T00:00:00Z'), createdAt: at('2026-09-01T00:00:00Z') }]);
  const read = () => inSnapshot(db, (tx) => loadPreCutoverSourceStats(tx, TID, CUTOVER_START, 2));
  const s1 = await read();
  assert.equal(s1.rep_settlements.count, 2);
  assert.equal(s1.rep_settlements.sumMilli, '14000');
  db.patch('repSettlement', st, { salesRepId: null, deletedSalesRepId: 'm-deleted' });
  const s2 = await read();
  assert.equal(s2.rep_settlements.count, 1);
  assert.notEqual(canonicalJson(s2), canonicalJson(s1));
  assert.equal(db.writeCount(), 0);
});
