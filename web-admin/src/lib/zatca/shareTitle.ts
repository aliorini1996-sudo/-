// ============================================================================
// عنوان المستند في رسالة «رابط المشتري» (واتساب) — كما تطبعه الشركة بـ«نصوص المطبوعات» (طلب المالك ٤ نوفمبر ٢٠٢٦).
// ----------------------------------------------------------------------------
// ملفٌّ منفصل عن shareView.ts عمداً: ذاك يُحمَّل مع صفحة المشتري العلنية وحدها، وهذا يسحب محلِّل النصوص (وقاموس الواجهة
// معه) — فلا يثقل حزمة الصفحة العلنية. يستدعيه حوار المشاركة في شاشات المدير وحده.
//
// القاعدة: عنوان قرار الطباعة للمرحلة الثانية (docPrint.phase2Title حرفاً) ثمّ صياغة الشركة له بالمفتاح نفسه الذي تطبعه
// القوالب: inv.title للفاتورة، وinv.returnTitle للإشعار الدائن، وinv.debitTitle للإشعار المدين. شركةٌ بلا نصوص ⇒ عنوان القرار.
// وعنوانٌ حذفته الشركة من الورقة ⇒ عنوان القرار أيضاً: الرسالة تحتاج اسماً للمستند ولو أُزيل من رأس الورقة.
// ============================================================================

import { makePrintTexts, normalizePrintTexts } from '../print/printTexts';
import { TAX_FREE_TITLES } from '../taxMode';

export interface ShareTitleFacts {
  /**
   * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): المستند مختومٌ بلا ضريبة (`Invoice.taxFree`) ⇒ عنوانه «فاتورة»/«فاتورة مرتجع»
   * (TAX_FREE_TITLES) بصياغة الشركة كما تطبعه القوالب — لا عنوان ضريبيّ. يسبق كل ما عداه، وغيابه = سلوك اليوم حرفاً.
   */
  taxFree?: boolean | null;
  /** نوع المستند عند الهيئة (ZatcaDocView.documentKind) — يغيب في الصفوف القديمة. */
  documentKind?: string | null;
  /** '01' قياسية / '02' مبسّطة (ZatcaDocView.subtype) — يغيب في بعض الصفوف. */
  subtype?: string | null;
  /** مرآة الهيئة — تحسم القياسية/المبسّطة حين يغيب subtype: الاعتماد للقياسية وحدها والإبلاغ للمبسّطة وحدها. */
  mirror?: string | null;
  /** مرتجعٌ (type === 'RETURN') بلا documentKind ⇒ إشعار دائن. */
  isReturn?: boolean;
}

const subtypeOf = (f: ShareTitleFacts): '01' | '02' | null => {
  if (f.subtype === '01' || f.subtype === '02') return f.subtype;
  if (f.mirror === 'cleared' || f.mirror === 'cleared_warn') return '01';
  if (f.mirror === 'reported' || f.mirror === 'reported_warn') return '02';
  return null;
};

/** عنوان قرار الطباعة للمرحلة الثانية (مطابقٌ لـ phase2Title في docPrint.ts) أو null إن لم يُعرف المستند. */
export function sharePhase2DecidedTitle(f: ShareTitleFacts): string | null {
  const kind = f.documentKind === 'CREDIT_NOTE' || f.documentKind === 'DEBIT_NOTE'
    ? f.documentKind
    : f.isReturn ? 'CREDIT_NOTE' : 'INVOICE';
  if (kind === 'CREDIT_NOTE') return 'إشعار دائن';
  if (kind === 'DEBIT_NOTE') return 'إشعار مدين';
  const st = subtypeOf(f);
  if (st === '02') return 'فاتورة ضريبية مبسطة';
  if (st === '01') return 'فاتورة ضريبية';
  return null;
}

/**
 * عنوان المستند لرسالة المشاركة: صياغة الشركة إن كانت، وإلا عنوان القرار؛ null ⇒ لا يُعرف المستند فتبقى الرسالة بعنوانها العامّ.
 * عربيّ دائماً (المستلم عميل الشركة) — فالمترجم هويّة، ولا لغة ثانية في سطر الرسالة.
 */
export function shareMessageTitle(f: ShareTitleFacts, rawPrintTexts: unknown): string | null {
  if (f.taxFree === true) {
    // المختوم بلا ضريبة: عنوان قرار الطباعة نفسه (docPrint.taxFreePrintDecision) بصياغة الشركة له — والمحذوف ⇒ العنوان نفسه
    const plain = f.isReturn ? TAX_FREE_TITLES.return : TAX_FREE_TITLES.sale;
    const pt = makePrintTexts(normalizePrintTexts(rawPrintTexts), (s) => s, { standard: false });
    return pt.title(plain, { isReturn: !!f.isReturn, phase2: false }).text.trim() || plain;
  }
  const decided = sharePhase2DecidedTitle(f);
  if (!decided) return null;
  const pt = makePrintTexts(normalizePrintTexts(rawPrintTexts), (s) => s, { standard: subtypeOf(f) === '01' });
  const isReturn = decided === 'إشعار دائن';
  const t = pt.title(decided, { isReturn, phase2: true }).text.trim();
  return t || decided;
}
