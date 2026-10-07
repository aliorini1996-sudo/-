// «إعادة إلى مسودة» في مكانها (أمر المالك، ٧ أكتوبر ٢٠٢٦): القيد اليدوي المرحّل نفسه يعود مسودة برقمه — لا قيد عكسي ولا نسخة
// ولا رقم جديد — ويخرج أثره من الأرصدة حتى يُعاد ترحيله فيأخذ رقمه نفسه. بلا قاعدة بيانات: مخزنٌ مزيّف بالسياق السعودي الحقيقي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { GlActor, GlTx } from '../services/gl/audit';
import { toDbDate } from '../services/gl/dates';
import { buildManualMoveDraft, draftRowsFromMoveDraft, saveDraftMove, type ManualLineInput } from '../services/gl/draft';
import { postDraftMove, reusableSequenceNumber } from '../services/gl/post';
import type { LedgerContext } from '../services/gl/resolve';
import { deleteDraftMove, deleteDraftMoves, resetDraft } from '../services/gl/reverse';
import { formatMoveNumber, sequenceGroup } from '../services/gl/sequence';
import { accountIdOf, saContext } from '../services/gl/testing/fixtures';
import { isLedgerError, type BuildContext } from '../services/gl/types';

const TENANT = 't1';
const ACTOR: GlActor = { actorType: 'ADMIN', actorId: 'u1', actorName: 'مدير', impersonated: false };
const LINES: ManualLineInput[] = [
  { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100' },
  { accountId: accountIdOf('111001'), label: 'صندوق', credit: '100' },
];

const ledgerContext = (ctx: BuildContext): LedgerContext =>
  ({ ctx, settings: null, accounts: [], taxes: [], journals: [], accountById: new Map(), taxById: new Map(), journalById: new Map() });

function misc(ctx: BuildContext) {
  const j = ctx.journals.byCode('MISC');
  assert.ok(j, 'دفتر MISC في القالب');
  return j;
}
/** رقم القيد في مجموعة MISC لتاريخٍ ما كما يصوغه الترحيل */
function numberOf(ctx: BuildContext, date: string, n: number): string {
  const j = misc(ctx);
  const g = sequenceGroup({ journal: j, moveType: 'ENTRY', date });
  return formatMoveNumber(g.prefix, g.periodKey, j.sequenceReset, n);
}

interface Row { [k: string]: unknown; id: string; lines: Record<string, unknown>[] }

function store(ctx: BuildContext) {
  const moves = new Map<string, Row>();
  const audits: Record<string, unknown>[] = [];
  const balanceCalls: unknown[][] = [];
  const sequenceAllocations: unknown[] = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? true : row[k] === v));
  const j = misc(ctx);
  const tx = {
    // INSERT … ON CONFLICT في gl_period_balances: القيم [id، الشركة، الحساب، الفترة، مدين، دائن]
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => { if (values.length === 6) balanceCalls.push(values); return 1; },
    $queryRaw: async () => { sequenceAllocations.push(1); return [{ n: 41 }]; },
    glSequence: { upsert: async () => ({}) },
    glSettings: {
      findUnique: async () => ({
        tenantId: TENANT, templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh',
        fiscalYearEndMonth: 12, fiscalYearEndDay: 31, weekStartsOn: 0, cutoverDate: null, inventoryMode: 'PERIODIC',
        perpetualFromDate: null, salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null,
        taxPeriodicity: 'QUARTERLY', taxDeadlineRule: 'END_OF_NEXT_MONTH', taxDeadlineDays: null,
      }),
    },
    glMove: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const m = [...moves.values()].find((x) => matches(x, where));
        return m ? structuredClone(m) : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const m of moves.values()) if (matches(m, where)) { Object.assign(m, data); count++; }
        return { count };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const m of [...moves.values()]) if (matches(m, where)) { moves.delete(m.id); count++; }
        return { count };
      },
    },
    glMoveLine: {
      updateMany: async ({ where, data }: { where: { moveId: string }; data: Record<string, unknown> }) => {
        const m = moves.get(where.moveId)!;
        for (const l of m.lines) Object.assign(l, data);
        return { count: m.lines.length };
      },
      deleteMany: async ({ where }: { where: { moveId: string } }) => { const m = moves.get(where.moveId)!; const c = m.lines.length; m.lines = []; return { count: c }; },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const l of data) moves.get(l.moveId as string)!.lines.push({ ...l, posted: false, generated: l.generated ?? false });
        return { count: data.length };
      },
    },
    glAccount: { findMany: async () => [] },
    glJournal: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === j.id ? { id: j.id, code: j.code, sequenceReset: j.sequenceReset } : null) },
    glAttachment: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    glAuditLog: {
      findFirst: async () => (audits.length ? { seq: audits.length, hash: String(audits[audits.length - 1].hash) } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return { id: `a${audits.length}` }; },
    },
  };
  /** قيدٌ يدويٌّ مرحّل كما يتركه الترحيل: رقمه، وسطوره posted=true، وتاريخ ترحيله ومراجعته */
  const putPosted = (id: string, number: string, over: Record<string, unknown> = {}) => {
    moves.set(id, {
      id, tenantId: TENANT, journalId: j.id, journal: { id: j.id, code: j.code, systemKey: null, type: 'GENERAL', sequenceReset: j.sequenceReset },
      number, state: 'POSTED', moveType: 'ENTRY', origin: 'MANUAL', date: toDbDate('2026-10-04'), originalDate: null, lateArrival: false,
      ref: 'فاتورة كهرباء', narration: 'قيد يدوي', currencyCode: 'SAR', currencyDecimals: 2, totalMilli: 100_000n,
      customerId: null, vendorId: null, salesRepId: null, sourceType: null, sourceId: null, reversedMoveId: null, reversalReason: null,
      draftOfMoveId: null, autoPostOn: null, reviewState: 'REVIEWED', reviewedBy: 'u9', reviewedAt: new Date(), needsAttention: false,
      attentionReason: null, createdBy: 'u1', createdByImpersonated: false, postedAt: new Date('2026-10-04T05:12:00Z'), postedBy: 'u1',
      postedByImpersonated: false, secureSeq: null, secureHash: null, sources: [], notes: [], reversal: null,
      lines: [
        { seq: 0, accountId: accountIdOf('621004'), label: 'إيجار', debitMilli: 100_000n, creditMilli: 0n, taxRole: null, posted: true, generated: false },
        { seq: 1, accountId: accountIdOf('111001'), label: 'صندوق', debitMilli: 0n, creditMilli: 100_000n, taxRole: null, posted: true, generated: false },
      ],
      ...over,
    });
  };
  return { tx: tx as unknown as GlTx, moves, audits, balanceCalls, sequenceAllocations, putPosted };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'OK'; } catch (e) {
    if (isLedgerError(e)) return `${e.code}:${String((e.details as { reason?: string })?.reason ?? '')}`;
    throw e;
  }
};

