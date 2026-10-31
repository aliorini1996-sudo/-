/**
 * الوحدات المتعددة للصنف — قلب الحساب، نقيٌّ بلا قاعدة بيانات.
 *
 * ═══ المبدأ ═══
 * لكلّ صنف **وحدة أساس** هي أصغر ما يُباع منه (حبة)، ووحداتٌ أكبر بمعامل تحويل
 * (كرتون = ٢٤ حبة). وكلّ صفٍّ يحمل كميةً يحمل معها **لقطةً**: اسم وحدته
 * ومعاملها لحظة الكتابة. فالكمية بالأساس = `qty × unitFactor`.
 *
 * ولماذا لقطةٌ لا مرجعٌ إلى الوحدة: المعامل قد يتغيّر (كرتون صار ١٢ بعد أن كان
 * ٢٤) أو تُوقَف الوحدة، والفاتورة الصادرة وثيقةٌ لا تُعاد كتابتها. ولو قُرئ
 * المعامل من الصنف وقت العرض لتبدّل مخزون شهورٍ مضت برقمٍ غيّره المدير اليوم.
 *
 * ═══ لماذا يُخزَّن `baseQty` عموداً ولا يُحسب ═══
 * `prisma.aggregate({ _sum: { qty } })` و`groupBy` يجمعان العمود الخام ولا
 * سبيل لضربه بمعاملٍ داخل القاعدة. والمنصّة تجمع الكميات بهما في المخزون
 * والتقارير والصلاحية. فإمّا عمودٌ محسوبٌ عند الكتابة، وإمّا تحويل كلّ تجميعة
 * في المنصّة إلى `findMany` وجمعٍ في الذاكرة — وذاك يُسقط الأداء ويُبقي بابَ
 * النسيان مفتوحاً: تجميعةٌ واحدة تُنسى تكفي لرقمٍ كاذب.
 *
 * ═══ قاعدة الأسماء ═══
 * `qty` كميةٌ **بوحدة الصفّ** كما كتبها المستخدم وكما تُطبع في الورقة.
 * `baseQty` الكمية نفسها بوحدة الأساس — وهي وحدها ما يُجمع ويُقارَن ويُخزَّن.
 */

/** الدقّة المخزَّنة للكمية بالأساس: ستّ منازل كغبار العائمة في بقيّة المنصّة. */
const QTY_SCALE = 1e6;

/** هامش مقارنة الكميات: أصغر من أصغر كسرٍ ذي معنى ولا يبتلع حبّة. */
export const QTY_EPS = 1e-6;

/** لقطة وحدة الصفّ — تُكتب مع كلّ كمية ولا تُقرأ من الصنف بعد ذلك. */
export interface UnitSnapshot {
  /** اسم الوحدة كما يُطبع: «كرتون». فارغٌ أو غائب ⇒ وحدة الصنف وقتها. */
  unitName?: string | null;
  /** كم وحدة أساس فيها. غائبٌ أو غير صالح ⇒ ١ (سلوك ما قبل الميزة). */
  unitFactor?: number | null;
}

/**
 * معامل الصفّ: ١ لكلّ صفٍّ كُتب قبل الميزة أو بوحدة الأساس.
 *
 * والصفر والسالب وغير الرقم تُقرأ ١ لا خطأً: صفٌّ تالفٌ في القاعدة يجب أن
 * يُقرأ بالسلوك القديم، لا أن يُسقط شاشة المخزون كلّها. ومن يكتب المعامل
 * يتحقّق منه عند الكتابة (`assertFactor`).
 */
