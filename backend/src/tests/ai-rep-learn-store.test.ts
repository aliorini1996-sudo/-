// حلقة التعلّم — المخزن: الرجوع يسجّل وقته (changedAt)، ومهلة الترقية بعد الرجوع (آلي ٢٨/٤٥ يوماً، إدارة ٦٠)،
// وإعادة الضبط تحرّر مفاتيح الدروس (#reset) — فوق Prisma مزيّف في الذاكرة، بلا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف ─────────────
type Row = Record<string, any>;
const DAY = 86_400_000;
let models: Row[] = [];
let lessons: Row[] = [];
let settings: Row[] = [];
let calls: { op: string; args: any }[] = [];
let seq = 0;

/** مطابقة where بسيطة: قيمة مباشرة، أو { in }، أو { not }. */
const matches = (r: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return (v.in as unknown[]).includes(r[k]);
    if ('not' in v) return v.not === null ? r[k] != null : r[k] !== v.not;
    if ('gte' in v) return r[k] instanceof Date && r[k].getTime() >= (v.gte as Date).getTime();
  }
  return r[k] === v;
});
const byOrder = (orderBy: Row | undefined) => (a: Row, b: Row): number => {
  if (!orderBy) return 0;
  const [k, dir] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
  const x = a[k] instanceof Date ? a[k].getTime() : a[k], y = b[k] instanceof Date ? b[k].getTime() : b[k];
  return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
};
const table = (name: string, rows: () => Row[]) => ({
  async findFirst(a: any) {
    calls.push({ op: `${name}.findFirst`, args: a });
    const r = rows().filter(x => matches(x, a.where)).sort(byOrder(a.orderBy))[0];
    return r ? { ...r } : null;
  },
  async findMany(a: any) {
    calls.push({ op: `${name}.findMany`, args: a });
    return rows().filter(x => matches(x, a.where)).sort(byOrder(a.orderBy)).slice(0, a.take ?? Infinity).map(x => ({ ...x }));
  },
  async updateMany(a: any) {
    calls.push({ op: `${name}.updateMany`, args: a });
    let count = 0;
    for (const r of rows()) if (matches(r, a.where)) { Object.assign(r, a.data); count++; }
    return { count };
  },
});
const db: Row = {
  aiLearnedModel: table('aiLearnedModel', () => models),
  aiLesson: table('aiLesson', () => lessons),
  aiRepSettings: {
    async upsert(a: any) {
      calls.push({ op: 'aiRepSettings.upsert', args: a });
      const r = settings.find(x => x.tenantId === a.where.tenantId);
      if (r) Object.assign(r, a.update); else settings.push({ ...a.create });
      return {};
    },
  },
};
db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const St = require('../ai-rep/learn/store') as typeof import('../ai-rep/learn/store');

const reset = () => { models = []; lessons = []; settings = []; calls = []; seq = 0; };
const model = (o: Row): Row => {
  const r = { id: `M${++seq}`, tenantId: 'A', kind: 'POLICY', version: 1, status: 'SUPERSEDED', reason: null, changedById: null, changedAt: null, promotedAt: null, ...o };
  models.push(r);
  return r;
};
const lesson = (o: Row): Row => {
  const r = { id: `L${++seq}`, tenantId: 'A', key: `K${seq}`, status: 'ACTIVE', statusReason: null, history: [], ...o };
  lessons.push(r);
  return r;
};
/** كل نداء على Prisma المزيّف يحمل tenantId للشركة A (وليس B). */
const assertScoped = () => {
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const s = JSON.stringify(c.args);
    assert.match(s, /"tenantId":"A"/, c.op);
    assert.ok(!s.includes('"tenantId":"B"'), c.op);
  }
};

const T = new Date('2026-09-01T00:00:00Z');
const at = (d: number) => new Date(T.getTime() + d * DAY);

// ───────────── مهلة الترقية ─────────────

