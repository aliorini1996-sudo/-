/**
 * مصافي تقارير تطبيق الإدارة على الجوال (طلب المالك ١٣ نوفمبر ٢٠٢٦) — منطقٌ نقيّ بلا React ولا شبكة، يُختبر وحده
 * (mReportFilters.test.ts). الشاشة (MReports.tsx وMReportFilterBar.tsx) ترسم ما يقرّره هذا الملف ولا تعيد اشتقاقه.
 *
 * أربعة أشياء هنا:
 *  1. **المدى**: ثمانية مديات جاهزة بتوقيت الجهاز (YYYY-MM-DD) و«هذا الشهر» افتراضاً — فلا يفتح التقرير على قصّ الخادم
 *     الصامت (آخر تسعين يوماً للمبيعات، وآخر سبعة أيام للساعات).
 *  2. **المصافي** (المندوب والعميل والفريق والموقع): أيّها يقرؤه الخادم لكل تقرير فيُرسَل معاملاً، وأيّها يُطبَّق على
 *     الجهاز لأن صفوف التقرير صفوف مندوبين أو عملاء أصلاً، وأيّها لا معنى له فيُخفى — مصفاةٌ ظاهرة فوق تقريرٍ لا يقرؤها
 *     كذبٌ صامت (الدرس نفسه في إخفاء مصفاة التاريخ عن الأرصدة اللحظية).
 *  3. **البحث والترتيب** داخل النتائج: بحثٌ يتسامح مع الهمزات والتشكيل والأرقام الهندية، وترتيبٌ مستقرّ.
 *  4. **التجميعان المتداخلان** في المبيعات (`thenBy`): «كم باع كل مندوب من كل صنف» — البحث يصل الصفوف الفرعية.
 *
 * ═══ الثابت الحاكم ═══
 * بلا مصفاة ولا بحث ولا تجميعٍ ثانٍ يبقى كل طلبٍ وكل صفٍّ كما كان قبل الميزة حرفاً: لا معامل فارغ يُرسَل، ولا ترتيب
 * يُفرض على ترتيب الخادم في الخيار الأول.
 */

import type { UnitDef } from '../lib/units';

/** معرّفات تقارير /m — مطابقة لـREPORTS في MReports.tsx */
export type MReportId = 'sales' | 'collections' | 'balances' | 'performance' | 'receivables' | 'hours' | 'visits' | 'unvisited';

// ═══════════════ ١) المدى ═══════════════

/**
 * YYYY-MM-DD **بتوقيت الجهاز** لا UTC — `toISOString().slice(0,10)` يعطي يوم UTC: في الرياض (+3) تقرأ الساعة الواحدة
 * ليلاً «أمس»، فيضغط المشرف «اليوم» ويرى مبيعات يومٍ مضى.
 */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export type PresetId = 'today' | 'yesterday' | 'week' | 'last7' | 'month' | 'lastMonth' | 'last30' | 'year';

/** المديات الجاهزة بترتيب الشريط — `label` مفتاح قاموس (tr في الشاشة) */
export const PRESETS: ReadonlyArray<{ id: PresetId; label: string }> = [
  { id: 'today', label: 'اليوم' },
  { id: 'yesterday', label: 'أمس' },
  { id: 'week', label: 'هذا الأسبوع' },
  { id: 'last7', label: 'آخر 7 أيام' },
  { id: 'month', label: 'هذا الشهر' },
  { id: 'lastMonth', label: 'الشهر الماضي' },
  { id: 'last30', label: 'آخر 30 يوما' },
  { id: 'year', label: 'هذه السنة' },
];

/** المدى عند أوّل فتح — «هذا الشهر» بدل «بلا مدى» (وتنبيه آخر التسعين يوماً لا يظهر افتراضاً) */
export const DEFAULT_PRESET: PresetId = 'month';

/** يومٌ بإزاحة أيامٍ من `now` بالتقويم المحلي — بالبناء من الأجزاء لا بطرح ميلي ثوانٍ (يومٌ بـ٢٣ ساعة عند تغيّر التوقيت) */
const dayOffset = (now: Date, days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);

