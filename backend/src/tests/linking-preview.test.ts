// «ربط الدفاتر» L2 (P1) — المعاينة runPreview: المراحل والتقدّم، والحتمية (dataHash/resultHash)، وحساسية dataHash لصفّ قبل
// البدء لا بعده، وصفر كتابات، والفشل المغلق SHADOW_GL_ACCESS ولو ابتُلع الخطأ، وALREADY_ACTIVATED وTOO_LARGE، وقصّ القوائم،
// والمحجوز و911001، وجولات إعادة المُرحِّل بالساعة الافتراضية — بـPreviewDeps مزيّفة أولاً، ثم بالوحدات الحقيقية كلها
// (C1/C2/P2/P3/P4) تكاملاً: R1 وR2 وR3 وR5 = OK على سيناريو السنة الكامل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CostingSummary } from '../services/costing/types';
import { computeDerivedOpening, type OpeningSources } from '../services/gl/opening';
import { toJsonMilli } from '../services/gl/reports/incomeStatement';
import {
  PREVIEW_LIST_CAPS, PREVIEW_PHASE_PCT, PREVIEW_RESULT_MAX_BYTES,
  type OperationalFacts, type ParityCheck, type PreviewDeps, type PreviewPhase, type PreviewResult,
} from '../services/gl/linking/types';
import { ShadowGlAccessError } from '../services/gl/linking/shadowClient';
import { FIX_DB_NOW, FIX_T0, FakeDb, buildLinkingScenario, previewOptionsFor, type LinkingScenario } from './linking-fake-db';

const TID = 't1';
const at = (iso: string) => new Date(iso);
const LINKING = path.join(__dirname, '..', 'services', 'gl', 'linking');
const COSTING = path.join(__dirname, '..', 'services', 'costing');
const DEPS_FILES = [
  path.join(LINKING, 'parity.ts'), path.join(LINKING, 'preflight.ts'), path.join(LINKING, 'openingLinked.ts'),
  path.join(COSTING, 'streams.ts'), path.join(COSTING, 'stepper.ts'), path.join(COSTING, 'summary.ts'),
];
const MISSING = DEPS_FILES.filter((f) => !fs.existsSync(f)).map((f) => path.basename(f));
/** preview.ts يستورد الوحدات الحقيقية لـdefaultPreviewDeps — لا يُحمَّل قبل اكتمالها */
const SKIP = MISSING.length ? `بانتظار ${MISSING.join('، ')}` : false;

async function previewModule() {
  return import('../services/gl/linking/preview');
}

// ═══ اعتماديات مزيّفة (P1 وحده) ═══

const EMPTY_SUMMARY: CostingSummary = {
  moveCount: 0, productCount: 0, openingByLocation: [{ location: 'WH', qtyBase: 10, uncostedQty: 0, valueMilli: 50_000n }], nowByLocation: [],
  fyCogsMilli: 0n, fyVarianceMilli: 0n, fyWriteOffMilli: 0n, uncostedAtCutover: [], uncostedAtCutoverTotalQty: 0, negativeAtCutover: [],
  holesFy: { count: 0, varianceMilli: 0n, sample: [] }, warnings: [],
};

const EMPTY_OPS: OperationalFacts = {
  arByCustomer: new Map(), arOpeningByCustomer: new Map(), custodyByRep: new Map(), settlementBalanceMilli: 0n, supplierByVendor: new Map(),
  unclassifiedPricedReceiptsFyMilli: 0n, names: { customers: new Map(), reps: new Map(), vendors: new Map() },
};

/** افتتاح مشتقّ مزيّف: ذمم لعملاء معطاة بلا قراءة */
function derivedFor(cut: Parameters<PreviewDeps['loadLinkedOpening']>[2]['cut'], receivables: { customerId: string; milli: bigint }[]) {
  const src: OpeningSources = { accountEntries: [], receipts: [], cashInvoices: [], settlements: [], settlementEntries: [] };
  const base = computeDerivedOpening(src, cut, { decimals: 2, routing: { receiptRouting: null, cashInvoiceRouting: 'MAIN_CASH' } });
  return {
    ...base,
    receivables: receivables.map((r) => ({ customerId: r.customerId, customerName: `عميل ${r.customerId}`, balanceMilli: r.milli, rows: 1 })),
    receivablesTotalMilli: receivables.reduce((a, r) => a + r.milli, 0n),
  };
}

