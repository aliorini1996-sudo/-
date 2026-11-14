// «ربط الدفاتر» L9 مبسّط (B1): تحويل الدفاتر اليدوية المفعّلة إلى مربوطة من تاريخ بدئها — services/gl/linking/activate.ts بلا قاعدة.
//   ١) التحويل يحفظ الافتتاح ولا يحذف قيداً ولا يعدّله: LINKED/FROM_ACTIVATION، linkedFrom = cutoverDate، اللقطة = openingSnapshotAt،
//      RUNNING، مؤشّرات المربوطة (skipDuplicates) والجرد المستمر من linkedFrom لمخزون الشركة المفعّل.
//   ٢) القيود اليدوية المكرّرة (منذ linkedFrom وتمسّ حساباً يرحّله النظام) تُعكس بتاريخها الأصلي، وغيرها يبقى.
//   ٣) بلا إقرار ⇒ 409 LINKING_DUPLICATES_ACK بلا أي كتابة. ٤) غير اليدوية ⇒ لا تحويل (والتفعيل الجديد كما هو).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LINKING_AUDIT_DUPLICATE, LINKING_AUDIT_ENABLE, LINKING_DUPLICATES_ACK_CODE, LINKING_DUPLICATE_REASON,
  conversionPreconditions, conversionStatus, convertManualBooks, findLinkingDuplicates, isAutoPostedAccount, linkingCommitHooks,
  type ConvertDeps, type ConvertInput,
} from '../services/gl/linking/activate';
import { isAuditAction } from '../services/gl/audit';
import type { MoveDraft } from '../services/gl/types';
import type { LedgerContext } from '../services/gl/resolve';
import type { PostMoveOptions, PostedMove } from '../services/gl/post';

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const T0 = new Date('2026-03-01T09:30:00.000Z');

const ACCOUNTS = [
  { id: 'a-bank', code: '111101', controlKind: null },
  { id: 'a-ar', code: '113001', controlKind: 'AR' },
  { id: 'a-rev', code: '411001', controlKind: null },
  { id: 'a-vat', code: '212001', controlKind: null },
  { id: 'a-rent', code: '521001', controlKind: null },
  { id: 'a-cap', code: '311001', controlKind: null },
];

interface FakeMove {
  id: string; number: string; date: Date; state: string; origin: string; sourceType: string | null; moveType: string;
  reversedMoveId: string | null; reversal: { id: string } | null; ref: string | null; narration: string | null; totalMilli: bigint;
  lines: { accountId: string; debitMilli: bigint; creditMilli: bigint }[];
}
const mv = (id: string, date: string, lines: [string, bigint, bigint][], over: Partial<FakeMove> = {}): FakeMove => ({
  id, number: `JE/2026/${id}`, date: day(date), state: 'POSTED', origin: 'MANUAL', sourceType: null, moveType: 'ENTRY',
  reversedMoveId: null, reversal: null, ref: null, narration: `قيد ${id}`, totalMilli: lines.reduce((s, l) => s + l[1], 0n),
  lines: lines.map(([accountId, debitMilli, creditMilli]) => ({ accountId, debitMilli, creditMilli })), ...over,
});

