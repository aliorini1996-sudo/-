// «تتبّع اللوط» في تطبيق الإدارة على الجوال (W5): المنطق الصرف في m/mLotsLogic.ts، وحرّاس نصّية على الشاشات والقوقعة والقاموس
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  newRowId, lineBaseQty, shelfLifeOn, resolveShelfOn, isTracked, fefoLinesParam, emptyLotDraft, lotDraftProblem, entryLotFields, loadLotFields,
  lotPickChoices, stalePick, vanOutSources, prefillOut, prefillOutLines, sourcesLeftFor, setOutQty, outGroupProblems, whOutSources, whOutRows,
  lotLineLabel, lotListParams, nextLotsLimit, statusReasonProblem, scopedLotUser,
  unloadPlanRows, unloadPlanTotals, unloadPlanHasRemovals, weakestCertainty, customerLotTotals, telHref, trackedDemand, vanAvailableOf, vanLotShortages,
  LOT_DRAFT_PROBLEMS, VAN_OUT_PROBLEMS, WH_OUT_PROBLEMS, STATUS_REASON_PROBLEMS, LOT_CACHE_KEYS, STOCK_CACHE_KEYS, M_LOTS_PAGE, M_LOTS_MAX, M_LOTS_SOON_DAYS,
  LOT_REASON_MAX, type LotDraft, type OutSource,
} from './mLotsLogic';
import type { LotRef, LotTraceDto, LotUnloadPlanDto, PlaceLotViewDto, VanLotSnapshotDto } from '../lib/lots';
import { statusActions } from '../lib/lotsPage';

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, 'src', ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

/** مفاتيح PHRASES بأجسامها — من إعلانها إلى أول إغلاق بعده (كحارس lib/lots.test.ts) */
function phrases(): Map<string, string> {
  const s = read('i18n', 'strings.ts');
  const at = s.indexOf('export const PHRASES');
  assert.ok(at >= 0, 'PHRASES غير موجودة');
  const body = s.slice(at, s.indexOf('\n};\n', at));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:\s*\{(.*)\},?\s*$/gm)) out.set(m[1], m[2]);
  return out;
}
const assertTranslated = (have: Map<string, string>, ar: string, where: string) => {
  const t = have.get(ar);
  assert.ok(t, `عبارة بلا ترجمة (${where}): ${ar}`);
  for (const lang of ['en', 'fr', 'tr', 'zh']) assert.match(t!, new RegExp(`\\b${lang}:\\s*'[^']+'`), `«${ar}» بلا ${lang}`);
};

// ═══════════════ الأساسيات ═══════════════

test('newRowId فريدٌ في الجلسة — مفتاح React وهدف التعديل', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newRowId()));
  assert.equal(ids.size, 500);
});

test('lineBaseQty: القيمة المطلقة × المعامل بأربع خانات، والمعامل التالف ١، وغير الرقم صفر', () => {
  assert.equal(lineBaseQty(2, 24), 48);
  assert.equal(lineBaseQty(-3, 6), 18);
  assert.equal(lineBaseQty(1.23456, 1), 1.2346);
  for (const bad of [0, -2, NaN, null, undefined]) assert.equal(lineBaseQty(5, bad as number), 5, `معامل ${bad}`);
  assert.equal(lineBaseQty(NaN, 2), 0);
});

test('shelfLifeOn = shelfLifeOf في الخادم: مفعّلة بمدة صحيحة موجبة ووحدة معروفة', () => {
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }), true);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 0, shelfLifeUnit: 'DAY' }), false);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 1.5, shelfLifeUnit: 'YEAR' }), false);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'WEEK' }), false);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: false, shelfLifeValue: 3, shelfLifeUnit: 'DAY' }), false);
  assert.equal(shelfLifeOn(null), false);
});

test('isTracked: علم الشركة وعلم الصنف معاً — والمطفأة تُخفي ولا تحذف (D8)', () => {
  assert.equal(isTracked(true, { lotTracked: true }), true);
  assert.equal(isTracked(false, { lotTracked: true }), false);
  assert.equal(isTracked(true, { lotTracked: false }), false);
  assert.equal(isTracked(true, null), false);
});

test('fefoLinesParam: «كمية:معامل» بالأساس، والأصفار تسقط', () => {
  assert.equal(fefoLinesParam([{ qty: 2, unitFactor: 24 }, { qty: 5, unitFactor: 1 }, { qty: 0, unitFactor: 6 }, { qty: 3 }]), '48:24,5:1,3:1');
  assert.equal(fefoLinesParam([]), '');
});

// ═══════════════ مسودّة تشغيلة السطر ═══════════════

const draft = (p: Partial<LotDraft>): LotDraft => ({ ...emptyLotDraft(), ...p });

