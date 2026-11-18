// الجرد المطلق للسيارة (POST /van-stock/loads بـtype ADJUST وmode COUNT) وتصفيرها (POST /van-stock/zero) — طلب المالك ١٦ نوفمبر ٢٠٢٦:
// «تصفير مخزون السيارة في Odoo يبقى في فيلد كمية LOT في السيارات». Odoo يرسل الكمية المعدودة لا الفرق، فالخادم يحسب الفرق تحت الأقفال:
// حركة ADJUST واحدة (بسبب COUNT) بصفوف لوطها، وإزالة المنتهي والتالف حين includeUnsellable، وإعادة تسميةٍ (CORRECTION) لتوزيع الباقي —
// ثم يعيد القراءة ويتحقّق. فوق المزيّف نفسه لحاضنة lots-van.test.ts (lots-van-fake.ts) — بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API, ADMIN, FAR1, FAR2, REP, call, codeOf, lastLoad, lot, lotRowsOf, post, reset, seedInvoice, seedMove, st, usableOf, views, warnCodes,
} from './lots-van-fake';
import { planVanCountBucket } from '../services/lotsVan';
import type { PlaceLotView } from '../services/lots';

const count = (items: unknown[], extra: Record<string, unknown> = {}, user: unknown = API) =>
  post({ salesRepId: 'r1', type: 'ADJUST', mode: 'COUNT', items, ...extra }, user);
const zero = (body: Record<string, unknown> = {}, user: unknown = API) => call('post', '/zero', { body: { salesRepId: 'r1', ...body }, user });
/** رصيد الصنف في السيارة: الإجمالي والصالح لكل تشغيلة وغير المسمّى */
async function vanOf(pid: string, lotIds: string[]) {
  const v = (await views(pid)).van;
  return { total: v.total?.SELLABLE ?? 0, lots: lotIds.map((id) => usableOf(v, id)), unknown: v.unknownUsable?.SELLABLE ?? 0, expired: v.total?.EXPIRED ?? 0 };
}

test('COUNT 0: سيارةٌ فيها L1 ٧٠ (حُمّل ١٠٠ وبيع ٣٠) ⇒ ADJUST −٧٠ بسبب COUNT وصفّ L1 −٧٠، والصنف والتشغيلة وغير المسمّى صفر؛ والإعادة noop ثم بالمرجع replay، والواجهة 403', async () => {
  reset({ warehouse: false });
  lot('l1', 'pB', FAR1);
  seedMove('r1', 'LOAD', 'pB', 100, [{ lotId: 'l1', qty: 100 }], { via: false });
  seedInvoice('r1', 'CASH', 'pB', 30, [{ lotId: 'l1', qty: 30 }]);
  const ui = await count([{ productId: 'pB', qty: 0 }], {}, ADMIN);
  assert.deepEqual([ui.statusCode, codeOf(ui)], [403, 'COUNT_API_KEY_ONLY'], 'الجرد بالكمية المعدودة لمفتاح الربط وحده');
  const n0 = st().vanLoads.length;
  const r = await count([{ productId: 'pB', qty: 0 }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(st().vanLoads.length, n0 + 1);
  assert.deepEqual([lastLoad().type, lastLoad().reason], ['ADJUST', 'COUNT']);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [['l1', -70]]);
  assert.deepEqual(await vanOf('pB', ['l1']), { total: 0, lots: [0], unknown: 0, expired: 0 });
  // متكرّرٌ بالبناء: الخطة فارغة ⇒ 200 بلا كتابة
  const again = await count([{ productId: 'pB', qty: 0 }]);
  assert.deepEqual([again.statusCode, again.body?.noop], [200, true]);
  assert.ok(warnCodes(again).includes('COUNT_MATCHES'));
  assert.equal(st().vanLoads.length, n0 + 1);
  // الكمية المعدودة فوق الرصيد: الزيادة إلى غير المسمّى (لا رقم يُخترع) — ومرجعها يُعاد 200 replay بلا كتابة
  const up = await count([{ productId: 'pB', qty: 6 }], { clientRef: 'cnt-1' });
  assert.equal(up.statusCode, 201, JSON.stringify(up.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty, x.certainty]), [[null, 6, 'UNKNOWN']]);
  const n1 = st().vanLoads.length;
  const rep = await count([{ productId: 'pB', qty: 6 }], { clientRef: 'cnt-1' });
  assert.deepEqual([rep.statusCode, rep.body?.replay], [200, true]);
  assert.equal(st().vanLoads.length, n1);
  assert.deepEqual(await vanOf('pB', ['l1']), { total: 6, lots: [0], unknown: 6, expired: 0 });
  // المندوب لا يجرد
  const byRep = await count([{ productId: 'pB', qty: 0 }], {}, REP);
  assert.equal(byRep.statusCode, 403);
});

