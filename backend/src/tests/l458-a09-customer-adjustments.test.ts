// «ربط الدفاتر» L4 — A9: تسويات ذمم العملاء M4 (العقد §4.8، E4.13–E4.15، E8.1).
// صرفة بلا قاعدة: الـbuilder (متّزن، والتحقق SYSTEM يقبله، بالمنازل 0 و2 و3)، والتخصيص والمطابقة الجزئية (CA وFIFO وREV)، ومسارا
// الإنشاء والإلغاء كاملين بمعاملة مزيّفة تتراجع عند الخطأ: الصفّ والقيد والحدث معاً أو لا شيء، وR2 (113001 لكل عميل = Σ AccountEntry)
// بعد كل خطوة، وSKIPPED(NETTED) لصفّ العكس، والحارس 409 لليدوية، و422 قبل البداية — وحراس ثابتة على المسار.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCustomerAdjustmentMove, customerAdjustmentKey, refundCreditTarget, resolveAccountTarget, writeoffCounterAccount,
  type CustomerAdjustmentPayload,
} from '../services/gl/builders/customerAdjustment';
import {
  adjustmentCutover, cancelBodyOf, createAdjustmentSchema, entryInstantOf, executeCancelAdjustment, executeCreateAdjustment,
  listWhereOf, planAllocations,
  type AdjustmentDeps, type CreateAdjustmentBody, type LockedInvoice,
} from '../routes/ledger/customerAdjustments';
import { reconcileAfterPost } from '../services/gl/reconcile/apply';
import type { OpenControlLine, ReconcileKind, ReconcileStore } from '../services/gl/reconcile/types';
import { ledgerErrorResponse, LedgerHttpError } from '../routes/ledger/errors';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import type { GlDb, GlSettingsRow, LedgerContext } from '../services/gl/resolve';
import type { GlActor } from '../services/gl/audit';
import type { PostedMove } from '../services/gl/post';
import type { ReverseResult } from '../services/gl/reverse';
import { fromDbDate, toDbDate } from '../services/gl/dates';
import { toMilli } from '../services/gl/money';
import {
  createBuildContext, isLedgerError, isNoMove,
  type AccountRef, type BuildContext, type MoveDraft,
} from '../services/gl/types';

// ═══ السياق ═══

const RAJHI: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'بنك الراجحي', type: 'asset_cash', isActive: true, reconcile: true, controlKind: null };

interface CtxOpts { linked?: boolean; dec?: number; maps?: Record<string, string>; accounts?: Record<string, Partial<AccountRef> | null> }

function ledgerContext(o: CtxOpts = {}): LedgerContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: o.dec ?? 2, ...(o.linked === false ? {} : { linkedPosting: true as const }) },
    extraAccounts: [...linkedAccountRefs(accountIdOf), RAJHI],
    accounts: o.accounts,
  });
  const maps = o.maps
    ? Object.fromEntries(Object.entries(o.maps).map(([k, code]) => [k, { accountId: accountIdOf(code), journalId: null }]))
    : undefined;
  const ctx = createBuildContext({ ...input, ...(maps ? { paymentMethodMaps: maps } : {}) });
  const accounts = [...input.accounts];
  const taxes = [...(input.taxes ?? [])];
  const journals = [...(input.journals ?? [])];
  return {
    ctx, settings: {} as GlSettingsRow, accounts, taxes, journals,
    accountById: new Map(accounts.map((a) => [a.id, a])),
    taxById: new Map(taxes.map((t) => [t.id, t])),
    journalById: new Map(journals.map((j) => [j.id, j])),
  };
}
const ctxOf = (o: CtxOpts = {}): BuildContext => ledgerContext(o).ctx;
/** آخر عنصر (target المشروع قبل es2022 فلا Array.prototype.at) */
const last = <T>(xs: readonly T[]): T => xs[xs.length - 1];

