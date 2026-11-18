/**
 * «المحاسب الذكي AI» — منطق بطاقة التقرير وورقته (نقيّ قدر الإمكان فيُختبر بلا متصفّح):
 * اسم نوع التقرير، ومقطع الفترة في اسم الملف («قائمة-الدخل-2026-11.pdf»)، وتنسيق سطر التقرير بالعملة،
 * وتسطيح الأقسام وتقطيعها شرائح A4 لا تتجاوز صفحة، ووثيقة الطباعة.
 *
 * الأرقام تأتي محسوبةً من الخادم (أدوات المحاسب) — هنا عرضٌ فقط: لا جمع ولا طرح، والتقريب لمنازل العملة وحده.
 * والنصوص القادمة من الخادم (العنوان والبنود والملاحظات) تُرسم عبر React لا innerHTML — فلا حقن في الورقة ولا في الطباعة.
 * وعناوين الأقسام والبنود وملاحظاتها تمرّ عبر tr (تعيد المجهول كما هو): الثابتة منها من أدوات الخادم مترجمةٌ في القاموس،
 * وأسماء العملاء والأصناف والحسابات تبقى كما هي.
 */
import type { AiReport } from '../../../lib/aiAccountant';
import { currencyDecimals } from '../../../i18n/countries';
import { formatCurrency, formatDayOnly } from '../../../utils/format';

export type ReportKind = AiReport['kind'];
export type ReportSection = AiReport['sections'][number];
export type ReportRow = ReportSection['rows'][number];
export type ReportPeriod = AiReport['period'];
type Tr = (ar: string) => string;
const same: Tr = (s) => s;

/** الاسم المعتمد لنوع التقرير — لاسم الملف وللورقة، وعنوانٌ للبطاقة والترويسة بغير العربية (reportTitle) */
export function reportKindName(kind: string, tr: Tr = same): string {
  switch (kind) {
    case 'income-statement': return tr('قائمة الدخل');
    case 'balance-sheet': return tr('الميزانية العمومية');
    case 'trial-balance': return tr('ميزان المراجعة');
    case 'executive-summary': return tr('الملخص التنفيذي');
    case 'general-ledger': return tr('دفتر الأستاذ العام');
    case 'sales': return tr('ملخص المبيعات');
    case 'collections': return tr('ملخص التحصيل');
    case 'purchases-inventory': return tr('المشتريات والمخزون');
    case 'receivables': return tr('ذمم العملاء');
    case 'expenses': return tr('المصروفات');
    case 'profit-estimate': return tr('تقدير الربح');
    case 'top': return tr('أفضل العملاء والأصناف');
    default: return '';
  }
}

/**
 * عنوان البطاقة وترويسة الورقة: بالعربية عنوان الخادم كما هو (قد يحمل تفصيلاً: «ذمم العملاء كما في …»، «تقدير الربح
 * الإجمالي»)، وبغيرها اسم النوع مترجماً — عنوان الخادم عربيٌّ دائماً فكان يبقى عربياً في ترويسة PDF الإنجليزية.
 * نوعٌ مجهول ⇒ عنوان الخادم (عبر tr)، وبلا شيء ⇒ «تقرير».
 */
export function reportTitle(report: Pick<AiReport, 'kind' | 'title'>, lang: string, tr: Tr = same): string {
  const server = String(report.title ?? '').trim();
  const kindName = reportKindName(report.kind, tr);
  if (lang === 'ar') return server || kindName || tr('تقرير');
  return kindName || (server ? tr(server) : '') || tr('تقرير');
}