const MOVES: FakeMove[] = [
  // افتتاح المحاسب القديم: يبقى كما هو
  mv('open', '2026-02-28', [['a-bank', 50_000_000n, 0n], ['a-ar', 20_000_000n, 0n], ['a-cap', 0n, 70_000_000n]], { moveType: 'OPENING', origin: 'AUTO', number: 'OPEN/2026/0001' }),
  // مبيعات يدوية بعد تاريخ البدء: مكرّرة (الإيراد والضريبة والذمم يرحّلها النظام)
  mv('sale', '2026-03-05', [['a-ar', 1_150_000n, 0n], ['a-rev', 0n, 1_000_000n], ['a-vat', 0n, 150_000n]]),
  // تحصيل يدوي على الذمم: مكرّر
  mv('coll', '2026-04-10', [['a-bank', 1_150_000n, 0n], ['a-ar', 0n, 1_150_000n]]),
  // إيجار من البنك: لا يمسّ حساباً آلياً ⇒ يبقى
  mv('rent', '2026-04-01', [['a-rent', 3_000_000n, 0n], ['a-bank', 0n, 3_000_000n]]),
  // مبيعات قبل تاريخ البدء ⇒ خارج النافذة
  mv('old', '2026-02-20', [['a-ar', 500_000n, 0n], ['a-rev', 0n, 500_000n]]),
  // معكوس سلفاً، وقيد عاكس، ومسودة، وقيد مستند مالك، وإقفال ضريبي ⇒ كلها تبقى
  mv('done', '2026-05-01', [['a-ar', 100_000n, 0n], ['a-rev', 0n, 100_000n]], { reversal: { id: 'done-rev' } }),
  mv('done-rev', '2026-05-01', [['a-rev', 100_000n, 0n], ['a-ar', 0n, 100_000n]], { reversedMoveId: 'done' }),
  mv('draft', '2026-05-02', [['a-ar', 100_000n, 0n], ['a-rev', 0n, 100_000n]], { state: 'DRAFT' }),
  mv('bill', '2026-05-03', [['a-rev', 100_000n, 0n], ['a-bank', 0n, 100_000n]], { sourceType: 'BILL' }),
  mv('taxc', '2026-06-30', [['a-vat', 150_000n, 0n], ['a-bank', 0n, 150_000n]], { moveType: 'TAX_CLOSING' }),
];

/** معاملة مزيّفة تقيّم مسند findLinkingDuplicates على MOVES وتسجّل كل نداء — أي حذف أو تعديل قيد يُرمى */
function fakeTx(o: { name?: string; warehouseEnabled?: boolean } = {}) {
  const calls: string[] = [];
  const writes: Record<string, unknown[]> = {};
  const rec = (k: string, a: unknown) => { calls.push(k); (writes[k] ??= []).push(a); };
  const forbid = (k: string) => () => { throw new Error(`كتابة ممنوعة: ${k}`); };
  type W = { tenantId: string; state: string; origin: string; sourceType: null; moveType: { notIn: string[] }; reversedMoveId: null; date: { gte: Date }; lines: { some: { accountId: { in: string[] } } } };
  const tx = {
    companySettings: { findUnique: async () => { calls.push('companySettings.findUnique'); return { name: o.name ?? 'شركة النور' }; } },
    invoice: { groupBy: async () => { calls.push('invoice.groupBy'); return [{ currency: 'SAR', _count: { _all: 3 } }]; } },
    glAccount: {
      findMany: async () => { calls.push('glAccount.findMany'); return ACCOUNTS; },
      updateMany: async (a: unknown) => { rec('glAccount.updateMany', a); return { count: 1 }; },
    },
    glMove: {
      findMany: async (a: { where: W }) => {
        calls.push('glMove.findMany');
        const w = a.where;
        return MOVES.filter((m) => m.state === w.state && m.origin === w.origin && m.sourceType === w.sourceType && !w.moveType.notIn.includes(m.moveType)
          && m.reversedMoveId === null && m.reversal === null && m.date >= w.date.gte && m.lines.some((l) => w.lines.some.accountId.in.includes(l.accountId)));
      },
      delete: forbid('glMove.delete'), deleteMany: forbid('glMove.deleteMany'), update: forbid('glMove.update'), updateMany: forbid('glMove.updateMany'),
    },
    glMoveLine: { delete: forbid('glMoveLine.delete'), deleteMany: forbid('glMoveLine.deleteMany'), update: forbid('glMoveLine.update'), updateMany: forbid('glMoveLine.updateMany') },
    tenant: { findUnique: async () => { calls.push('tenant.findUnique'); return { warehouseEnabled: o.warehouseEnabled ?? false }; } },
    glSettings: {
      update: async (a: { data: Record<string, unknown> }) => { rec('glSettings.update', a); return { id: 's1', timezone: 'Asia/Riyadh', linkBasis: a.data.linkBasis, ...a.data }; },
      findUnique: async () => ({ setupMethod: 'CLEAN', activatedAt: T0, cutoverDate: day('2026-03-01') }),
    },
    glSyncCursor: { createMany: async (a: unknown) => { rec('glSyncCursor.createMany', a); return { count: 1 }; } },
  };
  return { tx: tx as never, calls, writes };
}

