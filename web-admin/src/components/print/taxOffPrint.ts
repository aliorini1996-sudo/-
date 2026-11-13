/**
 * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — شاشات الطباعة في إعدادات الشركة لشركةٍ بلا ضريبة (CompanySettings.taxDisabled):
 * «نصوص المطبوعات» و«إعدادات الطباعة» ومعايناتهما والطباعة التجريبية بلا أي ذكرٍ للضريبة — لا عبارة ضريبية، ولا تنبيه هيئة، ولا رقم
 * ضريبي، ولا رمز QR، ولا «فاتورة ضريبية/مبسطة/إشعار دائن».
 *
 * كل دالّة هنا تُستدعى خلف taxOff صريح (isTaxOff في lib/taxMode.ts، أو سياق TaxOffPrintContext وافتراضه false) — فالشركة بضريبتها
 * (الغائب أو false) ترى كل شيءٍ كما كان حرفاً. وما يخصّ القوالب نفسها (مفاتيح عبارات الضريبة، وعنوانا المستند، وشريط «نموذج اختبار»)
 * من lib/print (printTextsCore وtaxFreePrint) — مصدرٌ واحد. بلا JSX: تُختبر في node (pages/taxOffScreens1.test.ts).
 */
import { createContext, useContext } from 'react';
import { PRINT_NOTES, PRINT_WARNINGS, type TemplateId } from '../../lib/print/printSettings';
import { TAX_FREE_TITLE_TEXTS, isTaxPhraseKey, taxFreeDefaultOf, type PrintTextEntry, type PrintTextWarning } from '../../lib/print/printTexts';
import { TAX_FREE_SAMPLE_WATERMARK, sampleWatermarkFor } from '../../lib/print/taxFreePrint';
import type { Company, DocCustomer, InvoiceDoc, ReceiptDoc } from '../../rep/RepDocuments';

/** الشركة بلا ضريبة؟ — تبويب «إعدادات الطباعة» يوفّره (PrintSettingsPanel)، وافتراضه false: كل مكوّنٍ خارجه كما كان */
export const TaxOffPrintContext = createContext(false);

export function useTaxOffPrint(): boolean {
  return useContext(TaxOffPrintContext);
}

// ─── العلامة المائية للمعاينة والطباعة التجريبية ───

/** «نموذج اختبار» وحده — بلا «ليس مستندا ضريبيا» (lib/print/taxFreePrint.ts) */
export const TAX_OFF_SAMPLE_WATERMARK = TAX_FREE_SAMPLE_WATERMARK;
/** بديل «المعاينة والاختبار يحملان «نموذج اختبار — ليس مستندا ضريبيا» ورمزا تجريبيا» — بلا رمز (لا QR بلا ضريبة) */
export const TAX_OFF_DEVICE_SAMPLE_NOTE = 'المعاينة والاختبار يحملان «نموذج اختبار»';

/** نصّ العلامة المائية (عربي يُمرَّر إلى tr): «نموذج اختبار» للشركة بلا ضريبة، وإلا PRINT_SAMPLE_WATERMARK كما هو */
export const sampleWatermark = sampleWatermarkFor;

// ─── «نصوص المطبوعات» ───

/**
 * صفّ المفتاح ظاهرٌ في المحرّر؟ — كل صفٍّ للشركة بضريبتها؛ ولغيرها بلا عبارات الضريبة (TAX_PHRASE_KEYS: سطورٌ لا يطبعها مستندٌ بلا
 * ضريبة) — وما صاغته الشركة منها يبقى محفوظاً كما هو فيعود بعودة الضريبة
 */
export function printTextRowVisible(key: string, taxOff: boolean): boolean {
  return !taxOff || !isTaxPhraseKey(key);
}

/**
 * النصّ الافتراضي لصفّ المحرّر (تسميته وما يظهر في خانته فارغةً): «فاتورة» و«فاتورة مرتجع» بلا ضريبة، و«إجمالي المرتجع» لسطر
 * إجمالي المرتجع (E3 — ما يطبعه المستند بلا ضريبة: taxFreeDefaultOf)، وإلا نصّ القائمة كما هو
 */
export function printTextDefault(entry: Pick<PrintTextEntry, 'key' | 'ar'>, taxOff: boolean): string {
  return (taxOff && (TAX_FREE_TITLE_TEXTS[entry.key] || taxFreeDefaultOf(entry.key))) || entry.ar;
}

/**
 * تنبيه صفّ المحرّر (lineWarning — ومعه ما يرثه عنوان الصندوق من صفوفه): بلا ضريبة لا تنبيه هيئةٍ ولا إلزام فاتورةٍ ضريبية ولا
 * عنوان حالة — يبقى سطر المنصّة وحده
 */
export function editorWarningFor(w: PrintTextWarning | null, taxOff: boolean): PrintTextWarning | null {
  if (!taxOff) return w;
  return w === 'platform' ? w : null;
}

// ─── «إعدادات الطباعة» ───