/** {الرمز: [مدين، دائن]} بعد التحقق SYSTEM (كما يرحّله postMove) */
function sums(m: MoveDraft, ctx: BuildContext): Record<string, [bigint, bigint]> {
  const v = validateMove(m, ctx, { mode: 'SYSTEM' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'متّزن');
  const out: Record<string, [bigint, bigint]> = {};
  for (const l of m.lines) {
    assert.match(l.label, /[؀-ۿ]/, 'وصف عربي');
    const acc = resolveLineAccount(l, ctx.accounts)!;
    const cur = out[acc.code] ?? [0n, 0n];
    out[acc.code] = [cur[0] + l.debitMilli, cur[1] + l.creditMilli];
  }
  return out;
}

const payload = (p: Partial<CustomerAdjustmentPayload> = {}): CustomerAdjustmentPayload => ({
  adjustmentId: 'adj1', kind: 'BAD_DEBT_WRITEOFF', customerId: 'C', customerName: 'مؤسسة النور', amount: '300.00',
  counterAccountCode: '711005', method: null, docDate: '2026-11-14', reference: null, ...p,
});

// ═══ الـbuilder ═══

test('E4.13 شطب دين معدوم: Dr 711005 300 / Cr 113001 [C] 300 — CUSTOMER_ADJUSTMENT في MISC بمفتاح AR_ENTRY:<id>:POST', () => {
  const ctx = ctxOf();
  const m = buildCustomerAdjustmentMove(payload(), ctx);
  assert.ok(!isNoMove(m));
  assert.deepEqual(sums(m, ctx), { '711005': [300_000n, 0n], '113001': [0n, 300_000n] });
  assert.equal(m.moveType, 'CUSTOMER_ADJUSTMENT');
  assert.equal(m.journalSystemKey, 'MISC');
  assert.equal(m.origin, 'AUTO');
  assert.equal(m.sourceType, 'CUSTOMER_ADJUSTMENT');
  assert.equal(m.sourceId, 'adj1');
  assert.equal(m.sourceKey, 'AR_ENTRY:adj1:POST');
  assert.equal(m.sourceEvent, 'POST');
  assert.equal(m.date, '2026-11-14');
  const ar = m.lines.find((l) => l.accountKey === 'AR_CONTROL')!;
  assert.equal(ar.customerId, 'C');
  assert.equal(ar.partnerName, 'مؤسسة النور');
  assert.equal(ar.salesRepId, undefined);
  // بالمخصص: Dr 113009 300 / Cr 113001 300
  const allowance = buildCustomerAdjustmentMove(payload({ counterAccountCode: '113009' }), ctx);
  assert.ok(!isNoMove(allowance));
  assert.deepEqual(sums(allowance, ctx), { '113009': [300_000n, 0n], '113001': [0n, 300_000n] });
  assert.match(allowance.narration, /مخصص الديون المشكوك فيها/);
});

test('E4.14 ردّ رصيد دائن: نقداً Cr 111001، وتحويلاً وشيكاً Cr 111101 (OD14) — CUSTOMER_REFUND في RCPT', () => {
  const ctx = ctxOf();
  for (const [method, code] of [['CASH', '111001'], ['BANK_TRANSFER', '111101'], ['CHEQUE', '111101']] as const) {
    const acc = resolveAccountTarget(refundCreditTarget(method, ctx), ctx)!;
    assert.equal(acc.code, code, method);
    const m = buildCustomerAdjustmentMove(payload({ kind: 'CREDIT_REFUND', amount: '200.00', method, counterAccountCode: acc.code }), ctx);
    assert.ok(!isNoMove(m));
    assert.deepEqual(sums(m, ctx), { '113001': [200_000n, 0n], [code]: [0n, 200_000n] }, method);
    assert.equal(m.moveType, 'CUSTOMER_REFUND');
    assert.equal(m.journalSystemKey, 'RECEIPTS');
    const ar = m.lines.find((l) => l.accountKey === 'AR_CONTROL')!;
    assert.equal(ar.dueDate, '2026-11-14', 'الردّ يستحق يوم دفعه');
  }
  // خريطة الطرق: التحويل مربوط بـ111102 ⇒ الحلّ يتبعها (D3)، والرمز المخزَّن يحكم إعادة البناء ولو تغيّرت الخريطة بعدها
  const mapped = ctxOf({ maps: { BANK_TRANSFER: '111102' } });
  assert.equal(resolveAccountTarget(refundCreditTarget('BANK_TRANSFER', mapped), mapped)!.code, '111102');
  const frozen = buildCustomerAdjustmentMove(payload({ kind: 'CREDIT_REFUND', amount: '200', method: 'BANK_TRANSFER', counterAccountCode: '111102' }), ctxOf());
  assert.ok(!isNoMove(frozen));
  assert.deepEqual(sums(frozen, ctxOf()), { '113001': [200_000n, 0n], '111102': [0n, 200_000n] });
  // بلا رمز مخزَّن: الحلّ الحالي من الطريقة
  const live = buildCustomerAdjustmentMove(payload({ kind: 'CREDIT_REFUND', amount: '200', method: 'CASH', counterAccountCode: '' }), ctx);
  assert.ok(!isNoMove(live));
  assert.deepEqual(sums(live, ctx), { '113001': [200_000n, 0n], '111001': [0n, 200_000n] });
});

test('المنازل 0 و2 و3: المبلغ بالملّي حرفاً، ومبلغ صفري NO_MOVE، والحمولة الناقصة RangeError', () => {
  for (const [dec, amount, milli] of [[0, '3000', 3_000_000n], [2, '0.01', 10n], [3, '1.099', 1_099n]] as const) {
    const ctx = ctxOf({ dec });
    const m = buildCustomerAdjustmentMove(payload({ amount }), ctx);
    assert.ok(!isNoMove(m));
    assert.deepEqual(sums(m, ctx), { '711005': [milli, 0n], '113001': [0n, milli] }, `dec ${dec}`);
    assert.equal(m.currencyDecimals, dec);
  }
  const zero = buildCustomerAdjustmentMove(payload({ amount: '0' }), ctxOf());
  assert.ok(isNoMove(zero) && zero.reason === 'ZERO_VALUE');
  assert.throws(() => buildCustomerAdjustmentMove(payload({ counterAccountCode: '' }), ctxOf()), RangeError);
  assert.throws(() => buildCustomerAdjustmentMove(payload({ kind: 'CREDIT_REFUND', method: 'POS' }), ctxOf()), RangeError);
  assert.throws(() => buildCustomerAdjustmentMove(payload({ docDate: '2026-13-01' }), ctxOf()), RangeError);
});

test('مقابل الشطب بمفتاح الربط أولاً ثم الرمز الافتراضي', () => {
  const ctx = ctxOf();
  assert.equal(writeoffCounterAccount('BAD_DEBT', ctx)!.code, '711005');
  assert.equal(writeoffCounterAccount('ALLOWANCE', ctx)!.code, '113009');
  assert.equal(writeoffCounterAccount('BAD_DEBT', ctxOf({ accounts: { '711005': null } })), null);
});

// ═══ التخصيص (صرف) ═══

const inv = (p: Partial<LockedInvoice> & { id: string }): LockedInvoice => ({
  number: `INV-${p.id}`, customerId: 'C', status: 'CONFIRMED', type: 'CREDIT', remainingAmt: 100, einvoiceStatus: null,
  invoiceDate: new Date('2026-10-01T09:00:00Z'), ...p,
});

function rejectsWith(fn: () => unknown, code: string, reason: string) {
  assert.throws(fn, (e: unknown) => e instanceof LedgerHttpError && e.code === code && e.details.reason === reason);
}

test('التخصيص الصريح: المكرّر يُجمع، وΣ = المبلغ حرفاً، وكل خطأ 422 LEDGER_ADJUSTMENT_ALLOCATION_INVALID بسببه', () => {
  let n = 0;
  const newId = () => `al${++n}`;
  const invoices = [inv({ id: 'a', remainingAmt: 300 }), inv({ id: 'b', remainingAmt: 50.5 })];
  const base = { autoAllocate: false, amountMilli: 350_500n, decimals: 2, customerId: 'C', invoices, newId };
  const out = planAllocations({ ...base, requested: [{ invoiceId: 'a', amountMilli: 100_000n }, { invoiceId: 'b', amountMilli: 50_500n }, { invoiceId: 'a', amountMilli: 200_000n }] });
  assert.deepEqual(out, [{ id: 'al1', invoiceId: 'a', amountMilli: 300_000n }, { id: 'al2', invoiceId: 'b', amountMilli: 50_500n }]);
  const code = 'LEDGER_ADJUSTMENT_ALLOCATION_INVALID';
  rejectsWith(() => planAllocations({ ...base, requested: [{ invoiceId: 'a', amountMilli: 350_500n }] }), code, 'EXCEEDS_REMAINING');
  rejectsWith(() => planAllocations({ ...base, requested: [{ invoiceId: 'a', amountMilli: 300_000n }] }), code, 'SUM_MISMATCH');
  rejectsWith(() => planAllocations({ ...base, requested: [{ invoiceId: 'zz', amountMilli: 350_500n }] }), code, 'INVOICE_NOT_FOUND');
  rejectsWith(() => planAllocations({ ...base, requested: [{ invoiceId: 'a', amountMilli: 1n }] }), code, 'PRECISION');
  rejectsWith(() => planAllocations({ ...base, requested: [{ invoiceId: 'a', amountMilli: 0n }] }), code, 'AMOUNT_NOT_POSITIVE');
  for (const [p, reason] of [
    [{ customerId: 'OTHER' }, 'OTHER_CUSTOMER'], [{ status: 'CANCELLED' }, 'NOT_CONFIRMED'], [{ type: 'CASH' }, 'NOT_CREDIT'],
    [{ einvoiceStatus: 'clearance_pending' }, 'ZATCA_PENDING'],
  ] as const) {
    rejectsWith(() => planAllocations({ ...base, amountMilli: 100_000n, invoices: [inv({ id: 'x', ...p })], requested: [{ invoiceId: 'x', amountMilli: 100_000n }] }), code, reason);
  }
  rejectsWith(() => planAllocations({ ...base, requested: null }), code, 'ALLOCATIONS_REQUIRED');
});

test('التخصيص التلقائي بالأقدم فالأقدم (تاريخ الفاتورة ثم المعرّف)، والمتبقّي مقرَّب لكل مستند، والناقص AUTO_INSUFFICIENT', () => {
  const invoices = [
    inv({ id: 'new', remainingAmt: 500, invoiceDate: new Date('2026-11-01T09:00:00Z') }),
    inv({ id: 'old', remainingAmt: 120.004, invoiceDate: new Date('2026-09-01T09:00:00Z') }),
    inv({ id: 'mid', remainingAmt: 80, invoiceDate: new Date('2026-10-01T09:00:00Z') }),
    inv({ id: 'gone', remainingAmt: 0.001, invoiceDate: new Date('2026-08-01T09:00:00Z') }),
  ];
  let n = 0;
  const out = planAllocations({ requested: null, autoAllocate: true, amountMilli: 250_000n, decimals: 2, customerId: 'C', invoices, newId: () => `al${++n}` });
  assert.deepEqual(out.map((a) => [a.invoiceId, a.amountMilli]), [['old', 120_000n], ['mid', 80_000n], ['new', 50_000n]]);
  rejectsWith(() => planAllocations({ requested: null, autoAllocate: true, amountMilli: 700_006n, decimals: 3, customerId: 'C', invoices }),
    'LEDGER_ADJUSTMENT_ALLOCATION_INVALID', 'AUTO_INSUFFICIENT');
});

// ═══ المعاملة المزيّفة ═══

const NOW = new Date('2026-11-14T09:00:00Z'); // 12:00 بتوقيت الرياض
const ACTOR: GlActor = { actorType: 'ADMIN', actorId: 'admin-1', actorName: 'المحاسب', impersonated: false };
const AR = accountIdOf('113001');

interface FMove { id: string; number: string; date: string; sourceType: string | null; sourceId: string | null; reversedMoveId: string | null; lines: FLine[] }
interface FLine { id: string; moveId: string; seq: number; accountId: string; debitMilli: bigint; creditMilli: bigint; customerId: string | null; dueDate: string | null; date: string }
interface FEntry { id: string; tenantId: string; customerId: string; type: string; debit: number; credit: number; balance: number; description: string; entryDate: Date; createdAt: Date }
interface FPartial { id: string; tenantId: string; debitLineId: string; creditLineId: string; debitMoveId: string; creditMoveId: string; amountMilli: bigint; sourceRef: string; createdBy: string }
interface FState {
  settings: { setupMethod: string | null; activatedAt: Date | null; linkedFrom: Date | null; cutoverDate: Date | null; timezone: string; currencyDecimals: number };
  customers: Record<string, { id: string; tenantId: string; name: string; balance: number }>;
  entries: FEntry[];
  invoices: Record<string, LockedInvoice & { tenantId: string }>;
  adjustments: Record<string, Record<string, unknown> & { allocations: { id: string; invoiceId: string; amount: number }[] }>;
  events: Record<string, unknown>[];
  partials: FPartial[];
  moves: FMove[];
  audits: { action: string; entityId?: string | null }[];
}

interface HarnessOpts { mode?: 'LINKED' | 'LEGACY' | 'MANUAL' | 'NONE'; dec?: number; failPost?: boolean; accounts?: Record<string, Partial<AccountRef> | null> }

function harness(o: HarnessOpts = {}) {
  const mode = o.mode ?? 'LINKED';
  const dec = o.dec ?? 2;
  let state: FState = {
    settings: {
      setupMethod: mode === 'MANUAL' ? 'CLEAN' : mode === 'LEGACY' ? 'OPENING' : 'LINKED',
      activatedAt: mode === 'NONE' ? null : new Date('2026-01-01T00:00:00Z'),
      linkedFrom: mode === 'LINKED' ? toDbDate('2026-01-01') : null,
      cutoverDate: toDbDate(mode === 'LEGACY' ? '2026-03-01' : '2026-01-01'),
      timezone: 'Asia/Riyadh', currencyDecimals: dec,
    },
    customers: {
      C: { id: 'C', tenantId: 't1', name: 'مؤسسة النور', balance: 0 },
      D: { id: 'D', tenantId: 't1', name: 'متجر الندى', balance: 0 },
    },
    entries: [], invoices: {}, adjustments: {}, events: [], partials: [], moves: [], audits: [],
  };
  const lc = ledgerContext({ linked: mode === 'LINKED', dec, accounts: o.accounts });
  let seq = 0;
  const newId = (p: string) => `${p}${++seq}`;
  const log: string[] = [];

  /** المتبقّي = المبلغ − Σ المطابقات التي تمسّه من الجهتين (تعريف L8) */
  const residualOf = (l: FLine): bigint => (l.debitMilli > 0n ? l.debitMilli : l.creditMilli)
    - state.partials.filter((p) => p.debitLineId === l.id || p.creditLineId === l.id).reduce((s, p) => s + p.amountMilli, 0n);
  const kindOf = (accountId: string): ReconcileKind | null => {
    const k = lc.accountById.get(accountId)?.controlKind;
    return k === 'AR' || k === 'AP' ? k : null;
  };
  const openLine = (l: FLine, kind: ReconcileKind): OpenControlLine => ({
    lineId: l.id, moveId: l.moveId, accountId: l.accountId, kind, partnerId: l.customerId ?? '', side: l.debitMilli > 0n ? 'DEBIT' : 'CREDIT',
    amountMilli: l.debitMilli > 0n ? l.debitMilli : l.creditMilli, residualMilli: residualOf(l), date: l.date, dueDate: l.dueDate, seq: l.seq,
  });
  const reversedIds = () => new Set(state.moves.filter((m) => m.reversedMoveId).map((m) => m.reversedMoveId!));
  const store: ReconcileStore = {
    controlLinesOfMove: async (moveId, kind) => (state.moves.find((m) => m.id === moveId)?.lines ?? [])
      .filter((l) => kindOf(l.accountId) === kind && l.customerId).map((l) => openLine(l, kind)),
    liveMoveIdOf: async (baseKey) => {
      const [type, id] = baseKey.split(':');
      const rev = reversedIds();
      return state.moves.find((m) => m.sourceType === type && m.sourceId === id && !m.reversedMoveId && !rev.has(m.id))?.id ?? null;
    },
    pendingAllocationsForInvoice: async () => [],
    partialsOfMoves: async (ids) => state.partials.filter((p) => ids.includes(p.debitMoveId) || ids.includes(p.creditMoveId))
      .map((p) => ({ id: p.id, debitLineId: p.debitLineId, creditLineId: p.creditLineId, amountMilli: p.amountMilli, sourceRef: p.sourceRef })),
    insertPartials: async (rows) => {
      let n = 0;
      for (const r of rows) {
        if (state.partials.some((x) => x.sourceRef === r.sourceRef && x.debitLineId === r.debitLineId && x.creditLineId === r.creditLineId)) continue;
        state.partials.push({ ...r, id: newId('pr'), tenantId: 't1', createdBy: 'SYSTEM' });
        n++;
      }
      return n;
    },
    deletePartials: async (ids) => {
      const before = state.partials.length;
      state.partials = state.partials.filter((p) => !ids.includes(p.id));
      return before - state.partials.length;
    },
    openLinesOfPartner: async (kind, partnerId, side) => state.moves.flatMap((m) => m.lines)
      .filter((l) => kindOf(l.accountId) === kind && l.customerId === partnerId && (side === 'DEBIT' ? l.debitMilli > 0n : l.creditMilli > 0n) && residualOf(l) > 0n)
      .map((l) => openLine(l, kind)).sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : 0)),
  };

  function postDraft(draft: MoveDraft, reversedMoveId: string | null = null): FMove {
    const id = newId('mv');
    const m: FMove = {
      id, number: `${draft.journalCode}/2026/${String(seq).padStart(5, '0')}`, date: draft.date,
      sourceType: draft.sourceType ?? null, sourceId: draft.sourceId ?? null, reversedMoveId, lines: [],
    };
    draft.lines.forEach((l, i) => {
      const acc = resolveLineAccount(l, lc.ctx.accounts)!;
      m.lines.push({
        id: `${id}:${i}`, moveId: id, seq: i, accountId: acc.id, debitMilli: l.debitMilli, creditMilli: l.creditMilli,
        customerId: l.customerId ?? null, dueDate: l.dueDate ?? null, date: draft.date,
      });
    });
    state.moves.push(m);
    return m;
  }

  const tx = {
    glSettings: { findUnique: async () => ({ ...state.settings }) },
    customer: {
      findFirst: async (a: { where: { id: string; tenantId: string } }) => {
        const c = state.customers[a.where.id];
        return c && c.tenantId === a.where.tenantId ? { id: c.id, name: c.name } : null;
      },
      update: async (a: { where: { id: string }; data: { balance: number } }) => { state.customers[a.where.id].balance = a.data.balance; return {}; },
    },
    accountEntry: {
      create: async (a: { data: Omit<FEntry, 'id' | 'createdAt'> }) => {
        const e: FEntry = { ...a.data, id: newId('ae'), createdAt: NOW };
        state.entries.push(e);
        return { id: e.id, customerId: e.customerId, debit: e.debit, credit: e.credit, description: e.description, entryDate: e.entryDate, createdAt: e.createdAt };
      },
      findFirst: async (a: { where: { id: string; tenantId: string } }) => {
        const e = state.entries.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        return e ? { id: e.id, customerId: e.customerId, debit: e.debit, credit: e.credit, description: e.description, entryDate: e.entryDate, createdAt: e.createdAt } : null;
      },
    },
    invoice: {
      update: async (a: { where: { id: string }; data: { remainingAmt: number } }) => { state.invoices[a.where.id].remainingAmt = a.data.remainingAmt; return {}; },
    },
    customerAdjustment: {
      create: async (a: { data: Record<string, unknown> & { allocations?: { createMany: { data: { id: string; tenantId: string; invoiceId: string; amount: number }[] } } } }) => {
        const { allocations, ...row } = a.data;
        state.adjustments[row.id as string] = { ...row, createdAt: NOW, cancelledAt: null, reverseMoveId: null, allocations: allocations?.createMany.data.map(({ id, invoiceId, amount }) => ({ id, invoiceId, amount })) ?? [] };
        return { createdAt: NOW };
      },
      findFirst: async (a: { where: { id: string; tenantId: string } }) => {
        const r = state.adjustments[a.where.id];
        return r && r.tenantId === a.where.tenantId ? structuredClone(r) : null;
      },
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => { Object.assign(state.adjustments[a.where.id], a.data); return {}; },
    },
    glSourceEvent: {
      create: async (a: { data: Record<string, unknown> }) => { state.events.push(a.data); return a.data; },
      createMany: async (a: { data: Record<string, unknown>[] }) => {
        for (const d of a.data) {
          if (state.events.some((e) => e.sourceKey === d.sourceKey)) throw new Error(`P2002 ${String(d.sourceKey)}`);
          state.events.push(d);
        }
        return { count: a.data.length };
      },
    },
    glAccount: { findMany: async () => lc.accounts.filter((a) => a.controlKind === 'AR').map((a) => ({ id: a.id })) },
    glMove: {
      findMany: async (a: { where: { id: { in: string[] } } }) => state.moves.filter((m) => a.where.id.in.includes(m.id)).map((m) => ({ id: m.id, number: m.number })),
    },
  } as unknown as GlDb;

  const deps: AdjustmentDeps = {
    acquirePostLock: async () => { log.push('lock'); },
    loadBuildContext: async () => { log.push('context'); return lc; },
    lockCustomerRow: async (_tx, id) => { log.push(`customer:${id}`); },
    currentBalance: async (_tx, id) => state.entries.filter((e) => e.customerId === id).reduce((s, e) => Math.round((s + e.debit - e.credit) * 1e6) / 1e6, 0),
    lockInvoicesById: async (_tx, tenantId, ids) => {
      log.push(`invoices:${[...ids].sort().join(',')}`);
      return [...ids].sort().map((id) => state.invoices[id]).filter((i) => i && i.tenantId === tenantId).map((i) => ({ ...i }));
    },
    lockOpenInvoicesOfCustomer: async (_tx, tenantId, customerId) => {
      log.push(`open-invoices:${customerId}`);
      return Object.values(state.invoices).filter((i) => i.tenantId === tenantId && i.customerId === customerId && i.status === 'CONFIRMED' && i.type === 'CREDIT' && i.remainingAmt > 0.004).map((i) => ({ ...i }));
    },
    reconcile: async (_tx, _t, input) => { log.push(`reconcile:${input.event}`); return reconcileAfterPost(store, input); },
    postMove: (async (_tx: GlDb, draft: MoveDraft, opts: { validationMode?: string; lockPolicy?: string }) => {
      assert.equal(opts.validationMode, 'SYSTEM');
      assert.equal(opts.lockPolicy, 'REJECT', 'المستند يحمل تاريخه: الإقفال مرفوض لا مُزاح');
      if (o.failPost) throw new Error('فشل الترحيل');
      validateMove(draft, lc.ctx, { mode: 'SYSTEM' });
      log.push('post');
      const m = postDraft(draft);
      return { id: m.id, number: m.number, date: m.date } as PostedMove;
    }) as unknown as AdjustmentDeps['postMove'],
    reverseMove: (async (_tx: GlDb, r: { moveId: string; mode?: string; sourceKey?: string | null; reason: string }) => {
      assert.equal(r.mode, 'SYSTEM');
      assert.ok(r.reason.trim());
      log.push('reverse');
      const orig = state.moves.find((m) => m.id === r.moveId)!;
      const draft: MoveDraft = {
        kind: 'MOVE', journalCode: orig.number.split('/')[0], moveType: 'CUSTOMER_ADJUSTMENT', origin: 'AUTO', date: '2026-11-14',
        narration: `عكس القيد ${orig.number}`, needsAttention: false, sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: orig.sourceId,
        sourceKey: r.sourceKey ?? null, sourceEvent: 'REVERSE', currencyCode: 'SAR', currencyDecimals: dec,
        lines: orig.lines.map((l) => ({
          accountId: l.accountId, label: 'عكس', debitMilli: l.creditMilli, creditMilli: l.debitMilli, customerId: l.customerId,
          partnerName: l.customerId ? 'عميل' : null,
        })),
      };
      const m = postDraft(draft, orig.id);
      return { alreadyReversed: false, original: { id: orig.id, number: orig.number }, reversal: { id: m.id, number: m.number, date: m.date } } as ReverseResult;
    }) as unknown as AdjustmentDeps['reverseMove'],
    appendAudit: (async (_tx: GlDb, a: { action: string; entityId?: string | null }) => {
      state.audits.push(a);
      log.push(`audit:${a.action}`);
      return { id: 'au', seq: 1, hash: 'h', prevHash: null };
    }) as unknown as AdjustmentDeps['appendAudit'],
    now: () => NOW,
    newId: () => newId('al'),
  };

  /** معاملة: أي خطأ يعيد الحالة كما كانت (تراجع prisma.$transaction) */
  async function runTx<T>(fn: () => Promise<T>): Promise<T> {
    const snap = structuredClone(state);
    try {
      return await fn();
    } catch (e) {
      state = snap;
      throw e;
    }
  }

  /** فاتورة آجلة مرحّلة: صفّ AccountEntry وقيدها (Dr 113001 لكل قسط / Cr 411001) */
  function seedInvoice(id: string, customerId: string, total: number, installments?: { due: string; amount: number }[]) {
    state.invoices[id] = { ...inv({ id, customerId, remainingAmt: total, number: id }), tenantId: 't1' };
    state.entries.push({ id: newId('ae'), tenantId: 't1', customerId, type: 'INVOICE_DEBIT', debit: total, credit: 0, balance: 0, description: 'فاتورة', entryDate: NOW, createdAt: NOW });
    const parts = installments ?? [{ due: '2026-11-14', amount: total }];
    postDraft({
      kind: 'MOVE', journalCode: 'INV', moveType: 'OUT_INVOICE', origin: 'AUTO', date: '2026-10-01', narration: 'فاتورة', needsAttention: false,
      sourceType: 'INVOICE', sourceId: id, currencyCode: 'SAR', currencyDecimals: dec,
      lines: [
        ...parts.map((p) => ({ accountKey: 'AR_CONTROL' as const, label: 'ذمة', debitMilli: toMilli(p.amount, dec), creditMilli: 0n, customerId, partnerName: 'عميل', dueDate: p.due })),
        { accountKey: 'SALES_REVENUE' as const, label: 'إيراد', debitMilli: 0n, creditMilli: toMilli(total, dec) },
      ],
    });
  }

  /** مرتجع حرّ يترك رصيداً دائناً (Cr 113001 مفتوح) */
  function seedCredit(customerId: string, amount: number, date: string) {
    state.entries.push({ id: newId('ae'), tenantId: 't1', customerId, type: 'INVOICE_CREDIT', debit: 0, credit: amount, balance: 0, description: 'مرتجع', entryDate: NOW, createdAt: NOW });
    postDraft({
      kind: 'MOVE', journalCode: 'INV', moveType: 'OUT_REFUND', origin: 'AUTO', date, narration: 'مرتجع', needsAttention: false,
      sourceType: 'INVOICE', sourceId: newId('ret'), currencyCode: 'SAR', currencyDecimals: dec,
      lines: [
        { accountKey: 'SALES_RETURNS', label: 'مردود', debitMilli: toMilli(amount, dec), creditMilli: 0n },
        { accountKey: 'AR_CONTROL', label: 'ذمة', debitMilli: 0n, creditMilli: toMilli(amount, dec), customerId, partnerName: 'عميل' },
      ],
    });
  }

  /** R2: 113001 لكل عميل من الأستاذ = Σ AccountEntry (مقرَّبة لكل صفّ) — صفر فرق */
  function assertR2() {
    const ledger = new Map<string, bigint>();
    for (const m of state.moves) for (const l of m.lines) {
      if (l.accountId === AR && l.customerId) ledger.set(l.customerId, (ledger.get(l.customerId) ?? 0n) + l.debitMilli - l.creditMilli);
    }
    for (const c of Object.keys(state.customers)) {
      const ops = state.entries.filter((e) => e.customerId === c).reduce((s, e) => s + toMilli(e.debit, dec) - toMilli(e.credit, dec), 0n);
      assert.equal(ledger.get(c) ?? 0n, ops, `R2 للعميل ${c}`);
    }
  }

  const create = (b: Partial<CreateAdjustmentBody>) => runTx(() => executeCreateAdjustment(tx, {
    tenantId: 't1', actor: ACTOR, body: createAdjustmentSchema.parse({ customerId: 'C', kind: 'BAD_DEBT_WRITEOFF', docDate: '2026-11-14', ...b }),
  }, deps));
  const cancel = (id: string, reason = 'خطأ في التسوية') => runTx(() => executeCancelAdjustment(tx, { tenantId: 't1', actor: ACTOR, id, body: { reason } }, deps));

  return { get state() { return state; }, lc, log, deps, tx, create, cancel, seedInvoice, seedCredit, assertR2 };
}

