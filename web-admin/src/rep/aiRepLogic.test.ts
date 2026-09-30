// المندوب الذكي — منطق شاشة المندوب: ترتيب المسار، الأزمنة التقديرية، روابط الملاحة، والتنسيق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distKm, fmtDistance, fmtRange, multiStopUrl, navUrl, orderRoute, routeLegs, OUTLET_TYPE_OPTIONS, OUTCOMES } from './aiRepLogic';
import { AI_REP_PHRASES, aiRepTranslate } from '../i18n/aiRepPhrases';

const O = { lat: 24.7, lng: 46.7 };
const at = (id: string, kmEast: number, kmNorth = 0) => ({ placeId: id, name: id, lat: O.lat + kmNorth / 111, lng: O.lng + kmEast / 101 });

test('ترتيب المسار: من الأقرب ولا تقاطع (2‑opt)، وحتمي', () => {
  const stops = [at('c', 3), at('a', 1), at('b', 2)];
  assert.deepEqual(orderRoute(O, stops).map(s => s.placeId), ['a', 'b', 'c']);
  // مربّع: الترتيب الأمثل يدور حوله لا يقطعه قطرياً
  const sq = [at('p1', 1, 0), at('p3', 1, 1), at('p2', 0, 1), at('p4', 2, 0.5)];
  const r1 = orderRoute(O, sq).map(s => s.placeId), r2 = orderRoute(O, [...sq].reverse()).map(s => s.placeId);
  const len = (ids: string[]) => { let d = 0, prev = O as { lat: number; lng: number }; for (const id of ids) { const s = sq.find(x => x.placeId === id)!; d += distKm(prev, s); prev = s; } return d; };
  assert.ok(Math.abs(len(r1) - len(r2)) < 1e-9, 'الطول نفسه مهما كان ترتيب الإدخال');
  assert.equal(orderRoute(O, []).length, 0);
});

test('الأزمنة التقديرية: تعرّج ١٫٣ وسرعة ٢٥ كم/س تراكمياً', () => {
  const legs = routeLegs(O, [at('a', 5)]);
  assert.ok(Math.abs(legs[0].legKm - 5 * 1.3) < 0.1);
  assert.equal(legs[0].etaMin, Math.round((legs[0].cumKm / 25) * 60));
});

test('روابط الملاحة: معرّف المكان، وحدّ ٣ نقاط وسيطة للجوال', () => {
  const u = new URL(navUrl({ lat: 24.7, lng: 46.7, placeId: 'ChIJ1' }));
  assert.equal(u.searchParams.get('destination_place_id'), 'ChIJ1');
  assert.equal(u.searchParams.get('dir_action'), 'navigate');
  const m = new URL(multiStopUrl([at('a', 1), at('b', 2), at('c', 3), at('d', 4), at('e', 5)])!);
  assert.equal(m.searchParams.get('destination_place_id'), 'd', 'الوجهة هي الرابعة');
  assert.equal(m.searchParams.get('waypoints')!.split('|').length, 3);
  assert.equal(m.searchParams.get('waypoint_place_ids'), 'a|b|c');
  assert.equal(multiStopUrl([]), null);
});

test('التنسيق: المسافة والمدى', () => {
  assert.equal(fmtDistance(437), '440 م');
  assert.equal(fmtDistance(2350), '2.4 كم');
  assert.equal(fmtRange({ low: 6, high: 12 }), '6–12');
  assert.equal(fmtRange({ low: 5, high: 5 }), '5');
  assert.equal(fmtRange(null), '—');
});

test('كل تسمية ثابتة (الأنواع والنتائج) لها ترجمة', () => {
  for (const lang of ['en', 'fr', 'tr', 'zh']) {
    for (const t of OUTLET_TYPE_OPTIONS) assert.notEqual(aiRepTranslate(lang, t.label), t.label, `بلا ترجمة ${lang}: ${t.label}`);
    for (const o of OUTCOMES) assert.notEqual(aiRepTranslate(lang, o.label), o.label, `بلا ترجمة ${lang}: ${o.label}`);
  }
  assert.equal(aiRepTranslate('ar', 'مهتم'), 'مهتم');
  for (const [k, v] of Object.entries(AI_REP_PHRASES)) assert.ok(v.en && v.fr && v.tr && v.zh, `ترجمة ناقصة: ${k}`);
});

import { renderRefs } from './aiRepLogic';

test('عرض الأسماء مكان مراجع المستشار (الاسم لا يغادر الجهاز)', () => {
  assert.equal(renderRefs('ابدأ بـ P1 ثم P2 وليس P10', [{ ref: 'P1', label: 'بقالة الخير' }, { ref: 'P2', label: 'صيدلية' }]), 'ابدأ بـ «بقالة الخير» ثم «صيدلية» وليس P10');
});

