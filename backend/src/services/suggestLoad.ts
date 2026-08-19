/**
 * محرّك «كمية التحميل المقترحة» — دالّة **صرفة** بلا Prisma ولا شبكة.
 *
 * لماذا قواعد صريحة لا نموذج تعلّم: لا عميل لدينا يملك ستة أشهر من التاريخ،
 * وأي نموذج يحتاجها سيعرض فراغاً طوال التجربة العشرة أيام — وهي اللحظة التي
 * يُتّخذ فيها قرار الشراء. القواعد أدناه تعمل من الأسبوع الثاني، وكل رقم فيها
 * قابل للشرح بجملة واحدة. القابلية للشرح ليست ترفاً: اقتراح لا يُفسَّر يُرفض
 * أول مرّة يُخطئ فيها ولا يُستعمل بعدها.
 *
 * ────────────────────── القرار الأهمّ في الملف ──────────────────────
 * **الأيام الصفرية تُحتسب في المتوسط.**
 * إن باع الصنف ١٠٠ حبّة في أحدٍ واحد من أربعة آحاد، فمتوسط الأحد ٢٥ لا ١٠٠.
 * قسمة المجموع على «عدد الأيام التي حدث فيها بيع» بدل «عدد الأيام في النافذة»
 * هو الخطأ الذي ينفخ كل تنبّؤ ويملأ السيارة ببضاعة راكدة. الفرق أربعة أضعاف
 * في المثال أعلاه، ويكبر كلّما قلّ دوران الصنف.
 * ───────────────────────────────────────────────────────────────────
 *
 * وقاعدة ثانية: **لا اقتراح لصنف بلا تاريخ.** الصفر هنا معلومة صادقة، أمّا
 * رقم مُختلَق لصنف لم يُبَع قطّ فهو تخمين يُقدَّم كتوصية.
 */

export interface SaleRow {
  productId: string;
  qty: number;
  /** تاريخ الفاتورة — ISO أو أي صيغة يقبلها Date */
  date: string | Date;
}

export interface ProductRow {
  id: string;
  name: string;
  code: string;
  unit: string;
}

export interface SuggestInput {
  /** مبيعات المندوب المؤكَّدة داخل النافذة */
  sales: SaleRow[];
  /** مرتجعاته — تُخصم لأنها ليست طلباً حقيقياً */
  returns?: SaleRow[];
  /** ما في سيارته الآن (من computeStock) */
  onVan?: { productId: string; remaining: number }[];
  /** اليوم المستهدَف للتحميل */
  targetDate: string | Date;
  /** طول نافذة التاريخ بالأيام */
  windowDays?: number;
  /** هامش أمان % فوق المتوقّع */
  bufferPct?: number;
  products: ProductRow[];
}

export type Basis = 'weekday' | 'overall' | 'none';
export type Confidence = 'high' | 'medium' | 'low';

export interface SuggestRow extends ProductRow {
  /** الطلب المتوقّع لليوم قبل الهامش */
  expected: number;
  /** بعد الهامش */
  withBuffer: number;
  /** ما في السيارة الآن */
  onVan: number;
  /** الكمية المقترح تحميلها = withBuffer − onVan (لا تقلّ عن صفر) */
  suggested: number;
  basis: Basis;
  /** عدد الأيام التي دخلت المتوسط (شاملةً الصفرية) */
  sampleDays: number;
  /** عدد الأيام التي حدث فيها بيع فعلاً — للشفافية لا للحساب */
  activeDays: number;
  confidence: Confidence;
  why: string;
}

export interface SuggestResult {
  rows: SuggestRow[];
  meta: {
    targetDate: string;
    weekday: number;
    windowDays: number;
    bufferPct: number;
    /** عدد الأيام التي فيها بيانات فعلاً داخل النافذة */
    dataDays: number;
    /** أقدم تاريخ بيع وُجد — يبيّن عمر البيانات الحقيقي */
    oldestSale: string | null;
    /** تحذير يُعرض للمستخدم حين تكون البيانات أرقّ ممّا يُعتمد عليه */
    warning: string | null;
  };
}