async function rejectsCode(p: Promise<unknown>, code: string, reason?: string) {
  await assert.rejects(p, (e: unknown) => {
    const r = ledgerErrorResponse(e);
    assert.ok(r, `خطأ دفاتر: ${String(e)}`);
    assert.equal(r.body.code, code);
    if (reason) assert.equal(r.body.reason, reason);
    return true;
  });
}

// ═══ الإنشاء ═══

test('E4.13 عبر المسار: صفّ ADJUSTMENT_CREDIT ورصيد العميل والمتبقّي والقيد والحدث DONE وCA معاً — وR2 صفر', async () => {
  const h = harness();
  h.seedInvoice('INV-77', 'C', 300);
  h.assertR2();
  const v = await h.create({ amount: 300, allocations: [{ invoiceId: 'INV-77', amount: '300' }], reference: 'قرار 12' });
  assert.deepEqual(h.log, ['lock', 'context', 'invoices:INV-77', 'customer:C', 'post', 'reconcile:POST', 'audit:CUSTOMER_ADJUSTMENT']);
  const s = h.state;
  // الصفّ التشغيلي ورصيد العميل (Σمدين − Σدائن) والمتبقّي
  const entry = last(s.entries);
  assert.equal(entry.id, v.id, 'معرّف المستند = AccountEntry.id');
  assert.equal(entry.type, 'ADJUSTMENT_CREDIT');
  assert.equal(entry.credit, 300);
  assert.equal(entry.debit, 0);
  assert.equal(entry.description, 'شطب دين معدوم');
  assert.equal(s.customers.C.balance, 0);
  assert.equal(s.invoices['INV-77'].remainingAmt, 0);
  // القيد
  const move = s.moves.find((m) => m.id === v.moveId)!;
  assert.deepEqual(move.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli]), [
    [accountIdOf('711005'), 300_000n, 0n], [AR, 0n, 300_000n],
  ]);
  // الحدث DONE بمفتاح الصفّ نفسه، وحمولة arEntryPayload بأصل CUSTOMER_ADJUSTMENT (المبالغ نصوص)
  const ev = s.events.find((e) => e.sourceKey === `AR_ENTRY:${v.id}:POST`)!;
  assert.equal(ev.status, 'DONE');
  assert.equal(ev.sourceType, 'CUSTOMER_ADJUSTMENT');
  assert.equal(ev.sourceId, v.id);
  assert.equal(ev.event, 'POST');
  assert.equal(ev.moveId, v.moveId);
  const p = ev.payload as Record<string, unknown>;
  assert.equal(p.origin, 'CUSTOMER_ADJUSTMENT');
  assert.equal(p.customerId, 'C');
  assert.equal(p.debit, '0.00');
  assert.equal(p.credit, '300.00');
  assert.equal(p.kind, 'BAD_DEBT_WRITEOFF');
  assert.equal(p.adjustmentId, v.id);
  // المستند وتخصيصه، والمطابقة CA:<alloc> بسطر INV-77
  const adj = s.adjustments[v.id];
  assert.equal(adj.status, 'ACTIVE');
  assert.equal(adj.counterAccountCode, '711005');
  assert.equal(adj.moveId, v.moveId);
  assert.equal(fromDbDate(adj.docDate as Date), '2026-11-14');
  assert.equal(adj.allocations.length, 1);
  const alloc = adj.allocations[0];
  assert.deepEqual(p.allocations, [{ id: alloc.id, invoiceId: 'INV-77', amount: '300.00' }]);
  assert.deepEqual(s.partials.map((x) => [x.sourceRef, x.amountMilli]), [[`CA:${alloc.id}`, 300_000n]]);
  assert.equal(s.partials[0].creditMoveId, v.moveId);
  // العرض (لا BigInt في JSON)
  assert.equal(v.amount, 300);
  assert.equal(v.kind, 'BAD_DEBT_WRITEOFF');
  assert.equal(v.moveNumber, move.number);
  assert.deepEqual(v.allocations, [{ invoiceId: 'INV-77', invoiceNumber: 'INV-77', amount: 300 }]);
  assert.doesNotThrow(() => JSON.stringify(v));
  h.assertR2();
});

