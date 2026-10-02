// المندوب الذكي — منطق شاشة المسح: رابط الملاحة والمسافة، والوسوم والنتائج وأسبابها، وإعادة المسح، وأحكام «ما تعلّمه العقل».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDistance, navUrl, refreshHoldMs, OUTLET_TYPE_OPTIONS, OUTCOMES } from './aiRepLogic';
import { AI_REP_PHRASES, aiRepTranslate } from '../i18n/aiRepPhrases';

const O = { lat: 24.7, lng: 46.7 };

test('«حدّث» يتوقّف لحظات بعد مسحٍ فشل من جهة Google وحدها', () => {
  assert.equal(refreshHoldMs({ code: 'SCAN_FAILED', retryAfterS: 30 }), 30_000);
  assert.equal(refreshHoldMs({ code: 'SCAN_COOLDOWN', retryAfterS: 720 }), 30_000, 'القاطع الطويل: لحظات في الواجهة والخادم يرفض الباقي');
  assert.equal(refreshHoldMs({ code: 'SOURCE_CHANGED' }), 8_000);
  assert.equal(refreshHoldMs({ code: 'SCAN_COOLDOWN', retryAfterS: 1 }), 5_000);
  assert.equal(refreshHoldMs({ code: 'AI_REP_DAILY_LIMIT' }), 0);
  assert.equal(refreshHoldMs(undefined), 0);
});

test('رابط الملاحة: بمعرّف المكان ويبدأ الملاحة', () => {
  const u = new URL(navUrl({ lat: 24.7, lng: 46.7, placeId: 'ChIJ1' }));
  assert.equal(u.searchParams.get('destination_place_id'), 'ChIJ1');
  assert.equal(u.searchParams.get('dir_action'), 'navigate');
});

test('التنسيق: المسافة', () => {
  assert.equal(fmtDistance(437), '440 م');
  assert.equal(fmtDistance(2350), '2.4 كم');
  assert.equal(fmtDistance(Number.NaN), '—');
});

test('كل تسمية ثابتة (الأنواع والنتائج) لها ترجمة', () => {
  for (const lang of ['en', 'fr', 'tr', 'zh']) {
    for (const t of OUTLET_TYPE_OPTIONS) assert.notEqual(aiRepTranslate(lang, t.label), t.label, `بلا ترجمة ${lang}: ${t.label}`);
    for (const o of OUTCOMES) assert.notEqual(aiRepTranslate(lang, o.label), o.label, `بلا ترجمة ${lang}: ${o.label}`);
  }
  assert.equal(aiRepTranslate('ar', 'مهتم'), 'مهتم');
  for (const [k, v] of Object.entries(AI_REP_PHRASES)) assert.ok(v.en && v.fr && v.tr && v.zh, `ترجمة ناقصة: ${k}`);
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
  const labels = ['عميل حالي', 'ربما عميل حالي', 'أُبلغ أنه مغلق', 'فرصة جديدة', 'بانتظار المزامنة', ...Object.values(OUTCOME_LABEL)];
  for (const lang of ['en', 'fr', 'tr', 'zh']) for (const l of labels) assert.notEqual(aiRepTranslate(lang, l), l, `بلا ترجمة ${lang}: ${l}`);
  // أُضيف عميلاً دون اتصال: لا «فرصة جديدة» تُغري بإضافته ثانيةً، والعميل الفعلي يسبقه
  assert.deepEqual(b({ pendingCustomer: true }), { label: 'بانتظار المزامنة', tone: 'customer' });
  assert.equal(b({ pendingCustomer: true, relation: 'CUSTOMER' }).label, 'عميل حالي');
});

// ───────────── موقع المندوب وإعادة المسح ─────────────
import { GPS_ERROR_TEXT, RESCAN_AGE_MS, RESCAN_MOVE_M, gpsErrorKind, mergeStudied, needsRescan } from './aiRepLogic';

