// «المحاسب الذكي AI» — الإطفاء الشهري للمدفوع مقدماً (الحزمة P3، القرار D2): التقريب نصف-لأعلى والباقي على الأخير، نهايات
// الأشهر بتوقيت الشركة، عدم التكرار بالمرجع AI-AMORT-<parentPostId>-<k>، الفترة المقفلة (تخطٍّ وتنبيه ثم استكمال)، عكس قيد
// الدفع (توقّف والأقساط باقية وتنبيه في القائمة)، أهلية الشركة ومفتاح الإطفاء، وشكل القيد (Dr المصروف / Cr المدفوع مقدماً).
// بلا قاعدة: قاعدة ومعاملة مزيّفتان (المعاملة تُسقط ما كتبته عند الرمي)، والخطط من posting.ts الحقيقية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AMORT_ACTOR_NAME, AMORT_ADMIN_ID, AMORT_AUDIT_ACTION, amortEligible, amortRefOf, dueMonths, runAmortization,
  type AmortDb, type AmortTenantRow,
} from '../services/aiAccountant/amortization';
import {
  amortizationAmount, amortizationDate, amortizationMonthEnd, buildAmortizationPlan, buildPrepaidPlan, listAiPostsWith,
  prepaidLockedWarning, prepaidReversedWarning, scheduleOf,
  type AiPostDeps, type AiPostsListDb, type PlanEnv, type PlanOutcome, type AiPostPlan, type PrepaidSchedule,
} from '../services/aiAccountant/posting';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import type { GlDb, GlSettingsRow, LedgerContext } from '../services/gl/resolve';
import type { PostedMove as GlPostedMove, PostMoveOptions } from '../services/gl/post';
import { LedgerError, createBuildContext, type MoveDraft } from '../services/gl/types';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function ledgerContext(dec = 2): LedgerContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: dec }, extraAccounts: [...linkedAccountRefs(accountIdOf)],
  });
  const ctx = createBuildContext(input);
  const accounts = [...input.accounts];
  const taxes = [...(input.taxes ?? [])];
  const journals = [...(input.journals ?? [])];
  return {
    ctx, settings: {} as GlSettingsRow, accounts, taxes, journals,
    accountById: new Map(accounts.map((a) => [a.id, a])), taxById: new Map(taxes.map((t) => [t.id, t])), journalById: new Map(journals.map((j) => [j.id, j])),
  };
}
const envOf = (dec = 2): PlanEnv => ({ lc: ledgerContext(dec), booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false });
const planOf = (o: PlanOutcome): AiPostPlan => { if (!o.ok) assert.fail(`رُفض: ${o.refusal.code} ${o.refusal.message}`); return o.plan; };

/** جدول إطفاء من خطة PREPAID حقيقية: الأساس (بلا ضريبة) على الأشهر */
function scheduleFor(o: { base: string; months: number; startYm?: string; expense?: string; dec?: number; date?: string }): PrepaidSchedule {
  const plan = planOf(buildPrepaidPlan(envOf(o.dec), {
    docId: 'doc-1', accountCode: o.expense ?? '621004', paidFrom: 'bank', paidFromAccountCode: null, totalMilli: BigInt(Math.round(Number(o.base) * 1000)),
    vatMilli: 0n, vatMode: 'NONE', date: o.date ?? '2026-11-10', what: 'فاتورة إيجار — شركة العقار رقم R-77', months: o.months, startYm: o.startYm ?? '2026-11',
  }));
  return plan.meta!;
}