test('E4.14 عبر المسار: ردّ رصيد دائن 200 نقداً — Dr 113001 / Cr 111001، ومطابقة FIFO بسطر المرتجع الأقدم', async () => {
  const h = harness();
  h.seedCredit('C', 150, '2026-10-05');
  h.seedCredit('C', 100, '2026-11-01');
  const v = await h.create({ kind: 'CREDIT_REFUND', amount: '200', method: 'CASH' });
  const s = h.state;
  const entry = last(s.entries);
  assert.equal(entry.type, 'ADJUSTMENT_DEBIT');
  assert.equal(entry.debit, 200);
  assert.equal(s.customers.C.balance, -50);
  const move = s.moves.find((m) => m.id === v.moveId)!;
  assert.deepEqual(move.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli]), [[AR, 200_000n, 0n], [accountIdOf('111001'), 0n, 200_000n]]);
  assert.equal(v.counterAccountCode, '111001');
  assert.equal(v.method, 'CASH');
  assert.deepEqual(s.partials.map((x) => x.amountMilli), [150_000n, 50_000n]);
  assert.ok(s.partials.every((x) => x.sourceRef === `FIFO:${x.debitLineId}` && x.debitMoveId === v.moveId));
  h.assertR2();
  // تحويلاً ⇒ Cr 111101 (OD14)
  const t = await h.create({ kind: 'CREDIT_REFUND', amount: '50', method: 'BANK_TRANSFER' });
  assert.equal(t.counterAccountCode, '111101');
  assert.equal(h.state.customers.C.balance, 0);
  h.assertR2();
});

