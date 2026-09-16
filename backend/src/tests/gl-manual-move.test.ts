// M2 — القيود اليدوية (DESIGN.md §6.1، §8.3، §10.1 صف M2: gl-manual-move.test.ts).
// الحسابات الرئيسية ممنوعة، الإقفال، الضريبة التلقائية، قبل التفعيل (المسار والجماعي والمجدول)، I7 للوصفات الآلية،
// نسخة «إعادة إلى مسودة» يدوية، وحذف المسودة (JE‑05b) بشروطه وكل‑شيء‑أو‑لا‑شيء — بلا قاعدة بيانات (مخزن مزيّف).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_ACTOR, type GlActor, type GlTx } from '../services/gl/audit';
import {
  AUTO_POST_ATTENTION_PREFIX, BULK_MOVE_IDS_LIMIT, postDraftsBatch, rejectionOf, runAutoPostTick,
  type AutoPostDb, type AutoPostTickDb, type PostDraftFn,
} from '../services/gl/autoPost';
import { toDbDate } from '../services/gl/dates';
import { buildManualMoveDraft, draftRowsFromMoveDraft, priceIncludeGrossAmounts, saveDraftMove, type ManualLineInput } from '../services/gl/draft';
import { assertManualDateOpen, lockScopeOfDraft } from '../services/gl/locks';
import { manualOwnership } from '../services/gl/resolve';
import { deleteDraftMove, deleteDraftMoves } from '../services/gl/reverse';
import { accountIdOf, journalIdOf, saContext, taxIdOf } from '../services/gl/testing/fixtures';
import { LedgerError, SOURCE_TYPES, isLedgerError, type BuildContext } from '../services/gl/types';
import { validateMove } from '../services/gl/validate';
import {
  assertLineRefsOwned, attachmentCapViolation, generatedLineFlags, isGeneratedTaxLabel, inlineDisposition, moveListWhere, sanitizeFileName,
  sniffAttachmentMime, ATTACHMENT_CAPS,
} from '../routes/ledger/moves';
import { typeChangeCrossesOffBalance } from '../routes/ledger/config';
import { EXPORT_IDS_MAX, exportIdsOf, exportRows } from '../routes/ledger/lists';

const ROOT = path.join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (rel: string) => strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** نص معالج مسار من سطر تسجيله حتى التسجيل التالي. */
function routeBody(file: string, method: string, route: string): string {
  const s = src(file);
  const start = s.indexOf(`router.${method}('${route}'`);
  assert.ok(start >= 0, `${file}: ${method.toUpperCase()} ${route} غير مسجّل`);
  const next = s.slice(start + 10).search(/\n(router\.(get|post|put|delete|patch)\(|export |async function |function |const )/);
  return next < 0 ? s.slice(start) : s.slice(start, start + 10 + next);
}
function fnBody(file: string, name: string): string {
  const s = src(file);
  const start = s.search(new RegExp(`(export )?(async )?function ${name}\\b`));
  assert.ok(start >= 0, `${file}: ${name} غير موجودة`);
  const rest = s.slice(start + 10);
  const next = rest.search(/\n(export |async function |function |router\.)/);
  return next < 0 ? rest : rest.slice(0, next);
}
function assertOrder(body: string, needles: string[], label: string) {
  let last = -1;
  for (const n of needles) {
    const idx = body.indexOf(n, last + 1);
    assert.ok(idx > last, `${label}: «${n}» مفقود أو خارج الترتيب`);
    last = idx;
  }
}

const TENANT = 't1';
const ACTOR: GlActor = { actorType: 'ADMIN', actorId: 'u1', actorName: 'مدير', impersonated: false };

function manual(ctx: BuildContext, lines: ManualLineInput[], date = '2026-09-10') {
  const journal = ctx.journals.byCode('MISC');
  assert.ok(journal, 'دفتر MISC في القالب');
  return buildManualMoveDraft({ journal, date, ref: 'R-1', narration: 'قيد يدوي', lines }, ctx);
}

// ═══ القواعد ═══

test('الحسابات الرئيسية ممنوعة يدوياً: المسودة تُحفظ بمخالفة LEDGER_CONTROL_ACCOUNT_MANUAL والترحيل يرفضها', () => {
  const ctx = saContext();
  const b = manual(ctx, [
    { accountId: accountIdOf('113001'), label: 'ذمة', debit: '50', customerId: 'c1', partnerName: 'عميل' },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '50' },
  ]);
  const issue = b.issues.find((i) => i.code === 'LEDGER_CONTROL_ACCOUNT_MANUAL');
  assert.ok(issue, 'مخالفة الحساب الرئيسي');
  assert.equal(issue.lineIndex, 0);
  assert.throws(() => validateMove(b.draft, ctx, { mode: 'MANUAL' }), (e: unknown) => isLedgerError(e, 'LEDGER_CONTROL_ACCOUNT_MANUAL') && e.httpStatus === 422);
  // القيد نفسه بلا حساب رئيسي صالح
  const ok = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '50' },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '50' },
  ]);
  assert.deepEqual(ok.issues, []);
  assert.doesNotThrow(() => validateMove(ok.draft, ctx, { mode: 'MANUAL' }));
});

test('الإقفال: قيد يدوي بتاريخ ضمن فترة مقفلة يُنبَّه في المسودة ويُرفض ترحيله بـLEDGER_PERIOD_LOCKED', () => {
  const ctx = saContext({ settings: { hardLockDate: '2026-06-30' } });
  const lines: ManualLineInput[] = [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '10' },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '10' },
  ];
  const locked = manual(ctx, lines, '2026-06-30');
  assert.equal(locked.lock.locked, true);
  const s = ctx.settings;
  const locks = { salesLockDate: s.salesLockDate, purchaseLockDate: s.purchaseLockDate, taxLockDate: s.taxLockDate, hardLockDate: s.hardLockDate };
  assert.throws(() => assertManualDateOpen('2026-06-30', locks, lockScopeOfDraft(locked.draft, ctx)), (e: unknown) => isLedgerError(e, 'LEDGER_PERIOD_LOCKED'));
  const open = manual(ctx, lines, '2026-07-01');
  assert.equal(open.lock.locked, false);
  assert.doesNotThrow(() => assertManualDateOpen('2026-07-01', locks, lockScopeOfDraft(open.draft, ctx)));
});

test('الضريبة التلقائية: ضريبة على سطر المصروف تولّد سطر ضريبة المدخلات ووعاءه، والقيد متوازن', () => {
  const ctx = saContext();
  const b = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '115' },
  ]);
  assert.deepEqual(b.issues, []);
  assert.deepEqual(b.generatedLineIndexes, [2]);
  const tax = b.draft.lines[2];
  assert.equal(tax.taxRole, 'TAX');
  assert.equal(tax.debitMilli, 15_000n);
  assert.equal(tax.taxBaseMilli, 100_000n);
  assert.equal(b.draft.lines[0].taxRole, 'BASE');
  assert.equal(b.totalDebitMilli, b.totalCreditMilli);
  const rows = draftRowsFromMoveDraft(b.draft, ctx, { tenantId: TENANT, journalId: journalIdOf('MISC'), actor: ACTOR });
  assert.equal(rows.lines[2].accountId, accountIdOf('116001'));
  assert.equal(rows.move.state, 'DRAFT');
  assert.equal(rows.move.number, null);
  assert.equal(rows.move.origin, 'MANUAL');
});