test('التقريب: القسط = الأساس ÷ الأشهر نصف-لأعلى إلى منازل العملة، والأخير يأخذ الباقي (Σ = الأساس بالضبط)', () => {
  const cases: [string, number, number, bigint, bigint][] = [
    ['10000.00', 3, 2, 3_333_330n, 3_333_340n],
    ['1000.00', 12, 2, 83_330n, 83_370n],
    ['12000.00', 12, 2, 1_000_000n, 1_000_000n],
    ['100.05', 2, 2, 50_030n, 50_020n], // 50.025 ⇒ 50.03 (نصف لأعلى) والأخير 50.02
    ['1000.000', 7, 3, 142_857n, 142_858n], // الدينار بثلاث منازل
  ];
  for (const [base, months, dec, monthly, last] of cases) {
    const s = scheduleFor({ base, months, dec });
    assert.deepEqual([BigInt(s.monthlyMilli), BigInt(s.lastMilli)], [monthly, last], `${base}/${months}`);
    let sum = 0n;
    for (let k = 1; k <= months; k++) sum += amortizationAmount(s, k);
    assert.equal(sum, BigInt(s.baseMilli), 'مجموع الأقساط = الأساس');
    assert.equal(amortizationAmount(s, months), last);
  }
  assert.equal(scheduleOf({ months: 'x' }), null);
  assert.equal(scheduleOf(null), null);
  assert.deepEqual(scheduleOf(scheduleFor({ base: '1200.00', months: 12 }))?.months, 12);
});

test('نهايات الأشهر: الشهر k يحلّ بعد آخر يومٍ فيه (اليوم المحلي بعده)، وتاريخه آخر الشهر ولا يسبق تاريخ قيد الدفع', () => {
  const s = { months: 3, startYm: '2026-11' };
  assert.deepEqual(dueMonths(s, '2026-11-30', new Set()), [], 'آخر يوم لم ينقضِ بعد');
  assert.deepEqual(dueMonths(s, '2026-12-01', new Set()), [1]);
  assert.deepEqual(dueMonths(s, '2027-01-15', new Set()), [1, 2]);
  assert.deepEqual(dueMonths(s, '2027-02-01', new Set()), [1, 2, 3]);
  assert.deepEqual(dueMonths(s, '2027-06-01', new Set([1])), [2, 3]);
  assert.deepEqual(dueMonths({ months: 2, startYm: '2027-01' }, '2027-03-01', new Set()), [1, 2], 'فبراير 28 يوماً');
  assert.equal(amortizationMonthEnd('2027-01', 2), '2027-02-28');
  assert.equal(amortizationMonthEnd('2028-01', 2), '2028-02-29');
  assert.equal(amortizationMonthEnd('2026-11', 3), '2027-01-31');
  // شهرٌ خدمته قبل الدفع ⇒ يُحمَّل بتاريخ الدفع لا قبله
  assert.equal(amortizationDate({ startYm: '2026-10' }, 1, '2026-11-10'), '2026-11-10');
  assert.equal(amortizationDate({ startYm: '2026-10' }, 2, '2026-11-10'), '2026-11-30');
});