export function factorOf(row: UnitSnapshot | null | undefined): number {
  const f = Number(row?.unitFactor);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/** الكمية بوحدة الأساس من كميةٍ بوحدة الصفّ ومعاملها. */
export function toBase(qty: number | string | null | undefined, row?: UnitSnapshot | null): number {
  const q = Number(qty);
  if (!Number.isFinite(q)) return 0;
  return roundQty(q * factorOf(row));
}

/** العكس: من الأساس إلى وحدةٍ معاملها `factor` (للعرض والتسعير). */
export function fromBase(baseQty: number | string | null | undefined, factor: number): number {
  const b = Number(baseQty);
  const f = Number(factor);
  if (!Number.isFinite(b) || !Number.isFinite(f) || f <= 0) return 0;
  return roundQty(b / f);
}

/** تقريبٌ يحجب غبار العائمة (0.1+0.2) ولا يمسّ أيّ كسرٍ ذي معنى. */
export function roundQty(n: number): number {
  return Math.round(n * QTY_SCALE) / QTY_SCALE;
}

/** مجموع كمياتٍ بوحداتٍ مختلفة — بالأساس دائماً. */
export function sumBase(rows: Array<{ qty?: number | string | null; baseQty?: number | string | null } & UnitSnapshot>): number {
  let t = 0;
  for (const r of rows) t += baseQtyOf(r);
  return roundQty(t);
}

/**
 * كمية الصفّ بالأساس: العمود المخزَّن إن وُجد، وإلّا تُحسب من اللقطة.
 *
 * والعمود يسبق الحساب لأنّه الحقيقة المكتوبة لحظة الحدث؛ والحساب احتياطٌ
 * لصفوفٍ قديمة لم يملأها الترحيل بعد، ولنتائج `select` التي لم تطلبه.
 */
export function baseQtyOf(row: { qty?: number | string | null; baseQty?: number | string | null } & UnitSnapshot): number {
  // `null`/غائب ⇒ صفٌّ سبق الميزة لم يملأه الترحيل بعد، أو select لم يطلب العمود:
  // يُحسب من اللقطة. ولا يُعامَل الصفر غياباً — الصفر كميةٌ حقيقية.
  // (وكان `Number(null)` = 0 «رقماً صالحاً» فتُقرأ كل الصفوف القديمة صفراً.)
  if (row?.baseQty != null && row.baseQty !== '') {
    const b = Number(row.baseQty);
    if (Number.isFinite(b)) return roundQty(b);
  }
  return toBase(row?.qty, row);
}

/** وحدةٌ معرَّفة على الصنف (صفُّ `ProductUnit`) كما يحتاجها الحساب. */
export interface UnitDef {
  id?: string;
  name: string;
  factor: number;
  /** سعر الوحدة — `null` ⇒ يُشتقّ من سعر الأساس × المعامل */
  price?: number | null;
  /** رمز الوحدة الضريبي (UN/ECE Rec 20) لبند الفاتورة الإلكترونية */
  unitCode?: string | null;
  isActive?: boolean;
}

/**
 * سعر الوحدة: المحدَّد لها، وإلّا سعر الأساس مضروباً بمعاملها.
 *
 * والاشتقاق ضربٌ لا قسمة: سعر الأساس هو المرجع، فكرتونٌ بلا سعرٍ محدَّد يساوي
 * ٢٤ حبّة بسعرها. ومن أراد سعر جملةٍ أقلّ حدّده صراحةً على الوحدة.
 */
export function unitPriceOf(unit: UnitDef, basePrice: number | string | null | undefined): number {
  // `null`/غائب ⇒ لا سعر محدَّد فيُشتقّ — لا صفراً. وكان `Number(null)` = 0 «سعراً
  // صالحاً» فيصير مرجع الحارس السعريّ صفراً: يُرفض بيع الكرتون لمن لا يملك تغيير
  // السعر، وتسقط أرضيته لمن يملكه. (نظير درس `baseQtyOf`.)
  if (unit?.price != null && (unit.price as unknown) !== '') {
    const p = Number(unit.price);
    if (Number.isFinite(p) && p >= 0) return p;
  }
  const bp = Number(basePrice);
  return Number.isFinite(bp) ? money(bp * factorOf({ unitFactor: unit?.factor })) : 0;
}

/** تقريب المال: منزلتان بنصف-لأعلى كبقيّة المنصّة (`dsd_money_precision`). */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * سعر الوحدة الواحدة من بندٍ مباع — لتسعير المرتجع الجزئيّ.
 *
 * المرجع **ما دفعه العميل فعلاً** لا سعر اليوم: `lineTotal ÷ الكمية بالأساس`.
 * فحبّةٌ من كرتونٍ بِيع بخصمٍ تُردّ بسعرها بعد الخصم.
 */
export function refundPerBase(line: { lineTotal: number | string; qty: number | string } & UnitSnapshot): number {
  const total = Number(line?.lineTotal);
  const base = toBase(line?.qty, line);
  if (!Number.isFinite(total) || base <= 0) return 0;
  return total / base;   // بلا تقريب: التقريب عند بناء البند لا هنا
}

/**
 * مبلغ مرتجعٍ جزئيّ، والباقي يذهب لآخر حبّة.
 *
 * ١٠٫٠٠ ÷ ٢٤ = ٠٫٤١٦٦٧، فأربعٌ وعشرون حبّةً في أربعةٍ وعشرين مرتجعاً بسعرٍ
 * مقرَّب تساوي ١٠٫٠٨ — أكثر ممّا دفع العميل. فالمبلغ هنا = ما بقي من قيمة
 * البند حين يُرجَع آخره، وإلّا فحصّته المقرَّبة.
 *
 * @param alreadyReturnedBase ما سبق إرجاعه من البند، بالأساس
 */
export function refundAmount(
  line: { lineTotal: number | string; qty: number | string } & UnitSnapshot,
  returnBase: number,
  alreadyReturnedBase = 0,
): number {
  const total = money(Number(line?.lineTotal) || 0);
  const soldBase = toBase(line?.qty, line);
  const done = Math.max(0, Number(alreadyReturnedBase) || 0);
  const want = Math.max(0, Number(returnBase) || 0);
  if (soldBase <= 0 || want <= 0) return 0;
  /* فرقُ تراكميَّين مقرَّبين (أكبر-باقٍ): حصّةُ هذا المرتجع = قيمة ما رُدّ
   * شاملاً إيّاه ناقص ما رُدّ قبله، كلاهما مقرَّب. فالمجموع يتلسكب إلى قيمة
   * البند تماماً مهما جُزّئ، وآخر حبّةٍ تأخذ الباقي من غير حالةٍ خاصّة:
   * cum(٢٤)=total، cum(٢٣)=٩٫٥٨، فحصّتها ٠٫٤٢ والمجموع ١٠٫٠٠ لا ١٠٫٠٨. */
  const cum = (k: number) => k >= soldBase - QTY_EPS ? total : money((total * k) / soldBase);
  return money(cum(done + want) - cum(done));
}

/**
 * عرض الكمية بوحداتها: «٥ كرتون و٣ حبة» بدل «٥٫١٢٥».
 *
 * يختار أكبر وحدةٍ تنقسم عليها الكمية ثمّ ما بقي، ويتوقّف عند وحدتين فالمزيد
 * يُقرأ لغزاً. وما لا ينقسم (نصف حبّة) يُعرض كسراً على وحدة الأساس.
 *
 * ومع `primary` («الوحدة الرئيسية»، D4) يقف عندها ولا يذكر الأكبر منها: «52 كرتون و2 قارورة» لا «1 طبلية و…»،
 * والصفر «0 كرتون»، وما دون الكرتون «5 قارورة». غيابه أو null ⇒ الجسم القائم حرفياً (I1). ومرّرها من
 * `primaryUnitOf` (أو `productQtyText`) لا من المعرّف مباشرة: التالف هناك يعود null.
 */
export function formatQty(baseQty: number, units: UnitDef[], baseName: string, primary?: UnitDef | null): string {
  const pf = primary ? Number(primary.factor) : NaN;
  if (primary && primary.isActive !== false && Number.isFinite(pf) && pf > 1) {
    const q = roundQty(Number(baseQty) || 0);
    if (q === 0) return `0 ${primary.name}`;
    const sign = q < 0 ? '-' : '';
    const abs = Math.abs(q);
    const whole = Math.floor(abs / pf + QTY_EPS);
    if (whole < 1) return `${sign}${trim(abs)} ${baseName}`;
    const rest = roundQty(abs - whole * pf);
    if (rest <= QTY_EPS) return `${sign}${trim(whole)} ${primary.name}`;
    return `${sign}${trim(whole)} ${primary.name} و${trim(rest)} ${baseName}`;
  }
  const q = roundQty(Number(baseQty) || 0);
  if (q === 0) return `0 ${baseName}`;
  const sign = q < 0 ? '-' : '';
  const abs = Math.abs(q);
  // الوحدات الأكبر من الأساس، من الأكبر إلى الأصغر
  const big = (units || [])
    .filter(u => u && Number(u.factor) > 1 && u.isActive !== false)
    .sort((a, b) => Number(b.factor) - Number(a.factor));
  for (const u of big) {
    const f = Number(u.factor);
    const whole = Math.floor(abs / f + QTY_EPS);
    if (whole < 1) continue;
    const rest = roundQty(abs - whole * f);
    if (rest <= QTY_EPS) return `${sign}${trim(whole)} ${u.name}`;
    return `${sign}${trim(whole)} ${u.name} و${trim(rest)} ${baseName}`;
  }
  return `${sign}${trim(abs)} ${baseName}`;
}

/** رقمٌ بلا أصفارٍ زائدة: 5 لا 5.000000، و0.5 كما هي. */
function trim(n: number): string {
  return String(roundQty(n));
}

/** حدود المعامل: أقلّه أكبر من صفر، وأقصاه يمنع رقماً كارثياً بخطأٍ مطبعيّ. */
export const MAX_UNIT_FACTOR = 100000;

/** سبب رفض وحدةٍ جديدة أو معدَّلة، أو null حين تصحّ. */
export function unitProblem(u: { name?: unknown; factor?: unknown; price?: unknown }, others: UnitDef[] = []): string | null {
  const name = String(u?.name ?? '').trim();
  if (!name) return 'اسم الوحدة مطلوب';
  if (name.length > 24) return 'اسم الوحدة طويل';
  const f = Number(u?.factor);
  if (!Number.isFinite(f) || f <= 0) return 'معامل التحويل رقم أكبر من صفر';
  if (f > MAX_UNIT_FACTOR) return `معامل التحويل لا يتجاوز ${MAX_UNIT_FACTOR}`;
  // كسرٌ في المعامل يعني أنّ «الأساس» ليس أصغر الوحدات — وهو نقضٌ للمبدأ كلّه
  if (Math.abs(f - Math.round(f)) > QTY_EPS) return 'معامل التحويل عدد صحيح — وحدة الأساس هي الأصغر';
  if (u?.price != null && u.price !== '') {
    const p = Number(u.price);
    if (!Number.isFinite(p) || p < 0) return 'سعر الوحدة رقم موجب';
  }
  if (others.some(o => o.name.trim() === name)) return 'اسم الوحدة مكرر لهذا الصنف';
  if (others.some(o => Math.abs(Number(o.factor) - f) < QTY_EPS)) return 'يوجد وحدة بالمعامل نفسه لهذا الصنف';
  return null;
}

/** يتحقّق من المعامل عند الكتابة — من يخزّن لقطةً يمرّ من هنا. */
export function assertFactor(factor: unknown): number {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0 || f > MAX_UNIT_FACTOR) {
    throw new Error(`معامل وحدة غير صالح: ${String(factor)}`);
  }
  return f;
}