test('I4: سطر ضريبة يدوي على حساب VAT_IN بـtaxId وvatBox يُحفظ كما كُتب بلا توليد ضريبة عليه', () => {
  const ctx = saContext();
  const b = manual(ctx, [
    { accountId: accountIdOf('116001'), label: 'تسوية مدخلات', debit: '15', taxId: taxIdOf('S15_PURCH'), vatBox: 'SA_7' },
    { accountId: accountIdOf('112001'), label: 'مقابل', credit: '15' },
  ]);
  assert.equal(b.draft.lines.length, 2);
  assert.deepEqual(b.generatedLineIndexes, []);
  const t = b.draft.lines[0];
  assert.equal(t.taxRole, 'TAX');
  assert.equal(t.taxId, taxIdOf('S15_PURCH'));
  assert.equal(t.vatBox, 'SA_7');
  assert.equal(t.debitMilli, 15_000n);
  assert.equal(t.taxBaseMilli, null);
  assert.ok(!b.issues.some((i) => i.code === 'LEDGER_UNBALANCED'), JSON.stringify(b.issues));
  assert.ok(!b.issues.some((i) => i.reason === 'VAT_LINE_UNTAGGED'));
  assert.deepEqual(b.issues, []);
  // بوعاء صريح، ودور TAX مُرسَل بلا generated لا يُسقط السطر
  const withBase = manual(ctx, [
    { accountId: accountIdOf('116001'), label: 'تسوية', debit: '15', taxId: taxIdOf('S15_PURCH'), vatBox: 'SA_7', taxRole: 'TAX', taxBaseMilli: '100' },
    { accountId: accountIdOf('112001'), label: 'مقابل', credit: '15' },
  ]);
  assert.equal(withBase.draft.lines.length, 2);
  assert.equal(withBase.draft.lines[0].taxBaseMilli, 100_000n);
  assert.deepEqual(withBase.issues, []);
  // بلا مربع ⇒ مخالفة I4 تُعاد (لا تُبتلع)
  const untagged = manual(ctx, [
    { accountId: accountIdOf('116001'), label: 'تسوية', debit: '15', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('112001'), label: 'مقابل', credit: '15' },
  ]);
  assert.ok(untagged.issues.some((i) => i.reason === 'VAT_LINE_UNTAGGED'));
});

test('السطر المولَّد (generated=true) يُهمل ويُعاد توليده من سطر الوعاء', () => {
  const ctx = saContext();
  const first = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '115' },
  ]);
  assert.deepEqual(first.generatedLineIndexes, [2]);
  const g = first.draft.lines[2];
  // إعادة الحفظ بإرسال السطر المولَّد مع علمه (ومبلغ قديم خاطئ): يُسقط ويُعاد بالمبلغ الصحيح
  const again = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '115' },
    { accountId: String(g.accountId ?? accountIdOf('116001')), label: g.label, debit: '99', taxId: taxIdOf('S15_PURCH'), vatBox: 'SA_7', taxRole: 'TAX', generated: true },
  ]);
  assert.equal(again.draft.lines.length, 3);
  assert.deepEqual(again.generatedLineIndexes, [2]);
  assert.equal(again.draft.lines[2].debitMilli, 15_000n);
  assert.deepEqual(again.issues, []);
});

// ═══ قبل التفعيل ═══

function batchDb(activatedAt: Date | null) {
  const calls = { tx: 0 };
  const db: AutoPostDb = {
    glSettings: { findUnique: async () => ({ activatedAt }) },
    $transaction: async (fn) => { calls.tx++; return fn({} as GlTx); },
  };
  return { db, calls };
}

test('قبل التفعيل: /moves/post-drafts يعيد كل معرّف في rejected بـLEDGER_NOT_SETUP بلا أي معاملة ترحيل', async () => {
  const { db, calls } = batchDb(null);
  let posted = 0;
  const post: PostDraftFn = async () => { posted++; throw new Error('لا يُستدعى'); };
  const r = await postDraftsBatch(db, { tenantId: TENANT, actor: ACTOR, ids: ['m1', 'm2', 'm1', ' '], post });
  assert.deepEqual(r.posted, []);
  assert.deepEqual(r.rejected.map((x) => [x.id, x.code]), [['m1', 'LEDGER_NOT_SETUP'], ['m2', 'LEDGER_NOT_SETUP']]);
  assert.equal(calls.tx, 0);
  assert.equal(posted, 0);
  assert.equal(BULK_MOVE_IDS_LIMIT, 100);
});

test('بعد التفعيل: كل قيد في معاملة مستقلة، والمرفوض برمزه لا يُسقط غيره', async () => {
  const { db, calls } = batchDb(new Date('2026-09-01T00:00:00Z'));
  const post: PostDraftFn = async (_tx, o) => {
    if (o.moveId === 'bad') throw new LedgerError('LEDGER_UNBALANCED', { moveId: o.moveId });
    if (o.moveId === 'locked') throw new LedgerError('LEDGER_PERIOD_LOCKED', {});
    return { id: o.moveId, number: `MISC/2026/0000${o.moveId.length}`, journalId: 'j', date: '2026-09-10', originalDate: null, lateArrival: false, totalMilli: 1n, sequence: { journalId: 'j', prefix: 'MISC', periodKey: '2026', n: 1 }, auditSeq: 1 };
  };
  const r = await postDraftsBatch(db, { tenantId: TENANT, actor: ACTOR, ids: ['a', 'bad', 'locked', 'b'], post });
  assert.equal(calls.tx, 4);
  assert.deepEqual(r.posted.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(r.rejected.map((x) => [x.id, x.code]), [['bad', 'LEDGER_UNBALANCED'], ['locked', 'LEDGER_PERIOD_LOCKED']]);
  assert.throws(() => rejectionOf('x', new TypeError('غير متوقع')), TypeError);
});

/** مخزن مزيّف لدورة المجدول */
function tickDb(opts: {
  drafts: { id: string; tenantId: string; autoPostOn: string }[];
  settings: { tenantId: string; activatedAt: Date | null; timezone: string; suite: boolean }[];
}) {
  const flagged: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const audits: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async () => 0,
    glMove: { updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => { flagged.push(a); return { count: 1 }; } },
    glAuditLog: {
      findFirst: async () => null,
      create: async (a: { data: Record<string, unknown> }) => { audits.push(a.data); return { id: `a${audits.length}` }; },
    },
  } as unknown as GlTx;
  let lte: Date | null = null;
  const queries: Parameters<AutoPostTickDb['glMove']['findMany']>[0][] = [];
  const settingsOf = (tenantId: string) => opts.settings.find((x) => x.tenantId === tenantId);
  const db: AutoPostTickDb = {
    glMove: {
      findMany: async (a) => {
        queries.push(a);
        lte = a.where.autoPostOn.lte;
        assert.equal(a.where.state, 'DRAFT');
        assert.equal(a.where.number, null);
        const t = a.where.tenant;
        // يطبّق شرط الشركة كما تطبّقه Prisma: الميزة مفعّلة والدفاتر مفعّلة وactivatedAt غير فارغ
        const eligible = (tenantId: string) => {
          if (!t) return true;
          const st = settingsOf(tenantId);
          if (!st) return false;
          if (t.accountingSuiteEnabled === true && !st.suite) return false;
          if (t.glSettings?.is?.activatedAt?.not === null && st.activatedAt === null) return false;
          return true;
        };
        return opts.drafts
          .map((x) => ({ id: x.id, tenantId: x.tenantId, autoPostOn: toDbDate(x.autoPostOn) }))
          .filter((x) => x.autoPostOn <= a.where.autoPostOn.lte && eligible(x.tenantId))
          .sort((x, y) => (x.autoPostOn.getTime() - y.autoPostOn.getTime()) || x.id.localeCompare(y.id))
          .slice(0, a.take);
      },
    },
    glSettings: {
      findMany: async () => opts.settings.map((s) => ({
        tenantId: s.tenantId, activatedAt: s.activatedAt, timezone: s.timezone,
        tenant: { accountingSuiteEnabled: s.suite, accountingEnabled: true },
      })),
    },
    $transaction: async (fn) => fn(tx),
  };
  return { db, flagged, audits, queries, horizon: () => lte };
}

