/**
 * فوترة ZATCA المرحلة الثانية (Z5.1a) — الفئة الضريبية في بطاقة الصنف (لوحة الإدارة): الخيارات وأسماؤها والحمولة.
 * القسم لا يُرسم إلا حين zatcaCollectOn(company)، وحينها وحده تُرسل الحقول الثلاثة (غير الجامعة كما اليوم حرفياً).
 * القواعد نفسها يفحصها الخادم (compliance/zatca/productVat.ts) مرآةً لفحص الإصدار.
 */
import { VATEX_CATEGORY } from './validators';

export const PRODUCT_VAT_CATEGORY_LABELS_AR = Object.freeze({
  S: 'قياسية (15% أو 5%)',
  Z: 'صفرية',
  E: 'معفاة',
  O: 'خارج نطاق الضريبة',
} as const);

/** أسباب الإعفاء والصفرية المعتمدة (VATEX) بأسمائها العربية. */
export const VATEX_LABELS_AR: Readonly<Record<string, string>> = Object.freeze({
  'VATEX-SA-29': 'الخدمات المالية',
  'VATEX-SA-29-7': 'عقد تأمين على الحياة',
  'VATEX-SA-30': 'التوريدات العقارية المعفاة',
  'VATEX-SA-32': 'صادرات السلع',
  'VATEX-SA-33': 'صادرات الخدمات',
  'VATEX-SA-34-1': 'النقل الدولي للسلع',
  'VATEX-SA-34-2': 'النقل الدولي للركاب',
  'VATEX-SA-34-3': 'الخدمات المرتبطة بالنقل الدولي',
  'VATEX-SA-34-4': 'توريد وسائل النقل المؤهلة',
  'VATEX-SA-34-5': 'الخدمات المرتبطة بوسائل النقل المؤهلة',
  'VATEX-SA-35': 'الأدوية والمعدات الطبية المؤهلة',
  'VATEX-SA-36': 'المعادن الاستثمارية المؤهلة',
  'VATEX-SA-EDU': 'الخدمات التعليمية الخاصة للمواطنين',
  'VATEX-SA-HEA': 'الخدمات الصحية الخاصة للمواطنين',
  'VATEX-SA-MLTRY': 'توريد المعدات العسكرية المؤهلة',
  'VATEX-SA-OOS': 'خارج نطاق ضريبة القيمة المضافة',
});

/** رموز الإعفاء الصالحة لفئة (Z/E/O). */
export function vatexCodesFor(category: string | null | undefined): string[] {
  return Object.keys(VATEX_CATEGORY).filter(code => VATEX_CATEGORY[code] === category);
}

/** حمولة الحقول الثلاثة: فئة فارغة أو قياسية ⇒ بلا رمز ولا سبب (فلا يرفضها الخادم لبقايا فئة سابقة). */
export function productVatPayload(v: { vatCategory?: string | null; vatExemptionCode?: string | null; vatExemptionReason?: string | null }): {
  vatCategory: string | null; vatExemptionCode: string | null; vatExemptionReason: string | null;
} {
  const cat = (v.vatCategory ?? '').trim().toUpperCase() || null;
  if (cat === null || cat === 'S') return { vatCategory: cat, vatExemptionCode: null, vatExemptionReason: null };
  const code = (v.vatExemptionCode ?? '').trim();
  const reason = (v.vatExemptionReason ?? '').trim();
  return { vatCategory: cat, vatExemptionCode: code || null, vatExemptionReason: reason || null };
}