interface FakeDepsLog { calls: string[]; parityCtx: unknown[] }

function fakeDeps(over: Partial<PreviewDeps> = {}, receivables: { customerId: string; milli: bigint }[] = []): PreviewDeps & FakeDepsLog {
  const calls: string[] = [];
  const parityCtx: unknown[] = [];
  return {
    calls,
    parityCtx,
    async loadMoves() {
      calls.push('loadMoves');
      return { moves: [], cursor: null, truncated: false, sourceRows: { WH_ENTRY: 0, VAN_LOAD: 0, INVOICE: 0, RESTOCK_LOG: 0 }, warnings: [] };
    },
    replay(_m, _c, o) {
      calls.push(`replay:${o?.captureAt?.map((d) => d.toISOString()).join()}`);
      const st = { locs: new Map(), movesFolded: 0, cursor: null };
      return { state: st, outputs: [], captured: [st] };
    },
    summarizeCosting(_o, _s, o) { calls.push(`summarize:${o.cutoverDate}:${o.openingSnapshotAt.toISOString()}`); return EMPTY_SUMMARY; },
    async loadLinkedOpening(_db, _t, input) {
      calls.push(`opening:${input.inventory ? 'PERPETUAL' : 'PERIODIC'}`);
      return { derived: { opening: derivedFor(input.cut, receivables), inventory: input.inventory, salesRepNames: {} }, settlementSplits: {} };
    },
    async runPreflight(_db, _t, input) {
      calls.push(`preflight:${input.mode}:${input.eventStats?.eventsToPost}`);
      return { mode: input.mode, linkedFrom: input.linkedFrom, basis: input.basis, checks: [], blocking: 0, warnings: 0 };
    },
    async loadOperationalFacts() { calls.push('ops'); return EMPTY_OPS; },
    runParity(gl, _ops, ctx): ParityCheck[] {
      calls.push('parity');
      parityCtx.push(ctx);
      const unbalanced = gl.unbalancedMoves();
      const t = gl.grandTotals();
      return [{
        code: 'R1', titleAr: 'توازن', status: unbalanced.length === 0 && t.debitMilli === t.creditMilli ? 'OK' : 'MISMATCH', scope: 'FULL',
        expectedMilli: t.debitMilli, actualMilli: t.creditMilli, diffMilli: t.debitMilli - t.creditMilli, drill: [], drillTruncated: 0,
      }];
    },
    ...over,
  };
}

function scenario(): LinkingScenario {
  return buildLinkingScenario(new FakeDb({ now: () => FIX_DB_NOW }));
}

// ═══ الاختبارات بالاعتماديات المزيّفة ═══

