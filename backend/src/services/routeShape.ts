/**
 * بناء «شكل خطّ السير» — يحوّل نقاط GPS المتفرّقة إلى مسارٍ يتبع الشوارع.
 *
 * ══════════ لماذا كان الخطّ مستقيماً فوق البحر والمباني ══════════
 * كنّا نمرّر نقاط اليوم كلّها إلى مطابقة المسارات (Map Matching) في Geoapify.
 * وهي **ترفض الطلب كاملاً** إذا تباعدت نقطتان متتاليتان أكثر من ٢ كم:
 *     400 — "Exceeded breakage distance for all pairs: 2000 meters"
 * فيسقط النظام على النقاط الخام، ويرسم الخطّ بينها مستقيماً.
 *
 * والتباعد هو **الحالة الطبيعية** لا الاستثناء: المتصفّح لا يمنح موقعاً إلا
 * والتطبيق مفتوح في المقدّمة، والمندوب يقود وهاتفه في جيبه — فلا نلتقط شيئاً
 * بين عميلٍ وآخر. النتيجة: نقطة عند كل وقفة، وعشرات الكيلومترات بينها فراغ.
 *
 * ══════════ الحلّ: محرّكان لا واحد ══════════
 * • **المطابقة** (mapmatching) تصلح للأثر الكثيف: تُلصق نقاطاً متقاربة بالشارع
 *   الذي مرّ عليه المندوب فعلاً. نستعملها للمقاطع المتقاربة وحدها.
 * • **التوجيه** (routing) يصلح للفراغات: يُعيد بناء الطريق الأرجح بين نقطتين
 *   متباعدتين. اختُبر على القطيف→الدمام→الخبر فأعاد ٣٩٥ نقطة على الطرق (٥٠ كم).
 *
 * ══════════ وأمانة العرض شرطٌ لا تحسين ══════════
 * المقطع المُعاد بناؤه **ليس أثراً مرصوداً**؛ هو أرجحُ طريقٍ بين نقطتين. رسمُه
 * خطاً متصلاً كالأثر الحقيقي يقول للمشرف «هذا ما سلكه» ونحن لا نعلم — وقد
 * يُبنى على ذلك اتّهامُ مندوبٍ بالانحراف عن مساره. لذلك يخرج كل مقطع موسوماً:
 *   observed = أثرٌ مرصود (نقاط GPS مطابَقة)
 *   inferred = مسارٌ مُرجَّح (أعاده محرّك التوجيه بين نقطتين متباعدتين)
 * والواجهة ترسم الأول متصلاً والثاني متقطّعاً، وتُعلن كم كيلومتراً من كلٍّ.
 */

export interface ShapePoint { lat: number; lng: number; accuracy?: number | null; capturedAt?: Date | string }
export interface LatLng { lat: number; lng: number }

/**
 * `observed` أثرُ GPS مطابَقٌ للشوارع — دليل.
 * `inferred` طريقٌ أعاده محرّك التوجيه بين تثبيتين متباعدين — ترجيح على شارع.
 * `raw`      تثبيتاتُ GPS حقيقية موصولةٌ بخطوط مستقيمة (تعذّرت المطابقة) —
 *            أثرٌ حقيقي بشكلٍ تقريبيّ. **لا يجوز وسمُه `observed`**: كان ذلك
 *            يُعيد الخطّ المستقيم فوق البحر مُصدَّقاً بلون الدليل وبعدّاد
 *            «مسار مرصود» — وهو عين العلّة التي بُني هذا الملف لإزالتها.
 */
export type SegmentKind = 'observed' | 'inferred' | 'raw';
export interface RouteSegment {
  kind: SegmentKind;
  points: LatLng[];
  /** طول المقطع بالأمتار (على الخطّ المرسوم) */
  meters: number;
}
export interface RouteShape {
  segments: RouteSegment[];
  observedMeters: number;
  inferredMeters: number;
  rawMeters: number;
  /** بلغنا سقف نداءات المزوّد فبقيت مقاطع خاماً — يُعلَن ولا يُبتلع */
  truncated: boolean;
  /**
   * حاولنا ولم ينجح **أيّ** نداء (لا مفتاح · حصّة منتهية · انقطاع) ⇒ ما تراه
   * خطوطٌ مستقيمة لا مسارُ شوارع. كان هذا العلم لا يُرفع إلا حين تغيب النقاط،
   * فكانت اللوحة تعرض خطوط البحر وتصفها بالطرق.
   */
  degraded: boolean;
}

/**
 * أقصى تباعدٍ تقبله المطابقة (٢٠٠٠م حدّ Geoapify الصلب). نقطع عند ١٥٠٠م
 * بهامش أمان: قياسُنا للمسافة تقريبيّ وقياسُهم قد يختلف قليلاً، وتجاوزُ الحدّ
 * يُفشل الطلب **كاملاً** لا المقطع وحده — فالتحفّظ هنا أرخص من الخسارة.
 */