test('التخصيص التلقائي على الأقساط: CA يطابق القسط الأقدم استحقاقاً ويُبقي المتبقّي مفتوحاً (E8.1 بالشطب)', async () => {
  const h = harness();
  h.seedInvoice('INV-1001', 'C', 1150, [{ due: '2026-12-14', amount: 575 }, { due: '2027-01-13', amount: 575 }]);
  const v = await h.create({ amount: 600, autoAllocate: true, counter: 'ALLOWANCE' });
  assert.equal(v.counterAccountCode, '113009');
  assert.equal(h.state.invoices['INV-1001'].remainingAmt, 550);
  const move = h.state.moves.find((m) => m.sourceId === 'INV-1001')!;
  assert.deepEqual(h.state.partials.map((p) => [p.debitLineId, p.amountMilli]), [[move.lines[0].id, 575_000n], [move.lines[1].id, 25_000n]]);
  assert.ok(h.log.includes('open-invoices:C'));
  h.assertR2();
});

test('تراجع المعاملة: فشل الترحيل أو حساب مؤرشف ⇒ لا AccountEntry ولا متبقٍّ ولا رصيد ولا حدث ولا مستند', async () => {
  for (const o of [{ failPost: true }, { accounts: { '711005': { isActive: false } } }] as HarnessOpts[]) {
    const h = harness(o);
    h.seedInvoice('INV-77', 'C', 300);
    const before = structuredClone(h.state);
    await assert.rejects(h.create({ amount: 300, allocations: [{ invoiceId: 'INV-77', amount: 300 }] }), (e: unknown) =>
      (o.failPost ? (e as Error).message === 'فشل الترحيل' : isLedgerError(e, 'LEDGER_ACCOUNT_ARCHIVED')));
    assert.deepEqual(h.state, before, 'لا شيء كُتب');
    assert.equal(h.state.entries.length, 1);
    assert.equal(Object.keys(h.state.adjustments).length, 0);
    assert.equal(h.state.events.length, 0);
  }
});