test('المراحل بترتيبها ونسبها، والتقدّم داخل POST بين 40 و85، والتوقيتات، وحقول النتيجة الأساسية', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  const deps = fakeDeps();
  const seen: [PreviewPhase, number][] = [];
  let t = 0;
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor(), { onProgress: (p, pct) => { seen.push([p, pct]); }, clock: () => (t += 1500) }, deps);
  const phases = seen.map(([p]) => p).filter((p, i, a) => i === 0 || a[i - 1] !== p);
  assert.deepEqual(phases, ['READ', 'COSTING', 'OPENING', 'RECONCILE', 'POST', 'PARITY', 'PREFLIGHT', 'DONE']);
  for (const [p, pct] of seen) {
    if (p === 'POST') assert.ok(pct >= 40 && pct <= 85, `POST ${pct}`);
    else assert.equal(pct, PREVIEW_PHASE_PCT[p]);
  }
  assert.ok(seen.filter(([p]) => p === 'POST').length > 1, 'نبض داخل POST');
  const pcts = seen.map(([, pct]) => pct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), 'التقدّم لا يتراجع');
  assert.deepEqual(r.timings.map((x) => x.phase), ['READ', 'COSTING', 'OPENING', 'RECONCILE', 'POST', 'PARITY', 'PREFLIGHT']);
  assert.equal(r.version, 1);
  assert.equal(r.linkedFrom, '2027-01-01');
  assert.equal(r.openingDate, '2026-12-31');
  assert.equal(r.snapshotAt, FIX_T0.toISOString());
  assert.equal(r.dbNow, FIX_DB_NOW.toISOString());
  assert.equal(r.inventoryMode, 'PERPETUAL');
  assert.deepEqual(deps.calls.slice(0, 4), ['loadMoves', 'replay:2026-12-31T21:00:00.000Z', `summarize:2027-01-01:${FIX_T0.toISOString()}`, 'opening:PERPETUAL']);
  assert.ok(deps.calls.some((c) => /^preflight:FULL:\d+$/.test(c) && Number(c.split(':')[2]) > 0));
  assert.equal(r.parity[0].status, 'OK');
  assert.equal(r.trialBalanceByMonth.totals.debitMilli, r.trialBalanceByMonth.totals.creditMilli);
  assert.equal(r.balanceSheet.balanced, true);
  // سياق المطابقة: فرق 319002 والمحجوز لكل شريك
  const pc = deps.parityCtx[0] as { openingEquityDiffMilli: bigint; heldByPartner: Map<string, string[]>; linkedFrom: string };
  assert.equal(pc.linkedFrom, '2027-01-01');
  assert.equal(typeof pc.openingEquityDiffMilli, 'bigint');
  // JSON بلا BigInt وتحت سقف الحجم
  const json = JSON.stringify(toJsonMilli(r));
  assert.ok(json.length < PREVIEW_RESULT_MAX_BYTES);
});

test('نبض النشاط: قراءات المراحل الطويلة تنبض كل ACTIVITY_BEAT_MS بنسبة المرحلة (فلا تُعلَّم منقطعة)، وP2028 ⇒ TIMEOUT', { skip: SKIP }, async () => {
  const { runPreview, previewErrorCodeOf, ACTIVITY_BEAT_MS } = await previewModule();
  const s = scenario();
  const seen: [PreviewPhase, number][] = [];
  let t = 0;
  await runPreview(s.db.client as never, TID, previewOptionsFor(), {
    onProgress: async (p, pct) => { seen.push([p, pct]); },
    clock: () => (t += ACTIVITY_BEAT_MS),
  }, fakeDeps());
  // انتظار النبضات غير المنتظَرة
  await new Promise((r) => setImmediate(r));
  const reconcile = seen.filter(([p]) => p === 'RECONCILE');
  assert.ok(reconcile.length > 1, `RECONCILE ×${reconcile.length}`);
  assert.ok(reconcile.every(([, pct]) => pct === PREVIEW_PHASE_PCT.RECONCILE));
  assert.ok(seen.filter(([p]) => p === 'OPENING').length > 1);
  assert.equal(previewErrorCodeOf(Object.assign(new Error('Transaction already closed'), { code: 'P2028' })), 'TIMEOUT');
  assert.equal(previewErrorCodeOf(new Error('x')), 'INTERNAL');
});