export const BREAK_M = 1500;
/** أقلّ عدد نقاط تستحقّ مطابقة: ثلاثٌ أو أقلّ لا تصف شكل طريق */
export const MIN_MATCH_POINTS = 4;
/** سقف محطات نداء التوجيه الواحد (اختُبر ١٦ بنجاح؛ نبقى دونه) */
export const MAX_BRIDGE_WAYPOINTS = 14;

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** المسافة بين نقطتين بالأمتار (هافرساين) */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** طول خطٍّ متعدّد النقاط بالأمتار */
export function pathMeters(pts: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversineM(pts[i - 1], pts[i]);
  return Math.round(m);
}

/**
 * يقسّم النقاط إلى «جَرَيات» متقاربة: تبدأ جَرْيةٌ جديدة كلّما تجاوز التباعد
 * `breakM`. كل جَرْية صالحة للمطابقة وحدها، والفجوات بينها تُعاد بالتوجيه.
 */
export function splitRuns<T extends LatLng>(points: T[], breakM = BREAK_M): T[][] {
  if (!points.length) return [];
  const runs: T[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1], points[i]);
    if (d > breakM) runs.push([points[i]]);
    else runs[runs.length - 1].push(points[i]);
  }
  return runs;
}

/** يخفّف قائمة المحطات مع الحفاظ على الطرفين (سقف مزوّد التوجيه) */
export function thinWaypoints<T>(wps: T[], max = MAX_BRIDGE_WAYPOINTS): T[] {
  if (wps.length <= max) return wps;
  const out: T[] = [];
  const step = (wps.length - 1) / (max - 1);
  for (let i = 0; i < max - 1; i++) out.push(wps[Math.round(i * step)]);
  out.push(wps[wps.length - 1]);
  return out;
}

/** ترتيب زمنيّ + إسقاط النقاط رديئة الدقّة + دمج المتلاصقة (وقفةٌ لا حركة) */
export function prepare(points: ShapePoint[], maxAccuracyM = 150, minMoveM = 12): ShapePoint[] {
  const sorted = [...points].sort((a, b) => {
    const ta = a.capturedAt ? new Date(a.capturedAt).getTime() : 0;
    const tb = b.capturedAt ? new Date(b.capturedAt).getTime() : 0;
    return ta - tb;
  });
  // الدقّة السيّئة تُبعد النقطة عن الشارع فتُفسد المطابقة — لكن لا نُفرغ
  // القائمة: إن كانت كل النقاط رديئة فهي كلّ ما نملك.
  const accurate = sorted.filter((p) => p.accuracy == null || p.accuracy <= maxAccuracyM);
  const base = accurate.length >= 2 ? accurate : sorted;

  const out: ShapePoint[] = [];
  for (const p of base) {
    const last = out[out.length - 1];
    if (!last || haversineM(last, p) >= minMoveM) out.push(p);
  }
  // نقطة الوقوف الأخيرة مهمّة (نهاية اليوم) — نُعيدها إن أُسقطت
  const lastSrc = base[base.length - 1];
  if (lastSrc && out[out.length - 1] !== lastSrc) out.push(lastSrc);
  return out;
}

export interface ShapeDeps {
  /** مطابقة أثر كثيف مع الشوارع — null عند التعذّر */
  match: (pts: ShapePoint[]) => Promise<LatLng[] | null>;
  /** إعادة بناء الطريق بين محطات متباعدة — null عند التعذّر */
  route: (wps: LatLng[]) => Promise<LatLng[] | null>;
  /** سقف نداءات المزوّد لهذا الطلب (حماية الحصّة وزمن الاستجابة) */
  maxCalls?: number;
}

/** امتداد جغرافيّ لا يستحقّ مطابقة: تذبذبُ GPS واقفاً عند عميل، لا طريق */
export const MIN_MATCH_EXTENT_M = 200;

type Slot =
  | { type: 'match'; pts: ShapePoint[]; extent: number; line?: LatLng[] | null; funded?: boolean }
  | { type: 'route'; wps: ShapePoint[]; extent: number; line?: LatLng[] | null; funded?: boolean };

/**
 * يخطّط عمل اليوم مقاطعَ مرتّبة زمنياً — **بلا أي نداء شبكة**.
 * فصلُ التخطيط عن التنفيذ هو ما يتيح إنفاق الميزانية على الأهمّ لا على الأسبق.
 */