// ───────────── حلقة التعلّم ─────────────
import {
  FEEDBACK_REASONS, LESSON_ORIGIN_LABEL, LESSON_REASON_LABEL, OBJECTIONS, OBJECTION_OUTCOMES, VERDICT_LABEL,
  autoRolledBack, betaAbove, lessonActions, toRate, verdictOfCI, verdictOfP,
} from './aiRepLogic';

test('أسباب الرفض: عشرة رموز فريدة مطابقة للخادم، ولا أزرار مع مغلق/أصبح عميلاً/مورّد حصري', () => {
  const codes = OBJECTIONS.map(o => o.code);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, 'رمز مكرّر');
  assert.equal(new Set(OBJECTIONS.map(o => o.label)).size, 10, 'تسمية مكرّرة');
  // نسخة الخادم: backend/src/ai-rep/learn/signals.ts OBJECTION_CODES — الخادم يرفض أي رمز غيرها بـ400
  assert.deepEqual(codes, ['PRICE', 'HAS_SUPPLIER', 'NO_SHELF_SPACE', 'NEEDS_CREDIT', 'SLOW_MOVING', 'DECISION_MAKER_ABSENT', 'WANTS_SAMPLE', 'UNKNOWN_BRAND', 'TIMING', 'OTHER']);
  for (const k of ['CLOSED', 'CONVERTED', 'EXCLUSIVE_SUPPLIER']) assert.ok(!OBJECTION_OUTCOMES.has(k), `أزرار السبب لا تظهر مع ${k}`);
  for (const k of ['INTERESTED', 'CALL_BACK', 'QUOTE', 'NOT_INTERESTED']) assert.ok(OBJECTION_OUTCOMES.has(k));
  for (const k of OBJECTION_OUTCOMES) assert.ok(OUTCOMES.some(o => o.kind === k), `نتيجة غير معروفة: ${k}`);
});

test('أسباب «غير مفيد» مطابقة لرموز الخادم', () => {
  assert.deepEqual(FEEDBACK_REASONS.map(r => r.code), ['WRONG_OUTLET', 'WRONG_QTY', 'NOT_PRACTICAL', 'WRONG_INFO', 'TOO_LONG']);
});

test('كل تسمية حلقة التعلّم لها ترجمة باللغات الأربع', () => {
  const labels = [
    ...OBJECTIONS.map(o => o.label), ...FEEDBACK_REASONS.map(r => r.label), ...Object.values(VERDICT_LABEL),
    ...Object.values(LESSON_REASON_LABEL), ...Object.values(LESSON_ORIGIN_LABEL),
  ];
  for (const lang of ['en', 'fr', 'tr', 'zh']) {
    for (const l of labels) assert.notEqual(aiRepTranslate(lang, l), l, `بلا ترجمة ${lang}: ${l}`);
  }
});

test('الأحكام لا تدّعي تحسّناً ما لم يستبعد المجال الصفر', () => {
  // نسب: ≥0.9 مؤكَّد، 0.7–0.9 مؤشّر، وإلا لا أثر؛ ودون الحدّ الأدنى للعدد لا يُدّعى شيء
  assert.equal(verdictOfP(0.95), 'CONFIRMED');
  assert.equal(verdictOfP(0.8), 'HINT');
  assert.equal(verdictOfP(0.6), 'NONE');
  assert.equal(verdictOfP(0.99, 5, 20), 'NONE');
  assert.equal(verdictOfP(null), 'NEEDS_DATA');
  // الترتيب: lo90 > 0 وحده «مؤكَّد»
  assert.equal(verdictOfCI(0.05, 0.01, 0.09, 100, 40), 'CONFIRMED');
  assert.equal(verdictOfCI(0.03, -0.01, 0.07, 100, 40), 'HINT');
  assert.equal(verdictOfCI(0, -0.04, 0.04, 100, 40), 'NONE');
  assert.equal(verdictOfCI(0.2, 0.1, 0.3, 12, 40), 'NONE', 'أزواج أقل من المطلوب');
  assert.equal(verdictOfCI(null, null, null), 'NEEDS_DATA');
});

test('betaAbove: احتمال أن تتجاوز النسبة عتبة (تقريب طبيعي كما في الخادم)', () => {
  assert.ok(betaAbove(90, 100, 0.5) > 0.99);
  assert.ok(betaAbove(10, 100, 0.5) < 0.01);
  assert.ok(Math.abs(betaAbove(50, 100, 0.5) - 0.5) < 0.01);
  assert.ok(betaAbove(3, 4, 0.5) < 0.9, 'أربع حالات لا تكفي لادّعاء');
});

test('toRate يقبل العدّاد والنسبة', () => {
  assert.equal(toRate(3, 30), 0.1);
  assert.equal(toRate(0.25, 30), 0.25);
  assert.equal(toRate(0, 30), 0);
  assert.equal(toRate(null, 30), null);
  assert.equal(toRate(40, 30), null);
});