test('سبب تعذّر الموقع: رفض الإذن غير انتهاء المهلة غير «غير متاح»، ولكلٍّ رسالة مترجمة', () => {
  assert.equal(gpsErrorKind({ code: 1 }), 'DENIED');
  assert.equal(gpsErrorKind({ code: 3 }), 'TIMEOUT');
  assert.equal(gpsErrorKind({ code: 2 }), 'UNAVAILABLE');
  assert.equal(gpsErrorKind(new Error('no-geo')), 'UNAVAILABLE', 'جهاز بلا GPS');
  assert.equal(gpsErrorKind(null), 'UNAVAILABLE');
  const texts = Object.values(GPS_ERROR_TEXT);
  assert.equal(new Set(texts).size, 3, 'ثلاث رسائل مختلفة');
  for (const lang of ['en', 'fr', 'tr', 'zh']) for (const t of texts) assert.notEqual(aiRepTranslate(lang, t), t, `بلا ترجمة ${lang}: ${t}`);
});

test('إعادة المسح عند العودة: الابتعاد عن موضع آخر مسح أو قِدَمه، وارتعاش الموقع التقريبي لا يُحسب ابتعاداً', () => {
  const now = 1_000_000_000;
  const last = { at: O, when: now - 60_000 };
  const moved = (m: number) => ({ lat: O.lat + m / 111_000, lng: O.lng });
  assert.equal(needsRescan(moved(0), null, now), true, 'لا مسح سابق معروف');
  assert.equal(needsRescan({ ...moved(RESCAN_MOVE_M - 50), accuracy: 10 }, last, now), false, 'في المكان نفسه تقريباً');
  assert.equal(needsRescan({ ...moved(RESCAN_MOVE_M + 100), accuracy: 10 }, last, now), true, 'حيٌّ آخر');
  assert.equal(needsRescan({ ...moved(RESCAN_MOVE_M + 100), accuracy: 800 }, last, now), false, 'الفرق دون دقّة الموقع ⇒ ارتعاش');
  assert.equal(needsRescan(moved(0), { at: O, when: now - RESCAN_AGE_MS - 1 }, now), true, 'مسحٌ قديم');
});

test('دمج محلٍّ دُرس بمراجعاته: الموجود يحتفظ بمرجعه، والجديد لا يصطدم بمرجع جلسة خادمٍ انتهت', () => {
  const list = [{ placeId: 'a', ref: 'P1', v: 1 }, { placeId: 'b', ref: 'P2', v: 1 }];
  // جلسة الخادم انتهت: أعادت P1 لمحلٍّ هو P2 في القائمة
  const m1 = mergeStudied(list, { placeId: 'b', ref: 'P1', v: 2 });
  assert.deepEqual(m1.map(x => [x.placeId, x.ref, x.v]), [['a', 'P1', 1], ['b', 'P2', 2]], 'خطة التوجيه تبقى تشير إلى المحل الصحيح');
  const m2 = mergeStudied(list, { placeId: 'c', ref: 'P1', v: 2 });
  assert.deepEqual(m2.map(x => x.ref), ['P1', 'P2', 'P3'], 'الجديد بمرجعٍ غير مأخوذ');
  assert.equal(new Set(mergeStudied(m2, { placeId: 'd', ref: 'P3', v: 2 }).map(x => x.ref)).size, 4);
  assert.deepEqual(mergeStudied(list, { placeId: 'c', ref: 'P3', v: 2 }).map(x => x.ref), ['P1', 'P2', 'P3'], 'مرجع الخادم إن لم يُؤخذ');
});

// ───────────── توجيه العقل المؤجَّل ─────────────
import { aiStopsAfterScan } from './aiRepLogic';

test('توجيه العقل بعد المسح: ما زاره المندوب أو حوّله أو أُغلق منذ المسح لا يعود للخطة — وزيارات الفريق قبل المسح لا تُسقط', () => {
  const scannedAt = Date.parse('2026-09-30T09:00:00Z');
  const stops = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map(ref => ({ ref, why: '' }));
  const items = [
    { ref: 'P1', relation: 'NEW', lastOutcomeAt: '2026-09-30T09:20:00Z' }, // سجّل نتيجته بعد المسح
    { ref: 'P2', relation: 'NEW', lastOutcomeAt: '2026-09-27T10:00:00Z' }, // متابعة من زيارة سابقة
    { ref: 'P3', relation: 'CUSTOMER' }, // أضافه عميلاً
    { ref: 'P4', relation: 'NEW', pendingCustomer: true }, // أضافه دون اتصال
    { ref: 'P5', relation: 'NEW', closed: true }, // «مغلق الآن»
    { ref: 'P6', relation: 'NEW', lastOutcomeAt: null },
  ];
  assert.deepEqual(aiStopsAfterScan(stops, items, scannedAt).map(s => s.ref), ['P2', 'P6']);
  assert.deepEqual(aiStopsAfterScan(stops, [], scannedAt).length, 6, 'محلٌّ غير معروف في القائمة لا يُسقط');
});

