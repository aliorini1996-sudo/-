/**
 * طلب مخزون (طلب زيادة المستودع) — ورقةٌ يصدرها مسؤول المستودع ويرسلها لإدارة
 * المشتريات أو الإنتاج: لكل صنفٍ كمّيته المطلوبة ورصيده الآن.
 *
 * لا يُحفظ في الخادم: ليس حركة مخزون ولا التزاماً مالياً، بل ورقة طلب. فالرصيد
 * لا يتغيّر بإصداره، ويتغيّر حين تصل البضاعة وتُسجَّل «وارداً».
 *
 * ═══ الوحدات المتعددة ═══
 * الرصيد `onHand` **بالأساس** (حبّات) والطلب **بوحدةٍ يختارها المسؤول** لكل صنف (كرتون — المشتريات تشتري به). وطلبات
 * المناديب كلٌّ بوحدة سطره (لقطته: «٥ كرتون» أو «٣ حبة»)، فتُجمع لكل صنف **بالأساس** ثم تُعرض بوحدة الطلب العام —
 * جمعُ «٥» كرتون و«٣» حبات رقماً واحداً «٨» كذب. وصنفٌ بلا وحدات: معامله ١ في كل مكان فكل رقمٍ كما كان حرفاً.
 *
 * ═══ الوحدة الرئيسية (القاعدة ١٢) ═══
 * `primaryUnitId` عرضٌ وافتراضٌ فقط: يجعل وحدة الطلب الافتراضية الرئيسيةَ (كرتون) لا الأكبر (طبلية)، ويُحمل على سطر
 * الورقة ليُطبع الرصيد بها. والحمولة لا تحمله أبداً — بل `baseUnitName` (الأساس كما رآه النموذج) فيكشف الخادم قائمةً قديمة.
 * صنفٌ بلا رئيسية (أو بمعرّفٍ تالف ⇒ primaryUnitOf = null): كل شيءٍ كما كان حرفاً (I1).
 */
import { QTY_EPS, baseNameKey, factorOf, fromBase, primaryUnitOf, roundQty, toBase, type UnitDef } from './units';
import { choiceById, defaultChoice, unitChoices, type UnitChoice } from '../rep/repUnits';

/** الجهة الموجَّه إليها الطلب */
export type StockRequestTo = 'PURCHASING' | 'PRODUCTION';

/** اسم الجهة — مفتاح ترجمة عربي يُمرَّر على `tr` عند العرض */
export const stockRequestToLabel = (to: StockRequestTo): string =>
  to === 'PRODUCTION' ? 'إدارة الإنتاج' : 'إدارة المشتريات';

/** خانة اعتماد الجهة في الورقة */
export const stockRequestApproverLabel = (to: StockRequestTo): string =>
  to === 'PRODUCTION' ? 'اعتماد إدارة الإنتاج' : 'اعتماد إدارة المشتريات';

/**
 * مرجع الطلب من لحظة إصداره بتوقيت الجهاز: `SR-سنةشهريوم-ساعةدقيقة`.
 * قصيرٌ يُقرأ على الهاتف ويُذكر في المراسلة، ويُرتَّب زمنياً كما يُكتب.
 */
