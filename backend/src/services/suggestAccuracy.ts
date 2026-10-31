/**
 * محرّك «دقّة الاقتراح» — يقيس ما تنبّأنا به مقابل ما بِيع فعلاً.
 *
 * دالّة **صرفة** بلا Prisma. اقتراح بلا قياس ادّعاء؛ هذا الملف يحوّل «نظنّه
 * مفيداً» إلى رقم يقبله صاحب الشركة أو يرفضه، وهو إشارة التحسين الوحيدة.
 *
 * ══════════════ ما الذي يُقاس بالضبط — وهو أصعب سؤال هنا ══════════════
 * محرّك الاقتراح يُخرج ثلاثة أرقام لكل صنف:
 *   expected    = **الطلب المتوقّع ليومٍ واحد**  ← هذا هو التنبّؤ
 *   withBuffer  = expected × (1 + هامش)          ← قرار مخاطرة
 *   suggested   = withBuffer − ما في السيارة     ← كمية تعبئة
 *
 * القياس يجب أن يقع على **expected** لا على suggested. مراجعة عدائية كشفت
 * أن قياس suggested يقلب النتيجة رأساً على عقب: مندوب في سيارته ٣٠ وحدة
 * فحمّل ١٦ مقترَحة ثم باع ٤٤ — قياس «٤٤ مقابل ١٦» يعلن نقصاً بـ٢٨ ويوصي
 * برفع الهامش، بينما المتاح كان ٤٦ والطلب ٤٤ أي **فائض** وحدتين. وكل مندوب
 * لا يُفرغ سيارته (الحالة الطبيعية) يُنتج هذا الانحياز الموجب دائماً —
 * فتُملأ السيارة ببضاعة راكدة بسبب المقياس نفسه.
 *
 * وثانياً: وحدة القياس **يوم تقويمي** لا «الفترة بين تحميلين».
 * لأن expected تنبّؤ ليوم واحد. لو قِيس على فترة تمتدّ ثلاثة أيام (مندوب
 * يُحمّل كل ثلاثة) لأعلن نقصاً ثلاثة أضعاف بلا أي خطأ في التنبّؤ. ولو
 * قِيس على فترة دقائق (تحميل تكميلي في اليوم نفسه) لأعلن خطأً = كامل
 * التنبّؤ. اليوم التقويمي يُسقط الحالتين معاً.
 *
 * وثالثاً: **اليوم الجاري مستبعَد** — لم يكتمل بيعه فيبدو كل تنبّؤ فيه
 * مبالغاً. نظير مباشر لقاعدة «الأيام الصفرية» في محرّك الاقتراح: كلاهما
 * خطأ يُنتج رقماً يبدو معقولاً ولا أحد يشكّ فيه.
 * ═══════════════════════════════════════════════════════════════════
 */

import { primaryUnitOf, type UnitDef } from './units';

/**
 * الكميات كلّها **بوحدة الأساس** (الوحدات المتعددة): المحمَّل والمبيع يحوّلهما المسار (qty × unitFactor)، والمقترَح
 * والمتنبَّأ به مخزَّنان بالأساس أصلاً. وإلا قيس تحميل «٢ كرتون» على اقتراح ٤٨ حبّة فلا يُعدّ تبنّياً أبداً.
 */
export interface LoadItemRow {
  productId: string;
  /** ما حُمِّل فعلاً — بالأساس */
  qty: number;
  /** كمية التعبئة المقترَحة (بعد الهامش وخصم ما في السيارة) — للتبنّي فقط */
  suggestedQty: number | null;
  /** **التنبّؤ اليومي** وقت التحميل — هذا ما تُقاس دقّته */
  expectedQty: number | null;
}

export interface LoadRow {
  id: string;
  at: string | Date;
  items: LoadItemRow[];
}

export interface SaleEvent {
  productId: string;
  /** بالأساس */
  qty: number;
  at: string | Date;
  /** RETURN يُخصم — ليس طلباً تحقّق */
  isReturn?: boolean;
}

export interface AccuracyInput {
  loads: LoadRow[];
  sales: SaleEvent[];
  /** لحظة القياس (افتراضي: الآن) — يحدّد أي يوم «جارٍ» فيُستبعَد */
  now?: string | Date;
  /** و`units`/`primaryUnitId` للعرض وحده («الوحدة الرئيسية»): لا يدخلان أي حساب */
  products?: { id: string; name: string; code: string; unit: string; units?: UnitDef[] | null; primaryUnitId?: string | null }[];
}