/** التقرير «تقديري» (ربحٌ بلا دفاتر من المبيعات وتكلفة المخزون) — لا يُقدَّم أبداً كأنه من القيود */
export function isEstimatedReport(report: Pick<AiReport, 'kind' | 'estimated'>): boolean {
  return report.estimated === true || report.kind === 'profit-estimate';
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** الشهر التالي لـ«YYYY-MM» نصّاً (ديسمبر ⇒ يناير السنة التالية) */
function nextMonth(y: string, m: string): string {
  const n = Number(m) === 12 ? `${Number(y) + 1}-01` : `${y}-${String(Number(m) + 1).padStart(2, '0')}`;
  return n;
}

/**
 * مقطع الفترة في اسم الملف بأرقام لاتينية وصيغة ISO (يُفرز ويُقرأ في أي نظام):
 * شهرٌ (من أوّله إلى أيّ يومٍ منه، أو إلى أوّل الشهر التالي حدّاً مفتوحاً) ⇒ «2026-11»؛ سنةٌ كاملة ⇒ «2026»؛
 * يومٌ واحد ⇒ «2026-11-18»؛ وغير ذلك ⇒ «2026-01-01_2026-03-31». وبلا فترة ⇒ ''.
 */
export function reportPeriodSlug(period: ReportPeriod | null | undefined): string {
  if (!period) return '';
  const f = DAY.exec(String(period.from ?? ''));
  const t = DAY.exec(String(period.to ?? ''));
  if (!f || !t) return '';
  const from = f[0];
  const to = t[0];
  if (from === to) return from;
  if (f[2] === '01' && f[3] === '01' && t[1] === f[1] && t[2] === '12' && t[3] === '31') return f[1];
  if (f[3] === '01') {
    const sameMonth = f[1] === t[1] && f[2] === t[2];
    const nextFirst = t[3] === '01' && nextMonth(f[1], f[2]) === `${t[1]}-${t[2]}`;
    if (sameMonth || nextFirst) return `${f[1]}-${f[2]}`;
  }
  return `${from}_${to}`;
}

/** اسم ملف آمن على كل نظام: بلا \ / : * ? " < > | والمسافات شرطات — «قائمة-الدخل-2026-11.pdf» */
export function reportFileName(report: Pick<AiReport, 'kind' | 'title' | 'period'>, tr: Tr = same): string {
  const base = reportKindName(report.kind, tr) || String(report.title ?? '').trim() || tr('تقرير');
  const name = [base, reportPeriodSlug(report.period)].filter(Boolean).join(' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return `${name || 'report'}.pdf`;
}

/** الفترة نصّاً ميلادياً بلغة الواجهة (formatDayOnly: ca-gregory) — يومٌ واحد بلا شرطة، وبلا فترة ⇒ '' */
export function reportPeriodText(period: ReportPeriod | null | undefined, fmtDay: (d: string) => string = formatDayOnly): string {
  if (!period || !period.from || !period.to) return '';
  return period.from === period.to ? fmtDay(period.from) : `${fmtDay(period.from)} — ${fmtDay(period.to)}`;
}

/** سطر التقرير جاهزاً للرسم */
export interface ReportRowView {
  label: string;
  /** المبلغ منسّقاً بالعملة، أو نصّ السطر (عدد/نسبة) حين لا مبلغ، أو '' */
  value: string;
  /**
   * نصّ السطر بجانب البند حين يحمل مبلغاً أيضاً («١٢ فاتورة»، «٣ سند»، كمية الصنف، «محظور») — الخادم يضع العدد بجانب
   * أغلب سطور المال، فلو رُسم النص حين لا مبلغ وحده لضاعت أعداد الفواتير وكميات الأصناف وحالة العميل. وإلا ''.
   */
  note: string;
  level: 0 | 1 | 2;
  bold: boolean;
  negative: boolean;
  /** لا مبلغ (نصٌّ أو فراغ) — يُرسم بلونٍ أهدأ */
  muted: boolean;
}

/**
 * يقرّب المبلغ لمنازل عملته (٢ للريال، ٣ للدينار) قبل التنسيق: سالبٌ يقرَّب صفراً يُكتب «0.00» لا «-0.00»،
 * ولا يُلوَّن أحمر.
 */
export function roundToCurrency(amount: number, currency: string): number {
  const dec = currencyDecimals(currency || 'SAR');
  const f = 10 ** dec;
  const v = Math.round(amount * f) / f;
  return Object.is(v, -0) || v === 0 ? 0 : v;
}

const hasAmount = (row: Pick<ReportRow, 'amount'>): boolean => typeof row.amount === 'number' && Number.isFinite(row.amount);

/** ملاحظة السطر بجانب بنده: نصّه حين يحمل مبلغاً أيضاً (بلا مبلغ يصير النصّ هو القيمة)، وإلا '' */
export function rowNote(row: Pick<ReportRow, 'amount' | 'text'>): string {
  return hasAmount(row) ? String(row.text ?? '').trim() : '';
}

/**
 * سطرٌ للعرض: المبلغ بالعملة وبنظام أرقام الشركة (formatCurrency — العربية أو اللاتينية كما اختارت الشركة)،
 * وبلا مبلغ ⇒ نصّ السطر كما هو (مثل «١٢ فاتورة»)، ومعه مبلغ ⇒ النصّ ملاحظةٌ بجانب البند (note)،
 * والمستوى ٠–٢ فقط (غيره ⇒ ٠).
 */
export function reportRowView(
  row: ReportRow,
  currency: string,
  fmt: (amount: number, currency?: string) => string = formatCurrency,
): ReportRowView {
  const level: 0 | 1 | 2 = row.level === 1 || row.level === 2 ? row.level : 0;
  const has = hasAmount(row);
  const amount = has ? roundToCurrency(row.amount as number, currency) : 0;
  return {
    label: String(row.label ?? ''),
    value: has ? fmt(amount, currency || undefined) : String(row.text ?? '').trim(),
    note: rowNote(row),
    level,
    bold: row.bold === true,
    negative: has && amount < 0,
    muted: !has,
  };
}

/** سطرٌ مسطّح من أقسام التقرير: عنوان قسم، أو بند، أو «لا توجد بيانات» */
export type FlatRow =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'row'; key: string; row: ReportRow }
  | { kind: 'empty'; key: string };

/** الأقسام سطوراً متتالية بمفاتيح ثابتة — قسمٌ معنون بلا بنود ⇒ سطر «لا توجد بيانات» تحته، وتقريرٌ فارغ كلّه ⇒ سطرٌ واحد */
export function flattenReport(report: Pick<AiReport, 'sections'>): FlatRow[] {
  const out: FlatRow[] = [];
  (report.sections ?? []).forEach((s, si) => {
    const rows = s.rows ?? [];
    if (s.title) out.push({ kind: 'section', key: `s${si}`, title: s.title });
    if (!rows.length && s.title) out.push({ kind: 'empty', key: `s${si}e` });
    rows.forEach((row, ri) => out.push({ kind: 'row', key: `s${si}r${ri}`, row }));
  });
  if (!out.some((r) => r.kind === 'row')) {
    return out.some((r) => r.kind === 'empty') ? out : [...out, { kind: 'empty', key: 'e' }];
  }
  return out;
}

/** سعة الشريحة بوحدة «سطرٍ قصير» (~٢٤ بكسل): الأولى تحمل الترويسة وصندوق البيانات فأقلّ */
export const SLICE_CAPACITY = { first: 24, rest: 38 } as const;

/** وزن السطر: عنوان القسم أطول قليلاً، والبند الطويل (مع ملاحظته بجانبه) يلتفّ سطرين */
export function rowWeight(r: FlatRow): number {
  if (r.kind === 'section') return 1.4;
  if (r.kind === 'row') {
    const note = rowNote(r.row);
    return String(r.row.label ?? '').length + (note ? note.length + 1 : 0) > 55 ? 2 : 1;
  }
  return 1;
}

/** وزن ذيل الورقة الأخيرة: الملاحظات (الطويلة سطران) وسطر «أعدّه المحاسب الذكي» */
export function notesWeight(notes: readonly string[] | null | undefined): number {
  const n = (notes ?? []).reduce((w, s) => w + (String(s).length > 90 ? 2 : 1.2), 0);
  return n + 2;
}

/**
 * يقطّع السطور شرائح لا تتجاوز صفحة A4 (elementsToPdfBlob يقصّ الشريحة الأطول من صفحةٍ بالارتفاع وحده فيشقّ سطراً):
 * عنوان قسمٍ لا يبقى يتيماً آخر الشريحة (يُنقل مع بنده التالي)، والذيل (الملاحظات) إن لم يتّسع له آخر شريحة ⇒ شريحةٌ له.
 */
export function paginateReport(
  rows: readonly FlatRow[],
  cap: { first: number; rest: number } = SLICE_CAPACITY,
  tailWeight = 0,
): FlatRow[][] {
  const slices: FlatRow[][] = [[]];
  let used = 0;
  let room = cap.first;
  for (const r of rows) {
    const w = rowWeight(r);
    let cur = slices[slices.length - 1];
    if (cur.length && used + w > room) {
      const carry: FlatRow[] = [];
      // عنوان القسم اليتيم آخر الشريحة ينتقل مع أوّل بنده (ما لم يكن وحده في الشريحة)
      const last = cur[cur.length - 1];
      if (r.kind !== 'section' && last.kind === 'section' && cur.length > 1) carry.push(cur.pop() as FlatRow);
      cur = [...carry];
      slices.push(cur);
      room = cap.rest;
      used = carry.reduce((s, x) => s + rowWeight(x), 0);
    }
    cur.push(r);
    used += w;
  }
  if (tailWeight > 0 && used + tailWeight > room && slices[slices.length - 1].length) slices.push([]);
  return slices;
}

/** طريقة تسليم الملف: في /m (الجوال وتطبيق الإدارة) مشاركةٌ ثم تنزيل، وفي اللوحة تنزيلٌ مباشر */
export function pdfDeliveryFor(pathname: string): 'share' | 'download' {
  return /^\/m(\/|$)/.test(pathname) ? 'share' : 'download';
}

const escAttr = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** أنماط الصفحة (الخطوط) لوثيقة الطباعة — كـheadStyles في rep/printPage.ts (غير مُصدَّرة) فيطابق المطبوعُ ملفَّ الـPDF */
export function pageHeadHtml(doc: Document = document): string {
  const origin = doc.defaultView?.location?.origin ?? '';
  const base = origin ? `<base href="${escAttr(origin)}/"/>` : '';
  return base + Array.from(doc.querySelectorAll('head link[rel="stylesheet"], head style')).map((n) => n.outerHTML).join('');
}

/**
 * وثيقة الطباعة (نقيّة): شرائح الورقة المرسومة (outerHTML لعقدةٍ رسمها React — نصوصها مهرّبة) كلٌّ في صفحة A4،
 * وحشوة الشريحة العلوية/السفلية تُلغى لأن هوامش @page تقوم مقامها، وصفّ الجدول لا يُشقّ بين صفحتين.
 */
export function buildReportPrintHtml(slicesHtml: readonly string[], headHtml = ''): string {
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"/>${headHtml}
  <style>
    @page { size: A4; margin: 10mm 0; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .ai-sheet { width: 794px; margin: 0 auto; }
    .ai-sheet [data-pdf-slice] { padding-top: 0 !important; padding-bottom: 0 !important; }
    .ai-sheet + .ai-sheet { break-before: page; page-break-before: always; }
    tr { break-inside: avoid; page-break-inside: avoid; }
  </style></head><body>${slicesHtml.map((h) => `<div class="ai-sheet">${h}</div>`).join('')}</body></html>`;
}
