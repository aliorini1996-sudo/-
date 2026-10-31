// «فك قيد الرقم الضريبي والعنوان الوطني» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — تركيبات حتمية لفحص الحفظ (patch، stored) يُقاس بها أنّ
// validateBuyerChanges بلا الخيار (أو { relaxed: false }) يطابق سلوك ما قبل الميزة بايتاً ببايت (بصمة مسجّلة من master 331d670).
// مصطنعة بالكامل — لا تمثّل عميلاً حقيقياً.
import type { BuyerPatch, BuyerRowLike } from '../buyerData';

export interface RelaxParityCase { patch: BuyerPatch; stored: BuyerRowLike | null }

/** حالات يدوية: كل فرع من فروع الفحص (صحيح وخاطئ، سعودي وخارجه، تغيّر الدولة، الزوج، القديم الخاطئ). */
export const RELAX_HANDPICKED: readonly RelaxParityCase[] = Object.freeze([
  { patch: { taxNumber: '30000000000000' }, stored: null },
  { patch: { taxNumber: '300000000000003' }, stored: null },
  { patch: { taxNumber: '123' }, stored: { taxNumber: '123' } },
  { patch: { taxNumber: 'x'.repeat(65) }, stored: null },
  { patch: { taxNumber: '3000\u00010000000003' }, stored: null },
  { patch: { taxNumber: '123', countryCode: 'AE' }, stored: null },
  { patch: { taxNumber: 'y'.repeat(70), countryCode: 'AE' }, stored: null },
  { patch: { addrBuildingNo: '123' }, stored: null },
  { patch: { addrBuildingNo: '1234' }, stored: null },
  { patch: { addrBuildingNo: '1'.repeat(17) }, stored: null },
  { patch: { addrBuildingNo: '12\u00073' }, stored: null },
  { patch: { addrBuildingNo: '1'.repeat(17), countryCode: 'AE' }, stored: null },
  { patch: { addrPostalCode: '1234' }, stored: null },
  { patch: { addrPostalCode: '12345' }, stored: null },
  { patch: { addrPostalCode: '1\u000734' }, stored: null },
  { patch: { addrPostalCode: '9'.repeat(20) }, stored: null },
  { patch: { addrAdditionalNo: '12' }, stored: null },
  { patch: { addrAdditionalNo: '1'.repeat(17) }, stored: null },
  { patch: { addrStreet: 'شارع\u0001' }, stored: null },
  { patch: { city: 'م'.repeat(201) }, stored: null },
  { patch: { district: 'الحي' }, stored: null },
  { patch: { businessName: 'مؤسسة\u0002' }, stored: null },
  { patch: { countryCode: 'KSA' }, stored: null },
  { patch: { countryCode: 'SA' }, stored: { countryCode: 'AE', addrBuildingNo: '123', addrPostalCode: '1', taxNumber: '9' } },
  { patch: { countryCode: 'AE' }, stored: { addrBuildingNo: '123', taxNumber: '123' } },
  { patch: { countryCode: null }, stored: { countryCode: 'SA' } },
  { patch: { buyerType: 'PERSON' }, stored: null },
  { patch: { buyerType: 'INDIVIDUAL', taxNumber: '300000000000003' }, stored: null },
  { patch: { buyerType: 'INDIVIDUAL' }, stored: { commercialReg: '1010101010' } },
  { patch: { buyerIdScheme: 'XYZ' }, stored: null },
  { patch: { buyerIdScheme: 'NAT' }, stored: null },
  { patch: { buyerIdScheme: 'NAT', buyerIdValue: '2000000000' }, stored: null },
  { patch: { buyerIdValue: 'ab-1' }, stored: { buyerIdScheme: 'NAT' } },
  { patch: { buyerIdValue: '1000000001' }, stored: null },
  { patch: { buyerIdScheme: 'CRN' }, stored: { commercialReg: '1010101010' } },
  { patch: { buyerIdScheme: 'CRN', buyerIdValue: '1010101010' }, stored: null },
  { patch: { buyerIdScheme: '700', buyerIdValue: '7000000001', buyerType: 'INDIVIDUAL' }, stored: null },
  { patch: { commercialReg: '12-3' }, stored: null },
  { patch: { commercialReg: '12345' }, stored: null },
  { patch: { taxNumber: null, addrBuildingNo: null }, stored: { taxNumber: '123', addrBuildingNo: '12' } },
  { patch: { addrStreet: 'شارع', city: 'الرياض' }, stored: { taxNumber: 'bad', addrBuildingNo: '1' } },
]);

/** توليد حتمي (LCG) لتركيبات إضافية: حقول مختارة بقيم صحيحة وخاطئة وفارغة، وصفّ محفوظ أو لا. */
export function relaxParityCases(n = 400): RelaxParityCase[] {
  let seed = 20261031;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const values: Record<string, readonly (string | null)[]> = {
    taxNumber: [null, '300000000000003', '123', '30000000000000', '3000000000000033', 'abc', '3 00000000000003', 'z'.repeat(66), 'v\u0003'],
    commercialReg: [null, '1010101010', '12-3', '12345'],
    buyerType: [null, 'BUSINESS', 'INDIVIDUAL', 'GOVERNMENT', 'X'],
    buyerIdScheme: [null, 'NAT', 'CRN', '700', 'XYZ', 'OTH'],
    buyerIdValue: [null, '1000000001', '7000000001', 'a b', 'AB12'],
    addrStreet: [null, 'شارع الملك', 's\u0001'],
    addrBuildingNo: [null, '1234', '123', '12a4', '1'.repeat(18), '1\u00052'],
    addrAdditionalNo: [null, '1111', '11', '1'.repeat(17)],
    addrPostalCode: [null, '12345', '1234', 'ABCDE', '9'.repeat(17), '1\u00062345'],
    countryCode: [null, 'SA', 'AE', 'KSA'],
    city: [null, 'الرياض', 'c\u0001'],
    district: [null, 'الروضة'],
    businessName: [null, 'مؤسسة'],
  };
  const keys = Object.keys(values);
  const out: RelaxParityCase[] = [...RELAX_HANDPICKED];
  for (let i = 0; i < n; i++) {
    const patch: Record<string, string | null> = {};
    const stored: Record<string, string | null> = {};
    for (const k of keys) {
      if (rnd() < 0.35) patch[k] = pick(values[k]);
      if (rnd() < 0.25) stored[k] = pick(values[k]);
    }
    out.push({ patch: patch as BuyerPatch, stored: rnd() < 0.4 ? null : (stored as BuyerRowLike) });
  }
  return out;
}