function fakeDeps() {
  const posts: { draft: MoveDraft; opts: PostMoveOptions }[] = [];
  const audits: { action: string; summary: string }[] = [];
  const deps: ConvertDeps = {
    requireMoveRecord: (async (_tx: unknown, _t: string, id: string) => {
      const m = MOVES.find((x) => x.id === id)!;
      return {
        ...m, originalDate: null, lateArrival: false, needsAttention: false, attentionReason: null, customerId: null, vendorId: null, salesRepId: null,
        sourceId: null, currencyCode: 'SAR', currencyDecimals: 2, journal: { code: 'MISC', systemKey: null },
        lines: m.lines.map((l) => ({
          ...l, label: null, customerId: null, vendorId: null, salesRepId: null, partnerName: null, analyticAccountId: null, productId: null,
          quantity: null, taxId: null, taxRole: null, taxBaseMilli: null, vatBox: null, vatAdjustment: false, dueDate: null,
        })),
      };
    }) as never,
    postMove: (async (_tx: unknown, draft: MoveDraft, opts: PostMoveOptions): Promise<PostedMove> => {
      posts.push({ draft, opts });
      return { id: `rev-${opts.reversedMoveId}`, number: `REV/${opts.reversedMoveId}`, date: draft.date } as PostedMove;
    }) as ConvertDeps['postMove'],
    loadContext: async () => ({}) as LedgerContext,
    appendAudit: (async (_tx: unknown, a: { action: string; summary: string }) => { audits.push(a); return {} as never; }) as never,
  };
  return { deps, posts, audits };
}

const BEFORE = {
  setupMethod: 'CLEAN', activatedAt: T0, cutoverDate: day('2026-03-01'), openingSnapshotAt: T0, currency: 'SAR', receiptRouting: null,
} as ConvertInput['before'];
const INPUT: ConvertInput = {
  tenantId: 't1', before: BEFORE, companyCurrency: 'SAR', typedCompanyName: 'شركة النور', reverseDuplicates: true,
  actor: { actorType: 'USER', actorId: 'owner' } as never, actorId: 'owner', dbNow: new Date('2026-11-14T08:00:00.000Z'),
};

test('المكرّرة: منذ linkedFrom وتمسّ حساباً آلياً (نوع تحكّم/إيراد/ضريبة) — الافتتاح والإيجار وما قبل البدء والمعكوس والمسودة والمستند والإقفال تبقى', async () => {
  assert.equal(isAutoPostedAccount({ code: '411001', controlKind: null }), true);
  assert.equal(isAutoPostedAccount({ code: '212001', controlKind: null }), true);
  assert.equal(isAutoPostedAccount({ code: '114001', controlKind: null }), true);
  assert.equal(isAutoPostedAccount({ code: '211002', controlKind: null }), true);
  assert.equal(isAutoPostedAccount({ code: '111101', controlKind: null }), false);
  assert.equal(isAutoPostedAccount({ code: '999999', controlKind: 'CUSTODY' }), true);
  const { tx } = fakeTx();
  const d = await findLinkingDuplicates(tx, 't1', '2026-03-01');
  assert.deepEqual(d.map((x) => [x.id, x.date, x.totalMilli]), [['sale', '2026-03-05', '1150000'], ['coll', '2026-04-10', '1150000']]);
});