/**
 * لقطة الوحدة لصفٍّ جديد، ومعها الكمية بالأساس — المدخل الوحيد للكتابة.
 *
 * `unit` غائبةٌ ⇒ وحدة الأساس بمعامل ١، وهو حال كلّ صفٍّ يكتبه مسارٌ لم
 * يُحدَّث بعد: سلوكه كما كان حرفياً.
 */
export function unitFields(qty: number | string, unit?: { name?: string | null; factor?: number | null } | null): {
  qty: number; unitName: string | null; unitFactor: number; baseQty: number;
} {
  const q = Number(qty);
  const factor = unit?.factor == null ? 1 : assertFactor(unit.factor);
  const name = unit?.name?.trim() || null;
  return {
    qty: Number.isFinite(q) ? q : 0,
    unitName: name,
    unitFactor: factor,
    baseQty: toBase(q, { unitFactor: factor }),
  };
}

// ═══════════════ «الوحدة الرئيسية» (القاعدة ١٢) — عرضٌ وتعريفٌ وإدخالٌ افتراضي فقط ═══════════════
// الحساب الداخلي لا ينقلب: القارورة هي الأساس (Product.unit/basePrice)، والكرتون صفّ ProductUnit بمعامل ٢٤، و
// primaryUnitId يشير إليه. فلا شيء هنا يدخل جمعاً أو تقريب مالٍ مخزَّن أو XML أو حمولة ERP أو LOT (I2): toBase وbaseQtyOf
// وunitFields وunitPriceOf وrefundAmount وunitProblem أعلاه لا تعرف الرئيسية.

