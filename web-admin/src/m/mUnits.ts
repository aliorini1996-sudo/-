/**
 * الوحدات المتعددة في تطبيق الإدارة على الجوال — نقيٌّ بلا React ولا شبكة، يُختبر وحده (mUnits.test.ts).
 *
 * لا حساب هنا: كل كميةٍ وسعرٍ من `lib/units.ts` (مرآة الخادم حرفياً) ومن `rep/repUnits.ts` (وحدة البند وسعرها في
 * تطبيق المندوب، والشاشات هنا نظيرتها). وما يخصّ الجوال وحده أربعة:
 *  1. **العرض**: رصيدٌ بالأساس يُعرض «٢ كرتون و٣ حبة» لصنفٍ له وحدات، ورقمه كما كان لغيره حرفاً.
 *  2. **أسطر التحميل والوارد**: سطرٌ لكل (صنف، وحدة)، و`unitId` يُرسَل مع البند — والتقسيم إلى تحميلٍ وتنزيل يبقى
 *     لـ`splitVanMovement` وحدها (إشارة النوعين معكوسة، وقاعدةٌ ثانية للتقسيم تتباعد عنها بصمت).
 *  3. **بنود الفاتورة**: مفتاح البند (الصنف + الوحدة) وسعر الوحدة صافياً — بند الأساس كما قبل الميزة حرفاً.
 *  4. **الشرائح**: حدودها وسعرها **بوحدة الأساس** (القاعدتان ٤ و٥) — تُقرأ من عموديها بالأساس وتُكتب فيهما.
 *
 * ═══ الفخّ الحاكم ═══
 * رقمٌ بالأساس بجانب اسم وحدةٍ أكبر يُقرأ خطأً ٢٤ ضعفاً: «المتبقي ٤٨ كرتون» عن ٤٨ حبة تقود إلى تحميلٍ خاطئ. فكلّ رقمٍ
 * بالأساس يُعرض إمّا مفكَّكاً بوحداته وإمّا بجانب اسم الأساس — لا بجانب اسم وحدة السطر أبداً.
 */
import { formatQty, factorOf, roundQty, unitProblem, QTY_EPS, MAX_UNIT_FACTOR, type UnitDef } from '../lib/units';
import { splitVanMovement } from '../lib/vanMovement';
import { qtyByUnit, unitTotalsText } from '../rep/warehouseNoticeFacts';
import { unitChoices, defaultChoice, choiceNet, lineUnitOf, refreshLineUnit, type UnitChoice, type UnitProduct } from '../rep/repUnits';
import type { Line } from './docMath';

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

/**
 * وحدات الصنف الأكبر مختصرةً لسطر القائمة: «كرتون ٢٤ · طبلية ١٢٠٠» — النشطة وحدها تصاعدياً، وفارغٌ لصنفٍ بلا وحدات
 * فيبقى سطره كما كان حرفاً. المعامل بجانب الاسم لأن «كرتون» عند صنفٍ ١٢ وعند آخر ٢٤.
 */
export function unitsBrief(units: UnitDef[] | null | undefined, num: (n: number) => string): string {
  return (units ?? [])
    .filter(u => u && Number(u.factor) > 1 && u.isActive !== false)
    .sort((a, b) => Number(a.factor) - Number(b.factor))
    .map(u => `${u.name} ${num(Number(u.factor))}`)
    .join(' · ');
}

// ═══════════════ بنود الفاتورة: بندٌ لكل (صنف، وحدة) ═══════════════

/** الصنف كما يصل من /products لشاشة الفاتورة — `units` تصل مع القائمة (النشطة والموقوفة، والمنتقي يُسقط الموقوفة) */
export interface SalePick extends UnitProduct {
  id: string; name: string;
  /** سعر وحدة الأساس صافياً قبل الضريبة (القاعدة ٤) */
  basePrice?: number | string | null;
  taxPct?: number | null;
}

/** مفتاح البند: الصنف بوحدته — كرتونٌ وحبّةٌ من الصنف نفسه بندان لا بندٌ يُعدَّلان معاً */
export function lineKey(l: { productId: string; unitId?: string | null }): string {
  return `${l.productId}:${l.unitId ?? ''}`;
}