export function stockRequestRef(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `SR-${String(at.getFullYear()).slice(2)}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

/** الخانة كما كُتبت رقماً — الأرقام الهندية والفاصلة العشرية العربية تُقرأ كما تُقرأ اللاتينية */
function readNumber(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * الكمية المطلوبة في الخانة — أو `null` حين لا تُعدّ طلباً: فارغةٌ أو صفرٌ أو
 * سالبةٌ أو ليست رقماً. الطلب يطلب زيادةً فلا معنى فيه لكمّية سالبة.
 */
export function parseRequestQty(raw: string | undefined): number | null {
  const n = readNumber(raw);
  if (n === null || Number.isNaN(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * خانةٌ لا تُفهم: نصٌّ ليس رقماً أو كمّية سالبة. تُوقف الإصدار ولا تُسقَط صامتةً —
 * سطرٌ كتبه المستخدم ثم غاب عن الورقة المرسلة أسوأ من زرٍّ معطّل يقول السبب.
 * والصفر ليس خطأً: معناه «لا أطلب هذا الصنف».
 */
export function isInvalidRequestQty(raw: string | undefined): boolean {
  const n = readNumber(raw);
  return n !== null && (Number.isNaN(n) || n < 0);
}

/**
 * صفّ صنفٍ في نافذة الطلب: `unit` وحدة الأساس و`onHand` بها، و`units` وحدات الصنف (الوحدات المتعددة)، و`primaryUnitId`
 * «الوحدة الرئيسية» (عرضٌ وافتراض فقط — غيابها كاشٌ قديم أو صنفٌ بلا رئيسية = سلوك ما قبل الميزة)
 */
export interface StockRequestSourceRow {
  productId: string; name: string; code?: string; unit?: string; onHand: number; units?: UnitDef[] | null; primaryUnitId?: string | null;
}
/**
 * سطر الورقة: `qty` بوحدة الطلب `unit`. ولصنفٍ له وحدات: `unitFactor` معامل تلك الوحدة (فلا يُجمع كرتونٌ وحبّةٌ في
 * «إجمالي الكميات»)، و`units`/`baseUnit` ليُطبع الرصيد بالأساس «٢ كرتون و٣ حبة» — والحقول غائبةٌ لغيره فالسطر كما كان.
 * و`primaryUnitId` لصنفٍ له رئيسية صالحة وحده، فيُطبع رصيده بها («52 كرتون و2 قارورة») — وغيابه السطر كما كان حرفاً.
 */
export interface StockRequestLine {
  productId: string; name: string; code?: string; unit?: string; onHand: number; qty: number;
  unitFactor?: number | null; units?: UnitDef[] | null; baseUnit?: string | null; primaryUnitId?: string | null;
}

/** للصنف وحدةٌ نشطة أكبر من الأساس؟ */
const hasUnits = (r: { units?: UnitDef[] | null }) => (r.units ?? []).some(u => u && Number(u.factor) > 1 && u.isActive !== false);

/** وحدة طلبٍ مختارة لصنف (`unitId` غائب ⇒ `fallback`؛ null ⇒ الأساس) — معرّفٌ لم يعد نشطاً يسقط إلى الأساس */
export function requestUnitOf(r: StockRequestSourceRow, unitId: string | null | undefined): UnitChoice {
  const p = { unit: r.unit ?? '', units: r.units ?? [] };
  return (unitId === undefined ? null : choiceById(p, unitId)) ?? unitChoices(p)[0];
}

/**
 * وحدة الطلب الافتراضية لصنف: لمجموع مناديب (بالأساس) أكبرُ وحدةٍ ينقسم عليها تماماً (٤٨ حبة ⇒ ٢ كرتون)، وإلّا الأساس
 * (١٣ حبة لا تُكتب ٠٫٥٤ كرتون). وبلا طلب مناديب: الأكبر — المشتريات تشتري بالكرتون، وقبل التحويل كان الكرتون هو الأساس.
 * صنفٌ بلا وحدات ⇒ null (الأساس) دائماً.
 * **ولصنفٍ له وحدة رئيسية** (§5.1): الرئيسية حين لا طلب مناديب أو حين ينقسم عليها مجموعهم تماماً — لا الطبلية الأكبر منها؛
 * وإلّا القاعدة نفسها أعلاه. والرئيسية بين النشطة (primaryUnitOf) وإلّا فلا رئيسية.
 */
export function defaultRequestUnit(r: StockRequestSourceRow, repBase: number): string | null {
  const big = unitChoices({ unit: r.unit ?? '', units: r.units ?? [] }).filter(c => c.id && c.factor > 1).sort((a, b) => b.factor - a.factor);
  if (!big.length) return null;
  const primary = primaryUnitOf({ primaryUnitId: r.primaryUnitId, units: r.units ?? [] });
  const pc = primary ? big.find(c => c.id === String(primary.id)) : undefined;
  if (pc) {
    const n = repBase / pc.factor;
    if (!(repBase > QTY_EPS) || (n >= 1 - QTY_EPS && Math.abs(n - Math.round(n)) < QTY_EPS)) return pc.id;
  }
  if (!(repBase > QTY_EPS)) return big[0].id;
  const fit = big.find(c => { const n = repBase / c.factor; return n >= 1 - QTY_EPS && Math.abs(n - Math.round(n)) < QTY_EPS; });
  return fit ? fit.id : null;
}

/** مجموع المناديب (بالأساس) معبَّراً بوحدة الطلب — نصّاً لخانة الطلب، بخانتين كبقية الطلب */
export function prefillInUnit(repBase: number, factor: number): string {
  return String(Math.round(fromBase(repBase, factor) * 100) / 100);
}

/**
 * أسطر الطلب بترتيب الأصناف المعطى — الصنف الذي لم تُكتب له كمية مطلوبة لا يدخل الورقة.
 * `unitById` وحدة طلب كل صنف (معرّفٌ، أو null للأساس)؛ غيابها ⇒ الأساس — فالمستدعي القديم يبقى كما كان.
 */
export function stockRequestLines(rows: StockRequestSourceRow[], qtyById: Record<string, string>, unitById: Record<string, string | null> = {}): StockRequestLine[] {
  const out: StockRequestLine[] = [];
  for (const r of rows) {
    const qty = parseRequestQty(qtyById[r.productId]);
    if (qty === null) continue;
    const line: StockRequestLine = { productId: r.productId, name: r.name, code: r.code || undefined, unit: r.unit || undefined, onHand: Number(r.onHand) || 0, qty };
    if (hasUnits(r)) {
      const c = requestUnitOf(r, unitById[r.productId] ?? null);
      Object.assign(line, { unit: c.name || undefined, unitFactor: c.id ? c.factor : 1, units: r.units, baseUnit: r.unit || undefined });
      // الرئيسية الصالحة وحدها تُحمل على السطر (الورقة تطبع الرصيد بها) — وغيرها لا مفتاح، فالسطر كما كان حرفاً
      if (primaryUnitOf(r)) line.primaryUnitId = r.primaryUnitId;
    }
    out.push(line);
  }
  return out;
}

/** إجمالي الكميات المطلوبة — بخانتين، فجمع الكسور لا يطبع ذيلاً عشرياً طويلاً */
export const stockRequestTotalQty = (lines: { qty: number }[]): number =>
  Math.round(lines.reduce((s, l) => s + l.qty, 0) * 100) / 100;

/**
 * نصّ «إجمالي الكميات»: الرقم كما كان ما دامت الأسطر كلّها بوحدة الأساس ولا صنف فيها بوحدةٍ رئيسية، وإلّا مجموعٌ لكل وحدة
 * («٢ كرتون · ٥ حبة»، و«10 قارورة» لطلبٍ كلّه بقارورة صنفٍ يُعرَّف بالكرتون) — بشرط ورقة الطلب المطبوعة (PrintableStockRequest:
 * qtyByUnit) نفسه حرفاً، فلا تقول الشاشة رقماً والورقة غيره.
 */
export function stockRequestTotalText(lines: { qty: number; unit?: string; unitFactor?: number | null; primaryUnitId?: string | null }[], fmt: (n: number) => string): string {
  if (!lines.some(l => factorOf(l) !== 1 || !!l.primaryUnitId)) return fmt(stockRequestTotalQty(lines));
  const m = new Map<string, number>();
  for (const l of lines) {
    const u = (l.unit || '').trim();
    m.set(u, Math.round(((m.get(u) ?? 0) + l.qty) * 100) / 100);
  }
  return [...m].map(([u, q]) => `${fmt(q)} ${u}`.trim()).join(' · ');
}

/** الناقص: رصيده صفر أو سالب — هو ما ينبّه إليه شريط الصفحة «يحتاج استلام بضاعة» */
export const isShort = (r: { onHand: number }): boolean => r.onHand <= 0;

/** الناقص أولاً، ثم البقية — وكلٌّ بترتيبه في جدول المستودع */
export function shortFirst<T extends { onHand: number }>(rows: T[]): T[] {
  return [...rows.filter(isShort), ...rows.filter(r => !isShort(r))];
}

// ——— طلبات بضاعة المناديب (الخادم: /rep-stock-requests) ———
// المندوب الذي لا يملك صلاحية التحميل يرفع من تطبيقه ما يحتاجه، فتظهر طلباته المعلّقة أسفل هذه
// النافذة: يعدّل الإداري الكمية المعتمدة لكل صنف، ومجموع المشمول منها هو الكمية المبدئية في الطلب العام.

/**
 * بند طلب مندوب كما يردّه الخادم (routes/repStockRequests.ts shape). `unit` وحدة السطر (لقطته، وإلا وحدة الصنف)،
 * و`requestedQty`/`qty` بها. والوحدات المتعددة (اختيارية — خادمٌ قبل الميزة لا يرسلها ⇒ الأساس بمعامل ١):
 * `unitName`/`unitFactor` لقطة الوحدة، و`baseQty` المعتمد بالأساس `baseUnit`، و`units` وحدات الصنف.
 */
export interface RepRequestItem {
  productId: string; name: string; code?: string; unit?: string; requestedQty: number; qty: number;
  unitName?: string | null; unitFactor?: number | null; baseQty?: number | null; requestedBaseQty?: number | null;
  /** «الوحدة الرئيسية» لصنف البند — عرضٌ فقط (خادمٌ قبل الميزة لا يرسلها ⇒ بلا رئيسية) */
  baseUnit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null;
}
export interface RepStockRequest {
  id: string; salesRepId: string; repName: string; note: string | null;
  createdAt: string; updatedAt: string; items: RepRequestItem[];
}

/**
 * تعديلات وحدة البنود في الشاشة: `unitEdits[reqId][productId]` = معرّف وحدةٍ اختارها الإداري، أو null للأساس.
 * **الغياب = وحدة سطر المندوب كما هي** — وهو عقد الخادم نفسه (unitId غائب ⇒ وحدة السطر، null ⇒ الأساس).
 */
export type RepUnitEdits = Record<string, Record<string, string | null>>;

/**
 * ردّ الخادم «وحدات الصنف تغيّرت منذ حُمّلت الشاشة» (§2.7–2.9): 400 UNIT_INVALID (كاشٌ قديم) أو 409 PRODUCT_UNITS_CHANGED
 * (سباقٌ مع تحويل). شاشات المخزون (الطلب والوارد والتحميل والإزالة) تعيد بهما جلب الأصناف أو البنود ولا تعيد الإرسال كما هو.
 * و503 PRODUCT_UNITS_BUSY ليس منهما: الكتالوج لم يتغيّر بعد، فتُقال رسالته وحدها.
 */
export function isStaleUnitsError(e: unknown): boolean {
  const code = (e as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data?.code;
  return code === 'UNIT_INVALID' || code === 'PRODUCT_UNITS_CHANGED';
}

/** الكمية المعتمدة لبندٍ الآن: ما كتبه الإداري في خانته (فارغها صفر)، وإلا المحفوظة في الخادم */
export function repItemQty(saved: number, raw: string | undefined): number {
  if (raw === undefined) return saved;
  return isInvalidRequestQty(raw) ? saved : (parseRequestQty(raw) ?? 0);
}

/** صنف البند كما تحتاجه وحدات الاختيار: الأساس `baseUnit` (خادمٌ قبل الميزة: وحدة السطر هي الأساس) ووحداته */
const itemProduct = (i: RepRequestItem) => ({ unit: String(i.baseUnit ?? i.unit ?? ''), units: i.units ?? [] });

/**
 * معرّف وحدة سطر المندوب بين وحدات الصنف النشطة الآن (بالاسم والمعامل، ثم بالمعامل وحده)، أو null لسطرٍ بالأساس —
 * و`undefined` حين لم تعد وحدته بينها (أُوقفت أو تغيّر معاملها): يبقى السطر بوحدته ولا يُنسب لوحدةٍ أخرى.
 */
export function repLineUnitId(i: RepRequestItem): string | null | undefined {
  const f = factorOf(i);
  if (f === 1) return null;
  const all = unitChoices(itemProduct(i)).filter(c => c.id && Math.abs(c.factor - f) < QTY_EPS);
  return (all.find(c => c.name === (i.unitName ?? i.unit)) ?? all[0])?.id ?? undefined;
}

/** وحدة البند الآن: ما اختاره الإداري، وإلا وحدة سطر المندوب — اسمها ومعاملها */
export function repItemUnit(i: RepRequestItem, unitEdit: string | null | undefined): { name: string; factor: number } {
  if (unitEdit !== undefined) {
    const c = choiceById(itemProduct(i), unitEdit) ?? unitChoices(itemProduct(i))[0];
    return { name: c.name, factor: c.id ? c.factor : 1 };
  }
  return { name: String(i.unitName ?? i.unit ?? ''), factor: factorOf(i) };
}

/** اختار الإداري وحدةً غير وحدة السطر؟ — اختيارُ الوحدة نفسها ليس تعديلاً */
function unitChanged(i: RepRequestItem, unitEdit: string | null | undefined): boolean {
  return unitEdit !== undefined && unitEdit !== repLineUnitId(i);
}

/** هل في خانات هذا الطلب ما يخالف المحفوظ؟ — يظهر «حفظ التعديل» ويُحفظ تلقائياً قبل الإرسال */
export function repRequestDirty(r: RepStockRequest, edits: Record<string, string> | undefined, unitEdits?: Record<string, string | null>): boolean {
  return r.items.some(i => (edits?.[i.productId] !== undefined && repItemQty(i.qty, edits[i.productId]) !== i.qty)
    || unitChanged(i, unitEdits?.[i.productId]));
}

/**
 * بنود حفظ تعديل الإداري (PUT /rep-stock-requests/:id): ما تغيّر كميّته أو وحدته. `unitId` يُرسل **حين تغيّرت الوحدة
 * وحدها** (معرّفٌ أو null للأساس)، وغيابه = وحدة سطر المندوب — فالكمية المكتوبة بجانب وحدة السطر تُحفظ بها.
 * و`baseUnitName` (§2.9) وحدة أساس الصنف **كما رآها الإداري** (`baseUnit` من الخادم): إن حُوِّل الأساس منذ فُتحت النافذة
 * ردّ الخادم 400/409 بدل أن يحفظ «٢» بأساسٍ لم يره — وخادمٌ قبل الميزة لا يرسل `baseUnit` فلا يُرسل شيء (الجسم كما كان).
 */
export function repEditItems(r: RepStockRequest, edits: Record<string, string> | undefined, unitEdits?: Record<string, string | null>): { productId: string; qty: number; unitId?: string | null; baseUnitName?: string }[] {
  return r.items
    .filter(i => edits?.[i.productId] !== undefined || unitChanged(i, unitEdits?.[i.productId]))
    .map(i => {
      const base = String(i.baseUnit ?? '').trim();
      return {
        productId: i.productId,
        qty: repItemQty(i.qty, edits?.[i.productId]),
        ...(unitChanged(i, unitEdits?.[i.productId]) && { unitId: unitEdits![i.productId] }),
        ...(base && { baseUnitName: base }),
      };
    });
}

/**
 * الكمية حين يبدّل الإداري وحدة بند: الكمية نفسها بالأساس معبَّراً بالوحدة الجديدة («٢ كرتون» ⇒ «٤٨ حبة») — لا الرقم
 * نفسه بوحدةٍ أخرى («٢ حبة» صامتة). نصّاً لخانة الإداري **بخانتين** كما تُقرأ الخانة عند الحفظ (repItemQty) — فما
 * يُرى هو ما يُحفظ: «١٣ حبة» إلى الكرتون تُرى ٠٫٥٤ فيصحّحها الإداري، لا ٠٫٥٤١٧ تُحفظ ٠٫٥٤ بصمت.
 */
export function convertRepQty(qty: number, fromFactor: number, toFactor: number): string {
  return String(Math.round(fromBase(toBase(qty, { unitFactor: fromFactor }), toFactor) * 100) / 100);
}

/**
 * مجموع الكميات المعتمدة لكل صنف عبر الطلبات المشمولة — **بالأساس** (كمية كل بند × معامل وحدته الآن)، بخانتين كبقية
 * الطلب. وصنفٌ بلا وحدات معامله ١ فمجموعه كما كان.
 */
export function repRequestTotals(reqs: RepStockRequest[], edits: Record<string, Record<string, string>>, unitEdits: RepUnitEdits = {}): Map<string, number> {
  const sum = new Map<string, number>();
  for (const r of reqs) {
    for (const i of r.items) {
      const q = repItemQty(i.qty, edits[r.id]?.[i.productId]);
      const f = repItemUnit(i, unitEdits[r.id]?.[i.productId]).factor;
      if (q > 0) sum.set(i.productId, Math.round(((sum.get(i.productId) ?? 0) + roundQty(q * f)) * 100) / 100);
    }
  }
  return sum;
}

/** صنفٌ طلبه مندوب وليس في جدول المستودع (أُضيف بعده مثلاً) يُلحق برصيد صفر — فلا يسقط من الطلب العام */
export function withRequestedProducts(rows: StockRequestSourceRow[], reqs: RepStockRequest[]): StockRequestSourceRow[] {
  const known = new Set(rows.map(r => r.productId));
  const extra: StockRequestSourceRow[] = [];
  for (const r of reqs) {
    for (const i of r.items) {
      if (known.has(i.productId)) continue;
      known.add(i.productId);
      // وحدة الأساس لا وحدة سطر المندوب: الصفّ رصيده (صفر) وطلبه العام يُحسبان بالأساس ووحداته
      extra.push({
        productId: i.productId, name: i.name, code: i.code, unit: i.baseUnit ?? i.unit, onHand: 0,
        ...(i.units && i.units.length > 0 ? { units: i.units } : {}),
        // الرئيسية حين يرسلها الخادم وحدها — غيابها الصفّ كما كان حرفاً
        ...(i.primaryUnitId && i.units && i.units.length > 0 ? { primaryUnitId: i.primaryUnitId } : {}),
      });
    }
  }
  return [...rows, ...extra];
}

/** ما طلبه المناديب أولاً (بما طلبوه أصلاً لا بالمعدَّل، فلا يقفز الترتيب أثناء الكتابة)، ثم الناقص، ثم البقية */
export function requestedFirst<T extends { productId: string; onHand: number }>(rows: T[], requested: Set<string>): T[] {
  return [...rows.filter(r => requested.has(r.productId)), ...shortFirst(rows.filter(r => !requested.has(r.productId)))];
}

// ═══ شاشات المخزون في لوحة الويب: «الوحدة الرئيسية» (primary_unit_spec §5.3، حزمة B5b) ═══
// نقيٌّ يُختبر وحده (stockRequest.primary.test.ts) وتقرؤه مخزون السيارات ونافذة التحميل والمستودع وسجلّ التحميلات —
// هنا لا في الصفحات لأن الصفحات (tsx) لا تُختبر بلا متصفح. والعرض نفسه من lib/adminUnits وlib/units لا منطقٌ موازٍ.

/** وسم مجموعٍ عبر الأصناف بالأساس (R3): «بالوحدات الصغرى» حين فيه صنفٌ له رئيسية، وإلّا الوسم القائم حرفاً (I1) */
export type CrossSumLabel = 'بالوحدات الصغرى' | 'مجموع بوحدات الأساس';
export const crossSumLabel = (hasPrimary: boolean): CrossSumLabel => (hasPrimary ? 'بالوحدات الصغرى' : 'مجموع بوحدات الأساس');

/** في هذه الأصناف أو البنود ما له «وحدة رئيسية»؟ — قيمةٌ صادقة لا حضور المفتاح (D18: `null` يصل في كل select) */
export function anyPrimary(rows: ReadonlyArray<{ primaryUnitId?: string | null; product?: { primaryUnitId?: string | null } | null } | null | undefined>): boolean {
  return rows.some(r => !!(r?.primaryUnitId || r?.product?.primaryUnitId));
}

/** لقطة وحدة بندٍ كما يقرؤها factorOf */
type UnitSnap = { unitFactor?: number | null; unitName?: string | null };

/**
 * وسم عمود «الكمية» لتحميلٍ في السجلّ (R3): المجموع بالأساس حين تختلط وحدات البنود — «مجموع بوحدات الأساس» كما كان،
 * و«بالوحدات الصغرى» حين في البنود صنفٌ له رئيسية (ولو كانت بنوده كلّها بالقارورة: «٤٨» وحدها بجانب «٢ كرتون» تُقرأ
 * كراتين)، وإلّا لا وسم والرقم كما كان (I1).
 */
export function loadSumLabel(items: ReadonlyArray<UnitSnap & { product?: { primaryUnitId?: string | null } | null }>): CrossSumLabel | null {
  if (anyPrimary(items)) return 'بالوحدات الصغرى';
  return items.some(it => factorOf(it) !== 1) ? 'مجموع بوحدات الأساس' : null;
}

/**
 * `baseUnitName` على كل بند مخزونٍ يُرسل (§2.7–2.9): أساس الصنف **كما رآه النموذج** — يكشف به الخادم قائمةً قديمة
 * (400 UNIT_INVALID) أو سباقاً مع تحويل (409). `baseOf` يعيده لكل صنف، والفارغ لا يُرسل (الجسم كما كان).
 * ولا يمسّ شيئاً آخر في البند (الوحدة والتشغيلات والمقترَح) — يُطبَّق بعد splitVanMovement الذي يُسقط ما لا يعرفه.
 */
export function withBaseUnitNames<T extends { productId: string }>(items: T[], baseOf: (productId: string) => string | null | undefined): (T & { baseUnitName?: string })[] {
  return items.map(it => {
    const b = String(baseOf(it.productId) ?? '').trim();
    return b ? { ...it, baseUnitName: b } : it;
  });
}

/**
 * وحدة نافذة «إزالة المنتهي/التالف» من السيارة وكميتها الأولى (D8) — الافتراضي كامل الرصيد كما كان:
 *  • صنفٌ له رئيسية صالحة: بها (`defaultChoice`) حين ينقسم الرصيد عليها تماماً («٤٨ قارورة» ⇒ «٢ كرتون»)، وإلّا
 *    بالقارورة كما هو — فلا يُقرَّب كامل الرصيد إلى كراتين ولا يُكتب كسرٌ منها.
 *  • صنفٌ بلا رئيسية: الأساس حرفاً كما قبل الميزة (I1) — بلا منتقٍ جديد.
 * `qty` بوحدة الاختيار، والمستدعي ينسّقه (roundLot).
 */
export function removalStart(row: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null }, have: number): { unitId: string | null; factor: number; qty: number } {
  const h = Number(have) || 0;
  if (!primaryUnitOf(row)) return { unitId: null, factor: 1, qty: h };
  const c = defaultChoice(row);
  if (c.id && c.factor > 1) {
    const n = h / c.factor;
    if (n >= 1 - QTY_EPS && Math.abs(n - Math.round(n)) < QTY_EPS) return { unitId: c.id, factor: c.factor, qty: Math.round(n) };
  }
  return { unitId: null, factor: 1, qty: h };
}

/**
 * كمية الإزالة **بالأساس** كما تُرسل وتُقارن بالرصيد: الخانة × معامل الوحدة المختارة (D8 — عقد الخادم لا يتغيّر،
 * البند بلا unitId). وبالأساس (معامل ١) الرقم كما كُتب حرفاً كما قبل الميزة. غير الرقم ⇒ NaN.
 */
export function removalBaseQty(raw: string, factor: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return factor === 1 ? n : toBase(n, { unitFactor: factor });
}

type PrimarySource = { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null };

/**
 * مصدر «الوحدة الرئيسية» لصفّ اقتراح التحميل (R7، suggestionChoice): الصفّ نفسه حين يحمل المفتاح — الخادم يمرّر
 * `primaryUnitId` والوحدات مع الكميات في الردّ نفسه فالأساس واحدٌ بالبناء، و`null` صريحاً = بلا رئيسية ولو قال كتالوجٌ
 * قديم غير ذلك. وخادمٌ لا يرسل المفتاح (undefined): صفّ الكتالوج حين له رئيسية صالحة وأساسه أساس الاقتراح نفسه
 * (baseNameKey) — كتالوجٌ بأساسٍ آخر قديمٌ فلا يُقرأ منه شيء. وإلّا null ⇒ الاقتراح بوحدات صفّه كما كان حرفاً (I1).
 */
export function suggestPrimarySource<R extends PrimarySource, P extends PrimarySource>(row: R, catalog: P | null | undefined): R | P | null {
  if (row.primaryUnitId !== undefined) return primaryUnitOf(row) ? row : null;
  return catalog && primaryUnitOf(catalog) && baseNameKey(catalog.unit) === baseNameKey(row.unit) ? catalog : null;
}