/** الصنف كما تحتاجه «الوحدة الرئيسية»: معرّفها ووحداته بمعرّفاتها */
export interface PrimaryHolder { primaryUnitId?: string | null; units?: UnitDef[] | null }

/**
 * الوحدة الرئيسية الصالحة أو null (= سلوك ما قبل الميزة). كل مستهلكٍ يمرّ من هنا: معرّفٌ لا يطابق وحدةً من وحدات الصنف
 * (كاشٌ قديم، وحدةٌ حُذفت، صنفٌ آخر)، أو موقوفة، أو بمعاملٍ غير صحيح ≥ ٢ ⇒ null — فكلّ حالٍ تالف يعود إلى سلوك اليوم (I5).
 */
export function primaryUnitOf(p: PrimaryHolder | null | undefined): UnitDef | null {
  const id = p?.primaryUnitId;
  if (!id) return null;
  const u = (p?.units ?? []).find(x => x && x.id === id);
  if (!u || u.isActive === false) return null;
  const f = Number(u.factor);
  if (!Number.isFinite(f) || f < 2 || f > MAX_UNIT_FACTOR || Math.abs(f - Math.round(f)) > QTY_EPS) return null;
  return u;
}

/** كمية بالأساس لصنفٍ بوحداته ورئيسيّه — الاختصار المشترك لكل عرض (R1). بلا رئيسية ⇒ formatQty القائم حرفياً */
export function productQtyText(baseQty: number, p: (PrimaryHolder & { unit?: string | null }) | null | undefined): string {
  return formatQty(baseQty, p?.units ?? [], String(p?.unit ?? ''), primaryUnitOf(p));
}