test('قسط الشهر: Dr الإيجار 621004 / Cr 115002 بقسطه، دفتر MISC، نوع DEFERRAL، يدويّ بلا مصدر، PREPAID_AMORT بأبيه', () => {
  const env = envOf();
  const s = scheduleFor({ base: '10000.00', months: 3 });
  const plan = planOf(buildAmortizationPlan(env, { parentPostId: 'pp1', schedule: s, k: 3, date: '2027-01-31' }));
  assert.equal(plan.kind, 'PREPAID_AMORT');
  assert.equal(plan.parentPostId, 'pp1');
  assert.equal(plan.totalMilli, 3_333_340n);
  const v = validateMove(plan.draft, env.lc.ctx, { mode: 'MANUAL' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli);
  const codes = plan.draft.lines.map((l) => [resolveLineAccount(l, env.lc.ctx.accounts)!.code, l.debitMilli, l.creditMilli]);
  assert.deepEqual(codes, [['621004', 3_333_340n, 0n], ['115002', 0n, 3_333_340n]]);
  assert.deepEqual([plan.draft.journalCode, plan.draft.moveType, plan.draft.origin, plan.draft.sourceType], ['MISC', 'DEFERRAL', 'MANUAL', null]);
  assert.match(plan.summaryAr, /إطفاء فاتورة إيجار — شركة العقار رقم R-77 — يناير 2027 \(3 من 3\)/);
  // غير الإيجار ⇒ 115001، وقسط خارج الجدول يُرفض
  const sw = scheduleFor({ base: '1200.00', months: 12, expense: '621008' });
  assert.equal(sw.prepaidCode, '115001');
  const p2 = planOf(buildAmortizationPlan(env, { parentPostId: 'pp2', schedule: sw, k: 1, date: '2026-11-30' }));
  assert.deepEqual(p2.draft.lines.map((l) => resolveLineAccount(l, env.lc.ctx.accounts)!.code), ['621008', '115001']);
  assert.equal(buildAmortizationPlan(env, { parentPostId: 'pp2', schedule: sw, k: 13, date: '2026-11-30' }).ok, false);
});

// ═══ التشغيل بقاعدة مزيّفة ═══

interface Mv { id: string; tenantId: string; ref: string | null; reversedMoveId: string | null; state: string; number: string; date: string; lines: { accountId: string; debitMilli: bigint; creditMilli: bigint }[] }

function world(o: { settings?: Record<string, Partial<AmortTenantRow> | null>; lockedUntil?: string | null } = {}) {
  const lc = ledgerContext();
  const rows: Row[] = [];
  const moves: Mv[] = [];
  const posts: { draft: MoveDraft; opts: PostMoveOptions }[] = [];
  const state = { lockedUntil: o.lockedUntil ?? null };
  const settings: Record<string, AmortTenantRow | null> = {};
  for (const t of ['t1', 't2']) {
    const over = o.settings?.[t];
    settings[t] = over === null ? null : {
      tenantId: t, activatedAt: new Date('2026-10-01T00:00:00Z'), timezone: 'Asia/Riyadh', setupMethod: 'CLEAN',
      tenant: { accountingSuiteEnabled: true, accountingEnabled: true, aiAccountantEnabled: true }, ...(over ?? {}),
    };
  }
  const updateMany = async (a: { where: Row; data: Row }) => {
    const hit = rows.filter((r) => r.id === a.where.id && r.tenantId === a.where.tenantId);
    for (const r of hit) Object.assign(r, a.data);
    return { count: hit.length };
  };
  const tx = {
    aiAccountantPost: {
      findFirst: async (a: { where: Row }) => rows.find((r) => r.tenantId === a.where.tenantId && r.ref === a.where.ref) ?? null,
      create: async (a: { data: Row }) => { const r = { id: `am${rows.length + 1}`, createdAt: new Date(), docId: null, meta: null, ...a.data }; rows.push(r); return r; },
      updateMany,
    },
    glMove: {
      findFirst: async (a: { where: Row }) => {
        const w = a.where;
        if (w.reversedMoveId) return moves.find((m) => m.tenantId === w.tenantId && m.reversedMoveId === w.reversedMoveId) ?? null;
        return moves.find((m) => m.tenantId === w.tenantId && m.id === w.id && (!w.state || m.state === w.state)) ?? null;
      },
    },
  } as unknown as GlDb;
  const db: AmortDb = {
    aiAccountantPost: {
      findMany: async (a: { where: Row; take?: number }) => {
        const w = a.where;
        if (w.kind === 'PREPAID') {
          return rows.filter((r) => r.kind === 'PREPAID' && (!w.id || r.id > w.id.gt)).sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, a.take ?? 1000);
        }
        return rows.filter((r) => r.parentPostId && w.parentPostId.in.includes(r.parentPostId));
      },
      updateMany,
    },
    glSettings: { findMany: async (a: { where: Row }) => (a.where.tenantId.in as string[]).map((t) => settings[t]).filter(Boolean) },
    // المعاملة: ما كُتب يسقط عند الرمي
    $transaction: async (fn) => {
      const r0 = rows.length;
      const m0 = moves.length;
      const p0 = posts.length;
      try { return await fn(tx); } catch (e) { rows.length = r0; moves.length = m0; posts.length = p0; throw e; }
    },
  };
  const deps: AiPostDeps = {
    acquirePostLock: async () => undefined,
    loadBuildContext: async () => lc,
    postMove: (async (_tx: GlDb, draft: MoveDraft, opts: PostMoveOptions) => {
      validateMove(draft, lc.ctx, { mode: 'MANUAL' });
      if (state.lockedUntil && draft.date <= state.lockedUntil) {
        throw new LedgerError('LEDGER_PERIOD_LOCKED', { date: draft.date, lockDate: state.lockedUntil, firstOpenDate: null });
      }
      posts.push({ draft, opts });
      const id = `mv${moves.length + 1}`;
      const number = `MISC/2026/000${posts.length}`;
      moves.push({ id, tenantId: opts.tenantId, ref: draft.ref ?? null, reversedMoveId: null, state: 'POSTED', number, date: draft.date, lines: draft.lines.map((l) => ({ accountId: resolveLineAccount(l, lc.ctx.accounts)!.id, debitMilli: l.debitMilli, creditMilli: l.creditMilli })) });
      return { id, number, date: draft.date } as GlPostedMove;
    }) as unknown as AiPostDeps['postMove'],
  };
  /** قيد دفعٍ مقدّم مرحّل وصفّه */
  const parent = (id: string, s: PrepaidSchedule, p: { tenantId?: string; date?: string } = {}) => {
    const tenantId = p.tenantId ?? 't1';
    const moveId = `pm-${id}`;
    moves.push({ id: moveId, tenantId, ref: `AI-x-${id}`, reversedMoveId: null, state: 'POSTED', number: `BNK1/2026/${id}`, date: p.date ?? '2026-11-10', lines: [] });
    rows.push({
      id, tenantId, adminId: 'a1', adminName: 'سارة', moveId, moveNumber: `BNK1/2026/${id}`, ref: `AI-x-${id}`, kind: 'PREPAID',
      amountMilli: BigInt(s.baseMilli), dateLocal: p.date ?? '2026-11-10', summaryAr: 'إيجار مدفوع مقدماً', createdAt: new Date('2026-11-10T10:00:00Z'),
      docId: 'doc-1', parentPostId: null, meta: { ...s },
    });
  };
  const reverse = (moveId: string) => {
    const m = moves.find((x) => x.id === moveId)!;
    moves.push({ ...m, id: `rv-${moveId}`, reversedMoveId: moveId, number: `REV/${m.number}`, lines: [] });
  };
  return { lc, rows, moves, posts, db, deps, parent, reverse, state, settings };
}

