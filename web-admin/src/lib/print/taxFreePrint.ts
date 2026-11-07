/**
 * «إزالة الضريبة» في المطبوعات (طلب المالك ٧ نوفمبر ٢٠٢٦: «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام ولا في اي مستند»)
 * — أدواتٌ نقيّة تشترك فيها القوالب (الشريط الحراري والقالب ثنائي اللغة والمعايرة والمعاينات): بلا React ولا قاموس.
 *
 * · الفاتورة يحكمها ختمها (Invoice.taxFree ⇒ قرار الطباعة: hideTaxIds وshowTaxBreakdown:false وqr.source:'none')، والسند
 *   وصفحة المعايرة والطباعة التجريبية يحكمها علم الشركة الآن (CompanySettings.taxDisabled) — القواعد في lib/taxMode.ts.
 * · بلا ختمٍ ولا علم: كل دالّةٍ هنا تعيد ما أخذته كما هو، فالورقة حرفاً بحرف كما اليوم (الحرّاس الذهبية).
 */
import { isDocTaxFree, type TaxModeDoc } from '../taxMode';
import { PRINT_SAMPLE_WATERMARK } from './printSettings';

/** شريط «نموذج اختبار» لشركةٍ أزالت الضريبة — بلا «ليس مستندا ضريبيا» (لا ذكر للضريبة ولو نفياً) */
export const TAX_FREE_SAMPLE_WATERMARK = 'نموذج اختبار';

/** نصّ شريط الطباعة التجريبية والمعاينة: كاليوم حرفاً، أو «نموذج اختبار» وحده لشركةٍ أزالت الضريبة */
export function sampleWatermarkFor(taxOff: boolean): string {
  return taxOff ? TAX_FREE_SAMPLE_WATERMARK : PRINT_SAMPLE_WATERMARK;
}

/**
 * ما يقرؤه القالب من قرار الطباعة (lib/zatca/docPrint.ts) — `hideTaxIds` يضيفه «إزالة الضريبة» ويُقرأ صريحاً (true وحده)، فقرارٌ
 * بلا الحقل (حزمةٌ أقدم أو المرحلة الأولى والثانية) لا يُخفي شيئاً.
 */
export interface TaxFreeDecisionView {
  showTaxBreakdown: boolean;
  hideTaxIds?: boolean;
}

/** ورقة فاتورةٍ بلا أيّ ذكرٍ للضريبة؟ قرار الطباعة (hideTaxIds) أو ختم المستند نفسه (taxFree) — أيّهما، دفاعاً */
export function isTaxFreePrint(d: TaxFreeDecisionView | null | undefined, doc: TaxModeDoc | null | undefined): boolean {
  return d?.hideTaxIds === true || isDocTaxFree(doc);
}

interface TaxIdsDoc {
  company?: { taxNumber?: string | null } | null;
  customer: { taxNumber?: string | null };
}

/**
 * المستند كما يُطبع بلا ضريبة: بلا الرقم الضريبي للبائع (الترويسة ورأس الشريط وصندوق البائع) وللمشتري (صفّه في الفاتورة والسند)
 * — نسخةٌ جديدة، والمستند الأصليّ وبيانات الشركة المحفوظة كما هي (تعود بعودة الضريبة). يستدعيه القالب خلف ختم الفاتورة أو علم الشركة.
 */
export function withoutTaxIds<T extends TaxIdsDoc>(doc: T): T {
  return {
    ...doc,
    company: doc.company ? { ...doc.company, taxNumber: undefined } : doc.company,
    customer: { ...doc.customer, taxNumber: undefined },
  } as T;
}

/**
 * عبارات الضريبة التي لا تظهر في أيّ ورقةٍ أو شاشةٍ بلا ضريبة — للاختبارات وحرّاس المصدر (lib/print وrep). الأرقام الضريبية نفسها
 * تُفحص بقيمتها في كل اختبار (لا نمط عامّ لها)، وخانة الرمز وصورته في اختبار كل قالب (لا يُذكر اسم الخانة هنا: حارس printGuards
 * يحصر الملفات التي تذكرها).
 */
export const TAX_FREE_FORBIDDEN: readonly RegExp[] = Object.freeze([
  /ضريب/, /ض\.ق\.م/, /\bVAT\b/i, /\btax\b/i, /\bTVA\b/, /\bKDV\b/, /Vergi/i, /fiscal/i, /税/, /الهيئة/, /إشعار دائن/, /إشعار مدين/,
  /مبسطة/, /ZATCA/i, /Credit Note/i, /Debit Note/i,
]);

/** أوّل عبارةٍ ضريبية في النصّ أو null — `allow` نصوصٌ تُستثنى (مفتاح الإعدادات نفسه) */
export function firstTaxMention(text: string, allow: readonly string[] = []): string | null {
  let t = text;
  for (const a of allow) t = t.split(a).join('');
  for (const re of TAX_FREE_FORBIDDEN) {
    const m = re.exec(t);
    if (m) return `${re.source}: …${t.slice(Math.max(0, m.index - 40), m.index + 40)}…`;
  }
  return null;
}