test('lotDraftProblem: كل فرعٍ برسالته — مرآة الوارد والتسوية والتحميل بلا مستودع', () => {
  const P = LOT_DRAFT_PROBLEMS;
  // بلا اختيار: الزيادة تلزمها تشغيلة، والنقص يختار الخادم مصدره الوحيد (D10)
  assert.equal(lotDraftProblem(draft({}), 'IN_STRICT', { shelfOn: false }), P.PICK);
  assert.equal(lotDraftProblem(draft({}), 'IN', { shelfOn: false }), P.PICK);
  assert.equal(lotDraftProblem(draft({}), 'OUT', { shelfOn: false }), null);
  // «غير مسمى»: يُرفض في الوارد وحده (LOT_REQUIRED)
  assert.equal(lotDraftProblem(draft({ pick: 'UNNAMED' }), 'IN_STRICT', { shelfOn: false }), P.RECEIVE_NEEDS_LOT);
  assert.equal(lotDraftProblem(draft({ pick: 'UNNAMED' }), 'IN', { shelfOn: true }), null);
  assert.equal(lotDraftProblem(draft({ pick: 'UNNAMED' }), 'OUT', { shelfOn: false }), null);
  // جديدة: لا في النقص، والرقم المطبَّع، والانتهاء الإلزامي مع الصلاحية، والترتيب
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: 'L1' }), 'OUT', { shelfOn: false }), P.OUT_NEEDS_SOURCE);
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: '   ' }), 'IN', { shelfOn: false }), P.NUMBER);
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: 'L1' }), 'IN_STRICT', { shelfOn: true }), P.EXPIRY_REQUIRED);
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: 'L1', productionDate: '2026-05-02', expiryDate: '2026-05-01' }), 'IN', { shelfOn: false }), P.DATES);
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: 'L1', expiryDate: '2026-02-30' }), 'IN', { shelfOn: false }), P.DATES);
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: '٠١٢', expiryDate: '2027-01-01' }), 'IN_STRICT', { shelfOn: true }), null);
  // التحميل بلا مستودع (LOAD) كالزيادة: تشغيلةٌ أو جديدة أو «غير مسمى»
  assert.equal(lotDraftProblem(draft({}), 'LOAD', { shelfOn: false }), P.PICK);
  assert.equal(lotDraftProblem(draft({ pick: 'UNNAMED' }), 'LOAD', { shelfOn: true }), null);
  assert.equal(lotDraftProblem(draft({ pick: 'NEW', lotNumber: 'L1' }), 'LOAD', { shelfOn: true }), P.EXPIRY_REQUIRED);
  // I4: تشغيلةٌ جديدة انتهاؤها قبل يوم الشركة لا تُحمَّل (LOT_EXPIRED بعد إنشائها) — ويوم الانتهاء نفسه صالح، والوارد يقبلها
  const old = draft({ pick: 'NEW', lotNumber: 'L1', expiryDate: '2026-10-29' });
  assert.equal(lotDraftProblem(old, 'LOAD', { shelfOn: false, day: '2026-10-30' }), P.EXPIRED_LOAD);
  assert.equal(lotDraftProblem(old, 'LOAD', { shelfOn: false, day: '2026-10-29' }), null);
  assert.equal(lotDraftProblem(old, 'LOAD', { shelfOn: false }), null, 'بلا يوم الشركة لا حكم');
  assert.equal(lotDraftProblem(old, 'IN', { shelfOn: false, day: '2026-10-30' }), null);
  // تشغيلة قائمة: مقبولة في كل اتجاه (أهليّتها في lotPickChoices، ورصيدها في outGroupProblems، والخادم صاحب القرار)
  for (const mode of ['IN_STRICT', 'IN', 'LOAD', 'OUT'] as const) assert.equal(lotDraftProblem(draft({ pick: 'lot-1' }), mode, { shelfOn: true }), null);
});

test('entryLotFields: سطرٌ = تشغيلة — الفارغ لا حقل، و«غير مسمى» null صريح، والجديدة برقمٍ مطبَّع', () => {
  assert.deepEqual(entryLotFields(draft({})), {});
  assert.deepEqual(entryLotFields(draft({ pick: 'UNNAMED' })), { lotId: null });
  assert.deepEqual(entryLotFields(draft({ pick: 'lot-9' })), { lotId: 'lot-9' });
  assert.deepEqual(entryLotFields(draft({ pick: 'NEW', lotNumber: ' l-12 ', expiryDate: '2027-01-01' })),
    { lotNumber: 'L-12', productionDate: null, expiryDate: '2027-01-01' });
});

test('loadLotFields (D4): القائمة و«غير مسمى» صفٌّ صريح بكمية السطر الأساسية، والجديدة رقمٌ وتاريخان', () => {
  assert.deepEqual(loadLotFields(draft({}), 48), {});
  assert.deepEqual(loadLotFields(draft({ pick: 'UNNAMED' }), 48), { lots: [{ lotId: null, qty: 48 }] });
  assert.deepEqual(loadLotFields(draft({ pick: 'lot-1' }), 1.23456), { lots: [{ lotId: 'lot-1', qty: 1.2346 }] });
  assert.deepEqual(loadLotFields(draft({ pick: 'NEW', lotNumber: 'a1', productionDate: '2026-01-01' }), 5),
    { lotNumber: 'A1', productionDate: '2026-01-01', expiryDate: null });
});

// ═══════════════ مصادر التنزيل من السيارة ═══════════════

const DAY = '2026-10-30';
const snapProduct = (): VanLotSnapshotDto['products'][number] => ({
  productId: 'p1', available: 9, availableNamed: 9, unknownUsable: 7, quarantined: 3, held: 0, expiredUnsold: 3, expiredReturned: 0, damaged: 0,
  lots: [
    { lotId: 'A', lotNumber: 'A', expiryDate: '2027-01-01', status: 'ACTIVE', blockKind: null, usable: 5 },
    { lotId: 'B', lotNumber: 'B', expiryDate: '2027-06-01', status: 'BLOCKED', blockKind: 'HOLD', usable: 2 },
    { lotId: 'C', lotNumber: 'C', expiryDate: '2027-09-01', status: 'BLOCKED', blockKind: 'RECALL', usable: 1 },
    { lotId: 'D', lotNumber: 'D', expiryDate: '2026-01-01', status: 'ACTIVE', blockKind: null, usable: 3 },
    { lotId: 'E', lotNumber: 'E', expiryDate: '2026-12-01', status: 'ACTIVE', blockKind: null, usable: 4 },
    { lotId: 'F', lotNumber: 'F', expiryDate: '2026-11-01', status: 'ACTIVE', blockKind: null, usable: 0 },
    { lotId: 'G', lotNumber: 'G', expiryDate: DAY, status: 'ACTIVE', blockKind: null, usable: 1 },
  ],
});

test('vanOutSources: المسحوب ثم الموقوف ثم المنتهي ثم FEFO، وغير المسمّى آخراً، والصفر يسقط', () => {
  const s = vanOutSources(snapProduct(), DAY);
  assert.deepEqual(s.map(x => x.lotId), ['C', 'B', 'D', 'G', 'E', 'A', null]);
  assert.equal(s.find(x => x.lotId === 'D')!.expired, true);
  // يوم الانتهاء نفسه آخر يوم صالح
  assert.equal(s.find(x => x.lotId === 'G')!.expired, false);
  assert.equal(s[s.length - 1].usable, 7);
  assert.deepEqual(vanOutSources(null, DAY), []);
  assert.deepEqual(vanOutSources({ ...snapProduct(), unknownUsable: 0 }, DAY).map(x => x.lotId).includes(null), false);
});

