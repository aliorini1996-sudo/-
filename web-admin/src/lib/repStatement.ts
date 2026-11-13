/**
 * «كشف أداء وعمل المندوب» (نافذة المناديب على الويب) — حساباته الصافية بلا React.
 *
 * ثلاثة أخطاء كشفتها مراجعة دقّة التقارير (١٣ نوفمبر ٢٠٢٦)، وكلّها في الأرقام لا في الشكل:
 *  ١) تذييل «الإجمالي» كان يجمع كل مستندات الكشف موجبةً — والمرتجع يُخزَّن بإجماليٍّ موجب — فمندوبٌ باع
 *     ١٠٬٠٠٠ وأرجع ١٬٠٠٠ يقرأ «١١٬٠٠٠»: لا هو إجمالي البيع ولا صافيه. والبطاقة «إجمالي المبيعات» كانت
 *     قبل المرتجع بينما كل «مبيعات» في المنصّة صافيةٌ منه (backend/src/services/netSales.ts).
 *  ٢) الكشف كان يطلب ٥٠٠٠ مستند ويتجاهل pagination.total، فمندوبٌ قديم على «كل الفترات» تسقط أقدم
 *     مستنداته من كل الأرقام بلا تنبيه.
 *  ٣) طرفٌ واحد من المدّة كان يُكتب «كل الفترات» على الشاشة والورقة والملف.
 */

/** المرتجع مستندٌ في قائمة الكشف نفسها — يُعرف بنوعه لا بإشارة إجماليّه (إجماليّه موجبٌ دائماً) */
export function isReturnDoc(d: { type: string }): boolean {
  return d.type === 'RETURN';
}

export interface StatementTotals {
  salesCount: number;
  returnsCount: number;
  /** مستندات البيع (نقدي وآجل) قبل المرتجع */
  salesTotal: number;
  /** المرتجعات مبلغاً موجباً — يُعرض بعنوان «المرتجعات» لا مضافاً إلى البيع */
  returnsTotal: number;
  /** صافي المبيعات = البيع − المرتجع، تعريف netSales.ts نفسه */
  netSales: number;
}

// الجمع بالأجزاء من الألف (يكفي ثلاث خانات عشرية كالدينار) ثم القسمة مرّةً واحدة:
// جمع آلاف الكسور العشرية عائماً يترك ذيلاً كـ٠٫٣٠٠٠٠٠٠٠٠٤ يظهر في Excel
const milli = (v: unknown) => Math.round((Number(v) || 0) * 1000);

export function statementTotals(docs: ReadonlyArray<{ type: string; total: number | string }>): StatementTotals {
  let salesCount = 0, returnsCount = 0, salesM = 0, returnsM = 0;
  for (const d of docs) {
    if (isReturnDoc(d)) { returnsCount++; returnsM += milli(d.total); }
    else { salesCount++; salesM += milli(d.total); }
  }
  return {
    salesCount,
    returnsCount,
    salesTotal: salesM / 1000,
    returnsTotal: returnsM / 1000,
    netSales: (salesM - returnsM) / 1000,
  };
}

/**
 * عنوان مدّة الكشف كما فلترها الخادم فعلاً: الخادم يقبل «من» وحدها أو «إلى» وحدها، فالعنوان يقول ذلك
 * ولا يدّعي «كل الفترات» لمدّةٍ مُصفّاة. الصيغ نفسها في كشف حساب العميل المطبوع (rep/RepDocuments.tsx).
 * و«حتى» عبارةُ قالبٍ بتاريخها ('حتى {date}') لا كلمة 'حتى' المفردة: ترجمتها التركية «Son güncelleme:» (آخر تحديث) لسياقٍ آخر.
 * `day` منسّق يومٍ خالص (formatDayOnly) حتى لا يُزاح اليوم بمنطقة المتصفّح.
 */
export function statementPeriodLabel(
  from: string | null | undefined,
  to: string | null | undefined,
  tr: (ar: string) => string,
  day: (d: string) => string,
): string {
  const f = (from || '').trim();
  const t = (to || '').trim();
  if (f && t) return `${day(f)} — ${day(t)}`;
  if (f) return `${tr('من')} ${day(f)}`;
  if (t) return tr('حتى {date}').replace('{date}', day(t));
  return tr('كل الفترات');
}