const run = (w: ReturnType<typeof world>, now: string, env: NodeJS.ProcessEnv = {}) =>
  runAmortization(w.db, new Date(now), { env, post: w.deps, page: 2, log: () => undefined });

test('بتوقيت الشركة: ٢٣:٣٠ بتوقيت غرينتش آخر نوفمبر = أول ديسمبر في الرياض ⇒ قسط نوفمبر بتاريخ ٣٠ نوفمبر؛ ونيويورك لم يحن بعد', async () => {
  const w = world({ settings: { t2: { timezone: 'America/New_York' } } });
  const s = scheduleFor({ base: '12000.00', months: 12 });
  w.parent('p-001', s);
  w.parent('p-002', s, { tenantId: 't2' });
  const r = await run(w, '2026-11-30T21:30:00Z');
  assert.deepEqual(r.posted.map((p) => [p.tenantId, p.parentPostId, p.k]), [['t1', 'p-001', 1]]);
  const { draft, opts } = w.posts[0];
  assert.equal(draft.date, '2026-11-30');
  assert.equal(draft.ref, amortRefOf('p-001', 1));
  assert.equal(draft.ref, 'AI-AMORT-p-001-1');
  assert.deepEqual([opts.actor.actorType, opts.actor.actorId, opts.actor.actorName], ['SYSTEM', null, AMORT_ACTOR_NAME]);
  assert.deepEqual([opts.validationMode, opts.lockPolicy, opts.auditAction], ['MANUAL', 'REJECT', AMORT_AUDIT_ACTION]);
  assert.deepEqual(opts.auditExtra, { aiAccountant: true, amortization: true, parentPostId: 'p-001', k: 1, ref: 'AI-AMORT-p-001-1' });
  const row = w.rows.find((x) => x.kind === 'PREPAID_AMORT')!;
  assert.deepEqual([row.tenantId, row.adminId, row.adminName, row.parentPostId, row.ref, row.amountMilli, row.dateLocal],
    ['t1', AMORT_ADMIN_ID, AMORT_ACTOR_NAME, 'p-001', 'AI-AMORT-p-001-1', 1_000_000n, '2026-11-30']);
  // نيويورك بعد أن ينقضي ٣٠ نوفمبر هناك
  const r2 = await run(w, '2026-12-01T05:30:00Z');
  assert.deepEqual(r2.posted.map((p) => [p.tenantId, p.k]), [['t2', 1]]);
});

