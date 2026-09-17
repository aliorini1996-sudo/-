// تصنيف «حالة الدفع» في ملفات الفواتير (مثل تصدير أودو): قيم كاملة بعد التطبيع، مع فحص المسودة والإلغاء والجزئي والنفي
// قبل «المدفوع» — فلا تُعدّ «غير مدفوعة» أو «Not Paid» أو «Partially Paid» مدفوعة، ولا تلتقط «مبلغ» إلغاءً.

export type PaymentStatusClass = 'paid' | 'unpaid' | 'partial' | 'cancelled' | 'draft' | 'unknown' | 'none';

/** تطبيع قيمة الحالة: أحرف صغيرة، توحيد عربي، [_-] وعلامات الترقيم («Paid.» و«Paid (Full)») مسافة، طي المسافات (المسافات تبقى) */
export function normStatus(raw: unknown): string {
  return String(raw ?? '').toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[_\-.,:;!?()[\]{}«»"'`/\\|؟،؛*]/g, ' ')
    .replace(/[\s\u00A0\u202F]+/g, ' ')
    .trim();
}

const set = (xs: string[]) => new Set(xs.map(normStatus));
const DRAFT = set(['draft', 'مسوده']);
const CANCELLED = set(['cancel', 'cancelled', 'canceled', 'void', 'voided', 'reversed', 'ملغي', 'ملغى', 'ملغاه', 'ملغيه', 'الغاء',
  'معكوس', 'معكوسه']);
const PARTIAL = set(['partial', 'partially paid', 'partly paid', 'paid partially', 'partial payment', 'partially settled',
  'جزئي', 'جزيي', 'مدفوع جزئيا', 'مدفوعه جزئيا', 'مسدد جزئيا', 'مسدده جزئيا', 'دفع جزئي', 'سداد جزئي']);
// النفي كلمةً كاملة فقط: «unknown» و«normal» و«none» ليست نفياً (البادئة غير المحدودة كانت تصنّفها غير مدفوعة)
const NEGATION_WORDS = set(['غير', 'لم', 'not', 'no', 'non', 'لا']);
const PAID = set(['paid', 'fully paid', 'paid in full', 'in payment', 'settled', 'fully settled',
  'مدفوع', 'مدفوعه', 'مسدد', 'مسدده', 'تم السداد', 'تم الدفع', 'خالص', 'خالصه',
  'مدفوع بالكامل', 'مدفوعه بالكامل', 'مسدد بالكامل', 'مسدده بالكامل', 'مدفوع كليا', 'مدفوعه كليا', 'مسدد كليا', 'مسدده كليا',
  // أودو العربي: in_payment «قيد الدفع»
  'قيد الدفع', 'قيد السداد', 'payment in progress', 'reconciled']);
// كلمات الاكتمال («تم السداد بالكامل»، «Paid (Full)»، «مدفوعة كاملة»): تُحذف ثم يُعاد فحص المدفوع — بعد النفي والجزئي
const COMPLETENESS = set(['بالكامل', 'كامل', 'كامله', 'كاملا', 'كليا', 'كلي', 'full', 'fully', 'complete', 'completely']);
const withoutCompleteness = (s: string): string =>
  s.replace(/(^| )in full( |$)/g, ' ').split(' ').filter((w) => w && !COMPLETENESS.has(w)).join(' ');
const UNPAID = set(['open', 'posted', 'due', 'overdue', 'unpaid', 'notpaid', 'nonpaid', 'not paid',
  'مفتوح', 'مستحق', 'متاخر', 'مرحل', 'مرحله']);

export function classifyPaymentStatus(raw: unknown): PaymentStatusClass {
  const s = normStatus(raw);
  if (!s) return 'none';
  if (DRAFT.has(s)) return 'draft';
  if (CANCELLED.has(s)) return 'cancelled';
  if (PARTIAL.has(s)) return 'partial';
  if (UNPAID.has(s)) return 'unpaid';
  if (s.split(' ').some((w) => NEGATION_WORDS.has(w))) return 'unpaid';
  if (PAID.has(s)) return 'paid';
  const base = withoutCompleteness(s);
  if (base && base !== s && PAID.has(base)) return 'paid';
  return 'unknown';
}
