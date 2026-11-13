/**
 * دقّة التقارير (طلب المالك ١٣ نوفمبر ٢٠٢٦ — البنود ٢ و٦ و٧ و٩) — منطقٌ صرفٌ مشترك بين الويب (pages/ReportsPage)
 * والجوال (m/MReports)، معزولٌ عن React ليُختبر وحده (reportsAccuracy.test.ts).
 *
 * - **ما يعلنه الخادم عن تقريره** (البندان ٧ و٩): كائن `meta` أعلى الردّ بجانب `data` — `truncated` و`limit` حين بلغ
 *   التقرير سقف الأمان فقصّ، و`appliedRange` المدى الذي طبّقه فعلاً (نافذته الافتراضية حين لم يُحدَّد مدى، أو المقصوص).
 *   والقراءة متسامحة: خادمٌ أقدم بلا الحقل ⇒ لا قصّ ولا مدى مُعلَن، فيبقى العرض والتصدير كما كانا حرفاً.
 * - **حالة العميل في الأرصدة** (البند ٢): المحظور والموقوف مدينون حقيقيّون يدخلون الإجمالي، وشارةٌ تميّزهم لا إخفاء.
 * - **نسبة التحصيل** (البند ٦): الخادم يحسبها (السندات + البيع النقدي المحصَّل) ÷ صافي المبيعات؛ ونسبة الشركة على
 *   الجوال من مجاميع الصفوف بالتعريف نفسه، وشريطها يُقصّ عند ١٠٠٪ (سندات ديونٍ قديمة قد تتجاوزها).
 *
 * كل نصٍّ هنا مفتاحُ `tr()` عربيٌّ كما هو — الترجمة عند المستدعي.
 */

type Tr = (ar: string) => string;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const dayOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * حوامل البيانات الوصفية في ردّ التقرير: `meta` أعلى الردّ أوّلاً (الاتفاق الموحّد، ومنه rangeClamped في ساعات العمل)،
 * ثم — احتياطاً لخادمٍ وضعها في موضعٍ آخر — جسم الردّ نفسه، و`data` حين تكون كائناً (لا مصفوفة صفوف) و`meta` داخلها.
 */
function holders(body: unknown): Record<string, unknown>[] {
  if (!isObj(body)) return [];
  const out: Record<string, unknown>[] = [];
  if (isObj(body.meta)) out.push(body.meta);
  out.push(body);
  if (isObj(body.data)) {
    if (isObj(body.data.meta)) out.push(body.data.meta);
    out.push(body.data);
  }
  return out;
}

/** المدى الذي طبّقه الخادم فعلاً — يوما YYYY-MM-DD بتعريف يوم التقرير نفسه، وnull في طرفٍ = بلا حدٍّ من جهته */
export interface AppliedRange { from: string | null; to: string | null; defaulted: boolean }

/** `meta.appliedRange` من جسم الردّ (axios `res.data`) — null من خادمٍ أقدم أو تقريرٍ بلا نافذة افتراضية */
export function appliedRangeOf(body: unknown): AppliedRange | null {
  for (const h of holders(body)) {
    const r = h.appliedRange;
    if (!isObj(r)) continue;
    const from = dayOf(r.from);
    const to = dayOf(r.to);
    if (from || to) return { from, to, defaulted: r.defaulted === true };
  }
  return null;
}

/** القصّ: `truncated` صادقٌ وحده يعني أن الخادم بلغ سقفه، و`limit` السقف (عدد السجلّات الخام أو صفوف القائمة) */
export interface Truncation { truncated: boolean; limit: number | null }

export function truncationOf(body: unknown): Truncation {
  for (const h of holders(body)) {
    if (h.truncated !== true) continue;
    const lim = Number(h.limit);
    return { truncated: true, limit: Number.isFinite(lim) && lim > 0 ? lim : null };
  }
  return { truncated: false, limit: null };
}