test('عدم التكرار: إعادة التشغيل لا تكرّر قسطاً، والفائت يُستكمل دفعةً واحدة بأشهره، والمرجع الموجود يُتخطّى ولو لم تره القائمة', async () => {
  const w = world();
  const s = scheduleFor({ base: '10000.00', months: 3 });
  w.parent('p-001', s);
  await run(w, '2026-12-05T09:00:00Z');
  await run(w, '2026-12-06T09:00:00Z');
  assert.equal(w.posts.length, 1, 'قسط نوفمبر مرة واحدة');
  // بعد أشهر: الباقي كله، والأخير يأخذ الباقي — Σ = الأساس
  const r = await run(w, '2027-03-01T09:00:00Z');
  assert.deepEqual(r.posted.map((p) => p.k), [2, 3]);
  const amounts = w.rows.filter((x) => x.kind === 'PREPAID_AMORT').map((x) => x.amountMilli as bigint);
  assert.deepEqual(amounts, [3_333_330n, 3_333_330n, 3_333_340n]);
  assert.equal(amounts.reduce((a, b) => a + b, 0n), 10_000_000n);
  assert.deepEqual(w.posts.map((p) => p.draft.date), ['2026-11-30', '2026-12-31', '2027-01-31']);
  assert.equal((await run(w, '2027-06-01T09:00:00Z')).posted.length, 0, 'اكتمل الجدول');
  // سباق: صفّ القسط موجود تحت القفل وإن لم يظهر في قائمة الأبناء ⇒ لا ترحيل
  const w2 = world();
  w2.parent('p-001', s);
  const origFindMany = w2.db.aiAccountantPost.findMany;
  w2.db.aiAccountantPost.findMany = async (a: Row) => (a.where.parentPostId ? [] : origFindMany(a));
  w2.rows.push({ id: 'race', tenantId: 't1', ref: 'AI-AMORT-p-001-1', kind: 'PREPAID_AMORT', parentPostId: 'other' });
  const r2 = await run(w2, '2026-12-05T09:00:00Z');
  assert.deepEqual(r2.posted, []);
  assert.equal(w2.posts.length, 0);
});

test('الفترة المقفلة: يُتخطّى الشهر بتنبيه في meta (يظهر في القائمة) ويُستكمل غيره، ثم يُرحَّل بعد فتحها ويُمحى التنبيه', async () => {
  const w = world({ lockedUntil: '2026-11-30' });
  const s = scheduleFor({ base: '9000.00', months: 3 });
  w.parent('p-001', s);
  const r = await run(w, '2027-01-02T09:00:00Z');
  assert.deepEqual(r.locked.map((x) => [x.k, x.date]), [[1, '2026-11-30']]);
  assert.deepEqual(r.posted.map((p) => p.k), [2], 'ديسمبر مفتوح فيُرحَّل');
  const meta = scheduleOf(w.rows.find((x) => x.id === 'p-001')!.meta)!;
  assert.deepEqual([meta.lockedSkip?.k, meta.lockedSkip?.date], [1, '2026-11-30']);
  assert.equal(w.rows.filter((x) => x.kind === 'PREPAID_AMORT').length, 1, 'لا صفّ للشهر المقفل (المعاملة سقطت)');
  // القائمة تنبّه
  const listed = await listAiPostsWith(listDb(w), 't1', 50);
  const pp = listed.find((x) => x.id === 'p-001')!;
  assert.deepEqual(pp.prepaid, { posted: 1, months: 3, stopped: false, nextDate: '2026-11-30', lockedMonths: ['2026-11'] });
  assert.equal(pp.warning, prepaidLockedWarning('2026-11-30'));
  // فُتحت الفترة
  w.state.lockedUntil = null;
  const r2 = await run(w, '2027-01-03T09:00:00Z');
  assert.deepEqual(r2.posted.map((p) => p.k), [1]);
  assert.equal(scheduleOf(w.rows.find((x) => x.id === 'p-001')!.meta)!.lockedSkip, null);
  const again = (await listAiPostsWith(listDb(w), 't1', 50)).find((x) => x.id === 'p-001')!;
  assert.equal(again.warning, undefined);
  assert.deepEqual(again.prepaid, { posted: 2, months: 3, stopped: false, nextDate: '2027-01-31' });
});

