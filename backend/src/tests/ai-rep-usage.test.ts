// المندوب الذكي — الحجز الذرّي للحصص وجلسة البحث في الخادم (فوق Prisma مزيّف في الذاكرة)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Row = Record<string, number | string>;
let rows: Row[] = [];
const match = (r: Row, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => {
  if (v && typeof v === 'object') {
    const c = v as { lte?: number; gte?: number };
    if (c.lte !== undefined) return (r[k] as number ?? 0) <= c.lte;
    if (c.gte !== undefined) return (r[k] as number ?? 0) >= c.gte;
  }
  return r[k] === v;
});
const aiUsageDaily = {
  async createMany(a: { data: Row[] }) {
    let count = 0;
    for (const d of a.data) if (!rows.find(x => x.tenantId === d.tenantId && x.salesRepId === d.salesRepId && x.day === d.day)) { rows.push({ searches: 0, estimates: 0, chatTurns: 0, ...d }); count++; }
    return { count };
  },
  async upsert(a: { where: { tenantId_salesRepId_day: Row }; create: Row; update: Record<string, { increment: number }> }) {
    const w = a.where.tenantId_salesRepId_day;
    let r = rows.find(x => x.tenantId === w.tenantId && x.salesRepId === w.salesRepId && x.day === w.day);
    if (!r) { r = { searches: 0, estimates: 0, chatTurns: 0, ...a.create }; rows.push(r); return r; }
    for (const [k, v] of Object.entries(a.update)) r[k] = ((r[k] as number) ?? 0) + v.increment;
    return r;
  },
  async updateMany(a: { where: Record<string, unknown>; data: Record<string, { increment?: number; decrement?: number }> }) {
    // تنفيذ ذرّي لكل صفّ (كما في Postgres: التحديث الشرطي صفّاً صفّاً تحت قفل الصفّ)
    let count = 0;
    for (const r of rows) {
      if (!match(r, a.where)) continue;
      for (const [k, v] of Object.entries(a.data)) r[k] = ((r[k] as number) ?? 0) + (v.increment ?? 0) - (v.decrement ?? 0);
      count++;
    }
    return { count };
  },
  async findUnique() { return rows[0] ?? null; },
};
stub('config/database', { default: { aiUsageDaily } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reserveUsage, refundUsage } = require('../ai-rep/usage') as typeof import('../ai-rep/usage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saveSession, getSession, patchSessionOutlet, clearSessions, SESSION_TTL_MS } = require('../ai-rep/session') as typeof import('../ai-rep/session');

test('الحجز الذرّي: ١٠٠ طلب متزامن بحدّ ٤٠ ⇒ ٤٠ فقط تمرّ، والعدّاد لا يتجاوز الحدّ', async () => {
  rows = [];
  const results = await Promise.all(Array.from({ length: 100 }, () => reserveUsage('t1', 'r1', 'chatTurns', 40)));
  assert.equal(results.filter(Boolean).length, 40);
  assert.equal(rows[0].chatTurns, 40);
});

test('الحدّ صفر يرفض، والاسترداد لا ينزل تحت الصفر', async () => {
  rows = [];
  assert.equal(await reserveUsage('t1', 'r1', 'searches', 0), false);
  assert.equal(await reserveUsage('t1', 'r1', 'searches', 2), true);
  await refundUsage('t1', 'r1', 'searches');
  await refundUsage('t1', 'r1', 'searches');
  assert.equal(rows[0].searches, 0);
});

test('جلسة البحث: المعرّف يجب أن يطابق، وتنتهي، والتحديث لا يغيّر المراجع', () => {
  clearSessions();
  const base = { searchId: 's1', createdAt: Date.now(), origin: { lat: 1, lng: 2 }, radiusM: 2000,
    outlets: [{ ref: 'P1', placeId: 'a', outletType: 'GROCERY', lat: 1, lng: 2, distanceM: 10, relation: 'NEW' as const, lastOutcome: null, customerId: null }] };
  saveSession('t1', 'r1', base);
  assert.equal(getSession('t1', 'r1', 's2'), null, 'معرّف آخر');
  assert.equal(getSession('t1', 'r2', 's1'), null, 'مندوب آخر');
  patchSessionOutlet('t1', 'r1', 'a', { closed: true, lastOutcome: 'CLOSED' });
  const s = getSession('t1', 'r1', 's1')!;
  assert.equal(s.outlets[0].ref, 'P1');
  assert.equal(s.outlets[0].closed, true);
  assert.equal(getSession('t1', 'r1', 's1', Date.now() + SESSION_TTL_MS + 1), null, 'منتهية');
});
