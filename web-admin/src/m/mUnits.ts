/**
 * الوحدات المتعددة في تطبيق الإدارة على الجوال — نقيٌّ بلا React ولا شبكة، يُختبر وحده (mUnits.test.ts).
 *
 * لا حساب هنا: كل كميةٍ وسعرٍ من `lib/units.ts` (مرآة الخادم حرفياً) ومن `rep/repUnits.ts` (وحدة البند وسعرها في
 * تطبيق المندوب، والشاشات هنا نظيرتها). وما يخصّ الجوال وحده ثلاثة:
 *  1. **العرض**: رصيدٌ بالأساس يُعرض «٢ كرتون و٣ حبة» لصنفٍ له وحدات، ورقمه كما كان لغيره حرفاً.
 *  2. **أسطر التحميل والوارد**: سطرٌ لكل (صنف، وحدة)، و`unitId` يُرسَل مع البند — والتقسيم إلى تحميلٍ وتنزيل يبقى
 *     لـ`splitVanMovement` وحدها (إشارة النوعين معكوسة، وقاعدةٌ ثانية للتقسيم تتباعد عنها بصمت).
 *  3. **الشرائح**: حدودها وسعرها **بوحدة الأساس** (القاعدتان ٤ و٥) — تُقرأ من عموديها بالأساس وتُكتب فيهما.
 *
 * ═══ الفخّ الحاكم ═══
 * رقمٌ بالأساس بجانب اسم وحدةٍ أكبر يُقرأ خطأً ٢٤ ضعفاً: «المتبقي ٤٨ كرتون» عن ٤٨ حبة تقود إلى تحميلٍ خاطئ. فكلّ رقمٍ
 * بالأساس يُعرض إمّا مفكَّكاً بوحداته وإمّا بجانب اسم الأساس — لا بجانب اسم وحدة السطر أبداً.
 */
import { formatQty, factorOf, roundQty, QTY_EPS, type UnitDef } from '../lib/units';
import { splitVanMovement } from '../lib/vanMovement';
import { qtyByUnit, unitTotalsText } from '../rep/warehouseNoticeFacts';
import { unitChoices, type UnitChoice, type UnitProduct } from '../rep/repUnits';

/** للصنف وحدةٌ نشطة أكبر من الأساس؟ — بلا شرط المعرّف: وحدات التقارير تصل بالاسم والمعامل وحدهما */
export function hasBigUnit(units: UnitDef[] | null | undefined): boolean {
  return (units ?? []).some(u => u && Number(u.factor) > 1 && u.isActive !== false);
}

/**
 * كمية بالأساس للعرض: «٢ كرتون و٣ حبة» لصنفٍ له وحدات، وإلّا الرقم كما كان ومعه اسم الأساس إن طُلب.
 * `num` منسّق أرقام الشاشة (شكل الأرقام في خيار الشركة) — يُطبَّق على أرقام formatQty وحدها لا على أسماء الوحدات.
 */
export function qtyText(
  baseQty: number,
  p: { unit?: string | null; units?: UnitDef[] | null } | null | undefined,
  num: (n: number) => string,
  opts: { withUnit?: boolean } = {},
): string {
  const n = Number(baseQty) || 0;
  const base = String(p?.unit ?? '');
  if (p && hasBigUnit(p.units)) {
    return formatQty(n, p.units ?? [], base).replace(/\d+(?:\.\d+)?/g, m => num(Number(m)));
  }
  return opts.withUnit && base ? `${num(n)} ${base}` : num(n);
}

/** كمية بالأساس بإشارةٍ صريحة (التسوية): «+٢ كرتون» و«−٣ حبة» — والصفر بلا إشارة */
export function signedQtyText(baseQty: number, p: { unit?: string | null; units?: UnitDef[] | null } | null | undefined, num: (n: number) => string): string {
  const n = roundQty(Number(baseQty) || 0);
  if (n === 0) return qtyText(0, p, num);
  return `${n < 0 ? '−' : '+'}${qtyText(Math.abs(n), p, num)}`;
}

// ═══════════════ أسطر التحميل والوارد: سطرٌ لكل (صنف، وحدة) ═══════════════