/* ═══ جلب كل الصفحات ═══ */

/** حجم الصفحة: سقف الطلب الواحد القديم نفسه، فلا يزيد حمل الطلب الواحد على القاعدة */
export const STATEMENT_PAGE_SIZE = 5000;
/** سقف الأمان: ما فوقه يُعرض أحدثه وحده مع تنبيهٍ كهرماني — لا يُسقط شيءٌ بصمت */
export const STATEMENT_CEILING = 50000;

export interface PageResult<T> { rows: T[]; total?: number | null }

export interface AllPages<T> {
  /** الأحدث أولاً (ترتيب الخادم createdAt تنازلياً) — فالقطع عند السقف يُبقي الأحدث */
  rows: T[];
  /** عدد ما يطابق الفلتر في الخادم */
  total: number;
  /** بلغ السقفَ وبقي في الخادم ما لم يُجلب */
  truncated: boolean;
}

/** صفحةٌ من ردّ قائمة الخادم `{ data, pagination: { total } }` */
export function pageOf<T>(body: { data?: T[] | null; pagination?: { total?: number | null } | null } | null | undefined): PageResult<T> {
  return { rows: body?.data ?? [], total: body?.pagination?.total ?? null };
}

/**
 * يجلب صفحات القائمة بالتتابع حتى يبلغ pagination.total أو السقف.
 *
 * - بالتتابع لا بالتوازي: القاعدة صغيرة (٠٫١ نواة)، وكل صفحةٍ ٥٠٠٠ فاتورة ببنودها.
 * - الإجمالي يُقرأ من كل صفحة: مستندٌ جديد أثناء الجلب يزيده فتُطلب الصفحة الزائدة.
 * - التكرار بالمعرّف يُسقط: الترقيم بالإزاحة، فمستندٌ جديد في الأعلى يدفع آخر الصفحة إلى أوّل التالية.
 * - صفحةٌ أقصر من حجمها نهايةٌ أكيدة — حمايةٌ من حلقةٍ لا تنتهي لو اختلف الإجمالي عن الصفوف.
 * - خادمٌ لا يعيد pagination: الصفوف المستلمة هي الإجمالي.
 */
export async function fetchAllPages<T extends { id: string }>(
  fetchPage: (page: number, limit: number) => Promise<PageResult<T>>,
  opts: { pageSize?: number; ceiling?: number } = {},
): Promise<AllPages<T>> {
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? STATEMENT_PAGE_SIZE));
  const ceiling = Math.max(1, Math.floor(opts.ceiling ?? STATEMENT_CEILING));
  const maxPages = Math.ceil(ceiling / pageSize);
  const seen = new Set<string>();
  const rows: T[] = [];
  let total = 0;
  let capped = false;
  for (let page = 1; ; page++) {
    const res = await fetchPage(page, pageSize);
    const got = res.rows ?? [];
    for (const r of got) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
    const t = Number(res.total);
    total = res.total != null && Number.isFinite(t) && t >= 0 ? t : rows.length;
    if (got.length < pageSize) break;          // آخر صفحة
    if (page * pageSize >= total) break;       // بلغنا ما في الخادم
    if (rows.length >= ceiling || page >= maxPages) { capped = true; break; }
  }
  const kept = rows.length > ceiling ? rows.slice(0, ceiling) : rows;
  if (rows.length > ceiling) capped = true;
  total = Math.max(total, rows.length);
  return { rows: kept, total, truncated: capped && total > kept.length };
}

/** نصّ التنبيه الكهرماني: «عُرض أحدث N فاتورة فقط من أصل M» */
export function truncationNote(
  kind: 'invoices' | 'receipts',
  cut: { shown: number; total: number },
  tr: (ar: string) => string,
  fmt: (n: number) => string,
): string {
  const noun = kind === 'invoices' ? tr('فاتورة فقط من أصل') : tr('سند قبض فقط من أصل');
  return `${tr('عُرض أحدث')} ${fmt(cut.shown)} ${noun} ${fmt(cut.total)}`;
}