export interface DayAccuracy {
  /** 'YYYY-MM-DD' */
  day: string;
  productId: string;
  name: string;
  unit: string;
  /** التنبّؤ اليومي */
  expected: number;
  /** كمية التعبئة المقترَحة (سياق لا مرجع قياس) */
  suggested: number;
  /** ما حُمِّل فعلاً */
  loaded: number;
  /** الطلب الفعلي في اليوم نفسه (مبيع − مرتجع، لا ينزل تحت الصفر) */
  actual: number;
  /** موجب = الطلب فاق التنبّؤ · سالب = تنبّأنا فوق الطلب */
  error: number;
  adopted: boolean;
  outcome: 'دقيق' | 'نقص' | 'زيادة';
  /** اليوم لم ينتهِ ⇒ خارج التجميع */
  open: boolean;
  /**
   * وحدات الصنف و«الوحدة الرئيسية» ليعرض الجدول أرقامه بها («2 كرتون»، R1) — `units` حاضرة حين للصنف رئيسية صالحة فقط،
   * فلا تُفكَّك أرقام صنفٍ بلاها؛ و`primaryUnitId` حاضرٌ دائماً (D18): معرّف الرئيسية الصالحة أو null
   */
  units?: UnitDef[];
  primaryUnitId: string | null;
}

export interface AccuracySummary {
  measured: number;
  pending: number;
  /** بنود حُمِّلت بلا تنبّؤ — خارج القياس أصلاً */
  unmeasured: number;
  adoptionRate: number | null;
  mae: number | null;
  bias: number | null;
  maePct: number | null;
  under: number;
  over: number;
  exact: number;
  verdict: string;
}

export interface AccuracyResult {
  days: DayAccuracy[];
  summary: AccuracySummary;
}

const tsOf = (v: string | Date): number => {
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? NaN : t;
};
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * بنود الصنف الواحد في التحميل الواحد ← بندٌ واحد بالأساس (#12، الوحدات المتعددة).
 *
 * التحميل بندٌ لكل (صنف، وحدة): «2 كرتون» و«2 قارورة» من الصنف نفسه بندان، والاقتراح (`suggestedQty`/`expectedQty`
 * بالأساس) على أحدهما. فكان البند الأول وحده يُقارن بالمقترَح — «48 مقابل 50» ليس تبنّياً، والقارورتان «تحميلٌ لاحق»
 * أو «بلا تنبّؤ» — والصواب أن المحمَّل في هذا التحميل 50 = المقترَح. فالكمية مجموع البنود، والتنبّؤ والمقترَح أوّل
 * قيمةٍ غير فارغة بترتيب البنود (لا يُجمعان: تنبّؤ اليوم واحدٌ لا يتضاعف بتقسيم البند). صنفٌ ببندٍ واحد كما هو حرفاً.
 */
export function mergeLoadItems(items: ReadonlyArray<LoadItemRow>): LoadItemRow[] {
  const out: LoadItemRow[] = [];
  const at = new Map<string, number>();
  for (const it of items || []) {
    if (!it?.productId) { out.push(it); continue; }
    const i = at.get(it.productId);
    if (i === undefined) { at.set(it.productId, out.length); out.push(it); continue; }
    const m = out[i];
    out[i] = {
      ...m,
      qty: num(m.qty) + num(it.qty),
      suggestedQty: m.suggestedQty === null || m.suggestedQty === undefined ? it.suggestedQty ?? null : m.suggestedQty,
      expectedQty: m.expectedQty === null || m.expectedQty === undefined ? it.expectedQty ?? null : m.expectedQty,
    };
  }
  return out;
}

export function computeAccuracy(input: AccuracyInput): AccuracyResult {
  const nowT = input.now ? tsOf(input.now) : Date.now();
  const today = dayOf(Number.isFinite(nowT) ? nowT : Date.now());
  const prod = new Map((input.products || []).map((p) => [p.id, p]));

  /* ١) الطلب الفعلي لكل صنف في كل يوم */
  const actualByDayProduct = new Map<string, number>();
  const key = (day: string, pid: string) => `${day} ${pid}`;
  for (const s of input.sales || []) {
    if (!s?.productId) continue;
    const t = tsOf(s.at);
    if (!Number.isFinite(t)) continue;
    const k = key(dayOf(t), s.productId);
    const delta = (s.isReturn ? -1 : 1) * Math.abs(num(s.qty));
    actualByDayProduct.set(k, (actualByDayProduct.get(k) || 0) + delta);
  }

  /* ٢) تنبّؤ كل (يوم، صنف).
   *
   * تحميلان في اليوم نفسه: يُعتمد **الأوّل** الحامل لتنبّؤ. الثاني تكملةُ
   * نقصٍ لا تنبّؤ جديد، وجمعُهما يُضاعف التنبّؤ بلا وجه حقّ. */
  interface Slot { expected: number; suggested: number; loaded: number; firstAt: number; adopted: boolean }
  const slots = new Map<string, Slot>();
  let unmeasured = 0;

  const loads = (input.loads || [])
    .map((l) => ({ ...l, items: mergeLoadItems(l.items || []), t: tsOf(l.at) }))
    .filter((l) => Number.isFinite(l.t))
    .sort((a, b) => a.t - b.t);

  for (const load of loads) {
    const day = dayOf(load.t);
    for (const it of load.items || []) {
      if (!it?.productId) continue;
      // بلا تنبّؤ ⇒ لا مرجع. عدّه «دقيقاً» تلفيقٌ للنتيجة.
      if (it.expectedQty === null || it.expectedQty === undefined) { unmeasured++; continue; }
      const k = key(day, it.productId);
      const existing = slots.get(k);
      if (existing) {
        // تحميل لاحق في اليوم نفسه: يزيد المُحمَّل ولا يمسّ التنبّؤ
        existing.loaded = round2(existing.loaded + num(it.qty));
        continue;
      }
      const expected = round2(Math.max(0, num(it.expectedQty)));
      const suggested = round2(Math.max(0, num(it.suggestedQty)));
      slots.set(k, {
        expected, suggested,
        loaded: round2(num(it.qty)),
        firstAt: load.t,
        adopted: Math.abs(num(it.qty) - suggested) < 0.001,
      });
    }
  }

  /* ٣) المقارنة يوماً بيوم */
  const days: DayAccuracy[] = [];
  for (const [k, s] of slots) {
    const [day, productId] = k.split(' ');
    const actual = Math.max(0, round2(actualByDayProduct.get(k) || 0));
    const p = prod.get(productId);
    const prim = primaryUnitOf(p);
    const error = round2(actual - s.expected);
    days.push({
      day, productId,
      name: p?.name || productId,
      unit: p?.unit || '',
      expected: s.expected,
      suggested: s.suggested,
      loaded: s.loaded,
      actual,
      error,
      adopted: s.adopted,
      outcome: error > 0 ? 'نقص' : error < 0 ? 'زيادة' : 'دقيق',
      open: day >= today, // اليوم الجاري (وأي تاريخ مستقبلي) لم يكتمل
      ...(prim && p?.primaryUnitId ? { units: [...(p.units ?? [])], primaryUnitId: p.primaryUnitId } : { primaryUnitId: null }),
    });
  }

  const closed = days.filter((d) => !d.open);
  const n = closed.length;
  const sumExpected = closed.reduce((s, d) => s + d.expected, 0);
  const sumAbsErr = closed.reduce((s, d) => s + Math.abs(d.error), 0);

  const summary: AccuracySummary = {
    measured: n,
    pending: days.length - n,
    unmeasured,
    adoptionRate: n ? round2((closed.filter((d) => d.adopted).length / n) * 100) : null,
    mae: n ? round2(sumAbsErr / n) : null,
    bias: n ? round2(closed.reduce((s, d) => s + d.error, 0) / n) : null,
    // النسبة على مجموع التنبّؤ لا كمتوسط نِسَب: متوسط النِسَب يعطي صنفاً
    // تنبّؤه ٢ نفس وزن صنف تنبّؤه ٢٠٠ فيهيمن الصغير على الحكم.
    maePct: n && sumExpected > 0 ? round2((sumAbsErr / sumExpected) * 100) : null,
    under: closed.filter((d) => d.outcome === 'نقص').length,
    over: closed.filter((d) => d.outcome === 'زيادة').length,
    exact: closed.filter((d) => d.outcome === 'دقيق').length,
    verdict: '',
  };
  summary.verdict = buildVerdict(summary);

  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : Math.abs(b.error) - Math.abs(a.error)));
  return { days, summary };
}

