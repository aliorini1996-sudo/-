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