test('الحرّاس: اليدوية وغير المفعّلة 409، وقبل بداية الربط والتاريخ المستقبلي والمنازل والرصيد 422 — بلا كتابة', async () => {
  for (const mode of ['MANUAL', 'NONE'] as const) {
    const h = harness({ mode });
    await rejectsCode(h.create({ amount: 10, autoAllocate: true }), 'LEDGER_BOOKS_NOT_LINKED', 'BOOKS_NOT_LINKED');
    assert.equal(h.state.entries.length, 0);
  }
  const h = harness();
  h.seedInvoice('INV-77', 'C', 300);
  const n = h.state.entries.length;
  await rejectsCode(h.create({ amount: 10, autoAllocate: true, docDate: '2025-12-31' }), 'LEDGER_ADJUSTMENT_BEFORE_CUTOVER', 'BEFORE_CUTOVER');
  await rejectsCode(h.create({ amount: 10, autoAllocate: true, docDate: '2026-11-15' }), 'LEDGER_ADJUSTMENT_INVALID', 'DOC_DATE_IN_FUTURE');
  await rejectsCode(h.create({ amount: '10.005', autoAllocate: true }), 'LEDGER_ADJUSTMENT_INVALID', 'PRECISION');
  await rejectsCode(h.create({ amount: 0, autoAllocate: true }), 'LEDGER_ADJUSTMENT_INVALID', 'AMOUNT_NOT_POSITIVE');
  await rejectsCode(h.create({ amount: 10 }), 'LEDGER_ADJUSTMENT_ALLOCATION_INVALID', 'ALLOCATIONS_REQUIRED');
  await rejectsCode(h.create({ kind: 'CREDIT_REFUND', amount: 10 }), 'LEDGER_ADJUSTMENT_EXCEEDS_BALANCE', 'REFUND_EXCEEDS_CREDIT_BALANCE');
  await rejectsCode(h.create({ kind: 'CREDIT_REFUND', amount: 10, allocations: [{ invoiceId: 'INV-77', amount: 10 }] }), 'LEDGER_ADJUSTMENT_INVALID', 'REFUND_WITH_ALLOCATIONS');
  await rejectsCode(h.create({ customerId: 'D', amount: 10, allocations: [{ invoiceId: 'INV-77', amount: 10 }] }), 'LEDGER_ADJUSTMENT_ALLOCATION_INVALID', 'OTHER_CUSTOMER');
  // رصيد دائن غير مخصَّص (سند 250) يُنقص المدين: الشطب لا يتجاوز الرصيد المدين (300 − 250 = 50)
  h.seedCredit('C', 250, '2026-11-01');
  await rejectsCode(h.create({ amount: 100, allocations: [{ invoiceId: 'INV-77', amount: 100 }] }), 'LEDGER_ADJUSTMENT_EXCEEDS_BALANCE', 'WRITEOFF_EXCEEDS_DEBIT_BALANCE');
  assert.equal(h.state.entries.length, n + 1, 'لا صفّ تسوية من الرفض (المزروع وحده)');
  await assert.rejects(h.create({ customerId: 'ZZ', amount: 10, autoAllocate: true }), (e: unknown) => ledgerErrorResponse(e)?.status === 404);
});