test('عكس قيد الدفع: يتوقف الإطفاء والأقساط المرحّلة باقية، والقائمة تنبّه بعددها الحيّ', async () => {
  const w = world();
  const s = scheduleFor({ base: '12000.00', months: 12 });
  w.parent('p-001', s);
  await run(w, '2027-01-05T09:00:00Z');
  assert.equal(w.posts.length, 2, 'نوفمبر وديسمبر');
  w.reverse('pm-p-001');
  const r = await run(w, '2027-03-05T09:00:00Z');
  assert.deepEqual(r.posted, []);
  assert.deepEqual(r.stopped, [{ tenantId: 't1', parentPostId: 'p-001' }]);
  assert.equal(w.rows.filter((x) => x.kind === 'PREPAID_AMORT').length, 2, 'المرحّل باقٍ');
  const listed = await listAiPostsWith(listDb(w), 't1', 50);
  const pp = listed.find((x) => x.id === 'p-001')!;
  assert.equal(pp.reversed, true);
  assert.deepEqual(pp.prepaid, { posted: 2, months: 12, stopped: true, nextDate: null });
  assert.equal(pp.warning, prepaidReversedWarning(2));
  assert.match(pp.warning!, /عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة \(2\)/);
  const amort = listed.find((x) => x.kind === 'PREPAID_AMORT')!;
  assert.equal(amort.parentPostId, 'p-001');
  assert.equal(amort.reversed, false);
  // ترتيب القسط «الشهر k من n» (amortText في الويب) من مرجعه وجدول أبيه
  const ords = listed.filter((x) => x.kind === 'PREPAID_AMORT').map((x) => x.amort).sort((a, b) => a!.index - b!.index);
  assert.deepEqual(ords, [{ parentPostId: 'p-001', index: 1, months: 12 }, { parentPostId: 'p-001', index: 2, months: 12 }]);
  // الأب خارج الصفحة ⇒ يُسأل عن جدوله وحده
  const db = listDb(w);
  const base = db.aiAccountantPost.findMany.bind(db.aiAccountantPost);
  db.aiAccountantPost.findMany = async (a: unknown) => {
    const rs = await base(a);
    const wh = (a as { where: Row }).where;
    return wh.id || wh.parentPostId ? rs : rs.filter((r) => r.kind !== 'PREPAID');
  };
  const paged = await listAiPostsWith(db, 't1', 50);
  assert.equal(paged.some((x) => x.kind === 'PREPAID'), false);
  assert.deepEqual(paged.filter((x) => x.kind === 'PREPAID_AMORT').map((x) => x.amort?.months), [12, 12]);
});

test('الأهلية والمفتاح: الشركة بلا تفعيل أو بنظامٍ مطفأ تُتخطّى، وAI_ACCOUNTANT_WRITE=0 يوقف التشغيل كله', async () => {
  for (const over of [{ activatedAt: null }, { tenant: { accountingSuiteEnabled: false, accountingEnabled: true, aiAccountantEnabled: true } },
    { tenant: { accountingSuiteEnabled: true, accountingEnabled: false, aiAccountantEnabled: true } }]) {
    const w = world({ settings: { t1: over } });
    w.parent('p-001', scheduleFor({ base: '1200.00', months: 12 }));
    const r = await run(w, '2027-01-05T09:00:00Z');
    assert.equal(r.posted.length, 0, JSON.stringify(over));
    assert.equal(r.skippedTenants, 1);
  }
  // عَلَم «المحاسب الذكي» أُطفئ بعد أن صار قيد الدفع في الدفاتر: الإطفاء يستمر بحالة الدفاتر وحدها — وإلا بقي 115002
  // متضخّماً والمصروف ناقصاً كل شهر بلا أي تنبيه (قائمة القيود تختفي مع الميزة)
  const flagOff = world({ settings: { t1: { tenant: { accountingSuiteEnabled: true, accountingEnabled: true, aiAccountantEnabled: false } } } });
  flagOff.parent('p-001', scheduleFor({ base: '1200.00', months: 12 }));
  const rf = await run(flagOff, '2027-01-05T09:00:00Z');
  assert.deepEqual([rf.posted.map((p) => p.k), rf.skippedTenants], [[1, 2], 0]);
  assert.equal(amortEligible({ tenantId: 't1', activatedAt: new Date(), timezone: null, tenant: { accountingSuiteEnabled: true, accountingEnabled: true, aiAccountantEnabled: false } }), true);
  const none = world({ settings: { t1: null } });
  none.parent('p-001', scheduleFor({ base: '1200.00', months: 12 }));
  assert.equal((await run(none, '2027-01-05T09:00:00Z')).posted.length, 0);
  assert.equal(amortEligible(undefined), false);
  const w = world();
  w.parent('p-001', scheduleFor({ base: '1200.00', months: 12 }));
  const off = await run(w, '2027-01-05T09:00:00Z', { AI_ACCOUNTANT_WRITE: '0' });
  assert.equal(off.disabled, true);
  assert.equal(w.posts.length, 0);
  // صفّ PREPAID بجدولٍ تالف يُتخطّى بلا رمي، وصفحاتٌ متعددة تُقرأ كلها
  const many = world();
  many.parent('p-001', scheduleFor({ base: '1200.00', months: 12 }));
  many.rows.push({ id: 'p-002', tenantId: 't1', kind: 'PREPAID', moveId: 'x', dateLocal: '2026-11-10', meta: { bad: true } });
  many.parent('p-003', scheduleFor({ base: '600.00', months: 6 }));
  const r = await run(many, '2026-12-02T09:00:00Z');
  assert.deepEqual(r.posted.map((p) => p.parentPostId), ['p-001', 'p-003']);
});