/**
 * بند فاتورة جديد بوحدةٍ مختارة (الافتراض أكبر وحدة — انظر رأس repUnits.ts). السعر سعر **تلك الوحدة** صافياً قبل
 * الضريبة (`choiceNet`): سعرها المحدَّد وإلّا الأساس × المعامل — فكرتونٌ يُضاف بسعر الحبّة يُباع بخسارة ٢٤ ضعفاً بلا تحذير.
 * ولصنفٍ بلا وحدات: سعر الأساس ووحدته كما كان البند قبل الميزة حرفاً.
 */
export function invoiceLine(p: SalePick, c: UnitChoice = defaultChoice(p)): Line {
  return {
    productId: p.id, name: p.name, qty: 1,
    // ⚠️ سعرٌ **قبل** الضريبة — هذا ما يتوقّعه مسار الأدمن (docMath.ts)
    unitPrice: choiceNet(c, p.basePrice ?? 0),
    discountPct: 0,
    taxPct: Number(p.taxPct ?? 15),
    // ومعها أساس الصنف كما رآه هذا الجهاز: تحويلٌ للأساس بعد فتح القائمة يُكشف بـ400 UNIT_INVALID لا يُقيَّد بغير ما رُئي
    ...lineUnitOf(c, p.unit),
  };
}

/** إضافة الصنف بوحدة: بندٌ قائم بالوحدة نفسها يزيد واحداً، وإلّا بندٌ جديد — «+١ حبة» لا تُضاف إلى بند كرتون */
export function addInvoiceLine(lines: Line[], p: SalePick, c: UnitChoice = defaultChoice(p)): Line[] {
  const key = lineKey({ productId: p.id, unitId: c.id });
  const i = lines.findIndex(l => lineKey(l) === key);
  if (i < 0) return [...lines, invoiceLine(p, c)];
  const n = [...lines];
  n[i] = { ...n[i], qty: n[i].qty + 1 };
  return n;
}

/**
 * تبديل وحدة البند — **ويُعاد تسعيره** بسعر الوحدة الجديدة: سعر الحبّة المكتوب على بندٍ صار كرتوناً يبيعه بخسارة ٢٤ ضعفاً.
 * والوحدة التي أخذها بندٌ آخر للصنف لا يُنتقل إليها (يتنازع البندان الكمية): القائمة كما هي.
 */
export function setInvoiceLineUnit(lines: Line[], key: string, p: SalePick, c: UnitChoice): Line[] {
  const next = lineKey({ productId: p.id, unitId: c.id });
  if (next !== key && lines.some(l => lineKey(l) === next)) return lines;
  return lines.map(l => (lineKey(l) === key ? { ...l, ...lineUnitOf(c, p.unit), unitPrice: choiceNet(c, p.basePrice ?? 0) } : l));
}

/**
 * بنود صنفٍ بعد وصول وحداته من جديد (ردّ 400 UNIT_INVALID: القائمة على الشاشة قديمة). كل بندٍ يُحلّ بـ`refreshLineUnit`
 * (مرآة تطبيق المندوب): الوحدة بمعرّفها كما هي الآن، وبند الأساس الذي صار اسمه وحدةً (حُوِّل الأساس: كرتون ⇒ حبة) يصير
 * بتلك الوحدة — فـ«٢ كرتون» تبقى كرتونين لا حبّتين، وتحمل أساس الصنف الجديد فلا يُرفض البند ثانيةً.
 * والسعر المكتوب **يبقى** ما لم يتغيّر المعامل (سعر الكرتون هو هو بعد التحويل، وقد عدّله المستخدم يدوياً)؛ ومعاملٌ تغيّر
 * (كرتون ٢٤ صار ١٢) يُعاد تسعيره بسعر الوحدة الآن. وبندٌ لا وحدة صالحة له الآن يبقى كما هو — يختار المستخدم.
 */