// ───────────── لغة المندوب: وقائع الخادم ← نصوص بلغته ─────────────
import {
  FOLLOW_UP_WHAT, HOUR_BAND_TEXT, OBJECTION_TACTIC, OPPORTUNITY_TEXT, THEME_LABEL, VISIT_TIP_TEXT,
  aiErrOf, aiErrorText, guideSummaryText, shopTypeText, stopWhyText, studyTexts, teamTipText,
} from './aiRepLogic';

const trOf = (lang: string) => (ar: string) => aiRepTranslate(lang, ar);
const en = trOf('en');

test('المسافة بوحدات لغة المندوب وفاصلتها العشرية، والعربية كما كانت', () => {
  assert.deepEqual([fmtDistance(437, 'en'), fmtDistance(2350, 'en'), fmtDistance(12345, 'en')], ['440 m', '2.4 km', '12 km']);
  assert.equal(fmtDistance(2350, 'fr'), '2,4 km');
  assert.equal(fmtDistance(2350, 'tr'), '2,4 km');
  assert.deepEqual([fmtDistance(437, 'zh'), fmtDistance(2350, 'zh')], ['440 米', '2.4 公里']);
  assert.equal(fmtDistance(2350, 'ar'), '2.4 كم');
});

test('خلاصة التوجيه: العربية نصّ الخادم، وغيرها من وقائع خلاصة القواعد، وبلا وقائع (نصّ العقل بلغة المندوب) كما هو', () => {
  const facts = { shops: 8, fresh: 6, follow: 1, customers: 1, possible: 0, stops: 5, open: 5 };
  const g = { summary: 'حولك 8 محلات، منها 6 فرص جديدة. ابدأ بهذا الترتيب:', facts };
  assert.equal(guideSummaryText(g, 'ar', trOf('ar')), g.summary);
  assert.equal(guideSummaryText(g, 'en', en), 'Shops around you: 8 — New opportunities: 6 · To follow up: 1 · Your customers: 1. Start in this order:');
  assert.equal(guideSummaryText({ summary: 'x', facts: { ...facts, stops: 1, open: 0 } }, 'en', en).endsWith('Closed now — visit it when it opens:'), true);
  assert.equal(guideSummaryText({ summary: 'x', facts: { ...facts, stops: 0 } }, 'fr', trOf('fr')), 'Commerces autour de vous : 8 — aucune nouvelle opportunité ni aucun suivi à faire pour l’instant — essayez une autre zone.');
  assert.equal(guideSummaryText({ summary: 'x', facts: { ...facts, shops: 0 } }, 'en', en), 'No target shops around you right now — try another area.');
  assert.match(guideSummaryText(g, 'zh', trOf('zh')), /^您附近的门店：8 — .+。按此顺序开始：$/);
  assert.equal(guideSummaryText({ summary: 'Start with the nearest.' }, 'en', en), 'Start with the nearest.');
});

test('سبب المحطة بلغة المندوب: المتابعة وأيامها، والزيارة السابقة، والتقييم ومقيّموه (مفرداً وجمعاً)، والفتح، والمسافة', () => {
  const f = { fu: 'QUOTE', days: 4, rating: 4.2, ratingCount: 30, openNow: true, distanceM: 400 };
  assert.equal(stopWhyText({ why: 'عربي', f }, 'ar', trOf('ar')), 'عربي');
  assert.equal(stopWhyText({ why: 'عربي', f }, 'en', en), 'Follow-up: Asked for a quote — 4 days ago · Rated 4.2 (30 ratings) on Google Maps · Open now · 400 m away');
  assert.equal(stopWhyText({ why: 'x', f: { prev: 'CLOSED', rating: 5, ratingCount: 1, openNow: false, distanceM: 2350 } }, 'en', en),
    'Found closed on an earlier visit · Rated 5 (1 rating) on Google Maps · Closed now — visit later · 2.4 km away');
  assert.equal(stopWhyText({ why: 'x', f: { rating: 4.5, ratingCount: null, openNow: null, distanceM: 90 } }, 'fr', trOf('fr')), 'Noté 4,5 sur Google Maps · à 90 m');
  assert.equal(stopWhyText({ why: 'x', f: { prev: 'NOT_FOUND', rating: null, ratingCount: null, openNow: null, distanceM: 90 } }, 'zh', trOf('zh')),
    '此前曾报告未找到 · Google 地图上暂无评分 · 距离 90 米');
  assert.equal(stopWhyText({ why: 'Close by' }, 'en', en), 'Close by', 'سبب العقل بلا وقائع كما هو');
});

