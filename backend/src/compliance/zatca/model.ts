// ============================================================================
// ZATCA المرحلة الثانية (Z1) — نموذج مستند UBL 2.1 (أنواع نطاق نقيّة بلا Prisma)
// ----------------------------------------------------------------------------
// كل المبالغ هنا **نصوص عشرية جاهزة للكتابة** كما ستظهر في الـXML حرفياً ("123.45")،
// فلا يعيد المُسلسِل أي حساب ولا يقرّب: ما في النموذج = ما في الملف = ما في اللقطة.
// الأنواع مطابقة لـ design §3 Z1 مع إضافات صغيرة موثّقة بجانب كل حقل (⊕).
// ============================================================================

/** فئات ضريبة القيمة المضافة المسموحة وحدها (BR-KSA-18). */
export type VatCategory = 'S' | 'Z' | 'E' | 'O';

export const VAT_CATEGORIES: readonly VatCategory[] = ['S', 'Z', 'E', 'O'];

export interface UblAddress {
  street: string;           // BT-35 / BT-50 StreetName
  buildingNumber: string;   // KSA-17 / KSA-18 (4 أرقام)
  additionalNumber?: string; // KSA-23 PlotIdentification (اختياري)
  district: string;         // KSA-3 / KSA-4 CitySubdivisionName
  city: string;             // BT-37 / BT-52 CityName
  postalZone: string;       // BT-38 / BT-53 (5 أرقام)
  country: string;          // BT-40 / BT-55 IdentificationCode
}

export interface UblParty {
  registrationName?: string;                    // BT-27 / BT-44
  vatNumber?: string;                           // BT-31 / BT-48
  otherId?: { scheme: string; value: string };  // BT-29 / BT-46 + @schemeID
  address?: UblAddress;
}

export interface UblLineAllowance {
  amount: string;           // BT-136
  reason: string;           // BT-139
  baseAmount?: string;      // ⊕ BT-137 — يُكتب مع النسبة فقط (الوضع الحصري، BR-KSA-EN16931-03)
  multiplier?: string;      // ⊕ BT-138 MultiplierFactorNumeric ("10.00")
}

export interface UblLine {
  id: number;               // BT-126
  name: string;             // BT-153
  quantity: string;         // BT-129
  unitCode: string;         // @unitCode (UN/ECE Rec 20)
  priceAmount: string;      // BT-146
  allowance?: UblLineAllowance;
  lineExtension: string;    // BT-131
  vat: { category: VatCategory; percent: string; exemptionCode?: string; exemptionReason?: string };
  taxAmount: string;        // KSA-11
  roundingAmount: string;   // KSA-12 = BT-131 + KSA-11 (BR-KSA-51)
}

export interface UblDocAllowance {
  amount: string;
  category: VatCategory;
  percent: string;
  reason: string;
  reasonCode?: string;
}

export interface UblSubtotal {
  taxable: string;          // BT-116
  tax: string;              // BT-117
  category: VatCategory;    // BT-118
  percent: string;          // BT-119
  exemptionCode?: string;   // BT-121
  exemptionReason?: string; // BT-120
}

export interface UblTotals {
  lineExtension: string;    // BT-106
  taxExclusive: string;     // BT-109
  taxInclusive: string;     // BT-112
  allowanceTotal: string;   // BT-107
  prepaid: string;          // BT-113 (دائماً 0.00 — paidAmt لا يُربط به)
  payableRounding?: string; // BT-114 يُكتب فقط عند عدم الصفر
  payable: string;          // BT-115
  taxTotal: string;         // BT-110
}

export type InvoiceTypeCode = '388' | '381' | '383';

export interface UblDocument {
  id: string;               // BT-1
  uuid: string;             // KSA-1
  issueDate: string;        // BT-2 (الرياض)
  issueTime: string;        // KSA-25 (الرياض، بلا Z)
  typeCode: InvoiceTypeCode;
  typeName: string;         // KSA-2 سبع خانات NNPNESB
  currency: string;         // ⊕ BT-5 — يلزم أن يكون SAR (D9)؛ مطلوب للفحص المسبق
  icv: number;              // KSA-16
  pih: string;              // KSA-13
  billingReferences?: string[]; // BT-25
  instructionNote?: string; // KSA-10
  supplyDate?: string;      // KSA-5
  paymentMeansCode?: string; // BT-81
  supplier: UblParty;
  customer: UblParty;
  docAllowances: UblDocAllowance[];
  subtotals: UblSubtotal[];
  totals: UblTotals;
  lines: UblLine[];
}

/** مخالفة تُعرض للمستخدم بالعربية وتُسمّي الحقل الناقص. ⊕ severity: warning لا يمنع الإصدار. */
export interface ZatcaIssue {
  rule: string;
  field: string;
  messageAr: string;
  severity: 'error' | 'warning';
}

/**
 * خطأ مُدخلات لا يمكن معها بناء المستند أصلاً (فئة ضريبية غير قابلة للاستنتاج، أرقام خارج
 * النطاق، خصم فاتورة على أسعار شاملة…). يحمل نفس شكل مخالفات الفحص المسبق كي يُعاد 422
 * ZATCA_PREFLIGHT بقائمة الحقول — ويُرمى **قبل** استهلاك أي ICV.
 */
export class ZatcaInputError extends Error {
  readonly code: string;
  readonly issues: ZatcaIssue[];
  constructor(code: string, issues: ZatcaIssue[]) {
    super(`${code}: ${issues.map(i => i.messageAr).join(' · ')}`);
    this.name = 'ZatcaInputError';
    this.code = code;
    this.issues = issues;
  }
}