export function presetRange(id: PresetId, now: Date = new Date()): { from: string; to: string } {
  const today = ymd(now);
  switch (id) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = ymd(dayOffset(now, -1)); return { from: y, to: y }; }
    // أسبوع العمل في السوق الخليجي يبدأ **السبت** (getDay: الأحد 0 … السبت 6)
    case 'week': return { from: ymd(dayOffset(now, -((now.getDay() + 1) % 7))), to: today };
    // «آخر ٧ أيام» تشمل اليوم: اليوم وستة قبله
    case 'last7': return { from: ymd(dayOffset(now, -6)), to: today };
    case 'month': return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    // اليوم صفر من الشهر الحالي = آخر يوم في الشهر الماضي
    case 'lastMonth': return {
      from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
    case 'last30': return { from: ymd(dayOffset(now, -29)), to: today };
    case 'year': return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: today };
  }
}

/**
 * المدى الجاهز الذي يطابق from/to الآن — `preferred` (آخر ما نُقر) أولاً: في أوّل الشهر «هذا الشهر» و«اليوم» مدىً واحد،
 * فيبقى مضيئاً ما نقره المشرف لا أوّل مطابقٍ في الشريط. لا مطابق ⇒ undefined («مخصص»).
 */
export function activePreset(from: string, to: string, preferred?: PresetId | null, now: Date = new Date()): PresetId | undefined {
  if (!from && !to) return undefined;
  const hit = (id: PresetId) => { const r = presetRange(id, now); return r.from === from && r.to === to; };
  if (preferred && hit(preferred)) return preferred;
  return PRESETS.find(p => hit(p.id))?.id;
}

// ═══════════════ ٢) المصافي ═══════════════

export type FilterKey = 'rep' | 'customer' | 'team' | 'location';
/** ما اختاره المشرف — الاسم محفوظٌ مع المعرّف: نتيجة البحث تتبدّل مع كل حرف فلا يُقرأ منها الاسم بعد الاختيار */
export interface FilterPick { id: string; name: string }
export type ReportFilters = Record<FilterKey, FilterPick | null>;

export const NO_FILTERS: ReportFilters = { rep: null, customer: null, team: null, location: null };
export const FILTER_KEYS: ReadonlyArray<FilterKey> = ['rep', 'customer', 'team', 'location'];
/** وسم الشريحة — مفاتيح قاموس */
export const FILTER_LABELS: Record<FilterKey, string> = { rep: 'المندوب', customer: 'العميل', team: 'الفريق', location: 'الموقع' };
/** «بلا فريق» — الخادم يفهمها (reportTeamOf) كما في تقارير الويب */
export const NO_TEAM = 'none';

/** server: معاملٌ يقرؤه الخادم · client: تصفيةٌ على الجهاز لأن الصفوف صفوف مندوبين أو عملاء */
export type FilterMode = 'server' | 'client';

/**
 * أيّ مصفاةٍ تنطبق على أيّ تقرير — مطابقٌ لعقد الخادم (routes/reports.ts):
 *  - المبيعات: الأربع في الخادم (الموقع بختم الفاتورة وقت إصدارها Invoice.locationId).
 *  - التحصيل: المندوب والعميل والفريق — **لا موقع**: سند القبض لا يُختم بموقع (لا عمود locationId في Receipt).
 *  - أرصدة العملاء: صفّ لكل عميل بلا مندوب ولا فريق (العملاء مشتركون) ⇒ العميل وحده على الجهاز.
 *  - أداء المناديب وساعات العمل: المندوب والموقع (موقع المندوب الحالي SalesRep.locationId) والفريق في الخادم.
 *  - مديونيات المناديب: الفريق في الخادم، والمندوب والموقع على الجهاز (صفّ لكل مندوب، وموقعه من قائمة المناديب).
 *  - زيارات العملاء: المندوب والعميل والفريق في الخادم — الزيارة لا تُختم بموقع.
 *  - لم تتم زيارتهم: صفّ لكل عميل ⇒ العميل بمعرّفه والمندوب بأسماء مناديبه المسندين، على الجهاز (الخادم لا يقرؤهما).
 */
