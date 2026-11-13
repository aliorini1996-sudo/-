// «ربط الدفاتر» L1 — التقاط المبيعات التشغيليّ في مسار المناديب (الوكيل B2b):
//   • حذف المندوب (C18): سنداته تبقى بمرجعٍ مفرَّغ ومعرّفُه في Receipt.deletedSalesRepId — في الكتابة نفسها التي تفرّغ salesRepId،
//     وبعد حارس الدفاتر (assertRepDeletable أول ما في المعاملة)، وقبل حذف المندوب. فعهدة المندوب المحذوف تُعاد رجعياً بلا تخمين.
//   • قرار المالك OD1: حذف «استلام تحصيل» (RepSettlement — مستندٌ مرحَّل: نقل العهدة من المندوب إلى المستلم) في شركةٍ دفاترها
//     مربوطة (isLinked وحدها) ⇒ 409 BOOKS_LINKED_NO_DELETE قبل أي قفلٍ أو كتابة. اليدوية (CLEAN) وغير المفعّلة والقديمة: كما كانت.
// المعالجات الحقيقية من مكدّس الموجّه فوق Prisma مزيّف في الذاكرة (نمط rep-delete-van-history.test.ts) — لا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE } from '../services/booksMode';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ Prisma مزيّف ═══

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const T = 'T1';
let calls: string[] = [];
let gl: Row | null = null; // صفّ gl_settings للشركة (null = لم تُفعَّل الدفاتر يوماً)
let counts: Record<string, number> = {};
let state: { receipts: Row[]; settlements: Row[]; reps: Row[]; events: Row[]; notifications: Row[] } = {
  receipts: [], settlements: [], reps: [], events: [], notifications: [],
};

/** مطابقةٌ مسطّحة لشروط where البسيطة — شكلٌ لا يعرفه المزيّف يفشل صراحةً */
const flatMatch = (r: Row, where: Row = {}): boolean => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return (v.in as unknown[]).includes(r[k]);
    throw new Error(`شرطٌ لا يعرفه المزيّف: ${k}`);
  }
  return r[k] === v;
});