test('الدفاتر القديمة (LEGACY): المستند يُرحَّل ويحفظ R2، بلا مطابقة جزئية (L8 للمربوطة وحدها)، والبداية تاريخ البدء', async () => {
  const h = harness({ mode: 'LEGACY' });
  h.seedInvoice('INV-77', 'C', 300);
  await rejectsCode(h.create({ amount: 10, autoAllocate: true, docDate: '2026-02-28' }), 'LEDGER_ADJUSTMENT_BEFORE_CUTOVER');
  await h.create({ amount: 120, autoAllocate: true });
  assert.equal(h.state.partials.length, 0);
  assert.ok(!h.log.some((x) => x.startsWith('reconcile')), 'لا مطابقة لغير المربوطة');
  assert.equal(h.state.invoices['INV-77'].remainingAmt, 180);
  h.assertR2();
});

test('المنازل 0 و3: ملّي حرفاً في الصفّ والقيد والمتبقّي', async () => {
  const h0 = harness({ dec: 0 });
  h0.seedInvoice('IQ-1', 'C', 3000);
  await h0.create({ amount: 3000, allocations: [{ invoiceId: 'IQ-1', amount: 3000 }] });
  assert.equal(h0.state.invoices['IQ-1'].remainingAmt, 0);
  h0.assertR2();
  const h3 = harness({ dec: 3 });
  h3.seedInvoice('BH-1', 'C', 1.099);
  await h3.create({ amount: '0.333', allocations: [{ invoiceId: 'BH-1', amount: '0.333' }] });
  assert.equal(h3.state.invoices['BH-1'].remainingAmt, 0.766);
  assert.equal(last(h3.state.moves).lines[1].creditMilli, 333n);
  h3.assertR2();
});

// ═══ الإلغاء ═══

test('E4.15 إلغاء الشطب: الصفّ العاكس، والمتبقّي يعود 300، والعكس DONE، وصفّ العكس SKIPPED(NETTED)، وCA ⇐ REV — وR2 صفر', async () => {
  const h = harness();
  h.seedInvoice('INV-77', 'C', 300);
  const v = await h.create({ amount: 300, allocations: [{ invoiceId: 'INV-77', amount: 300 }] });
  h.log.length = 0;
  const c = await h.cancel(v.id, 'دفع العميل لاحقاً');
  assert.deepEqual(h.log, ['lock', 'invoices:INV-77', 'customer:C', 'reverse', 'reconcile:REVERSE', 'audit:CUSTOMER_ADJUSTMENT']);
  const s = h.state;
  const rev = last(s.entries);
  assert.equal(rev.type, 'ADJUSTMENT_DEBIT');
  assert.equal(rev.debit, 300);
  assert.equal(rev.description, 'إلغاء شطب ذمة');
  assert.equal(s.customers.C.balance, 300);
  assert.equal(s.invoices['INV-77'].remainingAmt, 300);
  const revMove = s.moves.find((m) => m.reversedMoveId === v.moveId)!;
  assert.equal(c.reverseMoveId, revMove.id);
  const revEv = s.events.find((e) => e.sourceKey === `AR_ENTRY:${v.id}:REVERSE`)!;
  assert.equal(revEv.status, 'DONE');
  assert.equal(revEv.moveId, revMove.id);
  assert.equal(revEv.sourceType, 'CUSTOMER_ADJUSTMENT');
  assert.equal((revEv.payload as Record<string, unknown>).origin, 'CUSTOMER_ADJUSTMENT');
  assert.equal((revEv.payload as Record<string, unknown>).credit, '300.00', 'حمولة العكس = حمولة الأصل');
  const netted = s.events.find((e) => e.sourceKey === `AR_ENTRY:${rev.id}:POST`)!;
  assert.equal(netted.status, 'SKIPPED');
  assert.equal(netted.skipReason, 'NETTED');
  assert.equal(netted.moveId, undefined);
  assert.equal((netted.payload as Record<string, unknown>).origin, 'CUSTOMER_ADJUSTMENT');
  assert.equal((netted.payload as Record<string, unknown>).kind, undefined, 'صفّ العكس لا يُطابَق مستنداً');
  // CA فُكّت فعاد سطر الفاتورة مفتوحاً، والأصل مطابَق بعكسه REV
  assert.deepEqual(s.partials.map((p) => [p.sourceRef, p.amountMilli]), [[`REV:${revMove.id}`, 300_000n]]);
  assert.equal(s.adjustments[v.id].status, 'CANCELLED');
  assert.equal(s.adjustments[v.id].reverseEntryId, rev.id);
  assert.equal(s.adjustments[v.id].cancelReason, 'دفع العميل لاحقاً');
  assert.equal(c.status, 'CANCELLED');
  assert.equal(c.cancelReason, 'دفع العميل لاحقاً');
  h.assertR2();
  // إلغاء ثانٍ ⇒ 409 بلا أي كتابة
  const before = structuredClone(h.state);
  await rejectsCode(h.cancel(v.id), 'LEDGER_ADJUSTMENT_CANCELLED', 'ALREADY_CANCELLED');
  assert.deepEqual(h.state, before);
});

test('إلغاء ردّ الرصيد: الصفّ العاكس دائن، وFIFO تُفكّ فيعود الرصيد الدائن مفتوحاً — وR2 صفر', async () => {
  const h = harness();
  h.seedCredit('C', 200, '2026-10-05');
  const v = await h.create({ kind: 'CREDIT_REFUND', amount: 200, method: 'BANK_TRANSFER' });
  assert.equal(h.state.partials.length, 1);
  await h.cancel(v.id);
  const rev = last(h.state.entries);
  assert.equal(rev.type, 'ADJUSTMENT_CREDIT');
  assert.equal(rev.credit, 200);
  assert.equal(h.state.customers.C.balance, -200);
  assert.deepEqual(h.state.partials.map((p) => p.sourceRef.split(':')[0]), ['REV']);
  h.assertR2();
});

