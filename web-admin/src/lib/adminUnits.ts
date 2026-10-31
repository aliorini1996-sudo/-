/**
 * الوحدات المتعددة في لوحة الإدارة على الويب — نقيٌّ بلا React ولا شبكة، يُختبر وحده (adminUnits.test.ts).
 *
 * لا حساب هنا: كل كميةٍ وسعرٍ من `lib/units.ts` (مرآة الخادم حرفياً) ووحدة البند من `rep/repUnits.ts`.
 * وما يخصّ اللوحة وحدها أربعة:
 *  1. **العرض**: رصيدٌ بالأساس يُعرض «٢ كرتون و٣ حبة» لصنفٍ له وحدات، ورقمه كما كان لغيره حرفاً.
 *  2. **محرّر وحدات الصنف** (نافذة الصنف): التحقق قبل الإرسال بقاعدة الخادم نفسها (`unitProblem`) والأساس بين
 *     «الأخريات» — فلا وحدة باسمه ولا بمعامل ١.
 *  3. **تحويل الأساس إلى وحدةٍ أصغر**: التحقق ومعاينة ما سيحدث، كما يحسبه الخادم (routes/products.ts convert-base).
 *  4. **سطر الاقتراح** في نافذة التحميل: الكمية المقترحة بالأساس تُحمَّل بأكبر وحدةٍ تنقسم عليها تماماً.
 *  5. **«الوحدة الرئيسية»** (القاعدة ١٢، عرضٌ وتعريفٌ وإدخالٌ افتراضي فقط): العرض يقف عندها، ونموذج الصنف المعرَّف
 *     بالكرتون (`ReverseForm`) يُتحقَّق منه ويُرسَل من هنا. وصنفٌ بلا رئيسية (`primaryUnitId` غائب أو null أو تالف)
 *     يبقى كل ناتجٍ له حرفاً كما قبل الميزة (I1).
 *
 * ═══ الفخّ الحاكم ═══
 * رقمٌ بالأساس بجانب اسم وحدةٍ أكبر يُقرأ خطأً ٢٤ ضعفاً: «المتبقي ٤٨ كرتون» عن ٤٨ حبة. فكلّ رقمٍ بالأساس يُعرض إمّا
 * مفكَّكاً بوحداته وإمّا بجانب اسم الأساس — لا بجانب اسم وحدة السطر أبداً.
 */
import { MAX_UNIT_FACTOR, QTY_EPS, derivedBasePrice, factorOf, formatQty, primaryPriceOf, primaryUnitOf, unitProblem, type UnitDef } from './units';
import { unitChoices, type UnitChoice, type UnitProduct } from '../rep/repUnits';

/** للصنف وحدةٌ نشطة أكبر من الأساس؟ — بلا شرط المعرّف: وحدات التقارير تصل بالاسم والمعامل وحدهما */
export function hasBigUnit(units: UnitDef[] | null | undefined): boolean {
  return (units ?? []).some(u => u && Number(u.factor) > 1 && u.isActive !== false);
}

/** أكبر وحدةٍ نشطة للصنف — لتلميح «سعر الكرتون» بجانب سعر الأساس، أو null */
export function biggestUnit(units: UnitDef[] | null | undefined): UnitDef | null {
  const big = (units ?? []).filter(u => u && Number(u.factor) > 1 && u.isActive !== false);
  return big.length ? big.reduce((a, b) => (Number(b.factor) > Number(a.factor) ? b : a)) : null;
}

/**
 * الوحدة الرئيسية الصالحة، وإلّا أكبر وحدةٍ نشطة (`biggestUnit`) — لتلميحَي «سعر/تكلفة الكرتون» بجانب سعر القارورة:
 * صنفٌ رئيسيّه كرتون وله طبلية يُلمَّح بسعر الكرتون لا الطبلية. وبلا رئيسية `biggestUnit` حرفاً.
 */
export function primaryOrBiggest(p: { units?: UnitDef[] | null; primaryUnitId?: string | null } | null | undefined): UnitDef | null {
  return primaryUnitOf(p) ?? biggestUnit(p?.units);
}

/**
 * وسم وحدة الصنف (R5): «كرتون (24 قارورة)» حين للصنف رئيسية، وإلّا `p.unit` كما هو. `fmt` منسّق أرقام الشاشة للمعامل.
 */