/** المدى نصّاً بصيغة رأس PDF القائمة: «من — إلى»، أو «من X» / «إلى Y» لطرفٍ واحد، أو «كل الفترات» بلا طرفين */
export function rangeText(from: string | null | undefined, to: string | null | undefined, tr: Tr): string {
  if (from && to) return `${from} — ${to}`;
  if (from) return `${tr('من')} ${from}`;
  if (to) return `${tr('إلى')} ${to}`;
  return tr('كل الفترات');
}

/**
 * «الفترة» في رأس PDF وورقة Excel (البند ٩): المدى الذي طبّقه الخادم حين يُعلنه — فلا يُطبع «كل الفترات» فوق تسعين يوماً،
 * ولا ثلاثة أشهرٍ طُلبت فوق شهرٍ قُصّ إليه — موسوماً بأنه افتراضيّ حين اختاره الخادم. وبلا إعلانٍ ما أدخله المستخدم كما اليوم.
 */
export function periodText(applied: AppliedRange | null | undefined, from: string, to: string, tr: Tr): string {
  if (!applied) return rangeText(from || null, to || null, tr);
  const base = rangeText(applied.from, applied.to, tr);
  return applied.defaulted ? `${base} (${tr('مدى افتراضي من الخادم')})` : base;
}

/** تنبيه الشاشة حين اختار الخادم نافذته الافتراضية — بتاريخيها كما طُبّقا؛ ولا شيء لمدىً حدّده المستخدم */
export function defaultedRangeNote(applied: AppliedRange | null | undefined, tr: Tr): string | null {
  if (!applied?.defaulted) return null;
  // نافذةٌ افتراضية بلا طرفٍ أعلى (الطلبات: التسليمات القادمة داخلة) — لا يقال «إلى … فقط»
  if (applied.from && !applied.to) return tr('بلا تحديد مدة يعرض الخادم من {from} فصاعدا').replace('{from}', applied.from);
  return tr('بلا تحديد مدة يعرض الخادم الفترة من {from} إلى {to} فقط')
    .replace('{from}', applied.from ?? '…')
    .replace('{to}', applied.to ?? '…');
}

/**
 * نصّ تنبيه القصّ (البند ٧):
 * - `newest` لتقارير الزيارات: الخادم أبقى أحدث N سجلاً خاماً فالأرقام عنها وحدها؛
 * - `list` للمرتجع والطلبات على الشاشة: الإجماليات من القاعدة كاملةً (البطاقات أعلى الجدول) والقائمة وحدها مقطوعة عند N
 *   صفّاً (الطلبات بالأقرب تسليماً، فلا يقال «أحدث» عنها) — وبلا `limit` يُعدّ ما وصل من الصفوف، فهو السقف نفسه؛
 * - `listExport` للتنبيه نفسه في PDF وExcel: لا بطاقات «أعلاه» في الملف — الإجمالي ورقةٌ في أوّله (ReportsPage buildSheets).
 */
export function truncationNote(t: Truncation | null | undefined, tr: Tr, fmt: (n: number) => string, kind: 'newest' | 'list' | 'listExport', shown = 0): string | null {
  if (!t?.truncated) return null;
  if (kind === 'list' || kind === 'listExport') {
    const n = t.limit ?? (shown > 0 ? shown : null);
    const text = kind === 'list'
      ? 'القائمة مقطوعة عند {n} سجل والإجماليات أعلاه تشمل الفترة كاملة — ضيق الفترة لعرض كل السجلات'
      : 'القائمة مقطوعة عند {n} سجل والإجمالي في أول الملف يشمل الفترة كاملة — ضيق الفترة لعرض كل السجلات';
    return n != null ? tr(text).replace('{n}', fmt(n)) : tr('النتيجة مقطوعة عند الحد الأقصى — ضيق الفترة لنتيجة كاملة');
  }
  return t.limit != null
    ? tr('عرض أحدث {n} سجل فقط — ضيق الفترة لنتيجة كاملة').replace('{n}', fmt(t.limit))
    : tr('النتيجة مقطوعة عند الحد الأقصى — ضيق الفترة لنتيجة كاملة');
}

