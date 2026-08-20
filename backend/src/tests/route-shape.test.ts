/**
 * محرك شكل خط السير — `buildRouteShape` وأدواته الهندسية.
 *
 * الخلل الذي يحرسه: كنا نمرر نقاط اليوم كلها إلى مطابقة المسارات، وهي ترفض
 * الطلب **برمته** إذا تباعد زوج نقاط أكثر من ٢ كم (400 breakage distance) —
 * وهو حال أغلب الأيام لأن المتصفح لا يلتقط موقعا والتطبيق مغلق. فيسقط النظام
 * على النقاط الخام ويرسم خطوطا مستقيمة فوق البحر والمباني (بلاغ المالك بالصورة).
 *
 * الاعتمادات تحقن، فالمنطق كله يختبر بلا شبكة ولا مفاتيح.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildRouteShape, splitRuns, haversineM, pathMeters, thinWaypoints, prepare,
  BREAK_M, MIN_MATCH_POINTS, MIN_MATCH_EXTENT_M, planSlots, type ShapePoint, type LatLng,
} from '../services/routeShape';

// نقاط حقيقية من المنطقة الشرقية (حيث ظهر البلاغ)
const QATIF = { lat: 26.5196, lng: 49.9962 };
const DAMMAM = { lat: 26.4207, lng: 50.0888 };
const KHOBAR = { lat: 26.2794, lng: 50.2083 };

/** نقطة على بعد `m` مترا شمالا تقريبا */
const north = (p: LatLng, m: number): LatLng => ({ lat: p.lat + m / 111320, lng: p.lng });
const at = (p: LatLng, sec: number): ShapePoint => ({ ...p, capturedAt: new Date(1770000000000 + sec * 1000) });

/** أثر كثيف: `n` نقطة متتالية بفارق ٣٠ مترا (قيادة داخل حي) */
const denseRun = (start: LatLng, n: number, t0 = 0): ShapePoint[] =>
  Array.from({ length: n }, (_, i) => at(north(start, i * 45), t0 + i * 8));

// اعتمادات مزيفة: تعيد خطوطا يمكن تمييزها، وتحصي النداءات
function fakeDeps(opts: { matchFails?: boolean; routeFails?: boolean; maxCalls?: number } = {}) {
  const calls = { match: 0, route: 0 };
  return {
    calls,
    deps: {
      maxCalls: opts.maxCalls,
      match: async (pts: ShapePoint[]) => {
        calls.match++;
        if (opts.matchFails) return null;
        // «مطابقة»: نضيف نقطة وسطية لتمييز الناتج عن الخام
        return [{ lat: pts[0].lat, lng: pts[0].lng }, { lat: 0.111, lng: 0.111 },
                { lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng }];
      },
      route: async (wps: LatLng[]) => {
        calls.route++;
        if (opts.routeFails) return null;
        return [wps[0], { lat: 0.222, lng: 0.222 }, wps[wps.length - 1]];
      },
    },
  };
}

/* ───────────────── الأدوات الهندسية ───────────────── */

test('هافرساين يقيس مسافة معلومة بدقة معقولة', () => {
  // القطيف ← الخبر ≈ ٣٠ كم بخط مستقيم
  const km = haversineM(QATIF, KHOBAR) / 1000;
  assert.ok(km > 25 && km < 35, `المسافة ${km.toFixed(1)} كم خارج المتوقع`);
  assert.equal(Math.round(haversineM(DAMMAM, DAMMAM)), 0);
});

test('القسمة تفصل عند تجاوز حد التباعد وحده', () => {
  const pts = [QATIF, DAMMAM, KHOBAR].map((p, i) => at(p, i * 600));
  assert.equal(splitRuns(pts).length, 3, 'ثلاث نقاط متباعدة ⇒ ثلاث جريات');

  const close = [DAMMAM, north(DAMMAM, 300), north(DAMMAM, 600)].map((p, i) => at(p, i * 8));
  assert.equal(splitRuns(close).length, 1, 'نقاط متقاربة ⇒ جرية واحدة');
});