test('الحتمية: تشغيلان على الفايك نفسه ⇒ dataHash وresultHash متطابقان؛ وصفّ قبل البدء يغيّر dataHash وصفّ بعده لا', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  const run = () => runPreview(s.db.client as never, TID, previewOptionsFor({ manualRows: [{ accountCode: '111001', debit: 500 }] }), {}, fakeDeps());
  const a = await run();
  const b = await run();
  assert.match(a.dataHash, /^[0-9a-f]{64}$/);
  assert.equal(b.dataHash, a.dataHash);
  assert.equal(b.resultHash, a.resultHash);
  // مستند في السنة (مبلغ سند 5 مارس: حمولة حدثه من السند نفسه)
  const inYear = s.db.rows('receipt').find((r) => (r.receiptDate as Date).toISOString().startsWith('2027-03-05'))!;
  s.db.patch('receipt', inYear.id as string, { amount: (inYear.amount as number) + 1 });
  const c = await run();
  assert.equal(c.dataHash, a.dataHash, 'نشاط السنة لا يغيّر dataHash');
  assert.notEqual(c.resultHash, a.resultHash, 'لكنه يغيّر النتيجة');
  // صفّ قبل البدء
  const pre = s.db.rows('accountEntry').find((r) => (r.entryDate as Date).getTime() < at('2026-12-20T00:00:00Z').getTime())!;
  s.db.patch('accountEntry', pre.id as string, { debit: (pre.debit as number) + 0.01 });
  const d = await run();
  assert.notEqual(d.dataHash, a.dataHash);
  // الأرصدة اليدوية جزء من dataHash
  const e = await runPreview(s.db.client as never, TID, previewOptionsFor({ manualRows: [{ accountCode: '111001', debit: 501 }] }), {}, fakeDeps());
  assert.notEqual(e.dataHash, d.dataHash);
});