/** لقطة وحدة سطرٍ في نموذج التحميل/الوارد — ومعها وحدات الصنف لعرض رصيده بالأساس */
export interface StockLineUnit {
  /** null لوحدة الأساس — فلا يُرسَل unitId ويبقى الجسم كما قبل الميزة */
  unitId: string | null;
  /** اسم وحدة السطر كما يُعرض (اسم الأساس لوحدة الأساس) */
  unit: string;
  unitFactor: number;
  /** وحدة الأساس ووحدات الصنف — لعرض الرصيد بالأساس لا بوحدة السطر */
  baseUnit: string;
  units: UnitDef[];
}

/** وحدة السطر من اختيارٍ من وحدات الصنف */
export function stockLineUnit(p: UnitProduct, c: UnitChoice): StockLineUnit {
  return {
    unitId: c.id, unit: c.name, unitFactor: c.id ? c.factor : 1,
    baseUnit: String(p.unit ?? ''), units: Array.isArray(p.units) ? p.units : [],
  };
}

/** مفتاح السطر: الصنف بوحدته — كرتونٌ وحبّةٌ من الصنف نفسه سطران لا سطرٌ يُعدَّلان معاً */
export function lineKey(l: { productId: string; unitId?: string | null }): string {
  return `${l.productId}:${l.unitId ?? ''}`;
}

/**
 * الوحدات التي لم يأخذها سطرٌ للصنف بعد — «إضافة وحدة أخرى» تقدّم أولاها، والمنتقي يعطّل المأخوذة:
 * سطران بوحدةٍ واحدة لصنفٍ واحد يتنازعان الكمية.
 */
export function freeChoices(p: UnitProduct, lines: { productId: string; unitId?: string | null }[], productId: string, exceptKey?: string): UnitChoice[] {
  const taken = new Set(lines.filter(l => l.productId === productId && lineKey(l) !== exceptKey).map(l => l.unitId ?? null));
  return unitChoices(p).filter(c => !taken.has(c.id));
}

/** بند تحميلٍ كما يُرسَل: `unitId` للبند بغير وحدة الأساس وحده — بند الأساس حرفياً كما قبل الميزة */
export interface LoadItem { productId: string; qty: number; unitId?: string; suggestedQty?: number; expectedQty?: number }

/**
 * تقسيم أسطر الشاشة إلى وثيقتَي تحميلٍ وتنزيل **بوحدة كل سطر**.
 *
 * `splitVanMovement` المصدر الوحيد للإشارة والقلب والإسقاط، وصارت تحمل الوحدة في الشقّين — فهذه واجهةٌ رقيقة
 * عليها بنوع الجوال لا نسخةٌ ثانية من قاعدة التقسيم تتباعد عنها.
 */
export function splitLoadRows(rows: Array<{ productId: string; qty: number; unitId?: string | null; suggestedQty?: number; expectedQty?: number }>): { out: LoadItem[]; back: LoadItem[] } {
  const s = splitVanMovement(rows);
  return { out: s.out, back: s.back };
}

/**
 * سطر الاقتراح: المحرّك يُخرج الكمية **بالأساس** (٤٨ حبة). فيُحمَّل بأكبر وحدةٍ تنقسم عليها الكمية تماماً (٢ كرتون)،
 * وإلّا بالأساس كما هي — لا تقريب إلى كرتونٍ كامل يغيّر الرقم المقترح بصمت. و`suggestedQty`/`expectedQty` بالأساس
 * دائماً مهما كانت وحدة السطر (DESIGN «قرارات أثناء التنفيذ»): قياس الدقّة في الخادم يقارنهما بالمحمَّل بالأساس.
 */
export function suggestionLine(r: { unit: string; units?: UnitDef[] | null; suggested: number; expected: number }): StockLineUnit & { qty: number; suggestedQty: number; expectedQty: number } {
  const p: UnitProduct = { unit: r.unit, units: r.units ?? [] };
  const base = Number(r.suggested) || 0;
  const pick = unitChoices(p)
    .filter(c => c.id && c.factor > 1)
    .sort((a, b) => b.factor - a.factor)
    .find(c => {
      const n = base / c.factor;
      return n >= 1 - QTY_EPS && Math.abs(n - Math.round(n)) < QTY_EPS;
    });
  const c = pick ?? unitChoices(p)[0];
  return {
    ...stockLineUnit(p, c),
    qty: pick ? Math.round(base / pick.factor) : base,
    suggestedQty: base,
    expectedQty: Number(r.expected) || 0,
  };
}