test('المجدول يتخطى مسودات autoPostOn لشركة بلا activatedAt أو بميزة مطفأة، ويرحّل ما حلّ تاريخه بتوقيت الشركة', async () => {
  const now = new Date('2026-09-15T22:30:00Z'); // 16 سبتمبر 01:30 بالرياض، و15 سبتمبر بـUTC
  const { db, flagged, audits } = tickDb({
    drafts: [
      { id: 'pre1', tenantId: 'pre', autoPostOn: '2026-09-01' },
      { id: 'off1', tenantId: 'off', autoPostOn: '2026-09-01' },
      { id: 'on-due', tenantId: 'on', autoPostOn: '2026-09-16' },
      { id: 'on-bad', tenantId: 'on', autoPostOn: '2026-09-02' },
      { id: 'on-race', tenantId: 'on', autoPostOn: '2026-09-03' },
      { id: 'utc-later', tenantId: 'utc', autoPostOn: '2026-09-16' },
    ],
    settings: [
      { tenantId: 'pre', activatedAt: null, timezone: 'Asia/Riyadh', suite: true },
      { tenantId: 'off', activatedAt: new Date('2026-08-01T00:00:00Z'), timezone: 'Asia/Riyadh', suite: false },
      { tenantId: 'on', activatedAt: new Date('2026-08-01T00:00:00Z'), timezone: 'Asia/Riyadh', suite: true },
      { tenantId: 'utc', activatedAt: new Date('2026-08-01T00:00:00Z'), timezone: 'UTC', suite: true },
    ],
  });
  const seen: { tenantId: string; moveId: string; actor: GlActor }[] = [];
  const post: PostDraftFn = async (_tx, o) => {
    seen.push({ tenantId: o.tenantId, moveId: o.moveId, actor: o.actor });
    if (o.moveId === 'on-bad') throw new LedgerError('LEDGER_CONTROL_ACCOUNT_MANUAL', {});
    if (o.moveId === 'on-race') throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { reason: 'RACE' });
    return { id: o.moveId, number: 'MISC/2026/00001', journalId: 'j', date: '2026-09-16', originalDate: null, lateArrival: false, totalMilli: 1n, sequence: { journalId: 'j', prefix: 'MISC', periodKey: '2026', n: 1 }, auditSeq: 1 };
  };
  const r = await runAutoPostTick(db, { now, post });
  assert.deepEqual(seen.map((s) => s.moveId).sort(), ['on-bad', 'on-due', 'on-race']);
  assert.ok(seen.every((s) => s.actor === SYSTEM_ACTOR));
  assert.deepEqual(r.posted.map((p) => p.id), ['on-due']);
  // الشركتان غير المؤهلتين مستبعدتان في الاستعلام نفسه، فلا تصلان إلى التخطي في الذاكرة
  assert.deepEqual(r.skippedTenants, []);
  assert.equal(r.notDue, 1); // utc-later: ما زال 15 سبتمبر بتوقيت UTC
  // الفشل غير العابر يوسم المسودة (بشرط المسودة) مع تدقيق؛ السباق لا يوسم
  assert.equal(flagged.length, 1);
  assert.deepEqual(flagged[0].where, { id: 'on-bad', tenantId: 'on', state: 'DRAFT', number: null });
  assert.equal(flagged[0].data.attentionReason, `${AUTO_POST_ATTENTION_PREFIX}LEDGER_CONTROL_ACCOUNT_MANUAL`);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'MOVE_UPDATE_DRAFT');
  assert.equal(audits[0].actorType, 'SYSTEM');
});

test('المجدول لا يتجمّد: 400 مسودة قديمة لشركة غير مفعّلة وأخرى مطفأة لا تحجب مسودة شركة مفعّلة مع limit=200', async () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const drafts: { id: string; tenantId: string; autoPostOn: string }[] = [];
  for (let i = 0; i < 200; i++) drafts.push({ id: `pre${String(i).padStart(3, '0')}`, tenantId: 'pre', autoPostOn: '2026-01-01' });
  for (let i = 0; i < 200; i++) drafts.push({ id: `off${String(i).padStart(3, '0')}`, tenantId: 'off', autoPostOn: '2026-01-01' });
  drafts.push({ id: 'on1', tenantId: 'on', autoPostOn: '2026-09-10' });
  const { db, queries } = tickDb({
    drafts,
    settings: [
      { tenantId: 'pre', activatedAt: null, timezone: 'Asia/Riyadh', suite: true },
      { tenantId: 'off', activatedAt: new Date('2026-08-01T00:00:00Z'), timezone: 'Asia/Riyadh', suite: false },
      { tenantId: 'on', activatedAt: new Date('2026-08-01T00:00:00Z'), timezone: 'Asia/Riyadh', suite: true },
    ],
  });
  const seen: string[] = [];
  const post: PostDraftFn = async (_tx, o) => {
    seen.push(o.moveId);
    return { id: o.moveId, number: 'MISC/2026/00001', journalId: 'j', date: '2026-09-10', originalDate: null, lateArrival: false, totalMilli: 1n, sequence: { journalId: 'j', prefix: 'MISC', periodKey: '2026', n: 1 }, auditSeq: 1 };
  };
  const r = await runAutoPostTick(db, { now, post, limit: 200 });
  assert.deepEqual(seen, ['on1']);
  assert.deepEqual(r.posted.map((p) => p.id), ['on1']);
  assert.equal(queries.length, 1);
  const t = queries[0].where.tenant;
  assert.equal(t.accountingSuiteEnabled, true);
  assert.equal(t.accountingEnabled, true);
  assert.deepEqual(t.glSettings, { is: { activatedAt: { not: null } } });
  assert.deepEqual(queries[0].orderBy, [{ autoPostOn: 'asc' }, { id: 'asc' }]);
});