test('prefillOut وsetOutQty: التوزيع الأوّلي بترتيب المصادر، والتعديل يحفظ الترتيب ويحذف الصفر', () => {
  const s = vanOutSources(snapProduct(), DAY);
  assert.deepEqual(prefillOut(s, 6), [{ lotId: 'C', qty: 1 }, { lotId: 'B', qty: 2 }, { lotId: 'D', qty: 3 }]);
  // أكبر من المجموع: كل المصادر، والناقص يبقى ناقصاً فيُرى
  const all = prefillOut(s, 100);
  assert.equal(all.reduce((t, r) => t + r.qty, 0), 23);
  assert.deepEqual(prefillOut(s, 0), []);
  let rows = setOutQty([{ lotId: 'D', qty: 3 }], s, 'C', 1);
  assert.deepEqual(rows, [{ lotId: 'C', qty: 1 }, { lotId: 'D', qty: 3 }]);
  rows = setOutQty(rows, s, 'D', 0);
  assert.deepEqual(rows, [{ lotId: 'C', qty: 1 }]);
  assert.deepEqual(setOutQty(rows, s, 'C', NaN), []);
});

/** سطرٌ واحد بمشكلاته — اختصارٌ لأسطر الحالة الواحدة */
const one1 = (sources: readonly OutSource[], rows: LotRef[] | null, base: number, loaded = true) =>
  outGroupProblems(sources, [{ key: 'k', base, rows }], { loaded }).get('k') ?? null;

test('outGroupProblems لسطرٍ واحد: مرآة pickOutSources قبل الإرسال (D10، I1)', () => {
  const s = vanOutSources(snapProduct(), DAY);
  const single: OutSource[] = [s[0]];
  assert.equal(one1(s, [], 5, false), null, 'بلا لقطة لا حكم');
  assert.equal(one1([], null, 5), 'NO_BALANCE');
  assert.equal(one1(s, prefillOut(s, 30), 30), 'OVER');
  assert.equal(one1(single, null, 1), null, 'المصدر الوحيد يختاره الخادم');
  assert.equal(one1(single, null, 2), 'OVER');
  assert.equal(one1(s, null, 3), 'PICK', 'أكثر من مصدر بلا صريح: LOT_REQUIRED');
  assert.equal(one1(s, [], 3), 'DISTRIBUTE', 'صريحٌ فارغ');
  assert.equal(one1(s, [{ lotId: 'C', qty: 1 }], 3), 'DISTRIBUTE', 'مجموعٌ ناقص');
  assert.equal(one1(s, [{ lotId: 'C', qty: 2 }, { lotId: 'B', qty: 1 }], 3), 'ROW_OVER');
  assert.equal(one1(s, [{ lotId: 'F', qty: 1 }], 1), 'ROW_OVER', 'تشغيلةٌ ليست مصدراً صالحها صفر');
  assert.equal(one1(s, prefillOut(s, 6), 6), null);
});

test('أسطر تنزيل صنفٍ واحد بوحدتين (D26): «−١ كرتون» و«−٥ حبّات» على متاحٍ مشترك — لا يأخذ السطران التشغيلة نفسها', () => {
  const src = (lots: [string, number][]): OutSource[] =>
    lots.map(([id, u]) => ({ lotId: id, lotNumber: id, expiryDate: null, status: 'ACTIVE', blockKind: null, usable: u, expired: false }));
  const lines = [{ key: 'pcs', base: 5, factor: 1 }, { key: 'ctn', base: 24, factor: 24 }];
  // مصدران A:24 وB:24 — الكرتون أولاً (allocateOutLines) فيأخذ A كلّها، والحبّات من B. قبل الإصلاح: A:24 وA:5 (٢٩ > ٢٤)
  const two = src([['A', 24], ['B', 24]]);
  const filled = prefillOutLines(two, lines);
  assert.deepEqual(filled.get('ctn'), [{ lotId: 'A', qty: 24 }]);
  assert.deepEqual(filled.get('pcs'), [{ lotId: 'B', qty: 5 }]);
  const asLines = (m: Map<string, LotRef[]>) => lines.map(l => ({ key: l.key, base: l.base, rows: m.get(l.key)! }));
  assert.equal(outGroupProblems(two, asLines(filled), { loaded: true }).size, 0);
  // التوزيع المستقلّ القديم لكل سطر: يمرّ كل سطرٍ وحده، والمجموع على A فوق صالحها — الخادم يرفض (LOT_STOCK_INSUFFICIENT)
  const naive = new Map([['ctn', prefillOut(two, 24)], ['pcs', prefillOut(two, 5)]]);
  const p = outGroupProblems(two, asLines(naive), { loaded: true });
  assert.equal(p.get('ctn'), 'ROW_OVER');
  assert.equal(p.get('pcs'), 'ROW_OVER');
  // مصدرٌ واحد (بلا صفوف): كل سطرٍ أصغر من المتاح، ومجموعهما أكبر منه ⇒ OVER على أول سطر
  const single = src([['A', 24]]);
  const q = outGroupProblems(single, lines.map(l => ({ key: l.key, base: l.base, rows: null })), { loaded: true });
  assert.equal(q.get('pcs'), 'OVER');
  assert.equal(q.size, 1);
  // كرتونٌ وحبّاتٌ من تشغيلةٍ واحدة تكفيهما: لا مشكلة
  assert.equal(outGroupProblems(src([['A', 29]]), lines.map(l => ({ key: l.key, base: l.base, rows: null })), { loaded: true }).size, 0);
  // الصفّ المعدّل يدوياً يُخصم أولاً كما هو، والباقي يُملأ مما بقي
  const edited = prefillOutLines(two, [{ key: 'ctn', base: 24, factor: 24 }, { key: 'pcs', base: 5, factor: 1, rows: [{ lotId: 'A', qty: 5 }] }]);
  assert.deepEqual(edited.get('pcs'), [{ lotId: 'A', qty: 5 }]);
  assert.deepEqual(edited.get('ctn'), [{ lotId: 'A', qty: 19 }, { lotId: 'B', qty: 5 }]);
  // «المتاح» المعروض على سطرٍ = ما يبقى له بعد أسطر صنفه الأخرى
  assert.deepEqual(sourcesLeftFor(two, [edited.get('pcs')!]).map(s => s.usable), [19, 24]);
  assert.deepEqual(sourcesLeftFor(two, [[{ lotId: 'A', qty: 30 }]]).map(s => s.usable), [0, 24], 'لا سالب');
});

