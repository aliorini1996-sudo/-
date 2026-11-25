// «قبول المندوب للتحميل وتوقيعه» × «تتبّع اللوط» — فوق حاضنة lots-van-fake.ts (مسار اللوط الحقيقي: الطابور وأقفال الأصناف وخطة التوزيع):
//  · الإرسال تجربةٌ بلا كتابة: لا حركة ولا صفوف توزيع ولا تشغيلة جديدة ولا سجل تدقيق — كلها تُجهض مع المعاملة.
//  · القبول يكتب الحركة بتشغيلاتها كما لو سجّلتها الإدارة، وسجل تدقيق التشغيلة باسم المرسِل لا المندوب.
//  · تشغيلةٌ صريحة لم يعد صالحها يكفي ⇒ 409 PENDING_LOAD_LOTS_SHORT، ونقص الصنف كله كذلك — بلا كتابة ويبقى معلّقاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAR1, FAR2, db, router, st, reset, lot, receive, lotRowsOf, lastLoad, views, usableOf, ADMIN, REP, type Res } from './lots-van-fake';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
// التنبيه يُحمَّل عند الإرسال (استيرادٌ متأخّر) — بديلٌ يسجّله بلا شبكة
const pushes: string[] = [];
stub('services/webPush', { sendPushToRep: async (id: string) => { pushes.push(id); return 1; } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// الإعداد مفعّل، وجدول المعلّق في الذاكرة (معاملة الحاضنة هي القاعدة نفسها)
let pending: Row[] = [];
let seq = 0;
const D = db as Row;
D.companySettings = { findUnique: async () => ({ vanLoadAcceptance: true }) };
const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(r[k]) : r[k] === v));
D.pendingVanLoad = {
  findFirst: async ({ where }: { where: Row }) => { const r = pending.find((x) => match(x, where)); return r ? { ...r, body: JSON.parse(JSON.stringify(r.body)), salesRep: null } : null; },
  create: async ({ data }: { data: Row }) => {
    const now = new Date();
    const row: Row = {
      id: `pl${++seq}`, revision: 1, note: null, clientRef: null, disputeNote: null, disputedAt: null, acceptedAt: null, signature: null, acceptedLat: null,
      acceptedLng: null, vanLoadId: null, cancelledAt: null, cancelledById: null, cancelledByName: null, ...data, createdAt: now, updatedAt: now,
    };
    pending.push(row);
    return { ...row, salesRep: null };
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => { const r = pending.find((x) => x.id === where.id)!; Object.assign(r, data); return r; },
};

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] }; handle: (...a: unknown[]) => unknown }
const layers = (router as unknown as { stack: Layer[] }).stack;
const errLayer = layers.find((l) => !l.route && l.handle.length === 4)!;
async function call(p: string, body: unknown, user: unknown, params: Record<string, string> = {}): Promise<Res> {
  const route = layers.find((l) => l.route?.path === p && l.route.methods.post)!.route!;
  const res: Res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b as Record<string, unknown>; return this; } };
  const req = { user, body, query: {}, headers: {}, params };
  let err: unknown = null;
  await route.stack[route.stack.length - 1].handle(req, res, (e?: unknown) => { if (e) err = e; });
  if (err) {
    let passed: unknown = null;
    errLayer.handle(err, req, res, (e?: unknown) => { passed = e ?? null; });
    if (passed) { res.statusCode = 500; res.body = { success: false, unhandled: String((passed as Error)?.message ?? passed) }; }
  }
  return res;
}
const SIG = 'data:image/png;base64,iVBORw0KGgo=';
const send = (items: unknown[]) => call('/loads', { salesRepId: 'r1', type: 'LOAD', items }, ADMIN);
const accept = (id: string) => call('/pending-loads/:id/accept', { signature: SIG, revision: 1 }, REP, { id });
const freshPending = () => { pending = []; seq = 0; pushes.length = 0; };

