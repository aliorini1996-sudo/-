// «اشتراط تفعيل الموقع» على الزيارة (أمر المالك، ٦ أكتوبر ٢٠٢٦) — منطق POST /visits فوق Prisma مزيّف في الذاكرة، بلا قاعدة.
// نثبت: زيارة المقيَّد بلا موقع ⇒ 409 LOCATION_REQUIRED دائماً (ومنها إعادة الرفع بـclientRef من صفّ العمل دون اتصال)،
// وما سُجّل دون اتصال (X-FS-Replay) يُردّ ولو حمل موقعاً، وبالموقع حيّاً تُقبل وتُحفظ إحداثياتها؛ وغير المقيَّد كما كان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Visit = { id: string; tenantId: string; salesRepId: string; customerId: string; lat: number | null; lng: number | null; clientRef?: string; _count: { photos: number } };
let visits: Visit[] = [];
let repReads: { id?: unknown; tenantId?: unknown }[] = [];
// المندوبون: rep1 مقيَّد في t1، rep2 غير مقيَّد
const reps: Record<string, { tenantId: string; requireLocationOn: boolean }> = {
  rep1: { tenantId: 't1', requireLocationOn: true },
  rep2: { tenantId: 't1', requireLocationOn: false },
};

const prisma = {
  repVisit: {
    async findFirst(a: { where: { tenantId: string; clientRef: string } }) {
      return visits.find((v) => v.tenantId === a.where.tenantId && v.clientRef === a.where.clientRef) ?? null;
    },
    async create(a: { data: Omit<Visit, 'id' | '_count'> }) {
      const v: Visit = { id: `v${visits.length + 1}`, ...a.data, _count: { photos: 0 } } as Visit;
      visits.push(v);
      return v;
    },
  },
  salesRep: {
    async findFirst(a: { where: { id: string; tenantId: string } }) {
      repReads.push(a.where);
      const r = reps[a.where.id];
      return r && r.tenantId === a.where.tenantId ? { requireLocationOn: r.requireLocationOn } : null;
    },
  },
  customer: {
    async findFirst(a: { where: { id?: string; tenantId: string; clientRef?: string } }) {
      if (a.where.clientRef) return a.where.clientRef === '11111111-1111-4111-8111-111111111111' ? { id: 'c-uploaded' } : null;
      return a.where.id ? { id: a.where.id } : null;
    },
  },
};
stub('config/database', { default: prisma });
stub('middleware/auth', {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/adminScope', { scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/customerScope', { canAccessCustomer: async () => true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../routes/visits');
const router = mod.default as Router;
const hasVisitCoords = mod.hasVisitCoords as (b: { lat?: number | null; lng?: number | null }) => boolean;

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function postHandler() {
  for (const l of (router as unknown as { stack: Layer[] }).stack) {
    const r = l.route;
    if (r && r.path === '/' && r.methods.post) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error('POST /visits غير مسجّل');
}
async function post(body: Record<string, unknown>, opts: { user?: Record<string, unknown>; replay?: boolean } = {}) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  let thrown: unknown = null;
  await postHandler()(
    { user: opts.user ?? { role: 'SALES_REP', id: 'rep1', tenantId: 't1' }, body, headers: opts.replay ? { 'x-fs-replay': '1' } : {} },
    res, (e?: unknown) => { if (e) thrown = e; },
  );
  if (thrown) throw thrown;
  return res;
}
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reset = () => { visits = []; repReads = []; };

test('المقيَّد بلا موقع ⇒ 409 LOCATION_REQUIRED ولا كتابة — غياباً وnull ونصف زوجٍ و(0،0)', async () => {
  reset();
  for (const coords of [{}, { lat: null, lng: null }, { lat: 24.7 }, { lng: 46.6 }, { lat: 0, lng: 0 }]) {
    const res = await post({ customerId: 'c1', note: 'زيارة', ...coords });
    assert.equal(res.statusCode, 409, JSON.stringify(coords));
    assert.equal(res.body!.code, 'LOCATION_REQUIRED');
    assert.match(String(res.body!.message), /بلا موقعك/);
  }
  assert.equal(visits.length, 0, 'لا زيارة كُتبت');
});

test('بلا استثناء لإعادة الرفع: زيارة المؤقّت من صفّ العمل دون اتصال بـclientRef بلا موقع ⇒ 409، وتكرارها 409 لا قبول', async () => {
  reset();
  const body = { customerId: 'c1', clientRef: REF(1), startedAt: '2026-10-06T08:00:00.000Z', endedAt: '2026-10-06T08:10:00.000Z', clientDurationSec: 600 };
  for (let i = 0; i < 2; i++) {
    const res = await post(body, { replay: true });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body!.code, 'LOCATION_REQUIRED');
  }
  // ولو بلا ترويسة إعادة الرفع (نسخةٌ أقدم من التطبيق)
  const live = await post(body);
  assert.equal(live.body!.code, 'LOCATION_REQUIRED');
  assert.equal(visits.length, 0);
});

test('ما سُجّل دون اتصال (X-FS-Replay) يُردّ للمقيَّد ولو حمل موقعاً — VISIT_NEEDS_CONNECTION', async () => {
  reset();
  const res = await post({ customerId: 'c1', lat: 24.71, lng: 46.67, clientRef: REF(2) }, { replay: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body!.code, 'VISIT_NEEDS_CONNECTION');
  assert.equal(visits.length, 0);
});

test('المقيَّد بموقعٍ حيّاً ⇒ 201 وتُحفظ إحداثياته؛ وإعادة الطلب نفسه idempotent لا زيارة ثانية', async () => {
  reset();
  const body = { customerId: 'c1', lat: 24.7136, lng: 46.6753, clientRef: REF(3), startedAt: '2026-10-06T08:00:00.000Z', endedAt: '2026-10-06T08:05:00.000Z' };
  const res = await post(body);
  assert.equal(res.statusCode, 201);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].lat, 24.7136);
  assert.equal(visits[0].lng, 46.6753);
  assert.equal(visits[0].salesRepId, 'rep1');
  const again = await post(body);
  assert.equal(again.statusCode, 200);
  assert.equal((again.body as { idempotent?: boolean }).idempotent, true);
  assert.equal(visits.length, 1);
});

test('عزل الشركات: القيد يُقرأ بمعرّف المندوب وشركة التوكن معاً', async () => {
  reset();
  await post({ customerId: 'c1' });
  assert.deepEqual(repReads[0], { id: 'rep1', tenantId: 't1' });
  // مندوبٌ لا يوجد في هذه الشركة لا يُعدّ مقيَّداً من شركةٍ أخرى — ولا يُقرأ قيدُ غيرها
  reset();
  const res = await post({ customerId: 'c1' }, { user: { role: 'SALES_REP', id: 'rep1', tenantId: 't2' } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(repReads[0], { id: 'rep1', tenantId: 't2' });
});

test('غير المقيَّد كما كان: بلا موقع يُقبل، ومن صفّ العمل دون اتصال يُقبل، وعميلٌ أوف‑لاين يُحلّ', async () => {
  reset();
  const rep2 = { role: 'SALES_REP', id: 'rep2', tenantId: 't1' };
  const a = await post({ customerId: 'c1', note: 'بلا موقع' }, { user: rep2 });
  assert.equal(a.statusCode, 201);
  assert.equal(visits[0].lat, null);
  const b = await post({ customerClientRef: '11111111-1111-4111-8111-111111111111', clientRef: REF(4) }, { user: rep2, replay: true });
  assert.equal(b.statusCode, 201);
  assert.equal(visits[1].customerId, 'c-uploaded');
  // عميلٌ في صفّ الجهاز لم يُرفع بعد: 400 بوسمٍ يميّزه عن رفض الأعمال
  const c = await post({ customerClientRef: '22222222-2222-4222-8222-222222222222' }, { user: rep2 });
  assert.equal(c.statusCode, 400);
  assert.equal(c.body!.code, 'CUSTOMER_REF_PENDING');
});

test('الإدارة نيابةً عن مندوبٍ مقيَّد: الحارس على المندوب لا على المستخدم — ولا تُسجَّل زيارته نيابةً عنه ولو بموقع', async () => {
  reset();
  const admin = { role: 'ADMIN', id: 'u1', tenantId: 't1' };
  // salesRepId من الجسم الخام (req.body) كما في المسار
  for (const coords of [{}, { lat: 24.71, lng: 46.67 }]) {
    const res = await post({ customerId: 'c1', salesRepId: 'rep1', ...coords }, { user: admin });
    assert.equal(res.statusCode, 403, JSON.stringify(coords));
    assert.equal(res.body!.code, 'VISIT_REP_ONLY');
  }
  assert.equal(visits.length, 0);
  // وغير المقيَّد نيابةً عنه كما كان
  const ok = await post({ customerId: 'c1', salesRepId: 'rep2' }, { user: admin });
  assert.equal(ok.statusCode, 201);
});

test('hasVisitCoords: رقمان محدودان، و(0،0) فاسد', () => {
  assert.equal(hasVisitCoords({ lat: 24.7, lng: 46.6 }), true);
  assert.equal(hasVisitCoords({ lat: 0, lng: 46.6 }), true, 'خطّ الاستواء وحده ليس فاسداً');
  assert.equal(hasVisitCoords({ lat: 0, lng: 0 }), false);
  assert.equal(hasVisitCoords({ lat: null, lng: 46.6 }), false);
  assert.equal(hasVisitCoords({}), false);
});

test('حارس ثابت: الحارس بعد تحديد المندوب ونطاقه وقبل حلّ العميل والكتابة', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src = require('fs').readFileSync(path.join(SRC, 'routes', 'visits.ts'), 'utf8') as string;
  const h = src.slice(src.indexOf("router.post('/'"), src.indexOf('\n});', src.indexOf("router.post('/'")));
  const scope = h.indexOf('canAccessRep(req, tid, salesRepId)');
  const guard = h.indexOf("if (await refuseVisitWithoutLocation(res, tid, salesRepId, body, replay, req.user!.role === 'SALES_REP')) return;");
  const resolve = h.indexOf('body.customerClientRef) {');
  const write = h.indexOf('prisma.repVisit.create(');
  assert.ok(scope > 0 && guard > scope && resolve > guard && write > resolve);
});