test('نقص المستودع (التسوية السالبة): مصادر العرض، وسطرٌ = تشغيلة، ومشكلات الصنف كما يرفضها الخادم', () => {
  const bucket = (s: number) => ({ SELLABLE: s, EXPIRED: 0, DAMAGED: 0 });
  const meta = (id: string) => ({ id, productId: 'p1', lotNumber: id, productionDate: null, expiryDate: null, status: 'ACTIVE' as const, blockKind: null, blockedAt: null, createdAt: '' });
  const view = (lots: [string, number][], unknown: number): PlaceLotViewDto => ({
    productId: 'p1', place: 'WAREHOUSE', vanKey: null, total: bucket(0), deficits: [], approximate: false,
    lots: lots.map(([id, u]) => ({ lotId: id, meta: meta(id), raw: bucket(u), held: bucket(0), usable: bucket(u) })),
    unknown: bucket(unknown), unknownUsable: bucket(unknown),
  });
  const v = view([['A', 10], ['B', 0], ['C', 4]], 3);
  assert.deepEqual(whOutSources(v), [{ lotId: 'A', usable: 10 }, { lotId: 'C', usable: 4 }, { lotId: null, usable: 3 }]);
  assert.deepEqual(whOutSources(view([['A', 2]], -1)), [{ lotId: 'A', usable: 2 }], 'غير المسمّى السالب ليس مصدراً');
  assert.deepEqual(whOutSources(null), []);
  assert.equal(whOutRows(draft({}), 5), null);
  assert.deepEqual(whOutRows(draft({ pick: 'UNNAMED' }), 5), [{ lotId: null, qty: 5 }]);
  assert.deepEqual(whOutRows(draft({ pick: 'A' }), 2.5), [{ lotId: 'A', qty: 2.5 }]);
  const probs = (vw: PlaceLotViewDto, ls: [string, LotDraft, number][]) =>
    outGroupProblems(whOutSources(vw), ls.map(([key, d, base]) => ({ key, base, rows: whOutRows(d, base) })), { loaded: true });
  // (١) بلا اختيار وأكثر من مصدر ⇒ يُمنع (الخادم: LOT_REQUIRED، D10) — كان تنبيهاً كهرمانياً وحده
  assert.equal(probs(v, [['x', draft({}), 1]]).get('x'), 'PICK');
  assert.equal(probs(view([['A', 10]], 0), [['x', draft({}), 4]]).size, 0, 'المصدر الوحيد يختاره الخادم');
  assert.equal(probs(view([['A', 3]], 0), [['x', draft({}), 4]]).get('x'), 'OVER');
  assert.equal(probs(view([], 0), [['x', draft({}), 1]]).get('x'), 'NO_BALANCE');
  // (٢) صالح التشغيلة المختارة دون كمية السطر ⇒ يُمنع
  assert.equal(probs(v, [['x', draft({ pick: 'C' }), 5]]).get('x'), 'ROW_OVER');
  assert.equal(probs(v, [['x', draft({ pick: 'UNNAMED' }), 4]]).get('x'), 'ROW_OVER', 'I2: غير المسمّى حتى صالحه');
  // (٣) المختار ليس مصدراً (من قائمة الزيادة قبل قلب الإشارة) ⇒ يُمنع
  assert.equal(probs(v, [['x', draft({ pick: 'B' }), 1]]).get('x'), 'ROW_OVER');
  // D26: سطران على تشغيلةٍ واحدة يُفحصان معاً
  const two = probs(v, [['x', draft({ pick: 'C' }), 3], ['y', draft({ pick: 'C' }), 2]]);
  assert.equal(two.get('x'), 'ROW_OVER');
  assert.equal(two.get('y'), 'ROW_OVER');
  assert.equal(probs(v, [['x', draft({ pick: 'C' }), 3], ['y', draft({ pick: 'A' }), 2]]).size, 0);
});

test('lotPickChoices وstalePick: تحميل السيارة بلا مستودع لا يعرض الموقوفة والمنتهية قابلتين للاختيار (I4)', () => {
  const lots = [
    { id: 'A', lotNumber: 'A', expiryDate: '2027-01-01', status: 'ACTIVE' as const },
    { id: 'B', lotNumber: 'B', expiryDate: '2027-01-01', status: 'BLOCKED' as const },
    { id: 'X', lotNumber: 'X', expiryDate: '2026-10-29T00:00:00.000Z', status: 'ACTIVE' as const },
    { id: 'T', lotNumber: 'T', expiryDate: DAY, status: 'ACTIVE' as const },
  ];
  const load = lotPickChoices('LOAD', { lots }, DAY);
  assert.deepEqual(load.map(c => [c.value, c.disabled]), [['A', false], ['B', true], ['X', true], ['T', false], ['NEW', false], ['UNNAMED', false]]);
  assert.equal(load.find(c => c.value === 'X')!.expired, true, 'المنتهية موسومة');
  assert.equal(load.find(c => c.value === 'T')!.expired, false, 'يوم الانتهاء نفسه صالح');
  // الوارد والتسوية بالزيادة: الموقوفة تُقبل بتحذير — معروضةٌ بوسمها لا معطّلة؛ والوارد بلا «غير مسمى»
  assert.deepEqual(lotPickChoices('IN', { lots }, DAY).filter(c => c.disabled), []);
  assert.deepEqual(lotPickChoices('IN_STRICT', { lots }, DAY).map(c => c.value), ['A', 'B', 'X', 'T', 'NEW']);
  assert.equal(stalePick('B', load), true, 'تشغيلةٌ أُوقفت بعد اختيارها');
  assert.equal(stalePick('A', load), false);
  assert.equal(stalePick('', load), false);
  assert.equal(stalePick('NEW', load), false);
  // النقص: المصادر وحدها — «جديدة» واختيارٌ من قائمة الزيادة يُصفَّران بقلب الإشارة
  const meta = (id: string, status: 'ACTIVE' | 'BLOCKED') => ({ id, productId: 'p1', lotNumber: id, productionDate: null, expiryDate: null, status, blockKind: null, blockedAt: null, createdAt: '' });
  const b = (s: number) => ({ SELLABLE: s, EXPIRED: 0, DAMAGED: 0 });
  const view: PlaceLotViewDto = {
    productId: 'p1', place: 'WAREHOUSE', vanKey: null, total: b(0), deficits: [], approximate: false, unknown: b(0), unknownUsable: b(0),
    lots: [{ lotId: 'A', meta: meta('A', 'ACTIVE'), raw: b(3), held: b(0), usable: b(3) }, { lotId: 'B', meta: meta('B', 'BLOCKED'), raw: b(2), held: b(0), usable: b(2) }],
  };
  const out = lotPickChoices('OUT', { view }, DAY);
  assert.deepEqual(out.map(c => [c.value, c.usable, c.blocked, c.disabled]), [['A', 3, false, false], ['B', 2, true, false]]);
  assert.equal(stalePick('NEW', out), true);
  assert.equal(stalePick('UNNAMED', out), true, 'غير المسمّى بلا صالح ليس خياراً');
  assert.equal(stalePick('X', out), true);
  assert.equal(stalePick('B', out), false, 'الموقوفة تُتلف من المستودع بتسوية نقص');
});

