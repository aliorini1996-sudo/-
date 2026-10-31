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
 * ═══ الافتراض في البيع = الوحدة الرئيسية، وإلّا أكبر وحدة ═══
 * بعد تحويل الصنف إلى أساسٍ أصغر (حبة) تصير وحدته القديمة (كرتون) وحدةً بمعامل؛ ولو بقي الافتراض
 * الأساسَ لصار نقر المندوب المعتاد «+١ حبة» بعد أن كان «+١ كرتون» — خطأٌ صامت ٢٤ ضعفاً.
 * والصنف ذو «الوحدة الرئيسية» (القاعدة ١٢) افتراضه رئيسيّته (كرتون) ولو كانت له طبلية أكبر منها.
 */
import { baseNameKey, factorOf, formatQty, primaryUnitOf, roundQty, sumBase, toBase, unitPriceOf, type UnitDef } from '../lib/units';

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

/**
 * الصنف كما يصل من الكتالوج — الكاش القديم بلا `units` يُقرأ صنفاً بوحدةٍ واحدة لا يُخمَّن له. و`primaryUnitId`
 * («الوحدة الرئيسية»، القاعدة ١٢) عرضٌ وافتراضٌ فقط: لا يدخل جسم بندٍ أبداً، وغيابه (كاشٌ قديم) = سلوك ما قبل الميزة
 */
export interface UnitProduct { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null }

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
  /**
   * وحدة أساس الصنف **كما رآها الجهاز** لحظة البند (product.unit). المعامل محسوبٌ عليها: «١ طبلية = ٥٠» تعني ٥٠ كرتوناً
   * إن كان الأساس كرتوناً وقتها — فإن حُوِّل الأساس إلى الحبّة قبل رفع البند من الصندوق عرف الخادم بها أنّ اللقطة على
   * الأساس القديم (baseUnitName في routes/invoices.ts)، وفي الإصدار الحيّ يكشف بها كاشاً قديماً (400 UNIT_INVALID)
   */
  baseUnit: string;
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

/**
 * رقاقة «الوحدة الرئيسية» من `unitChoices(p)` (معرّفها = `primaryUnitOf(p)?.id`)، أو null بلا رئيسية صالحة. لا تغيّر
 * ترتيب الرقاقات: `unitChoices(p)[0]` يبقى الأساس دائماً (D5، I4) لأن rebaseRow وrefreshLineUnit يعتمدان عليه
 */
export function primaryChoice(p: UnitProduct | null | undefined): UnitChoice | null {
  const id = primaryUnitOf(p)?.id;
  if (!id) return null;
  return unitChoices(p).find(c => c.id === String(id)) ?? null;
}

/** للصنف أكثر من وحدة؟ — وإلّا لا منتقي ولا تغيّر في الشاشة */
export function hasUnitChoice(p: UnitProduct | null | undefined): boolean {
  return unitChoices(p).length > 1;
}

/**
 * وحدة البيع الافتراضية: الوحدة الرئيسية الصالحة (`primaryChoice`)، وإلّا الأكبر كما قبل الميزة حرفاً (انظر رأس الملف).
 * كاشٌ قديم بلا `primaryUnitId` أو رئيسيةٌ تالفة/موقوفة ⇒ الأكبر — وهو الكرتون في الحالة الشائعة (§6.5)
 */
export function defaultChoice(p: UnitProduct | null | undefined): UnitChoice {
  return primaryChoice(p) ?? unitChoices(p).reduce((a, b) => (b.factor > a.factor ? b : a));
}

/** الوحدة بمعرّفها (null = الأساس)؛ معرّفٌ لم يعد بين النشطة ⇒ null فيقرّر المستدعي */
export function choiceById(p: UnitProduct | null | undefined, id: string | null | undefined): UnitChoice | null {
  const all = unitChoices(p);
  return id ? all.find(c => c.id === id) ?? null : all[0];
}

/**
 * السعر الصافي للوحدة — مرجع حارس الخادم (routes/invoices.ts) حرفاً، وإلّا رفض الخادم مندوباً لم يغيّر السعر أصلاً:
 *  • سعر العميل الخاص (مخزَّنٌ لوحدة الأساس) × المعامل **يغلب** سعر الوحدة المحدَّد: هو السقف المتّفق عليه معه، والتحويل
 *    يقسمه على المعامل لئلّا يتغيّر سعر كرتونه — فلو غلبه سعر الوحدة العامّ لضاع على العميل سعره بعد التحويل.
 *  • وبلا سعر عميل: سعر الوحدة المحدَّد (جملة) وإلّا الأساس × المعامل (`unitPriceOf`).
 * والأساس حرفياً كما كان (بلا تقريبٍ وسيط)، والضرب بلا تقريبٍ كذلك: التقريب مرّةً واحدة على الشامل عند المستدعي.
 */
