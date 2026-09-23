// بيانات اختبار Z5.2 — مصطنعة بالكامل (تمتدّ z1-sources.ts؛ الرقم الضريبي 399999999900003 رقم الهيئة التجريبي العامّ، و311111111111113
// صيغة صحيحة لا تخصّ منشأة حقيقية). لا تمثّل أي شركة أو عميل حقيقي، ولا تُقرأ من قاعدة بيانات.
//   • بائع كامل بإعدادات SAR والمزوّد zatca.
//   • عملاء B2B/B2C: مكتمل، ناقص، سجل تجاري فقط، أرقام عربية-هندية، حكومي، فرد، فرد برقم ضريبي، غير مصنّف (قناة/اسم منشأة/معرّف).
//   • أصناف بفئات S (15% و5%) وZ وE وO، وصنف بنسبة 0% بلا فئة.
//   • طلبات: المبسّطة والقياسية المطابقتان لعيّنتي Z1، وشاملة الضريبة ببقية 0 و0.01 (G = 25.80 و25.95) و0.02 (نسبتان).
import { computeInvoiceTotals } from '../../../lib/invoiceCalc';
import type { EngineTotals, IssuanceCustomer, IssuanceProduct, IssuanceRequest } from '../issue';
import type { SellerSettingsRecord } from '../onboardingStore';
import { BUSINESS_BUYER, SELLER, WALK_IN_BUYER } from './z1-sources';

export const Z5_TENANT = 'tenant-z5';
export const Z5_UNIT = 'unit-z5-prod';
export const Z5_VAT = SELLER.taxNumber as string;
export const COMPANY_VAT = 15;
export const Z5_LIVE_AT = new Date('2026-11-20T06:00:00.000Z');
/** 2026-09-14 10:15:30 بتوقيت الرياض — لحظة عيّنات Z1. */
export const Z1_ISSUED_AT = new Date('2026-09-14T07:15:30.250Z');

export function sellerSettings(over: Partial<SellerSettingsRecord> = {}): SellerSettingsRecord {
  return {
    tenantId: Z5_TENANT, legalName: SELLER.legalName as string, taxNumber: Z5_VAT, commercialReg: SELLER.commercialReg as string,
    sellerIdScheme: null, sellerIdValue: null, addrStreet: SELLER.addrStreet as string, addrBuildingNo: SELLER.addrBuildingNo as string,
    addrAdditionalNo: SELLER.addrAdditionalNo as string, addrDistrict: SELLER.addrDistrict as string, addrCity: SELLER.addrCity as string,
    addrPostalCode: SELLER.addrPostalCode as string, vatGroupTin: null, countryCode: 'SA', currency: 'SAR', currencyOverride: null,
    einvoiceProvider: 'zatca', zatcaPhase2StartedAt: Z5_LIVE_AT, ...over,
  };
}

const b2b = BUSINESS_BUYER;

export const CUSTOMERS = Object.freeze({
  /** منشأة مكتملة (عيّنة Z1 القياسية). */
  b2bComplete: { id: 'c-b2b', channel: 'MT', ...b2b } as IssuanceCustomer,
  /** منشأة غير مصنّفة صراحةً بأرقام عربية-هندية في كل الحقول الرقمية — تُطبَّع عند القراءة فتكتمل. */
  b2bArabicDigits: {
    id: 'c-b2b-ar', name: 'أبو فهد', businessName: 'مؤسسة الأرقام الهندية', taxNumber: '٣١١١١١١١١١١١١١٣', commercialReg: '٢٠٥٠٠١٢٣٤٥',
    buyerType: null, addrStreet: 'شارع الأمير محمد', addrBuildingNo: '٧٧٨٨', addrAdditionalNo: '١٢٣٤', addrPostalCode: '٣١٩٥٢',
    district: 'الشاطئ', city: 'الدمام', countryCode: null,
  } as IssuanceCustomer,
  /** منشأة صريحة برقم ضريبي وعنوان ناقص (لا شارع ولا مبنى ولا حي ولا رمز). */
  b2bIncomplete: {
    id: 'c-b2b-inc', name: 'سوبرماركت', businessName: 'أسواق الحي', taxNumber: '311111111111113', buyerType: 'BUSINESS', city: 'الرياض',
  } as IssuanceCustomer,
  /** سجل تجاري فقط بلا عنوان ⇒ 01 ناقصة. */
  crOnlyIncomplete: { id: 'c-cr', name: 'محل الوفاء', commercialReg: '1010101010' } as IssuanceCustomer,
  /** جهة حكومية بمعرّف SAG وعنوان كامل بلا رقم ضريبي ⇒ 01 مكتملة. */
  government: {
    id: 'c-gov', name: 'مدرسة الأمل الحكومية', buyerType: 'GOVERNMENT', buyerIdScheme: 'SAG', buyerIdValue: '5000000001', addrStreet: 'طريق الملك عبدالله',
    addrBuildingNo: '4455', addrPostalCode: '12345', district: 'الملقا', city: 'الرياض', countryCode: 'SA',
  } as IssuanceCustomer,
  /** فرد (عيّنة Z1 المبسّطة). */
  individual: { id: 'c-walkin', ...WALK_IN_BUYER } as IssuanceCustomer,
  /** فرد صريح برقم ضريبي ⇒ مبسّطة (الصريح يغلب). */
  individualWithVat: { id: 'c-ind-vat', name: 'سالم', buyerType: 'INDIVIDUAL', taxNumber: '311111111111113' } as IssuanceCustomer,
  /** غير مصنّف: قناة جملة واسم منشأة فقط ⇒ مبسّطة حتى يُصنَّف (Q2). */
  unclassifiedChannel: { id: 'c-uncl-ch', name: 'أبو سعد', businessName: 'بقالة النور', channel: 'WHOLESALE' } as IssuanceCustomer,
  /** غير مصنّف: معرّف منشأة (CRN) في حقلَي المعرّف وحده ⇒ مبسّطة (القاعدة الحيّة في Z5.1a). */
  unclassifiedBusinessId: { id: 'c-uncl-id', name: 'تموينات', buyerIdScheme: 'CRN', buyerIdValue: '١٠١٠١٠١٠١٠' } as IssuanceCustomer,
});