test('حارس ثابت: فحص activatedAt في معالجات routes/ledger والمجدول لا في services/gl/post.ts', () => {
  assert.doesNotMatch(src('services/gl/post.ts'), /activatedAt/);
  const moves = 'routes/ledger/moves.ts';
  assertOrder(routeBody(moves, 'post', '/moves/:id/post'), ['assertLedgerActivated(tenantId)', 'postDraftMove(tx'], 'POST /moves/:id/post');
  assertOrder(fnBody(moves, 'assertLedgerActivated'), ['isLedgerActivated(', "'LEDGER_NOT_SETUP'"], 'assertLedgerActivated');
  assert.match(routeBody(moves, 'post', '/moves/post-drafts'), /postDraftsBatch\(/);
  assert.doesNotMatch(routeBody(moves, 'post', '/moves/post-drafts'), /postDraftMove\(/);
  for (const r of [['post', '/moves/:id/reverse'], ['post', '/moves/:id/reset-draft']] as const) {
    assertOrder(routeBody(moves, r[0], r[1]), ['assertReversalReason(', 'assertLedgerActivated(tenantId)', 'assertManualOwned(tx'], r[1]);
  }
  // الإنشاء والتحرير والحذف مسموحة قبل التفعيل
  for (const r of [['post', '/moves'], ['put', '/moves/:id'], ['delete', '/moves/:id'], ['post', '/moves/delete-drafts']] as const) {
    assert.doesNotMatch(routeBody(moves, r[0], r[1]), /assertLedgerActivated|isLedgerActivated/, `${r[0]} ${r[1]}`);
  }
  const auto = 'services/gl/autoPost.ts';
  assertOrder(fnBody(auto, 'postDraftsBatch'), ['isLedgerActivated(db', "'LEDGER_NOT_SETUP'", 'db.$transaction('], 'postDraftsBatch');
  assertOrder(fnBody(auto, 'runAutoPostTick'), ['if (!s?.activatedAt)', "'NOT_ACTIVATED'", 'db.$transaction('], 'runAutoPostTick');
  // المجدول مسجّل مع الجداول الدورية القائمة
  assertOrder(fnBody('services/opsSchedule.ts', 'startOpsScheduler'), ['startLedgerAutoPostScheduler()'], 'startOpsScheduler');
});

// ═══ I7 ═══

test('I7: كل وصفة آلية (origin=AUTO بأي sourceType، أو بمفتاح مصدر) مملوكة لمصدر، والقيد اليدوي حرّ', () => {
  for (const sourceType of SOURCE_TYPES) {
    const o = manualOwnership({ origin: 'AUTO', sourceType, sourceId: 'x1', moveSources: [{ sourceType, sourceId: 'x1' }], lineControlKinds: [] });
    assert.ok(o, sourceType);
    assert.deepEqual(o.reasons, ['AUTO_ORIGIN', 'SOURCE_TYPE', 'MOVE_SOURCE'], sourceType);
    // حتى لو فُقد sourceType على القيد العكسي، الأصل AUTO يكفي
    assert.ok(manualOwnership({ origin: 'AUTO', sourceType: null, sourceId: null, moveSources: 0, lineControlKinds: [] }));
  }
  // كل builder في M1 يصدر origin: 'AUTO'
  const builders = path.join(ROOT, 'services/gl/builders');
  for (const f of fs.readdirSync(builders).filter((x) => x.endsWith('.ts'))) {
    const c = strip(fs.readFileSync(path.join(builders, f), 'utf8'));
    if (!/kind: 'MOVE'/.test(c)) continue;
    assert.doesNotMatch(c, /origin: 'MANUAL'/, f);
    assert.match(c, /origin: 'AUTO'/, f);
  }
  assert.equal(manualOwnership({ origin: 'MANUAL', sourceType: null, sourceId: null, moveSources: 0, lineControlKinds: [null] }), null);
});

test('نسخة «إعادة إلى مسودة» origin=MANUAL بلا مصدر، والمعالج يستدعي resetDraft بعد assertManualOwned', () => {
  const reset = fnBody('services/gl/reverse.ts', 'resetDraft');
  assert.match(reset, /origin: 'MANUAL', sourceType: null, sourceId: null, sourceKey: null, sourceEvent: null/);
  assertOrder(routeBody('routes/ledger/moves.ts', 'post', '/moves/:id/reset-draft'), ['assertManualOwned(tx', 'resetDraft(tx'], 'reset-draft');
});

// ═══ مخزن مزيّف للمسودات ═══

interface FakeMove {
  id: string; tenantId: string; journalId: string; number: string | null; state: string; moveType: string; origin: string;
  date: Date; ref: string | null; narration: string | null; totalMilli: bigint; sourceType: string | null; sourceId: string | null;
  salesRepId: string | null; draftOfMoveId: string | null; autoPostOn: Date | null; postedAt: Date | null; secureSeq: number | null;
  lines: Record<string, unknown>[]; sources: { sourceKey: string; sourceType: string; sourceId: string; event: string }[];
  notes: { authorName: string | null; body: string; createdAt: Date }[];
  [k: string]: unknown;
}

function draftStore() {
  const moves = new Map<string, FakeMove>();
  let attachments: { id: string; tenantId: string; entityType: string; entityId: string; fileName: string; sha256: string; mimeType: string; sizeBytes: number }[] = [];
  const audits: Record<string, unknown>[] = [];
  const accounts = [{ id: accountIdOf('113001'), tenantId: TENANT, controlKind: 'AR' }, { id: accountIdOf('621004'), tenantId: TENANT, controlKind: null }];
  let n = 0;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? true : row[k] === v));
  const tx = {
    $executeRaw: async () => 0,
    glMove: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const m = [...moves.values()].find((x) => matches(x, where));
        return m ? structuredClone(m) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> & { lines: { create: Record<string, unknown>[] } } }) => {
        const id = `m${++n}`;
        const { lines, ...rest } = data;
        moves.set(id, { secureSeq: null, postedAt: null, sources: [], notes: [], ...(rest as object), id, lines: lines.create } as FakeMove);
        return { id };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const m of moves.values()) if (matches(m, where)) { Object.assign(m, data); count++; }
        return { count };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.state, 'DRAFT');
        assert.equal(where.number, null);
        let count = 0;
        for (const m of [...moves.values()]) if (matches(m, where)) { moves.delete(m.id); count++; }
        return { count };
      },
    },
    glMoveLine: {
      deleteMany: async ({ where }: { where: { moveId: string } }) => { const m = moves.get(where.moveId)!; const c = m.lines.length; m.lines = []; return { count: c }; },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { for (const l of data) moves.get(l.moveId as string)!.lines.push(l); return { count: data.length }; },
    },
    glAccount: {
      findMany: async ({ where }: { where: { tenantId: string; id: { in: string[] } } }) =>
        accounts.filter((a) => a.tenantId === where.tenantId && where.id.in.includes(a.id)),
    },
    glAttachment: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => attachments.filter((a) => matches(a, where)),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = attachments.length;
        attachments = attachments.filter((a) => !matches(a, where));
        return { count: before - attachments.length };
      },
    },
    glAuditLog: {
      findFirst: async () => (audits.length ? { seq: audits.length, hash: String(audits[audits.length - 1].hash) } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return { id: `a${audits.length}` }; },
    },
  };
  const put = (m: Partial<FakeMove> & { id: string }) => {
    moves.set(m.id, {
      tenantId: TENANT, journalId: journalIdOf('MISC'), number: null, state: 'DRAFT', moveType: 'ENTRY', origin: 'MANUAL',
      date: toDbDate('2026-09-10'), ref: null, narration: 'مسودة', totalMilli: 10_000n, sourceType: null, sourceId: null,
      salesRepId: null, draftOfMoveId: null, autoPostOn: null, postedAt: null, secureSeq: null,
      lines: [
        { seq: 0, accountId: accountIdOf('621004'), label: 'م', debitMilli: 10_000n, creditMilli: 0n },
        { seq: 1, accountId: accountIdOf('621004'), label: 'د', debitMilli: 0n, creditMilli: 10_000n },
      ],
      sources: [], notes: [], ...m,
    });
  };
  return {
    tx: tx as unknown as GlTx, moves, audits, put,
    addAttachment: (entityId: string) => attachments.push({ id: `f${attachments.length + 1}`, tenantId: TENANT, entityType: 'MOVE', entityId, fileName: 'x.pdf', sha256: 'aa', mimeType: 'application/pdf', sizeBytes: 10 }),
    attachments: () => attachments,
  };
}

test('قبل التفعيل: إنشاء المسودة وتحريرها وحذفها ينجح (لا فحص activatedAt في خدماتها)', async () => {
  const ctx = saContext();
  const s = draftStore();
  const lines: ManualLineInput[] = [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '115' },
  ];
  const rows = draftRowsFromMoveDraft(manual(ctx, lines).draft, ctx, { tenantId: TENANT, journalId: journalIdOf('MISC'), actor: ACTOR, autoPostOn: '2026-09-20' });
  const created = await saveDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, rows });
  assert.equal(created.created, true);
  assert.equal(s.moves.get(created.id)?.lines.length, 3);

  const edited = draftRowsFromMoveDraft(manual(ctx, [lines[0], { ...lines[1], credit: '115' }, { accountId: accountIdOf('621004'), label: 'صفر', debit: '0' }]).draft, ctx, { tenantId: TENANT, journalId: journalIdOf('MISC'), actor: ACTOR });
  const upd = await saveDraftMove(s.tx, { tenantId: TENANT, actor: ACTOR, rows: edited, moveId: created.id });
  assert.equal(upd.created, false);
  assert.equal(s.moves.get(created.id)?.lines.length, 4);

  s.addAttachment(created.id);
  await deleteDraftMove(s.tx, { tenantId: TENANT, moveId: created.id, actor: ACTOR });
  assert.equal(s.moves.has(created.id), false);
  assert.equal(s.attachments().length, 0, 'المرفقات تُحذف صراحةً');
  assert.deepEqual(s.audits.map((a) => a.action), ['MOVE_CREATE', 'MOVE_UPDATE_DRAFT', 'MOVE_DELETE_DRAFT']);
  const snap = s.audits[2].beforeJson as { attachments: { fileName: string; sha256: string }[] };
  assert.deepEqual(snap.attachments.map((a) => [a.fileName, a.sha256]), [['x.pdf', 'aa']]);
});