test('resolveShelfOn: المعروفة أولى ثم المجلوبة — والمجهولة إلزامية فلا يرفض الخادم ما مرّ هنا', () => {
  assert.equal(resolveShelfOn(false, true), false);
  assert.equal(resolveShelfOn(true, undefined), true);
  assert.equal(resolveShelfOn(undefined, false), false);
  assert.equal(resolveShelfOn(undefined, undefined), true);
});

test('lotLineLabel: الرقم والانتهاء يوماً، والغائب «غير مسمى»', () => {
  assert.equal(lotLineLabel({ lotNumber: 'L1', expiryDate: '2026-12-01T00:00:00.000Z' }, 'U', 'Exp'), 'L1 · Exp 2026-12-01');
  assert.equal(lotLineLabel({ lotNumber: null }, 'U', 'Exp'), 'U');
});

// ═══════════════ شاشة التشغيلات ═══════════════

test('lotListParams: الفارغ يُحذف، والقريب من الانتهاء بأيام اللوحة، والحدّ ضمن سقف الخادم', () => {
  assert.deepEqual(lotListParams({ q: '  L1 ', status: '', soon: false }, 30), { q: 'L1', page: 1, limit: 30 });
  assert.deepEqual(lotListParams({ q: '', status: 'BLOCKED', soon: true }, 60),
    { status: 'BLOCKED', expiringWithinDays: M_LOTS_SOON_DAYS, page: 1, limit: 60 });
  assert.equal(lotListParams({ q: '', status: '', soon: false }, 999).limit, M_LOTS_MAX);
  assert.equal(lotListParams({ q: '', status: '', soon: false }, 0).limit, M_LOTS_PAGE);
  assert.equal(lotListParams({ q: '', status: '', soon: false }, NaN).limit, M_LOTS_PAGE);
  assert.equal(M_LOTS_SOON_DAYS, 30);
});

test('nextLotsLimit: دفعةٌ أكبر حتى سقف الخادم — ولا مزيد بعد دفعةٍ ناقصة أو بلوغ العدد', () => {
  assert.equal(nextLotsLimit(30, 20, 100), null);
  assert.equal(nextLotsLimit(30, 30, 30), null);
  assert.equal(nextLotsLimit(30, 30, 100), 60);
  assert.equal(nextLotsLimit(180, 180, null), M_LOTS_MAX);
  assert.equal(nextLotsLimit(M_LOTS_MAX, M_LOTS_MAX, 900), null);
});

test('statusReasonProblem: السبب إلزامي في الاتجاهين (D27) وبسقف الخادم', () => {
  assert.equal(statusReasonProblem(''), STATUS_REASON_PROBLEMS.EMPTY);
  assert.equal(statusReasonProblem('   '), STATUS_REASON_PROBLEMS.EMPTY);
  assert.equal(statusReasonProblem(null), STATUS_REASON_PROBLEMS.EMPTY);
  assert.equal(statusReasonProblem('شكوى عميل'), null);
  assert.equal(statusReasonProblem('x'.repeat(LOT_REASON_MAX)), null);
  assert.equal(statusReasonProblem('x'.repeat(LOT_REASON_MAX + 1)), STATUS_REASON_PROBLEMS.LONG);
});

test('scopedLotUser: المقيّد بنطاقٍ لا يوقف — وجلسة المالك غير مقيّدة', () => {
  assert.equal(scopedLotUser({ scopeEnabled: true }, null), true);
  assert.equal(scopedLotUser({ scopeEnabled: true }, 'شركة'), false);
  assert.equal(scopedLotUser({}, null), false);
  assert.equal(scopedLotUser(null, null), false);
});

const plan = (salesRepId: string, sell: number, held = 0, repName: string | null = salesRepId): LotUnloadPlanDto => ({
  salesRepId, repName, deleted: repName === null, usable: { SELLABLE: sell, EXPIRED: 0, DAMAGED: 0 }, held: { SELLABLE: held, EXPIRED: 0, DAMAGED: 0 },
});

test('unloadPlanRows وunloadPlanTotals: ما يُنزَّل أولاً بالأكبر، والمحجوز وحده آخراً، والفارغ يسقط', () => {
  const rows = [plan('r1', 2), plan('r2', 0, 3), plan('r3', 5), plan('r4', 0, 0), plan('r5', 2, 0, 'أحمد')];
  assert.deepEqual(unloadPlanRows(rows).map(r => r.salesRepId), ['r3', 'r1', 'r5', 'r2']);
  assert.deepEqual(unloadPlanTotals(rows), { usable: 9, held: 3, vans: 3 });
  assert.deepEqual(unloadPlanRows(null), []);
  assert.deepEqual(unloadPlanTotals(undefined), { usable: 0, held: 0, vans: 0 });
});

test('unloadPlanRows = unloadPlan في الخادم (anyPositive): سيارةٌ فيها من التشغيلة منتهٍ أو تالف وحده تبقى في الخطة', () => {
  const only = (id: string, usable: Partial<LotUnloadPlanDto['usable']>, held: Partial<LotUnloadPlanDto['held']> = {}): LotUnloadPlanDto => ({
    salesRepId: id, repName: id, deleted: false,
    usable: { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0, ...usable }, held: { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0, ...held },
  });
  const rows = [only('exp', { EXPIRED: 4 }), only('dmg', { DAMAGED: 1 }), only('heldExp', {}, { EXPIRED: 2 }), only('none', {}), plan('sell', 3)];
  assert.deepEqual(unloadPlanRows(rows).map(r => r.salesRepId), ['sell', 'dmg', 'exp', 'heldExp'],
    'المسحوبة في سيارةٍ منتهيةً أو تالفةً ليست «لا رصيد في السيارات»');
  // ما يُنزَّل بزرّ «تنزيل» صالحه وحده — المنتهي والتالف يزالان من دلويهما، والملاحظة تقول ذلك
  assert.deepEqual(unloadPlanTotals(rows), { usable: 3, held: 0, vans: 1 });
  assert.equal(unloadPlanHasRemovals(rows), true);
  assert.equal(unloadPlanHasRemovals([plan('a', 2, 1)]), false);
  assert.equal(unloadPlanHasRemovals(null), false);
});