/** سعر الوحدة الرئيسية (المحدَّد، وإلّا الأساس × المعامل)، أو null بلا رئيسية */
export function primaryPriceOf(p: PrimaryHolder & { basePrice: number | string }): number | null {
  const u = primaryUnitOf(p);
  return u ? unitPriceOf(u, p.basePrice) : null;
}

/** نسخة حرفية من roundHalfUp في lib/money.ts (الملف بلا استيراد لأنه مرآة) — خاصّة، لا تُصدَّر، ولا تمسّ money() أعلاه */
function halfUp(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  const scaled = Number((value * f).toPrecision(12));
  const sign = scaled < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(scaled))) / f;
}

/**
 * سعر الفرعية (الأساس) المشتقّ من سعر الرئيسية — roundHalfUp لأربع منازل، كالخطوة ٥ في convert-base (roundDecimal(…, 4)).
 * فالإنشاء العكسي والتحويل والاستيراد يعطون سعر القارورة نفسه للكرتون نفسه (16.33 ÷ 8 = 2.0413 في الثلاثة، D10).
 * مدخلٌ غير رقم أو معاملٌ ≤ ٠ ⇒ 0.
 */
export function derivedBasePrice(primaryPrice: number, factor: number): number {
  const p = Number(primaryPrice), f = Number(factor);
  if (!Number.isFinite(p) || !Number.isFinite(f) || f <= 0) return 0;
  return halfUp(p / f, 4);
}

/** D20-أ: مفتاح المقارنة الوحيد لاسم وحدة الأساس — قصّ الأطراف ثم أول ٦٤ حرفاً (حدّ baseUnitName في كل مخطّط) */
export function baseNameKey(s: string | null | undefined): string { return String(s ?? '').trim().slice(0, 64); }
