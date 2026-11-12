// «هدف الشهر» — مراجعة الإصلاحات (الجولة الثانية) فوق Prisma مزيّف في الذاكرة (بلا قاعدة بيانات ولا شبكة):
//   • R4 (routes/visits.ts): لحظة زيارة المندوب (createdAt) وطابعا مؤقّتها محصورةٌ بنافذة [الآن − ٧ أيام، الآن + ٥ دقائق] — فلا يؤرّخ
//     بتوكنه زياراته في شهرٍ منتهٍ أو قادم فيقلب «عدد الزيارات». بلا اشتراط X-FS-Replay: زيارة المقيَّد «بانتظار الاتصال» تُعاد
//     حيّةً لاحقاً فتبقى بلحظتها الحقيقية. والإدارة ومفتاح API كما كانا.
//   • R6 (routes/customers.ts): عميل صندوق المندوب (X-FS-Replay) يُؤرَّخ createdAt بلحظة إضافته على الجهاز بحصر فاتورته دون اتصال
//     (offlineInvoiceDate: تصحيح الانحراف بـX-FS-Device-Now، لا مستقبل ولا أقدم من سبعة أيام، والمرحلة الثانية) — POST وإنشاء PUT.
//     والإنشاء المتصل والإدارة ومفتاح API بساعة الخادم كما كانت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

// ═══ حقن البدائل قبل تحميل الموجّهين (نمط customer-put-upsert.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Args = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let calls: { op: string; args: Args }[] = [];
let scripted: Record<string, (args: Args) => unknown> = {};
const defaultFor = (method: string): unknown => (method === 'findMany' ? [] : method === 'count' ? 0 : null);
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push({ op: `${model}.${method}`, args });
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(args) : defaultFor(method);
  },
});
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]));
    }
    if (key === '$queryRaw' || key === '$executeRaw') return async () => (key === '$queryRaw' ? [] : 0);
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireAccounting: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});

/* eslint-disable @typescript-eslint/no-var-requires */
const visitsModule = require('../routes/visits') as typeof import('../routes/visits');
const customersModule = require('../routes/customers') as typeof import('../routes/customers');
const offline = require('../services/offlineInvoiceDate') as typeof import('../services/offlineInvoiceDate');
/* eslint-enable @typescript-eslint/no-var-requires */
const { inRepVisitWindow, repVisitMoment } = visitsModule;
const { DEVICE_CLOCK_SKEW_TOLERANCE_MS, OFFLINE_INVOICE_DATE_MAX_AGE_MS } = offline;

// ═══ العُدّة: معالج المسار الحقيقي من مكدّس الموجّه ═══