export function choiceNet(c: UnitChoice, basePrice: number | string, customerPrice?: number | null): number {
  const cp = customerPrice == null ? NaN : Number(customerPrice);
  if (Number.isFinite(cp)) return c.id ? cp * c.factor : cp;
  if (!c.id) return Number(basePrice);
  // `?? undefined` لا null: Number(null) = 0 «سعرٌ صالح» في unitPriceOf فيُباع الكرتون بلا سعرٍ محدَّد مجاناً
  return unitPriceOf({ name: c.name, factor: c.factor, price: c.price ?? undefined }, basePrice);
}

/**
 * لقطة البند من الوحدة المختارة. `baseUnit` اسم أساس الصنف (product.unit) — ولوحدة الأساس هو اسمها نفسه، فالمستدعي
 * الذي لا يمرّره لبندٍ بوحدةٍ أكبر يُرسل بلا أساس (سلوك اللقطة وحدها على الخادم) لا باسمٍ مخمَّن.
 */
export function lineUnitOf(c: UnitChoice, baseUnit?: string | null): LineUnit {
  return {
    unit: c.name, unitId: c.id, unitName: c.id ? c.name : null, unitFactor: c.id ? c.factor : 1, unitDefPrice: c.price,
    baseUnit: String(baseUnit ?? (c.id ? '' : c.name)).trim(),
  };
}

/** لقطة وحدة المرتجع على بندٍ من فاتورة بيع (`ret*` كما يطبّعها lib/returnInvoice.ts، والأساس `baseUnit` من الخادم) */
export function linkedLineUnit(l: { unit?: string; baseUnit?: string; retUnitId: string | null; retUnitName: string | null; retUnitFactor: number }): LineUnit {
  return {
    unit: String(l.unit ?? ''), unitId: l.retUnitId, unitName: l.retUnitName, unitFactor: l.retUnitFactor, unitDefPrice: null,
    baseUnit: String(l.baseUnit ?? (l.retUnitId ? '' : l.unit ?? '')).trim(),
  };
}

/** البندان بالوحدة نفسها؟ — مع الصنف مفتاحُ الدمج في السلّة: «+١ حبة» لا تُضاف إلى بند كرتون */
export function sameUnit(a: { unitId?: string | null }, b: { unitId?: string | null }): boolean {
  return (a.unitId ?? null) === (b.unitId ?? null);
}

/**
 * حقول الوحدة في جسم بند الفاتورة: `unitId` ولقطة الجهاز (اسم الوحدة ومعاملها، ووحدة الأساس `baseUnitName`، كما رآها
 * لحظة البند). الصندوق الأوف‑لاين يحفظ الجسم كما هو، فاللقطة تُرفع معه في إعادة الرفع (القاعدة ٧).
 *
 * وبند الأساس يحمل لقطته أيضاً (اسم الأساس بمعامل ١، بلا unitId): هي وحدها ما يكشف «أخطر فخّ» — صنفٌ حُوِّل أساسه
 * (كرتون ⇒ حبة) بعد أن صُفّت فاتورته على الجهاز. بلا اللقطة يُرفع «٢» فيُقيَّد حبّتين؛ وبها يعرف الخادم أنّ «كرتون»
 * صار وحدةً فيكتبها بمعاملها، وفي الإصدار الحيّ يردّ كاشاً قديماً بـ400 UNIT_INVALID بدل أن يقيّد غير ما رآه المندوب.
 * ولصنفٍ بلا وحدات يقبلها الخادم كما هي (الاسم = أساسه) فلا يتغيّر قيده.
 * و`baseUnitName` لبندٍ بوحدةٍ أكبر: «١ طبلية = ٥٠» محسوبةٌ على أساس الجهاز، فإن حُوِّل بعدها ضُربت بمعامل التحويل.
 */
export function invoiceItemUnit(l: { unit?: string | null; unitId?: string | null; unitName?: string | null; unitFactor?: number | null; baseUnit?: string | null }):
  { unitId?: string; unitName: string | null; unitFactor: number; baseUnitName?: string } | Record<string, never> {
  const base = String(l.baseUnit ?? '').trim();
  if (l.unitId) return { unitId: l.unitId, unitName: l.unitName ?? null, unitFactor: factorOf(l), ...(base && { baseUnitName: base }) };
  const name = String(l.unit ?? '').trim();
  return name ? { unitName: name, unitFactor: 1, baseUnitName: base || name } : {};
}

