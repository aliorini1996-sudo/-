/**
 * الوحدات المتعددة في تطبيق المندوب — وحدة البند وسعره وعرض كمياته. نقيٌّ بلا React ولا شبكة،
 * يُختبر وحده (repUnits.test.ts). والحساب كلّه من lib/units.ts (مرآة الخادم حرفياً) لا حسابٌ موازٍ.
 *
 * ═══ لماذا لقطةٌ على البند لا مرجعٌ إلى الوحدة ═══
 * البند قد يُصفّ في صندوق الأوف‑لاين ويُرفع بعد أن غيّر المدير معامل الكرتون أو أوقفه. فيحمل البند
 * `unitId` (يحلّه الخادم في الإصدار الحيّ) ومعه `unitName/unitFactor` كما رآها الجهاز لحظة الإصدار
 * (يقبلها الخادم في إعادة الرفع X-FS-Replay، القاعدة ٧). والبند بلا وحدة = وحدة الأساس بمعامل ١،
 * فجسم الصنف الذي لا وحدات له يُرسَل حرفياً كما قبل الميزة.
 *
 * ═══ الافتراض في البيع = أكبر وحدة ═══
 * بعد تحويل الصنف إلى أساسٍ أصغر (حبة) تصير وحدته القديمة (كرتون) وحدةً بمعامل؛ ولو بقي الافتراض
 * الأساسَ لصار نقر المندوب المعتاد «+١ حبة» بعد أن كان «+١ كرتون» — خطأٌ صامت ٢٤ ضعفاً.
 */
import { factorOf, formatQty, roundQty, sumBase, unitPriceOf, type UnitDef } from '../lib/units';

/** وحدة بيعٍ يختارها المندوب للبند */
export interface UnitChoice {
  /** معرّف ProductUnit — null لوحدة الأساس */
  id: string | null;
  name: string;
  /** وحدات الأساس فيها — ١ للأساس */
  factor: number;
  /** سعرها المحدَّد صافياً — null ⇒ سعر الأساس × المعامل */
  price: number | null;
}

/** الصنف كما يصل من الكتالوج — الكاش القديم بلا `units` يُقرأ صنفاً بوحدةٍ واحدة لا يُخمَّن له */
export interface UnitProduct { unit?: string | null; units?: UnitDef[] | null }

/** لقطة الوحدة على بند السلّة/التحميل/الطلب */
export interface LineUnit {
  /** اسم الوحدة كما يُعرض ويُطبع (اسم الأساس لوحدة الأساس) */
  unit: string;
  unitId: string | null;
  /** null لوحدة الأساس — فالطباعة تقرأ اسم الصنف كما قبل الميزة */
  unitName: string | null;
  unitFactor: number;
  /** سعر الوحدة المحدَّد (لإعادة التسعير حين تصل أسعار العميل) — null ⇒ مشتقّ */
  unitDefPrice: number | null;
}

export function baseChoice(p: UnitProduct | null | undefined): UnitChoice {
  return { id: null, name: String(p?.unit ?? ''), factor: 1, price: null };
}

/**
 * وحدات البند المتاحة: الأساس أوّلاً ثم وحدات الصنف **النشطة** تصاعدياً بالمعامل. الموقوفة لا تُعرض:
 * الخادم يردّ وحدةً موقوفة إلى الأساس، فبيعُ «٢» بها يُقيَّد حبّتين لا كرتونين.
 */
export function unitChoices(p: UnitProduct | null | undefined): UnitChoice[] {
  const extra = (Array.isArray(p?.units) ? p!.units! : [])
    .filter(u => u && u.id && u.isActive !== false && Number.isFinite(Number(u.factor)) && Number(u.factor) > 0)
    .map(u => ({ id: String(u.id), name: String(u.name), factor: Number(u.factor), price: u.price == null ? null : Number(u.price) }))
    .sort((a, b) => a.factor - b.factor);
  return [baseChoice(p), ...extra];
}

/** للصنف أكثر من وحدة؟ — وإلّا لا منتقي ولا تغيّر في الشاشة */
export function hasUnitChoice(p: UnitProduct | null | undefined): boolean {
  return unitChoices(p).length > 1;
}

/** وحدة البيع الافتراضية: الأكبر (انظر رأس الملف) */
export function defaultChoice(p: UnitProduct | null | undefined): UnitChoice {
  return unitChoices(p).reduce((a, b) => (b.factor > a.factor ? b : a));
}

/** الوحدة بمعرّفها (null = الأساس)؛ معرّفٌ لم يعد بين النشطة ⇒ null فيقرّر المستدعي */
export function choiceById(p: UnitProduct | null | undefined, id: string | null | undefined): UnitChoice | null {
  const all = unitChoices(p);
  return id ? all.find(c => c.id === id) ?? null : all[0];
}

/**
 * السعر الصافي للوحدة من سعر الأساس (سعر العميل الخاص وإلا سعر الصنف). الأساسُ حرفياً كما كان (بلا تقريبٍ
 * وسيط)، وغيره `unitPriceOf` — سعرها المحدَّد يغلب سعر العميل كما يحكم حارس الخادم (routes/invoices.ts).
 */
export function choiceNet(c: UnitChoice, basePrice: number | string): number {
  if (!c.id) return Number(basePrice);
  // `?? undefined` لا null: Number(null) = 0 «سعرٌ صالح» في unitPriceOf فيُباع الكرتون بلا سعرٍ محدَّد مجاناً
  return unitPriceOf({ name: c.name, factor: c.factor, price: c.price ?? undefined }, basePrice);
}

