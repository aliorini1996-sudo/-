/**
 * PDF مُرقَّم عند حدود الصفوف (DESIGN.md §7.1 البند 6، RPT‑01) — جارُ `rep/pdf.ts` ولا يعدّله.
 *
 * لماذا ملفٌّ جديد: `elementToPdfBlob` يلتقط عنصراً واحداً ثم **يقصّه** بارتفاع الصفحة، فيقع
 * القصّ في منتصف الصفّ، ولا ترويسة تتكرر، ويتجاوز العنصرُ الطويل سقوف لوحة الرسم
 * (‏32,767px بُعداً في Chrome ونحو 16.7 مليون بكسل مساحةً في Safari على iOS) فيخرج بياضاً صامتاً.
 *
 * هنا العكس: الصفوف تُوزَّع أولاً على صفحات **بلا كسر صفٍّ أبداً**، ثم تُبنى لكل صفحة كتلة DOM
 * مستقلّة بعرض A4 الثابت (794px = 210mm عند 96dpi) وارتفاعها 1123px، تُلتقط لوحةَ رسمٍ وحدها
 * وتُحرَّر قبل التالية — فلا يقترب التقاطٌ واحد من أي سقف مهما طال التقرير.
 *
 * العربية عبر html2canvas (مسار المستودع المختار، G7): النصّ يُرسم في المتصفّح ثم يُلتقط صورةً،
 * فلا حاجة إلى خطٍّ عربي داخل jsPDF ولا إلى `jspdf-autotable` (ممنوعة صراحةً في §7.1).
 *
 * **كل النصوص تمرّ بـ`tr('…')`**: المُستدعي يمرّر `tr` من `useTr()`، وبغيابه تُعرض العربية كما هي.
 *
 * مستهلكوه: `ReportView` (§7.1) و`MLedgerReport` بمقياس 1.5 (§8.5) وحزمة القوائم المالية.
 */

// ═══ أبعاد الصفحة (px عند 96dpi) ═══

/** عرض A4 ثابتاً: 210mm عند 96dpi. كل كتلة صفحة تُبنى بهذا العرض حرفياً (§7.1). */
export const PDF_PAGE_WIDTH_PX = 794;
/** ارتفاع A4: 297mm عند 96dpi. نسبته إلى العرض = نسبة صفحة jsPDF، فلا تشويه في الالتقاط. */
export const PDF_PAGE_HEIGHT_PX = 1123;
export const PDF_PAGE_PADDING_PX = 28;
/** عنوان التقرير وخطّ الهوية أسفله */
export const PDF_TITLE_HEIGHT_PX = 44;
/** سطر ترويسة واحد (الشركة، الفترة، الخيارات، تاريخ الطباعة…) */
export const PDF_META_LINE_HEIGHT_PX = 17;
/** شريط رؤوس الأعمدة (يتكرر في كل صفحة) */
export const PDF_COLUMNS_HEIGHT_PX = 28;
/** تذييل «صفحة n من N» */
export const PDF_FOOTER_HEIGHT_PX = 26;
export const PDF_ROW_HEIGHT_PX = 22;
/** صفّ عنوان (حساب في دفتر الأستاذ، قسم في القائمة) */
export const PDF_HEAD_ROW_HEIGHT_PX = 26;

/**
 * الارتفاع المتاح للصفوف في صفحة واحدة. الترويسة ورؤوس الأعمدة والتذييل تتكرر في **كل** صفحة،
 * فهي ثابتة تُطرح مرة واحدة ولا تتغيّر بين الصفحات (§7.1: «تكرّر ترويسة الشركة والفترة ورؤوس الأعمدة»).
 */
export function pdfBodyHeight(metaLineCount = 0): number {
  const chrome =
    PDF_PAGE_PADDING_PX * 2 +
    PDF_TITLE_HEIGHT_PX +
    Math.max(0, metaLineCount) * PDF_META_LINE_HEIGHT_PX +
    PDF_COLUMNS_HEIGHT_PX +
    PDF_FOOTER_HEIGHT_PX;
  return Math.max(PDF_ROW_HEIGHT_PX, PDF_PAGE_HEIGHT_PX - chrome);
}

// ═══ العقد ═══

export interface PagedPdfColumn {
  /** عنوان العمود كما يُطبع (عربيٌّ جاهز — المُستدعي مرّره على `tr`) */
  label: string;
  /** حصّة العمود من العرض (أي مقياس؛ تُنسَّب إلى مجموع الحصص). الافتراضي 1 */
  width?: number;
  /** محاذاة الخلية: `end` للأرقام */
  align?: 'start' | 'end' | 'center';
}