/** تنبيهات القالب وملاحظاته التي تخصّ رمز الهيئة أو الفاتورة الضريبية — لا معنى لها بلا ضريبة */
const TAX_OFF_DROPPED_NOTES: ReadonlySet<string> = new Set<string>([
  PRINT_WARNINGS.qrNoFit, PRINT_WARNINGS.phase2Narrow, PRINT_WARNINGS.qrRemoved, PRINT_WARNINGS.itemsRemoved, PRINT_WARNINGS.stampsRemoved,
  PRINT_NOTES.impactTopPly,
]);

/** profileWarnings بلا تنبيهات الرمز والفاتورة الضريبية لشركةٍ بلا ضريبة — والنتيجة نفسها حرفاً لغيرها */
export function taxOffProfileWarnings<T extends { warnings: string[]; notes: string[] }>(r: T, taxOff: boolean): T {
  if (!taxOff) return r;
  return { ...r, warnings: r.warnings.filter((w) => !TAX_OFF_DROPPED_NOTES.has(w)), notes: r.notes.filter((n) => !TAX_OFF_DROPPED_NOTES.has(n)) };
}

/**
 * وصف القوالب بلا «ملخص الضريبة» ولا «رقمه الضريبي» ولا «رمز QR». وimpact_preprinted بلا بديل: وصفه الجديد «على ورق بترويسة مطبوعة»
 * (قرار المالك ١٣ نوفمبر ٢٠٢٦، س٣) لا يذكر الضريبة أصلاً — فيُعرض كما هو للشركة بلا ضريبة
 */
export const TAX_OFF_TEMPLATE_HINTS: Readonly<Partial<Record<TemplateId, string>>> = Object.freeze({
  roll_detailed: 'جدول كمية وسعر وإجمالي — من 72 مم',
  impact_plain: 'بلا تظليل بخطوط سوداء وخط عريض',
});

/** وصف القالب (عربي يُمرَّر إلى tr): بديل الشركة بلا ضريبة إن وُجد، وإلا الوصف كما هو */
export function templateHintFor(t: TemplateId | null, hint: string, taxOff: boolean): string {
  return (taxOff && t && TAX_OFF_TEMPLATE_HINTS[t]) || hint;
}

// ─── المستندات النموذجية (محرّر النصوص والمعاينة) ───

const r2 = (n: number): number => Math.round(n * 100) / 100;

function withoutSellerTaxNumber(company: Company | null | undefined): Company | null | undefined {
  if (!company) return company;
  const { taxNumber: _drop, ...rest } = company;
  void _drop;
  return rest;
}

function withoutBuyerTaxNumber(customer: DocCustomer): DocCustomer {
  const { taxNumber: _drop, ...rest } = customer;
  void _drop;
  return rest;
}

/**
 * المستند النموذجي كما يصدر لشركةٍ بلا ضريبة: مختومٌ taxFree، والسعر المكتوب نهائي (البند بسعره وإجماليه كما هو والنسبة صفر)،
 * والمجموع مجموع البنود والإجمالي بعد الخصم، ولا رقم ضريبي للطرفين، ولا قرار هيئة (zatca) ولا مزوّد فوترة إلكترونية.
 * المدفوع والمتبقي والأقساط تُقاس على الإجمالي الجديد.
 */
export function taxFreeInvoiceDoc(doc: InvoiceDoc): InvoiceDoc {
  const items = doc.items.map((it) => ({ ...it, taxPct: 0, ...(it.taxAmt !== undefined ? { taxAmt: 0 } : {}) }));
  const subtotal = r2(items.reduce((s, it) => s + it.lineTotal, 0));
  const discount = r2(Math.min(subtotal, doc.discount));
  const total = r2(subtotal - discount);
  const ratio = doc.total > 0 ? total / doc.total : 1;
  const paid = doc.paidAmt !== undefined ? Math.min(total, doc.paidAmt) : undefined;
  const { zatca: _zatca, einvoice: _einvoice, ...rest } = doc;
  void _zatca; void _einvoice;
  return {
    ...rest,
    taxFree: true,
    pricesIncludeTax: false,
    company: withoutSellerTaxNumber(doc.company),
    customer: withoutBuyerTaxNumber(doc.customer),
    items,
    subtotal,
    discount,
    tax: 0,
    total,
    ...(paid !== undefined ? { paidAmt: paid } : {}),
    ...(doc.remainingAmt !== undefined ? { remainingAmt: r2(total - (paid ?? 0)) } : {}),
    ...(doc.installments ? { installments: doc.installments.map((x) => ({ ...x, amount: r2(x.amount * ratio) })) } : {}),
  };
}

/** السند النموذجي لشركةٍ بلا ضريبة: بلا رقمٍ ضريبي للطرفين */
export function taxFreeReceiptDoc(doc: ReceiptDoc): ReceiptDoc {
  return { ...doc, company: withoutSellerTaxNumber(doc.company), customer: withoutBuyerTaxNumber(doc.customer) };
}