test('أسوأ — أُعيد للأساس: آخر نسخة أُرجعت تلقائياً لا بيد الإدارة', () => {
  const m = (version: number, status: string, reason: string | null = null) => ({ kind: 'POLICY', version, status, reason });
  assert.equal(autoRolledBack([m(1, 'SUPERSEDED'), m(2, 'ROLLED_BACK', 'AUTO_REGRESSION')], 'POLICY'), true);
  assert.equal(autoRolledBack([m(1, 'ACTIVE'), m(2, 'ROLLED_BACK', 'ADMIN_ROLLBACK')], 'POLICY'), false);
  assert.equal(autoRolledBack([m(1, 'ROLLED_BACK', 'AB_WORSE'), m(2, 'ACTIVE')], 'POLICY'), false, 'نسخة أحدث فعّالة');
  assert.equal(autoRolledBack([m(1, 'ROLLED_BACK', 'AB_WORSE')], 'CALIBRATION'), false);
  assert.equal(autoRolledBack([], 'POLICY'), false);
});

test('إجراءات الدرس لكل حالة (الخادم يرفض غيرها بـ409)', () => {
  assert.deepEqual(lessonActions('PENDING'), ['approve', 'reject']);
  assert.deepEqual(lessonActions('TRIAL'), ['disable']);
  assert.deepEqual(lessonActions('ACTIVE'), ['disable']);
  assert.deepEqual(lessonActions('DISABLED'), ['enable']);
  assert.deepEqual(lessonActions('RETIRED'), ['restore']);
  assert.deepEqual(lessonActions('REJECTED'), []);
});

// ───────────── وسم المحل في قائمة المسح ─────────────
import { CLOSED_OUTCOMES, OUTCOME_LABEL, shopBadge } from './aiRepLogic';

test('وسم المسح: العميل و«ربما عميل» والمُبلَّغ عن إغلاقه وآخر نتيجة للفريق، و«مغلق الآن» من أمس لا يَسِم', () => {
  const now = new Date(2026, 8, 20, 12, 0, 0);
  const at = (h: number) => new Date(now.getTime() - h * 3600000).toISOString();
  const b = (o: Partial<Parameters<typeof shopBadge>[0]>) => shopBadge({ relation: 'NEW', ...o }, now);
  assert.deepEqual(b({ relation: 'CUSTOMER', lastOutcome: 'CONVERTED' }), { label: 'عميل حالي', tone: 'customer' });
  assert.deepEqual(b({ relation: 'POSSIBLE_CUSTOMER' }), { label: 'ربما عميل حالي', tone: 'possible' }, 'لا «فرصة جديدة» خضراء للعميل المحتمل');
  assert.deepEqual(b({ reportedClosed: true, lastOutcome: 'NOT_FOUND', lastOutcomeAt: at(72) }), { label: 'أُبلغ أنه مغلق', tone: 'muted' });
  assert.deepEqual(b({ lastOutcome: 'QUOTE', lastOutcomeAt: at(2) }), { label: 'طلب عرض سعر', tone: 'followup' }, 'زاره زميل ⇒ ليس فرصة جديدة');
  assert.deepEqual(b({ lastOutcome: 'NOT_INTERESTED', lastOutcomeAt: at(24 * 5) }), { label: 'غير مهتم', tone: 'muted' });
  assert.deepEqual(b({ lastOutcome: 'CLOSED', lastOutcomeAt: at(1) }), { label: 'مغلق الآن', tone: 'muted' });
  assert.deepEqual(b({ lastOutcome: 'CLOSED', lastOutcomeAt: at(30) }), { label: 'فرصة جديدة', tone: 'new' }, 'وُجد مغلقاً أمس ⇒ فرصة من جديد');
  assert.deepEqual(b({}), { label: 'فرصة جديدة', tone: 'new' });
  assert.ok(CLOSED_OUTCOMES.has('CLOSED') && CLOSED_OUTCOMES.has('NOT_FOUND'));
  assert.equal(OUTCOME_LABEL.NOT_FOUND, 'أُغلق نهائياً / لم أجده');
  // تسميات الوسم تمرّ بـtr() متغيّرةً (لا يلتقطها فحص المفاتيح الحرفية) ⇒ ترجمتها هنا
  const labels = ['عميل حالي', 'ربما عميل حالي', 'أُبلغ أنه مغلق', 'فرصة جديدة', ...Object.values(OUTCOME_LABEL)];
  for (const lang of ['en', 'fr', 'tr', 'zh']) for (const l of labels) assert.notEqual(aiRepTranslate(lang, l), l, `بلا ترجمة ${lang}: ${l}`);
});