/** حكم بالعربية يُقال كما هو للمستخدم — لا رقم بلا معنى */
function buildVerdict(s: AccuracySummary): string {
  if (!s.measured) {
    return s.pending
      ? 'لا قياس بعد تحميل اليوم ما زال قيد البيع يظهر الرقم غدا'
      : 'لا قياس بعد لم يحمل شيء بناء على اقتراح';
  }
  const out: string[] = [`قيس ${s.measured} يوم-صنف`];
  if (s.maePct !== null) out.push(`متوسط الخطأ ${s.mae} وحدة (${s.maePct}٪ من المتنبأ به)`);
  if (s.bias !== null && Math.abs(s.bias) >= 0.5) {
    out.push(s.bias > 0
      ? `وميل إلى **النقص** بمقدار ${Math.abs(s.bias)} وحدة يوميا ارفع هامش الأمان`
      : `وميل إلى **الزيادة** بمقدار ${Math.abs(s.bias)} وحدة يوميا اخفض هامش الأمان`);
  } else if (s.bias !== null) {
    out.push('ولا انحياز واضح لأي اتجاه');
  }
  // العتبة ٦٠ لا ٥٠: تعديل الرقم في أربعٍ من كل عشر مرّات خبرٌ يستحقّ القول،
  // و«أقلّ من ٥٠» تُسقط حالة النصف بالضبط وهي أوضح إشارة عدم ثقة.
  if (s.adoptionRate !== null && s.adoptionRate < 60) {
    out.push(`وحمل ${s.adoptionRate}٪ فقط كما اقترح أنت تعدله كثيرا فراجع النافذة والهامش`);
  }
  if (s.unmeasured > 0) {
    out.push(`و${s.unmeasured} بندا حمل بلا اقتراح فلم يدخل القياس`);
  }
  return out.join(' ');
}