test('حد القسمة دون سقف المزود الصلب (٢٠٠٠م)', () => {
  assert.ok(BREAK_M < 2000, 'تجاوز الحد يفشل الطلب كاملا لا المقطع وحده');
  const justOver = [DAMMAM, north(DAMMAM, BREAK_M + 50)].map((p, i) => at(p, i * 60));
  assert.equal(splitRuns(justOver).length, 2);
  const justUnder = [DAMMAM, north(DAMMAM, BREAK_M - 50)].map((p, i) => at(p, i * 60));
  assert.equal(splitRuns(justUnder).length, 1);
});

test('تخفيف المحطات يحفظ الطرفين', () => {
  const wps = Array.from({ length: 40 }, (_, i) => ({ lat: i, lng: i }));
  const thin = thinWaypoints(wps, 10);
  assert.equal(thin.length, 10);
  assert.deepEqual(thin[0], wps[0]);
  assert.deepEqual(thin[thin.length - 1], wps[wps.length - 1]);
});

test('التحضير يرتب زمنيا ويسقط الدقة الرديئة ويدمج الوقفة', () => {
  const pts: ShapePoint[] = [
    { ...north(DAMMAM, 60), capturedAt: new Date(3000), accuracy: 10 },
    { ...DAMMAM, capturedAt: new Date(1000), accuracy: 10 },
    { ...north(DAMMAM, 2), capturedAt: new Date(2000), accuracy: 10 },   // حركة مترين = وقفة
    { ...north(DAMMAM, 5000), capturedAt: new Date(2500), accuracy: 900 }, // دقة رديئة
  ];
  const out = prepare(pts);
  assert.equal(out.length, 2, 'تبقى نقطتان: البداية والحركة الحقيقية');
  assert.equal(out[0].capturedAt, pts[1].capturedAt, 'الأقدم أولا');
});

test('كل النقاط رديئة الدقة ⇒ نستعملها بدل إفراغ المسار', () => {
  const pts: ShapePoint[] = [
    { ...DAMMAM, capturedAt: new Date(1000), accuracy: 900 },
    { ...north(DAMMAM, 400), capturedAt: new Date(2000), accuracy: 900 },
  ];
  assert.equal(prepare(pts).length, 2);
});

/* ───────────────── المحرك ───────────────── */

test('السيناريو المبلغ عنه: ثلاث وقفات متباعدة ⇒ مسار مرجح لا خط مستقيم', async () => {
  const { deps, calls } = fakeDeps();
  const pts = [QATIF, DAMMAM, KHOBAR].map((p, i) => at(p, i * 900));
  const shape = await buildRouteShape(pts, deps);

  assert.equal(calls.match, 0, 'لا مطابقة على نقاط متباعدة — كانت تفشل الطلب');
  assert.equal(calls.route, 1, 'نداء توجيه واحد يغطي اليوم كله');
  assert.equal(shape.segments.length, 1);
  assert.equal(shape.segments[0].kind, 'inferred', 'مرجح — لم نرصد الطريق');
  assert.ok(shape.segments[0].points.some(p => p.lat === 0.222), 'الخط من محرك التوجيه لا خاما');
  assert.equal(shape.observedMeters, 0);
  assert.ok(shape.inferredMeters > 0);
});

test('أثر كثيف ⇒ مطابقة ووسم «مرصود»', async () => {
  const { deps, calls } = fakeDeps();
  const shape = await buildRouteShape(denseRun(DAMMAM, 10), deps);

  assert.equal(calls.match, 1);
  assert.equal(calls.route, 0);
  assert.equal(shape.segments.length, 1);
  assert.equal(shape.segments[0].kind, 'observed');
  assert.ok(shape.segments[0].points.some(p => p.lat === 0.111), 'من المطابقة');
  assert.ok(shape.observedMeters > 0);
  assert.equal(shape.inferredMeters, 0);
});