export function refreshInvoiceLines(lines: Line[], p: SalePick): Line[] {
  let changed = false;
  const out = lines.map(l => {
    if (l.productId !== p.id) return l;
    const c = refreshLineUnit(l, p);
    if (!c) return l;
    const u = lineUnitOf(c, p.unit);
    const same = (l.unitId ?? null) === u.unitId && l.unit === u.unit && factorOf(l) === u.unitFactor
      && (l.baseUnit ?? '') === u.baseUnit && (l.unitName ?? null) === u.unitName;
    if (same) return l;
    changed = true;
    const reprice = factorOf(l) !== u.unitFactor && !(l.unitId == null && c.id);
    return { ...l, ...u, ...(reprice && { unitPrice: choiceNet(c, p.basePrice ?? 0) }) };
  });
  return changed ? out : lines;
}

/** زيادة كمية بندٍ أو إنقاصها بمفتاحه — والبند الذي يبلغ الصفر يُحذف */
export function stepInvoiceLine(lines: Line[], key: string, d: number): Line[] {
  return lines.map(l => (lineKey(l) === key ? { ...l, qty: Math.max(0, l.qty + d) } : l)).filter(l => l.qty > 0);
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

/**
 * الوحدات التي لم يأخذها سطرٌ للصنف بعد — «إضافة وحدة أخرى» تقدّم أولاها، والمنتقي يعطّل المأخوذة:
 * سطران بوحدةٍ واحدة لصنفٍ واحد يتنازعان الكمية.
 */
export function freeChoices(p: UnitProduct, lines: { productId: string; unitId?: string | null }[], productId: string, exceptKey?: string): UnitChoice[] {
  const taken = new Set(lines.filter(l => l.productId === productId && lineKey(l) !== exceptKey).map(l => l.unitId ?? null));
  return unitChoices(p).filter(c => !taken.has(c.id));
}

/**
 * وحدة السطر الذي تُضيفه نقرة الصنف: أوّل سطرٍ للصنف بوحدته الافتراضية (الأكبر — «خمسون كرتوناً» يُكتب كما كان قبل
 * تحويل الأساس)، وكل نقرةٍ بعدها بأوّل وحدةٍ لم يأخذها سطر (الأساس أولاً: «وحبّات فوقها»). و`null` حين أخذت الأسطرُ
 * وحداته كلّها — ولصنفٍ بلا وحدات بعد سطره الأول، كمنع التكرار قبل الميزة حرفاً.
 */
export function nextStockLineUnit(p: UnitProduct, lines: { productId: string; unitId?: string | null }[], productId: string): StockLineUnit | null {
  const free = freeChoices(p, lines, productId);
  if (!free.length) return null;
  const first = !lines.some(l => l.productId === productId);
  const d = defaultChoice(p);
  return stockLineUnit(p, first && free.some(c => c.id === d.id) ? d : free[0]);
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

// ═══════════════ إدارة وحدات الصنف وتحويل أساسه ═══════════════

/** مسوّدة وحدةٍ في نموذج الجوال — نصوصٌ كما تُكتب («» حالة كتابةٍ وسيطة يمسحها Number) */
export interface UnitDraft { name: string; factor: string; price: string; unitCode: string }

/** المعامل في نموذج الوحدة: صحيحٌ أكبر من ١ — رسالةٌ صريحة بدل «يوجد وحدة بالمعامل نفسه» حين يُكتب ١ */
export const UNIT_FACTOR_HINT = 'المعامل عدد صحيح أكبر من 1 كم وحدة أساس فيها';

/**
 * سبب رفض مسوّدة الوحدة، أو null — `unitProblem` نفسها التي يحرس بها الخادم، و«الأخريات» فيها الأساس بمعامل ١ كما في
 * الخادم (products.ts baseAsUnit): فلا وحدة باسم الأساس ولا بمعامله. والمعامل ١ يُقال صراحةً قبلها.
 * الرسائل مفاتيح القاموس (tr في الشاشة).
 */
export function unitDraftProblem(d: UnitDraft, baseUnit: string, others: UnitDef[]): string | null {
  const f = Number(d.factor);
  if (d.factor.trim() === '' || !Number.isFinite(f) || f < 2 - QTY_EPS) return UNIT_FACTOR_HINT;
  if (d.unitCode.trim().length > 16) return 'رمز الوحدة لا يتجاوز 16 حرفا';
  return unitProblem(
    { name: d.name, factor: f, price: d.price.trim() === '' ? null : Number(d.price) },
    [{ name: baseUnit, factor: 1 }, ...others],
  );
}

/**
 * جسم الوحدة كما يُرسَل (productApi.addUnit/updateUnit): المعامل صحيحٌ مقرَّب، والسعر الفارغ **null صريحاً** (يُشتقّ من
 * الأساس × المعامل) — وغيابه في التعديل كان يعني «لا تغيّره» فيبقى سعرٌ مسحه المستخدم. والرمز الفارغ null كذلك.
 */
export function unitDraftPayload(d: UnitDraft): { name: string; factor: number; price: number | null; unitCode: string | null } {
  return {
    name: d.name.trim(),
    factor: Math.round(Number(d.factor)),
    price: d.price.trim() === '' ? null : Number(d.price),
    unitCode: d.unitCode.trim() || null,
  };
}

/** المسوّدة من وحدةٍ قائمة — للتعديل */
export function unitDraftOf(u: UnitDef | null | undefined): UnitDraft {
  return {
    name: u?.name ?? '',
    factor: u ? String(u.factor) : '',
    price: u?.price == null ? '' : String(u.price),
    unitCode: u?.unitCode ?? '',
  };
}

/**
 * سبب رفض تحويل وحدة الأساس قبل إرساله، أو null — الشروط التي يرفضها الخادم (products.ts baseConversionProblem)
 * فلا تُفتح نافذة تأكيدٍ لطلبٍ سيُرفض. والخادم يبقى الحَكَم (ومعه 409 BASE_UNIT_CHANGED).
 */
export function convertDraftProblem(d: { newBaseName: string; factor: string }, p: { unit: string; units?: UnitDef[] | null }): string | null {
  const name = d.newBaseName.trim();
  if (!name) return 'اسم وحدة الأساس الجديدة مطلوب';
  if (name.length > 24) return 'اسم الوحدة طويل';
  if (name === String(p.unit ?? '').trim()) return 'وحدة الأساس الجديدة هي الحالية نفسها';
  if ((p.units ?? []).some(u => u.name.trim() === name)) return 'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف';
  const f = Number(d.factor);
  if (d.factor.trim() === '' || !Number.isFinite(f) || Math.abs(f - Math.round(f)) > QTY_EPS || Math.round(f) < 2) {
    return 'معامل التحويل عدد صحيح أكبر من 1 كم وحدة أساس جديدة في الوحدة الحالية';
  }
  if ((p.units ?? []).some(u => Number(u.factor) * Math.round(f) > MAX_UNIT_FACTOR) || Math.round(f) > MAX_UNIT_FACTOR) {
    return 'معامل التحويل كبير جدا';
  }
  return null;
}

/** سعر الأساس الجديد الافتراضي بعد التحويل — قسمة سعر الوحدة القديمة على المعامل بأربع منازل كالخادم (convert-base الخطوة ٥) */
export function convertedBasePrice(oldBasePrice: number | string, factor: number): number {
  const p = Number(oldBasePrice);
  const f = Math.round(Number(factor));
  if (!Number.isFinite(p) || !Number.isFinite(f) || f < 1) return 0;
  return Math.round((p / f) * 1e4) / 1e4;
}

// ═══════════════ بنود المستندات ═══════════════

/** بند فاتورة في كشف الحساب: «الاسم ×٢ كرتون» حين بندُه بغير الأساس — كالكشف المطبوع (PrintableStatement) حرفاً */
export function statementItemText(it: { qty: number | string; unitName?: string | null; unitFactor?: number | null; product?: { name?: string; unit?: string } | null }, num: (n: number) => string): string {
  const unit = it.unitName || it.product?.unit || '';
  return `${it.product?.name ?? '-'} ×${num(Number(it.qty))}${factorOf(it) !== 1 && unit ? ` ${unit}` : ''}`;
}