/**
 * وحدة البند بعد تحديث الكتالوج (ردّ الخادم 400 UNIT_INVALID: كاش الجهاز قديم). الوحدة بمعرّفها كما هي الآن؛ وبند
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

/**
 * صفّ تحميلٍ أو طلب بضاعة بعد تحديث الكتالوج (ردّ 400 UNIT_INVALID): وحدته إن بقيت بين وحدات الصنف النشطة (الكرتون
 * يُعدّ كرتوناً ولو تغيّر معامله — المندوب يحمّل عبواتٍ يعدّها)، وإلّا يصير الصفّ بالأساس وكميته × المعامل الذي اختيرت
 * به — فـ«١٠ كرتون» أُوقف كرتونها تصير «٢٤٠ حبة» ظاهرةً على الشاشة لا «١٠ حبة» صامتة. كما يفعل فتح طلبٍ معلّقٍ أُوقفت
 * وحدة بنده. والكمية غير الرقمية (حقلٌ يكتبه المندوب) تبقى كما هي، وصنفٌ خرج من الكتالوج (null) يبقى صفّه كما هو.
 * وصفّ الأساس الذي صار اسمه وحدةً للصنف (حُوِّل الأساس: كرتون ⇒ حبة) يصير بتلك الوحدة كبند البيع (refreshLineUnit).
 */
export function rebaseRow<Q extends number | string>(
  row: { unit?: string | null; unitId: string | null; unitFactor?: number | null; qty: Q }, p: UnitProduct | null | undefined,
): { choice: UnitChoice; qty: Q | number } | null {
  if (!p) return null;
  const now = refreshLineUnit(row, p);
  if (now) return { choice: now, qty: row.qty };
  const q = Number(row.qty);
  return { choice: unitChoices(p)[0], qty: String(row.qty).trim() !== '' && Number.isFinite(q) ? toBase(q, row) : row.qty };
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
  return formatQty(sumBase(mine), p?.units ?? [], String(p?.unit ?? ''), primaryUnitOf(p));
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
 * وللصنف ذي الوحدة الرئيسية يقف عندها («52 كرتون و2 قارورة» لا «1 طبلية و…»، والصفر «0 كرتون»).
 */
export function unitsText(baseQty: number, p: UnitProduct | null | undefined, num: (n: number) => string): string | null {
  if (!p || !hasUnitChoice(p)) return null;
  return formatQty(Number(baseQty) || 0, p.units ?? [], String(p.unit ?? ''), primaryUnitOf(p)).replace(/\d+(?:\.\d+)?/g, m => num(Number(m)));
}

/**
 * أسعار العميل الخاصّة (`/products/customer-prices/:id` أو كاشها `custprices:<id>`) **على أساس الكتالوج الحالي** —
 * السعر مخزَّنٌ لوحدة الأساس، والصفّ يحمل `unit` = أساس الصنف لحظة قراءته (§2.2-ح). فكاشُ أسعارٍ من قبل تحويل الأساس
 * (unit = كرتون) مع كتالوجٍ من بعده (الأساس قارورة، والكرتون وحدة ٢٤) يُقسم على ٢٤ — وإلّا صار سعر الكرتون للعميل
 * ٤٨ × ٢٤ = ١١٥٢. والقاعدة:
 *  • صفٌّ بلا `unit` (كاشٌ قديم) أو `unit` = أساس الصنف الآن (`baseNameKey` على الطرفين) ⇒ السعر كما هو حرفاً.
 *  • `unit` اسم وحدةٍ نشطة للصنف ⇒ السعر ÷ معاملها (بلا تقريبٍ وسيط، كاستيراد الأسعار).
 *  • وإلّا (اسمٌ مجهول: تحويلٌ في الاتجاه الآخر أو وحدةٌ حُذفت) ⇒ يُسقط السعر، فيعود البند إلى سعر الصنف ويحكم الخادم.
 *  • صنفٌ غائب عن الكتالوج ⇒ كما هو.
 */
export function rebaseCustPrices(
  rows: Array<{ productId: string; price: number | string; unit?: string | null }> | null | undefined,
  products: Array<UnitProduct & { id: string }> | null | undefined,
): Record<string, number> {
  const byId = new Map((products ?? []).filter(p => p && p.id).map(p => [String(p.id), p] as const));
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    if (!r || r.productId == null) continue;
    const price = Number(r.price);
    const p = byId.get(String(r.productId));
    const seen = baseNameKey(r.unit);
    if (!p || !seen || seen === baseNameKey(p.unit)) { out[r.productId] = price; continue; }
    const u = (Array.isArray(p.units) ? p.units : [])
      .find(x => x && x.isActive !== false && baseNameKey(x.name) === seen && Number.isFinite(Number(x.factor)) && Number(x.factor) > 0);
    if (u) out[r.productId] = price / Number(u.factor);
  }
  return out;
}