test('الإعادة إلى مسودة: القيد نفسه يعود مسودة برقمه — لا قيد عكسي ولا نسخة — وتُطرح أرصدته وتُزال مراجعته', async () => {
  const ctx = saContext();
  const s = store(ctx);
  const number = numberOf(ctx, '2026-10-04', 17);
  s.putPosted('m17', number);
  const r = await resetDraft(s.tx, { tenantId: TENANT, moveId: 'm17', actor: ACTOR, reason: 'تصحيح المبلغ', context: ledgerContext(ctx) });
  assert.deepEqual(r, { draft: { id: 'm17', number } });
  assert.equal(s.moves.size, 1, 'لا قيد عكسي ولا نسخة مسودة');
  const m = s.moves.get('m17')!;
  assert.equal(m.state, 'DRAFT');
  assert.equal(m.number, number, 'الرقم كما كان');
  assert.equal(m.postedAt, null);
  assert.equal(m.reviewState, 'NONE');
  assert.ok(m.lines.every((l) => l.posted === false), 'سطوره خارج التقارير');
  // الأرصدة الشهرية: ما أضافه الترحيل يُطرح بالفترة نفسها
  assert.deepEqual(s.balanceCalls.map((c) => [c[2], c[3], c[4], c[5]]).sort(), [
    [accountIdOf('111001'), '2026-10', 0n, -100_000n],
    [accountIdOf('621004'), '2026-10', -100_000n, 0n],
  ]);
  assert.equal(s.audits.length, 1);
  assert.equal(s.audits[0].action, 'MOVE_RESET_DRAFT');
  assert.match(String(s.audits[0].summary), /إلى مسودة: تصحيح المبلغ/);
});