test('التحويل يحفظ الافتتاح ولا يحذف قيداً: LINKED من تاريخ البدء بلقطته، RUNNING، مؤشّرات المربوطة، والمكرّر يُعكس بتاريخه', async () => {
  const { tx, writes, calls } = fakeTx({ warehouseEnabled: true });
  const { deps, posts, audits } = fakeDeps();
  const r = await convertManualBooks(tx, INPUT, deps);
  assert.ok('value' in r);
  // العكس: المكرّران وحدهما، بتاريخهما الأصلي، سطراً بسطر بالجانب المقلوب
  assert.deepEqual(posts.map((p) => [p.opts.reversedMoveId, p.draft.date]), [['sale', '2026-03-05'], ['coll', '2026-04-10']]);
  for (const p of posts) {
    assert.equal(p.opts.reversalReason, LINKING_DUPLICATE_REASON);
    assert.equal(p.opts.lockPolicy, 'REJECT');
    assert.equal(p.opts.validationMode, 'SYSTEM');
    assert.equal(p.opts.auditAction, LINKING_AUDIT_DUPLICATE);
  }
  assert.deepEqual(posts[0].draft.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli]), [
    ['a-ar', 0n, 1_150_000n], ['a-rev', 1_000_000n, 0n], ['a-vat', 150_000n, 0n],
  ]);
  assert.deepEqual(r.value.reversed.map((x) => x.originalId), ['sale', 'coll']);
  // الإعدادات: لا مسّ لـactivatedAt/cutoverDate/openingSnapshotAt
  const data = (writes['glSettings.update'][0] as { data: Record<string, unknown> }).data;
  assert.equal(data.setupMethod, 'LINKED');
  assert.equal(data.linkBasis, 'FROM_ACTIVATION');
  assert.deepEqual(data.linkedFrom, day('2026-03-01'));
  assert.deepEqual(data.linkSnapshotAt, T0);
  assert.equal(data.backfillState, 'RUNNING');
  assert.equal(data.linkedBy, 'owner');
  assert.equal(data.inventoryMode, 'PERPETUAL');
  assert.deepEqual(data.perpetualFromDate, day('2026-03-01'));
  assert.ok(data.receiptRouting, 'توجيه الربط الافتراضي حين لا توجيه محفوظاً');
  for (const k of ['activatedAt', 'cutoverDate', 'openingSnapshotAt', 'setupDraft']) assert.equal(k in data, false, k);
  // المؤشّرات: المربوطة وتُتخطّى القائمة؛ المُطابِق يبدأ من min(بداية يوم ما قبل البدء، T0)
  const cur = writes['glSyncCursor.createMany'][0] as { data: { source: string; watermarkAt: Date }[]; skipDuplicates: boolean };
  assert.equal(cur.skipDuplicates, true);
  assert.ok(cur.data.length > 0);
  assert.deepEqual(r.value.watermarkAt, new Date('2026-02-27T21:00:00.000Z'));
  assert.ok(cur.data.every((c) => c.watermarkAt.getTime() === r.value.watermarkAt.getTime()));
  assert.deepEqual(writes['glAccount.updateMany'], [{ where: { tenantId: 't1', code: '211002', controlKind: null }, data: { controlKind: 'GRNI' } }]);
  assert.deepEqual(audits.map((a) => a.action), [LINKING_AUDIT_ENABLE]);
  assert.equal(isAuditAction(LINKING_AUDIT_DUPLICATE), true);
  assert.equal(calls.some((c) => /delete|glMove\.update/.test(c)), false);
});