export function productUnitLabel(
  p: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null } | null | undefined,
  fmt: (n: number) => string = n => String(n),
): string {
  const base = String(p?.unit ?? '');
  const u = primaryUnitOf(p);
  return u ? `${u.name} (${fmt(Number(u.factor))} ${base})` : base;
}

/**
 * كمية بالأساس للعرض: «٢ كرتون و٣ حبة» لصنفٍ له وحدات، وإلّا الرقم كما كان (ومعه اسم الأساس إن طُلب).
 * `fmt` منسّق أرقام الشاشة — يُطبَّق على أرقام formatQty وحدها لا على أسماء الوحدات.
 * وللصنف ذي الوحدة الرئيسية يقف عندها: «52 كرتون و2 قارورة»، والصفر «0 كرتون» (D4).
 */
export function baseQtyText(
  baseQty: number,
  p: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null } | null | undefined,
  fmt: (n: number) => string,
  opts: { withUnit?: boolean } = {},
): string {
  const n = Number(baseQty) || 0;
  const base = String(p?.unit ?? '');
  if (p && hasBigUnit(p.units)) {
    return formatQty(n, p.units ?? [], base, primaryUnitOf(p)).replace(/\d+(?:\.\d+)?/g, m => fmt(Number(m)));
  }
  return opts.withUnit && base ? `${fmt(n)} ${base}` : fmt(n);
}

/**
 * كمية بند مستندٍ بوحدته: «٢ كرتون» حين البند بغير الأساس، والرقم وحده لبند الأساس — كالكشف المطبوع
 * (PrintableStatement) حرفاً، فصنفٌ بلا وحدات يُعرض كما كان.
 *
 * ولصنفٍ له وحدة رئيسية (R2) يُلحق اسم الوحدة **دائماً** («×5 قارورة»): «×5» وحدها تُقرأ كراتين. الشرط قيمةٌ صادقة
 * (`!!primaryUnitId`) لا حضور المفتاح — D18 يجعل `primaryUnitId: null` حاضراً في كل select، و`null` = القائم حرفاً.
 * يُقرأ من البند (`it.primaryUnitId`) أو من صنفه (`it.product.primaryUnitId`)، أيّهما مرّره المستدعي.
 */
export function docQtyText(
  it: {
    qty: number | string; unitName?: string | null; unitFactor?: number | null; unit?: string | null;
    primaryUnitId?: string | null; product?: { primaryUnitId?: string | null } | null;
  },
  fmt: (n: number) => string,
): string {
  const unit = (it.unitName || it.unit || '').trim();
  const always = !!(it.primaryUnitId || it.product?.primaryUnitId);
  return `${fmt(Number(it.qty))}${(always || factorOf(it) !== 1) && unit ? ` ${unit}` : ''}`;
}

/**
 * مجموع كميات بنودٍ **لكل وحدة** («٢ كرتون · ٥ حبة») — جمع كرتونٍ وحبّةٍ رقماً واحداً كذب. والمفتاح اسم وحدة البند
 * (لقطته، وإلا وحدة الصنف)، فصنفٌ بلا وحدات يُجمع تحت اسم وحدته كما كان.
 */
export function totalsByUnit(items: Array<{ qty: number | string; unitName?: string | null; unit?: string | null }>, fallback: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const u = (it.unitName || it.unit || '').trim() || fallback;
    m.set(u, (m.get(u) || 0) + (Number(it.qty) || 0));
  }
  return m;
}

// ═══════════════ أسطر النماذج: وحدة السطر ═══════════════

/** مفتاح سطر (صنف، وحدة) — كرتونٌ وحبّةٌ من الصنف نفسه سطران لا سطرٌ يُعدَّلان معاً */
export function lineKey(l: { productId: string; unitId?: string | null }): string {
  return `${l.productId}:${l.unitId ?? ''}`;
}

/**
 * وحدةٌ أخذها سطرٌ آخر للصنف نفسه؟ — المنتقي يعطّلها: سطران بوحدةٍ واحدة لصنفٍ واحد يتنازعان الكمية.
 * `exceptKey` مفتاح السطر نفسه (وحدته الحالية لا تُعدّ مأخوذة).
 */