test('الدراسة بلغة المندوب: الحتمي من وقائعه (الخلاصة والنشاط والمحاور والفرص والساعات)، ونصّ العقل كما هو، والرمز المجهول يُبقي النص', () => {
  const s = {
    summary: 'عربي', activityWhy: 'عربي', praise: ['النظافة'], complaints: ['الأسعار'], opportunity: ['عربي'], visitTip: 'عربي',
    facts: {
      summary: { name: 'Baqala', rating: 4.2, ratingCount: 128, openNow: true, reviews: 3 }, activityN: 128,
      praise: ['CLEAN'], complaints: ['PRICE'], opportunity: ['PRICE_SENSITIVE'], visitTip: 'HOURS',
    },
  };
  assert.deepEqual(studyTexts(s, 'ar', trOf('ar')), { summary: 'عربي', activityWhy: 'عربي', praise: ['النظافة'], complaints: ['الأسعار'], opportunity: ['عربي'], visitTip: 'عربي' });
  assert.deepEqual(studyTexts(s, 'en', en), {
    summary: 'Baqala: Rated 4.2 (128 ratings) on Google Maps · Open now',
    activityWhy: 'Based on the number of ratings (128) — the more ratings, the more customer traffic.',
    praise: ['Cleanliness'], complaints: ['Prices'], opportunity: ['Customers are price-sensitive — start with the best-value products.'],
    visitTip: 'Check the opening hours below and avoid peak times.',
  });
  const noRating = studyTexts({ ...s, facts: { summary: { name: 'B', rating: null, ratingCount: 0, openNow: null, reviews: 1 }, activityN: 0, visitTip: null } }, 'en', en);
  assert.deepEqual([noRating.summary, noRating.activityWhy, noRating.visitTip], ['B: study based on 1 review from Google Maps.', '', null]);
  assert.equal(studyTexts({ ...s, facts: { summary: { name: 'B', rating: null, ratingCount: 0, openNow: null, reviews: 0 } } }, 'en', en).summary,
    'B: no ratings on Google Maps yet — the study relies on your visit.');
  // دراسة العقل (بلا وقائع إلا خلاصة القواعد البديلة): النصوص كما كتبها العقل بلغة المندوب
  const ai = studyTexts({ ...s, praise: ['Clean aisles'], facts: { summary: s.facts.summary } }, 'en', en);
  assert.deepEqual([ai.summary.startsWith('Baqala: '), ai.praise, ai.visitTip], [true, ['Clean aisles'], 'عربي']);
  assert.deepEqual(studyTexts({ ...s, facts: { praise: ['NEW_THEME'] } }, 'en', en).praise, ['النظافة'], 'رمز من خادمٍ أحدث ⇒ النص');
});

test('«من تجربة فريقك» بلغة المندوب من مفتاح الدرس (الاعتراض والوقت والعودة)، وبلا مفتاح أو بمفتاح مجهول نصّه العربي', () => {
  assert.equal(teamTipText('OBJ:GROCERY:PRICE', 'عربي', 'ar', trOf('ar')), 'عربي');
  assert.equal(teamTipText('OBJ:GROCERY:PRICE', 'عربي', 'en', en),
    'At “Grocery” shops, one of the most common objections your reps hear: “Price is too high” — Focus on his profit margin and how fast the item sells, and stick to the playbook prices.');
  assert.equal(teamTipText('TIME:BAKERY:4', 'عربي', 'en', en), `“${en('مخبز')}” shops are often found closed at night — plan your visit for another time.`);
  assert.match(teamTipText('REVISIT:PHARMACY', 'عربي', 'tr', trOf('tr')), /dönüşte olumlu yanıt verdi/);
  for (const k of [null, 'OBJ:GROCERY:OTHER', 'TIME:GROCERY:9', 'OBJ:NOPE:PRICE', 'NEW:GROCERY']) assert.equal(teamTipText(k, 'عربي', 'en', en), 'عربي', String(k));
});