export const PRODUCTS: readonly IssuanceProduct[] = Object.freeze([
  { id: 'p-water', name: 'مياه معدنية 330 مل × 40' },
  { id: 'p-juice', name: 'عصير برتقال 1 لتر' },
  { id: 'p-rice', name: 'أرز بسمتي 5 كجم', vatCategory: 'S' },
  { id: 'p-sugar', name: 'سكر ناعم' },
  { id: 'p-mask', name: 'كمامات طبية', vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-35', vatExemptionReason: 'Medicines and medical equipment | الأدوية والمعدات الطبية' },
  { id: 'p-fin', name: 'رسوم خدمة تمويل', vatCategory: 'E', vatExemptionCode: 'VATEX-SA-29', vatExemptionReason: 'Financial services | الخدمات المالية' },
  { id: 'p-gov-fee', name: 'رسوم حكومية مستردّة', vatCategory: 'O', vatExemptionCode: 'VATEX-SA-OOS', vatExemptionReason: 'Not subject to VAT | خارج نطاق الضريبة' },
  { id: 'p-zero-uncat', name: 'صنف بنسبة صفر بلا فئة' },
  { id: 'p-five', name: 'صنف بنسبة 5%', vatCategory: 'S' },
]);

/** طلب المندوب المطابق لعيّنة Z1 المبسّطة (أسعار شاملة، خصم بند، بقية 0.01). */
export const REQ_SIMPLIFIED_Z1: IssuanceRequest = Object.freeze({
  type: 'CASH', paymentPlan: null, pricesIncludeTax: true, discountPct: 0, supplyDate: null,
  items: [
    { productId: 'p-water', qty: 2, unitPrice: 5, discountPct: 0, taxPct: 15 },
    { productId: 'p-juice', qty: 3, unitPrice: 11.5, discountPct: 10, taxPct: 15 },
  ],
}) as IssuanceRequest;

/** طلب المدير المطابق لعيّنة Z1 القياسية (أسعار صافية، خصم بند وخصم فاتورة، ونسبتان مع بند صفري، تاريخ توريد سابق). */
export const REQ_STANDARD_Z1: IssuanceRequest = Object.freeze({
  type: 'CREDIT', paymentPlan: null, pricesIncludeTax: false, discountPct: 5, supplyDate: '2026-09-13',
  items: [
    { productId: 'p-rice', qty: 10, unitPrice: 45.5, discountPct: 10, taxPct: 15 },
    { productId: 'p-sugar', qty: 12.5, unitPrice: 3.35, discountPct: 0, taxPct: 15 },
    { productId: 'p-mask', qty: 4, unitPrice: 19.99, discountPct: 0, taxPct: 0 },
  ],
}) as IssuanceRequest;

/** بند واحد شامل الضريبة 15% بسعر G (مبسّطة نقدية). */
export function inclusiveOne(g: number, over: Partial<IssuanceRequest> = {}): IssuanceRequest {
  return { type: 'CASH', paymentPlan: null, pricesIncludeTax: true, discountPct: 0, supplyDate: null, items: [{ productId: 'p-water', qty: 1, unitPrice: g, discountPct: 0 }], ...over };
}

/** G = 11.50 ⇒ 10.00 + 1.50 بلا بقية. */
export const REQ_INCLUSIVE_R0 = inclusiveOne(11.5);
/** G = 25.80 ⇒ 22.43 + 3.36 = 25.79 ⇒ فرق تقريب 0.01. */
export const REQ_INCLUSIVE_2580 = inclusiveOne(25.8);
/** G = 25.95 ⇒ 22.56 + 3.38 = 25.94 ⇒ فرق تقريب 0.01. */
export const REQ_INCLUSIVE_2595 = inclusiveOne(25.95);
/** نسبتان: 25.80 @15% (بقية 0.01) + 0.10 @5% (0.09 + 0.00 ⇒ بقية 0.01) ⇒ فرق تقريب 0.02. */
export const REQ_TWO_BUCKETS_002: IssuanceRequest = {
  type: 'CASH', paymentPlan: null, pricesIncludeTax: true, discountPct: 0, supplyDate: null,
  items: [
    { productId: 'p-water', qty: 1, unitPrice: 25.8, discountPct: 0, taxPct: 15 },
    { productId: 'p-five', qty: 1, unitPrice: 0.1, discountPct: 0, taxPct: 5 },
  ],
};

/** المحرّك كما يستدعيه POST /invoices (بلا taxPct ⇒ ضريبة الشركة، خانتان للريال). */
export function engineOf(request: IssuanceRequest, companyVat: number = COMPANY_VAT): EngineTotals {
  return computeInvoiceTotals(
    request.items.map(i => ({ qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct ?? 0, taxPct: i.taxPct ?? undefined })),
    { companyVat, decimals: 2, invoiceDiscountPct: request.discountPct ?? 0, pricesIncludeTax: request.pricesIncludeTax },
  );
}