export const FILTER_MODES: Record<MReportId, Partial<Record<FilterKey, FilterMode>>> = {
  sales: { rep: 'server', customer: 'server', team: 'server', location: 'server' },
  collections: { rep: 'server', customer: 'server', team: 'server' },
  balances: { customer: 'client' },
  performance: { rep: 'server', team: 'server', location: 'server' },
  receivables: { rep: 'client', team: 'server', location: 'client' },
  hours: { rep: 'server', team: 'server', location: 'server' },
  visits: { rep: 'server', customer: 'server', team: 'server' },
  unvisited: { rep: 'client', customer: 'client' },
};

/** اسم معامل الخادم لكل مصفاة */
const PARAM: Record<FilterKey, string> = { rep: 'salesRepId', customer: 'customerId', team: 'teamId', location: 'locationId' };

/**
 * ما يتاح أصلاً للمستخدم والشركة: المندوب بصلاحية المناديب (قائمتهم /sales-reps)، والعميل بصلاحية العملاء، والفريق حين
 * فعّلت الشركة الفرق ولها فرق، والموقع حين فعّل المالك «لوكيشن» (والمحاسبة مفعّلة) وللشركة مواقع.
 */
export type FilterAvail = Record<FilterKey, boolean>;

/** المصافي الظاهرة فوق هذا التقرير بترتيب الشريط */
export function filterKeysFor(report: MReportId, avail: FilterAvail): FilterKey[] {
  const modes = FILTER_MODES[report];
  return FILTER_KEYS.filter(k => !!modes[k] && avail[k]);
}

/** معاملات الخادم لهذا التقرير — المختار المنطبق في الخادم وحده، والفارغ لا يُرسل (فالطلب بلا مصافٍ كما كان حرفاً) */
export function filterParams(report: MReportId, f: ReportFilters, avail: FilterAvail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = f[k]?.id.trim();
    if (v && avail[k] && FILTER_MODES[report][k] === 'server') out[PARAM[k]] = v;
  }
  return out;
}

/** المختار الذي يُطبَّق على الجهاز لهذا التقرير — null إن لم يُختر أو لم ينطبق أو يقرؤه الخادم */
export function clientPick(report: MReportId, f: ReportFilters, avail: FilterAvail, key: FilterKey): FilterPick | null {
  return f[key] && avail[key] && FILTER_MODES[report][key] === 'client' ? f[key] : null;
}

/** مصافٍ مختارة لا تنطبق على هذا التقرير — تُذكر صراحةً بدل أن يظنّ المشرف الرقم مصفّى */
export function ignoredFilters(report: MReportId, f: ReportFilters, avail: FilterAvail): FilterKey[] {
  return FILTER_KEYS.filter(k => !!f[k] && !(avail[k] && FILTER_MODES[report][k]));
}

/** عدد المصافي المطبَّقة فعلاً على هذا التقرير (لشارة الشريط وزرّ «مسح الفلاتر») */
export function activeCount(report: MReportId, f: ReportFilters, avail: FilterAvail): number {
  return filterKeysFor(report, avail).filter(k => !!f[k]).length;
}

/** مفتاح كاشٍ ثابت للمختار — يدخل مفتاح كل استعلام فلا يعرض الكاش تقريراً بمصفاةٍ أخرى */
export function filtersKey(f: ReportFilters): string {
  return FILTER_KEYS.map(k => f[k]?.id ?? '').join('|');
}

// ═══════════════ ٣) البحث والترتيب ═══════════════

/**
 * تطبيع البحث العربي: الهمزات على الألف ألفٌ، والتاء المربوطة هاء، والألف المقصورة ياء، بلا تشكيلٍ ولا تطويل، والأرقام
 * الهندية لاتينية — فيجد «احمد» «أحمد» و«١٢٣» الرمز 123.
 */