export function lineUnitOf(c: UnitChoice): LineUnit {
  return { unit: c.name, unitId: c.id, unitName: c.id ? c.name : null, unitFactor: c.id ? c.factor : 1, unitDefPrice: c.price };
}

/** لقطة وحدة المرتجع على بندٍ من فاتورة بيع (`ret*` كما يطبّعها lib/returnInvoice.ts) */
export function linkedLineUnit(l: { unit?: string; retUnitId: string | null; retUnitName: string | null; retUnitFactor: number }): LineUnit {
  return { unit: String(l.unit ?? ''), unitId: l.retUnitId, unitName: l.retUnitName, unitFactor: l.retUnitFactor, unitDefPrice: null };
}

/** البندان بالوحدة نفسها؟ — مع الصنف مفتاحُ الدمج في السلّة: «+١ حبة» لا تُضاف إلى بند كرتون */
export function sameUnit(a: { unitId?: string | null }, b: { unitId?: string | null }): boolean {
  return (a.unitId ?? null) === (b.unitId ?? null);
}

/**
 * حقول الوحدة في جسم بند الفاتورة: `unitId` ولقطة الجهاز (اسم الوحدة ومعاملها كما رآها). الصندوق الأوف‑لاين
 * يحفظ الجسم كما هو، فاللقطة تُرفع معه في إعادة الرفع.
 *
 * وبند الأساس يحمل لقطته أيضاً (اسم الأساس بمعامل ١، بلا unitId): هي وحدها ما يكشف «أخطر فخّ» — صنفٌ حُوِّل أساسه
 * (كرتون ⇒ حبة) بعد أن صُفّت فاتورته على الجهاز. بلا اللقطة يُرفع «٢» فيُقيَّد حبّتين؛ وبها يعرف الخادم أنّ «كرتون»
 * صار وحدةً فيكتبها بمعاملها، وفي الإصدار الحيّ يردّ كاشاً قديماً بـ409 بدل أن يقيّد غير ما رآه المندوب.
 * ولصنفٍ بلا وحدات يقبلها الخادم كما هي (الاسم = أساسه) فلا يتغيّر قيده.
 */
export function invoiceItemUnit(l: { unit?: string | null; unitId?: string | null; unitName?: string | null; unitFactor?: number | null }):
  { unitId?: string; unitName: string | null; unitFactor: number } | Record<string, never> {
  if (l.unitId) return { unitId: l.unitId, unitName: l.unitName ?? null, unitFactor: factorOf(l) };
  const base = String(l.unit ?? '').trim();
  return base ? { unitName: base, unitFactor: 1 } : {};
}

/**
 * وحدة البند بعد تحديث الكتالوج (ردّ الخادم 409 UNIT_CHANGED: كاش الجهاز قديم). الوحدة بمعرّفها كما هي الآن؛ وبند
 * الأساس الذي صار اسمه وحدةً للصنف (حُوِّل الأساس: كرتون ⇒ حبة) يصير بتلك الوحدة — فـ«٢ كرتون» تبقى كرتونين لا
 * حبّتين. و`null` حين لا وحدة صالحة للبند الآن (أُوقفت أو حُذفت): يقرّر المندوب، لا يُردّ إلى الأساس بصمت.
 */
export function refreshLineUnit(l: { unit?: string | null; unitId?: string | null }, p: UnitProduct | null | undefined): UnitChoice | null {
  if (!p) return null;
  if (l.unitId) return choiceById(p, l.unitId);
  const all = unitChoices(p);
  const was = String(l.unit ?? '').trim();
  return (was && was !== all[0].name.trim() ? all.find(c => c.id && c.name.trim() === was) : undefined) ?? all[0];
}

interface QtyLine { productId: string; qty: number; unitId?: string | null; unitFactor?: number | null }

/**
 * شارة الصنف في الشبكة: كمية بنده كما كانت ما دام بوحدةٍ واحدة، والمجموع لبنودٍ بالمعامل نفسه،
 * و«٢ كرتون و٣ حبة» حين تختلط وحداته — جمع كرتونٍ وحبّةٍ رقمٌ بلا معنى.
 */
export function cartBadge(lines: QtyLine[], productId: string, p: UnitProduct | null | undefined): number | string {
  const mine = lines.filter(l => l.productId === productId);
  if (mine.length === 0) return 0;
  if (mine.length === 1) return mine[0].qty || 0;
  if (new Set(mine.map(l => factorOf(l))).size === 1) return roundQty(mine.reduce((s, l) => s + (Number(l.qty) || 0), 0));
  return formatQty(sumBase(mine), p?.units ?? [], String(p?.unit ?? ''));
}

/** عدد الشريط السفلي: مجموع الكميات كما كان ما دامت البنود كلّها بوحدة الأساس، وإلّا عدد البنود */
export function cartCount(lines: QtyLine[]): number {
  return lines.every(l => !l.unitId && factorOf(l) === 1)
    ? lines.reduce((s, l) => s + l.qty, 0)
    : lines.length;
}

/**
 * كمية بالأساس للعرض: «٢ كرتون و٣ حبة» لصنفٍ له وحدات، و`null` لغيره فيعرض المستدعي رقمه كما كان.
 * `num` منسّق أرقام الشاشة (خيار الشركة في شكل الأرقام) — يُطبَّق على أرقام `formatQty` وحدها.
 */
export function unitsText(baseQty: number, p: UnitProduct | null | undefined, num: (n: number) => string): string | null {
  if (!p || !hasUnitChoice(p)) return null;
  return formatQty(Number(baseQty) || 0, p.units ?? [], String(p.unit ?? '')).replace(/\d+(?:\.\d+)?/g, m => num(Number(m)));
}
