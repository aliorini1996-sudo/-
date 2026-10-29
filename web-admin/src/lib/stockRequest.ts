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
 */
import { QTY_EPS, factorOf, fromBase, roundQty, toBase, type UnitDef } from './units';
import { choiceById, unitChoices, type UnitChoice } from '../rep/repUnits';

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

/** صفّ صنفٍ في نافذة الطلب: `unit` وحدة الأساس و`onHand` بها، و`units` وحدات الصنف (الوحدات المتعددة) */
export interface StockRequestSourceRow { productId: string; name: string; code?: string; unit?: string; onHand: number; units?: UnitDef[] | null }
/**
 * سطر الورقة: `qty` بوحدة الطلب `unit`. ولصنفٍ له وحدات: `unitFactor` معامل تلك الوحدة (فلا يُجمع كرتونٌ وحبّةٌ في
 * «إجمالي الكميات»)، و`units`/`baseUnit` ليُطبع الرصيد بالأساس «٢ كرتون و٣ حبة» — والحقول غائبةٌ لغيره فالسطر كما كان.
 */
export interface StockRequestLine {
  productId: string; name: string; code?: string; unit?: string; onHand: number; qty: number;
  unitFactor?: number | null; units?: UnitDef[] | null; baseUnit?: string | null;
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
 */
export function defaultRequestUnit(r: StockRequestSourceRow, repBase: number): string | null {
  const big = unitChoices({ unit: r.unit ?? '', units: r.units ?? [] }).filter(c => c.id && c.factor > 1).sort((a, b) => b.factor - a.factor);
  if (!big.length) return null;
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
    }
    out.push(line);
  }
  return out;
}

/** إجمالي الكميات المطلوبة — بخانتين، فجمع الكسور لا يطبع ذيلاً عشرياً طويلاً */
export const stockRequestTotalQty = (lines: { qty: number }[]): number =>
  Math.round(lines.reduce((s, l) => s + l.qty, 0) * 100) / 100;

/**
 * نصّ «إجمالي الكميات»: الرقم كما كان ما دامت الأسطر كلّها بوحدة الأساس، وإلّا مجموعٌ لكل وحدة («٢ كرتون · ٥ حبة») —
 * كورقة الطلب المطبوعة (PrintableStockRequest: qtyByUnit) حرفاً، فلا تقول الشاشة رقماً والورقة غيره.
 */
export function stockRequestTotalText(lines: { qty: number; unit?: string; unitFactor?: number | null }[], fmt: (n: number) => string): string {
  if (!lines.some(l => factorOf(l) !== 1)) return fmt(stockRequestTotalQty(lines));
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
  baseUnit?: string | null; units?: UnitDef[] | null;
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
 */
export function repEditItems(r: RepStockRequest, edits: Record<string, string> | undefined, unitEdits?: Record<string, string | null>): { productId: string; qty: number; unitId?: string | null }[] {
  return r.items
    .filter(i => edits?.[i.productId] !== undefined || unitChanged(i, unitEdits?.[i.productId]))
    .map(i => ({
      productId: i.productId,
      qty: repItemQty(i.qty, edits?.[i.productId]),
      ...(unitChanged(i, unitEdits?.[i.productId]) && { unitId: unitEdits![i.productId] }),
    }));
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
      extra.push({ productId: i.productId, name: i.name, code: i.code, unit: i.baseUnit ?? i.unit, onHand: 0, ...(i.units && i.units.length > 0 ? { units: i.units } : {}) });
    }
  }
  return [...rows, ...extra];
}

/** ما طلبه المناديب أولاً (بما طلبوه أصلاً لا بالمعدَّل، فلا يقفز الترتيب أثناء الكتابة)، ثم الناقص، ثم البقية */
export function requestedFirst<T extends { productId: string; onHand: number }>(rows: T[], requested: Set<string>): T[] {
  return [...rows.filter(r => requested.has(r.productId)), ...shortFirst(rows.filter(r => !requested.has(r.productId)))];
}