export function normalizeSearch(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** كل كلمةٍ في البحث موجودةٌ في أحد الحقول — «أحمد رياض» يجد «أحمد — الرياض» */
export function matchesSearch(q: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const nq = normalizeSearch(q);
  if (!nq) return true;
  const hay = normalizeSearch(fields.filter(Boolean).join(' '));
  return nq.split(' ').every(t => hay.includes(t));
}

/**
 * default: ترتيب الخادم كما وصل · valueDesc/valueAsc: بالرقم الأساسي للتقرير (المبلغ، أو الوقت في الساعات) · count: العدد
 * أو الكمية تنازلياً · recent: الأحدث تاريخاً · name: أبجدياً.
 */
export type SortId = 'default' | 'valueDesc' | 'valueAsc' | 'count' | 'recent' | 'name';
/** خيار ترتيب في شاشة تقرير — `label` مفتاح قاموس، والخيار الأول هو البداية */
export interface SortOption { id: SortId; label: string }

export interface RowAccess<T> {
  name: (r: T) => string;
  /** حقول بحثٍ إضافية (الرمز، الجوال، رقم السند…) */
  extra?: (r: T) => ReadonlyArray<string | null | undefined>;
  value?: (r: T) => number;
  count?: (r: T) => number;
  /** تاريخ ISO للترتيب «الأحدث» */
  date?: (r: T) => string | null | undefined;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const byName = (a: string, b: string) => a.localeCompare(b, 'ar');

/** ترتيبٌ مستقرّ (Array.prototype.sort مستقرّ منذ ES2019) — خيارٌ بلا مُوصِلٍ يُبقي ترتيب الخادم */
export function sortRows<T>(rows: ReadonlyArray<T>, sort: SortId, acc: RowAccess<T>): T[] {
  const out = [...rows];
  const { value, count, date, name } = acc;
  if (sort === 'valueDesc' && value) out.sort((a, b) => num(value(b)) - num(value(a)));
  else if (sort === 'valueAsc' && value) out.sort((a, b) => num(value(a)) - num(value(b)));
  else if (sort === 'count' && count) out.sort((a, b) => num(count(b)) - num(count(a)) || (value ? num(value(b)) - num(value(a)) : 0));
  else if (sort === 'recent' && date) out.sort((a, b) => String(date(b) ?? '').localeCompare(String(date(a) ?? '')));
  else if (sort === 'name') out.sort((a, b) => byName(name(a) ?? '', name(b) ?? ''));
  return out;
}

/** البحث ثم الترتيب — ما تعرضه القائمة */
export function viewRows<T>(rows: ReadonlyArray<T>, q: string, sort: SortId, acc: RowAccess<T>): T[] {
  const hit = normalizeSearch(q) ? rows.filter(r => matchesSearch(q, [acc.name(r), ...(acc.extra?.(r) ?? [])])) : rows;
  return sortRows(hit, sort, acc);
}

/** الترتيب المختار إن كان من خيارات التقرير، وإلا أوّلها — خيارٌ محفوظ من تجميعٍ آخر لا يبقى معلّقاً */
export function sortOf(options: ReadonlyArray<SortOption>, sort: SortId | null | undefined): SortId {
  return options.some(o => o.id === sort) ? (sort as SortId) : (options[0]?.id ?? 'default');
}

// ═══════════════ ٤) المبيعات: تجميعان متداخلان ═══════════════

export type SalesLevel = 'rep' | 'customer' | 'product';
export const SALES_LEVELS: ReadonlyArray<SalesLevel> = ['rep', 'customer', 'product'];

/**
 * صفّ مبيعات (مستوى أول أو فرعي) كما يردّه الخادم: count للمندوب/العميل، وqty/baseQty/unit/units/primaryUnitId للصنف.
 * `key` يصل مع التجميع الثاني وحده: «—» = بلا مندوب (أو بلا عميل)، و«unknown» = صنف محذوف.
 */
export interface SalesRowLike {
  key?: string; name: string; total: number; count?: number; code?: string;
  qty?: number; baseQty?: number; unit?: string;
  units?: UnitDef[];
  primaryUnitId?: string | null;
}
export interface SalesNestedRow extends SalesRowLike { sub?: SalesRowLike[] }

/** خيارات «ثم حسب» — المستويان الآخران */
export function thenByChoices(groupBy: SalesLevel): SalesLevel[] {
  return SALES_LEVELS.filter(l => l !== groupBy);
}

/** التجميع الثاني الفعّال — المطابق للأول يسقط (الخادم يهمله أيضاً: thenByOf) */
export function effectiveThenBy(groupBy: SalesLevel, thenBy: SalesLevel | '' | null | undefined): SalesLevel | '' {
  return thenBy && thenBy !== groupBy && SALES_LEVELS.includes(thenBy) ? thenBy : '';
}

/** معاملات طلب المبيعات — `thenBy` يُرسل حين يُختار وحده، فبلاه الطلب كما كان حرفاً */
export function salesParams(groupBy: SalesLevel, thenBy: SalesLevel | '' | null | undefined): Record<string, string> {
  const t = effectiveThenBy(groupBy, thenBy);
  return t ? { groupBy, thenBy: t } : { groupBy };
}

/** الردّ متداخل فعلاً؟ — خادمٌ أقدم يُهمل thenBy فيردّ صفوفاً بلا `sub`، فتُعرض مسطّحةً كما كانت */
export function isNested(rows: ReadonlyArray<SalesNestedRow>): boolean {
  return rows.some(r => Array.isArray(r.sub));
}

/** مُوصِل صفوف المبيعات لمستوى — البحث بالاسم (والرمز للصنف)، والعدد = الفواتير أو الكمية بالأساس */
export function salesAccess(level: SalesLevel): RowAccess<SalesRowLike> {
  return {
    name: r => r.name ?? '',
    extra: r => (level === 'product' ? [r.code] : []),
    value: r => r.total,
    count: r => (level === 'product' ? num(r.baseQty ?? r.qty) : num(r.count)),
  };
}

export interface NestedView<R extends SalesNestedRow = SalesNestedRow> {
  row: R;
  /** الصفوف الفرعية المعروضة بعد البحث والترتيب */
  subs: SalesRowLike[];
  /** طابق البحثُ صفوفاً فرعية لا الصفّ نفسه ⇒ يُفتح تلقائياً ويعرض المطابق وحده */
  bySub: boolean;
}

/**
 * عرض التجميعين: البحث يطابق الصفّ (فيبقى بكل فروعه) أو فروعه (فيبقى بالمطابق منها مفتوحاً) — «بيبسي» تحت «حسب المندوب
 * ثم الصنف» تعرض كل مندوبٍ ببيبسي وحده: كم باع كلٌّ منهم منه. والترتيب نفسه على المستويين.
 * مجاميع الصفّ الأب تبقى كما ردّها الخادم (كل مبيعاته) — البحث يحدّد ما يُرى لا ما يُحسب.
 */
export function viewNested<R extends SalesNestedRow>(
  rows: ReadonlyArray<R>, q: string, sort: SortId, groupBy: SalesLevel, thenBy: SalesLevel,
): NestedView<R>[] {
  const pa = salesAccess(groupBy);
  const sa = salesAccess(thenBy);
  const searching = !!normalizeSearch(q);
  const out: NestedView<R>[] = [];
  for (const row of rows) {
    const subs = row.sub ?? [];
    if (!searching || matchesSearch(q, [pa.name(row), ...(pa.extra?.(row) ?? [])])) {
      out.push({ row, subs: sortRows(subs, sort, sa), bySub: false });
      continue;
    }
    const hit = subs.filter(s => matchesSearch(q, [sa.name(s), ...(sa.extra?.(s) ?? [])]));
    if (hit.length) out.push({ row, subs: sortRows(hit, sort, sa), bySub: true });
  }
  return sortRows(out, sort, {
    name: v => pa.name(v.row), value: v => v.row.total, count: v => pa.count!(v.row),
  });
}

/** حصّة الصفّ الفرعي من أبيه بالمئة — فقط حين مجموع الأب موجب (صافٍ بعد المرتجع قد يكون صفراً أو سالباً) */
export function shareOf(sub: number, parent: number): number | null {
  if (!(parent > 0) || !Number.isFinite(sub)) return null;
  return Math.round((sub / parent) * 100);
}