/* ═══ البند ٢: حالة العميل في «أرصدة العملاء» ═══ */

/** نصّ الحالة لعمود Excel — مفاتيح tr قائمة («نشط» «غير نشط» «محظور»)؛ وحالةٌ لا يعرفها العميل تُكتب كما وصلت */
export function customerStatusLabel(status: string | null | undefined): string {
  return status === 'BLOCKED' ? 'محظور' : status === 'INACTIVE' ? 'غير نشط' : status === 'ACTIVE' ? 'نشط' : (status ?? '');
}

/** شارة الاسم: للمحظور والموقوف وحدهما — النشط بلا شارة كما كان */
export function customerStatusBadge(status: string | null | undefined): 'محظور' | 'غير نشط' | null {
  return status === 'BLOCKED' ? 'محظور' : status === 'INACTIVE' ? 'غير نشط' : null;
}

/** هل أرسل الخادم الحالة؟ — عمود «الحالة» في Excel لا يُضاف لردٍّ أقدم بلاها (الملف كما كان حرفاً) */
export const hasCustomerStatus = (rows: readonly { status?: string | null }[] | null | undefined): boolean =>
  !!rows?.some((r) => typeof r.status === 'string');

/* ═══ البند ٦: نسبة التحصيل والبيع النقدي المحصَّل ═══ */

export interface PerfLike { salesTotal: number; collectionsTotal: number; cashSalesTotal?: number | null }

/** هل أرسل الخادم «مبيعات نقدية محصّلة»؟ — عمودها وبطاقتها وشرح النسبة لا تظهر لخادمٍ أقدم (نسبته سندات وحدها) */
export const perfHasCash = (rows: readonly PerfLike[] | null | undefined): boolean =>
  !!rows?.some((r) => typeof r.cashSalesTotal === 'number');

/**
 * نسبة تحصيل المعروض من **المجاميع** (لا متوسّط نسب المناديب) بتعريف الخادم لكل صفّ: (السندات + البيع النقدي المحصَّل) ÷
 * صافي المبيعات، نسبةً صحيحة، و0 بلا مبيعات. وخادمٌ أقدم بلا الحقل ⇒ السندات وحدها كما كانت.
 */
export function perfCompanyRate(rows: readonly PerfLike[]): number {
  let sales = 0;
  let collected = 0;
  for (const r of rows) {
    sales += Number(r.salesTotal) || 0;
    collected += (Number(r.collectionsTotal) || 0) + (Number(r.cashSalesTotal) || 0);
  }
  return sales > 0 ? Math.round((collected / sales) * 100) : 0;
}

/** عرض شريط النسبة: بين ٠ و١٠٠ — النسبة نفسها تُكتب كما هي ولو تجاوزت ١٠٠٪ */
export const rateBarWidth = (rate: number): number => Math.max(0, Math.min(100, Number(rate) || 0));

/* ═══ البند ٧: إجماليات المرتجع والطلبات من الخادم ═══ */

/**
 * إجماليّا القائمة: بلا بحثٍ من ملخّص الخادم — محسوبٌ في القاعدة على كل مستندات المدى ولو قُصّت القائمة عند سقفها؛
 * ومع البحث مجموع المطابق المعروض (التصدير يتبع المعروض). وخادمٌ أقدم ملخّصه من الصفوف نفسها فالرقم كما كان.
 */
export function listTotals<R>(
  summary: { count: number; total: number } | null | undefined,
  rows: readonly R[],
  totalOf: (r: R) => number,
  searching: boolean,
): { count: number; total: number } {
  if (!searching && summary && Number.isFinite(Number(summary.count)) && Number.isFinite(Number(summary.total))) {
    return { count: Number(summary.count), total: Math.round(Number(summary.total) * 1e6) / 1e6 };
  }
  return { count: rows.length, total: Math.round(rows.reduce((t, r) => t + (Number(totalOf(r)) || 0), 0) * 1e6) / 1e6 };
}