test('صفر كتابات: لا create/update/delete ولا $executeRaw غير SET الأولى، ولا قراءة gl* من القاعدة إلا حارس التفعيل', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  await runPreview(s.db.client as never, TID, previewOptionsFor(), {}, fakeDeps());
  assert.equal(s.db.writeCount(), 0);
  assert.deepEqual(s.db.stats.writes, []);
  // العبارات الخام كلها: المُصدِّرة (SET ثم التحقّق ثم now ثم التصدير)، وكل معاملة دوّارة (SET ثم استيراد اللقطة ثم التحقّق)
  assert.match(s.db.stats.raw[0], /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
  const sets = s.db.stats.raw.filter((x) => /^SET TRANSACTION/.test(x));
  const imports = sets.filter((x) => /^SET TRANSACTION SNAPSHOT '/.test(x));
  assert.ok(imports.length >= 1);
  assert.equal(sets.length, 1 + 2 * imports.length);
  assert.ok(sets.every((x) => /^SET TRANSACTION (ISOLATION LEVEL REPEATABLE READ, READ ONLY|SNAPSHOT '[0-9A-F-]+')$/i.test(x)), JSON.stringify(sets.slice(0, 5)));
  assert.equal(s.db.stats.snapshotImports, imports.length);
  const glReads = [...s.db.stats.reads.entries()].filter(([k]) => k.startsWith('gl'));
  assert.deepEqual(glReads, [['glSettings.findUnique', 1]]);
});

test('SHADOW_GL_ACCESS: وصول gl* من اعتمادية يُفشل المعاينة ولو ابتلعت الخطأ (فشل مغلق، لا رقم كاذب)', { skip: SKIP }, async () => {
  const { runPreview, previewErrorCodeOf } = await previewModule();
  const s = scenario();
  const swallowing = fakeDeps({
    async loadOperationalFacts(db) {
      try { await db.glMoveLine.aggregate({ where: { tenantId: TID }, _sum: { debitMilli: true } }); } catch { /* ابتلاع */ }
      return EMPTY_OPS;
    },
  });
  await assert.rejects(runPreview(s.db.client as never, TID, previewOptionsFor(), {}, swallowing), (e: unknown) => {
    assert.ok(e instanceof ShadowGlAccessError);
    assert.equal(previewErrorCodeOf(e), 'SHADOW_GL_ACCESS');
    assert.match((e as ShadowGlAccessError).access, /^glMoveLine\.aggregate/);
    return true;
  });
  const direct = fakeDeps({ async loadMoves(db) { await db.glMove.findMany({ where: { tenantId: TID } } as never); throw new Error('unreachable'); } });
  await assert.rejects(runPreview(s.db.client as never, TID, previewOptionsFor(), {}, direct), ShadowGlAccessError);
  assert.equal(s.db.writeCount(), 0);
});

test('ALREADY_ACTIVATED: من خيارات المهمة قبل أي معاملة، ومن الصفّ الحقيقي داخل اللقطة', { skip: SKIP }, async () => {
  const { runPreview, previewErrorCodeOf, PreviewRunError } = await previewModule();
  const s = scenario();
  const activated = previewOptionsFor({ settingsRow: { activatedAt: at('2027-01-01T00:00:00Z'), setupMethod: 'CLEAN' } as never });
  await assert.rejects(runPreview(s.db.client as never, TID, activated, {}, fakeDeps()), (e: unknown) => e instanceof PreviewRunError && previewErrorCodeOf(e) === 'ALREADY_ACTIVATED');
  assert.equal(s.db.stats.transactions.length, 0);
  s.db.seed('glSettings', [{ tenantId: TID, templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, activatedAt: at('2027-02-01T00:00:00Z') }]);
  await assert.rejects(runPreview(s.db.client as never, TID, previewOptionsFor(), {}, fakeDeps()), (e: unknown) => previewErrorCodeOf(e) === 'ALREADY_ACTIVATED');
});

test('TOO_LARGE: أحداث الظلّ فوق limits.maxEvents', { skip: SKIP }, async () => {
  const { runPreview, previewErrorCodeOf } = await previewModule();
  const s = scenario();
  await assert.rejects(
    runPreview(s.db.client as never, TID, previewOptionsFor({ limits: { maxEvents: 5 } }), {}, fakeDeps()),
    (e: unknown) => previewErrorCodeOf(e) === 'TOO_LARGE' && /السقف|سقف/.test((e as Error).message),
  );
});

test('القصّ: القيد الافتتاحي عند 2000 سطر والمحجوز عند 500، مع العدّ المقصوص', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  // 520 صفاً غير متوقّع (فاتورة وسند معاً) ⇒ 520 حدث HELD
  s.db.seed('accountEntry', Array.from({ length: 520 }, (_, i) => ({
    id: `bad-${i}`, tenantId: TID, customerId: s.c1, invoiceId: `ghost-${i}`, receiptId: 'rcp-ghost', type: 'RECEIPT_CREDIT', credit: 1, balance: 0,
    description: '', entryDate: at('2027-05-01T08:00:00Z'), createdAt: new Date(at('2027-05-01T08:00:00Z').getTime() + i),
  })));
  const receivables = Array.from({ length: 2100 }, (_, i) => ({ customerId: `cx-${String(i).padStart(5, '0')}`, milli: 1000n + BigInt(i) * 10n }));
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor(), {}, fakeDeps({}, receivables));
  assert.equal(r.opening.lines.length, PREVIEW_LIST_CAPS.openingLines);
  // 2100 ذمة + مخزون المستودع (من الملخّص المزيّف) + 319002
  assert.equal(r.opening.linesTruncated, 2100 + 1 + 1 - PREVIEW_LIST_CAPS.openingLines);
  assert.equal(r.opening.totals.debitMilli, r.opening.totals.creditMilli);
  assert.equal(r.heldLines.length, PREVIEW_LIST_CAPS.heldLines);
  assert.equal(r.heldTruncated, 520 - PREVIEW_LIST_CAPS.heldLines);
  assert.ok(r.eventCounts.some((c) => c.status === 'HELD' && c.reason === 'UNEXPECTED_ENTRY_SHAPE' && c.count === 520));
});

test('المحجوز و911001 والتحذيرات: سند إلكتروني بلا رابط على المعلّق، وصفّ يدوي بحساب مجهول، وفئة بحساب مجهول', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  s.f.receipt({ customerId: s.c2, amount: 11, method: 'ONLINE', at: at('2027-05-02T08:00:00Z'), invoiceId: null });
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor({
    manualRows: [{ accountCode: '111001', debit: 500 }, { accountCode: '999999', debit: 1 }],
    categoryIncomeAccounts: [{ categoryId: 'k', accountCode: '888888' }],
  }), {}, fakeDeps());
  const susp = r.heldLines.filter((l) => l.kind === 'SUSPENSE_LINE');
  assert.equal(susp.length, 1);
  assert.equal(susp[0].amountMilli, 11_000n);
  assert.equal(susp[0].partnerId, s.c2);
  const codes = r.warnings.map((w) => w.code).sort();
  assert.ok(codes.includes('MANUAL_ROWS_INVALID'));
  assert.ok(codes.includes('CATEGORY_ACCOUNT_UNKNOWN'));
  assert.deepEqual(r.opening.manualIssues, [{ index: 1, accountCode: '999999', reason: 'ACCOUNT_NOT_FOUND' }]);
  const manual = r.opening.lines.filter((l) => l.origin === 'MANUAL');
  assert.deepEqual(manual.map((l) => [l.accountCode, l.debitMilli]), [['111001', 500_000n]]);
  assert.equal(r.opening.lines[r.opening.lines.length - 1].origin, 'EQUITY');
});