export interface PagedPdfRow {
  /** خلايا الصفّ بترتيب الأعمدة (‏`null`/`undefined` = خلية فارغة) */
  cells: readonly (string | number | null | undefined)[];
  /** عمق الشجرة: إزاحة الخلية النصّية الأولى (RPT‑07) */
  level?: number;
  /** صفّ مجموع — عريض */
  strong?: boolean;
  /** صفّ باهت (صفري) */
  muted?: boolean;
  /** صفّ عنوان (حساب/قسم) — أعلى قليلاً وبخلفية */
  head?: boolean;
  /**
   * صفّ «رصيد مُرحَّل»: يُعاد طبعه أعلى كل صفحة تالية حتى يظهر صفٌّ مثله (§7.1، §7.5).
   * في دفتر الأستاذ هو الصفّ الافتتاحي للحساب، فلا تُقرأ صفحةٌ وسطى بلا رصيدها المُرحَّل.
   */
  carry?: boolean;
}

/** صفحةٌ بعد التوزيع: صفوفها، والصفّ المُرحَّل المُعاد طبعه أعلاها (‏`null` في الصفحة الأولى للحساب). */
export interface PagedPdfPage {
  /** رقم الصفحة، يبدأ من 1 */
  index: number;
  /** عدد الصفحات كلها — يُملأ بعد التوزيع فيصحّ «صفحة n من N» */
  total: number;
  /** الصفّ المُرحَّل المكرَّر أعلى الصفحة (لا يُعدّ من صفوف البيانات) */
  carry: PagedPdfRow | null;
  rows: PagedPdfRow[];
}

export interface PaginateOptions {
  /** ارتفاع منطقة الصفوف؛ الافتراضي `pdfBodyHeight()` */
  bodyHeight?: number;
  rowHeight?: number;
  headRowHeight?: number;
  /** ارتفاع صفّ بعينه (لسطرٍ يلتفّ على سطرين مثلاً) */
  heightOf?: (row: PagedPdfRow) => number;
}

/** ارتفاع صفٍّ افتراضاً: صفّ العنوان أعلى من صفّ البيانات. صرفة. */
export function defaultRowHeight(row: PagedPdfRow, opts: PaginateOptions = {}): number {
  const head = opts.headRowHeight ?? PDF_HEAD_ROW_HEIGHT_PX;
  const normal = opts.rowHeight ?? PDF_ROW_HEIGHT_PX;
  return row.head === true ? head : normal;
}

/**
 * يوزّع الصفوف على صفحات **بلا كسر صفٍّ أبداً** (§7.1 البند 6). صرفة وحتمية — تُختبر بلا DOM.
 *
 * - الصفّ الذي لا يسع وحده صفحةً فارغة يُوضع في صفحته كاملاً (لا يُقصّ، ولا حلقة لا نهائية).
 * - صفّ `carry` يُعاد طبعه أعلى كل صفحة تالية حتى يظهر صفّ `carry` آخر، ويُحتسب ارتفاعه
 *   من ارتفاع الصفحة فلا يزيح آخر صفّ خارجها.
 * - المدخل الفارغ ⇒ لا صفحات (المُستدعي يطبع صفحة «لا توجد بيانات»).
 */
export function paginateRows(rows: readonly PagedPdfRow[], opts: PaginateOptions = {}): PagedPdfPage[] {
  const bodyHeight = Math.max(1, opts.bodyHeight ?? pdfBodyHeight());
  const heightOf = opts.heightOf ?? ((r: PagedPdfRow) => defaultRowHeight(r, opts));

  const pages: PagedPdfPage[] = [];
  /** آخر صفّ مُرحَّل رُئي حتى الآن (يتجاوز حدود الصفحات) */
  let activeCarry: PagedPdfRow | null = null;
  /** المُرحَّل الذي تبدأ به الصفحة الجارية (‏`null` حين بدأت بصفّه الأصلي) */
  let pageCarry: PagedPdfRow | null = null;
  let current: PagedPdfRow[] = [];
  let used = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    pages.push({ index: pages.length + 1, total: 0, carry: pageCarry, rows: current });
    current = [];
    used = 0;
    pageCarry = activeCarry;
  };

  for (const row of rows) {
    const h = heightOf(row);
    if (current.length > 0 && used + h > bodyHeight) flush();
    // صفحةٌ تبدأ بالمُرحَّل: احجز ارتفاعه قبل أول صفّ بيانات فيها فلا يزيح آخر صفّ خارجها
    if (current.length === 0 && pageCarry !== null) used = heightOf(pageCarry);
    current.push(row);
    used += h;
    if (row.carry === true) {
      activeCarry = row;
      // الصفّ الأصلي مطبوعٌ في هذه الصفحة، فلا يُعاد طبعه أعلاها
      if (pageCarry !== null && current.length === 1) pageCarry = null;
    }
  }
  flush();

  const total = pages.length;
  for (const p of pages) p.total = total;
  return pages;
}