export function planSlots(pts: ShapePoint[]): Slot[] {
  const slots: Slot[] = [];
  const span = (a: LatLng[] | ShapePoint[]) =>
    a.length < 2 ? 0 : Math.round(haversineM(a[0], a[a.length - 1]));

  let bridge: ShapePoint[] = [];
  const flush = (nextAnchor?: ShapePoint) => {
    const wps = nextAnchor ? [...bridge, nextAnchor] : [...bridge];
    bridge = [];
    if (wps.length >= 2) slots.push({ type: 'route', wps, extent: span(wps) });
  };

  for (const run of splitRuns(pts)) {
    // جَرْية «كثيفة» = عدد كافٍ **وامتداد حقيقي**. بلا شرط الامتداد كان عنقودُ
    // تذبذبٍ عند عميل (امتداده ~صفر) يبتلع نداء مطابقة كاملاً، فيُحرم منه جسرٌ
    // طوله ثلاثون كيلومتراً فيُرسم مستقيماً — أي عودةُ العلّة بعينها.
    if (run.length >= MIN_MATCH_POINTS && span(run) >= MIN_MATCH_EXTENT_M) {
      flush(run[0]);
      slots.push({ type: 'match', pts: run, extent: span(run) });
      bridge = [run[run.length - 1]];
    } else {
      bridge.push(...run);
    }
  }
  flush();
  return slots;
}

/**
 * يبني المسار النهائي مقاطعَ موسومة. الاعتمادات تُحقن ⇒ المنطق يُختبر بلا شبكة.
 *
 * ثلاث مراحل: **خطّط** (بلا شبكة) ← **موّل** الأطول أولاً ← **نفّذ متوازياً**.
 * • التمويل بالامتداد لا بالترتيب الزمني: الميزانية محدودة، وإنفاقُها بالتسلسل
 *   كان يُطعم أوّل أربع وقفات ويترك بقيّة اليوم خطوطاً مستقيمة.
 * • والتوازي يجعل أسوأ زمنٍ مهلةَ نداءٍ واحد (~٨ث) لا مجموعَها (٦٤ث تعليقاً).
 */
export async function buildRouteShape(rawPoints: ShapePoint[], deps: ShapeDeps): Promise<RouteShape> {
  const pts = prepare(rawPoints);
  const plain = (p: ShapePoint): LatLng => ({ lat: p.lat, lng: p.lng });
  const base = { segments: [] as RouteSegment[], observedMeters: 0, inferredMeters: 0, rawMeters: 0, truncated: false, degraded: true };
  if (pts.length < 2) {
    return pts.length === 1
      ? { ...base, segments: [{ kind: 'raw', points: [plain(pts[0])], meters: 0 }] }
      : base;
  }

  const slots = planSlots(pts);
  const budget = deps.maxCalls ?? 10;

  // التمويل: الأطول امتداداً أولاً — هو الأظهر على الشاشة والأكثر تضليلاً لو تُرك مستقيماً
  const order = slots.map((_, i) => i).sort((a, b) => slots[b].extent - slots[a].extent);
  for (const i of order.slice(0, budget)) slots[i].funded = true;
  const truncated = slots.length > budget;

  await Promise.all(
    slots.filter((sl) => sl.funded).map(async (sl) => {
      try {
        sl.line = sl.type === 'match'
          ? await deps.match(sl.pts)
          : await deps.route(thinWaypoints(sl.wps).map(plain));
      } catch {
        sl.line = null; // اعتمادٌ يرمي لا يُسقط اليوم كلّه
      }
    }),
  );

  const attempted = slots.filter((sl) => sl.funded).length;
  const succeeded = slots.filter((sl) => sl.line && sl.line.length > 1).length;

  const segments: RouteSegment[] = [];
  for (const sl of slots) {
    const ok = sl.line && sl.line.length > 1;
    // فشلُ المطابقة يُنتج **raw** لا observed: تثبيتاتٌ حقيقية بخطوط مستقيمة
    // بينها. وسمُها «مرصودة» كان يُعيد الخطّ المستقيم مصبوغاً بلون الدليل.
    const kind: SegmentKind = sl.type === 'match' ? (ok ? 'observed' : 'raw') : 'inferred';
    const points = ok ? sl.line! : (sl.type === 'match' ? sl.pts.map(plain) : thinWaypoints(sl.wps).map(plain));
    if (points.length < 2) continue;
    segments.push({ kind, points, meters: pathMeters(points) });
  }

  const sum = (k: SegmentKind) => segments.filter((s2) => s2.kind === k).reduce((a, s2) => a + s2.meters, 0);
  return {
    segments,
    observedMeters: sum('observed'),
    inferredMeters: sum('inferred'),
    rawMeters: sum('raw'),
    truncated,
    // حاولنا ولم ينجح شيء ⇒ لا مزوّد فعليّاً: ما يُعرض خطوطٌ مستقيمة، فلا
    // تصفه اللوحة بالطرق. (كان العلم لا يُرفع إلا حين تغيب النقاط أصلاً.)
    degraded: attempted > 0 && succeeded === 0,
  };
}
