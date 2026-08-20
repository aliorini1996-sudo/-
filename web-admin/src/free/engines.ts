/**
 * محرّكات الأدوات المجانية — دوالّ **صرفة** بلا DOM ولا شبكة.
 *
 * لماذا منفصلة عن React: الصحّة الحسابية هي كل قيمة هذه الأدوات. صاحب شركة
 * التوزيع يبني قراراً على الرقم الذي نعرضه، فيجب أن يكون مختبَراً لا مُجرَّباً
 * بصرياً. الفصل يجعلها قابلة للاختبار بـnode بلا بيئة متصفّح.
 *
 * قاعدة عابرة: **لا رقم سوق مضمَّن هنا**. كل معامل يُدخله المستخدم، فلا ندّعي
 * معرفة تكاليفه ولا نُخفي افتراضاً داخل حساب.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const safe = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : 0;
};

/* ------------------------------------------------------------------ */
/* ١) عمولة المندوب المتدرّجة                                          */
/* ------------------------------------------------------------------ */

export interface CommissionTier {
  /** من مبلغ مبيعات (شامل) */
  from: number;
  /** إلى مبلغ (شامل) — استخدم Infinity للشريحة الأخيرة */
  to: number;
  /** نسبة العمولة % */
  pct: number;
}

export interface CommissionInput {
  sales: number;
  tiers: CommissionTier[];
  /** مرتجعات تُخصم من أساس العمولة */
  returns?: number;
  /** حدّ أدنى للعمولة (أرضية) */
  floor?: number;
  /** حدّ أقصى (سقف) — 0 أو غياب = بلا سقف */
  cap?: number;
  /** تدرّجي: كل شريحة تُحسب على الجزء الواقع فيها. غير تدرّجي: نسبة الشريحة على الإجمالي */
  progressive?: boolean;
}

export interface CommissionBreakdownRow {
  from: number; to: number; pct: number;
  /** المبلغ الخاضع لهذه الشريحة */
  base: number;
  amount: number;
}

export interface CommissionResult {
  /** أساس الحساب بعد خصم المرتجعات */
  base: number;
  rows: CommissionBreakdownRow[];
  /** قبل تطبيق الأرضية/السقف */
  raw: number;
  total: number;
  /** هل عدّلت الأرضية أو السقف النتيجة؟ */
  adjusted: 'floor' | 'cap' | null;
}

export function computeCommission(input: CommissionInput): CommissionResult {
  const sales = Math.max(0, safe(input.sales));
  const returns = Math.max(0, safe(input.returns));
  const base = Math.max(0, sales - returns); // المرتجع لا يجعل الأساس سالباً
  const tiers = [...(input.tiers || [])]
    .map((t) => ({ from: safe(t.from), to: Number.isFinite(t.to) ? safe(t.to) : Infinity, pct: safe(t.pct) }))
    .sort((a, b) => a.from - b.from);

  const rows: CommissionBreakdownRow[] = [];
  let raw = 0;

  if (input.progressive === false) {
    // غير تدرّجي: تُطبَّق نسبة الشريحة التي يقع فيها الأساس على كامل الأساس
    const hit = tiers.find((t) => base >= t.from && base <= t.to);
    if (hit) {
      raw = base * (hit.pct / 100);
      rows.push({ from: hit.from, to: hit.to, pct: hit.pct, base, amount: round2(raw) });
    }
  } else {
    // تدرّجي (الافتراضي): كل شريحة على الجزء الواقع فيها فقط
    for (const t of tiers) {
      if (base <= t.from) continue;
      const upper = Math.min(base, t.to);
      const slice = upper - t.from;
      if (slice <= 0) continue;
      const amount = slice * (t.pct / 100);
      raw += amount;
      rows.push({ from: t.from, to: t.to, pct: t.pct, base: round2(slice), amount: round2(amount) });
    }
  }

  let total = raw;
  let adjusted: 'floor' | 'cap' | null = null;
  const floor = safe(input.floor);
  const cap = safe(input.cap);
  if (floor > 0 && total < floor) { total = floor; adjusted = 'floor'; }
  if (cap > 0 && total > cap) { total = cap; adjusted = 'cap'; }

  return { base: round2(base), rows, raw: round2(raw), total: round2(total), adjusted };
}

/* ------------------------------------------------------------------ */
/* ٢) تسوية عهدة سيارة المندوب                                        */
/* ------------------------------------------------------------------ */

export interface VanLine {
  code: string;
  name?: string;
  opening: number;
  loaded: number;
  sold: number;
  returned: number;
  damaged: number;
  /** الجرد الفعلي آخر اليوم */
  counted: number;
  /** تكلفة الوحدة — لتقدير قيمة العجز */
  unitCost?: number;
}

export interface VanLineResult extends VanLine {
  expected: number;
  /** موجب = زيادة، سالب = عجز */
  diff: number;
  diffValue: number;
}

export interface VanResult {
  lines: VanLineResult[];
  totalShortageUnits: number;
  totalSurplusUnits: number;
  totalShortageValue: number;
  balanced: boolean;
}