test('إلغاء الشطب على فاتورة أُلغيت بعده: لا يُردّ متبقّي فاتورة ملغاة', async () => {
  const h = harness();
  h.seedInvoice('INV-77', 'C', 300);
  const v = await h.create({ amount: 300, allocations: [{ invoiceId: 'INV-77', amount: 300 }] });
  h.state.invoices['INV-77'].status = 'CANCELLED';
  await h.cancel(v.id);
  assert.equal(h.state.invoices['INV-77'].remainingAmt, 0);
});

test('سبب الإلغاء إلزامي: 422 LEDGER_REVERSAL_REASON_REQUIRED', () => {
  for (const raw of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: 5 }]) {
    assert.throws(() => cancelBodyOf(raw), (e: unknown) => isLedgerError(e, 'LEDGER_REVERSAL_REASON_REQUIRED'));
  }
  assert.deepEqual(cancelBodyOf({ reason: ' خطأ ' }), { reason: 'خطأ' });
});

// ═══ مساعدات صرفة ═══

test('لحظة الصفّ: اليوم ⇒ الآن، ويوم سابق ⇒ بداية يومه بتوقيت الشركة (تاريخه المحلي = تاريخ القيد)', () => {
  assert.equal(entryInstantOf('2026-11-14', 'Asia/Riyadh', NOW), NOW);
  assert.equal(entryInstantOf('2026-11-01', 'Asia/Riyadh', NOW).toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(adjustmentCutover({ linkedFrom: toDbDate('2026-01-01'), cutoverDate: toDbDate('2026-05-01') }), '2026-01-01');
  assert.equal(adjustmentCutover({ linkedFrom: null, cutoverDate: toDbDate('2026-05-01') }), '2026-05-01');
  assert.equal(adjustmentCutover({ linkedFrom: null, cutoverDate: null }), null);
});

test('فلاتر القائمة: العميل والحالة ونطاق التاريخ والصفحة من 1 بسقف 200', () => {
  const r = listWhereOf('t1', { customerId: 'C', status: 'ACTIVE', from: '2026-11-01', to: '2026-11-30', page: '3', limit: '500' });
  assert.deepEqual(r.where, { tenantId: 't1', customerId: 'C', status: 'ACTIVE', docDate: { gte: toDbDate('2026-11-01'), lte: toDbDate('2026-11-30') } });
  assert.deepEqual([r.skip, r.take, r.page], [400, 200, 3]);
  assert.deepEqual(listWhereOf('t1', {}).where, { tenantId: 't1' });
  assert.throws(() => listWhereOf('t1', { status: 'X' }), LedgerHttpError);
  assert.throws(() => listWhereOf('t1', { from: '2026-13-01' }), LedgerHttpError);
});

test('جسم الإنشاء strict: حقل مجهول أو نوع مجهول ⇒ ZodError', () => {
  assert.throws(() => createAdjustmentSchema.parse({ customerId: 'C', kind: 'X', amount: 1, docDate: '2026-11-14' }));
  assert.throws(() => createAdjustmentSchema.parse({ customerId: 'C', kind: 'CREDIT_REFUND', amount: 1, docDate: '2026-11-14', foo: 1 }));
  assert.throws(() => createAdjustmentSchema.parse({ customerId: 'C', kind: 'CREDIT_REFUND', amount: 1, docDate: '2026-11-14', method: 'POS' }));
});

// ═══ حراس ثابتة ═══

const ROUTES = path.join(process.cwd(), 'src', 'routes');
const src = (f: string) => fs.readFileSync(path.join(ROUTES, f), 'utf8');

test('حارس ثابت: المسارات بصلاحياتها، والكتابة في معاملة واحدة، وopen-items قبل :id', () => {
  const s = src('ledger/customerAdjustments.ts');
  const routes = [...s.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  assert.deepEqual(routes, [
    'get /customer-adjustments VIEW', 'get /customer-adjustments/open-items VIEW', 'get /customer-adjustments/:id VIEW',
    'post /customer-adjustments POST', 'post /customer-adjustments/:id/cancel POST',
  ]);
  assert.match(s, /const VIEW = requireLedgerPermission\('canViewLedger'\);/);
  assert.match(s, /const POST = requireLedgerPermission\('canPostJournals'\);/);
  assert.match(s, /prisma\.\$transaction\(\(tx\) => executeCreateAdjustment\(/);
  assert.match(s, /executeCancelAdjustment\(tx, /);
  // ترتيب الأقفال: الفواتير قبل صفّ العميل (ترتيب السندات) — والقفل الاستشاري أولاً
  const body = s.slice(s.indexOf('export async function executeCreateAdjustment'), s.indexOf('export function adjustmentEventPayload'));
  const at = (t: string) => { const i = body.indexOf(t); assert.ok(i > 0, t); return i; };
  assert.ok(at('deps.acquirePostLock') < at('deps.lockInvoicesById') && at('deps.lockInvoicesById') < at('deps.lockCustomerRow'));
  assert.ok(at('deps.lockCustomerRow') < at('tx.accountEntry.create') && at('tx.accountEntry.create') < at('deps.postMove'));
  assert.ok(at('deps.postMove') < at('tx.glSourceEvent.create'));
});

test('حارس ثابت: المسارات التشغيلية لا تستورد التسويات ولا خريطة الطرق، والفهرس يركّب الجديد بعد الحراسة وقبل reportsRouter', () => {
  for (const f of ['invoices.ts', 'receipts.ts', 'accounting.ts', 'paylink.ts', 'settlement.ts']) {
    const p = path.join(ROUTES, f);
    if (!fs.existsSync(p)) continue;
    assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /ledger\/customerAdjustments|ledger\/paymentMethodMap|builders\/customerAdjustment/, f);
  }
  const index = src('ledger/index.ts');
  const guard = index.indexOf('router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext);');
  const reports = index.indexOf('router.use(reportsRouter);');
  for (const [name, file] of [
    ['customerAdjustmentsRouter', 'customerAdjustments'], ['paymentMethodMapRouter', 'paymentMethodMap'], ['clearingRouter', 'clearing'],
    ['partnerReportsRouter', 'partnerReports'], ['sourceAttachmentsRouter', 'sourceAttachments'],
  ]) {
    assert.match(index, new RegExp(`import ${name} from '\\./${file}';`));
    const use = index.indexOf(`router.use(${name});`);
    assert.ok(use > guard, `${name} بعد الحراسة`);
    assert.ok(use < reports, `${name} قبل reportsRouter`);
  }
});

test('حارس ثابت: customerAdjustment في builders صرفٌ بلا prisma ولا I/O', () => {
  const b = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'gl', 'builders', 'customerAdjustment.ts'), 'utf8');
  assert.doesNotMatch(b, /from '@prisma\/client'|config\/database|\$queryRaw|\.findMany\(/);
  assert.equal(customerAdjustmentKey('x'), 'AR_ENTRY:x:POST');
  assert.equal(customerAdjustmentKey('x', 'REVERSE'), 'AR_ENTRY:x:REVERSE');
});