type TraceCustomer = NonNullable<LotTraceDto['customers']>[number];
const inv = (sold: number, returned: number, weakest: 'CONFIRMED' | 'ASSUMED' | 'UNKNOWN', broad = false) =>
  ({ invoiceId: `i${sold}${returned}`, number: 'INV', date: '2026-10-01', sold, returned, net: sold - returned, weakest, flags: [], broad });

test('weakestCertainty وcustomerLotTotals: أضعف يقين، والصافي، و«من الموسّع وحده»', () => {
  assert.equal(weakestCertainty([]), null);
  assert.equal(weakestCertainty(['CONFIRMED', 'ASSUMED']), 'ASSUMED');
  assert.equal(weakestCertainty(['ASSUMED', 'UNKNOWN', 'CONFIRMED']), 'UNKNOWN');
  assert.equal(weakestCertainty(['BOGUS' as 'CONFIRMED', 'CONFIRMED']), 'CONFIRMED');
  const c: TraceCustomer = { customerId: 'c', name: 'ع', phone: null, address: null, city: null, invoices: [inv(5, 1, 'CONFIRMED'), inv(2.5, 0, 'ASSUMED', true)] };
  assert.deepEqual(customerLotTotals(c), { sold: 7.5, returned: 1, net: 6.5, weakest: 'ASSUMED', broadOnly: false });
  assert.equal(customerLotTotals({ ...c, invoices: [inv(1, 0, 'ASSUMED', true)] }).broadOnly, true);
});

test('telHref: رابط اتصالٍ صالح (E.164) — الأرقام العربية لاتينية، و00 دولية، والقصير والطويل والفارغ بلا رابط', () => {
  assert.equal(telHref('0501234567'), 'tel:0501234567');
  assert.equal(telHref('+966 50 123 4567'), 'tel:+966501234567');
  assert.equal(telHref('00966501234567'), 'tel:+966501234567');
  assert.equal(telHref('٠٥٠١٢٣٤٥٦٧'), 'tel:0501234567');
  assert.equal(telHref('123'), null);
  assert.equal(telHref('1234567890123456'), null);
  assert.equal(telHref('abc'), null);
  assert.equal(telHref(null), null);
});

// ═══════════════ فاتورة الإدارة: متاح السيارة ═══════════════

const snap = (): VanLotSnapshotDto => ({
  serverTime: '2026-10-30T08:00:00.000Z', day: DAY, tracked: ['p1', 'p3'], allowUnknown: true,
  products: [{ ...snapProduct(), productId: 'p1', available: 40 }],
});

test('trackedDemand: مجموع أسطر الصنف المتتبَّع بوحداتها (كرتونان + ٥ حبّات = ٥٣)، وغيره يسقط', () => {
  const lines = [{ productId: 'p1', qty: 2, unitFactor: 24 }, { productId: 'p1', qty: 5, unitFactor: 1 }, { productId: 'p2', qty: 3 }];
  assert.deepEqual([...trackedDemand(lines, pid => pid === 'p1')], [['p1', 53]]);
});

test('vanAvailableOf: المتتبَّع الغائب صفر، وغير المتتبَّع أو بلا لقطة null، والسالب صفر', () => {
  assert.equal(vanAvailableOf(snap(), 'p1'), 40);
  assert.equal(vanAvailableOf(snap(), 'p3'), 0);
  assert.equal(vanAvailableOf(snap(), 'p2'), null);
  assert.equal(vanAvailableOf(null, 'p1'), null);
  const neg = { ...snap(), products: [{ ...snapProduct(), productId: 'p1', available: -2 }] };
  assert.equal(vanAvailableOf(neg, 'p1'), 0);
});

test('vanLotShortages: النقص بالكمية الأساسية بترتيب الأسطر — والمتتبَّع من اللقطة لا من علم الصنف', () => {
  const lines = [{ productId: 'p3', qty: 1 }, { productId: 'p1', qty: 2, unitFactor: 24 }, { productId: 'p1', qty: 5 }, { productId: 'p2', qty: 99 }];
  assert.deepEqual(vanLotShortages(lines, snap()), [
    { productId: 'p3', wanted: 1, available: 0 },
    { productId: 'p1', wanted: 53, available: 40 },
  ]);
  assert.deepEqual(vanLotShortages([{ productId: 'p1', qty: 40 }], snap()), [], 'يساوي المتاح: لا نقص');
  assert.deepEqual(vanLotShortages(lines, null), []);
});

// ═══════════════ القاموس: المفاتيح التي تمرّ إلى tr بمتغيّر ═══════════════

test('رسائل المسودّة والتنزيل والسبب وأفعال الحالة وبلاطات الرئيسية مترجمةٌ بالأربع (لا يلتقطها langs.test)', () => {
  const have = phrases();
  for (const m of Object.values(LOT_DRAFT_PROBLEMS)) assertTranslated(have, m, 'LOT_DRAFT_PROBLEMS');
  for (const m of Object.values(VAN_OUT_PROBLEMS)) assertTranslated(have, m, 'VAN_OUT_PROBLEMS');
  for (const m of Object.values(WH_OUT_PROBLEMS)) assertTranslated(have, m, 'WH_OUT_PROBLEMS');
  for (const m of Object.values(STATUS_REASON_PROBLEMS)) assertTranslated(have, m, 'STATUS_REASON_PROBLEMS');
  for (const lot of [{ status: 'ACTIVE' as const, blockKind: null }, { status: 'BLOCKED' as const, blockKind: 'HOLD' as const }, { status: 'BLOCKED' as const, blockKind: 'RECALL' as const }]) {
    for (const a of statusActions(lot)) assertTranslated(have, a.label, 'statusActions');
  }
  const home = read('m', 'MHome.tsx');
  const tiles = home.slice(home.indexOf('const SECTION_TILES'), home.indexOf('];', home.indexOf('const SECTION_TILES')));
  const labels = [...tiles.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
  assert.ok(labels.includes('تتبع LOT'), 'بلاطة «تتبع LOT» مفقودة');
  for (const l of labels) assertTranslated(have, l, 'SECTION_TILES');
});

// ═══════════════ حرّاس نصّية ═══════════════

test('لا ملفّان في m/ يختلف اسماهما بحالة الأحرف وحدها — ويندوز وماك يحلّان ./MLots إلى ./mLots', () => {
  const names = fs.readdirSync(path.join(root, 'src', 'm')).map(f => f.replace(/\.(test\.)?tsx?$/, ''));
  const seen = new Map<string, string>();
  for (const n of new Set(names)) {
    const k = n.toLowerCase();
    assert.ok(!seen.has(k), `تصادم حالة أحرف: ${seen.get(k)} و${n}`);
    seen.set(k, n);
  }
});

test('القوقعة: قسم التشغيلات بحارس موجّه /api/lots وبترتيبه، كسولٌ، وبلا تبويبٍ سفلي', () => {
  const s = read('m', 'MobileApp.tsx');
  assert.match(s, /const MLots = lazy\(\(\) => import\('\.\/MLots'\)\)/, 'الشاشة يجب أن تكون كسولة');
  assert.doesNotMatch(s, /^import MLots/m, 'استيرادٌ ثابت يُدخل الشاشة حزمة الإقلاع');
  assert.match(s, /const lotOn = lotFlagsOf\(company[^)]*\)\.on;/, 'العلم يُقرأ بـlotFlagsOf (=== true)');
  assert.match(s, /can\(user, 'canManageVanStock'\) && accountingOn && lotOn\) out\.push\('lots'\)/,
    'البلاطة بلا الصلاحية أو المحاسبة أو العلم تُفضي إلى ٤٠٣');
  assert.match(s, /\}, \[user, accountingOn, warehouseOn, lotOn\]\);/, 'lotOn خارج تبعيات allowedSections');
  assert.match(s, /section === 'lots' \? <MLots company=\{company\}/, 'القسم غير موصول');
  assert.match(s, /<MProducts lotOn=\{lotOn\}/, 'مفتاح «تتبّع بـLOT» لا يصل شاشة المنتجات');
  const tabs = s.slice(s.indexOf('const TABS'), s.indexOf('/** حدث تثبيت PWA'));
  assert.doesNotMatch(tabs, /id: 'lots'/, 'المقاعد خمسة وقد امتلأت — التشغيلات قسمٌ لا تبويب');
});