test('promotionHold: رجوع آلي ⇒ ٢٨ يوماً للترتيب و٤٥ للمعايرة؛ رجوع الإدارة ⇒ ٦٠ يوماً', async () => {
  reset();
  model({ kind: 'POLICY', version: 2, status: 'ROLLED_BACK', changedById: 'SYSTEM', changedAt: T, reason: 'AUTO_REGRESSION' });
  assert.deepEqual(await St.promotionHold('A', 'POLICY', at(27)), { until: at(28), by: 'SYSTEM' });
  assert.equal(await St.promotionHold('A', 'POLICY', at(29)), null);
  assert.equal(await St.promotionHold('A', 'POLICY', at(28)), null, 'تنتهي عند ٢٨ يوماً تماماً');
  // النوع الآخر بلا رجوع ⇒ بلا مهلة
  assert.equal(await St.promotionHold('A', 'CALIBRATION', at(1)), null);

  model({ kind: 'CALIBRATION', version: 3, status: 'ROLLED_BACK', changedById: 'SYSTEM', changedAt: T, reason: 'AUTO_REGRESSION' });
  assert.deepEqual(await St.promotionHold('A', 'CALIBRATION', at(44)), { until: at(45), by: 'SYSTEM' });
  assert.equal(await St.promotionHold('A', 'CALIBRATION', at(46)), null);

  reset();
  model({ kind: 'POLICY', version: 4, status: 'ROLLED_BACK', changedById: 'user-1', changedAt: T, reason: 'ADMIN' });
  assert.deepEqual(await St.promotionHold('A', 'POLICY', at(59)), { until: at(60), by: 'ADMIN' });
  assert.equal(await St.promotionHold('A', 'POLICY', at(61)), null);
  model({ kind: 'CALIBRATION', version: 1, status: 'ROLLED_BACK', changedById: 'user-1', changedAt: T, reason: 'ADMIN' });
  assert.deepEqual(await St.promotionHold('A', 'CALIBRATION', at(59)), { until: at(60), by: 'ADMIN' }, 'الإدارة ٦٠ يوماً للنوعين');
  assertScoped();
});

test('promotionHold: أطول مهلة سارية هي الحاكمة؛ الرجوع القديم بلا changedAt لا يحجز؛ وشركة أخرى لا تحجز', async () => {
  reset();
  model({ kind: 'POLICY', version: 1, status: 'ROLLED_BACK', changedById: 'SYSTEM', changedAt: at(-40) });
  model({ kind: 'POLICY', version: 2, status: 'ROLLED_BACK', changedById: 'user-1', changedAt: at(-5) });
  assert.deepEqual(await St.promotionHold('A', 'POLICY', T), { until: at(55), by: 'ADMIN' });
  reset();
  model({ kind: 'POLICY', version: 1, status: 'ROLLED_BACK', changedById: 'SYSTEM', changedAt: null });
  assert.equal(await St.promotionHold('A', 'POLICY', T), null, 'صفّ قديم بلا وقت');
  model({ tenantId: 'B', kind: 'POLICY', version: 1, status: 'ROLLED_BACK', changedById: 'user-9', changedAt: T });
  assert.equal(await St.promotionHold('A', 'POLICY', at(1)), null, 'رجوع الشركة B لا يحجز A');
  const q = calls.filter(c => c.op === 'aiLearnedModel.findMany');
  assert.ok(q.length > 0);
  for (const c of q) assert.deepEqual([c.args.where.tenantId, c.args.where.kind, c.args.where.status], ['A', 'POLICY', 'ROLLED_BACK']);
  assertScoped();
});

test('rollbackModel يسجّل changedAt ومن رجع، فتحجز promotionHold بعده', async () => {
  reset();
  const active = model({ kind: 'POLICY', version: 3, status: 'ACTIVE', promotedAt: at(-3) });
  const prev = model({ kind: 'POLICY', version: 2, status: 'SUPERSEDED' });
  const other = model({ tenantId: 'B', kind: 'POLICY', version: 3, status: 'ACTIVE' });
  const before = Date.now();
  assert.deepEqual(await St.rollbackModel('A', 'POLICY', 2, 'SYSTEM', 'AUTO_REGRESSION'), { ok: true });
  assert.equal(active.status, 'ROLLED_BACK');
  assert.equal(active.reason, 'AUTO_REGRESSION');
  assert.equal(active.changedById, 'SYSTEM');
  assert.ok(active.changedAt instanceof Date && active.changedAt.getTime() >= before);
  assert.equal(prev.status, 'ACTIVE');
  assert.ok(prev.changedAt instanceof Date && prev.promotedAt instanceof Date);
  assert.equal(other.status, 'ACTIVE', 'شركة أخرى لا تُمسّ');
  const now = active.changedAt.getTime();
  assert.equal((await St.promotionHold('A', 'POLICY', new Date(now + 27 * DAY)))?.by, 'SYSTEM');
  assert.equal(await St.promotionHold('A', 'POLICY', new Date(now + 29 * DAY)), null);

  // بعد يومين: رجوع الإدارة إلى الافتراضي ⇒ ٦٠ يوماً (نُرجع وقت الرجوع الأول كي لا يتعادل الوقتان في المللي ثانية نفسها)
  active.changedAt = new Date(now - 2 * DAY);
  assert.deepEqual(await St.rollbackModel('A', 'POLICY', 0, 'user-1', 'ADMIN'), { ok: true });
  assert.equal(prev.status, 'ROLLED_BACK');
  assert.equal(prev.changedById, 'user-1');
  const t2 = prev.changedAt.getTime();
  assert.deepEqual(await St.promotionHold('A', 'POLICY', new Date(t2 + 59 * DAY)), { until: new Date(t2 + 60 * DAY), by: 'ADMIN' });
  // نسخة غير موجودة ⇒ ٤٠٤ بلا تغيير
  assert.deepEqual(await St.rollbackModel('A', 'POLICY', 9, 'user-1', 'ADMIN'), { ok: false, status: 404 });
  assertScoped();
});

