// «الوحدة الرئيسية» §2.14 — services/baseConversions.ts نقيّ: سجلّ تحويلات وحدة أساس الصنف كما تقرؤه إعادة الرفع دون اتصال (D16).
//   • chainFrom: السلسلة من أساس الجهاز إلى الأساس الحالي (تحويلان، وتحويلٌ ثم إعادة تسمية، واسمٌ طويل يُقارَن بـbaseNameKey).
//   • conversionsSince: ما وقع بعد لحظة المستند، والهامش، وغياب الوقت.
//   • rebaseCandidates وpickByPrice (نوافذ لا تتداخل، والسعر الصفري ⇒ null) وpickByFactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_MATCH_TOL, PRODUCT_DISPLAY_ONLY_KEYS, REPLAY_CLOCK_MARGIN_MS, chainFrom, conversionsSince, pickByFactor, pickByPrice, rebaseCandidates,
  type BaseConversionRow,
} from '../services/baseConversions';

const at = (iso: string) => new Date(iso);
const row = (fromUnit: string, toUnit: string, factor: number, iso: string, fromUnitId: string | null = null): BaseConversionRow =>
  ({ fromUnit, toUnit, factor, fromUnitId, convertedAt: at(iso) });

// طبلية ⇒ كرتون (٥٠) ثم كرتون ⇒ قارورة (٢٤)
const TWO = [row('طبلية', 'كرتون', 50, '2026-10-01T08:00:00Z', 'u-pal'), row('كرتون', 'قارورة', 24, '2026-10-10T08:00:00Z', 'u-ct')];
// كرتون ⇒ قارورة (٢٤) ثم إعادة تسمية قارورة ⇒ عبوة (١)
const RENAMED = [row('كرتون', 'قارورة', 24, '2026-10-10T08:00:00Z', 'u-ct'), row('قارورة', 'عبوة', 1, '2026-10-12T08:00:00Z')];

test('الثوابت: هامش الساعة عشر دقائق ونافذة السعر ±٢٥٪، ومفاتيح العرض التي تُسقطها حمولة ERP', () => {
  assert.equal(REPLAY_CLOCK_MARGIN_MS, 10 * 60_000);
  assert.equal(PRICE_MATCH_TOL, 0.25);
  assert.deepEqual([...PRODUCT_DISPLAY_ONLY_KEYS], ['primaryUnitId', 'baseConvertedAt']);
});

test('chainFrom: سلسلة تحويلين، ومن منتصفها، وتحويلٌ ثم إعادة تسمية — والسجلّ بأيّ ترتيب', () => {
  const full = chainFrom(TWO, 'طبلية', 'قارورة');
  assert.equal(full?.factor, 1200);
  assert.equal(full?.first.fromUnitId, 'u-pal');
  const mid = chainFrom([...TWO].reverse(), 'كرتون', 'قارورة');
  assert.equal(mid?.factor, 24);
  assert.equal(mid?.first.fromUnit, 'كرتون');
  const ren = chainFrom(RENAMED, 'كرتون', 'عبوة');
  assert.equal(ren?.factor, 24, 'إعادة التسمية (معامل ١) تُبقي السلسلة متّصلة');
  assert.equal(chainFrom(RENAMED, 'قارورة', 'عبوة')?.factor, 1, 'أساسٌ بين التحويل وإعادة التسمية: الأساس نفسه باسمٍ آخر');
});

test('chainFrom: لا سلسلة ⇒ null — أساسٌ مجهول، أو سلسلةٌ لا تصل الأساس الحالي، أو أساس الجهاز فارغ', () => {
  assert.equal(chainFrom(TWO, 'علبة', 'قارورة'), null);
  assert.equal(chainFrom(TWO, 'طبلية', 'عبوة'), null, 'آخر صفٍّ لا ينتهي بالأساس الحالي');
  assert.equal(chainFrom(TWO, '', 'قارورة'), null);
  assert.equal(chainFrom([], 'كرتون', 'قارورة'), null);
});

test('chainFrom وrebaseCandidates: المقارنة بـbaseNameKey على الطرفين (قصّ الأطراف وأول ٦٤ حرفاً)', () => {
  const long = 'ك'.repeat(80);
  const rows = [row(long, 'قارورة', 24, '2026-10-10T08:00:00Z')];
  assert.equal(chainFrom(rows, ` ${long.slice(0, 64)} `, ' قارورة')?.factor, 24);
  assert.deepEqual(rebaseCandidates(rows, 'قارورة ').map(c => c.factor), [1, 24]);
});