test('اللوط بالمستودع: الإرسال بلا أي كتابة، والقبول يوزّع على التشغيلة الصريحة كتحميل الإدارة', async () => {
  reset(); freshPending();
  const S = st();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  receive('pB', 10, 'l1'); receive('pB', 10, 'l2');
  const r = await send([{ productId: 'pB', qty: 4, lots: [{ lotId: 'l2', qty: 4 }] }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body!.pending, true);
  assert.equal(S.vanLoads.length, 0);
  assert.equal(S.vanItemLots.length, 0, 'لا صفوف توزيع');
  assert.ok(S.log.some((x) => x === 'q:FOR KEY SHARE'), 'التجربة بلغت أقفال الأصناف وخطة اللوط');
  const lines = (r.body!.data as Row).lines as Row[];
  assert.deepEqual(lines.map((l) => [l.productId, l.baseQty, (l.lots as Row[]).map((x) => [x.lotId, x.qty])]), [['pB', 4, [['l2', 4]]]]);
  const before = await views('pB');
  assert.equal(usableOf(before.wh, 'l2'), 10, 'المستودع كما هو');
  const a = await accept((r.body!.data as Row).id);
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  const load = lastLoad() as Row;
  assert.equal(load.createdBy, 'ADMIN');
  assert.deepEqual(lotRowsOf(load.id)[0].map((x) => [x.lotId, x.qty, x.viaWarehouse, x.vanKey]), [['l2', 4, true, 'r1']]);
  const after = await views('pB');
  assert.deepEqual([usableOf(after.wh, 'l2'), usableOf(after.van, 'l2')], [6, 4]);
  assert.equal(pending[0].status, 'ACCEPTED');
});

test('اللوط بلا مستودع (D4): التشغيلة الجديدة لا تُنشأ عند الإرسال، وتُنشأ عند القبول بسجل تدقيقٍ باسم المرسِل', async () => {
  reset({ warehouse: false }); freshPending();
  const S = st();
  const r = await send([{ productId: 'pB', qty: 6, lotNumber: 'NEW-1', expiryDate: FAR1 }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(!S.lots.some((l) => l.lotNumber === 'NEW-1'), 'تجربةٌ أُجهضت: لا تشغيلة');
  assert.equal(S.events.length, 0, 'ولا سجل تدقيق');
  const a = await accept((r.body!.data as Row).id);
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  const created = S.lots.find((l) => l.lotNumber === 'NEW-1')!;
  assert.ok(created);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [[created.id, 6]]);
  const ev = S.events.find((e) => e.kind === 'CREATE')!;
  assert.deepEqual([ev.actorType, ev.actorId, ev.actorName], ['ADMIN', 'adm1', 'مدير'], 'فاعل التشغيلة المرسِل لا المندوب');
});

test('جلسة موظف المنصة: فاعل سجل التشغيلة عند القبول كما كان سيكتبه المسار المباشر لحظة الإرسال (بمعرّفه لا بمعرّف مدير الشركة المنتحَل)', async () => {
  reset({ warehouse: false }); freshPending();
  const S = st();
  const staff = { ...ADMIN, impersonated: true, byKind: 'STAFF', by: 'st9' };
  const r = await call('/loads', { salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 2, lotNumber: 'NEW-S', expiryDate: FAR1 }] }, staff);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(pending[0].createdByActor, { type: 'STAFF', id: 'st9', name: 'موظف المنصة' }, 'lotEventActorOf لحظة الإرسال');
  assert.ok(!('createdByActor' in (r.body!.data as Row)), 'داخليٌّ لا يصل الردّ');
  const a = await accept((r.body!.data as Row).id);
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  const ev = S.events.find((e) => e.kind === 'CREATE')!;
  assert.deepEqual([ev.actorType, ev.actorId, ev.actorName], ['STAFF', 'st9', 'موظف المنصة']);
  // صفٌّ أقدم بلا الفاعل المحفوظ ⇒ من المرسِل كما كان
  reset({ warehouse: false }); freshPending();
  const S2 = st();
  const r2 = await send([{ productId: 'pB', qty: 1, lotNumber: 'NEW-O', expiryDate: FAR1 }]);
  assert.equal(r2.statusCode, 201, JSON.stringify(r2.body));
  delete pending[0].createdByActor;
  assert.equal((await accept((r2.body!.data as Row).id)).statusCode, 200);
  const ev2 = S2.events.find((e) => e.kind === 'CREATE')!;
  assert.deepEqual([ev2.actorType, ev2.actorId, ev2.actorName], ['ADMIN', 'adm1', 'مدير']);
});

test('اللوط عند القبول: الصريح لم يعد يكفي ⇒ 409 PENDING_LOAD_LOTS_SHORT بتحذيره، ونقص الصنف كله كذلك — بلا كتابة ويبقى معلّقاً', async () => {
  reset(); freshPending();
  const S = st();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  receive('pB', 5, 'l1'); receive('pB', 5, 'l2');
  const r = await send([{ productId: 'pB', qty: 4, lots: [{ lotId: 'l2', qty: 4 }] }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const id = (r.body!.data as Row).id as string;
  // تحميلٌ مباشر (المندوب نفسه ومسار الخادم) يصرف من l2 قبل القبول
  assert.equal((await call('/loads', { salesRepId: 'r2', type: 'LOAD', items: [{ productId: 'pB', qty: 3, lots: [{ lotId: 'l2', qty: 3 }] }] }, { ...ADMIN, apiKeyId: 'k1' })).statusCode, 201);
  const n = S.vanLoads.length;
  const short = await accept(id);
  assert.deepEqual([short.statusCode, short.body!.code], [409, 'PENDING_LOAD_LOTS_SHORT'], JSON.stringify(short.body));
  assert.deepEqual((short.body!.warnings as Row[]).map((w) => w.code), ['LOT_EXPLICIT_FALLBACK']);
  assert.equal(S.vanLoads.length, n);
  assert.equal(pending[0].status, 'PENDING');
  // ونفد الصنف كله ⇒ LotError (LOT_STOCK_INSUFFICIENT) ⇒ PENDING_LOAD_LOTS_SHORT بتفاصيله
  assert.equal((await call('/loads', { salesRepId: 'r2', type: 'LOAD', items: [{ productId: 'pB', qty: 7 }] }, { ...ADMIN, apiKeyId: 'k1' })).statusCode, 201);
  const none = await accept(id);
  assert.deepEqual([none.statusCode, none.body!.code, (none.body!.lot as Row)?.code], [409, 'PENDING_LOAD_LOTS_SHORT', 'LOT_STOCK_INSUFFICIENT'], JSON.stringify(none.body));
  assert.equal(pending[0].status, 'PENDING');
  // والإرسال بصريحٍ لا يكفيه صالحه ⇒ 422 PENDING_LOAD_LINES_CHANGED (المندوب لا يوقّع على غير ما أُرسل)
  receive('pB', 3, 'l1');
  const over = await send([{ productId: 'pB', qty: 3, lots: [{ lotId: 'l2', qty: 3 }] }]);
  assert.deepEqual([over.statusCode, over.body!.code], [422, 'PENDING_LOAD_LINES_CHANGED'], JSON.stringify(over.body));
  assert.equal(pending.length, 1);
});