const scripted: Record<string, (a: any) => unknown> = {
  'glSettings.findUnique': () => (gl ? { ...gl } : null),
  'admin.findUnique': () => ({ role: 'ADMIN', tenantId: T, isActive: true, scopeEnabled: false, scopeMode: null }),
  'admin.findFirst': (a) => (a.where.id === 'U1' && a.where.tenantId === T ? { id: 'U1', name: 'سعد' } : null),
  'salesRep.findFirst': (a) => { const r = state.reps.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId); return r ? { id: r.id, name: r.name } : null; },
  'salesRep.delete': (a) => {
    state.reps = state.reps.filter((x) => x.id !== a.where.id);
    // كما أعلن المخطط: onDelete: SetNull — والمعرّف المحفوظ يكتبه المسار لا القاعدة
    for (const r of state.receipts) if (r.salesRepId === a.where.id) r.salesRepId = null;
    return {};
  },
  'receipt.updateMany': (a) => {
    let count = 0;
    for (const r of state.receipts) if (flatMatch(r, a.where)) { Object.assign(r, a.data); count++; }
    return { count };
  },
  'repSettlement.findFirst': (a) => {
    const r = state.settlements.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId && x.salesRepId === a.where.salesRepId);
    return r ? { ...r, team: null } : null;
  },
  'repSettlement.delete': (a) => { state.settlements = state.settlements.filter((x) => x.id !== a.where.id); return {}; },
  'repSettlement.aggregate': (a) => ({
    _sum: { amount: state.settlements.filter((x) => (!a.where.receivedByUserId || x.receivedByUserId === a.where.receivedByUserId)).reduce((s, x) => s + x.amount, 0) },
  }),
  'userSettlement.aggregate': () => ({ _sum: { amount: 0 } }),
  'receipt.aggregate': () => ({ _sum: { amount: 1000 } }),
  'invoice.aggregate': () => ({ _sum: { paidAmt: 0 } }),
  'glSourceEvent.createMany': (a) => { state.events.push(...a.data); return { count: a.data.length }; },
  'notification.create': (a) => { state.notifications.push(a.data); return a.data; },
  'aiRepSettings.findUnique': () => null,
};
function defaultFor(model: string, method: string): unknown {
  if (method === 'count') return counts[model] ?? 0;
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'aggregate') return { _sum: {} };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (a: unknown) => {
    calls.push(`${model}.${method}`);
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(a ?? {}) : defaultFor(model, method);
  },
});
const db: Row = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        calls.push('$transaction');
        const snap = structuredClone(state);
        try { return await fn(db); } catch (e) { state = snap; throw e; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (s: TemplateStringsArray) => { calls.push(`${key} ${Array.from(s).join('?').replace(/\s+/g, ' ').trim()}`); return key === '$queryRaw' ? [] : 1; };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const salesRepsModule = require('../routes/salesReps') as typeof import('../routes/salesReps');

function handlerOf(routePath: string): (req: Row, res: Row, next: (e?: unknown) => void) => Promise<void> {
  const layer = (salesRepsModule.default as unknown as { stack: Row[] }).stack
    .find((l) => l.route?.path === routePath && l.route.methods?.delete);
  assert.ok(layer, `مسار DELETE ${routePath} مفقود من salesReps`);
  return layer.route.stack[0].handle;
}
async function invoke(routePath: string, params: Row): Promise<{ status: number; body: Row | null }> {
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  let err: unknown;
  await handlerOf(routePath)({ params, query: {}, body: {}, headers: {}, user: { id: 'ADM', name: 'المدير', role: 'ADMIN', tenantId: T } }, res, (e?: unknown) => { err = e; });
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

function seed(o: { gl?: Row | null; counts?: Record<string, number> } = {}): void {
  calls = []; gl = o.gl ?? null; counts = o.counts ?? {};
  state = {
    reps: [{ id: 'R1', tenantId: T, name: 'أحمد' }, { id: 'R2', tenantId: T, name: 'خالد' }],
    receipts: [
      { id: 'rc1', tenantId: T, salesRepId: 'R1', deletedSalesRepId: null, amount: 500 },
      { id: 'rc2', tenantId: T, salesRepId: 'R1', deletedSalesRepId: null, amount: 250 },
      { id: 'rc3', tenantId: T, salesRepId: 'R2', deletedSalesRepId: null, amount: 100 },
      // شركةٌ أخرى بالمعرّف نفسه للمندوب — لا تُمسّ
      { id: 'rcX', tenantId: 'T2', salesRepId: 'R1', deletedSalesRepId: null, amount: 900 },
    ],
    settlements: [{
      id: 'S1', tenantId: T, salesRepId: 'R1', amount: 300, method: 'CASH', note: null, teamId: null, createdBy: 'المدير',
      receivedByUserId: 'U1', settledAt: new Date('2026-11-01T08:00:00Z'), createdAt: new Date('2026-11-01T08:00:01Z'),
    }],
    events: [], notifications: [],
  };
}

const ACTIVATED = new Date('2026-01-01T00:00:00Z');

// ═══ (١) حذف المندوب: Receipt.deletedSalesRepId ═══

test('حذف المندوب: سنداته تبقى بمرجعٍ مفرَّغ ومعرّفه في deletedSalesRepId — في الكتابة نفسها، وسندات غيره وشركةٍ أخرى كما هي', async () => {
  seed();
  const r = await invoke('/:id', { id: 'R1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true });
  const byId = (id: string) => state.receipts.find((x) => x.id === id)!;
  for (const id of ['rc1', 'rc2']) {
    assert.equal(byId(id).salesRepId, null, `${id}: المرجع مفرَّغ`);
    assert.equal(byId(id).deletedSalesRepId, 'R1', `${id}: المعرّف محفوظ`);
    assert.ok(state.receipts.some((x) => x.id === id), `${id}: السند باقٍ`);
  }
  assert.deepEqual([byId('rc3').salesRepId, byId('rc3').deletedSalesRepId], ['R2', null], 'سند مندوبٍ آخر لا يُمسّ');
  // شرط الشركة في الكتابة: سند شركةٍ أخرى لا يُكتب عليه المعرّف (تفريغ SetNull في المزيّف بالمعرّف وحده كالقاعدة)
  assert.equal(byId('rcX').deletedSalesRepId, null, 'سند شركةٍ أخرى لا يُمسّ');
  // كتابةٌ واحدة تحمل الاثنين معاً (لا نافذة يُفرَّغ فيها المرجع بلا معرّفه)، وقبل حذف المندوب
  const receiptWrites = calls.filter((c) => c.startsWith('receipt.'));
  assert.deepEqual(receiptWrites, ['receipt.updateMany'], 'كتابةٌ واحدة على السندات');
  assert.ok(calls.indexOf('receipt.updateMany') < calls.indexOf('salesRep.delete'));
  assert.ok(calls.indexOf('glSettings.findUnique') < calls.indexOf('receipt.updateMany'), 'حارس الدفاتر أولاً');
});

test('حذف المندوب في شركةٍ مربوطة وله سندات ⇒ 409 LEDGER_HISTORY_LOCKED (assertRepDeletable أولاً) بلا أي كتابة على السندات', async () => {
  seed({ gl: { setupMethod: 'LINKED', activatedAt: ACTIVATED }, counts: { receipt: 2 } });
  const r = await invoke('/:id', { id: 'R1' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body?.code, 'LEDGER_HISTORY_LOCKED');
  assert.ok(!calls.includes('receipt.updateMany') && !calls.includes('salesRep.delete'));
  assert.deepEqual(state.receipts.filter((x) => x.deletedSalesRepId).map((x) => x.id), []);
});

test('حارس نصّي: تفريغ السندات يكتب deletedSalesRepId في updateMany نفسه، بترتيب الاستدعاءات القائم', () => {
  const src = read('routes/salesReps.ts');
  const body = src.slice(src.indexOf("router.delete('/:id',"), src.indexOf('// ===== إسناد العملاء للمندوب'));
  assert.match(body, /tx\.receipt\.updateMany\(\{ where: \{ tenantId: tid, salesRepId: req\.params\.id \}, data: \{ salesRepId: null, deletedSalesRepId: req\.params\.id \} \}\)/);
  assert.equal(body.split('tx.receipt.updateMany(').length - 1, 1, 'كتابةٌ واحدة على السندات');
  assert.doesNotMatch(body, /receipt\.delete(?:Many)?\(/, 'السندات لا تُحذف');
  // والمخطّط: العمود بلا مفتاح أجنبيّ (يبقى بعد حذف المندوب)
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = schema.slice(schema.indexOf('model Receipt {'), schema.indexOf('\n}', schema.indexOf('model Receipt {')));
  assert.match(model, /\n\s+deletedSalesRepId String\?\n/);
  assert.doesNotMatch(model, /deletedSalesRep\s+SalesRep/, 'بلا علاقة');
});

// ═══ (٢) حذف «استلام تحصيل» — قرار المالك OD1 ═══

const delSettlement = () => invoke('/:id/settlements/:settlementId', { id: 'R1', settlementId: 'S1' });

test('شركةٌ دفاترها مربوطة (LINKED مفعّلة): حذف الاستلام ⇒ 409 BOOKS_LINKED_NO_DELETE قبل قفل العهدة وأي كتابة — والصفّ باقٍ', async () => {
  seed({ gl: { setupMethod: 'LINKED', activatedAt: ACTIVATED, currencyDecimals: 2 } });
  const r = await delSettlement();
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: false, code: LINKED_NO_DELETE_CODE, message: LINKED_NO_DELETE_MESSAGE });
  assert.equal(LINKED_NO_DELETE_CODE, 'BOOKS_LINKED_NO_DELETE');
  assert.deepEqual(state.settlements.map((s) => s.id), ['S1'], 'الاستلام باقٍ');
  assert.deepEqual([state.events.length, state.notifications.length], [0, 0], 'لا أحداث ولا إشعار');
  for (const w of ['repSettlement.delete', 'glSourceEvent.createMany', 'notification.create']) assert.ok(!calls.includes(w), `لا ${w}`);
  assert.ok(!calls.some((c) => c.includes('pg_advisory_xact_lock')), 'لا قفل عهدة');
  // الحكم داخل المعاملة وأوّل ما فيها
  const inTx = calls.slice(calls.indexOf('$transaction') + 1);
  assert.equal(inTx[0], 'glSettings.findUnique', 'أول ما في المعاملة قراءة وضع الدفاتر');
});

test('غير المربوطة: الحذف كما كان — اليدوية (CLEAN) ولم تُفعَّل يوماً وLINKED قيد الإعداد (بلا تفعيل) والقديمة المفعّلة', async () => {
  const modes: [string, Row | null][] = [
    ['لم تُفعَّل الدفاتر', null],
    ['يدوية CLEAN مفعّلة', { setupMethod: 'CLEAN', activatedAt: ACTIVATED, currencyDecimals: 2 }],
    ['LINKED قبل التفعيل', { setupMethod: 'LINKED', activatedAt: null, currencyDecimals: 2 }],
    ['قديمة OPENING مفعّلة', { setupMethod: 'OPENING', activatedAt: ACTIVATED, currencyDecimals: 2 }],
  ];
  for (const [label, row] of modes) {
    seed({ gl: row });
    const r = await delSettlement();
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.success, true, label);
    assert.deepEqual(state.settlements, [], `${label}: حُذف`);
    assert.equal(state.notifications.length, 1, `${label}: إشعار الحذف`);
    assert.equal(state.notifications[0].type, 'REP_SETTLEMENT_DELETED', label);
    assert.ok(calls.some((c) => c.includes('pg_advisory_xact_lock')), `${label}: حارس العهدة كما كان`);
  }
  // والقديمة المفعّلة تكتب عكسها في الدفاتر كما كانت (POST وREVERSE)
  seed({ gl: { setupMethod: 'OPENING', activatedAt: ACTIVATED, currencyDecimals: 2 } });
  await delSettlement();
  assert.deepEqual(state.events.map((e) => e.sourceKey), ['SETTLEMENT:S1:POST', 'SETTLEMENT:S1:REVERSE']);
});

test('حارس نصّي: حارس الربط أول ما في معاملة حذف الاستلام، من services/booksMode، والتحويل 409 في المعالج', () => {
  const src = read('routes/salesReps.ts');
  assert.match(src, /import \{ LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE, tenantBooksLinked \} from '\.\.\/services\/booksMode';/);
  const start = src.indexOf("router.delete('/:id/settlements/:settlementId'");
  const h = src.slice(start, src.indexOf('\n});', start));
  const tx = h.slice(h.indexOf('prisma.$transaction(async tx => {'));
  const firstAwait = tx.indexOf('await ');
  assert.match(tx.slice(firstAwait), /^await tenantBooksLinked\(tx, tid\)\) throw new BooksLinkedNoDelete\(\);/, 'أول await في المعاملة حارس الربط');
  assert.ok(tx.indexOf('tenantBooksLinked(tx, tid)') < tx.indexOf('lockCustody('), 'قبل قفل العهدة');
  assert.ok(tx.indexOf('tenantBooksLinked(tx, tid)') < tx.indexOf('tx.repSettlement.delete('), 'قبل الحذف');
  assert.match(h, /if \(err instanceof BooksLinkedNoDelete\) \{ res\.status\(409\)\.json\(BOOKS_LINKED_NO_DELETE_BODY\); return; \}/);
  assert.deepEqual({ ...salesRepsModule.BOOKS_LINKED_NO_DELETE_BODY }, { success: false, code: LINKED_NO_DELETE_CODE, message: LINKED_NO_DELETE_MESSAGE });
});
