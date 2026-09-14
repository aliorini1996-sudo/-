// بيانات اختبار Z1 — مصطنعة بالكامل (الرقم الضريبي 399999999900003 رقم الهيئة التجريبي العامّ).
// لا تمثّل أي شركة أو عميل حقيقي. تُستعمل في ubl/mapInvoice/preflight.test.ts.
import { ChainValues, InvoiceSource, SellerSource, BuyerSource } from '../mapInvoice';
import { INITIAL_PIH } from '../crypto';

export const SELLER: SellerSource = {
  legalName: 'شركة التوزيع الميداني التجريبية المحدودة',
  taxNumber: '399999999900003',
  commercialReg: '1010010000',
  sellerIdScheme: null,
  sellerIdValue: null,
  addrStreet: 'طريق الأمير سلطان',
  addrBuildingNo: '2322',
  addrAdditionalNo: '1234',
  addrDistrict: 'المحمدية',
  addrCity: 'الرياض',
  addrPostalCode: '12345',
  countryCode: 'SA',
};

export const BUSINESS_BUYER: BuyerSource = {
  name: 'أبو خالد',
  businessName: 'مؤسسة البقالة الحديثة للتجارة',
  taxNumber: '311111111111113',
  commercialReg: '2050012345',
  buyerType: 'BUSINESS',
  addrStreet: 'شارع الملك فهد',
  addrBuildingNo: '7788',
  addrAdditionalNo: null,
  addrPostalCode: '31952',
  district: 'الروضة',
  city: 'الدمام',
  countryCode: 'SA',
};

export const WALK_IN_BUYER: BuyerSource = {
  name: 'محمد عبدالله',
  buyerType: 'INDIVIDUAL',
  city: 'الرياض',
};

/** سلسلة ثابتة (لا توليد عشوائي) كي تبقى البايتات قابلة للمقارنة. */
export function chainFor(icv: number, pih = INITIAL_PIH): ChainValues {
  return {
    icv,
    pih,
    uuid: `8e6000cf-1a98-4174-b3e7-b5d5954bc10${icv}`,
    issuedAt: new Date('2026-09-14T07:15:30.250Z'), // 10:15:30 بتوقيت الرياض
  };
}

/** فاتورة مبسطة من تطبيق المندوب: أسعار شاملة، خصم بند، وبقية تقريب 0.01. */
export const SIMPLIFIED_INVOICE: InvoiceSource = {
  kind: 'INVOICE',
  number: 'INV-2609-000123',
  currency: 'SAR',
  pricesIncludeTax: true,
  invoiceDiscountPct: 0,
  paymentType: 'CASH',
  seller: SELLER,
  buyer: WALK_IN_BUYER,
  items: [
    { itemName: 'مياه معدنية 330 مل × 40', unitCode: null, qty: 2, unitPrice: 5, discountPct: 0, taxPct: 15 },
    { itemName: 'عصير برتقال 1 لتر', unitCode: 'PCE', qty: 3, unitPrice: 11.5, discountPct: 10, taxPct: 15 },
  ],
};

/** فاتورة ضريبية من لوحة الإدارة: أسعار صافية، خصم بند وخصم فاتورة، ونسبتان + بند صفري. */
export const STANDARD_INVOICE: InvoiceSource = {
  kind: 'INVOICE',
  number: 'INV-2609-000124',
  currency: 'SAR',
  pricesIncludeTax: false,
  invoiceDiscountPct: 5,
  paymentType: 'CREDIT',
  supplyDate: '2026-09-13',
  seller: SELLER,
  buyer: BUSINESS_BUYER,
  items: [
    { itemName: 'أرز بسمتي 5 كجم', unitCode: 'PCE', qty: 10, unitPrice: 45.5, discountPct: 10, taxPct: 15 },
    { itemName: 'سكر ناعم', unitCode: 'KGM', qty: 12.5, unitPrice: 3.35, discountPct: 0, taxPct: 15 },
    { itemName: 'كمامات طبية', unitCode: 'BX', qty: 4, unitPrice: 19.99, discountPct: 0, taxPct: 0, vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-35', vatExemptionReason: 'Medicines and medical equipment | الأدوية والمعدات الطبية' },
  ],
};

/** إشعار دائن ضريبي (381/01) لمرتجع جزئي من الفاتورة الضريبية. */
export const STANDARD_CREDIT_NOTE: InvoiceSource = {
  kind: 'CREDIT_NOTE',
  number: 'RET-2609-000045',
  currency: 'SAR',
  pricesIncludeTax: false,
  invoiceDiscountPct: 0,
  paymentType: 'CREDIT',
  subtype: '01',
  billingReferences: ['INV-2609-000124'],
  noteReason: 'إرجاع بضاعة تالفة',
  seller: SELLER,
  buyer: BUSINESS_BUYER,
  items: [
    { itemName: 'أرز بسمتي 5 كجم', unitCode: 'PCE', qty: 2, unitPrice: 45.5, discountPct: 10, taxPct: 15 },
  ],
};

/** إشعار مدين مبسط (383/02) لتعديل سعر. */
export const SIMPLIFIED_DEBIT_NOTE: InvoiceSource = {
  kind: 'DEBIT_NOTE',
  number: 'DBN-2609-000007',
  currency: 'SAR',
  pricesIncludeTax: true,
  invoiceDiscountPct: 0,
  paymentType: 'CASH',
  subtype: '02',
  billingReferences: ['INV-2609-000123'],
  noteReason: 'تصحيح سعر الصنف',
  seller: SELLER,
  buyer: WALK_IN_BUYER,
  items: [
    { itemName: 'فرق سعر عصير برتقال', unitCode: null, qty: 1, unitPrice: 2.3, discountPct: 0, taxPct: 15 },
  ],
};