test('حذف المسودة (JE‑05b): المرحَّل ⇒ LEDGER_MOVE_NOT_DRAFT، والمصدر أو AUTO ⇒ LEDGER_SOURCE_OWNED_MOVE، والمستند ⇒ LEDGER_MOVE_DOCUMENT_OWNED', async () => {
  const s = draftStore();
  s.put({ id: 'posted', state: 'POSTED', number: 'MISC/2026/00001', postedAt: new Date() });
  s.put({ id: 'withSource', sources: [{ sourceKey: 'INVOICE:i1:POST', sourceType: 'INVOICE', sourceId: 'i1', event: 'POST' }] });
  s.put({ id: 'auto', origin: 'AUTO', sourceType: 'RECEIPT', sourceId: 'r1' });
  s.put({ id: 'docOwned' });
  s.put({ id: 'free' });
  const code = async (moveId: string, documentOwner?: Parameters<typeof deleteDraftMove>[1]['documentOwner']) => {
    try { await deleteDraftMove(s.tx, { tenantId: TENANT, moveId, actor: ACTOR, documentOwner }); return 'OK'; } catch (e) {
      if (isLedgerError(e)) return `${e.code}:${e.httpStatus}`;
      throw e;
    }
  };
  assert.equal(await code('posted'), 'LEDGER_MOVE_NOT_DRAFT:409');
  assert.equal(await code('withSource'), 'LEDGER_SOURCE_OWNED_MOVE:409');
  assert.equal(await code('auto'), 'LEDGER_SOURCE_OWNED_MOVE:409');
  assert.equal(await code('docOwned', async (_tx, _t, id) => (id === 'docOwned' ? 'GlVendorBill' : null)), 'LEDGER_MOVE_DOCUMENT_OWNED:409');
  await assert.rejects(deleteDraftMove(s.tx, { tenantId: 'other', moveId: 'free', actor: ACTOR }), (e: Error) => e.name === 'GlNotFoundError');
  assert.equal(await code('free'), 'OK');
  assert.deepEqual([...s.moves.keys()].sort(), ['auto', 'docOwned', 'posted', 'withSource']);
  assert.equal(s.audits.length, 1, 'المرفوض لا يُدقَّق ولا يحذف');
});

test('الحذف الجماعي كل شيء أو لا شيء: مرفوض واحد ⇒ لا يُحذف شيء ويُعاد السبب؛ وبدونه يُحذف الكل', async () => {
  const s = draftStore();
  s.put({ id: 'd1' });
  s.put({ id: 'd2' });
  s.put({ id: 'p1', state: 'POSTED', number: 'MISC/2026/00007', postedAt: new Date() });
  const r1 = await deleteDraftMoves(s.tx, { tenantId: TENANT, actor: ACTOR, ids: ['d1', 'p1', 'nope', 'd2'] });
  assert.deepEqual(r1.deleted, []);
  assert.deepEqual(r1.rejected.map((x) => [x.id, x.code]), [['p1', 'LEDGER_MOVE_NOT_DRAFT'], ['nope', 'NOT_FOUND']]);
  assert.equal(s.moves.size, 3);
  assert.equal(s.audits.length, 0);
  const r2 = await deleteDraftMoves(s.tx, { tenantId: TENANT, actor: ACTOR, ids: ['d1', 'd2', 'd1'] });
  assert.deepEqual(r2, { deleted: ['d1', 'd2'], rejected: [] });
  assert.deepEqual([...s.moves.keys()], ['p1']);
  assert.deepEqual(s.audits.map((a) => a.action), ['MOVE_DELETE_DRAFT', 'MOVE_DELETE_DRAFT']);
});

test('حارس ثابت: معاملة الحذف تحتوي glAttachment.deleteMany وتدقيق MOVE_DELETE_DRAFT، والمسار يلفّها بـ$transaction', () => {
  const del = fnBody('services/gl/reverse.ts', 'deleteDraftMove');
  assertOrder(del, ['acquirePostLock(tx', 'appendAudit(tx', "'MOVE_DELETE_DRAFT'", 'tx.glAttachment.deleteMany(', 'tx.glMove.deleteMany('], 'deleteDraftMove');
  const moves = 'routes/ledger/moves.ts';
  assertOrder(routeBody(moves, 'delete', '/moves/:id'), ["requireLedgerPermission('canPostJournals')", 'prisma.$transaction((tx) => deleteDraftMove(tx'], 'DELETE /moves/:id');
  assertOrder(routeBody(moves, 'post', '/moves/delete-drafts'), ["requireLedgerPermission('canPostJournals')", 'bulkIds(', 'prisma.$transaction((tx) => deleteDraftMoves(tx'], 'delete-drafts');
  assert.match(fnBody(moves, 'bulkIds'), /BULK_MOVE_IDS_LIMIT/);
});

// ═══ المسارات: الصلاحيات والفلاتر والمرفقات ═══