test('تعديل المسودة المُعادة ثم ترحيلها: الرقم نفسه بلا تسلسلٍ جديد، والأرصدة تعود؛ ونقلها خارج فترة رقمها يُرفض', async () => {
  const ctx = saContext();
  const lc = ledgerContext(ctx);
  const s = store(ctx);
  const number = numberOf(ctx, '2026-10-04', 17);
  s.putPosted('m17', number);
  await resetDraft(s.tx, { tenantId: TENANT, moveId: 'm17', actor: ACTOR, reason: 'تصحيح', context: lc });

  // تعديلٌ في المسودة (المبلغ) — الرقم لا يتغيّر بالتعديل
  const edited = draftRowsFromMoveDraft(buildManualMoveDraft({
    journal: misc(ctx), date: '2026-10-04', ref: 'فاتورة كهرباء', narration: 'قيد يدوي',
    lines: [{ ...LINES[0], debit: '120' }, { ...LINES[1], credit: '120' }],
  }, ctx).draft, ctx, { tenantId: TENANT, journalId: misc(ctx).id, actor: ACTOR });
  assert.deepEqual(await saveDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, rows: edited, moveId: 'm17' }), { id: 'm17', created: false });
  assert.equal(s.moves.get('m17')!.number, number);
  assert.equal(s.moves.get('m17')!.state, 'DRAFT');

  s.balanceCalls.length = 0;
  const posted = await postDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, moveId: 'm17', context: lc });
  assert.equal(posted.number, number, 'يُرحَّل برقمه كما كان');
  assert.equal(s.sequenceAllocations.length, 0, 'لا رقم جديد من التسلسل');
  const m = s.moves.get('m17')!;
  assert.equal(m.state, 'POSTED');
  assert.equal(m.number, number);
  assert.ok(m.lines.every((l) => l.posted === true));
  assert.deepEqual(s.balanceCalls.map((c) => [c[2], c[4], c[5]]).sort(), [
    [accountIdOf('111001'), 0n, 120_000n],
    [accountIdOf('621004'), 120_000n, 0n],
  ]);

  // مرّةً أخرى: نقلها إلى فترة ترقيمٍ أخرى يُرفض (لا رقم جديد ولا فجوة) — وتعديلٌ داخل فترتها يُقبل ويبقى الرقم
  await resetDraft(s.tx, { tenantId: TENANT, moveId: 'm17', actor: ACTOR, reason: 'تاريخ خاطئ', context: lc });
  const rowsAt = (date: string) => draftRowsFromMoveDraft(buildManualMoveDraft({ journal: misc(ctx), date, ref: null, narration: 'قيد يدوي', lines: LINES }, ctx).draft,
    ctx, { tenantId: TENANT, journalId: misc(ctx).id, actor: ACTOR });
  const farDate = numberOf(ctx, '2027-03-02', 17) === number ? null : '2027-03-02';
  if (farDate) {
    assert.equal(await codeOf(saveDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, rows: rowsAt(farDate), moveId: 'm17' })), 'LEDGER_MOVE_NOT_DRAFT:NUMBER_GROUP_CHANGED');
    assert.equal(s.moves.get('m17')!.date instanceof Date && (s.moves.get('m17')!.date as Date).toISOString().slice(0, 10), '2026-10-04', 'لم يُكتب شيء');
  }
  await saveDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, rows: rowsAt('2026-10-06'), moveId: 'm17' });
  const again = await postDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, moveId: 'm17', context: lc });
  assert.equal(again.number, number);
  assert.equal(s.sequenceAllocations.length, 0);
  assert.deepEqual(s.audits.map((a) => a.action), ['MOVE_RESET_DRAFT', 'MOVE_UPDATE_DRAFT', 'MOVE_POST', 'MOVE_RESET_DRAFT', 'MOVE_UPDATE_DRAFT', 'MOVE_POST']);
});

test('ما لا يُعاد إلى مسودة: المعكوس، والقيد العكسي، والمؤمَّن، والفترة المقفلة، والمسودة، والسبب الفارغ — بلا أي كتابة', async () => {
  const ctx = saContext();
  const s = store(ctx);
  s.putPosted('rev', numberOf(ctx, '2026-10-04', 1), { reversal: { id: 'r1', number: 'X' } });
  s.putPosted('isRev', numberOf(ctx, '2026-10-04', 2), { reversedMoveId: 'orig' });
  s.putPosted('sec', numberOf(ctx, '2026-10-04', 3), { secureSeq: 7 });
  s.putPosted('draft', numberOf(ctx, '2026-10-04', 4), { state: 'DRAFT', postedAt: null });
  s.putPosted('locked', numberOf(ctx, '2026-10-04', 5));
  s.putPosted('archived', numberOf(ctx, '2026-10-04', 6));
  const run = (moveId: string, c = ctx, reason = 'سبب') => codeOf(resetDraft(s.tx, { tenantId: TENANT, moveId, actor: ACTOR, reason, context: ledgerContext(c) }));
  assert.equal(await run('rev'), 'LEDGER_MOVE_NOT_DRAFT:ALREADY_REVERSED');
  assert.equal(await run('isRev'), 'LEDGER_MOVE_NOT_DRAFT:IS_REVERSAL');
  assert.equal(await run('sec'), 'LEDGER_SECURED_MOVE:');
  assert.equal(await run('draft'), 'LEDGER_MOVE_NOT_DRAFT:NOT_POSTED');
  assert.equal(await run('locked', saContext({ settings: { hardLockDate: '2026-10-31' } })), 'LEDGER_PERIOD_LOCKED:');
  assert.equal(await run('locked', ctx, '  '), 'LEDGER_REVERSAL_REASON_REQUIRED:');
  // حسابٌ أُرشف بعد الترحيل: لن يُرحَّل القيد كما هو ⇒ لا يُعاد (وإلا خرج أثره وعلق مسودةً لا تُحذف)
  assert.equal(await run('archived', saContext({ accounts: { '621004': { isActive: false } } })), 'LEDGER_ACCOUNT_ARCHIVED:ACCOUNT_ARCHIVED');
  assert.equal(s.audits.length, 0);
  assert.equal(s.balanceCalls.length, 0);
  assert.ok(['rev', 'isRev', 'sec', 'locked', 'archived'].every((id) => s.moves.get(id)!.state === 'POSTED'));
});