test('نوع المحل: العربية تصنيف Google كما جاء، وغيرها تسمية نوعه عندنا مترجمة', () => {
  const it = { outletTypeLabel: 'بقالة / تموينات', profile: { typeLabel: 'متجر بقالة' } };
  assert.equal(shopTypeText(it, 'ar', trOf('ar')), 'متجر بقالة');
  assert.equal(shopTypeText(it, 'en', en), 'Grocery');
  assert.equal(shopTypeText({ outletTypeLabel: 'مطعم', profile: null }, 'ar', trOf('ar')), 'مطعم');
});

test('أخطاء الخادم برموزها: العربية رسالته، وغيرها مترجمة بسياقها وحدّها ودقائقها، والرمز المجهول يُترك للرسالة العامة', () => {
  const axiosErr = (status: number, data: unknown) => ({ response: { status, data } });
  const limit = aiErrOf(axiosErr(429, { code: 'AI_REP_DAILY_LIMIT', limit: 20, message: 'بلغت حدّ المسح اليومي (20) — نتائجك الحالية تبقى متاحة' }));
  assert.deepEqual(limit, { status: 429, code: 'AI_REP_DAILY_LIMIT', limit: 20, message: 'بلغت حدّ المسح اليومي (20) — نتائجك الحالية تبقى متاحة', retryAfterS: undefined });
  assert.equal(aiErrOf(new Error('net')), null);
  assert.equal(aiErrorText(limit, 'scan', 'ar', trOf('ar')), limit!.message);
  assert.equal(aiErrorText(limit, 'scan', 'en', en), 'You’ve reached the daily scan limit (20) — your current results stay available');
  assert.equal(aiErrorText(limit, 'study', 'en', en), 'You’ve reached the daily scan and study limit (20) — it resets tomorrow');
  assert.equal(aiErrorText({ code: 'AI_REP_DAILY_LIMIT' }, 'outcome', 'en', en), 'You’ve reached the daily limit for recording outcomes — it resets tomorrow');
  assert.equal(aiErrorText({ status: 429, code: 'SCAN_COOLDOWN', retryAfterS: 20 }, 'scan', 'en', en), 'The scan failed a moment ago — wait half a minute, then refresh');
  assert.equal(aiErrorText({ status: 503, code: 'SCAN_COOLDOWN', retryAfterS: 600 }, 'scan', 'en', en), 'Google Maps is limiting searches right now — try again in 10 minutes');
  assert.equal(aiErrorText({ status: 503, code: 'SCAN_COOLDOWN', retryAfterS: 30 }, 'scan', 'en', en), 'Google Maps is limiting searches right now — try again in 1 minute');
  assert.equal(aiErrorText({ code: 'GPS_INACCURATE' }, 'scan', 'zh', trOf('zh')), '您的位置过于粗略——请在手机设置中为此应用开启“精确位置”，然后刷新');
  assert.equal(aiErrorText({ code: 'PLACE_CLOSED' }, 'study', 'fr', trOf('fr')), 'Ce commerce est fermé selon Google Maps');
  assert.equal(aiErrorText({ code: 'SOMETHING_NEW', message: 'رسالة' }, 'scan', 'en', en), null);
  assert.equal(aiErrorText({ code: 'SOMETHING_NEW', message: 'رسالة' }, 'scan', 'ar', trOf('ar')), 'رسالة');
  // كل رمز معروف له عبارة مترجمة (لا عربي لمندوبٍ بلغة أخرى)
  for (const code of ['AI_REP_NOT_ALLOWED', 'GPS_INACCURATE', 'SCAN_FAILED', 'SOURCE_CHANGED', 'PLACES_NOT_CONFIGURED', 'PLACES_QUOTA', 'PLACES_NOT_FOUND', 'PLACES_AUTH', 'PLACES_UNAVAILABLE', 'PLACE_CLOSED']) {
    for (const lang of ['en', 'fr', 'tr', 'zh']) assert.doesNotMatch(aiErrorText({ code }, 'scan', lang, trOf(lang)) ?? '', /[؀-ۿ]/, `${code} ${lang}`);
  }
});

