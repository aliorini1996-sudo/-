/**
 * «استديو العميل» (طلب المالك ١٣ نوفمبر ٢٠٢٦): أنواع وثائق العميل وحدودها — مرآة backend/src/services/customerDocs.ts
 * (اختبار التطابق في الخادم: customer-docs.test.ts يقرأ هذا الملف).
 */

export const CUSTOMER_DOC_KINDS = [
  { code: 'CR', label: 'السجل التجاري' },
  { code: 'VAT', label: 'الشهادة الضريبية' },
  { code: 'ID', label: 'الهوية' },
  { code: 'SHOP', label: 'صورة المحل' },
  { code: 'CONTRACT', label: 'عقد أو اتفاقية' },
  { code: 'OTHER', label: 'وثيقة أخرى' },
] as const;

export type CustomerDocKind = (typeof CUSTOMER_DOC_KINDS)[number]['code'];

/** أقصى عدد صور في الرفع الواحد (ومع إضافة العميل) */
export const CUSTOMER_DOC_MAX_PER_REQUEST = 6;
/** أقصى عدد وثائق للعميل */
export const CUSTOMER_DOC_MAX_PER_CUSTOMER = 60;

/** ضغط صورة الوثيقة: أوضح من صورة الزيارة (نصّ السجل والهوية) وتبقى تحت سقف الخادم بكثير */
export const DOC_COMPRESS = { maxDim: 1600, quality: 0.72 } as const;

/** «إزالة الضريبة»: لا ذكر للضريبة في أي شاشة — فلا نوع «الشهادة الضريبية» */
export const docKindsFor = (taxOff: boolean) => CUSTOMER_DOC_KINDS.filter((k) => !(taxOff && k.code === 'VAT'));

/** اسم النوع بالعربية (المفتاح لـtr) — نوعٌ مجهول يُعرض «وثيقة أخرى»، وكذا «الشهادة الضريبية» تحت «إزالة الضريبة» (لا ذكر للضريبة) */
export const docKindLabel = (code: string | null | undefined, taxOff = false): string =>
  (taxOff && code === 'VAT' ? undefined : CUSTOMER_DOC_KINDS.find((k) => k.code === code)?.label) ?? 'وثيقة أخرى';

export interface PickedDoc { kind: CustomerDocKind; data: string }

/** مفتاح دفعة وثائق العميل الجديد — مرآة docsBatchRef في الخادم: الإرسال المباشر وصفّ دون اتصال بالمفتاح نفسه فلا تكرار */
export const docsBatchRef = (customerClientRef: string) => `${customerClientRef}:docs`;

/** حمولة الإنشاء: لا مفتاح أصلاً حين لا صور — فيبقى جسم العميل كما كان حرفياً */
export const docsPayload = (docs: PickedDoc[]): { documents?: PickedDoc[] } =>
  (docs.length > 0 ? { documents: docs.map((d) => ({ kind: d.kind, data: d.data })) } : {});