test('يوم مختلط: أثر كثيف ثم انتقال بعيد ثم أثر كثيف', async () => {
  const { deps, calls } = fakeDeps();
  const pts = [...denseRun(DAMMAM, 8, 0), ...denseRun(KHOBAR, 8, 2000)];
  const shape = await buildRouteShape(pts, deps);

  assert.equal(calls.match, 2, 'مطابقة لكل جرية كثيفة');
  assert.equal(calls.route, 1, 'وتوجيه للفراغ بينهما');
  assert.deepEqual(shape.segments.map(s => s.kind), ['observed', 'inferred', 'observed'],
    'الترتيب الزمني محفوظ: مرصود ← مرجح ← مرصود');
  assert.ok(shape.observedMeters > 0 && shape.inferredMeters > 0);
});

test('فشل التوجيه ⇒ خط مستقيم موسوم **مرجحا** لا مرصودا', async () => {
  const { deps } = fakeDeps({ routeFails: true });
  const shape = await buildRouteShape([QATIF, DAMMAM, KHOBAR].map((p, i) => at(p, i * 900)), deps);

  assert.equal(shape.segments.length, 1);
  assert.equal(shape.segments[0].kind, 'inferred',
    'التخمين يبقى تخمينا حتى حين يفشل المحرك — وسمه مرصودا كذب على المشرف');
});

test('فشل المطابقة ⇒ **raw** لا «مرصود» — ولا يدخل عداد المرصود', async () => {
  const { deps } = fakeDeps({ matchFails: true });
  const shape = await buildRouteShape(denseRun(DAMMAM, 20), deps);
  assert.equal(shape.segments[0].kind, 'raw',
    'وسم الخط المستقيم «مرصودا» يصبغ التخمين بلون الدليل — وهو عين العلة');
  assert.equal(shape.observedMeters, 0);
  assert.ok(shape.rawMeters > 0);
  assert.ok(!shape.segments[0].points.some(p => p.lat === 0.111));
});

test('تعذر المزود كليا (لا مفتاح/حصة منتهية) ⇒ degraded=true', async () => {
  const { deps } = fakeDeps({ matchFails: true, routeFails: true });
  const pts = [...denseRun(DAMMAM, 20, 0), ...denseRun(KHOBAR, 20, 3000)];
  const shape = await buildRouteShape(pts, deps);
  assert.equal(shape.degraded, true, 'ما يعرض خطوط مستقيمة — لا تصفه اللوحة بالطرق');
  assert.equal(shape.observedMeters, 0);
});

test('نجاح واحد على الأقل ⇒ ليس degraded', async () => {
  const { deps } = fakeDeps();
  const shape = await buildRouteShape(denseRun(DAMMAM, 20), deps);
  assert.equal(shape.degraded, false);
});

test('عنقود تذبذب عند عميل (امتداده ~صفر) لا يبتلع نداء مطابقة', async () => {
  const { deps, calls } = fakeDeps();
  // ٨ نقاط داخل ٦٠ مترا = وقوف لا طريق
  const jitter = Array.from({ length: 8 }, (_, i) => at(north(DAMMAM, i * 8), i * 8));
  const shape = await buildRouteShape([...jitter, at(KHOBAR, 3000)], deps);
  assert.ok(MIN_MATCH_EXTENT_M > 60, 'حد الامتداد فوق تذبذب الوقوف');
  assert.equal(calls.match, 0, 'لا مطابقة لعنقود واقف');
  assert.equal(calls.route, 1, 'والنداء يذهب للجسر الطويل');
  assert.ok(shape.segments.some(sg => sg.kind === 'inferred'));
});

test('الميزانية تنفق على الأطول امتدادا لا على الأسبق زمنيا', async () => {
  const seen: number[] = [];
  const deps = {
    maxCalls: 1,
    match: async () => null,
    route: async (wps: LatLng[]) => { seen.push(Math.round(haversineM(wps[0], wps[wps.length - 1]))); return null; },
  };
  // وقفة قريبة أولا (٣ كم) ثم انتقال بعيد (~٣٠ كم): النداء الوحيد للأبعد
  const near = { lat: DAMMAM.lat + 0.027, lng: DAMMAM.lng };
  const pts = [at(DAMMAM, 0), at(near, 600), at(KHOBAR, 3000)];
  await buildRouteShape(pts, deps);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] > 10000, `أنفق النداء على مقطع ${seen[0]}م — يجب أن يكون الأطول`);
});