test('عبارات لغة المندوب: كل رمزٍ في جداول الوقائع مترجم باللغات الأربع، وكل ترجمة تحمل متغيّرات عبارتها العربية', () => {
  const tables = [
    ...Object.values(FOLLOW_UP_WHAT), ...Object.values(THEME_LABEL), ...Object.values(OPPORTUNITY_TEXT), ...Object.values(VISIT_TIP_TEXT),
    ...HOUR_BAND_TEXT, ...Object.values(OBJECTION_TACTIC),
  ];
  for (const lang of ['en', 'fr', 'tr', 'zh']) for (const t of tables) assert.notEqual(aiRepTranslate(lang, t), t, `بلا ترجمة ${lang}: ${t}`);
  assert.deepEqual(Object.keys(OBJECTION_TACTIC), OBJECTIONS.map(o => o.code).filter(c => c !== 'OTHER'), 'تكتيك لكل اعتراض يولّد درساً');
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  for (const [k, v] of Object.entries(AI_REP_PHRASES)) {
    const want = vars(k);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.equal(vars(v[lang]), want, `متغيّرات ${lang}: ${k}`);
  }
});

// ───────────── «الطلب المتوقع من ملف المحل في Google» ─────────────
import {
  CONFIDENCE_TEXT, EXPECTED_HINT_TEXT, EXPECTED_SOURCE_TEXT, EXPECTED_TALK_TEXT,
  expectedBasisText, expectedQtyText, expectedRangeText, expectedRowText, fmtQty, type Expected, type ExpectedBasis,
} from './aiRepLogic';

const basisOf = (o: Partial<ExpectedBasis> = {}): ExpectedBasis => ({
  rating: 4.2, ratingCount: 165, trafficPct: 80, typeMedianCount: 40, typeMedianKnown: true, reviewsRead: true, reviews: 3,
  mentions: [{ name: 'بيض المراعي', reviews: 2 }], talk: ['BUSY'], source: 'VAN',
  text: '165 مقيّماً (أكثر من 80٪ من محلات المنطقة) · تقييم 4.2 · يُذكر «بيض المراعي» في مراجعتين', ...o,
});
const expOf = (products: Expected['products'], b: Partial<ExpectedBasis> = {}): Expected => ({ confidence: 'HIGH', basis: basisOf(b), products });
const prod = (o: Partial<Expected['products'][number]>): Expected['products'][number] =>
  ({ productId: 'p', name: 'بيض المراعي', unit: 'كرتون', qty: 12, low: 8, high: 16, mentioned: false, ...o });

test('الطلب المتوقع: سطر القائمة لأبرز صنفٍ برقم بلغة المندوب، والمذكور في المراجعات موسوم، وبلا رقم ⇒ لا سطر', () => {
  const e = expOf([prod({ productId: 'x', qty: null, low: null, high: null, reason: 'NO_ANCHOR', mentioned: true }), prod({ mentioned: true })]);
  assert.deepEqual(expectedRowText(e, 'ar', trOf('ar')), { text: 'متوقع: 12 كرتون بيض المراعي', mentioned: true });
  assert.equal(expectedRowText(e, 'en', en)?.text, 'Expected: 12 كرتون بيض المراعي');
  assert.equal(expectedRowText(expOf([prod({ qty: 0.5, low: 0.4, high: 0.7 })]), 'fr', trOf('fr'))?.text, 'Prévu : 0,5 كرتون بيض المراعي', 'الكسر بفاصلة الفرنسية');
  assert.equal(expectedRowText(expOf([prod({ qty: null, low: null, high: null, reason: 'NO_ANCHOR' })]), 'ar', trOf('ar')), null);
  assert.equal(expectedRowText(undefined, 'ar', trOf('ar')), null, 'جلسة محفوظة قبل الميزة');
  // بلا إشارة تخصّ المحل (المسح بالمفتاح الرسمي بلا تقييمات): الرقم حجم الطلب المعتاد نفسه لكل المحلات ⇒ لا سطر
  const bare = expOf([prod({})], { rating: null, ratingCount: null, trafficPct: null, reviewsRead: false, reviews: 0, mentions: [], talk: [] });
  assert.equal(expectedRowText(bare, 'ar', trOf('ar')), null);
  assert.ok(expectedRowText({ ...bare, basis: { ...bare.basis, rating: 4.1 } }, 'ar', trOf('ar')), 'التقييم وحده إشارة');
  assert.ok(expectedRowText({ ...bare, basis: { ...bare.basis, reviewsRead: true } }, 'ar', trOf('ar')), 'المراجعات المقروءة إشارة');
});