test('COUNT 0 بعجزٍ تاريخي: الصنف ١٠ والمسمّاة L1 ١٠ + L2 ٥ (غير المسمّى −٥) ⇒ ADJUST −١٠ من L1 وإعادة تسمية L2 ٥ إلى غير المسمّى، والكل صفر', async () => {
  reset({ warehouse: false });
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  seedMove('r1', 'LOAD', 'pB', 10, [{ lotId: 'l1', qty: 10 }], { via: false });
  seedMove('r1', 'LOAD', 'pB', 5, [{ lotId: 'l2', qty: 5 }], { via: false });
  seedMove('r1', 'ADJUST', 'pB', -5, []); // نقصٌ قديم بلا صفوف لوط ⇒ غير المسمّى −٥
  assert.deepEqual(await vanOf('pB', ['l1', 'l2']), { total: 10, lots: [10, 5], unknown: -5, expired: 0 });
  const r = await count([{ productId: 'pB', qty: 0 }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [['l1', -10]]);
  assert.deepEqual(st().relabels.map((x) => [x.fromLotId, x.toLotId, x.qty, x.reason, x.place, x.vanKey]), [['l2', null, 5, 'CORRECTION', 'VAN', 'r1']]);
  assert.deepEqual(await vanOf('pB', ['l1', 'l2']), { total: 0, lots: [0, 0], unknown: 0, expired: 0 });
  assert.ok(st().events.some((e) => e.kind === 'RELABEL' && e.lotId === 'l2'), 'سطرٌ في سجلّ التشغيلة');
});

test('COUNT بتشغيلات: L1 ١٠ + L2 ٥ ⇒ الصنف ١٢ وL1 ٤ (برقمٍ بحالة أحرفٍ أخرى) وNEWC ٢ جديدة ⇒ L1 ٤ وL2 ٠ وNEWC ٢ (LOT_CREATED) وغير المسمّى ٦', async () => {
  reset({ warehouse: false });
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  seedMove('r1', 'LOAD', 'pB', 10, [{ lotId: 'l1', qty: 10 }], { via: false });
  seedMove('r1', 'LOAD', 'pB', 5, [{ lotId: 'l2', qty: 5 }], { via: false });
  const r = await count([{ productId: 'pB', qty: 12, lots: [{ lotNumber: ' l1 ', qty: 4 }, { lotNumber: 'newc', qty: 2, expiryDate: FAR2 }] }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(warnCodes(r).includes('LOT_CREATED'));
  const c = st().lots.find((l) => l.lotNumber === 'NEWC');
  assert.ok(c, 'الرقم الجديد أُنشئ مطبَّعاً');
  assert.deepEqual(await vanOf('pB', ['l1', 'l2', c!.id]), { total: 12, lots: [4, 0, 2], unknown: 6, expired: 0 });
  // التشغيلات المعدودة أكبر من كمية الصنف ⇒ يُعتمد مجموعها بتحذير
  const ex = await count([{ productId: 'pB', qty: 1, lots: [{ lotId: 'l1', qty: 4 }] }]);
  assert.equal(ex.statusCode, 201, JSON.stringify(ex.body));
  assert.ok(warnCodes(ex).includes('COUNT_LOTS_EXCEED'));
  assert.deepEqual(await vanOf('pB', ['l1', 'l2', c!.id]), { total: 4, lots: [4, 0, 0], unknown: 0, expired: 0 });
});

test('COUNT: المرتجع المحجوز (إشعار ٠١ ينتظر حالته، D24) يبقى بتحذير LOT_HELD_REMAINS، والمعرّف لشركةٍ أخرى «غير موجود» لا يُكشف ولا يُنشأ', async () => {
  reset({ warehouse: false });
  lot('l1', 'pB', FAR1); lot('lx', 'pB', FAR1, { tenantId: 'other' });
  seedMove('r1', 'LOAD', 'pB', 10, [{ lotId: 'l1', qty: 10 }], { via: false });
  seedInvoice('r1', 'RETURN', 'pB', 3, [{ lotId: 'l1', qty: 3 }], { zatcaPhase: 2, invoiceSubtype: '01' });
  const r = await count([{ productId: 'pB', qty: 0 }]);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(warnCodes(r).includes('LOT_HELD_REMAINS'));
  const v = await vanOf('pB', ['l1']);
  assert.equal(v.total, 3, 'المحجوز لا يُزال');
  assert.equal(v.lots[0], 0, 'صالح التشغيلة صفر');
  const n = st().lots.length;
  const iso = await count([{ productId: 'pB', qty: 5, lots: [{ lotId: 'lx', qty: 5 }] }]);
  assert.equal(iso.statusCode, 201, JSON.stringify(iso.body));
  const w = (iso.body?.warnings as { code: string; detail?: Record<string, unknown> }[]).find((x) => x.code === 'LOT_NUMBER_UNKNOWN');
  assert.equal(w?.detail?.reason, 'NOT_FOUND', 'لا يُكشف أنه لشركةٍ أخرى');
  assert.equal(st().lots.length, n);
  assert.ok(!JSON.stringify(iso.body).includes('"other"'));
});

test('POST /van-stock/zero: كل صنفٍ في السيارة صفر — المتتبَّع وغير المتتبَّع والمنتهي (includeUnsellable الافتراضي) — والإعادة noop، والإدارة مسموحة والمندوب 403', async () => {
  reset({ warehouse: false });
  lot('l1', 'pB', FAR1);
  seedMove('r1', 'LOAD', 'pB', 8, [{ lotId: 'l1', qty: 8 }], { via: false });
  seedMove('r1', 'LOAD', 'pU', 7, []);
  seedInvoice('r1', 'RETURN', 'pB', 2, [{ lotId: 'l1', qty: 2 }], { returnExpired: true });
  const before = await vanOf('pB', ['l1']);
  assert.equal(before.expired, 2);
  assert.equal((await zero({}, REP)).statusCode, 403);
  const r = await zero();
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const types = st().vanLoads.slice(-2).map((l) => l.type).sort();
  assert.deepEqual(types, ['ADJUST', 'EXPIRED_OUT']);
  assert.deepEqual(await vanOf('pB', ['l1']), { total: 0, lots: [0], unknown: 0, expired: 0 });
  assert.equal((await views('pU')).van.total?.SELLABLE ?? 0, 0, 'غير المتتبَّع صفر أيضاً');
  const again = await zero({}, ADMIN);
  assert.deepEqual([again.statusCode, again.body?.noop], [200, true]);
});

test('planVanCountBucket (صرفة): الإنقاص من المسمّاة بالأقرب انتهاءً ثم غير المسمّى، والزيادة إلى غير المسمّى، والسالب يُرفع إلى صفر — ومجموع النهائي = الهدف', () => {
  const b = { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 };
  const lotRow = (lotId: string, u: number) => ({ lotId, usable: { ...b, SELLABLE: u }, held: { ...b }, raw: { ...b, SELLABLE: u } });
  const view = (lots: [string, number][], unknown: number) => ({
    productId: 'p', place: 'VAN', vanKey: 'r1', total: { ...b }, lots: lots.map(([id, u]) => lotRow(id, u)), unknown: { ...b, SELLABLE: unknown },
    unknownUsable: { ...b, SELLABLE: unknown }, deficits: [], firstInAt: new Map(), approximate: false,
  }) as unknown as PlaceLotView;
  const down = planVanCountBucket(view([['a', 6], ['b', 4]], 3), 'SELLABLE', 5, null);
  assert.equal(down.net, -8);
  assert.deepEqual(down.moves, [{ lotId: 'a', qty: -6 }, { lotId: 'b', qty: -2 }]);
  assert.deepEqual(down.relabels, []);
  const up = planVanCountBucket(view([['a', 2]], 0), 'SELLABLE', 5, null);
  assert.deepEqual(up.moves, [{ lotId: null, qty: 3 }]);
  const deficit = planVanCountBucket(view([['a', 10], ['b', 5]], -5), 'SELLABLE', 0, null);
  assert.deepEqual([deficit.net, deficit.moves, deficit.relabels], [-10, [{ lotId: 'a', qty: -10 }], [{ fromLotId: 'b', toLotId: null, qty: 5 }]]);
  for (const p of [down, up, deficit]) for (const v of p.targets.values()) assert.ok(v >= 0, 'لا مكوّن سالب');
});