const DAY_MS = 86400000;
const AR_WEEKDAY = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** مفتاح اليوم المحلّي 'YYYY-MM-DD' — التجميع باليوم لا بالطابع الزمني */
const dayKey = (d: string | Date): string => {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function suggestLoad(input: SuggestInput): SuggestResult {
  const windowDays = Math.max(7, Math.floor(num(input.windowDays) || 28));
  const bufferPct = Math.min(100, Math.max(0, num(input.bufferPct ?? 15)));
  const target = input.targetDate instanceof Date ? new Date(input.targetDate) : new Date(input.targetDate);
  const targetValid = !Number.isNaN(target.getTime());
  // تُصفَّر الساعة: النافذة أيام كاملة لا لحظات. وبها يُستثنى اليوم المستهدَف
  // نفسه من الحساب — نتنبّأ به لا نتعلّم منه.
  const raw = targetValid ? target : new Date();
  const end = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
  const start = new Date(end.getTime() - windowDays * DAY_MS);
  const weekday = end.getDay();

  // 1) صافي الطلب لكل صنف لكل يوم: المُباع − المرتجع
  const perProductDay = new Map<string, Map<string, number>>();
  const allDays = new Set<string>();
  let oldest: number | null = null;

  const add = (rows: SaleRow[] | undefined, sign: 1 | -1) => {
    for (const r of rows || []) {
      if (!r?.productId) continue;
      const t = r.date instanceof Date ? r.date : new Date(r.date);
      if (Number.isNaN(t.getTime())) continue;
      // `< end` لا `<=`: مبيعات اليوم المستهدَف نفسه خارج النافذة
      if (t.getTime() < start.getTime() || t.getTime() >= end.getTime()) continue;
      const k = dayKey(t);
      if (!k) continue;
      if (oldest === null || t.getTime() < oldest) oldest = t.getTime();
      allDays.add(k);
      if (!perProductDay.has(r.productId)) perProductDay.set(r.productId, new Map());
      const m = perProductDay.get(r.productId)!;
      m.set(k, (m.get(k) || 0) + sign * Math.abs(num(r.qty)));
    }
  };
  add(input.sales, 1);
  add(input.returns, -1);

  // 2) قوائم الأيام في النافذة — **كل** الأيام لا التي فيها بيع فقط
  const windowDayKeys: string[] = [];
  const weekdayKeys: string[] = [];
  for (let i = 1; i <= windowDays; i++) {
    const d = new Date(end.getTime() - i * DAY_MS);
    const k = dayKey(d);
    windowDayKeys.push(k);
    if (d.getDay() === weekday) weekdayKeys.push(k);
  }

  const onVanMap = new Map((input.onVan || []).map((v) => [v.productId, Math.max(0, num(v.remaining))]));
  const rows: SuggestRow[] = [];

  for (const p of input.products || []) {
    const days = perProductDay.get(p.id);
    const onVan = onVanMap.get(p.id) || 0;

    if (!days || days.size === 0) {
      rows.push({
        ...p, expected: 0, withBuffer: 0, onVan, suggested: 0,
        basis: 'none', sampleDays: 0, activeDays: 0, confidence: 'low',
        why: 'لا مبيعات لهذا الصنف خلال النافذة — لا اقتراح.',
      });
      continue;
    }

    /**
     * القصّ عند الصفر يقع على **المجموع** لا على كل يوم.
     *
     * كان `Math.max(0, ...)` داخل الجمع، فأي يوم صافيه سالب (مرتجع بلا بيع
     * فيه) يُصفَّر ويختفي المرتجع تماماً. والمرتجع في التوزيع يصل عادةً في
     * **زيارة تالية** لا في يوم البيع، فكان الخصم المُوثَّق ميتاً عملياً:
     * بيع 280 ومرتجع 210 في يوم آخر يُخرج 10/يوم بدل 2.5 — **أربعة أضعاف**،
     * وتُحمَّل السيارة أربعة أمثال حاجتها.
     *
     * القصّ على المجموع يحفظ المقصود الأصلي (لا متوسط سالب) بلا أن يبتلع
     * المرتجعات العابرة للأيام.
     */
    const sumOver = (keys: string[]) => Math.max(0, keys.reduce((s, k) => s + (days.get(k) || 0), 0));
    const activeDays = [...days.values()].filter((v) => v > 0).length;

    let basis: Basis;
    let sampleDays: number;
    let expected: number;
    let why: string;

    // 3) طريقة يوم الأسبوع — الإشارة الأقوى في التوزيع (المنافذ تطلب بإيقاع أسبوعي)
    const wdActive = weekdayKeys.filter((k) => (days.get(k) || 0) > 0).length;
    if (weekdayKeys.length >= 2 && wdActive >= 2) {
      basis = 'weekday';
      sampleDays = weekdayKeys.length; // القاسم = كل أيام الأسبوع في النافذة، لا التي بيع فيها
      expected = sumOver(weekdayKeys) / sampleDays;
      why = `متوسط ${AR_WEEKDAY[weekday]} خلال آخر ${windowDays} يوماً: `
        + `${fmt(sumOver(weekdayKeys))} على ${sampleDays} ${AR_WEEKDAY[weekday]} (منها ${wdActive} فيها بيع) = ${fmt(round2(expected))}.`;
    } else {
      // 4) سقوط آمن: متوسط يومي عام على كامل النافذة
      basis = 'overall';
      sampleDays = windowDays;
      expected = sumOver(windowDayKeys) / windowDays;
      why = `عيّنة ${AR_WEEKDAY[weekday]} غير كافية، فالحساب على المتوسط اليومي العام: `
        + `${fmt(sumOver(windowDayKeys))} على ${windowDays} يوماً (منها ${activeDays} فيها بيع) = ${fmt(round2(expected))}.`;
    }

    expected = Math.max(0, round2(expected));
    // قص غبار العائمة قبل السقف: 200×1.1 = 220.00000000000003 كانت تصير 221 وحدة
    const withBuffer = Math.ceil(Math.round(expected * (1 + bufferPct / 100) * 1e6) / 1e6);
    // التقريب لأعلى مقصود: التحميل وحدات مادّية، والنقص يُضيّع بيعاً بينما
    // الزيادة تعود للمستودع آخر اليوم.
    const suggested = Math.max(0, withBuffer - onVan);

    const confidence: Confidence = basis === 'weekday' && wdActive >= 4 ? 'high'
      : basis === 'weekday' || activeDays >= 4 ? 'medium'
      : 'low';

    const bufferNote = bufferPct > 0 ? ` + هامش ${bufferPct}٪ ⇒ ${withBuffer}` : '';
    const vanNote = onVan > 0 ? ` − ${fmt(onVan)} في السيارة ⇒ ${suggested}` : '';

    rows.push({
      ...p, expected, withBuffer, onVan, suggested,
      basis, sampleDays, activeDays, confidence,
      why: why + bufferNote + vanNote + '.',
    });
  }

  // الأهمّ أولاً: ما يحتاج تحميلاً فعلاً، ثم الأكبر كمّية
  rows.sort((a, b) => (b.suggested - a.suggested) || (b.expected - a.expected));

  const dataDays = allDays.size;
  let warning: string | null = null;
  if (!targetValid) warning = 'تاريخ غير صالح — حُسب على تاريخ اليوم.';
  else if (dataDays === 0) warning = 'لا مبيعات لهذا المندوب داخل النافذة — لا يمكن اقتراح تحميل.';
  else if (dataDays < 7) warning = `البيانات ${dataDays} يوماً فقط. الأرقام مؤشّر أوّلي لا أكثر — تتحسّن كلّما طال التشغيل.`;
  else if (dataDays < 14) warning = `البيانات ${dataDays} يوماً. اعتمد عليها بحذر وراجع الاقتراح قبل التحميل.`;

  return {
    rows,
    meta: {
      targetDate: dayKey(end),
      weekday,
      windowDays,
      bufferPct,
      dataDays,
      oldestSale: oldest === null ? null : dayKey(new Date(oldest)),
      warning,
    },
  };
}

function round2(n: number) { return Math.round(n * 100) / 100; }