/**
 * معادلة الاتزان: المتوقّع = أول اليوم + المُحمَّل − المُباع + المرتجع − التالف.
 * المرتجع **يضاف** لأنه عاد للسيارة، والتالف **يُطرح** لأنه خرج منها.
 */
export function computeVanReconciliation(lines: VanLine[]): VanResult {
  const out: VanLineResult[] = (lines || []).map((l) => {
    const opening = safe(l.opening), loaded = safe(l.loaded), sold = safe(l.sold);
    const returned = safe(l.returned), damaged = safe(l.damaged), counted = safe(l.counted);
    const expected = opening + loaded - sold + returned - damaged;
    const diff = counted - expected;
    return {
      ...l, opening, loaded, sold, returned, damaged, counted,
      expected: round2(expected),
      diff: round2(diff),
      diffValue: round2(diff * safe(l.unitCost)),
    };
  });

  const totalShortageUnits = round2(out.filter((l) => l.diff < 0).reduce((s, l) => s + Math.abs(l.diff), 0));
  const totalSurplusUnits = round2(out.filter((l) => l.diff > 0).reduce((s, l) => s + l.diff, 0));
  const totalShortageValue = round2(out.filter((l) => l.diff < 0).reduce((s, l) => s + Math.abs(l.diffValue), 0));

  return {
    lines: out,
    totalShortageUnits,
    totalSurplusUnits,
    totalShortageValue,
    balanced: out.every((l) => l.diff === 0),
  };
}

/* ------------------------------------------------------------------ */
/* ٣) كم مندوباً تحتاج؟                                                */
/* ------------------------------------------------------------------ */

export interface RepsNeedInput {
  /** عدد المنافذ/العملاء */
  outlets: number;
  /** كم مرّة يُزار العميل شهرياً */
  visitsPerMonth: number;
  /** كم زيارة يُنجزها المندوب يومياً */
  visitsPerDay: number;
  /** أيام العمل شهرياً */
  workDays: number;
}

export interface RepsNeedResult {
  totalVisits: number;
  capacityPerRep: number;
  exact: number;
  /** العدد العملي (تقريب لأعلى) */
  reps: number;
  /** حساسية ±٢٠٪ على إنتاجية المندوب */
  low: number;
  high: number;
  valid: boolean;
}

export function computeRepsNeeded(i: RepsNeedInput): RepsNeedResult {
  const outlets = Math.max(0, safe(i.outlets));
  const vpm = Math.max(0, safe(i.visitsPerMonth));
  const vpd = Math.max(0, safe(i.visitsPerDay));
  const days = Math.max(0, safe(i.workDays));

  const totalVisits = outlets * vpm;
  const capacityPerRep = vpd * days;
  // القسمة على صفر: نُرجع valid=false بدل Infinity أو NaN يتسرّب للواجهة
  if (capacityPerRep <= 0) {
    return { totalVisits, capacityPerRep: 0, exact: 0, reps: 0, low: 0, high: 0, valid: false };
  }
  const exact = totalVisits / capacityPerRep;
  return {
    totalVisits,
    capacityPerRep,
    exact: round2(exact),
    reps: Math.ceil(exact),
    // إنتاجية أعلى ٢٠٪ ⇒ مناديب أقلّ، والعكس
    low: Math.ceil(totalVisits / (capacityPerRep * 1.2)),
    high: Math.ceil(totalVisits / (capacityPerRep * 0.8)),
    valid: true,
  };
}

/* ------------------------------------------------------------------ */
/* ٤) حدّ الائتمان وأعمار الدين                                        */
/* ------------------------------------------------------------------ */

export interface AgingEntry { amount: number; daysOverdue: number }

export interface AgingResult {
  buckets: { label: string; amount: number; count: number }[];
  total: number;
  overdueTotal: number;
  /** حدّ ائتمان مقترح = متوسط المبيعات الشهرية × (مدّة السداد ÷ 30) */
  suggestedLimit: number;
}

export function computeAging(entries: AgingEntry[], monthlySales = 0, paymentDays = 30): AgingResult {
  const defs = [
    { label: 'غير مستحق', min: -Infinity, max: 0 },
    { label: '1 30 يوما', min: 1, max: 30 },
    { label: '31 60 يوما', min: 31, max: 60 },
    { label: '61 90 يوما', min: 61, max: 90 },
    { label: 'أكثر من 90 يوما', min: 91, max: Infinity },
  ];
  const list = (entries || []).map((e) => ({ amount: safe(e.amount), daysOverdue: safe(e.daysOverdue) }));
  const buckets = defs.map((d) => {
    const hit = list.filter((e) => e.daysOverdue >= d.min && e.daysOverdue <= d.max);
    return { label: d.label, amount: round2(hit.reduce((s, e) => s + e.amount, 0)), count: hit.length };
  });
  const total = round2(list.reduce((s, e) => s + e.amount, 0));
  const overdueTotal = round2(list.filter((e) => e.daysOverdue > 0).reduce((s, e) => s + e.amount, 0));
  const suggestedLimit = round2(Math.max(0, safe(monthlySales)) * (Math.max(0, safe(paymentDays)) / 30));
  return { buckets, total, overdueTotal, suggestedLimit };
}