test('بلا إقرار ⇒ 409 LINKING_DUPLICATES_ACK بعددها وتاريخها وقائمتها — لا كتابة ولا عكس؛ وبلا مكرّر لا يلزم إقرار', async () => {
  const { tx, writes } = fakeTx();
  const { deps, posts } = fakeDeps();
  const r = await convertManualBooks(tx, { ...INPUT, reverseDuplicates: false }, deps);
  assert.ok('block' in r);
  assert.equal(r.block.status, 409);
  assert.equal(r.block.code, LINKING_DUPLICATES_ACK_CODE);
  assert.match(r.block.message, /2 قيداً يدوياً منذ 2026-03-01/);
  const det = r.block.details as { count: number; from: string; field: string; moves: { id: string }[] };
  assert.equal(det.count, 2);
  assert.equal(det.field, 'reverseDuplicates');
  assert.deepEqual(det.moves.map((m) => m.id), ['sale', 'coll']);
  assert.equal(posts.length, 0);
  assert.deepEqual(writes, {});
  // تاريخ بدء بعد آخر قيد مكرّر ⇒ لا مكرّر ⇒ يمرّ بلا إقرار
  const late = await conversionPreconditions(fakeTx().tx, { ...INPUT, reverseDuplicates: false, before: { ...BEFORE, cutoverDate: day('2026-07-01') } });
  assert.ok('plan' in late);
  assert.deepEqual(late.plan.duplicates, []);
});

test('الإقفال منذ تاريخ البدء ⇒ 409 LINKING_LOCKED برسالة واضحة قبل أي عكس، والاسم المخالف ⇒ 422', async () => {
  const locked = await conversionPreconditions(fakeTx().tx, { ...INPUT, before: { ...BEFORE, taxLockDate: day('2026-06-30') } });
  assert.ok('block' in locked);
  assert.equal(locked.block.code, 'LINKING_LOCKED');
  assert.match(locked.block.message, /تاريخ إقفال لا يسبق تاريخ بدء الدفاتر \(2026-03-01\)/);
  const before = await conversionPreconditions(fakeTx().tx, { ...INPUT, before: { ...BEFORE, hardLockDate: day('2026-02-28') } });
  assert.ok('plan' in before, 'إقفال ما قبل البدء لا يمنع');
  const name = await conversionPreconditions(fakeTx({ name: 'شركة أخرى' }).tx, INPUT);
  assert.ok('block' in name && name.block.code === 'LINKING_NAME_MISMATCH');
});

test('غير اليدوية كما هي: لا تحويل للمفعّلة بطريقة أخرى ولا لغير المفعّلة، والحالة غير قابلة للتحويل، والاعتماد يتفرّع للتحويل لليدوية وحدها', async () => {
  for (const b of [{ ...BEFORE, setupMethod: 'OPENING' }, { ...BEFORE, setupMethod: 'LINKED' }, { ...BEFORE, activatedAt: null }]) {
    const r = await conversionPreconditions(fakeTx().tx, { ...INPUT, before: b as ConvertInput['before'] });
    assert.ok('block' in r && r.block.code === 'LINKING_NOT_MANUAL');
  }
  const st = await conversionStatus(fakeTx().tx, 't1');
  assert.equal(st.convertible, true);
  assert.equal(st.linkedFrom, '2026-03-01');
  assert.equal(st.duplicates.count, 2);
  const none = await conversionStatus({ glSettings: { findUnique: async () => ({ setupMethod: 'OPENING', activatedAt: T0, cutoverDate: day('2026-01-01') }) } } as never, 't1');
  assert.deepEqual(none, { convertible: false, linkedFrom: null, duplicates: { count: 0, moves: [] } });
  // الخطّافات: الإقرار من الجسم وحده
  assert.equal(linkingCommitHooks('شركة').reverseDuplicates, false);
  assert.equal(linkingCommitHooks('شركة', { reverseDuplicates: true }).reverseDuplicates, true);
  // setup.ts: فرع التحويل مشروط بالدفاتر اليدوية المفعّلة (isManualBooks) وبالخطّافات، ويسبق كل حساب للافتتاح
  const s = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'setup.ts'), 'utf8');
  assert.match(s, /const converting = !!linking && !!before\?\.activatedAt && isManualBooks\(before\);/);
  const i = s.indexOf('if (converting && linking && before) {');
  assert.ok(i > 0 && i < s.indexOf('const draft = mergeDraft(parseStoredDraft(before?.setupDraft)'), 'التحويل قبل المسودة والافتتاح');
});