test('جولات المُرحِّل بالساعة الافتراضية: استلام في نافذة الالتزام المتأخر يُحجب SETTLEMENT_ORDER ثم يُرحَّل', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  const st = s.f.settlement({ repId: s.r1, amount: 5, at: at('2027-06-15T08:56:00Z') });
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor(), {}, fakeDeps());
  const settlements = r.eventCounts.filter((c) => c.sourceType === 'SETTLEMENT' && c.event === 'POST');
  assert.deepEqual(settlements.map((c) => c.status), ['DONE']);
  assert.equal(settlements[0].count, 2);
  assert.ok(!r.warnings.some((w) => w.code === 'POSTER_INCOMPLETE'), JSON.stringify(r.warnings));
  assert.ok(st);
});

test('PERIODIC: بلا سطور مخزون افتتاحية (inventory = null)', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  const deps = fakeDeps();
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor({ inventoryMode: 'PERIODIC' }), {}, deps);
  assert.ok(deps.calls.includes('opening:PERIODIC'));
  assert.equal(r.opening.lines.some((l) => l.partnerType === 'LOCATION'), false);
});

test('حلقة الأحداث: ذيل POST في الذاكرة يتخلّى دورياً (كل POST_YIELD_EVERY_TX معاملة) فلا يتجمّد ما يشارك العملية', { skip: SKIP }, async () => {
  const { runPreview, POST_YIELD_EVERY_TX } = await previewModule();
  const s = scenario();
  // ~1,600 حدثٍ في السنة (فواتير آجلة وسندات) — القاعدة المزيّفة وعودٌ محلولة كلها: لا تخلٍّ إلا ما تضيفه المعاينة
  for (let i = 0; i < 800; i++) {
    const t = new Date(at('2027-02-01T08:00:00Z').getTime() + i * 60_000);
    s.f.invoice({ type: 'CREDIT', customerId: s.c1, lines: [{ productId: s.p1, qty: 1, unitPrice: 10 }], at: t });
    s.f.receipt({ customerId: s.c1, amount: 5, at: new Date(t.getTime() + 1000) });
  }
  let ticks = 0;
  let on = true;
  const spin = () => { if (!on) return; ticks++; setImmediate(spin); };
  setImmediate(spin);
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor(), {}, fakeDeps());
  on = false;
  assert.ok(r.eta.eventsToPost >= 1_600, String(r.eta.eventsToPost));
  assert.ok(ticks >= Math.floor(1_600 / POST_YIELD_EVERY_TX), `ticks ${ticks}`);
});