/** مقياس الالتقاط: 2 على سطح المكتب و1.5 على أجهزة اللمس (§7.1). صرفة. */
export function pdfCaptureScale(maxTouchPoints: number): number {
  return maxTouchPoints > 0 ? 1.5 : 2;
}

/** المقياس من المتصفّح الحالي (بلا انهيار خارج المتصفّح). */
export function currentCaptureScale(): number {
  const n = typeof navigator === 'undefined' ? 0 : Number(navigator.maxTouchPoints ?? 0);
  return pdfCaptureScale(Number.isFinite(n) ? n : 0);
}

/** نصّ التذييل «صفحة n من N». صرفة. */
export function pageFooterText(index: number, total: number, tr: (ar: string) => string = (s) => s): string {
  return `${tr('صفحة')} ${index} ${tr('من')} ${total}`;
}

/** هروب HTML — البيانات تُطبع نصّاً لا ترميزاً. صرفة. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** إزاحة الشجرة داخل الخلية النصّية الأولى (RPT‑07). صرفة. */
export function levelPaddingPx(level: number | undefined): number {
  const l = Number.isFinite(level) ? Math.max(0, Math.trunc(level as number)) : 0;
  return Math.min(l, 8) * 14;
}

// ═══ بناء الملف ═══

export interface RowsToPagedPdfInput {
  /** عنوان التقرير (يتكرر في كل صفحة) */
  title: string;
  /** أسطر الترويسة: الشركة، الفترة، الخيارات، تاريخ الطباعة… (تتكرر في كل صفحة) */
  meta?: readonly string[];
  columns: readonly PagedPdfColumn[];
  rows: readonly PagedPdfRow[];
  /** مترجم الواجهة (‏`useTr()`)؛ بغيابه تُطبع العربية كما هي */
  tr?: (ar: string) => string;
  /** مقياس الالتقاط؛ الافتراضي من `currentCaptureScale()` */
  scale?: number;
  /** ارتفاع منطقة الصفوف (اختبارياً أو لترويسة أطول) */
  bodyHeight?: number;
}

const FONT_STACK = 'Tahoma, "IBM Plex Sans Arabic", Arial, sans-serif';
const INK = '#1F1A13';
const MUTED = '#6E6557';
const CORAL = '#E15A30';

function columnStyles(columns: readonly PagedPdfColumn[]): string[] {
  const total = columns.reduce((s, c) => s + (c.width && c.width > 0 ? c.width : 1), 0) || 1;
  return columns.map((c) => {
    const pct = ((c.width && c.width > 0 ? c.width : 1) / total) * 100;
    const align = c.align === 'end' ? 'left' : c.align === 'center' ? 'center' : 'right';
    return `width:${pct.toFixed(4)}%;text-align:${align}`;
  });
}

function rowHtml(row: PagedPdfRow, styles: readonly string[], repeated: boolean): string {
  const weight = row.strong === true || row.head === true ? '700' : '400';
  const color = row.muted === true ? MUTED : INK;
  const bg = row.head === true ? '#FAF7F0' : repeated ? '#FFF6F2' : 'transparent';
  const pad = levelPaddingPx(row.level);
  const tds = styles.map((st, i) => {
    const raw = row.cells[i];
    const text = escapeHtml(raw);
    const indent = i === 0 && pad > 0 ? `padding-right:${8 + pad}px;` : '';
    return `<td style="${st};${indent}border-bottom:1px solid #EFE9DF;padding:4px 8px;font-size:11px;color:${color};font-weight:${weight};white-space:pre-wrap;word-break:break-word">${text}</td>`;
  });
  return `<tr style="background:${bg}">${tds.join('')}</tr>`;
}