test('conversionsSince: ما بعد لحظة المستند متّصلاً حتى الأساس الحالي، وإعادة التسمية وحدها لا تعيد الأساس', () => {
  const before = conversionsSince(TWO, at('2026-09-30T08:00:00Z'), 'قارورة');
  assert.deepEqual([before.kind, before.kind === 'rebase' && before.factor], ['rebase', 1200]);
  const between = conversionsSince(TWO, at('2026-10-05T08:00:00Z'), 'قارورة');
  assert.deepEqual([between.kind, between.kind === 'rebase' && between.factor, between.kind === 'rebase' && between.first.fromUnit], ['rebase', 24, 'كرتون']);
  assert.equal(conversionsSince(TWO, at('2026-10-20T08:00:00Z'), 'قارورة').kind, 'none');
  assert.equal(conversionsSince(RENAMED, at('2026-10-11T08:00:00Z'), 'عبوة').kind, 'none', 'بعد التحويل وقبل إعادة التسمية: الأساس نفسه');
});

test('conversionsSince: الهامش حول التحويل (لا حول إعادة التسمية)، وغياب الوقت ⇒ none مع nearConversion', () => {
  const near = conversionsSince(TWO, at('2026-10-10T08:05:00Z'), 'قارورة');
  assert.equal(near.nearConversion, true);
  const far = conversionsSince(TWO, at('2026-10-10T09:00:00Z'), 'قارورة');
  assert.equal(far.nearConversion, false);
  assert.equal(conversionsSince(RENAMED, at('2026-10-12T08:01:00Z'), 'عبوة').nearConversion, false, 'إعادة التسمية ليست تحويلاً');
  assert.equal(conversionsSince(TWO, at('2026-10-10T08:30:00Z'), 'قارورة', 60 * 60_000).nearConversion, true, 'هامشٌ ممرَّر');
  assert.deepEqual(conversionsSince(TWO, null, 'قارورة'), { kind: 'none', nearConversion: true });
  assert.deepEqual(conversionsSince(TWO, new Date('x'), 'قارورة'), { kind: 'none', nearConversion: true });
});

test('rebaseCandidates: «بعد» بمعامل ١ ثم «قبل كل تحويلٍ لاحق» بحاصل ضرب ما بعده — وإعادة التسمية لا تصنع مرشّحاً', () => {
  assert.deepEqual(rebaseCandidates(TWO, 'قارورة').map(c => [c.factor, c.first?.fromUnit ?? null]), [[1, null], [24, 'كرتون'], [1200, 'طبلية']]);
  assert.deepEqual(rebaseCandidates(RENAMED, 'عبوة').map(c => c.factor), [1, 24]);
  assert.deepEqual(rebaseCandidates(TWO, 'علبة').map(c => c.factor), [1], 'سلسلةٌ لا تصل الأساس الحالي');
});

test('pickByPrice: مرشّحٌ واحد ضمن ±٢٥٪ — والنوافذ لا تتداخل لأن كل معامل ≥ ٢، والسعر الصفري أو المرجع الغائب ⇒ null', () => {
  const cands = rebaseCandidates(TWO, 'قارورة');
  const ref = (c: { factor: number }) => 2 * c.factor; // قارورة بـ٢، كرتون ٤٨، طبلية ٢٤٠٠
  assert.equal(pickByPrice(48, cands, ref)?.factor, 24);
  assert.equal(pickByPrice(59.9, cands, ref)?.factor, 24, 'داخل +٢٥٪');
  assert.equal(pickByPrice(2.4, cands, ref)?.factor, 1);
  assert.equal(pickByPrice(2400, cands, ref)?.factor, 1200);
  assert.equal(pickByPrice(10, cands, ref), null, 'بين النافذتين');
  assert.equal(pickByPrice(0, cands, ref), null, 'سعرٌ صفري');
  assert.equal(pickByPrice(-5, cands, ref), null);
  assert.equal(pickByPrice(48, cands, () => null), null, 'لا مرجع');
  assert.equal(pickByPrice(48, cands, () => 0), null, 'مرجعٌ صفري');
  // نافذتان متداخلتان (مرجعان متقاربان صناعياً) ⇒ لا حسم
  assert.equal(pickByPrice(10, [{ factor: 1 }, { factor: 2 }], (c) => (c.factor === 1 ? 10 : 11)), null);
});

test('pickByFactor: devFactor × معامل المرشّح = المعامل الحالي للوحدة بالاسم، وواحدٌ فقط', () => {
  const cands = rebaseCandidates(TWO, 'قارورة');
  assert.equal(pickByFactor(1, 24, cands)?.factor, 24, 'كرتونٌ كان أساساً: «١» صار ٢٤');
  assert.equal(pickByFactor(24, 24, cands)?.factor, 1, 'لقطةٌ من بعد التحويل: لا ضرب ثانٍ');
  assert.equal(pickByFactor(50, 1200, cands)?.factor, 24, 'طبلية الجهاز ٥٠ كرتوناً ⇒ ١٢٠٠ قارورة');
  assert.equal(pickByFactor(7, 24, cands), null);
  assert.equal(pickByFactor(1, null, cands), null, 'لا وحدة بالاسم الآن');
  assert.equal(pickByFactor(0, 24, cands), null);
});