type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
const TENANT = 'T1';
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function handlerOf(router: Router, method: 'post' | 'put', routePath: string) {
  for (const l of (router as unknown as { stack: Layer[] }).stack) {
    const r = l.route;
    if (r && r.path === routePath && r.methods[method]) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error(`${method.toUpperCase()} ${routePath} غير مسجّل`);
}
type Reply = { statusCode: number; body: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(router: Router, method: 'post' | 'put', routePath: string, o: {
  user: User; body: Record<string, unknown>; headers?: Record<string, string>; params?: Record<string, string>;
}): Promise<Reply> {
  const res = {
    statusCode: 200, body: null as Reply['body'],
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Reply['body']; return this; },
  };
  let thrown: unknown = null;
  await handlerOf(router, method, routePath)(
    { user: o.user, body: o.body, headers: o.headers ?? {}, params: o.params ?? {}, query: {} },
    res, (e?: unknown) => { if (e) thrown = e; },
  );
  if (thrown) throw thrown;
  return res;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** لحظةٌ حسبها المعالج بساعته — بين ما قبل الطلب وما بعده */
const near = (got: unknown, before: number, after: number, label: string) => {
  const t = new Date(got as Date).getTime();
  assert.ok(t >= before && t <= after, `${label}: ${new Date(t).toISOString()} خارج [${iso(before)}، ${iso(after)}]`);
};

// ═══ R4 — الزيارات ═══

function visitWorld() {
  calls = [];
  const created: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'companySettings.findUnique': () => ({ customerIsolationEnabled: false }),
    // المندوب غير مقيَّد بـ«اشتراط تفعيل الموقع»، والفرق مطفأة
    'salesRep.findFirst': () => ({ id: 'rep-1', requireLocationOn: false, tenant: { settings: { teamsEnabled: false } }, teamMemberships: [] }),
    'customer.findFirst': (a) => (a?.where?.id ? { id: a.where.id } : null),
    'repVisit.findFirst': () => null,
    'repVisit.create': (a) => { created.push(a.data); return { id: `v${created.length}`, ...a.data, _count: { photos: 0 } }; },
  };
  return { created };
}
const postVisit = (user: User, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(visitsModule.default, 'post', '/', { user, body: user.role === 'SALES_REP' ? body : { salesRepId: 'rep-1', ...body }, headers });

test('R4 نافذة الزيارة: سبعة أيام قبل ساعة الخادم وحتى خمس دقائق بعدها — بحدّي الفاتورة نفسيهما', () => {
  const now = new Date('2026-11-12T10:00:00.000Z');
  const n = now.getTime();
  assert.equal(OFFLINE_INVOICE_DATE_MAX_AGE_MS, 7 * DAY);
  assert.equal(DEVICE_CLOCK_SKEW_TOLERANCE_MS, 5 * MIN);
  assert.equal(inRepVisitWindow(n, now), true);
  assert.equal(inRepVisitWindow(n - 7 * DAY, now), true, 'الحدّ الأدنى داخلها');
  assert.equal(inRepVisitWindow(n - 7 * DAY - 1, now), false);
  assert.equal(inRepVisitWindow(n + 5 * MIN, now), true, 'ساعةٌ متقدّمة بخمس دقائق تُقبل');
  assert.equal(inRepVisitWindow(n + 5 * MIN + 1, now), false);
  assert.equal(inRepVisitWindow(NaN, now), false);
});

test('R4 repVisitMoment: داخل النافذة خاماً بلا نقل، وخارجها تصحيح الانحراف ثم ساعة الخادم، والتالف والغائب null', () => {
  const now = new Date('2026-11-12T10:00:00.000Z');
  const n = now.getTime();
  // داخلها: كما أرسلها الجهاز حرفياً (لا تصحيح ولو حملت ترويسة الجهاز — زمن رفع الصور ليس انحرافاً)
  assert.deepEqual(repVisitMoment(iso(n - 3 * HOUR), String(n + 20 * MIN), now), { createdAt: new Date(n - 3 * HOUR), shiftMs: 0 });
  assert.deepEqual(repVisitMoment(iso(n + 4 * MIN), null, now), { createdAt: new Date(n + 4 * MIN), shiftMs: 0 });
  assert.deepEqual(repVisitMoment(iso(n - 7 * DAY), null, now), { createdAt: new Date(n - 7 * DAY), shiftMs: 0 });
  // شهرٌ منتهٍ أو قادم يختاره المرسل ⇒ ساعة الخادم الآن، ويُنقل المؤقّت بالفرق نفسه
  const oct = Date.parse('2026-10-30T10:00:00.000Z');
  assert.deepEqual(repVisitMoment(iso(oct), null, now), { createdAt: now, shiftMs: n - oct });
  const dec = Date.parse('2026-12-02T10:00:00.000Z');
  assert.deepEqual(repVisitMoment(iso(dec), null, now), { createdAt: now, shiftMs: n - dec });
  // ساعة جهازٍ متقدّمة ساعتين: الترويسة (رقماً أو ISO) تصحّحها إلى لحظتها الحقيقية
  const realAt = n - 10 * MIN;
  assert.deepEqual(repVisitMoment(iso(realAt + 2 * HOUR), String(n + 2 * HOUR), now), { createdAt: new Date(realAt), shiftMs: -2 * HOUR });
  assert.deepEqual(repVisitMoment(iso(realAt + 2 * HOUR), iso(n + 2 * HOUR), now), { createdAt: new Date(realAt), shiftMs: -2 * HOUR });
  // ترويسةٌ مزوّرة لا تفتح ما وراء النافذة: التصحيح يبقى خارجها ⇒ ساعة الخادم
  assert.deepEqual(repVisitMoment(iso(oct), String(n + 1 * DAY), now), { createdAt: now, shiftMs: n - oct });
  // وتصحيحٌ يعيدها إلى النافذة لا يتجاوزها: أقصى ما تبلغه أي لحظةٍ في النافذة نفسها
  const forged = repVisitMoment(iso(oct), String(n - (n - oct) + 6 * DAY), now);
  assert.ok(inRepVisitWindow(forged.createdAt!.getTime(), now));
  for (const bad of [undefined, null, '', '   ', 'ليس تاريخاً', 42]) {
    assert.deepEqual(repVisitMoment(bad, null, now), { createdAt: null, shiftMs: 0 }, String(bad));
  }
});

test('R4 المندوب يؤرّخ زيارة اليوم بشهرٍ منتهٍ أو قادم ⇒ تُكتب بساعة الخادم (لا يتحرّك «عدد الزيارات»)', async () => {
  const w = visitWorld();
  const before = Date.now();
  const past = await postVisit(REP, { customerId: 'c1', note: 'زيارة', createdAt: '2026-10-30T10:00:00.000Z' });
  const future = await postVisit(REP, { customerId: 'c1', note: 'زيارة', createdAt: iso(Date.now() + 25 * DAY) });
  // وبإعادة رفعٍ مصطنعة (X-FS-Replay) كذلك — النافذة لا تشترط الترويسة ولا تُفتح بها
  const replay = await postVisit(REP, { customerId: 'c1', note: 'زيارة', createdAt: iso(Date.now() - 20 * DAY) }, { 'x-fs-replay': '1' });
  const after = Date.now();
  for (const r of [past, future, replay]) assert.equal(r.statusCode, 201);
  assert.equal(w.created.length, 3);
  w.created.forEach((d, i) => near(d.createdAt, before, after, `زيارة ${i + 1}`));
});

test('R4 الزيارات المشروعة بلحظتها كما كانت: الحيّة، وزيارة الصندوق، والمؤقّت «بانتظار الاتصال» يُعاد حيّاً بعد ساعات', async () => {
  const w = visitWorld();
  const now = Date.now();
  // ملاحظة حيّة (لحظة الحفظ على الجهاز) — كما هي حرفياً
  const live = iso(now - 2_000);
  await postVisit(REP, { customerId: 'c1', note: 'رفّ', createdAt: live });
  // زيارة صندوق المندوب غير المقيَّد قبل يومين (X-FS-Replay) — بلحظة الجهاز
  const queued = iso(now - 2 * DAY);
  await postVisit(REP, { customerId: 'c1', note: 'دون اتصال', clientRef: REF(1), createdAt: queued }, { 'x-fs-replay': '1', 'x-fs-device-now': String(now) });
  // مؤقّت المقيَّد المحفوظ «بانتظار الاتصال» يُعاد حيّاً بعد خمس ساعات بلا ترويسة الإعادة (visitPending.ts): createdAt = endedAt
  const endedAt = iso(now - 5 * HOUR);
  const startedAt = iso(now - 5 * HOUR - 12 * MIN);
  await postVisit(REP, { customerId: 'c1', clientRef: REF(2), startedAt, endedAt, clientDurationSec: 720, createdAt: endedAt, lat: 24.7, lng: 46.6 },
    { 'x-fs-device-now': String(now) });
  assert.equal(w.created.length, 3);
  assert.equal(w.created[0].createdAt.toISOString(), live);
  assert.equal(w.created[1].createdAt.toISOString(), queued);
  assert.equal(w.created[2].createdAt.toISOString(), endedAt, 'لحظة انتهاء الزيارة الحقيقية لا لحظة الإعادة');
  assert.equal(w.created[2].startedAt.toISOString(), startedAt);
  assert.equal(w.created[2].endedAt.toISOString(), endedAt);
  assert.equal(w.created[2].durationSec, 720);
  // ملاحظةٌ بلا createdAt (حزمةٌ قديمة) ⇒ ساعة الخادم (افتراض العمود) كما كانت
  await postVisit(REP, { customerId: 'c1', note: 'قديمة' });
  assert.equal('createdAt' in w.created[3], false);
});

test('R4 طابعا المؤقّت: داخل النافذة كما هما، وفي شهرٍ آخر يُهملان (زيارةٌ بلا توقيت) — والمدّة الفاسدة كما كانت', async () => {
  const w = visitWorld();
  const now = Date.now();
  // createdAt اليوم وطابعان في أكتوبر: كان يُخزَّنان فتقع الزيارة في أكتوبر في تقارير الساعات (حقل التجميع startedAt)
  const r = await postVisit(REP, { customerId: 'c1', createdAt: iso(now - MIN), startedAt: '2026-10-30T08:00:00.000Z', endedAt: '2026-10-30T08:20:00.000Z' });
  assert.equal(r.statusCode, 201);
  assert.equal(w.created[0].createdAt.toISOString(), iso(now - MIN));
  assert.deepEqual([w.created[0].startedAt, w.created[0].endedAt, w.created[0].durationSec], [null, null, null]);
  // بدءٌ قبل ثمانية أيام (مؤقّتٌ منسيّ) وانتهاءٌ الآن ⇒ يُهمل لا يُقصّ
  await postVisit(REP, { customerId: 'c1', createdAt: iso(now), startedAt: iso(now - 8 * DAY), endedAt: iso(now) });
  assert.equal(w.created[1].durationSec, null);
  // مؤقّتٌ ممتدّ يوماً داخل النافذة ⇒ يُقصّ عند السقف كما كان
  await postVisit(REP, { customerId: 'c1', createdAt: iso(now), startedAt: iso(now - DAY), endedAt: iso(now) });
  assert.equal(w.created[2].durationSec, 4 * 3600);
  assert.equal(w.created[2].startedAt.toISOString(), iso(now - DAY));
  // مدّة سالبة ⇒ بلا توقيت كما كانت
  await postVisit(REP, { customerId: 'c1', createdAt: iso(now), startedAt: iso(now), endedAt: iso(now - MIN) });
  assert.equal(w.created[3].durationSec, null);
});

test('R4 ساعة جهازٍ متقدّمة ساعتين: لحظة الزيارة وطابعاها يُصحَّحون معاً بالترويسة فتبقى المدّة والاندماج — وبلاها إلى ساعة الخادم', async () => {
  const w = visitWorld();
  const skew = 2 * HOUR;
  const now = Date.now();
  const realEnd = now - 30_000;
  const realStart = realEnd - 10 * MIN;
  const body = { customerId: 'c1', startedAt: iso(realStart + skew), endedAt: iso(realEnd + skew), clientDurationSec: 600, createdAt: iso(realEnd + skew) };
  await postVisit(REP, body, { 'x-fs-device-now': String(now + skew) });
  const v = w.created[0];
  // تُقرأ ساعة الخادم داخل المعالج بعد الترويسة بأجزاء من الثانية — هامشٌ صغير
  assert.ok(Math.abs(v.createdAt.getTime() - realEnd) < 5_000, 'لحظة الانتهاء الحقيقية');
  assert.equal(v.endedAt.getTime() - v.startedAt.getTime(), 10 * MIN, 'المدّة لا تتغيّر بالنقل');
  assert.equal(v.createdAt.getTime(), v.endedAt.getTime(), 'createdAt = endedAt كما أرسلها التطبيق');
  assert.equal(v.durationSec, 600);
  // بلا ترويسة (حزمةٌ لا ترسلها): المستقبل ⇒ ساعة الخادم الآن، والطابعان يُنقلان معها
  const before = Date.now();
  await postVisit(REP, { ...body, clientRef: REF(3) });
  const after = Date.now();
  const u = w.created[1];
  near(u.createdAt, before, after, 'ساعة الخادم');
  assert.equal(u.endedAt.getTime(), u.createdAt.getTime());
  assert.equal(u.endedAt.getTime() - u.startedAt.getTime(), 10 * MIN);
  assert.equal(u.durationSec, 600);
});

test('R4 مؤقّت «بانتظار الاتصال» أُعيد بعد ثمانية أيام ⇒ يُسجَّل الآن بساعة الخادم ومدّته كما هي (لا شهرٌ مضى)', async () => {
  const w = visitWorld();
  const now = Date.now();
  const endedAt = iso(now - 8 * DAY);
  const before = Date.now();
  await postVisit(REP, { customerId: 'c1', startedAt: iso(now - 8 * DAY - 15 * MIN), endedAt, clientDurationSec: 900, createdAt: endedAt, lat: 24.7, lng: 46.6 });
  const after = Date.now();
  const v = w.created[0];
  near(v.createdAt, before, after, 'createdAt');
  near(v.endedAt, before, after, 'endedAt');
  assert.equal(v.endedAt.getTime() - v.startedAt.getTime(), 15 * MIN);
  assert.equal(v.durationSec, 900);
});

test('R4 الإدارة ومفتاح API بلا تغيير: اللحظة والطابعان كما أُرسلت ولو في شهرٍ مضى', async () => {
  for (const user of [ADMIN, API_KEY]) {
    const w = visitWorld();
    const r = await postVisit(user, {
      customerId: 'c1', note: 'تسجيلٌ متأخّر', createdAt: '2026-10-30T10:00:00.000Z',
      startedAt: '2026-10-30T09:40:00.000Z', endedAt: '2026-10-30T10:00:00.000Z',
    });
    assert.equal(r.statusCode, 201, user.apiKeyId ? 'مفتاح API' : 'الإدارة');
    assert.equal(w.created[0].salesRepId, 'rep-1');
    assert.equal(w.created[0].createdAt.toISOString(), '2026-10-30T10:00:00.000Z');
    assert.equal(w.created[0].startedAt.toISOString(), '2026-10-30T09:40:00.000Z');
    assert.equal(w.created[0].durationSec, 1200);
  }
});

test('R4 حارس ثابت: النافذة قبل الكتابة ولا تقرأ ترويسة الإعادة، والكتابة بالقيمة المحصورة وحدها', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src = require('fs').readFileSync(path.join(SRC, 'routes', 'visits.ts'), 'utf8') as string;
  const h = src.slice(src.indexOf("router.post('/'"), src.indexOf('\n});', src.indexOf("router.post('/'")));
  const moment = h.indexOf('repVisitMoment(body.createdAt, headerText(req.headers[DEVICE_NOW_HEADER]), clockNow)');
  assert.ok(moment > 0 && moment < h.indexOf('prisma.repVisit.create('));
  assert.ok(h.includes('...(visitCreatedAt && { createdAt: visitCreatedAt }),'));
  assert.ok(!h.includes('createdAt: new Date(body.createdAt) }'), 'عادت الكتابة الخام لكل دور');
  const fn = src.slice(src.indexOf('export function repVisitMoment('), src.indexOf("router.post('/'"));
  assert.ok(!/x-fs-replay/i.test(fn), 'النافذة لا تشترط X-FS-Replay — زيارة «بانتظار الاتصال» تُعاد حيّة');
});

// ═══ R6 — العميل الجديد ═══

function customerWorld(o: { phase2StartedAt?: Date | null; existing?: boolean } = {}) {
  calls = [];
  const created: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: false }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'companySettings.findUnique': () => ({ customerIsolationEnabled: false, zatcaPhase2StartedAt: o.phase2StartedAt ?? null }),
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, settings: { countryCode: 'SA', zatcaPhase2StartedAt: o.phase2StartedAt ?? null } }),
    'customer.findFirst': (a) => (o.existing && a?.where?.clientRef ? { id: 'c-old', createdBySalesRepId: 'rep-1', createdAt: new Date('2026-11-01T00:00:00Z') } : null),
    'customer.findUnique': () => null,
    'customer.create': (a) => { created.push(a.data); return { id: a.data.id ?? `c${created.length}`, ...a.data }; },
  };
  const phaseReads = () => calls.filter((c) => c.op === 'companySettings.findUnique' && c.args?.select?.zatcaPhase2StartedAt).length;
  return { created, phaseReads };
}
const postCustomer = (user: User, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(customersModule.default, 'post', '/', { user, body, headers });
const putCustomer = (user: User, id: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(customersModule.default, 'put', '/:id', { user, body, headers, params: { id } });
const REPLAY = (deviceNow: number) => ({ 'x-fs-replay': '1', 'x-fs-device-now': String(deviceNow) });

test('R6 عميل صندوق المندوب أُضيف ٢٢:٠٠ ورُفع صباح الغد ⇒ createdAt لحظة إضافته (شهرها) وclientCreatedAt كما أُرسل', async () => {
  const w = customerWorld();
  const now = Date.now();
  const addedAt = iso(now - 10 * HOUR);
  const r = await postCustomer(REP, { name: 'بقالة الحيّ', clientRef: REF(11), clientCreatedAt: addedAt }, REPLAY(now));
  assert.equal(r.statusCode, 201);
  assert.equal(w.created[0].createdAt.toISOString(), addedAt);
  assert.equal(w.created[0].clientCreatedAt.toISOString(), addedAt);
  assert.equal(w.created[0].createdBySalesRepId, 'rep-1');
  assert.equal(w.phaseReads(), 1, 'المرحلة الثانية تُقرأ لإعادة رفع المندوب وحدها');
});

test('R6 ساعة الجهاز المتأخّرة ساعتين تُصحَّح بـX-FS-Device-Now كفاتورته — والمتقدّمة بلا ترويسةٍ أو الأقدم من أسبوع إلى ساعة الخادم', async () => {
  const w = customerWorld();
  const now = Date.now();
  const skew = -2 * HOUR; // الجهاز متأخّر ساعتين
  const realAdded = now - 3 * HOUR;
  await postCustomer(REP, { name: 'أ', clientRef: REF(12), clientCreatedAt: iso(realAdded + skew) }, REPLAY(now + skew));
  assert.ok(Math.abs(w.created[0].createdAt.getTime() - realAdded) < 5_000, 'اللحظة الحقيقية لا لحظة الساعة المتأخّرة');
  assert.equal(w.created[0].clientCreatedAt.toISOString(), iso(realAdded + skew), 'clientCreatedAt خامٌ كما أُرسل');
  // مستقبلٌ بلا ترويسة، وأقدم من سبعة أيام، وتالف ⇒ لا createdAt (ساعة الخادم)
  await postCustomer(REP, { name: 'ب', clientRef: REF(13), clientCreatedAt: iso(now + HOUR) }, { 'x-fs-replay': '1' });
  await postCustomer(REP, { name: 'ج', clientRef: REF(14), clientCreatedAt: iso(now - 8 * DAY) }, REPLAY(now));
  await postCustomer(REP, { name: 'د', clientRef: REF(15), clientCreatedAt: 'ليس تاريخاً' }, REPLAY(now));
  for (const d of w.created.slice(1)) assert.equal('createdAt' in d, false, d.name);
});

test('R6 الإنشاء المتصل بساعة الخادم ولو كانت ساعة الجهاز منحرفة — والإدارة ومفتاح API كما كانوا', async () => {
  const w = customerWorld();
  const now = Date.now();
  // المندوب متصلاً: التطبيق يرسل clientCreatedAt مع كل إنشاء — ساعةٌ متأخّرة ساعتين لا تنقل العميل إلى الأمس
  await postCustomer(REP, { name: 'متصل', clientRef: REF(16), clientCreatedAt: iso(now - 2 * HOUR) }, { 'x-fs-device-now': String(now - 2 * HOUR) });
  // الإدارة ومفتاح API ولو أرسلا الترويسة (تُمحى للمفتاح في المصادقة، والشرط يكرّرها بهوية المصادقة)
  await postCustomer(ADMIN, { name: 'إدارة', clientCreatedAt: iso(now - DAY) }, REPLAY(now));
  await postCustomer(API_KEY, { name: 'مفتاح', clientCreatedAt: iso(now - DAY) }, REPLAY(now));
  assert.equal(w.created.length, 3);
  for (const d of w.created) assert.equal('createdAt' in d, false, d.name);
  assert.equal(w.created[0].clientCreatedAt.toISOString(), iso(now - 2 * HOUR), 'clientCreatedAt يُخزَّن كما كان');
  assert.equal(w.phaseReads(), 0, 'لا استعلام لغير إعادة رفع المندوب');
});

test('R6 المرحلة الثانية كالفاتورة: لحظة الجهاز بعد التفعيل ⇒ ساعة الخادم (فاتورته الأولى بلحظة ختمها)، وقبله ⇒ لحظة الجهاز', async () => {
  const now = Date.now();
  const w = customerWorld({ phase2StartedAt: new Date(now - DAY) });
  await postCustomer(REP, { name: 'بعد التفعيل', clientRef: REF(17), clientCreatedAt: iso(now - 3 * HOUR) }, REPLAY(now));
  await postCustomer(REP, { name: 'قبل التفعيل', clientRef: REF(18), clientCreatedAt: iso(now - 2 * DAY) }, REPLAY(now));
  assert.equal('createdAt' in w.created[0], false);
  assert.equal(w.created[1].createdAt.toISOString(), iso(now - 2 * DAY));
});

test('R6 إعادة رفعٍ لعميلٍ سبق رفعه (clientRef) تعيده كما هو بلا إنشاء ولا استعلام تأريخ', async () => {
  const w = customerWorld({ existing: true });
  const now = Date.now();
  const r = await postCustomer(REP, { name: 'مكرّر', clientRef: REF(19), clientCreatedAt: iso(now - HOUR) }, REPLAY(now));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body!.idempotent, true);
  assert.equal(w.created.length, 0);
  assert.equal(w.phaseReads(), 0);
});

test('R6 إنشاء PUT لمعرّفٍ لا يجده الطالب: صندوق المندوب بلحظة الجهاز، والمتصل والإدارة بساعة الخادم', async () => {
  const w = customerWorld();
  const now = Date.now();
  const addedAt = iso(now - 6 * HOUR);
  const a = await putCustomer(REP, 'cust-new-1', { name: 'من الصندوق', clientRef: REF(20), clientCreatedAt: addedAt }, REPLAY(now));
  const b = await putCustomer(REP, 'cust-new-2', { name: 'متصل', clientCreatedAt: addedAt });
  const c = await putCustomer(ADMIN, 'cust-new-3', { name: 'إدارة', clientCreatedAt: addedAt }, REPLAY(now));
  for (const r of [a, b, c]) assert.equal(r.statusCode, 201);
  assert.equal(w.created[0].id, 'cust-new-1');
  assert.equal(w.created[0].createdAt.toISOString(), addedAt);
  assert.equal('createdAt' in w.created[1], false);
  assert.equal('createdAt' in w.created[2], false);
  for (const d of w.created) assert.equal(d.clientCreatedAt.toISOString(), addedAt);
});

test('R6 حارس ثابت: التأريخ بـofflineInvoiceDate بالترويستين والمرحلة الثانية، ويُكتب في createdAt في الإنشاءين', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src = require('fs').readFileSync(path.join(SRC, 'routes', 'customers.ts'), 'utf8') as string;
  const fn = src.slice(src.indexOf('export async function replayCustomerCreatedAt('), src.indexOf("router.get('/',"));
  assert.ok(fn.includes("String(req.headers['x-fs-replay'] || '') === '1'"));
  assert.ok(fn.includes("req.user?.role !== 'SALES_REP' || req.user?.apiKeyId"));
  assert.ok(fn.includes('deviceNow: headerText(req.headers[DEVICE_NOW_HEADER]), phase2StartedAt: company?.zatcaPhase2StartedAt ?? null'));
  const post = src.slice(src.indexOf("router.post('/',"), src.indexOf("router.put('/:id',"));
  const put = src.slice(src.indexOf('async function createMissingOnPut('), src.indexOf("router.put('/:id',"));
  for (const [name, h] of [['POST', post], ['PUT', put]] as const) {
    const at = h.indexOf('const addedAt = await replayCustomerCreatedAt(req, tid, clientCreatedAt);');
    assert.ok(at > 0 && at < h.indexOf('prisma.customer.create('), `${name}: التأريخ قبل الإنشاء`);
    assert.ok(h.includes('...(addedAt && { createdAt: addedAt }),'), `${name}: createdAt المحصور`);
  }
});
