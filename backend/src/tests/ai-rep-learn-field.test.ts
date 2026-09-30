// حلقة التعلّم — ما يواجهه المندوب في الميدان (§3.7): الحلقات، سقف المندوب، وزن الباب، بوابة التعرّض، ديريشليه،
// انكماش الإغلاق، اقتراحات الإدارة، وإشارات الملاحظة والنيّة. فوق Prisma مزيّف في الذاكرة، بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ClosedRow, EpisodeRow } from '../ai-rep/learn/field';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const calls: { text: string; values: unknown[] }[] = [];
let episodesOut: unknown[] = [];
let closedOut: unknown[] = [];
stub('config/database', {
  default: {
    $queryRaw: async (q: { text: string; values: unknown[] }) => {
      calls.push({ text: q.text, values: q.values });
      return q.text.includes('bool_and') ? episodesOut : closedOut;
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const F = require('../ai-rep/learn/field') as typeof import('../ai-rep/learn/field');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require('../ai-rep/learn/signals') as typeof import('../ai-rep/learn/signals');

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
let seq = 0;
const ep = (o: Partial<EpisodeRow> = {}): EpisodeRow => ({
  type: 'GROCERY', outletId: `o${++seq}`, bucket: 0, best: 1, onlyClosed: false, rep: 'r1', firstAt: ago(40),
  anyDoor: true, doorUnknown: false, objection: null, wasCustomer: null, convertedAt: null, ...o,
});
const many = (k: number, o: Partial<EpisodeRow> = {}): EpisodeRow[] => Array.from({ length: k }, () => ep(o));
const stats = (eps: EpisodeRow[], closed: ClosedRow[] = [], activeReps = 1) => F.computeFieldStats(eps, closed, { now: NOW, activeReps });
const near = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

// ───────────── الاستعلامان ─────────────

test('خمسة أحداث لمندوب واحد على محل واحد داخل النافذة = حلقة واحدة بأفضل نتيجة (ثوابت SQL نفسها)', async () => {
  calls.length = 0;
  episodesOut = [{ type: 'GROCERY', outletId: 'o1', bucket: 686, best: 4, onlyClosed: false, rep: 'r1', firstAt: ago(3), anyDoor: null, doorUnknown: true, objection: 'PRICE', wasCustomer: null, convertedAt: null }];
  closedOut = [{ type: 'GROCERY', h: 15, rep: 'r1', n: 3, closed: 1 }];
  const rows = await F.loadFieldRows('t1', ago(90), 'Asia/Riyadh');
  const q1 = calls.find(c => c.text.includes('bool_and'))!;
  assert.ok(q1, 'استعلام الحلقات');
  assert.match(q1.text, /GROUP BY 1, 2, 3/);
  assert.match(q1.text, /LIMIT 20000/);

  // نطبّق ترتيب CASE وقاسم النافذة كما في نص الاستعلام على خمسة أحداث
  const rank = new Map([...q1.text.matchAll(/WHEN '(\w+)' THEN (\d)/g)].map(m => [m[1], Number(m[2])]));
  const divisor = Number(/extract\(epoch from e\."occurredAt"\) \/ (\d+)/.exec(q1.text)![1]);
  assert.equal(divisor, 30 * 86400);
  const start = Math.floor(NOW.getTime() / 1000 / divisor) * divisor * 1000;
  const events = ['CALL_BACK', 'CLOSED', 'INTERESTED', 'NOT_INTERESTED', 'CALL_BACK'].map((kind, i) => ({ outletId: 'o1', kind, at: start + (i + 1) * DAY }));
  const groups = new Map<string, number>();
  for (const e of events) {
    const key = `${e.outletId}|${Math.floor(e.at / 1000 / divisor)}`;
    groups.set(key, Math.max(groups.get(key) ?? -1, rank.get(e.kind) ?? 0));
  }
  assert.equal(groups.size, 1);
  assert.equal([...groups.values()][0], 4);
  assert.equal(rank.get('CONVERTED'), 5);
  assert.equal(rank.get('QUOTE'), 4);
  assert.equal(rank.get('CLOSED'), undefined, 'المغلق ELSE 0');
  assert.equal(rank.get('NOT_FOUND'), undefined, '«لم أجده» ELSE 0');

  // أول نتيجة مقيَّمة وعدد المقيَّمة: بلا المغلق و«لم أجده» والتحويل؛ و«مغلق فقط» يشمل «لم أجده» (مشوار ضائع)
  assert.match(q1.text, /\(array_agg\(e\.kind ORDER BY e\."occurredAt"\) FILTER \(WHERE e\.kind NOT IN \('CLOSED', 'NOT_FOUND', 'CONVERTED'\)\)\)\[1\] AS "firstKind"/);
  assert.match(q1.text, /COUNT\(\*\) FILTER \(WHERE e\.kind NOT IN \('CLOSED', 'NOT_FOUND', 'CONVERTED'\)\)::int AS "nRated"/);
  assert.match(q1.text, /bool_and\(e\.kind IN \('CLOSED', 'NOT_FOUND'\)\) AS "onlyClosed"/);
  // نسبة الإغلاق لكل فترة: «مغلق الآن» وحده — «لم أجده» خارج البسط والمقام
  const q2 = calls.find(c => !c.text.includes('bool_and'))!;
  assert.match(q2.text, /COUNT\(\*\) FILTER \(WHERE e\.kind = 'CLOSED'\)::int AS closed/);
  assert.match(q2.text, /AND e\.kind NOT IN \('CONVERTED', 'NOT_FOUND'\)/);

  assert.equal(rows.episodes.length, 1);
  assert.equal(rows.episodes[0].best, 4);
  assert.equal(rows.episodes[0].doorUnknown, true);
  assert.equal(rows.episodes[0].anyDoor, null);
  assert.ok(rows.episodes[0].firstAt instanceof Date);
  assert.equal(rows.episodes[0].firstKind, null, 'صفّ بلا العمود ⇒ null');
  assert.equal(rows.episodes[0].nRated, undefined);
  assert.deepEqual(rows.closedRows, [{ type: 'GROCERY', h: 15, rep: 'r1', n: 3, closed: 1 }]);
  const fs1 = stats(rows.episodes, rows.closedRows);
  assert.equal(fs1.byType.GROCERY.n, 1);
  assert.equal(fs1.byType.GROCERY.posRate, 1);

  // العمودان الجديدان يُفكّان (nRated رقماً)
  episodesOut = [{ ...(episodesOut[0] as object), firstKind: 'CALL_BACK', nRated: '3' }];
  const rows2 = await F.loadFieldRows('t1', ago(90), 'Asia/Riyadh');
  assert.equal(rows2.episodes[0].firstKind, 'CALL_BACK');
  assert.equal(rows2.episodes[0].nRated, 3);
});

test('العزل: كل جدول في FROM/JOIN مقيّد بـ"tenantId" = ${tid} في نص field.ts، وفي الاستعلامين المنفَّذين', async () => {
  const src = fs.readFileSync(path.join(SRC, 'ai-rep/learn/field.ts'), 'utf8');
  assert.ok(!/\$queryRawUnsafe|\$executeRawUnsafe|Prisma\.raw/.test(src), 'لا SQL نصي');
  const blocks = [...src.matchAll(/Prisma\.sql`([\s\S]*?)`/g)].map(m => m[1]);
  // استعلامان كاملان + مقطع الحدّ الأعلى الاختياري (بلا جداول)
  const queries = blocks.filter(b => /\b(?:FROM|JOIN)\b/.test(b));
  const fragments = blocks.filter(b => !/\b(?:FROM|JOIN)\b/.test(b));
  assert.equal(queries.length, 2);
  assert.equal(fragments.length, 1);
  assert.match(fragments[0], /^\s*AND e\."occurredAt" < \$\{until\}\s*$/, 'المقطع قيد زمني فقط — لا جدول ولا شرط آخر');
  assert.match(src, /const upper = until \? Prisma\.sql`[^`]*` : Prisma\.empty;/);
  for (const b of queries) {
    assert.match(b, /FROM ai_outlet_events e/);
    assert.match(b, /JOIN ai_outlets o ON o\.id = e\."outletId" AND o\."tenantId" = \$\{tid\}/);
    assert.match(b, /WHERE e\."tenantId" = \$\{tid\} AND e\."occurredAt" >= \$\{since\}\$\{upper\}/);
    for (const m of b.matchAll(/(?:FROM|JOIN)\s+(\w+)\s+(\w+)/g)) {
      assert.ok(b.includes(`${m[2]}."tenantId" = \${tid}`), `${m[1]} (${m[2]}) بلا tenantId`);
    }
  }
  calls.length = 0;
  await F.loadFieldRows('t1', ago(90), 'Asia/Riyadh');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.text, /o\."tenantId" = \$\d+/);
    assert.match(c.text, /e\."tenantId" = \$\d+/);
    assert.equal(c.values.filter(v => v === 't1').length, 2);
    assert.doesNotMatch(c.text, /"occurredAt" < /, 'بلا حدّ أعلى');
  }
  // بحدّ أعلى: القيد الزمني يُضاف للاستعلامين، وقيد الشركة على الطرفين باقٍ
  calls.length = 0;
  const until = ago(10);
  await F.loadFieldRows('t1', ago(90), 'Asia/Riyadh', until);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.text, /o\."tenantId" = \$\d+/);
    assert.match(c.text, /WHERE e\."tenantId" = \$\d+ AND e\."occurredAt" >= \$\d+ AND e\."occurredAt" < \$\d+/);
    assert.equal(c.values.filter(v => v === 't1').length, 2);
    assert.equal(c.values.filter(v => v === until).length, 1);
  }
});

// ───────────── الأوزان ─────────────

test('حلقة «مغلق فقط» تذهب للإغلاق وحده', () => {
  const s = stats(
    [ep({ best: 4 }), ep({ best: 0, onlyClosed: true }), ep({ type: 'PHARMACY', best: 0, onlyClosed: true })],
    [{ type: 'GROCERY', h: 10, rep: 'r1', n: 2, closed: 1 }, { type: 'PHARMACY', h: 10, rep: 'r1', n: 1, closed: 1 }],
  );
  assert.equal(s.byType.GROCERY.n, 1);
  assert.equal(s.byType.GROCERY.posRate, 1);
  assert.equal(s.byType.GROCERY.closed.rate, 0.5);
  assert.equal(s.byType.PHARMACY.n, 0);
  assert.equal(s.byType.PHARMACY.exposed, false);
  assert.equal(s.byType.PHARMACY.closed.rate, 1);
});

test('حلقات كان المحل فيها عميلاً تُستبعد', () => {
  const s = stats([ep({ best: 4, wasCustomer: true }), ep({ best: 1, wasCustomer: false })]);
  assert.equal(s.byType.GROCERY.n, 1);
  assert.equal(s.byType.GROCERY.posRate, 0);
});

test('مندوب يملك ٨٠٪ من الحلقات يُسقَف (R=4 ⇒ cap 0.375)', () => {
  const eps = [...many(80, { rep: 'rA', best: 4 }), ...many(7, { rep: 'rB' }), ...many(7, { rep: 'rC' }), ...many(6, { rep: 'rD' })];
  const s = stats(eps, [], 4);
  // وزن rA = 0.375·100/80 = 0.46875 ⇒ 37.5 مقابل 20
  near(s.byType.GROCERY.posRate, 37.5 / 57.5);
  assert.ok(s.byType.GROCERY.posRate < 0.8);
  near(s.byType.GROCERY.topRepShare, 37.5 / 57.5);
  assert.equal(s.byType.GROCERY.exposed, false, 'حصة أكبر مندوب > ٠٫٥ مع ٤ نشطين');
  // توازن ⇒ لا سقف
  const bal = stats([...many(10, { rep: 'rA', best: 4 }), ...many(10, { rep: 'rB' }), ...many(10, { rep: 'rC' })], [], 3);
  near(bal.byType.GROCERY.posRate, 1 / 3);
  assert.equal(bal.byType.GROCERY.exposed, true);
});

test('وزن الباب: بعيد ٠٫٤، غير معروف ٠٫٧، عند المحل ١', () => {
  near(stats([ep({ best: 4 }), ep({ best: 1, anyDoor: false, doorUnknown: false })]).byType.GROCERY.posRate, 1 / 1.4);
  near(stats([ep({ best: 4 }), ep({ best: 1, anyDoor: null, doorUnknown: true })]).byType.GROCERY.posRate, 1 / 1.7);
  near(stats([ep({ best: 4, anyDoor: false, doorUnknown: false }), ep({ best: 1 })]).byType.GROCERY.posRate, 0.4 / 1.4);
});

// ───────────── بوابة التعرّض ─────────────

test('البوابة تفشل بمندوبين حين ينشط ثلاثة، وبحصة أكبر مندوب > ٠٫٥', () => {
  assert.equal(F.exposureGate({ sumW: 30, reps: 2, topRepShare: 0.5 }, 3), false);
  assert.equal(F.exposureGate({ sumW: 30, reps: 3, topRepShare: 0.51 }, 3), false);
  assert.equal(F.exposureGate({ sumW: 30, reps: 3, topRepShare: 0.5 }, 3), true);
  assert.equal(F.exposureGate({ sumW: 11.9, reps: 3, topRepShare: 0.4 }, 3), false);
  assert.equal(F.exposureGate({ sumW: 12, reps: 2, topRepShare: 0.7 }, 2), true);
  assert.equal(F.exposureGate({ sumW: 12, reps: 2, topRepShare: 0.71 }, 2), false);
  // عبر الإحصاء: نوع رصده مندوبان من ثلاثة نشطين
  const s = stats([...many(10, { rep: 'rA' }), ...many(10, { rep: 'rB' }), ...many(10, { rep: 'rC', type: 'PHARMACY' })], [], 3);
  assert.equal(s.byType.GROCERY.reps, 2);
  assert.equal(s.byType.GROCERY.exposed, false);
});

test('شركة بمندوب واحد تحتاج ≥٢٠ (بوزن كامل)', () => {
  assert.equal(stats(many(19, { best: 4 })).byType.GROCERY.exposed, false);
  assert.equal(stats(many(20, { best: 4 })).byType.GROCERY.exposed, true);
  assert.equal(stats(many(20, { best: 4, anyDoor: null, doorUnknown: true })).byType.GROCERY.exposed, false, 'Σw = 14');
  assert.equal(F.exposureGate({ sumW: 19.9, reps: 1, topRepShare: 1 }, 1), false);
  assert.equal(F.exposureGate({ sumW: 20, reps: 1, topRepShare: 1 }, 1), true);
  // النشطون لا يقلّون عمّن ظهر في البيانات
  assert.equal(stats([...many(10, { rep: 'rA' }), ...many(10, { rep: 'rB' })], [], 1).activeReps, 2);
});

// ───────────── المعدّلات ─────────────

test('ديريشليه: الحصص = (١+n)/(١٠+N) ومجموعها مع كتلة الرموز غير المرصودة = ١', () => {
  const perRep = (rep: string) => [
    ...many(30, { rep, objection: 'PRICE' }), ...many(20, { rep, objection: 'HAS_SUPPLIER' }),
    ...many(6, { rep, objection: 'NEEDS_CREDIT' }), ...many(4, { rep, objection: 'TIMING' }),
  ];
  const s = stats([...perRep('rA'), ...perRep('rB'), ...perRep('rC')], [], 3);
  const o = s.byType.GROCERY.objections!;
  assert.equal(o.n, 180);
  assert.equal(o.exposed, true);
  near(o.shares.PRICE!, 91 / 190);
  near(o.shares.HAS_SUPPLIER!, 61 / 190);
  near(o.shares.NEEDS_CREDIT!, 19 / 190);
  const sum = Object.values(o.shares).reduce((a, b) => a + (b ?? 0), 0);
  near(sum + 6 / 190, 1, 1e-3);
  assert.ok(sum > 0.95 && sum <= 1);
  assert.equal(o.shares.WANTS_SAMPLE, undefined, 'رمز لم يُرصد لا يُعرض');
  // رمز مجهول ⇒ OTHER
  const u = stats([ep({ objection: 'SOMETHING_NEW' })]).byType.GROCERY.objections!;
  assert.deepEqual(Object.keys(u.shares), ['OTHER']);
  assert.equal(u.exposed, false);
});

test('انكماش الإغلاق لكل فترة نحو معدّل النوع (قوة ٨)، والساعة ← الفترة، وسقف المندوب على الصفوف', () => {
  const s = stats([], [
    { type: 'GROCERY', h: 15, rep: 'r1', n: 10, closed: 8 },
    { type: 'GROCERY', h: 9, rep: 'r1', n: 90, closed: 2 },
    { type: 'CAFE', h: 3, rep: 'r1', n: 4, closed: 4 },
    { type: 'CAFE', h: 23, rep: 'r1', n: 4, closed: 0 },
  ]);
  const g = s.byType.GROCERY.closed;
  near(g.rate, 0.1);
  near(g.byBand[0], 2.8 / 98);
  near(g.byBand[2], 8.8 / 18);
  near(g.byBand[1], 0.1);
  near(g.byBand[4], 0.1);
  assert.deepEqual(g.nByBand, [90, 0, 10, 0, 0]);
  assert.deepEqual(s.byType.CAFE.closed.nByBand, [0, 0, 0, 0, 8]);
  // r1 يملك ٩٠ من ١١٠ ⇒ وزنه 0.5·110/90
  const c = stats([], [
    { type: 'GROCERY', h: 15, rep: 'r1', n: 90, closed: 90 },
    { type: 'GROCERY', h: 15, rep: 'r2', n: 10, closed: 0 },
    { type: 'GROCERY', h: 15, rep: 'r3', n: 10, closed: 0 },
  ], 3);
  near(c.byType.GROCERY.closed.rate, 55 / 75);
  assert.ok(c.byType.GROCERY.closed.rate < 90 / 110);
});

test('التحويل بعد الاهتمام: الحلقات الناضجة (≥٣٠ يوماً) وتحويل خلال ٣٠ يوماً، لاحق بيتا(1+conv، 3+non)', () => {
  const eps = [
    ...Array.from({ length: 10 }, () => ep({ best: 4, firstAt: ago(60), convertedAt: ago(50) })),
    ...many(10, { best: 4, firstAt: ago(60) }),
    ...many(5, { best: 4, firstAt: ago(60), convertedAt: ago(20) }), // بعد ٤٠ يوماً
    ...many(5, { best: 4, firstAt: ago(10), convertedAt: ago(5) }), // غير ناضجة
    ...many(5, { best: 1, firstAt: ago(60) }),
  ];
  const cr = stats(eps).byType.GROCERY.convRate!;
  assert.equal(cr.n, 25);
  near(cr.rate, 11 / 29);
  assert.equal(cr.exposed, true);
  assert.equal(stats(many(3, { best: 1 })).byType.GROCERY.convRate, null);
});

test('العودة بعد «عُد لاحقاً»: أول حلقة ٣ ولاحقة خلال ٦٠ يوماً', () => {
  const eps = [
    ep({ outletId: 'A', best: 3, firstAt: ago(80) }), ep({ outletId: 'A', best: 4, firstAt: ago(45) }),
    ep({ outletId: 'B', best: 3, firstAt: ago(80) }), ep({ outletId: 'B', best: 1, firstAt: ago(45) }),
    ep({ outletId: 'C', best: 3, firstAt: ago(85) }), ep({ outletId: 'C', best: 4, firstAt: ago(10) }), // بعد ٧٥ يوماً
    ep({ outletId: 'D', best: 3, firstAt: ago(80) }),
    ep({ outletId: 'E', best: 1, firstAt: ago(80) }), ep({ outletId: 'E', best: 4, firstAt: ago(45) }),
    ep({ outletId: 'F', best: 3, firstAt: ago(80) }), ep({ outletId: 'F', best: 0, onlyClosed: true, firstAt: ago(45) }),
  ];
  const cb = stats(eps).byType.GROCERY.callback!;
  assert.equal(cb.n, 2);
  assert.equal(cb.rate, 0.5);
  assert.equal(cb.exposed, false);
});

test('العودة داخل الحلقة نفسها: «عُد لاحقاً» ثم «مهتم» في النافذة نفسها = عودة إيجابية (firstKind لا أفضل الحلقة)', () => {
  const eps = [
    // عُد لاحقاً ثم مهتم في النافذة نفسها: أفضل الحلقة ٤ لكن أول نتيجة CALL_BACK ⇒ عودة إيجابية
    ep({ outletId: 'S', best: 4, firstKind: 'CALL_BACK', nRated: 2, firstAt: ago(40) }),
    // عُد لاحقاً مرتين في النافذة نفسها ⇒ عودة غير إيجابية
    ep({ outletId: 'U', best: 3, firstKind: 'CALL_BACK', nRated: 2, firstAt: ago(40) }),
    // أول نتيجة «مهتم» ⇒ ليست عودة، ولو كان فيها متابعة
    ep({ outletId: 'T', best: 4, firstKind: 'INTERESTED', nRated: 2, firstAt: ago(40) }),
    // عُد لاحقاً وحدها بلا متابعة ولا حلقة لاحقة ⇒ خارج المقام
    ep({ outletId: 'V', best: 3, firstKind: 'CALL_BACK', nRated: 1, firstAt: ago(40) }),
    // عُد لاحقاً وحدها ثم حلقة لاحقة إيجابية خلال ٦٠ يوماً ⇒ عودة إيجابية (المسار القديم باقٍ)
    ep({ outletId: 'X', best: 3, firstKind: 'CALL_BACK', nRated: 1, firstAt: ago(80) }), ep({ outletId: 'X', best: 4, firstKind: 'INTERESTED', nRated: 1, firstAt: ago(45) }),
  ];
  const cb = stats(eps).byType.GROCERY.callback!;
  assert.equal(cb.n, 3, 'S و U و X');
  assert.equal(cb.rate, 0.6667);

  // الحالة وحدها: عودة واحدة إيجابية
  const only = stats([ep({ outletId: 'S1', best: 4, firstKind: 'CALL_BACK', nRated: 2 })]).byType.GROCERY.callback!;
  assert.equal(only.n, 1);
  assert.equal(only.rate, 1);
  // ومتابعة إيجابية في الحلقة نفسها تكفي ولو تلتها حلقة سلبية
  const thenNeg = stats([
    ep({ outletId: 'S2', best: 4, firstKind: 'CALL_BACK', nRated: 3, firstAt: ago(80) }), ep({ outletId: 'S2', best: 1, firstKind: 'NOT_INTERESTED', nRated: 1, firstAt: ago(45) }),
  ]).byType.GROCERY.callback!;
  assert.deepEqual([thenNeg.n, thenNeg.rate], [1, 1]);
});

test('مضاعف النوع: انكماش بقوة ١٥ نحو متوسط الشركة ومقصوص [0.6، 1.6]، و١ دون العتبات', () => {
  const s = stats([...many(12, { best: 4 }), ...many(8, { best: 1 }), ...many(2, { type: 'PHARMACY', best: 4 }), ...many(18, { type: 'PHARMACY', best: 1 })]);
  near(s.tenantPosRate, 0.35);
  assert.equal(s.byType.GROCERY.typeMult, 1.408);
  assert.equal(s.byType.PHARMACY.typeMult, 0.6);
  const small = stats([...many(8, { best: 4 }), ...many(2, { best: 1 }), ...many(1, { type: 'PHARMACY', best: 4 }), ...many(9, { type: 'PHARMACY', best: 1 })]);
  assert.equal(small.byType.GROCERY.typeMult, 1, 'ΣN < 30');
  assert.equal(small.byType.PHARMACY.typeMult, 1);
});

// ───────────── اقتراحات الإدارة ─────────────

test('الاقتراحات تظهر فقط حين يخلو دليل البيع من الجذر', () => {
  const perRep = (rep: string) => [...many(5, { rep, objection: 'NEEDS_CREDIT' }), ...many(5, { rep, objection: 'PRICE' }), ...many(2, { rep, objection: 'TIMING' })];
  const field = stats([...perRep('rA'), ...perRep('rB'), ...perRep('rC')], [], 3);
  assert.equal(field.byType.GROCERY.objections!.exposed, true);
  assert.ok(field.byType.GROCERY.objections!.shares.NEEDS_CREDIT! >= 0.25);
  const base = { field, intentCounts: {}, chatTotal: 0, insufficientTypes: [] as string[], typeLabel: (c: string) => c };
  const codes = (playbook: string | null) => F.fieldHints({ ...base, playbook }).map(h => h.code).sort();

  assert.deepEqual(codes(null), ['PLAYBOOK_CREDIT', 'PLAYBOOK_PRICE']);
  assert.deepEqual(codes('نقبل البيع بالأجل لمدة أسبوعين'), ['PLAYBOOK_PRICE'], 'الأجل بالهمزة يُطابق بعد التوحيد');
  assert.deepEqual(codes('الأسعار ثابتة والخصم للكميات الكبيرة'), ['PLAYBOOK_CREDIT']);
  assert.deepEqual(codes('البيع آجل حسب الاتفاق، وعرض خاص للجملة'), []);
  // «عاجل» و«من أجل» ليستا سياسة آجل (تفويض صريح عبر playbookAuthorizes)
  assert.deepEqual(codes('نوصّل الطلبات العاجلة في اليوم نفسه، والأسعار ثابتة'), ['PLAYBOOK_CREDIT']);
  assert.deepEqual(codes('نعمل من أجل رضا العميل، والأسعار ثابتة'), ['PLAYBOOK_CREDIT']);
  assert.deepEqual(codes('التقسيط متاح، والأسعار ثابتة'), []);
  const credit = F.fieldHints({ ...base, playbook: null }).find(h => h.code === 'PLAYBOOK_CREDIT')!;
  assert.equal(credit.textAr, 'مناديبك يواجهون طلب الآجل ودليل البيع لا يذكر سياستكم — أضفها ليجيب المستشار');
  assert.equal(F.fieldHints({ ...base, playbook: null }).find(h => h.code === 'PLAYBOOK_PRICE')!.textAr, 'مناديبك يُسألون عن الأسعار ودليل البيع لا يذكرها');

  // خانة غير معروضة لا تُطلق اقتراحاً
  const thin = stats(many(5, { objection: 'NEEDS_CREDIT' }));
  assert.deepEqual(F.fieldHints({ ...base, field: thin, playbook: null }), []);

  // نيّات المحادثة: ≥١٠٪ من ≥٣٠
  const byIntent = (counts: Record<string, number>, chatTotal: number) =>
    F.fieldHints({ ...base, field: null, playbook: null, intentCounts: counts, chatTotal }).map(h => h.code);
  assert.deepEqual(byIntent({ OBJ_CREDIT: 3 }, 30), ['PLAYBOOK_CREDIT']);
  assert.deepEqual(byIntent({ OBJ_CREDIT: 3 }, 29), []);
  assert.deepEqual(byIntent({ OBJ_PRICE: 2 }, 30), []);
  assert.deepEqual(byIntent({ OBJ_PRICE: 5 }, 40), ['PLAYBOOK_PRICE']);

  // أنواع ينقصها التصنيف (مرّة واحدة لكل نوع، بلا صلة بالدليل)
  const t = F.fieldHints({ ...base, field: null, playbook: 'آجل وأسعار', insufficientTypes: ['MINIMARKET', 'MINIMARKET'], typeLabel: () => 'ميني ماركت' });
  assert.deepEqual(t, [{ code: 'CLASSIFY_TYPE:MINIMARKET', textAr: 'صنّف عملاء «ميني ماركت» وأضف مواقعهم ليتحسّن التوقّع' }]);
});

// ───────────── إشارات الملاحظة والنيّة (signals.ts) ─────────────

test('classifyObjectionNote: عبارات خليجية', () => {
  assert.equal(S.classifyObjectionNote('غالي عليه'), 'PRICE');
  assert.equal(S.classifyObjectionNote('عنده مورّد'), 'HAS_SUPPLIER');
  assert.equal(S.classifyObjectionNote('ما عنده مكان بالرف'), 'NO_SHELF_SPACE');
  assert.equal(S.classifyObjectionNote('يبي آجل'), 'NEEDS_CREDIT');
  assert.equal(S.classifyObjectionNote('صاحب المحل مو موجود'), 'DECISION_MAKER_ABSENT');
  assert.equal(S.classifyObjectionNote('المحل نظيف والموقع ممتاز'), null);
  assert.equal(S.classifyObjectionNote(''), null);
});

test('classifyIntent', () => {
  assert.equal(S.classifyIntent('من وين أبدأ'), 'WHERE_START');
  assert.equal(S.classifyIntent('وش أعرض'), 'WHAT_OFFER');
  assert.equal(S.classifyIntent('رتّب لي مسار'), 'ROUTE');
  assert.equal(S.classifyIntent('وش تعلّمت من زيارات فريقنا؟'), 'TEAM_EXPERIENCE');
  assert.equal(S.classifyIntent('السلام عليكم'), 'OTHER');
  // لغات الواجهة الأخرى (بعد التحويل لحروف صغيرة)
  assert.equal(S.classifyIntent('What have you learned from our team’s visits?'), 'TEAM_EXPERIENCE');
  assert.equal(S.classifyIntent('Where should I start?'), 'WHERE_START');
  assert.equal(S.classifyIntent('He says he already has a supplier'), 'OBJ_SUPPLIER');
  assert.equal(S.classifyIntent('Combien dois-je proposer ?'), 'HOW_MUCH');
  assert.equal(S.classifyIntent('WHERE SHOULD I START'), 'WHERE_START');
});

test('outcomeObjection: الزر > الضمني > الكلمات', () => {
  assert.deepEqual(S.outcomeObjection('EXCLUSIVE_SUPPLIER', 'PRICE', 'غالي'), { objection: 'PRICE', source: 'REP' });
  assert.deepEqual(S.outcomeObjection('EXCLUSIVE_SUPPLIER', undefined, 'غالي'), { objection: 'HAS_SUPPLIER', source: 'IMPLIED' });
  assert.deepEqual(S.outcomeObjection('NOT_INTERESTED', undefined, 'غالي'), { objection: 'PRICE', source: 'KW' });
  assert.deepEqual(S.outcomeObjection('NOT_INTERESTED', 'TIMING', 'غالي'), { objection: 'TIMING', source: 'REP' });
  assert.deepEqual(S.outcomeObjection('INTERESTED', undefined, 'تمام'), { objection: null, source: null });
  assert.deepEqual(S.outcomeObjection('CLOSED', 'PRICE', 'غالي'), { objection: null, source: null });
});