test('الرئيسية: «lots» في HomeSection وبلاطتها، والأعمدة لا تتغيّر لما دون الخمس', () => {
  const s = read('m', 'MHome.tsx');
  assert.match(s, /export type HomeSection = [^;]*'lots'/);
  assert.match(s, /\{ id: 'lots', label: 'تتبع LOT', icon: Layers \}/);
  assert.match(s, /n >= 5 \? 'grid-cols-3' : n === 4 \? 'grid-cols-2' : n === 3 \? 'grid-cols-3' : n === 2 \? 'grid-cols-2' : 'grid-cols-1'/);
});

test('مستند الفاتورة والمرتجع بتشغيلاتهما مع الميزة وحدها (D11) — والسند والمطفأة كما كانا', () => {
  const s = read('m', 'MDocScreen.tsx');
  assert.match(s, /const lotOn = kind === 'invoice' && lotFlagsOf\(/);
  assert.match(s, /invoiceApi\.get\(id, lotOn \? \{ withLots: true \} : undefined\)/);
  assert.match(s, /: await receiptApi\.get\(id\)/);
  assert.match(s, /queryKey: \['m-doc', kind, id, lotOn\]/, 'المفتاح بلا العلم يعرض ورقةً بلا تشغيلات من الكاش');
  // البانية تضمّ التشغيلات وتطبعها بشرط lotOnInvoice — العقد الذي تعتمد عليه الشاشة
  const docs = read('rep', 'RepDocuments.tsx');
  assert.match(docs, /export function invoiceDocFromDetail[\s\S]*?\.\.\.lotsField\(it\.lots\)/);
  assert.match(docs, /invoiceLotsOf\(doc\.company, it\)/);
});

test('الإشعاران: الحركة بتشغيلاتها (withLots) تمرّ كما هي إلى بانيتها', () => {
  const rep = read('m', 'MRepLoad.tsx');
  assert.match(rep, /vanStockApi\.movements\(rep\.id, lotOn \? \{ withLots: true \} : undefined\)/);
  assert.match(rep, /queryKey: \['m-van-movements', rep\.id, lotOn\]/);
  const ln = read('m', 'MLoadNoticeDoc.tsx');
  assert.match(ln, /loadNoticeDocFromData\(repName, movement, /, 'الإشعار يجب أن يُبنى من الحركة كما هي');
  const wn = read('m', 'MWarehouseNoticeDoc.tsx');
  assert.match(wn, /warehouseNoticeDocFromEntry\(entry, /);
  const docs = read('rep', 'RepDocuments.tsx');
  assert.match(docs, /\.\.\.lotsField\(i\.lots\)/, 'loadNoticeDocFromData لم يعد يضمّ تشغيلات البند');
  assert.match(docs, /warehouseLineLots\(i\.lot, /, 'warehouseNoticeDocFromEntry لم يعد يضمّ تشغيلة السطر');
});

test('المنتجات: lotTracked يُرسل حين يتغيّر وحده، والتأكيد مع الإطفاء وحده، والمفتاح خلف العلم', () => {
  const s = read('m', 'MProducts.tsx');
  assert.match(s, /const lot = productLotPayload\(product \? \(lotBase \?\? null\) : null, lotOn, lotValue\);/);
  assert.match(s, /if \(confirmLot && lot\.lotTracked === false\) payload\.confirmLotBalances = true;/);
  assert.match(s, /const bal = product && !confirmLot \? trackingBalanceOf\(e\) : null;/);
  assert.match(s, /\{lotOn && \(\s*<Group title=\{tr\('تتبع بـLOT'\)\}>/);
  assert.match(s, /const lot = lotOn && p\.lotTracked === true;/, 'الشارة بلا العلم تظهر لشركةٍ أطفأت الميزة');
});

test('فاتورة الإدارة: لقطة السيارة حين في البنود متتبَّعٌ والصلاحية وحدهما، والرفض والتحذير بلغة الواجهة', () => {
  const s = read('m', 'MInvoiceCreate.tsx');
  assert.match(s, /const hasLotLine = lotOn && lines\.some\(/);
  assert.match(s, /enabled: hasLotLine && !!salesRepId && step !== 'head' && can\(user, 'canManageVanStock'\)/);
  assert.match(s, /queryKey: \['m-van-lots', salesRepId\]/, 'مفتاح اللقطة غير مفتاح MRepLoad — كاشان لرصيدٍ واحد');
  assert.match(s, /lotErrorText\(lot, tr, /);
  assert.match(s, /lotWarningsOf\(body\.warnings\)/);
  // لا حقل تشغيلة في الجسم: التوزيع FEFO في الخادم بلا نقرة
  const body = s.slice(s.indexOf('items: lines.map(l => ({'), s.indexOf('})),', s.indexOf('items: lines.map(l => ({')));
  assert.doesNotMatch(body, /lots/);
  for (const caller of ['MDocList.tsx', 'MCustomers.tsx']) {
    assert.match(read('m', caller), /<MInvoiceCreate [^>]*company=\{company\}/, `${caller} لا يمرّر إعدادات الشركة`);
  }
});

/** كل مفاتيح queryKey الحرفية (أول عنصر) في ملفات مجلّدٍ من src — المطابقة في TanStack على العنصر كاملاً لا على بادئته */
function queryKeysIn(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/queryKey: \['([\w-]+)'/g)) out.set(m[1], path.relative(root, f));
      }
    }
  };
  walk(path.join(root, 'src', dir));
  return out;
}

test('مفاتيح كاش التشغيلات: كل مفتاح لوطٍ في الجوال واللوحة يُبطَل بعد الحركة — ولا مفتاح ميّت', () => {
  const lotKeys = LOT_CACHE_KEYS as readonly string[];
  for (const f of ['MLots.tsx', 'MLotFields.tsx']) {
    for (const m of read('m', f).matchAll(/queryKey: \['([\w-]+)'/g)) {
      assert.ok(lotKeys.includes(m[1]), `${f}: ${m[1]} خارج LOT_CACHE_KEYS`);
    }
  }
  // اللوحة (الكاش مشترك): 'lot-balances' لا يطابق 'lot-balances-wh' — فكل مفتاحٍ فيه «lot» بعينه
  const all = new Map([...queryKeysIn('pages'), ...queryKeysIn('components'), ...queryKeysIn('m')]);
  for (const [k, where] of all) if (/lot/i.test(k)) assert.ok(lotKeys.includes(k), `${where}: ${k} خارج LOT_CACHE_KEYS`);
  for (const k of lotKeys) assert.ok(all.has(k), `LOT_CACHE_KEYS: ${k} لا يستعمله أحد`);
  for (const k of ['m-van-lots', 'm-van-fefo', 'm-wh-lots', 'm-lot-opts', 'lots']) assert.ok(lotKeys.includes(k), k);
  for (const k of ['m-van-current', 'm-van-movements', 'm-wh-stock', 'warehouse-vans']) assert.ok((STOCK_CACHE_KEYS as readonly string[]).includes(k), k);
  for (const k of STOCK_CACHE_KEYS) assert.ok(all.has(k), `STOCK_CACHE_KEYS: ${k} لا يستعمله أحد`);
  for (const f of ['MRepLoad.tsx', 'MWarehouse.tsx', 'MInvoiceCreate.tsx', 'MProducts.tsx']) {
    assert.match(read('m', f), /LOT_CACHE_KEYS/, `${f} لا يُبطل كاش التشغيلات`);
  }
});

test('الشاشات موصولة بالمنطق المشترك: أسطر الصنف معاً، وأهليّة التحميل، والصلاحية المجهولة، والمنتهي والتالف في الخطة', () => {
  const rep = read('m', 'MRepLoad.tsx');
  assert.match(rep, /prefillOutLines\(sources, /, 'التوزيع الأوّلي لكل سطرٍ وحده يأخذ التشغيلة نفسها مرّتين');
  assert.match(rep, /outGroupProblems\(sources, /, 'التحقق لكل سطرٍ وحده لا يرى مجموع أسطر الصنف (D26)');
  assert.doesNotMatch(rep, /vanOutProblem|prefillOut\(sourcesOf/);
  assert.match(rep, /<MLotFields productId=\{r\.productId\} mode="LOAD" shelfOn=\{shelfOf\(r\)\}/, 'التحميل بلا مستودع بوضع LOAD وصلاحيةٍ محلولة');
  assert.match(rep, /day=\{snapQ\.data\?\.day\}/, 'انتهاء التشغيلة بيوم الشركة من اللقطة');
  assert.match(rep, /lotDraftProblem\(r\.lot \?\? emptyLotDraft\(\), 'LOAD', \{ shelfOn: shelfOf\(r\), day: snapQ\.data\?\.day \}\)/,
    'منع الحفظ لا يرى تشغيلةً جديدة منتهية في التحميل (I4)');
  const wh = read('m', 'MWarehouse.tsx');
  assert.match(wh, /groupProblem=\{outProblems\.get\(k\) \?\? null\}/);
  assert.match(wh, /const lotBad = \(r: FormRow\) => r\.tracked && \(!draftOk\(r\) \|\| outProblems\.has\(r\.rowId\)\);/, 'مشكلة الصنف لا تمنع الحفظ');
  assert.match(wh, /onClick=\{\(\) => changeType\('ADJUST'\)\}/, 'تغيير النوع لا يصفّر تشغيلة السطر حين ينقلب اتجاهه');
  const f = read('m', 'MLotFields.tsx');
  assert.match(f, /stalePick\(draft\.pick, choices\)/, 'الاختيار الخارج من الخيارات لا يُصفَّر');
  assert.match(f, /disabled=\{c\.disabled\}/, 'الموقوفة والمنتهية قابلتان للاختيار في التحميل');
  assert.match(read('m', 'MLots.tsx'), /unloadPlanHasRemovals\(planQ\.data\) &&/, 'ملاحظة المنتهي والتالف مفقودة');
});

test('شاشة التشغيلات: الإيقاف بسببٍ ونسخةٍ، والتنزيل بجسم unloadBody المشترك مع اللوحة', () => {
  const s = read('m', 'MLots.tsx');
  assert.match(s, /lotsApi\.setStatus\(lot\.id, \{\s*status: a\.status, [\s\S]{0,120}?reason: reason\.trim\(\), updatedAt: lot\.updatedAt,/);
  assert.match(s, /disabled=\{!!reasonProblem \|\| setStatus\.isPending\}/, 'السبب الإلزامي غير محروس قبل الإرسال');
  assert.match(s, /disabled=\{scopedUser\}/, 'المقيّد بنطاقٍ يجب ألا يضغط الإيقاف');
  assert.match(s, /unloadBody\(lot, row, /);
  assert.match(s, /const scope = scopeSel \?\? \(autoBroad\(lot\) \? 'BROAD' : 'STRICT'\);/, 'الموسّع تلقائيٌّ في السحب');
  assert.match(s, /trace\.customersHidden/, 'قائمة العملاء بلا صلاحيتها');
});