export function unitTaken(lines: Array<{ productId: string; unitId?: string | null }>, productId: string, unitId: string | null, exceptKey?: string): boolean {
  return lines.some(l => l.productId === productId && lineKey(l) !== exceptKey && (l.unitId ?? null) === (unitId ?? null));
}

/**
 * سطر الاقتراح: المحرّك يُخرج الكمية **بالأساس** (٤٨ حبة). فيُحمَّل بأكبر وحدةٍ تنقسم عليها الكمية تماماً (٢ كرتون)،
 * وإلّا بالأساس كما هي — لا تقريب إلى كرتونٍ كامل يغيّر الرقم المقترح بصمت. (و`suggestedQty`/`expectedQty` تُرسل
 * بالأساس دائماً مهما كانت وحدة السطر — قياس الدقّة في الخادم يقارنهما بالمحمَّل بالأساس.)
 * ولصنفٍ له وحدة رئيسية (R7): المرشّحات وحداتٌ معاملها ≤ معامل الرئيسية — فلا قفز إلى طبليةٍ أكبر منها
 * («1200» تُحمَّل «50 كرتون» لا «1 طبلية»). وبلا رئيسية القائم حرفاً.
 */
export function suggestionChoice(p: UnitProduct, baseQty: number): { choice: UnitChoice; qty: number } {
  const base = Number(baseQty) || 0;
  const all = unitChoices(p);
  const prim = primaryUnitOf(p);
  const cap = prim ? Number(prim.factor) : Infinity;
  const pick = all
    .filter(c => c.id && c.factor > 1 && c.factor <= cap)
    .sort((a, b) => b.factor - a.factor)
    .find(c => {
      const n = base / c.factor;
      return n >= 1 - QTY_EPS && Math.abs(n - Math.round(n)) < QTY_EPS;
    });
  return pick ? { choice: pick, qty: Math.round(base / pick.factor) } : { choice: all[0], qty: base };
}

// ═══════════════ محرّر وحدات الصنف ═══════════════

/** حقول نموذج وحدةٍ كما كُتبت — نصوصٌ من الخانات */
export interface UnitForm { name: string; factor: string; price: string; unitCode: string }

export const EMPTY_UNIT_FORM: UnitForm = { name: '', factor: '', price: '', unitCode: '' };

/** نموذج وحدةٍ قائمة للتعديل */
export function unitFormOf(u: UnitDef): UnitForm {
  return { name: u.name, factor: String(u.factor), price: u.price == null ? '' : String(u.price), unitCode: u.unitCode ?? '' };
}