test('عنقود الوقوف لا يغرق محطات التوجيه فيزيح الوقفات البعيدة', () => {
  // ثلاث وقفات، أولاها بعشرين تثبيتا متلاصقا (وقوف داخل محل)
  const jitter = Array.from({ length: 20 }, (_, i) => at(north(QATIF, i * 14), i * 8));
  const slots = planSlots(prepare([...jitter, at(DAMMAM, 3000), at(KHOBAR, 6000)]));
  const routeSlot = slots.find(sl => sl.type === 'route');
  assert.ok(routeSlot && routeSlot.type === 'route');
  const wps = thinWaypoints((routeSlot as { wps: ShapePoint[] }).wps);
  // لو دفع العنقود كله لبقيت الوقفتان البعيدتان مهددتين بالقص
  assert.ok(wps.length <= 4, `محطات كثيرة (${wps.length}) — العنقود أغرق القائمة`);
  const far = wps.filter(w => haversineM(w, QATIF) > 5000);
  assert.equal(far.length, 2, 'الوقفتان البعيدتان محفوظتان');
});

test('التخطيط لا يستدعي شبكة ويحفظ الترتيب الزمني', () => {
  const pts = [...denseRun(DAMMAM, 8, 0), at(KHOBAR, 3000)];
  const slots = planSlots(pts);
  assert.ok(slots.length >= 2);
  assert.equal(slots[0].type, 'match');
  assert.equal(slots[slots.length - 1].type, 'route');
});

test('سقف النداءات يحترم ويعلن ولا يبتلع', async () => {
  const { deps, calls } = fakeDeps({ maxCalls: 1 });
  const pts = [...denseRun(QATIF, 20, 0), ...denseRun(DAMMAM, 20, 2000), ...denseRun(KHOBAR, 20, 4000)];
  const shape = await buildRouteShape(pts, deps);

  assert.equal(calls.match + calls.route, 1, 'لم يتجاوز السقف');
  assert.equal(shape.truncated, true, 'ويعلن أن مقاطع بقيت خاما');
  assert.ok(shape.segments.length >= 3, 'ومع ذلك يرسم اليوم كله');
});

test('عدد النقاط الصفر أو الواحدة لا يرمي', async () => {
  const { deps } = fakeDeps();
  const none = await buildRouteShape([], deps);
  assert.deepEqual(none.segments, []);
  assert.equal(none.degraded, true);

  const one = await buildRouteShape([at(DAMMAM, 0)], deps);
  assert.equal(one.segments.length, 1);
  assert.equal(one.segments[0].points.length, 1);
});

test('المسافة المحسوبة = مجموع مقاطعها', async () => {
  const { deps } = fakeDeps();
  const pts = [...denseRun(DAMMAM, 8, 0), ...denseRun(KHOBAR, 8, 2000)];
  const shape = await buildRouteShape(pts, deps);
  const sum = shape.segments.reduce((a, s) => a + s.meters, 0);
  assert.equal(sum, shape.observedMeters + shape.inferredMeters);
  for (const s of shape.segments) assert.equal(s.meters, pathMeters(s.points));
});

test('جرية قصيرة (دون حد المطابقة) تصير محطات توجيه لا مقطعا مرصودا', async () => {
  const { deps, calls } = fakeDeps();
  // جريتان: كثيفة ثم قصيرة متباعدة (نقطتان)
  const short = [at(KHOBAR, 3000), at(north(KHOBAR, 200), 3060)];
  const shape = await buildRouteShape([...denseRun(DAMMAM, 8, 0), ...short], deps);

  assert.ok(MIN_MATCH_POINTS > short.length, 'الجرية القصيرة دون حد المطابقة');
  assert.equal(calls.match, 1, 'المطابقة للكثيفة وحدها');
  assert.deepEqual(shape.segments.map(s => s.kind), ['observed', 'inferred']);
});