function pageHtml(
  page: PagedPdfPage,
  input: RowsToPagedPdfInput,
  styles: readonly string[],
  tr: (ar: string) => string,
): string {
  const meta = (input.meta ?? [])
    .map((m) => `<div style="font-size:11px;color:${MUTED};line-height:${PDF_META_LINE_HEIGHT_PX}px">${escapeHtml(m)}</div>`)
    .join('');
  const header =
    `<div style="border-bottom:2px solid ${CORAL};padding-bottom:6px;margin-bottom:8px">` +
    `<h2 style="margin:0;font-size:17px;color:${INK}">${escapeHtml(input.title)}</h2>${meta}</div>`;
  const thead =
    `<tr>${input.columns
      .map((c, i) => `<th style="${styles[i]};background:#FAF7F0;border-bottom:1px solid #DCD3C4;padding:5px 8px;font-size:11px;font-weight:700;color:${INK}">${escapeHtml(c.label)}</th>`)
      .join('')}</tr>`;
  const carry = page.carry ? rowHtml(page.carry, styles, true) : '';
  const body = page.rows.length > 0
    ? page.rows.map((r) => rowHtml(r, styles, false)).join('')
    : `<tr><td colspan="${input.columns.length}" style="padding:16px;text-align:center;font-size:12px;color:${MUTED}">${escapeHtml(tr('لا توجد بيانات'))}</td></tr>`;
  const footer =
    `<div style="position:absolute;bottom:${PDF_PAGE_PADDING_PX}px;right:${PDF_PAGE_PADDING_PX}px;left:${PDF_PAGE_PADDING_PX}px;` +
    `border-top:1px solid #EFE9DF;padding-top:6px;font-size:10px;color:${MUTED};text-align:center">` +
    `${escapeHtml(pageFooterText(page.index, page.total, tr))}</div>`;
  return `${header}<table style="width:100%;border-collapse:collapse;table-layout:fixed">${thead}${carry}${body}</table>${footer}`;
}

/**
 * يبني PDF مُرقَّماً عند حدود الصفوف: كتلة DOM لكل صفحة بعرض 794px، تُلتقط وحدها ثم تُحرَّر.
 *
 * التحرير بين الكتل مقصود: `html2canvas` تترك لوحةً بحجم الصفحة × المقياس² في الذاكرة، فتقريرٌ
 * من مئة صفحة كان سيبقيها كلها حيّة. نُصفّر أبعاد اللوحة ونحذف العنصر بعد كل صفحة، ونعطي
 * المتصفّح نفَساً (‏`setTimeout(0)`) لأن الالتقاط يحجب الخيط.
 */
export async function rowsToPagedPdf(input: RowsToPagedPdfInput): Promise<Blob> {
  const tr = input.tr ?? ((s: string) => s);
  const metaCount = (input.meta ?? []).length;
  const built = paginateRows(input.rows, { bodyHeight: input.bodyHeight ?? pdfBodyHeight(metaCount) });
  const pages: PagedPdfPage[] = built.length > 0
    ? built
    : [{ index: 1, total: 1, carry: null, rows: [] }];

  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);

  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const scale = input.scale ?? currentCaptureScale();
  const styles = columnStyles(input.columns);

  for (let i = 0; i < pages.length; i++) {
    const el = document.createElement('div');
    el.style.cssText =
      `position:fixed;left:-99999px;top:0;width:${PDF_PAGE_WIDTH_PX}px;height:${PDF_PAGE_HEIGHT_PX}px;` +
      `box-sizing:border-box;padding:${PDF_PAGE_PADDING_PX}px;background:#fff;direction:rtl;` +
      `font-family:${FONT_STACK};overflow:hidden`;
    el.innerHTML = pageHtml(pages[i], input, styles, tr);
    document.body.appendChild(el);
    try {
      // نفَسٌ للمتصفّح: الالتقاط يحجب الخيط، فبلا هذا تبدو الصفحة «معلّقة» طوال التقرير
      await new Promise((r) => setTimeout(r, 0));
      const canvas = await html2canvas(el, { scale, useCORS: true, backgroundColor: '#ffffff', logging: false });
      if (!canvas.width || !canvas.height) throw new Error(tr('تعذّر إنشاء PDF — جرّب مدى أقصر أو صدّر XLSX'));
      const img = canvas.toDataURL('image/jpeg', 0.92);
      if (img.length < 2000) throw new Error(tr('تعذّر إنشاء PDF — جرّب مدى أقصر أو صدّر XLSX'));
      if (i > 0) pdf.addPage();
      pdf.addImage(img, 'JPEG', 0, 0, pageW, pageH);
      // تحرير اللوحة قبل الصفحة التالية — وإلا بقيت كل صفحات التقرير في الذاكرة
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      el.remove();
    }
  }
  return pdf.output('blob');
}
