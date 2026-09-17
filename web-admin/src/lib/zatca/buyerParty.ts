// ============================================================================
// نسخة حرفية من backend/src/compliance/zatca/buyerParty.ts (بعد رأسه) — تصنيف المشتري (01/02) وطرفه في المستند.
// لا تعدّل هنا: عدّل ملف الخادم ثم انسخه. الحارس lib/zatca/buyerParty.test.ts يفشل عند أي فرق.
// ============================================================================

import { sanitizeText } from './validators';
import type { AddressLike, PartyLike } from './validators';

export type BuyerSubtype = '01' | '02';

/** بيانات المشتري — حقول Customer الحالية والمضافة (بنية BuyerSource في mapInvoice.ts). */
export interface BuyerPartySource {
  name?: string | null;
  businessName?: string | null;
  taxNumber?: string | null;
  commercialReg?: string | null;
  buyerType?: string | null;       // INDIVIDUAL | BUSINESS | GOVERNMENT | null
  buyerIdScheme?: string | null;
  buyerIdValue?: string | null;    // null + CRN ⇒ commercialReg
  addrStreet?: string | null;
  addrBuildingNo?: string | null;
  addrAdditionalNo?: string | null;
  addrPostalCode?: string | null;
  district?: string | null;
  city?: string | null;
  countryCode?: string | null;     // null ⇒ SA
}

/** كل نص يمرّ من هنا: sanitizeText ثم القصّ؛ نصّ من محارف تحكّم فقط = غائب. */
const clean = (v: string | null | undefined): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = sanitizeText(v).trim();
  return t === '' ? undefined : t;
};

/**
 * النوع الفرعي: 01 للمنشأة أو الجهة الحكومية؛ ما دام نوع المشتري غير مصنَّف فـ 01 عند وجود رقم ضريبي أو سجل تجاري،
 * وإلا 02. الفرد صراحةً مبسطة ولو أدخل رقماً.
 */
export function classifyBuyerSubtype(buyer: BuyerPartySource): BuyerSubtype {
  const t = clean(buyer.buyerType)?.toUpperCase();
  if (t === 'BUSINESS' || t === 'GOVERNMENT') return '01';
  if (t === 'INDIVIDUAL') return '02';
  return clean(buyer.taxNumber) || clean(buyer.commercialReg) ? '01' : '02';
}

/**
 * طرف المشتري. الضريبية (01): الاسم والعنوان الكامل والرقم الضريبي و/أو المعرّف الآخر (CRN من السجل التجاري حين لا نوع
 * صريحاً). المبسطة (02): الاسم، والمعرّف الآخر فقط إن أُدخل صريحاً بنوعه وقيمته، وبلا عنوان.
 */
export function mapBuyerPartyLike(b: BuyerPartySource, subtype: BuyerSubtype): PartyLike {
  const party: PartyLike = {};
  const name = clean(b.businessName) ?? clean(b.name);
  if (name) party.registrationName = name;
  const explicitScheme = clean(b.buyerIdScheme)?.toUpperCase();
  if (subtype === '02') {
    const explicitValue = clean(b.buyerIdValue);
    if (explicitScheme && explicitValue) party.otherId = { scheme: explicitScheme, value: explicitValue };
    return party;
  }

  const vat = clean(b.taxNumber);
  if (vat) party.vatNumber = vat;
  const cr = clean(b.commercialReg);
  const scheme = explicitScheme ?? (cr ? 'CRN' : undefined);
  const value = clean(b.buyerIdValue) ?? (scheme === 'CRN' ? cr : undefined);
  if (scheme && value) party.otherId = { scheme, value };
  const address: AddressLike = {
    street: clean(b.addrStreet) ?? '',
    buildingNumber: clean(b.addrBuildingNo) ?? '',
    district: clean(b.district) ?? '',
    city: clean(b.city) ?? '',
    postalZone: clean(b.addrPostalCode) ?? '',
    country: clean(b.countryCode)?.toUpperCase() ?? 'SA',
  };
  const extra = clean(b.addrAdditionalNo);
  if (extra) address.additionalNumber = extra;
  party.address = address;
  return party;
}