// ═══════════════ مجموع حركةٍ مختلطة الوحدات ═══════════════

/**
 * إجمالي كميات حركة سيارة (/van-stock/movements) لكل وحدة: «٢ كرتون · ٥ حبة» — و`null` حين بنودها كلّها بالأساس
 * فيبقى المجموع الرقميّ كما كان حرفاً. معامل البند من كميته بالأساس التي يرسلها الخادم معه (`baseQty ÷ qty`).
 */
export function movementQtyText(items: Array<{ qty: number; unit?: string; baseQty?: number | null }>, num: (n: number) => string): string | null {
  const lines = items.map(i => {
    const q = Number(i.qty);
    const f = i.baseQty != null && q ? roundQty(Number(i.baseQty) / q) : 1;
    return { qty: q, unit: i.unit, unitFactor: f };
  });
  const rows = qtyByUnit(lines, q => Math.abs(q));
  return rows ? unitTotalsText(rows, num) : null;
}

// ═══════════════ شرائح السعر بالأساس ═══════════════

/** شريحة كما يردّها الخادم: العمودان القديمان للعرض القديم، و`base*` حدودها بالأساس (القاعدة ٥) */
export interface TierIn { minQty: number; maxQty?: number | null; baseMinQty?: number | null; baseMaxQty?: number | null; price: number }

/**
 * حدود الشريحة بالأساس. والشريحة التي لم يملأها الترحيل بعد (`baseMinQty = 0` و`minQty ≠ 0`) تُقرأ من القديمين —
 * الشرط نفسه في مُطلِق الترحيل وتحويل الأساس (backfillBaseQty، convert-base)، فلا تُقرأ «من صفر» فتسري على كل كمية.
 */
export function tierBaseBounds(t: TierIn): { min: number; max: number | null } {
  const bm = t.baseMinQty == null ? null : Number(t.baseMinQty);
  const min = bm != null && Number.isFinite(bm) && !(bm === 0 && Number(t.minQty) !== 0) ? bm : Number(t.minQty) || 0;
  const max = t.baseMaxQty != null ? Number(t.baseMaxQty) : t.maxQty == null ? null : Number(t.maxQty);
  return { min, max: max != null && Number.isFinite(max) ? max : null };
}

/**
 * الشريحة كما تُكتب: الحدود بالأساس في العمودين معاً (القاعدة ٥ — `minQty` «بوحدة الصنف وقت إنشائها» وهي الأساس الآن)،
 * والسعر لوحدة الأساس. والحدّ الأعلى الفارغ يُحذف مفتاحاه: `maxQty` عند الخادم optional لا nullish، وnull يُسقط الطلب.
 */
export function tierPayload(min: number, max: number | null, price: number): { minQty: number; baseMinQty: number; price: number; maxQty?: number; baseMaxQty?: number } {
  return { minQty: min, baseMinQty: min, price, ...(max != null && { maxQty: max, baseMaxQty: max }) };
}

/** أكبر وحدةٍ نشطة للصنف — لتلميح «سعر الكرتون» بجانب سعر الأساس، أو null */
export function biggestUnit(units: UnitDef[] | null | undefined): UnitDef | null {
  const big = (units ?? []).filter(u => u && Number(u.factor) > 1 && u.isActive !== false);
  return big.length ? big.reduce((a, b) => (Number(b.factor) > Number(a.factor) ? b : a)) : null;
}

// ═══════════════ بنود المستندات ═══════════════

/** بند فاتورة في كشف الحساب: «الاسم ×٢ كرتون» حين بندُه بغير الأساس — كالكشف المطبوع (PrintableStatement) حرفاً */
export function statementItemText(it: { qty: number | string; unitName?: string | null; unitFactor?: number | null; product?: { name?: string; unit?: string } | null }, num: (n: number) => string): string {
  const unit = it.unitName || it.product?.unit || '';
  return `${it.product?.name ?? '-'} ×${num(Number(it.qty))}${factorOf(it) !== 1 && unit ? ` ${unit}` : ''}`;
}