test('الفشل غير الفترة (حساب مؤرشف…) لا يوقف غيره ويُسجَّل؛ والمُجدول يُسجَّل من opsSchedule بسطرٍ واحد مع كنس المستندات', async () => {
  const w = world();
  w.parent('p-001', { ...scheduleFor({ base: '1200.00', months: 12 }), expenseCode: '999999' });
  w.parent('p-002', scheduleFor({ base: '1200.00', months: 12 }));
  const r = await run(w, '2026-12-02T09:00:00Z');
  assert.deepEqual(r.failed.map((f) => [f.parentPostId, f.code]), [['p-001', 'ACCOUNT_MISSING']]);
  assert.deepEqual(r.posted.map((p) => p.parentPostId), ['p-002']);
  const ops = fs.readFileSync(path.join(__dirname, '..', 'services', 'opsSchedule.ts'), 'utf8');
  assert.match(ops, /import\('\.\/aiAccountant\/amortization'\)\.then\(m => m\.startAiAccountantScheduler\(\)\)/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'aiAccountant', 'amortization.ts'), 'utf8');
  assert.match(src, /runDocsGc/);
  assert.doesNotMatch(src, /autoPostOn|state: 'DRAFT'/, 'لا مسودات');
  assert.doesNotMatch(src, /sourceType: '/);
});

/** قاعدة القائمة فوق العالم المزيّف */
function listDb(w: ReturnType<typeof world>): AiPostsListDb {
  return ({
    aiAccountantPost: {
      findMany: async (a: { where: Row }) => {
        const wh = a.where;
        if (wh.parentPostId) return w.rows.filter((r) => r.tenantId === wh.tenantId && r.parentPostId && wh.parentPostId.in.includes(r.parentPostId));
        return w.rows.filter((r) => r.tenantId === wh.tenantId).map((r) => ({ adminName: null, moveNumber: null, summaryAr: '', createdAt: new Date(), amountMilli: 0n, dateLocal: '', ...r }));
      },
    },
    glMove: {
      findMany: async (a: { where: Row }) => {
        const wh = a.where;
        if (wh.reversedMoveId) return w.moves.filter((m) => m.tenantId === wh.tenantId && m.reversedMoveId && wh.reversedMoveId.in.includes(m.reversedMoveId)).map((m) => ({ reversedMoveId: m.reversedMoveId }));
        return w.moves.filter((m) => m.tenantId === wh.tenantId && wh.id.in.includes(m.id)).map((m) => ({ id: m.id, state: m.state, lines: m.lines }));
      },
    },
    glAccount: { findMany: async () => w.lc.accounts.map((x) => ({ id: x.id, code: x.code, name: x.name })) },
    glAttachment: { findMany: async () => [{ entityId: 'pm-p-001' }] },
  }) as unknown as AiPostsListDb;
}