test('المسودة المُعادة لا تُحذف (رقمها لا يصير فجوة) — POSTED_BEFORE مفرداً وجماعياً', async () => {
  const ctx = saContext();
  const s = store(ctx);
  s.putPosted('m17', numberOf(ctx, '2026-10-04', 17));
  await resetDraft(s.tx, { tenantId: TENANT, moveId: 'm17', actor: ACTOR, reason: 'تصحيح', context: ledgerContext(ctx) });
  assert.equal(await codeOf(deleteDraftMove(s.tx, { tenantId: TENANT, moveId: 'm17', actor: ACTOR })), 'LEDGER_MOVE_NOT_DRAFT:POSTED_BEFORE');
  const bulk = await deleteDraftMoves(s.tx, { tenantId: TENANT, actor: ACTOR, ids: ['m17'] });
  assert.deepEqual(bulk.deleted, []);
  assert.deepEqual(bulk.rejected.map((x) => x.code), ['LEDGER_MOVE_NOT_DRAFT']);
  assert.equal(s.moves.has('m17'), true);
});

test('reusableSequenceNumber: الرقم يُعاد في مجموعته نفسها وحدها', () => {
  const ctx = saContext();
  const j = misc(ctx);
  const g = sequenceGroup({ journal: j, moveType: 'ENTRY', date: '2026-10-04' });
  const n17 = formatMoveNumber(g.prefix, g.periodKey, j.sequenceReset, 17);
  assert.equal(reusableSequenceNumber(n17, g, j.sequenceReset), 17);
  assert.equal(reusableSequenceNumber(null, g, j.sequenceReset), null);
  assert.equal(reusableSequenceNumber('', g, j.sequenceReset), null);
  assert.equal(reusableSequenceNumber('INV/2026/10/0017', g, j.sequenceReset), null, 'دفترٌ آخر');
  const unpadded = n17.replace(/\/\d+$/, '/17');
  if (unpadded !== n17) assert.equal(reusableSequenceNumber(unpadded, g, j.sequenceReset), null, 'حشوٌ مختلف لا يطابق');
  const other = sequenceGroup({ journal: j, moveType: 'ENTRY', date: '2025-03-04' });
  assert.equal(reusableSequenceNumber(n17, other, j.sequenceReset), null, 'فترةٌ أخرى');
});

test('حارس ثابت: المسار يعيد القيد نفسه (لا عكس ولا نسخة)، والواجهة تبقى عليه وتمنع حذفه', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
  const route = read('routes', 'ledger', 'moves.ts');
  const h = route.slice(route.indexOf("router.post('/moves/:id/reset-draft'"), route.indexOf("router.post('/moves/:id/reset-draft'") + 900);
  assert.match(h, /resetDraft\(tx, \{ tenantId, moveId, actor, reason \}\)/);
  assert.match(h, /res\.json\(\{ success: true, data: \{ draft: r\.draft \} \}\)/);
  assert.doesNotMatch(h, /reversal/);
  const form = read('..', '..', 'web-admin', 'src', 'pages', 'ledger', 'entries', 'MoveForm.tsx');
  assert.match(form, /return \{ msg: tr\('أُعيد القيد إلى مسودة برقمه'\), target: move\.id \};/);
  assert.match(form, /move\.origin === 'MANUAL' && !move\.number && !owned \? removeDraft : undefined/);
});