test('PERIODIC: المخزون الافتتاحي اليدوي (114001/114002) يُقبل ويدخل القيد — لا يُشتقّ في الجرد الدوري فلا يُرفض DERIVED_ACCOUNT', { skip: SKIP }, async () => {
  const { runPreview } = await previewModule();
  const s = scenario();
  const manualRows = [{ accountCode: '114001', debit: 50_000 }, { accountCode: '111001', debit: 10_000 }];
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor({ inventoryMode: 'PERIODIC', manualRows }), {}, fakeDeps());
  // قبل الإصلاح: 114001 ⇒ DERIVED_ACCOUNT وMANUAL_ROWS_INVALID، فغاب المخزون من القيد وامتصّ 319002 الفرق كله
  assert.deepEqual(r.opening.manualIssues, []);
  assert.ok(!r.warnings.some((w) => w.code === 'MANUAL_ROWS_INVALID'), JSON.stringify(r.warnings));
  const manual = r.opening.lines.filter((l) => l.origin === 'MANUAL');
  assert.deepEqual(manual.map((l) => [l.accountCode, l.debitMilli]), [['114001', 50_000_000n], ['111001', 10_000_000n]]);
  assert.equal(r.opening.totals.debitMilli, r.opening.totals.creditMilli);
  // والميزانية تحمل المخزون الافتتاحي اليوم (الأصل لا يضيع)
  const inv = r.balanceSheet.lines.filter((l) => l.key.endsWith(':114001'));
  assert.deepEqual(inv.map((l) => l.amountMilli), [50_000_000n], JSON.stringify(toJsonMilli(inv)));

  // الجرد المستمر: المخزون مشتقّ من محرّك التكلفة ⇒ اليدوي مرفوض كما كان (لا عدّ مرتين)
  const p = await runPreview(s.db.client as never, TID, previewOptionsFor({ inventoryMode: 'PERPETUAL', manualRows }), {}, fakeDeps());
  assert.deepEqual(p.opening.manualIssues, [{ index: 0, accountCode: '114001', reason: 'DERIVED_ACCOUNT' }]);
});

// ═══ التكامل بالوحدات الحقيقية (C1، C2، P2، P3، P4) ═══

test('تكامل: R1 وR2 وR3 وR5 = OK على سيناريو السنة الكامل (آجل/نقدي/مرتجع، إلغاء ما قبل السنة، متأخر، مؤرّخ مستقبلاً، استرداد، استلام، رسوم وتوريد، استيراد بعد البدء)', { skip: SKIP }, async () => {
  const { runPreview, defaultPreviewDeps } = await previewModule();
  const s = scenario();
  const opts = previewOptionsFor({ manualRows: [{ accountCode: '111001', debit: 1000 }] });
  const r = await runPreview(s.db.client as never, TID, opts, {}, defaultPreviewDeps);
  const by = new Map(r.parity.map((p) => [p.code, p]));
  assert.equal(r.parity.length, 13);
  for (const code of ['R1', 'R2', 'R3', 'R5'] as const) {
    const p = by.get(code)!;
    assert.equal(p.status, 'OK', `${code}: ${JSON.stringify(toJsonMilli({ e: p.expectedMilli, a: p.actualMilli, d: p.diffMilli, drill: p.drill.slice(0, 5), info: p.info }))}`);
  }
  assert.equal(r.preflight.mode, 'FULL');
  assert.equal(r.costing.summary.moveCount > 0, true);
  // P13 والقسم «الوقت والتخزين» رقمٌ واحد (التخزين المقيس من الظلّ — إضافة التكامل)
  const p13 = r.preflight.checks.find((c) => c.code === 'P13')!;
  assert.ok(p13.details.includes(`⇒ ≈ ${r.storage.rows.total} صفاً`), p13.details);
  assert.equal(p13.count, r.eta.eventsToPost);
  // الافتتاح المشتقّ: ذمم كل عميل بما قبل البدء، والمخزون الافتتاحي من محرّك التكلفة، ومتوازن
  assert.ok(r.opening.lines.some((l) => l.origin === 'DERIVED' && l.accountCode === '113001'));
  assert.ok(r.opening.lines.some((l) => l.origin === 'DERIVED' && l.partnerType === 'LOCATION'));
  assert.equal(r.opening.totals.debitMilli, r.opening.totals.creditMilli);
  assert.equal(r.trialBalanceByMonth.totals.debitMilli, r.trialBalanceByMonth.totals.creditMilli);
  assert.equal(r.balanceSheet.balanced, true);
  assert.equal(s.db.writeCount(), 0);
  // الحتمية بالوحدات الحقيقية
  const again = await runPreview(s.db.client as never, TID, opts, {}, defaultPreviewDeps);
  assert.equal(again.dataHash, r.dataHash);
  assert.equal(again.resultHash, r.resultHash);
});