test('الطلب المتوقع: الكمية والمدى بأرقام لغة المندوب، والمدى المتساوي لا يُعرض', () => {
  assert.equal(fmtQty(12, 'ar'), '12');
  assert.equal(fmtQty(1.5, 'tr'), '1,5');
  assert.equal(expectedQtyText(prod({}), 'ar', trOf('ar')), '12 كرتون');
  assert.equal(expectedQtyText(prod({ qty: null }), 'ar', trOf('ar')), '—');
  assert.equal(expectedRangeText(prod({}), 'ar'), '8–16');
  assert.equal(expectedRangeText(prod({ low: 1, high: 1 }), 'ar'), null);
  assert.equal(expectedRangeText(prod({ low: null }), 'ar'), null);
});

test('الطلب المتوقع: سطر الأساس — العربية نصّ الخادم، وغيرها من وقائعه (المقيّمون ومكانهم في المنطقة، التقييم، الذكر، الحديث)', () => {
  const b = basisOf();
  assert.equal(expectedBasisText(b, 'ar', trOf('ar')), b.text);
  assert.equal(expectedBasisText(b, 'en', en), '165 ratings (more than 80% of shops in the area) · rated 4.2 · “بيض المراعي” is mentioned in 2 reviews · Reviews mention crowds and high demand');
  assert.equal(expectedBasisText(basisOf({ trafficPct: 30, mentions: [], talk: [] }), 'en', en), '165 ratings (area median 40) · rated 4.2');
  assert.equal(expectedBasisText(basisOf({ ratingCount: null, rating: null, trafficPct: null, mentions: [], talk: [] }), 'fr', trOf('fr')), 'Nombre d’avis inconnu');
  assert.equal(expectedBasisText(basisOf({ trafficPct: null, rating: 4.5, mentions: [{ name: 'حليب', reviews: 1 }], talk: ['UNKNOWN_CODE'] }), 'fr', trOf('fr')),
    '165 avis · note 4,5 · « حليب » cité dans 1 avis', 'رمزٌ لا تعرفه الواجهة يُسقط');
  for (const lang of ['en', 'fr', 'tr', 'zh']) assert.doesNotMatch(expectedBasisText(basisOf({ mentions: [] }), lang, trOf(lang)), /[؀-ۿ]/, `بلا عربية: ${lang}`);
  assert.equal(expectedBasisText(null, 'en', en), '');
});

test('الطلب المتوقع: كل عبارات جداوله مترجمة باللغات الأربع، وجدول الحديث يطابق رموز الخادم', () => {
  assert.deepEqual(Object.keys(EXPECTED_TALK_TEXT), ['BUSY', 'VARIETY', 'SHORTAGE', 'NEGATIVE', 'CLOSING']);
  const all = [...Object.values(EXPECTED_TALK_TEXT), ...Object.values(EXPECTED_HINT_TEXT), ...Object.values(EXPECTED_SOURCE_TEXT), ...Object.values(CONFIDENCE_TEXT),
    'متوقع: {what}', 'مذكور في المراجعات', 'الطلب المتوقع من ملف المحل في Google', 'حجم الطلب المعتاد للصنف من فواتيرك × مؤشر المحل',
    'المراجعات النصية لم تُقرأ — تُقرأ حين يُضبط مفتاح Google الرسمي', 'المراجعات النصية لم تُقرأ الآن — أعد فتح المحل بعد قليل', 'لا رقم: لم يُبع هذا الصنف في فواتيرك مؤخراً'];
  for (const lang of ['en', 'fr', 'tr', 'zh']) for (const t of all) assert.notEqual(aiRepTranslate(lang, t), t, `بلا ترجمة ${lang}: ${t}`);
});
