/**
 * تقرير «العملاء الذين لم تتم زيارتهم» (طلب المالك ٩ نوفمبر ٢٠٢٦):
 * «فلتر في صفحات تقارير العملاء… يوضّح العملاء الذين لم يتم زيارتهم، وبداخله فلتر للمدة من تاريخ إلى تاريخ».
 *
 * التعريف: عميلٌ نشط (ACTIVE) يراه المستخدم (قوائمه إن كان منطاقاً)، كان موجوداً في النظام قبل نهاية الفترة،
 * وليس له أي زيارة (RepVisit) في الفترة — من أي مندوب. هو مكمّل تقرير «زيارات العملاء» بالتعريف نفسه للزيارة
 * والتاريخ (اليوم من منتصف ليله، ويوم «إلى» كاملاً). وبلا تواريخ ⇒ عملاء لم يُزاروا قط.
 *
 * لماذا زيارات الشركة كلها لا زيارات نطاق المستخدم: السؤال عن العميل «هل زاره أحد؟» — عميلٌ في قائمة المشرف زاره
 * مندوبٌ خارجها قد زِير فعلاً، وعرضه «لم يُزر» يدفع المشرف لإرسال مندوبٍ إليه بلا حاجة.
 * ولا ينقسم بالفريق (كأرصدة العملاء): العملاء مشتركون بين الفرق.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UnvisitedRange { fromDate: Date; toEnd: Date; hasFrom: boolean }

/**
 * الفترة بتعريف تقرير «زيارات العملاء» نفسه (routes/reports.ts /customer-visits): من منتصف ليل «من»، إلى ما قبل
 * منتصف ليل اليوم التالي لـ«إلى». بلا «من» ⇒ منذ البداية، وبلا «إلى» ⇒ حتى الآن.
 * تاريخٌ فاسد أو «من» بعد «إلى» ⇒ رسالة خطأ بدل استعلامٍ ينفجر أو تقريرٍ فارغٍ يوحي بأن كل العملاء زِيروا.
 */
export function unvisitedRange(from: unknown, to: unknown, now: Date = new Date()): UnvisitedRange | { error: string } {
  if ((from != null && typeof from !== 'string') || (to != null && typeof to !== 'string')) return { error: 'تاريخ غير صالح' };
  const f = typeof from === 'string' ? from.trim() : '';
  const t = typeof to === 'string' ? to.trim() : '';
  const bad = (s: string) => s !== '' && (!DATE_RE.test(s) || Number.isNaN(new Date(s).getTime()));
  if (bad(f) || bad(t)) return { error: 'تاريخ غير صالح' };
  const fromDate = f ? new Date(f) : new Date(0);
  // بلا «إلى»: حتى الآن — ولا تنقلب النافذة إن كان «من» اليومَ بتوقيت الشركة وما زال أمسِ بتوقيت UTC (فجر الرياض)،
  // أو في المستقبل: يومُ «من» كاملٌ على الأقل، كما لو اختير «إلى» مساوياً له
  const toEnd = t ? new Date(new Date(t).getTime() + DAY_MS) : new Date(Math.max(now.getTime(), fromDate.getTime() + DAY_MS));
  if (f && t && fromDate.getTime() >= toEnd.getTime()) return { error: 'تاريخ البداية بعد تاريخ النهاية' };
  return { fromDate, toEnd, hasFrom: f !== '' };
}

export interface UnvisitedCustomerIn {
  id: string; name: string; businessName: string | null; phone: string; city: string | null; createdAt: Date;
  assignments: { salesRep: { name: string } | null }[];
}

export interface UnvisitedRow {
  id: string; name: string; businessName: string | null; phone: string; city: string | null;
  /** المناديب المُسنَدون للعميل (من أضافه أو أسندته الإدارة) — فارغ لعميلٍ بلا إسناد */
  reps: string[];
  /** آخر زيارة قبل بداية الفترة — null: لم يُزر قط قبلها */
  lastVisitAt: Date | null;
  createdAt: Date;
  /**
   * فواتير البيع في الفترة بلا زيارة (طلب المالك ١٣ نوفمبر ٢٠٢٦ — services/unvisitedInvoicesDb.ts): عددها وتاريخ آخرها.
   * 0/null: لم تُزر ولم يُصدر لها شيء — والفرق بين الحالين هو علامة التقرير
   */
  invoicesCount: number;
  lastInvoiceAt: Date | null;
}

/**
 * يستبعد من زِير في الفترة، ويرتّب: من لم يُزر قط أولاً، ثم الأقدم زيارةً (الأحوج لزيارة)، ثم بالاسم.
 */
export function buildUnvisitedRows(
  customers: UnvisitedCustomerIn[],
  visitedIds: Iterable<string>,
  lastVisitBefore: Map<string, Date>,
  invoiceStats: Map<string, { count: number; lastAt: Date | null }> = new Map(),
): UnvisitedRow[] {
  const visited = new Set(visitedIds);
  const rows: UnvisitedRow[] = [];
  for (const c of customers) {
    if (visited.has(c.id)) continue;
    const reps = [...new Set(c.assignments.map(a => a.salesRep?.name?.trim() || '').filter(Boolean))];
    const inv = invoiceStats.get(c.id);
    rows.push({
      id: c.id, name: c.name, businessName: c.businessName, phone: c.phone, city: c.city,
      reps, lastVisitAt: lastVisitBefore.get(c.id) ?? null, createdAt: c.createdAt,
      invoicesCount: inv?.count ?? 0, lastInvoiceAt: inv?.lastAt ?? null,
    });
  }
  rows.sort((a, b) => {
    if (!a.lastVisitAt !== !b.lastVisitAt) return a.lastVisitAt ? 1 : -1;
    if (a.lastVisitAt && b.lastVisitAt && a.lastVisitAt.getTime() !== b.lastVisitAt.getTime()) {
      return a.lastVisitAt.getTime() - b.lastVisitAt.getTime();
    }
    return a.name.localeCompare(b.name, 'ar');
  });
  return rows;
}