test('صلاحيات النقاط وفق ملحق أ: القراءة canViewLedger والكتابة canPostJournals، والتصدير بمحدده', () => {
  const moves = src('routes/ledger/moves.ts');
  const regs = [...moves.matchAll(/router\.(get|post|put|delete)\('([^']+)',\s*requireLedgerPermission\('(\w+)'\)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  const all = [...moves.matchAll(/router\.(get|post|put|delete)\(/g)];
  assert.equal(regs.length, all.length, 'كل مسار يبدأ بـrequireLedgerPermission');
  for (const r of regs) {
    const [method, , perm] = r.split(' ');
    assert.equal(perm, method === 'get' ? 'canViewLedger' : 'canPostJournals', r);
  }
  for (const needed of ['get /moves', 'get /moves/:id', 'post /moves', 'put /moves/:id', 'delete /moves/:id', 'post /moves/delete-drafts',
    'post /moves/post-drafts', 'post /moves/review', 'post /moves/:id/post', 'post /moves/:id/review', 'post /moves/:id/reverse',
    'post /moves/:id/reset-draft', 'post /moves/:id/notes', 'get /moves/:id/notes', 'post /moves/:id/attachments',
    'get /moves/:id/attachments', 'get /moves/:id/attachments/:attachmentId', 'get /items']) {
    assert.ok(regs.some((r) => r.startsWith(`${needed} `)), needed);
  }
  const lists = src('routes/ledger/lists.ts');
  assert.match(lists, /router\.post\('\/lists\/:list\/export', requireLedgerPermission\('canViewLedger'\), ledgerExportLimiter,/);
  assert.match(lists, /LEDGER_EXPORT_TOO_LARGE/);
  assert.match(lists, /action: 'EXPORT'/);
  assert.match(lists, /LIST_EXPORT_CAP = 50_000/);
  const saved = src('routes/ledger/savedFilters.ts');
  for (const m of saved.matchAll(/router\.(get|post|delete)\('[^']+',\s*requireLedgerPermission\('(\w+)'\)/g)) assert.equal(m[2], 'canViewLedger');
  assert.equal([...saved.matchAll(/router\.(get|post|delete)\(/g)].length, 3);
  assert.match(src('middleware/rateLimits.ts'), /export const ledgerExportLimiter = rateLimit\(\{[\s\S]*?limit: 20,/);
});

test('فلاتر قائمة القيود: معزولة بالشركة، والحالة والتاريخ والبحث والشريك', () => {
  const w = moveListWhere(TENANT, { state: 'POSTED,BOGUS', dateFrom: '2026-01-01', dateTo: '2026-01-31', search: 'MISC', customerId: 'c1', tenantId: 'evil' });
  assert.equal(w.tenantId, TENANT);
  assert.deepEqual(w.state, { in: ['POSTED'] });
  assert.deepEqual(w.date, { gte: toDbDate('2026-01-01'), lte: toDbDate('2026-01-31') });
  assert.equal((w.AND as unknown[]).length, 2);
  assert.throws(() => moveListWhere(TENANT, { dateFrom: '2026-13-01' }), (e: { status?: number }) => e.status === 400);
});

test('المرفقات: فحص البايتات الأولى، والسقوف (PDF 1MB، الصورة 400KB، 5MB شهرياً، 50MB إجمالاً)، وContent-Disposition: inline', () => {
  assert.equal(sniffAttachmentMime(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(sniffAttachmentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffAttachmentMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffAttachmentMime(Buffer.from('<html>')), null);
  assert.equal(sniffAttachmentMime(Buffer.from('%PDF')), null);
  const ok = { mimeType: 'application/pdf' as const, sizeBytes: 900_000, monthUsedBytes: 0, totalUsedBytes: 0 };
  assert.equal(attachmentCapViolation(ok), null);
  assert.equal(attachmentCapViolation({ ...ok, sizeBytes: ATTACHMENT_CAPS.pdfBytes + 1 })?.reason, 'FILE_TOO_LARGE');
  assert.equal(attachmentCapViolation({ ...ok, mimeType: 'image/jpeg', sizeBytes: 500_000 })?.reason, 'FILE_TOO_LARGE');
  assert.equal(attachmentCapViolation({ ...ok, monthUsedBytes: ATTACHMENT_CAPS.monthlyBytes - 100 })?.reason, 'MONTHLY_QUOTA');
  assert.equal(attachmentCapViolation({ ...ok, totalUsedBytes: ATTACHMENT_CAPS.totalBytes })?.reason, 'TOTAL_QUOTA');
  assert.equal(sanitizeFileName('../../etc/فاتورة"1".pdf', 'application/pdf'), 'فاتورة1.pdf');
  assert.equal(sanitizeFileName('', 'image/png'), 'attachment.png');
  assert.match(inlineDisposition('فاتورة.pdf'), /^inline; filename="_+\.pdf"; filename\*=UTF-8''/);
  const moves = src('routes/ledger/moves.ts');
  assert.match(moves, /'LEDGER_ATTACHMENT_QUOTA'/);
  assert.match(moves, /Content-Disposition', inlineDisposition\(/);
  assert.doesNotMatch(moves, /glAttachment\.findMany\(\s*\{(?![\s\S]{0,200}select:)/);
  assert.doesNotMatch(moves, /glAttachment(Blob)?\.(delete|deleteMany)\s*\(/, 'حذف المرفقات في معاملة حذف المسودة وحدها');
});

test('رفع المرفق يأخذ قفل الترحيل قبل قفل الحصة وقبل قراءة القيد (لا مرفق يتيم مع حذف متزامن)', () => {
  const body = routeBody('routes/ledger/moves.ts', 'post', '/moves/:id/attachments');
  assertOrder(body, ['prisma.$transaction(', 'acquirePostLock(tx, tenantId)', 'ATTACHMENT_LOCK_PREFIX', 'tx.glMove.findFirst(', 'tx.glAttachment.create('], 'upload');
  // الحذف يأخذ gl-post ثم يحذف المرفقات: الترتيب نفسه في المسارين
  assertOrder(fnBody('services/gl/reverse.ts', 'deleteDraftMove'), ['acquirePostLock(tx', 'tx.glAttachment.deleteMany('], 'deleteDraftMove');
});

// ═══ العزل: مراجع السطور (§9.4) ═══

function refDb(owned: Record<'customer' | 'glVendor' | 'salesRep' | 'product', { id: string; tenantId: string }[]>) {
  const calls: { model: string; where: { tenantId: string; id: { in: string[] } } }[] = [];
  const model = (name: keyof typeof owned) => ({
    findMany: async (a: { where: { tenantId: string; id: { in: string[] } }; select: { id: true } }) => {
      calls.push({ model: name, where: a.where });
      return owned[name].filter((r) => r.tenantId === a.where.tenantId && a.where.id.in.includes(r.id)).map((r) => ({ id: r.id }));
    },
  });
  return { db: { customer: model('customer'), glVendor: model('glVendor'), salesRep: model('salesRep'), product: model('product') }, calls };
}

test('مراجع السطور: عميل أو مورّد أو مندوب أو منتج لشركة أخرى ⇒ 404، وأي حساب تحليلي ⇒ 404 حتى نموذجه', async () => {
  const owned = {
    customer: [{ id: 'c1', tenantId: TENANT }, { id: 'cX', tenantId: 'other' }],
    glVendor: [{ id: 'v1', tenantId: TENANT }],
    salesRep: [{ id: 'r1', tenantId: TENANT }, { id: 'rX', tenantId: 'other' }],
    product: [{ id: 'p1', tenantId: TENANT }],
  };
  const notFound = (entity: string, id: string) => (e: Error & { entity?: string; id?: string }) => e.name === 'GlNotFoundError' && e.entity === entity && e.id === id;
  const ok = refDb(owned);
  await assert.doesNotReject(assertLineRefsOwned(ok.db, TENANT, [
    { customerId: ' c1 ', salesRepId: 'r1' }, { vendorId: 'v1', productId: 'p1' }, { customerId: 'c1' }, { customerId: '', salesRepId: null },
  ]));
  assert.equal(ok.calls.length, 4, 'استعلام واحد لكل نوع');
  assert.ok(ok.calls.every((c) => c.where.tenantId === TENANT));
  assert.deepEqual(ok.calls.find((c) => c.model === 'customer')?.where.id.in, ['c1']);

  await assert.rejects(assertLineRefsOwned(refDb(owned).db, TENANT, [{ customerId: 'cX' }]), notFound('Customer', 'cX'));
  await assert.rejects(assertLineRefsOwned(refDb(owned).db, TENANT, [{ salesRepId: 'rX' }]), notFound('SalesRep', 'rX'));
  await assert.rejects(assertLineRefsOwned(refDb(owned).db, TENANT, [{ vendorId: 'nope' }]), notFound('GlVendor', 'nope'));
  await assert.rejects(assertLineRefsOwned(refDb(owned).db, TENANT, [{ productId: 'p2' }]), notFound('Product', 'p2'));
  const analytic = refDb(owned);
  await assert.rejects(assertLineRefsOwned(analytic.db, TENANT, [{ analyticAccountId: 'an1' }]), notFound('GlAnalyticAccount', 'an1'));
  assert.equal(analytic.calls.length, 0);
  // السطر المولَّد يُهمل فلا يُفحص
  await assert.doesNotReject(assertLineRefsOwned(refDb(owned).db, TENANT, [{ customerId: 'cX', generated: true }]));
});

test('حارس ثابت: saveManualDraft يفحص الحسابات ثم مراجع السطور قبل البناء والحفظ (لا شيء يُحفظ عند الرفض)', () => {
  assertOrder(fnBody('routes/ledger/moves.ts', 'saveManualDraft'), [
    'prisma.$transaction(', 'lc.accountById.has(', 'assertLineRefsOwned(tx, tenantId, body.lines)', 'buildManualMoveDraft(', 'saveDraftMove(tx',
  ], 'saveManualDraft');
  assert.doesNotMatch(fnBody('routes/ledger/moves.ts', 'saveManualDraft'), /taxRole === 'TAX' \|\| l\.taxRole === 'MARKER'/);
});

// ═══ خيارات النموذج وعلم السطور المولَّدة ═══

test('GET /moves/options بصلاحية القراءة ومسجَّل قبل /moves/:id، بلا حقول البنك', () => {
  const moves = src('routes/ledger/moves.ts');
  const opt = moves.indexOf("router.get('/moves/options', requireLedgerPermission('canViewLedger')");
  const detail = moves.indexOf("router.get('/moves/:id',");
  assert.ok(opt >= 0 && detail > opt, 'options قبل :id');
  const body = routeBody('routes/ledger/moves.ts', 'get', '/moves/options');
  assert.match(body, /glJournal\.findMany\(\{\s*where: \{ tenantId \}/);
  assert.match(body, /glTax\.findMany\(\{\s*where: \{ tenantId \}/);
  // تحذير سطر الحساب الافتراضي لدفتر بنك في نموذج القيد يحتاجه
  assert.match(body, /useOutstandingAccounts: true/);
  assert.doesNotMatch(body, /iban|bankName/i);
});

test('generatedLineFlags: TAX/MARKER في الذيل بوعاء بالضريبة نفسها مولَّد، وسطر الضريبة اليدوي ليس مولَّداً', () => {
  const S = taxIdOf('S15_PURCH');
  const Z = taxIdOf('Z_PURCH');
  const ln = (taxRole: string | null, taxId: string | null, debit = 0n, credit = 0n, taxBaseMilli: bigint | null = null, accountId = 'a') =>
    ({ accountId, taxRole, taxId, debitMilli: debit, creditMilli: credit, taxBaseMilli });
  assert.deepEqual(generatedLineFlags([
    ln('BASE', S, 100_000n), ln(null, null, 0n, 115_000n), ln('TAX', S, 15_000n, 0n, 100_000n),
  ]), [false, false, true]);
  // سطر ضريبة يدوي وحده
  assert.deepEqual(generatedLineFlags([ln('TAX', S, 5_000n), ln(null, null, 0n, 5_000n)]), [false, false]);
  // سطر ضريبة يدوي بعد المولَّد لا يمكن أن يبنيه المحرك ⇒ يوقف المسح فلا يُعلَّم ما قبله
  assert.deepEqual(generatedLineFlags([
    ln('BASE', Z, 100_000n), ln(null, null, 0n, 100_000n), ln('MARKER', Z, 0n, 0n, 100_000n), ln('MARKER', Z, 0n, 0n, null),
  ]), [false, false, false, false]);

  const ctx = saContext();
  const fromBuild = (b: ReturnType<typeof manual>) => {
    const rows = draftRowsFromMoveDraft(b.draft, ctx, { tenantId: TENANT, journalId: journalIdOf('MISC'), actor: ACTOR });
    return generatedLineFlags(rows.lines.map((l) => ({
      accountId: l.accountId, taxRole: l.taxRole ?? null, taxId: l.taxId ?? null,
      debitMilli: BigInt(l.debitMilli as bigint), creditMilli: BigInt(l.creditMilli as bigint),
      taxBaseMilli: l.taxBaseMilli == null ? null : BigInt(l.taxBaseMilli as bigint),
    })));
  };
  const idx = (flags: boolean[]) => flags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  // من البناء الفعلي: فهارس generatedLineIndexes نفسها
  const b = manual(ctx, [
    { accountId: accountIdOf('116001'), label: 'تسوية', debit: '5', taxId: S, vatBox: 'SA_7' },
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: S },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '120' },
  ]);
  assert.deepEqual(idx(fromBuild(b)), b.generatedLineIndexes);
  assert.deepEqual(b.issues, []);

  // خطر تكرار الضريبة أو إسقاط اليدوي: سطر ضريبة يدوي بالضريبة نفسها آخر سطور المستخدم (ملاصق للمولَّد)
  const tail = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: S },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '120' },
    { accountId: accountIdOf('116001'), label: 'تسوية', debit: '5', taxId: S, vatBox: 'SA_7' },
  ]);
  assert.deepEqual(tail.generatedLineIndexes, [3]);
  const flags = fromBuild(tail);
  assert.deepEqual(idx(flags), [3], 'اليدوي (2) لا يُعلَّم مولَّداً');

  // إعادة الحفظ كما تفعل الواجهة: المولَّد يُحذف واليدوي يُرسَل ⇒ السطور نفسها بلا تكرار ولا فقد
  const resent = manual(ctx, tail.draft.lines.flatMap((l, i): ManualLineInput[] => (flags[i] ? [] : [{
    accountId: l.accountId as string, label: l.label,
    debit: (Number(l.debitMilli) / 1000).toString(), credit: (Number(l.creditMilli) / 1000).toString(),
    taxId: l.taxRole === 'BASE' || l.taxRole === 'TAX' ? l.taxId ?? null : null, vatBox: l.vatBox ?? null,
  }])));
  assert.equal(resent.draft.lines.length, tail.draft.lines.length);
  assert.deepEqual(resent.draft.lines.map((l) => [l.taxRole ?? null, l.debitMilli, l.creditMilli]), tail.draft.lines.map((l) => [l.taxRole ?? null, l.debitMilli, l.creditMilli]));
  assert.deepEqual(resent.issues, []);
});

// ═══ إعادة الحفظ كما يفعل GET ثم النموذج (priceInclude، والسطر اليدوي بوعاء السلة) ═══

/**
 * محاكاة الذهاب والإياب: البناء ⇒ الصفوف ⇒ GET (generatedLineFlags بالتسمية وpriceIncludeGrossAmounts) ⇒ جسم
 * النموذج (moveInputLines: المولَّد محذوف، المبلغ الشامل بدل الصافي لسطر الضريبة الشاملة غير المعدَّل، MARKER ووعاء اليدوي).
 */
function resaveFromStored(ctx: BuildContext, b: ReturnType<typeof manual>) {
  const rows = draftRowsFromMoveDraft(b.draft, ctx, { tenantId: TENANT, journalId: journalIdOf('MISC'), actor: ACTOR });
  const stored = rows.lines.map((l) => ({
    accountId: l.accountId, label: l.label ?? '', taxRole: l.taxRole ?? null, taxId: l.taxId ?? null,
    debitMilli: BigInt(l.debitMilli as bigint), creditMilli: BigInt(l.creditMilli as bigint),
    taxBaseMilli: l.taxBaseMilli == null ? null : BigInt(l.taxBaseMilli as bigint), vatBox: l.vatBox ?? null,
  }));
  const flags = generatedLineFlags(stored);
  const gross = priceIncludeGrossAmounts(stored, flags, (id) => ctx.taxes.byId(id), ctx.settings.currencyDecimals);
  const txt = (m: bigint) => (Number(m) / 1000).toString();
  const input = stored.flatMap((l, i): ManualLineInput[] => {
    if (flags[i]) return [];
    const g = gross[i];
    const manualTax = l.taxRole === 'TAX' || l.taxRole === 'MARKER';
    return [{
      accountId: l.accountId, label: l.label, taxId: l.taxId, vatBox: l.vatBox,
      debit: txt(g !== null && l.debitMilli > 0n ? g : l.debitMilli),
      credit: txt(g !== null && l.creditMilli > 0n ? g : l.creditMilli),
      ...(l.taxRole === 'MARKER' ? { taxRole: 'MARKER' as const } : {}),
      ...(manualTax && l.taxBaseMilli !== null ? { taxBaseMilli: txt(l.taxBaseMilli) } : {}),
    }];
  });
  return { flags, gross, input, rebuilt: manual(ctx, input) };
}

const shape = (b: ReturnType<typeof manual>) =>
  b.draft.lines.map((l) => [l.accountId ?? l.accountKey ?? null, l.taxRole ?? null, l.debitMilli, l.creditMilli, l.taxBaseMilli ?? null, l.vatBox ?? null]);

test('priceInclude: إعادة الحفظ والتكرار دون تعديل ثلاث مرات تعطي السطور نفسها وقيداً متوازناً (لا انكماش الوعاء)', () => {
  const ctx = saContext({ taxes: { S15_PURCH: { priceInclude: true } } });
  const S = taxIdOf('S15_PURCH');
  const first = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '1150', taxId: S },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '1150' },
  ]);
  assert.deepEqual(first.issues, []);
  assert.equal(first.draft.lines[0].debitMilli, 1_000_000n);
  assert.equal(first.draft.lines[2].debitMilli, 150_000n);
  let cur = first;
  for (let n = 0; n < 3; n++) {
    const r = resaveFromStored(ctx, cur);
    assert.equal(r.gross[0], 1_150_000n, 'المبلغ الشامل للوعاء المخزَّن');
    assert.deepEqual(shape(r.rebuilt), shape(first), `إعادة الحفظ ${n + 1}`);
    assert.equal(r.rebuilt.totalDebitMilli, r.rebuilt.totalCreditMilli);
    assert.deepEqual(r.rebuilt.issues, []);
    cur = r.rebuilt;
  }
  // التكرار (duplicate) يرسل الجسم نفسه ⇒ السطور نفسها
  assert.deepEqual(shape(manual(ctx, resaveFromStored(ctx, first).input)), shape(first));

  // كسور وعدة سطور في السلة نفسها (مرشّحان للوعاء نفسه): المجموع والوعاء كل سطر كما هما
  const multi = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'أ', debit: '1000.01', taxId: S },
    { accountId: accountIdOf('621004'), label: 'ب', debit: '0.07', taxId: S },
    { accountId: accountIdOf('621004'), label: 'ج', debit: '333.33', taxId: S },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '1333.41' },
  ]);
  assert.deepEqual(multi.issues, []);
  let m = multi;
  for (let n = 0; n < 3; n++) {
    const r = resaveFromStored(ctx, m);
    assert.deepEqual(shape(r.rebuilt), shape(multi), `سلة متعددة، إعادة الحفظ ${n + 1}`);
    m = r.rebuilt;
  }
  // غير الشاملة: لا مبلغ شامل (يُرسَل الصافي كما هو)
  const plain = saContext();
  const p = manual(plain, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '1000', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'صندوق', credit: '1150' },
  ]);
  assert.deepEqual(resaveFromStored(plain, p).gross, [null, null, null]);
});

test('generatedLineFlags: سطر ضريبة يدوي بوعاء يساوي وعاء السلة ملاصق للمولَّد لا يُعلَّم مولَّداً (لا يُحذف عند إعادة الحفظ)', () => {
  const ctx = saContext();
  const S = taxIdOf('S15_SALE');
  const b = manual(ctx, [
    { accountId: accountIdOf('411001'), label: 'مبيعات', credit: '1000', taxId: S },
    { accountId: accountIdOf('111001'), label: 'صندوق', debit: '1300' },
    { accountId: accountIdOf('212001'), credit: '150', taxId: S, vatBox: 'SA_1', taxBaseMilli: '1000' },
  ]);
  assert.deepEqual(b.generatedLineIndexes, [3]);
  assert.equal(b.totalDebitMilli, b.totalCreditMilli);
  const r = resaveFromStored(ctx, b);
  assert.deepEqual(r.flags, [false, false, false, true], 'اليدوي (2) ليس مولَّداً');
  assert.deepEqual(shape(r.rebuilt), shape(b));
  assert.equal(r.rebuilt.totalDebitMilli, r.rebuilt.totalCreditMilli);
  // حتى بتسمية تطابق تسمية التوليد: المفتاح المكرر يوقف المسح عند اليدوي
  const lookalike = manual(ctx, [
    { accountId: accountIdOf('411001'), label: 'مبيعات', credit: '1000', taxId: S },
    { accountId: accountIdOf('111001'), label: 'صندوق', debit: '1300' },
    { accountId: accountIdOf('212001'), label: String(b.draft.lines[3].label), credit: '150', taxId: S, vatBox: 'SA_1', taxBaseMilli: '1000' },
  ]);
  assert.deepEqual(resaveFromStored(ctx, lookalike).flags, [false, false, false, true]);
  // سطر يدوي في الذيل بلا مولَّد بعده وبتسمية المستخدم: لا يُعلَّم
  const tailOnly = generatedLineFlags([
    { accountId: 'r', label: 'مبيعات', taxRole: 'BASE', taxId: S, debitMilli: 0n, creditMilli: 1_000_000n, taxBaseMilli: null },
    { accountId: 'c', label: 'صندوق', taxRole: null, taxId: null, debitMilli: 1_150_000n, creditMilli: 0n, taxBaseMilli: null },
    { accountId: 'v', label: 'تسوية', taxRole: 'TAX', taxId: S, debitMilli: 0n, creditMilli: 150_000n, taxBaseMilli: 1_000_000n },
  ]);
  assert.deepEqual(tailOnly, [false, false, false]);
  assert.ok(isGeneratedTaxLabel('ضريبة المبيعات 15٪') && isGeneratedTaxLabel('وعاء مبيعات صفرية') && isGeneratedTaxLabel('ضريبة 7.5٪'));
  assert.ok(isGeneratedTaxLabel('ض (غير قابلة للخصم)') && isGeneratedTaxLabel('ض — مخرجات الاحتساب العكسي'));
  assert.ok(!isGeneratedTaxLabel('') && !isGeneratedTaxLabel('تسوية'));
});

// ═══ نوع الحساب وI8 ═══

test('I8: تغيير نوع حساب له قيود مرحّلة إلى off_balance أو منه ⇒ 409 TYPE_LOCKED_OFF_BALANCE بعد فحص السطور المرحّلة', () => {
  assert.equal(typeChangeCrossesOffBalance('expense', 'off_balance'), true);
  assert.equal(typeChangeCrossesOffBalance('off_balance', 'asset_current'), true);
  assert.equal(typeChangeCrossesOffBalance('expense', 'asset_current'), false);
  assert.equal(typeChangeCrossesOffBalance('off_balance', 'off_balance'), false);
  const body = routeBody('routes/ledger/config.ts', 'put', '/accounts/:id');
  assertOrder(body, [
    "'TYPE_LOCKED_SYSTEM'", 'typeChangeCrossesOffBalance(a.type, body.type)',
    'tx.glMoveLine.findFirst({ where: { tenantId, accountId: id, posted: true }', "'TYPE_LOCKED_OFF_BALANCE'", 'data.type = body.type',
  ], 'PUT /accounts/:id');
});

// ═══ تصدير القوائم ═══

test('تصدير القوائم: ids فارغة ⇒ لا صفوف (لا تصدير الكل)، وما فوق 1000 ⇒ 400 TOO_MANY_IDS لا اقتطاع', async () => {
  assert.equal(exportIdsOf(undefined), 'ABSENT');
  assert.equal(exportIdsOf(null), 'ABSENT');
  assert.equal(exportIdsOf([]), 'EMPTY');
  assert.equal(exportIdsOf(['', '  ']), 'EMPTY');
  assert.equal(exportIdsOf(''), 'EMPTY');
  assert.deepEqual(exportIdsOf(['a', ' b ', 'a']), ['a', 'b']);
  const many = Array.from({ length: EXPORT_IDS_MAX + 1 }, (_, i) => `id${i}`);
  assert.throws(() => exportIdsOf(many), (e: { status?: number; details?: { reason?: string; max?: number } }) => e.status === 400 && e.details?.reason === 'TOO_MANY_IDS' && e.details.max === 1000);
  assert.equal((exportIdsOf(many.slice(0, 1000)) as string[]).length, 1000);
  // الفارغ يعود قبل أي استعلام
  for (const list of ['moves', 'items', 'accounts'] as const) assert.deepEqual(await exportRows(TENANT, list, { ids: [] }), []);
  const lists = src('routes/ledger/lists.ts');
  assert.match(lists, /selected: selection !== 'ABSENT'/);
  assertOrder(routeBody('routes/ledger/lists.ts', 'post', '/lists/:list/export'), ['exportIdsOf(q.ids)', 'exportRows(', "action: 'EXPORT'"], 'export');
});