test('promotionHold: رجوع آلي لاحق لا يقصّر مهلة رجوع الإدارة', async () => {
  reset();
  model({ kind: 'POLICY', version: 1, status: 'ROLLED_BACK', changedById: 'user-1', changedAt: T });
  model({ kind: 'POLICY', version: 2, status: 'ROLLED_BACK', changedById: 'SYSTEM', changedAt: at(10) });
  assert.deepEqual(await St.promotionHold('A', 'POLICY', at(45)), { until: at(60), by: 'ADMIN' }, 'مهلة الإدارة (٦٠) تبقى رغم رجوع آلي في اليوم العاشر');
  assert.equal(await St.promotionHold('A', 'POLICY', at(61)), null);
  assertScoped();
});

// ───────────── إعادة الضبط ─────────────

test('resetLearning: الدروس الحيّة ← RETIRED/ADMIN_RESET بمفتاح محرَّر (#reset:<ms>)، والنسخ الفعّالة ← SUPERSEDED بلا مهلة', async () => {
  reset();
  const pol = model({ kind: 'POLICY', version: 3, status: 'ACTIVE' });
  const cal = model({ kind: 'CALIBRATION', version: 2, status: 'ACTIVE' });
  const polB = model({ tenantId: 'B', kind: 'POLICY', version: 5, status: 'ACTIVE' });
  const active = lesson({ key: 'OBJ:GROCERY:PRICE', status: 'ACTIVE', history: [{ at: 'x', from: null, to: 'ACTIVE', by: 'SYSTEM', reason: 'EVIDENCE' }] });
  const trial = lesson({ key: 'SELF:BRIEF', status: 'TRIAL' });
  const pending = lesson({ key: 'REFL:abc', status: 'PENDING' });
  const disabled = lesson({ key: 'SELF:MONEY', status: 'DISABLED', statusReason: 'ADMIN' });
  const retired = lesson({ key: 'SELF:NO_ARITH', status: 'RETIRED', statusReason: 'HARMFUL' });
  const lessonB = lesson({ tenantId: 'B', key: 'OBJ:GROCERY:PRICE', status: 'ACTIVE' });

  const before = Date.now();
  await St.resetLearning('A', 'u1');
  const after = Date.now();

  for (const [l, key, from] of [[active, 'OBJ:GROCERY:PRICE', 'ACTIVE'], [trial, 'SELF:BRIEF', 'TRIAL'], [pending, 'REFL:abc', 'PENDING']] as const) {
    const m = /^(.+)#reset:(\d+)$/.exec(l.key);
    assert.ok(m, `مفتاح محرَّر: ${l.key}`);
    assert.equal(m![1], key);
    const ms = Number(m![2]);
    assert.ok(ms >= before && ms <= after, 'اللاحقة وقت الضبط بالمللي ثانية');
    assert.equal(l.status, 'RETIRED');
    assert.equal(l.statusReason, 'ADMIN_RESET');
    const h = l.history[l.history.length - 1];
    assert.deepEqual([h.from, h.to, h.by, h.reason], [from, 'RETIRED', 'u1', 'ADMIN_RESET']);
  }
  assert.equal(active.history.length, 2, 'السجلّ يُلحق به لا يُستبدل');
  // المفاتيح الأصلية صارت حرّة ⇒ يُعاد تعلّمها بدليلها
  assert.ok(!lessons.some(l => l.tenantId === 'A' && ['OBJ:GROCERY:PRICE', 'SELF:BRIEF', 'REFL:abc'].includes(l.key)));
  // المعطّل والمتقاعد وشركة أخرى لا تُمسّ
  assert.deepEqual([disabled.key, disabled.status], ['SELF:MONEY', 'DISABLED']);
  assert.deepEqual([retired.key, retired.status, retired.statusReason], ['SELF:NO_ARITH', 'RETIRED', 'HARMFUL']);
  assert.deepEqual([lessonB.key, lessonB.status], ['OBJ:GROCERY:PRICE', 'ACTIVE']);

  assert.deepEqual([pol.status, pol.reason, pol.changedById], ['SUPERSEDED', 'ADMIN_RESET', 'u1']);
  assert.equal(cal.status, 'SUPERSEDED');
  assert.equal(polB.status, 'ACTIVE');
  const s = settings.find(x => x.tenantId === 'A')!;
  assert.ok(s.learningResetAt instanceof Date);
  // إعادة الضبط ليست رجوعاً ⇒ لا تحجز الترقية
  assert.equal(await St.promotionHold('A', 'POLICY', new Date(after + DAY)), null);
  assert.equal(await St.promotionHold('A', 'CALIBRATION', new Date(after + DAY)), null);
  assertScoped();
  for (const c of calls.filter(x => x.op.endsWith('.updateMany'))) assert.equal(c.args.where.tenantId, 'A', c.op);
});