/** رقمٌ من خانة: الأرقام الهندية والفاصلة العربية تُقرأ كاللاتينية، والفارغ null */
function readNum(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * سبب رفض وحدةٍ قبل إرسالها، أو null — قاعدة الخادم نفسها (`unitProblem`) والأساس بين «الأخريات»: لا وحدة باسم الأساس
 * ولا بمعامل ١ (هي الأساس نفسه). `editingId` الوحدة المعدَّلة لا تُقارَن بنفسها. والخادم يتحقّق ثانيةً — هذا لتسبق
 * الرسالةُ الطلب.
 */
export function unitFormProblem(form: UnitForm, product: { unit: string; units?: UnitDef[] | null }, editingId?: string | null): string | null {
  const factor = readNum(form.factor);
  const price = readNum(form.price);
  if (price !== null && Number.isNaN(price)) return 'سعر الوحدة رقم موجب';
  if (String(form.unitCode ?? '').trim().length > 16) return 'رمز الوحدة الضريبي 16 حرفا على الأكثر';
  // المعامل ١ هو الأساس نفسه — رسالةٌ تقول ذلك بدل «يوجد وحدة بالمعامل نفسه» التي لا يفهم منها المالك أين الوحدة الأخرى
  if (factor !== null && Math.abs(factor - 1) < QTY_EPS) return 'معامل الوحدة الإضافية أكبر من 1 — المعامل 1 هو وحدة الأساس نفسها';
  const others: UnitDef[] = [
    { name: product.unit, factor: 1 },
    ...(product.units ?? []).filter(u => !editingId || u.id !== editingId),
  ];
  return unitProblem({ name: form.name, factor: factor ?? NaN, price: price ?? null }, others);
}

/** حمولة الإضافة/التعديل: السعر الفارغ null (يُشتقّ من سعر الأساس × المعامل)، والرمز الفارغ null */
export function unitFormPayload(form: UnitForm): { name: string; factor: number; price: number | null; unitCode: string | null } {
  const price = readNum(form.price);
  return {
    name: form.name.trim(),
    factor: Math.round(Number(readNum(form.factor))),
    price: price === null || Number.isNaN(price) ? null : price,
    unitCode: form.unitCode.trim() || null,
  };
}

// ═══════════════ تحويل وحدة الأساس إلى أصغر منها ═══════════════

/** حقول نافذة التحويل كما كُتبت */
export interface ConvertForm { newBaseName: string; factor: string; basePrice: string }

/**
 * سبب رفض التحويل قبل إرساله، أو null — مرآة `baseConversionProblem` في الخادم (routes/products.ts) والخادم الحَكَم.
 * المعامل صحيحٌ ≥ ٢ (الأساس الجديد أصغر من الحالي)، والاسم جديدٌ على الصنف، ولا وحدة قائمة باسم الأساس الحالي
 * (تصير الوحدة الحالية وحدةً باسمها)، ولا تتجاوز وحدةٌ قائمة الحدّ بعد ضرب معاملها.
 */
export function convertFormProblem(form: ConvertForm, product: { unit: string; units?: UnitDef[] | null }): string | null {
  const f = readNum(form.factor);
  if (f === null || Number.isNaN(f) || Math.abs(f - Math.round(f)) > QTY_EPS || Math.round(f) < 2) {
    return 'معامل التحويل عدد صحيح أكبر من 1 — كم وحدة أساس جديدة في الوحدة الحالية';
  }
  const F = Math.round(f);
  if (F > MAX_UNIT_FACTOR) return 'معامل التحويل كبير جدا';
  const name = form.newBaseName.trim();
  if (!name) return 'اسم وحدة الأساس الجديدة مطلوب';
  if (name.length > 24) return 'اسم الوحدة طويل';
  const units = product.units ?? [];
  if (name === product.unit.trim()) return 'وحدة الأساس الجديدة هي الحالية نفسها';
  if (units.some(u => u.name.trim() === name)) return 'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف';
  if (units.some(u => u.name.trim() === product.unit.trim())) return 'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف';
  if (units.some(u => Number(u.factor) * F > MAX_UNIT_FACTOR)) return 'معامل إحدى الوحدات يتجاوز الحد بعد التحويل';
  const bp = readNum(form.basePrice);
  if (bp !== null && (Number.isNaN(bp) || bp < 0)) return 'سعر الوحدة رقم موجب';
  return null;
}

/** أربع منازل كتقريب الخادم لسعر الأساس الجديد (round4(oldBasePrice ÷ F)) */
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

/**
 * ما سيحدث بالتحويل كما يكتبه الخادم — للمعاينة في نافذة التأكيد بلغة المالك:
 *  · الوحدة الحالية تصير وحدةً بمعامل F **بسعرها الحالي** (فسعر الكرتون لا يتغيّر)،
 *  · ووحدات الصنف القائمة تُضرب معاملاتها بـF (طبليةٌ = ٥٠ كرتون ⇒ ١٢٠٠ حبة)،
 *  · وسعر الأساس الجديد ما كتبه المالك، وإلّا السعر الحالي ÷ F بأربع منازل.
 */
export function convertPreview(product: { unit: string; basePrice: number | string; units?: UnitDef[] | null }, form: ConvertForm): {
  factor: number; newBaseName: string; newBasePrice: number;
  oldAsUnit: { name: string; factor: number; price: number };
  scaled: { name: string; from: number; to: number }[];
} | null {
  if (convertFormProblem(form, product)) return null;
  const F = Math.round(Number(readNum(form.factor)));
  const old = Number(product.basePrice) || 0;
  const bp = readNum(form.basePrice);
  return {
    factor: F,
    newBaseName: form.newBaseName.trim(),
    newBasePrice: bp === null ? round4(old / F) : Number(bp),
    oldAsUnit: { name: product.unit, factor: F, price: old },
    scaled: (product.units ?? []).map(u => ({ name: u.name, from: Number(u.factor), to: Number(u.factor) * F })),
  };
}

/** حمولة التحويل: `expectedBaseName` الأساس كما رآه المالك حين فتح النافذة — نقرةٌ ثانية بعد الالتزام تُردّ ٤٠٩ */
export function convertPayload(form: ConvertForm, expectedBaseName: string): { newBaseName: string; factor: number; expectedBaseName: string; basePrice?: number } {
  const bp = readNum(form.basePrice);
  return {
    newBaseName: form.newBaseName.trim(),
    factor: Math.round(Number(readNum(form.factor))),
    expectedBaseName,
    ...(bp !== null && !Number.isNaN(bp) && { basePrice: bp }),
  };
}

// ═══════════════ «الوحدة الرئيسية»: صنفٌ يُعرَّف بالكرتون وفيه وحدةٌ أصغر ═══════════════
// الحساب الداخلي لا ينقلب (القاعدة ١٢): الفرعية (قارورة) هي Product.unit/basePrice، والرئيسية (كرتون) وحدةٌ بمعامل F
// وسعرٍ صريح على صفّها (فلا يزحف)، و`primaryUnitName` يجعلها رئيسية في طلب POST /products واحد ذرّي (D10).

/** خانات نموذج «أعرّف الصنف بالكرتون» كما كُتبت — نصوصٌ من الخانات */
export interface ReverseForm {
  /** الوحدة الرئيسية (كرتون) */
  primaryName: string;
  /** سعر الرئيسية قبل الضريبة — إلزامي */
  primaryPrice: string;
  /** الوحدة الفرعية (قارورة) = Product.unit */
  subName: string;
  /** كم فرعية في الرئيسية */
  factor: string;
  /** سعر الفرعية الواحدة — فارغٌ ⇒ derivedBasePrice(سعر الرئيسية، المعامل) */
  subPrice: string;
  /** رمز الوحدة الضريبي للرئيسية (ProductUnit.unitCode) ثم للفرعية (Product.unitCode) */
  primaryUnitCode: string;
  subUnitCode: string;
}

export const EMPTY_REVERSE_FORM: ReverseForm = { primaryName: '', primaryPrice: '', subName: '', factor: '', subPrice: '', primaryUnitCode: '', subUnitCode: '' };

/**
 * سبب رفض النموذج قبل إرساله، أو null — والخادم يتحقّق ثانيةً (unitProblem وPRIMARY_UNIT_INVALID). الرسائل مفاتيح
 * القاموس (tr في الشاشة)، وبلا كلمة «الأساس» (D21).
 */
export function reverseFormProblem(f: ReverseForm): string | null {
  const pn = String(f.primaryName ?? '').trim();
  const sn = String(f.subName ?? '').trim();
  if (!pn) return 'اسم الوحدة الرئيسية مطلوب';
  if (!sn) return 'اسم الوحدة الفرعية مطلوب';
  if (pn.length > 24 || sn.length > 24) return 'اسم الوحدة طويل';
  if (pn === sn) return 'الوحدة الرئيسية والفرعية باسمين مختلفين';
  const F = readNum(f.factor);
  if (F === null || Number.isNaN(F) || Math.abs(F - Math.round(F)) > QTY_EPS || Math.round(F) < 2 || Math.round(F) > MAX_UNIT_FACTOR) {
    return 'عدد الوحدات الفرعية في الرئيسية عدد صحيح من 2 إلى 100000';
  }
  const pp = readNum(f.primaryPrice);
  if (pp === null) return 'سعر الوحدة الرئيسية مطلوب';
  if (Number.isNaN(pp) || pp < 0) return 'سعر الوحدة رقم موجب';
  const sp = readNum(f.subPrice);
  if (sp !== null && (Number.isNaN(sp) || sp < 0)) return 'سعر الوحدة رقم موجب';
  if (String(f.primaryUnitCode ?? '').trim().length > 16 || String(f.subUnitCode ?? '').trim().length > 16) return 'رمز الوحدة الضريبي 16 حرفا على الأكثر';
  return null;
}

/** سعر الفرعية كما سيُحفظ: المكتوب، وإلّا المشتقّ من سعر الرئيسية (D10) — للمعاينة الحيّة وplaceholder «≈ … محسوب» */
export function reverseSubPrice(f: ReverseForm): number {
  const sp = readNum(f.subPrice);
  if (sp !== null && !Number.isNaN(sp)) return sp;
  return derivedBasePrice(Number(readNum(f.primaryPrice)), Math.round(Number(readNum(f.factor))));
}

/**
 * حقول الوحدة في جسم إنشاء الصنف (POST /products، §2.2-ب): الفرعية `unit` وسعرها `basePrice` (null ⇒ يشتقّه الخادم
 * بـderivedBasePrice نفسها)، والرئيسية وحدةٌ بسعرها الصريح، و`primaryUnitName` اسمها. المستدعي يدمجها **فوق** بقية حقول
 * النموذج (الاسم والرمز والضريبة…) فتغلب `unit`/`basePrice`/`unitCode` المخفيّة. يُستدعى بعد `reverseFormProblem` = null.
 */
export function reverseCreatePayload(f: ReverseForm): {
  unit: string; basePrice: number | null; unitCode: string | null;
  units: { name: string; factor: number; price: number; unitCode: string | null }[];
  primaryUnitName: string;
} {
  const sp = readNum(f.subPrice);
  const pn = f.primaryName.trim();
  return {
    unit: f.subName.trim(),
    basePrice: sp === null || Number.isNaN(sp) ? null : sp,
    unitCode: f.subUnitCode.trim() || null,
    units: [{ name: pn, factor: Math.round(Number(readNum(f.factor))), price: Number(readNum(f.primaryPrice)), unitCode: f.primaryUnitCode.trim() || null }],
    primaryUnitName: pn,
  };
}

/**
 * رقعة «حفظ التعديلات» لصنفٍ له رئيسية (PUT /products/:id، §2.2-هـ): الفرعية `unit`/`basePrice`/`unitCode`، والرئيسية
 * `primaryUnit` بمعرّفها كما رآه النموذج (`primaryId` — رئيسيةٌ تغيّرت بعد فتحه ⇒ 409 PRIMARY_UNIT_CHANGED)، فيُحفظ الكلّ
 * ذرّياً. سعر الفرعية الفارغ ⇒ `derivedBasePrice` صريحاً (§4.2). و`expectedBaseName` يضيفه المستدعي (الأساس المحفوظ).
 */
export function reverseEditPatch(f: ReverseForm, primaryId: string): {
  unit: string; basePrice: number; unitCode: string | null;
  primaryUnit: { id: string; name: string; factor: number; price: number; unitCode: string | null };
} {
  return {
    unit: f.subName.trim(),
    basePrice: reverseSubPrice(f),
    unitCode: f.subUnitCode.trim() || null,
    primaryUnit: {
      id: primaryId, name: f.primaryName.trim(), factor: Math.round(Number(readNum(f.factor))),
      price: Number(readNum(f.primaryPrice)), unitCode: f.primaryUnitCode.trim() || null,
    },
  };
}

/**
 * النموذج من صنفٍ قائم له رئيسية صالحة (`primaryUnitOf`)، أو null بلاها. سعر الرئيسية سعرها الفعلي (`primaryPriceOf`:
 * المحدَّد وإلّا القارورة × المعامل)، وسعر الفرعية **فارغٌ** حين يساوي المشتقّ منه — فصنفٌ حُوِّل بكرتونٍ 16.33 ÷ 8
 * (سعر القارورة 2.0413 بخطوة التحويل الخامسة) يُعرض مشتقّاً لا صريحاً، ولا يتجمّد سعرٌ مشتقّ حين يُعدَّل سعر الكرتون.
 */
export function reverseFormOf(p: {
  unit?: string | null; basePrice: number | string; unitCode?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null;
} | null | undefined): ReverseForm | null {
  if (!p) return null;
  const u = primaryUnitOf(p);
  if (!u) return null;
  const F = Math.round(Number(u.factor));
  const pp = primaryPriceOf(p) ?? 0;
  const bp = Number(p.basePrice);
  const derived = Number.isFinite(bp) && Math.abs(bp - derivedBasePrice(pp, F)) < 1e-9;
  return {
    primaryName: u.name, primaryPrice: String(pp), subName: String(p.unit ?? ''), factor: String(F),
    subPrice: derived || !Number.isFinite(bp) ? '' : String(bp), primaryUnitCode: u.unitCode ?? '', subUnitCode: p.unitCode ?? '',
  };
}
