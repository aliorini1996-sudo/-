// ============================================================================
// ZATCA المرحلة الثانية (Z5.5) — نواة الإشعارات الدائنة والمدينة: من فاتورة أصلية إلى مستند 381/383 على سلسلة الوحدة نفسها
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.5» + §2.2 (معاملة الإصدار) + §2.4 (الأعمدة والمبالغ) + قرارات المالك D3/D4/Q1/Q5 + نقد الخطة (7، 13، 14، 20، 31):
//   • D3: الإشعار الدائن **مرتبط بفاتورة أصلية دائماً** (BT-25 = رقمها) — لا مرتجع بلا أصل ولا إشعار دون اتصال. والأصل فاتورة
//     (CASH أو CREDIT) لا إشعاراً ولا مرتجعاً: إشعارٌ على إشعار ⇒ 409 (ولا إلغاء لإشعار في v1).
//   • D4: بعد الربط لا يُلغى مستند — الإلغاء الكامل يصير إشعاراً دائناً كاملاً. وفاتورة قياسية رفضتها الهيئة أُبطلت تلقائياً
//     (Z5.4) فلا إشعار عليها: ORIGINAL_VOIDED. وهو نفسه حارس Q1: النقدية المُبطلة تركت **رصيداً دائناً** للعميل، فإشعارٌ بعدها
//     كان يمنحه الرصيد مرّتين.
//   • الأصل مقبول = ما يجوز تسليمه للمشتري (isPrintableMirror): المبسّطة بأي حالة عدا المُبطلة، والقياسية بعد الاعتماد (أو بعد
//     الإبلاغ حين يوقف الاعتماد — نقد 10). وأصلٌ من المرحلة الأولى مسموح برقمه مرجعاً وبنوعٍ فرعيّ من تصنيف العميل الحيّ (حجب D2
//     يسري عليه كما يسري على الفاتورة).
//   • البنود تُنسخ من **بنود الأصل** (سعرها وخصمها ونسبتها وفئتها وإعفاؤها كما صدرت) لا من بطاقة صنفٍ تغيّرت بعد البيع، ومعها
//     `pricesIncludeTax` وخصم الفاتورة الكلّي — فالإشعار الجزئي يحمل حصّته من الخصم وضريبته على صافيها، وقواعد التقريب (D6)
//     هي عينها قواعد Z5.2 لأنّ الطريق واحد: computeInvoiceTotals ⇒ prepareIssuance ⇒ storedAmounts.
//   • حارسان: الكمية لكل بند (المُباع − مجموع ما أُرجع في إشعارات ملتزَمة سابقة) وهو الحارس الحقيقي، والقيمة على مستوى الفاتورة
//     شبكةَ أمانٍ خلفه بسماح تقريبٍ معلوم (هللة لكل سلّة نسبة لكل إشعار).
//   • السلسلة والختم: stampNoteInTx يمرّ بـstampInTx نفسه — القفل والرقم واللحظة وICV/PIH وCAS وترتيب نقد 38 بلا نسخة ثانية.
//     بادئة الرقم RET للدائن (صفّه type='RETURN') وINV للمدين (صفّه type='CREDIT').
//   • F1 (نقد 13): أثر الإشعار على متبقّي الأصل يُحسب **فرقاً نسبياً** (decrement) لا قيمةً مطلقة، كي لا يدهس سندَ قبضٍ متزامناً.
//   • الوحدات المتعددة (docs/multi-unit/DESIGN.md §9–10): المتاح والحارس ونطاق Q5 **بالأساس**، وبند الإشعار بوحدة الإرجاع
//     (كميته وسعره ورمزه معاً)، وسعر الحبّة من بند كرتون حصّةٌ تراكمية من قيمة البند (services/units.ts refundAmount).
// لا قاعدة بيانات ولا شبكة ولا services/gl هنا: القيود والمخزون يكتبها المسار بالبُناة القائمة (postReturnEntries/postInvoiceEntries).
// ============================================================================

import { customerBuyerStatus, buyerSourceFromCustomer } from './buyerData';
import { classifyBuyerSubtype } from './buyerParty';
import {
  ZatcaHttpError, creditAmountExceededError, creditQtyExceededError, noteLinesError, preflightHttpError,
} from './errors';
import {
  PHASE2_UNIT_CODE, phase2InvoiceColumns, phase2ItemColumns, phase2NumberPrefix, phase2UnitCode, prepareIssuance,
  type IssuanceCustomer, type IssuanceItemSnapshot, type IssuanceNoteContext, type IssuanceRequest, type IssuanceSellerSettings,
  type IssuedInvoiceRecord, type PreparedIssuance,
} from './issue';
import { stampInTx, type StampInTxDeps, type StampInTxHooks, type StampInTxResult } from './issueTx';
import type { IssuanceSigning } from './issueSigner';
import { mapBuyerParty, type DocumentKind, type InvoiceSubtype, type LineSource } from './mapInvoice';
import type { UblParty, ZatcaIssue } from './model';
import { isPrintableMirror, type Subtype } from './status';
import { computeInvoiceTotals, roundDecimal, type CalcResult } from '../../lib/invoiceCalc';
import { baseQtyOf, factorOf, formatQty, refundAmount, toBase } from '../../services/units';

// ─── الأنواع ───

/** نوع الإشعار: دائن (381، مرتجع/إلغاء) أو مدين (383، زيادة على الأصل). */
export type NoteKind = Exclude<DocumentKind, 'INVOICE'>;

export const NOTE_KINDS: readonly NoteKind[] = Object.freeze(['CREDIT_NOTE', 'DEBIT_NOTE'] as NoteKind[]);

export function isNoteKind(v: unknown): v is NoteKind {
  return v === 'CREDIT_NOTE' || v === 'DEBIT_NOTE';
}

/** بند الفاتورة الأصلية كما يُقرأ للإشعار (لقطة المرحلة الثانية إن وُجدت، وإلا أعمدة البند القديمة). */
export interface NoteOriginalItem {
  id: string;
  productId: string | null;
  /** ترتيب البند في المستند الأصلي (Phase-2)؛ null للمرحلة الأولى ⇒ ترتيب القراءة. */
  seq: number | null;
  /** اسم الصنف لحظة البيع (Phase-2)؛ null ⇒ اسم بطاقة الصنف الذي يمرّره المسار. */
  itemName: string | null;
  unitCode: string | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  vatCategory: string | null;
  vatExemptionCode: string | null;
  vatExemptionReason: string | null;
  /** سياسة عودة التالف لمخزون السيارة (Product.damagedReturnToStock) — لاشتقاق returnToStock كما اليوم. */
  damagedReturnToStock?: boolean | null;
  /**
   * الوحدات المتعددة: لقطة وحدة البند المباع كما كُتبت يوم البيع (غائبةٌ أو null/1 = وحدة الأساس كما قبل الميزة).
   * فالكمية المباعة بالأساس = qty × unitFactor، وهي وحدها ما يُقارَن به المرتجع.
   */
  unitName?: string | null;
  unitFactor?: number | null;
  baseQty?: number | null;
  /** وحدات الصنف اليوم (النشطة والموقوفة) — منها تُحلّ وحدة المرتجع المطلوبة بمعرّفها. */
  units?: readonly NoteUnitDef[] | null;
  /** اسم وحدة الأساس (Product.unit) — لرسالة التجاوز «١ كرتون و٣ حبة». */
  baseUnitName?: string | null;
}

/** وحدة بيعٍ للصنف كما يحتاجها الإشعار (صفّ ProductUnit). */
export interface NoteUnitDef {
  id: string;
  name: string;
  factor: number;
  unitCode?: string | null;
  isActive?: boolean;
}

/** صفّ الفاتورة الأصلية كما يُقرأ مقفلاً (SELECT … FOR UPDATE) داخل معاملة الإشعار. */
export interface NoteOriginalInvoice {
  id: string;
  tenantId: string;
  customerId: string;
  salesRepId: string | null;
  /** الفرق: فريق الأصل — يرثه الإشعار */
  teamId?: string | null;
  /** «لوكيشن»: ختم موقع الأصل — يرثه الإشعار (اختياريّ كي تبقى تجهيزات الاختبار القديمة صالحة) */
  locationId?: string | null;
  number: string;
  status: string;
  /** CASH | CREDIT | RETURN */
  type: string;
  paymentPlan: string | null;
  zatcaPhase: number | null;
  documentKind: string | null;
  invoiceSubtype: string | null;
  einvoiceStatus: string | null;
  pricesIncludeTax: boolean;
  discountPct: number;
  total: number;
  paidAmt: number;
  remainingAmt: number;
  /** تاريخ الفاتورة — يحدّ نافذة المرتجعات القديمة التي تُخصم من المتاح لأصلٍ من المرحلة الأولى. */
  invoiceDate?: Date | null;
  items: readonly NoteOriginalItem[];
}

/**
 * مرتجعٌ قديم (ما قبل الربط) لعميل الأصل: صفٌّ بلا `originalInvoiceId` ولا `creditedItemId`، فلا يراه حارس الكمية
 * المبنيّ على الإشعارات. يُطابَق بالصنف وحده — وهو كلّ ما في الصفّ القديم.
 */
export interface LegacyReturnQty {
  productId: string | null;
  qty: number;
  /** معامل وحدة صفّ المرتجع (غائبٌ = ١) — البركة تُجمع بالأساس */
  unitFactor?: number | null;
  baseQty?: number | null;
}

/** إشعار سابق على الأصل (يُقرأ بـoriginalInvoiceId) — الملتزَم وحده يُنقص المتاح. */
export interface PriorNote {
  id: string;
  status: string;
  documentKind: string | null;
  total: number;
  /** بنوده بلقطة وحدتها: إشعارٌ بالحبة على بند كرتون يُنقص المتاح حبّةً لا كرتوناً */
  items: readonly { creditedItemId: string | null; qty: number; unitFactor?: number | null; baseQty?: number | null }[];
}

// ─── الأهليّة ───

export type NoteRefusal =
  | 'NOT_FOUND' | 'TENANT_MISMATCH' | 'CUSTOMER_MISMATCH' | 'NOT_AN_INVOICE' | 'WRONG_TYPE' | 'ORIGINAL_VOIDED'
  | 'SIMPLIFIED_REJECTED'
  | 'NOT_CONFIRMED' | 'ORIGINAL_NO_XML' | 'ORIGINAL_PENDING' | 'NO_SUBTYPE' | 'NO_REFERENCE' | 'NOTHING_TO_CREDIT';

export const NOTE_REFUSAL_MESSAGES: Readonly<Record<NoteRefusal, string>> = Object.freeze({
  NOT_FOUND: 'الفاتورة غير موجودة',
  TENANT_MISMATCH: 'الفاتورة غير موجودة',
  CUSTOMER_MISMATCH: 'الفاتورة الأصلية لعميل آخر',
  NOT_AN_INVOICE: 'لا يُصدر إشعار على إشعار — أصدر الإشعار على الفاتورة الأصلية',
  WRONG_TYPE: 'لا يُصدر إشعار على مرتجع — أصدر الإشعار على الفاتورة الأصلية',
  ORIGINAL_VOIDED: 'أُبطلت هذه الفاتورة (رفضتها الهيئة أو سُحبت قبل وصولها) — لا إشعار عليها، وما حُصّل منها بقي رصيداً دائناً للعميل',
  // المبسّطة لا تُبطل أبداً (void.ts: SIMPLIFIED_KEPT) — ورقتها عند المشتري وقيودها قائمة، فلا رصيد دائن يُوعَد به
  SIMPLIFIED_REJECTED: 'رفضت الهيئة هذه الفاتورة المبسّطة ولم تُبطل — أعد إصدارها أولاً (إعادة إصدار المستند) ثمّ أصدر الإشعار عليها',
  NOT_CONFIRMED: 'الفاتورة ملغاة أو غير معتمدة — لا يُصدر عليها إشعار',
  ORIGINAL_NO_XML: 'اعتمدت الهيئة الفاتورة ولم تصلنا نسختها المعتمدة — راجع الإدارة قبل إصدار إشعار عليها',
  ORIGINAL_PENDING: 'لا يمكن إصدار إشعار على فاتورة لم تعتمدها الهيئة بعد',
  NO_SUBTYPE: 'بيانات الفوترة الإلكترونية للفاتورة الأصلية ناقصة — راجع الإدارة',
  NO_REFERENCE: 'رقم الفاتورة الأصلية مفقود — لا يُبنى إشعار بلا مرجع',
  NOTHING_TO_CREDIT: 'كل كميات هذه الفاتورة مُرتجعة سابقاً',
});

/** الرفض ⇒ خطأ HTTP، أو null لما يُردّ 404 بلا كشف (غير موجودة/شركة أخرى/عميل آخر). */
export function noteRefusalError(refusal: NoteRefusal): ZatcaHttpError | null {
  const messageAr = NOTE_REFUSAL_MESSAGES[refusal];
  switch (refusal) {
    case 'NOT_FOUND': case 'TENANT_MISMATCH': case 'CUSTOMER_MISMATCH':
      return null;
    case 'NOT_AN_INVOICE': case 'WRONG_TYPE':
      return new ZatcaHttpError('ZATCA_NOTE_ON_NOTE', { messageAr, reason: refusal });
    case 'NOTHING_TO_CREDIT':
      return new ZatcaHttpError('ZATCA_NOTHING_TO_CREDIT', { messageAr, reason: refusal });
    case 'NO_SUBTYPE':
      return new ZatcaHttpError('ZATCA_INTERNAL', { reason: refusal, logDetail: { source: 'NOTE', code: refusal } });
    default:
      return new ZatcaHttpError('ZATCA_ORIGINAL_NOT_CLEARED', { messageAr, reason: refusal });
  }
}

export interface NoteEligible {
  ok: true;
  /** نوع الأصل الفرعي المجمَّد (أو تصنيف العميل الحيّ لأصلٍ من المرحلة الأولى). */
  subtype: InvoiceSubtype;
  subtypeSource: 'inherited' | 'classified';
  /** BR-49: طريقة دفع الأصل (INSTALLMENT لخطة الأقساط). */
  paymentType: string;
  /** BT-25 كما يُكتب في المستند. */
  billingReference: string;
  originalPhase: 1 | 2;
}

export type NoteEligibility = NoteEligible | { ok: false; refusal: NoteRefusal };

const refuse = (refusal: NoteRefusal): NoteEligibility => ({ ok: false, refusal });

/** مرايا تعني أنّ الفاتورة أُبطلت تحت المستند (Z5.4) — لا إشعار عليها بحال. */
const VOIDED_MIRRORS: readonly string[] = Object.freeze(['rejected', 'withdrawn']);

/**
 * نقيّ: هل يجوز إصدار إشعار على هذه الفاتورة الآن؟ لا يفحص الكميات (ذاك creditableLines) ولا الصلاحيات (المسار).
 */
export function noteEligibility(input: {
  tenantId: string;
  original: NoteOriginalInvoice | null | undefined;
  customer: IssuanceCustomer;
}): NoteEligibility {
  const o = input.original;
  if (!o) return refuse('NOT_FOUND');
  if (o.tenantId !== input.tenantId) return refuse('TENANT_MISMATCH');
  if (o.customerId !== input.customer.id) return refuse('CUSTOMER_MISMATCH');
  if (o.documentKind !== null && o.documentKind !== 'INVOICE') return refuse('NOT_AN_INVOICE');
  if (o.type !== 'CASH' && o.type !== 'CREDIT') return refuse('WRONG_TYPE');

  const phase2 = o.zatcaPhase === 2;
  // D4/Q1 قبل حالة الصفّ: المُبطلة تُسمّى بسببها لا بـ«غير معتمدة» — والرصيد الدائن الذي تركته سببُ المنع.
  // والمبسّطة **لا تُبطل** (void.ts يردّ SIMPLIFIED_KEPT لغير '01')، فرفضها حالٌ تُصحَّح بإعادة الإصدار لا إبطالٌ:
  // رسالةُ الإبطال كانت تعِد بضاعةً مردودة ورصيدٍ دائن لا وجود لهما (مراجعة: «مال ومخزون»).
  if (phase2 && VOIDED_MIRRORS.includes(o.einvoiceStatus ?? '')) {
    return refuse(o.invoiceSubtype === '02' && o.einvoiceStatus === 'rejected' ? 'SIMPLIFIED_REJECTED' : 'ORIGINAL_VOIDED');
  }
  if (o.status !== 'CONFIRMED') return refuse('NOT_CONFIRMED');

  let subtype: InvoiceSubtype;
  let subtypeSource: NoteEligible['subtypeSource'];
  if (phase2) {
    const s = o.invoiceSubtype;
    if (s !== '01' && s !== '02') return refuse('NO_SUBTYPE');
    subtype = s;
    subtypeSource = 'inherited';
    if (o.einvoiceStatus === 'cleared_no_xml') return refuse('ORIGINAL_NO_XML');
    if (!isPrintableMirror(o.einvoiceStatus, subtype as Subtype)) return refuse('ORIGINAL_PENDING');
  } else {
    // أصل من المرحلة الأولى: لا مرآة تُفحص — والنوع من تصنيف العميل الحيّ (وحجب D2 يسري في prepareIssuance)
    subtype = classifyBuyerSubtype(buyerSourceFromCustomer(input.customer));
    subtypeSource = 'classified';
  }

  const billingReference = typeof o.number === 'string' ? o.number.trim() : '';
  if (billingReference === '') return refuse('NO_REFERENCE');

  return {
    ok: true,
    subtype,
    subtypeSource,
    paymentType: o.paymentPlan === 'INSTALLMENT' ? 'INSTALLMENT' : o.type,
    billingReference,
    originalPhase: phase2 ? 2 : 1,
  };
}

/** بيانات المشتري الناقصة لأصلٍ قياسيّ (حجب D2) — نفس فحص الفاتورة، يُستدعى قبل بناء المصدر. */
export function noteBuyerIncomplete(customer: IssuanceCustomer, subtype: InvoiceSubtype): boolean {
  return subtype === '01' && !customerBuyerStatus(customer).complete;
}

// ─── الكميات المتاحة للإرجاع ───

/**
 * دقّة الكميات المخزَّنة (Float): أربع خانات كما في حساب مخزون السيارة. تُطبَّق على كمياتٍ **بالأساس** (والمعامل
 * صحيح، فلا كسرَ ينشأ من التحويل)، لا على حبّةٍ ممثَّلةٍ كسرَ كرتون.
 */
export const QTY_DECIMALS = 4;
const QTY_EPSILON = 1e-6;

export const roundQty = (v: number): number => roundDecimal(v, QTY_DECIMALS);

/** إشعار سابق يُنقص المتاح: ملتزَم وليس إشعاراً مديناً (المدين يزيد ولا يُرجع كميّة). */
export function countsTowardCredit(n: PriorNote): boolean {
  return n.status === 'CONFIRMED' && n.documentKind !== 'DEBIT_NOTE';
}

export interface CreditableLine {
  invoiceItemId: string;
  seq: number;
  productId: string | null;
  itemName: string;
  unitCode: string;
  /*
   * الحقول الأربعة القديمة **بوحدة الأساس**: عميلٌ لا يعرف الوحدات (تطبيقٌ قديم، مفتاح API) يرسل الكمية بلا `unitId`
   * فيقرؤها الخادم أساساً (عقد التصميم §6) — فيجب أن يرى المتاح بها، وإلّا أرجع «٢» من «٢ كرتون» فقُيّدت حبّتان.
   * ولصنفٍ بلا وحدات (المعامل ١) هي أرقام ما قبل الميزة نفسها. وعقد /returnable في routes/invoices.ts على القاعدة نفسها.
   */
  /** المُباع في الأصل (بالأساس). */
  qty: number;
  /** المُرتجع في إشعارات ملتزَمة سابقة (بالأساس). */
  credited: number;
  /** المُرتجع في مرتجعات ما قبل الربط (بلا رابط بالأصل — مطابقة بالصنف، وأصلٌ من المرحلة الأولى وحده) — بالأساس. */
  legacyCredited: number;
  /** المتاح الآن = qty − credited − legacyCredited (لا يقلّ عن صفر) — بالأساس. */
  returnable: number;
  /** المُباع **بوحدة البند** كما طُبع (٢ كرتون) — ومعه سعر البند لوحدته `unitPrice`. */
  lineQty: number;
  /** سعر البند لوحدته (سعر الكرتون) كما صدر. */
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  vatCategory: string | null;
  vatExemptionCode: string | null;
  vatExemptionReason: string | null;
  damagedReturnToStock: boolean | null;
  /** لقطة وحدة البند المباع: اسمها (null = وحدة الأساس) ومعاملها. */
  unitName: string | null;
  unitFactor: number;
  /** اسم وحدة الأساس للعرض (Product.unit). */
  baseUnitName: string | null;
  /** وحدات الصنف — ما يجوز الإرجاع به غير وحدة البند نفسها ووحدة الأساس. */
  units: readonly NoteUnitDef[];
  /** أسماء الحقول الأربعة أعلاه الصريحة (بالأساس) — بها يعمل الحارس وعقد الواجهة الجديد. */
  soldBase: number;
  creditedBase: number;
  legacyCreditedBase: number;
  returnableBase: number;
}

/**
 * بنود الأصل بالمتاح منها، بترتيب المستند (seq ثم ترتيب القراءة). اسم الصنف من لقطة البند حين وُجدت
 * (المرحلة الثانية) وإلا يبقى كما مرّره المسار — فالإشعار يحمل اسم البيع لا اسم اليوم.
 *
 * `legacyReturns` (مراجعة «مال ومخزون/امتثال»): أصلٌ من **المرحلة الأولى** قد تكون أُرجعت بضاعته بمستند مرتجعٍ قديم
 * لا يحمل `originalInvoiceId` ولا `creditedItemId`، فلا تراه إشعاراتُه ويُرجَع المباعُ مرّتين (ائتمان مزدوج وكمّيةٌ
 * وهمية في السيارة). فتُخصم هذه الكمّيات **بالصنف** — وهي المطابقة الوحيدة الممكنة على صفٍّ بلا رابط — بترتيب
 * المستند: الخصم قد يصيب فاتورةً غير التي أُرجع منها فعلاً، وذاك اتجاه المنع لا اتجاه التسرّب.
 *
 * الوحدات المتعددة: كلّ جمعٍ وطرحٍ هنا **بالأساس** (qty × unitFactor). كان المتاح يُحسب بوحدة البند، فإشعارٌ سابق
 * بحبّةٍ من بند كرتون يُعدّ كرتوناً كاملاً، ومرتجعٌ قديم بالكراتين يُخصم حبّاتٍ من فاتورةٍ جديدة. وتمثيلُ الحبّة كسرَ
 * كرتونٍ (١÷٢٤ = ٠٫٠٤١٧ بعد التقريب) يتراكم فيتجاوز آخرُ مرتجعٍ المتاحَ فيُرفض — والأساس لا كسر فيه.
 */
export function creditableLines(
  original: NoteOriginalInvoice, priorNotes: readonly PriorNote[] = [], legacyReturns: readonly LegacyReturnQty[] = [],
): CreditableLine[] {
  const creditedBy = new Map<string, number>();
  for (const n of priorNotes) {
    if (!countsTowardCredit(n)) continue;
    for (const it of n.items) {
      if (typeof it.creditedItemId !== 'string' || it.creditedItemId === '') continue;
      creditedBy.set(it.creditedItemId, (creditedBy.get(it.creditedItemId) ?? 0) + baseQtyOf(it));
    }
  }
  const legacyPool = new Map<string, number>();
  for (const r of legacyReturns) {
    if (typeof r?.productId !== 'string' || r.productId === '') continue;
    const q = baseQtyOf(r);
    if (!(q > 0)) continue;
    legacyPool.set(r.productId, (legacyPool.get(r.productId) ?? 0) + q);
  }
  const rows = original.items.map((it, i) => {
    const factor = factorOf(it);
    const soldBase = roundQty(baseQtyOf(it));
    const creditedBase = roundQty(creditedBy.get(it.id) ?? 0);
    // بركة المرتجعات القديمة تُستهلك مرّةً واحدة: بندان بالصنف نفسه لا يخصمان الكمّية القديمة مرّتين
    const pooled = typeof it.productId === 'string' && it.productId !== '' ? (legacyPool.get(it.productId) ?? 0) : 0;
    const legacyCreditedBase = roundQty(Math.min(pooled, Math.max(0, soldBase - creditedBase)));
    if (legacyCreditedBase > 0) legacyPool.set(it.productId as string, roundQty(pooled - legacyCreditedBase));
    const returnableBase = roundQty(Math.max(0, soldBase - creditedBase - legacyCreditedBase));
    const line: CreditableLine = {
      invoiceItemId: it.id,
      seq: Number.isInteger(it.seq) && (it.seq as number) > 0 ? (it.seq as number) : i + 1,
      productId: it.productId,
      itemName: typeof it.itemName === 'string' && it.itemName.trim() !== '' ? it.itemName : '',
      // رمز وحدة البند كما دخل مستنده؛ ورمزٌ ليس بشكل UN/ECE (نصٌّ حرّ على وحدةٍ قديمة) لا ينتقل إلى الإشعار
      unitCode: phase2UnitCode(it.unitCode),
      qty: soldBase,
      credited: creditedBase,
      legacyCredited: legacyCreditedBase,
      returnable: returnableBase,
      lineQty: roundQty(Number(it.qty || 0)),
      unitPrice: Number(it.unitPrice || 0),
      discountPct: Number(it.discountPct || 0),
      taxPct: Number(it.taxPct || 0),
      vatCategory: it.vatCategory ?? null,
      vatExemptionCode: it.vatExemptionCode ?? null,
      vatExemptionReason: it.vatExemptionReason ?? null,
      damagedReturnToStock: it.damagedReturnToStock ?? null,
      unitName: typeof it.unitName === 'string' && it.unitName.trim() !== '' ? it.unitName.trim() : null,
      unitFactor: factor,
      baseUnitName: typeof it.baseUnitName === 'string' && it.baseUnitName.trim() !== '' ? it.baseUnitName.trim() : null,
      units: Array.isArray(it.units) ? it.units : [],
      soldBase,
      creditedBase,
      legacyCreditedBase,
      returnableBase,
    };
    return line;
  });
  rows.sort((a, b) => (a.seq - b.seq) || a.invoiceItemId.localeCompare(b.invoiceItemId));
  return rows;
}

/** هل بقي في الفاتورة ما يُرجَع؟ */
export function hasCreditableQty(lines: readonly CreditableLine[]): boolean {
  return lines.some(l => l.returnableBase > QTY_EPSILON);
}

/**
 * بند الطلب: بند الأصل وكميته **بوحدة الإرجاع**. `unitId` وحدةٌ من وحدات الصنف (كرتون)، وغيابه = وحدة الأساس بمعامل ١
 * (عقد التصميم §6) — فبندٌ بِيع بالأساس يُرجَع كما كان حرفياً، والحبّة من بند كرتون تُطلب بلا وحدة.
 */
export interface CreditLineRequest {
  invoiceItemId: string;
  qty: number;
  unitId?: string | null;
}

export type CreditLinesRequest = 'FULL' | readonly CreditLineRequest[];

export interface ResolvedCreditLine extends CreditableLine {
  /** الكمية المطلوب إرجاعها في هذا الإشعار — **بوحدة الإشعار** (كما تُطبع وتدخل الـXML). */
  creditQty: number;
  /** الكمية نفسها بالأساس — ما يُنقص المتاح ويعود إلى مخزون السيارة. */
  creditBase: number;
  /** لقطة وحدة بند الإشعار (null = وحدة الأساس) ومعاملها ورمزها الضريبي. */
  creditUnitName: string | null;
  creditUnitFactor: number;
  creditUnitCode: string;
  /** سعر وحدة الإشعار: سعر البند نفسه بوحدته، وإلا حصّته من قيمة البند بفرق تراكميّ (creditUnitPriceOf). */
  creditUnitPrice: number;
}

const lineIssue = (field: string, messageAr: string): ZatcaIssue => ({ rule: 'CREDIT-LINE', field, messageAr, severity: 'error' });

/** وحدة الإرجاع بعد الحلّ — `sameAsLine` يعني وحدة البند المباع نفسها: سعرها ورمزها من البند كما صدر. */
interface CreditUnit {
  name: string | null;
  factor: number;
  code: string;
  sameAsLine: boolean;
}

const lineUnitOf = (l: CreditableLine): CreditUnit => ({ name: l.unitName, factor: l.unitFactor, code: l.unitCode, sameAsLine: true });

/**
 * وحدة الإرجاع المطلوبة على بندٍ بعينه. الخادم يحلّها من وحدات الصنف بمعرّفها ولا يثق بمعاملٍ يرسله العميل.
 *   • وحدةٌ اسمُها اسم وحدة البند ⇒ وحدة البند **بمعامل لقطتها**: ما بيع كرتوناً من ٢٤ يُرجَع كرتوناً من ٢٤ ولو صار
 *     الكرتون اليوم ١٢. والوحدة الموقوفة بعد البيع تبقى صالحةً للإرجاع: الإيقاف يمنع بيعاً جديداً لا ردَّ ما بيع.
 *   • وحدةٌ أخرى من وحدات الصنف ⇒ بمعاملها ورمزها.
 *   • بلا وحدة (أو وحدةٌ لا تخصّ الصنف) ⇒ وحدة الأساس بمعامل ١ — وهي وحدة البند نفسها لكلّ بندٍ بِيع بالأساس.
 */
function creditUnitOf(l: CreditableLine, unitId: string | null | undefined): CreditUnit {
  const u = typeof unitId === 'string' && unitId !== '' ? l.units.find(x => x?.id === unitId) : undefined;
  if (u) {
    if (l.unitName !== null && String(u.name ?? '').trim() === l.unitName) return lineUnitOf(l);
    const factor = factorOf({ unitFactor: u.factor });
    if (factor === l.unitFactor && l.unitFactor === 1) return lineUnitOf(l);
    return { name: String(u.name ?? '').trim() || null, factor, code: phase2UnitCode(u.unitCode), sameAsLine: false };
  }
  if (l.unitFactor === 1) return lineUnitOf(l);
  return { name: null, factor: 1, code: PHASE2_UNIT_CODE, sameAsLine: false };
}

/** أقصى منازل سعر الوحدة المحلول — حدّ amounts.ts نفسه (PRICE_MAX_SCALE). */
const CREDIT_PRICE_MAX_SCALE = 8;

/**
 * سعر وحدة الإشعار حين تختلف عن وحدة البيع (حبّةٌ من بند كرتون): حصّته من قيمة البند بـ`refundAmount` — **فرقُ
 * تراكميَّين مقرَّبين** على أساس البند (r2(qty×price) كما حسبه المحرّك يوم البيع). فأربعٌ وعشرون حبّةً في
 * أربعةٍ وعشرين إشعاراً تساوي قيمة الكرتون تماماً (١٠٫٠٠ لا ١٠٫٠٨)، وآخر حبّةٍ تأخذ الباقي. ثمّ يُختار أقصرُ سعرٍ
 * (منزلتان فصاعداً) يعيد الحصّة نفسها بضربه في الكمية، فيطابق المحرّكُ والـXML الحصّةَ بلا انحراف.
 *
 * الخصم والضريبة يُحسبان فوق الحصّة لكلّ إشعارٍ بالمحرّك نفسه، فيبقى انحرافُ مجموع الإشعارات انحرافَ تقريبٍ
 * يغطّيه سماح حارس القيمة (هللة لكلّ سلّة نسبة لكلّ إشعار) — كما في كلّ مرتجعٍ جزئيّ قبل الميزة.
 */
export function creditUnitPriceOf(
  l: Pick<CreditableLine, 'lineQty' | 'unitPrice' | 'unitFactor'>, creditQty: number, creditBase: number, doneBase: number,
): number {
  const gross = roundDecimal(Number(l.lineQty) * Number(l.unitPrice), 2);
  const share = refundAmount({ lineTotal: gross, qty: l.lineQty, unitFactor: l.unitFactor }, creditBase, doneBase);
  const q = Number(creditQty);
  if (!(q > 0)) return 0;
  for (let scale = 2; scale <= CREDIT_PRICE_MAX_SCALE; scale++) {
    const p = roundDecimal(share / q, scale);
    if (roundDecimal(q * p, 2) === share) return p;
  }
  return share / q;
}

/** بند إشعارٍ محلول: الكمية بوحدتها وبالأساس، وسعره من البند نفسه أو من حصّته التراكمية. */
function creditLineOf(l: CreditableLine, unit: CreditUnit, creditQty: number, doneBase: number): ResolvedCreditLine {
  const creditBase = roundQty(toBase(creditQty, { unitFactor: unit.factor }));
  return {
    ...l,
    creditQty,
    creditBase,
    creditUnitName: unit.name,
    creditUnitFactor: unit.factor,
    creditUnitCode: unit.code,
    // وحدة البند نفسها ⇒ سعره كما صدر (سلوك ما قبل الميزة حرفياً)؛ وحدةٌ أخرى ⇒ حصّةٌ تراكمية لا سعر الكرتون للحبّة
    creditUnitPrice: unit.sameAsLine ? l.unitPrice : creditUnitPriceOf(l, creditQty, creditBase, doneBase),
  };
}

/** ما أُرجع من البند قبل هذا الإشعار، بالأساس — موضع البداية في تسعير الحصص التراكمية. */
const doneBaseOf = (l: CreditableLine): number => roundQty(Math.max(0, l.soldBase - l.returnableBase));

/**
 * 'FULL' لبندٍ: كلّ المتاح. بوحدة البند حين يكون المتاح وحداتٍ كاملةً منها (أو البند بالأساس، أو لم يُرجَع منه شيء)
 * — فالإلغاء الكامل لبيعٍ قائم يعكس بنوده حرفاً بحرف. وإلا (بقي ٤٥ حبّة من كرتونين بعد إرجاع ٣) فبوحدة الأساس:
 * كسرُ كرتونٍ لا يدخل مستنداً ضريبياً.
 */
function fullCreditLine(l: CreditableLine): ResolvedCreditLine {
  const done = doneBaseOf(l);
  if (l.unitFactor === 1) return creditLineOf(l, lineUnitOf(l), l.returnableBase, done);
  if (done <= QTY_EPSILON) return creditLineOf(l, lineUnitOf(l), l.lineQty, done);
  const whole = Math.round(l.returnableBase / l.unitFactor);
  if (whole > 0 && Math.abs(whole * l.unitFactor - l.returnableBase) <= QTY_EPSILON) return creditLineOf(l, lineUnitOf(l), whole, done);
  return creditLineOf(l, { name: null, factor: 1, code: PHASE2_UNIT_CODE, sameAsLine: false }, l.returnableBase, done);
}

/** هل يمسّ البندُ الوحداتِ المتعددة؟ وإلا تبقى رسالة التجاوز بأرقامها القديمة حرفياً. */
const isMultiUnit = (l: CreditableLine, units: readonly CreditUnit[]): boolean =>
  l.unitFactor !== 1 || l.units.length > 0 || units.some(u => u.factor !== 1);

/** كمية بالأساس كما يقرؤها المندوب: «١ كرتون و٣ حبة». */
function qtyText(base: number, l: CreditableLine): string {
  return formatQty(base, l.units.map(u => ({ name: u.name, factor: Number(u.factor), isActive: u.isActive })), l.baseUnitName ?? '').trim();
}

/**
 * الطلب ⇒ بنود الإشعار، أو يرمي ZatcaHttpError:
 *   • 'FULL' = كل المتاح (إلغاءٌ كاملٌ بعد الربط — D4). لا متاح ⇒ 409 ZATCA_NOTHING_TO_CREDIT.
 *   • قائمة: كل بند من بنود الأصل، بلا تكرار، بكمية موجبة ⇒ وإلا 422 ZATCA_NOTE_LINES_INVALID بأسماء الحقول.
 *   • كمية تتجاوز المتاح ⇒ 422 ZATCA_CREDIT_QTY_EXCEEDED بالصنف والمتاح (كل البنود المخالفة معاً لا أوّلها).
 * الترتيب دائماً ترتيب المستند الأصلي (لا ترتيب الطلب): البنود المتقابلة تُقرأ بمحاذاة الأصل.
 *
 * الوحدات المتعددة: الكمية المطلوبة بوحدتها (`unitId`) تُحوَّل إلى الأساس وتُقارَن بالمتاح بالأساس. والبند الواحد قد
 * يُطلب بوحدتين («١ كرتون و٣ حبة» = سطران)، والمكرَّر بالوحدة نفسها يبقى مرفوضاً كما كان.
 */
export function resolveCreditLines(lines: readonly CreditableLine[], request: CreditLinesRequest): ResolvedCreditLine[] {
  if (request === 'FULL') {
    const full = lines.filter(l => l.returnableBase > QTY_EPSILON).map(fullCreditLine);
    if (!full.length) throw noteRefusalError('NOTHING_TO_CREDIT') as ZatcaHttpError;
    return full;
  }
  if (!Array.isArray(request) || request.length === 0) {
    throw noteLinesError([lineIssue('lines', 'لم تُحدَّد بنود الإشعار')]);
  }
  const byId = new Map(lines.map(l => [l.invoiceItemId, l]));
  const issues: ZatcaIssue[] = [];
  const seen = new Set<string>();
  const wanted = new Map<string, { unit: CreditUnit; qty: number }[]>();
  request.forEach((r, i) => {
    const id = typeof r?.invoiceItemId === 'string' ? r.invoiceItemId : '';
    const q = Number(r?.qty);
    const l = byId.get(id);
    if (!l) {
      issues.push(lineIssue(`lines[${i}].invoiceItemId`, `البند ${i + 1} ليس من بنود الفاتورة الأصلية`));
      return;
    }
    const unit = creditUnitOf(l, r?.unitId);
    const key = `${id}\u0000${unit.factor}\u0000${unit.name ?? ''}`;
    if (seen.has(key)) {
      issues.push(lineIssue(`lines[${i}].invoiceItemId`, `البند «${l.itemName || i + 1}» مكرَّر في الطلب — اجمع كميّته في سطر واحد`));
      return;
    }
    seen.add(key);
    if (!Number.isFinite(q) || q <= 0) {
      issues.push(lineIssue(`lines[${i}].qty`, `كمية البند «${l.itemName || i + 1}» يجب أن تكون أكبر من صفر`));
      return;
    }
    const list = wanted.get(id) ?? [];
    list.push({ unit, qty: roundQty(q) });
    wanted.set(id, list);
  });
  if (issues.length) throw noteLinesError(issues);

  const over: { itemName: string; requested: number; available: number; requestedText?: string; availableText?: string }[] = [];
  for (const [id, list] of wanted) {
    const l = byId.get(id)!;
    const wantBase = roundQty(list.reduce((s, w) => s + toBase(w.qty, { unitFactor: w.unit.factor }), 0));
    if (wantBase <= l.returnableBase + QTY_EPSILON) continue;
    if (!isMultiUnit(l, list.map(w => w.unit))) {
      over.push({ itemName: l.itemName || id, requested: list[0].qty, available: l.returnable });
    } else {
      over.push({
        itemName: l.itemName || id, requested: wantBase, available: l.returnableBase,
        requestedText: qtyText(wantBase, l), availableText: qtyText(l.returnableBase, l),
      });
    }
  }
  if (over.length) throw creditQtyExceededError(over);

  const out: ResolvedCreditLine[] = [];
  for (const l of lines) {
    const list = wanted.get(l.invoiceItemId);
    if (!list) continue;
    // موضع كلّ سطرٍ في البند بعد ما سبقه — سطران من البند نفسه لا يُسعَّران من الموضع نفسه
    let done = doneBaseOf(l);
    for (const w of list) {
      const line = creditLineOf(l, w.unit, w.qty, done);
      done = roundQty(done + line.creditBase);
      out.push(line);
    }
  }
  if (!out.length) throw noteRefusalError('NOTHING_TO_CREDIT') as ZatcaHttpError;
  return out;
}

/** نطاق الإشعار الدائن كما تقيسه الصلاحية (Q5): كاملٌ = بديل الإلغاء، جزئيّ = مرتجعٌ عاديّ. */
export type CreditScope = 'FULL' | 'PARTIAL';

/**
 * Q5 يحرس **الأثر** لا صيغة الطلب (مراجعة «تراجع»): `lines:'FULL'` وقائمةٌ تعدّ كلّ البنود بكامل المتاح ينتجان
 * المستند نفسه وأثر الإلغاء نفسه. فالنطاق كاملٌ حين — وحين فقط — لم يُرجَع من الفاتورة شيءٌ قبل هذا الإشعار ولم
 * يبقَ بعده ما يُرجَع. وإتمامُ فاتورةٍ أُرجع بعضها سابقاً يبقى جزئياً: ليس إلغاءً لبيعٍ قائم.
 *
 * بالأساس: إرجاعُ كرتونين حبّةً حبّة (٤٨ سطراً بالأساس) إلغاءٌ كامل كإرجاعهما كرتونين — وخلطُ الوحدات هنا كان
 * يمنح الإلغاء الكامل لمن لا يملك صلاحيته أو يحجبه عن غيره.
 */
export function effectiveCreditScope(lines: readonly CreditableLine[], resolved: readonly ResolvedCreditLine[]): CreditScope {
  const wanted = new Map<string, number>();
  for (const r of resolved) wanted.set(r.invoiceItemId, (wanted.get(r.invoiceItemId) ?? 0) + r.creditBase);
  let before = 0;
  let left = 0;
  for (const l of lines) {
    before += l.creditedBase + l.legacyCreditedBase;
    left += Math.max(0, l.returnableBase - (wanted.get(l.invoiceItemId) ?? 0));
  }
  return before <= QTY_EPSILON && left <= QTY_EPSILON ? 'FULL' : 'PARTIAL';
}

// ─── حارس القيمة على مستوى الفاتورة ───

/** مجموع قيمة الإشعارات الملتزَمة السابقة. */
export function creditedTotalOf(priorNotes: readonly PriorNote[]): number {
  return roundDecimal(priorNotes.filter(countsTowardCredit).reduce((s, n) => s + Number(n.total || 0), 0), 2);
}

/**
 * سماح التقريب: البنود منسوخة من الأصل والكميات محروسة، فلا يزيد مجموع الإشعارات على الأصل إلا بهللات التقريب —
 * هللة لكل سلّة نسبة ضريبية في الإشعار، ولكل إشعار سابق نصيبه. أوسع من ذلك خللٌ لا تقريب.
 */
export function creditAmountTolerance(bucketCount: number, noteCount: number): number {
  const buckets = Math.max(1, Math.trunc(bucketCount) || 1);
  const notes = Math.max(1, Math.trunc(noteCount) || 1);
  return roundDecimal(0.01 * buckets * notes, 2);
}

/** عدد سلال النسب الضريبية في بنود الإشعار (وعاء التقريب في amounts.ts). */
export function taxBucketCount(lines: readonly { taxPct: number }[]): number {
  return new Set(lines.map(l => Number(l.taxPct || 0))).size;
}

/**
 * شبكة الأمان: مجموع (المُرتجع سابقاً + هذا الإشعار) لا يتجاوز إجمالي الأصل زائدَ سماح التقريب. يرمي 422 وإلا يصمت.
 */
export function assertCreditAmount(input: {
  original: Pick<NoteOriginalInvoice, 'total'>;
  priorNotes: readonly PriorNote[];
  noteTotal: number;
  bucketCount: number;
}): void {
  const already = creditedTotalOf(input.priorNotes);
  const notes = input.priorNotes.filter(countsTowardCredit).length + 1;
  const tolerance = creditAmountTolerance(input.bucketCount, notes);
  const originalTotal = roundDecimal(Number(input.original.total || 0), 2);
  if (roundDecimal(already + Number(input.noteTotal || 0), 2) > roundDecimal(originalTotal + tolerance, 2)) {
    throw creditAmountExceededError({ noteTotal: input.noteTotal, alreadyCredited: already, originalTotal });
  }
}

// ─── هوية المشتري لا تنحرف عن الأصل ───

const partyId = (p: UblParty | null | undefined): { vat: string | null; other: string | null } => ({
  vat: typeof p?.vatNumber === 'string' && p.vatNumber !== '' ? p.vatNumber : null,
  other: p?.otherId && p.otherId.value ? `${p.otherId.scheme}:${p.otherId.value}` : null,
});

/**
 * الإشعار يشير إلى فاتورةٍ بعينها، فمشتريه هو مشتريها. بطاقة العميل قد تكون عُدِّلت بعد البيع: **تغيّر** الرقم الضريبي أو
 * المعرّف الآخر (لا إضافتهما ولا حذفهما) يعني إشعاراً باسم مشترٍ غير الذي على الفاتورة ⇒ يُمنع. الفحص يجري فقط حين
 * يمرّر المسار لقطة مشتري الأصل (einvoiceSnapshot.customer).
 */
export function buyerIdentityDrift(before: UblParty | null | undefined, after: UblParty | null | undefined): ZatcaIssue[] {
  if (!before || !after) return [];
  const a = partyId(before);
  const b = partyId(after);
  const out: ZatcaIssue[] = [];
  if (a.vat && b.vat && a.vat !== b.vat) {
    out.push({
      rule: 'CREDIT-BUYER', field: 'customer.taxNumber', severity: 'error',
      messageAr: `الرقم الضريبي للعميل تغيّر بعد إصدار الفاتورة (${a.vat} ⇐ ${b.vat}) — الإشعار يجب أن يحمل بيانات مشتري الفاتورة نفسها`,
    });
  }
  if (a.other && b.other && a.other !== b.other) {
    out.push({
      rule: 'CREDIT-BUYER', field: 'customer.buyerIdValue', severity: 'error',
      messageAr: 'معرّف العميل (السجل التجاري/الهوية) تغيّر بعد إصدار الفاتورة — الإشعار يجب أن يحمل بيانات مشتري الفاتورة نفسها',
    });
  }
  return out;
}

// ─── بناء الإشعار (التحضير قبل القفل) ───

/** رابط الإشعار بأصله كما يُكتب في صفّ الفاتورة. */
export interface NoteLink {
  originalInvoiceId: string;
  billingReference: string;
  noteReason: string;
}

export interface PreparedNote {
  kind: NoteKind;
  prepared: PreparedIssuance;
  /** ناتج المحرّك (أعمدة البنود القديمة تُكتب منه). */
  engine: CalcResult;
  /** بنود الإشعار بترتيب المستند مع كمياتها وروابطها بالأصل. */
  lines: readonly ResolvedCreditLine[];
  /** بنود الأصل بالمتاح منها لحظة التحضير (منها يُقاس نطاق Q5) — فارغة للمدين. */
  creditable: readonly CreditableLine[];
  link: NoteLink;
  /** قيمة الإشعارات الملتزَمة السابقة (للعرض والتدقيق). */
  creditedBefore: number;
}

/** سبب الإشعار (KSA-10): نصّ إلزاميّ 3..1000 — الفحص المسبق يرفض الفارغ والأطول. */
export const NOTE_REASON_MIN = 3;
export const NOTE_REASON_MAX = 1000;

export function normalizeNoteReason(reason: string | null | undefined): string {
  return typeof reason === 'string' ? reason.trim() : '';
}

function assertReason(reason: string): string {
  const r = normalizeNoteReason(reason);
  if (r.length < NOTE_REASON_MIN || r.length > NOTE_REASON_MAX) {
    throw noteLinesError([lineIssue('reason', `سبب الإشعار مطلوب (من ${NOTE_REASON_MIN} إلى ${NOTE_REASON_MAX} حرفاً)`)]);
  }
  return r;
}

/** الطلب المصطنع الذي يمرّره الإشعار لنواة الإصدار: لغة المبالغ من الأصل، والبنود تأتي عبر `lines`. */
function noteRequest(original: NoteOriginalInvoice, kind: NoteKind): IssuanceRequest {
  return {
    type: original.type,
    paymentPlan: original.paymentPlan ?? null,
    pricesIncludeTax: original.pricesIncludeTax === true,
    // الدائن يرث خصم الفاتورة الكلّي (فيحمل الجزئيُّ حصّته منه)؛ والمدين زيادةٌ مستقلّة لا خصم عليها
    discountPct: kind === 'CREDIT_NOTE' ? Number(original.discountPct || 0) : 0,
    items: [],
    supplyDate: null,
  };
}

function noteContext(eligibility: NoteEligible, reason: string): IssuanceNoteContext {
  return {
    originalNumber: eligibility.billingReference,
    originalSubtype: eligibility.subtype,
    originalPaymentType: eligibility.paymentType,
    reason,
  };
}

export interface PrepareNoteBase {
  settings: IssuanceSellerSettings;
  customer: IssuanceCustomer;
  original: NoteOriginalInvoice;
  eligibility: NoteEligible;
  reason: string;
  companyVat: number;
  now: Date;
  /** خانات العملة (SAR = 2) — نفسها التي مُرِّرت للمحرّك في الفاتورة. */
  decimals?: number;
  qrMaxLength?: number;
  newUuid?: () => string;
  /** لقطة مشتري الأصل (einvoiceSnapshot.customer) — تُفعِّل حارس انحراف الهوية. */
  originalBuyer?: UblParty | null;
}

export interface PrepareCreditNoteInput extends PrepareNoteBase {
  priorNotes: readonly PriorNote[];
  /** مرتجعات ما قبل الربط لعميل الأصل (أصلٌ من المرحلة الأولى وحده) — تُخصم من المتاح بالصنف. */
  legacyReturns?: readonly LegacyReturnQty[];
  request: CreditLinesRequest;
}

/** سطور الـXML: الكمية والسعر والرمز **بوحدة الإشعار** معاً — حبّاتٌ بسعر الحبّة ورمزها، لا حبّاتٌ بسعر الكرتون. */
function lineSourcesOf(lines: readonly ResolvedCreditLine[]): LineSource[] {
  return lines.map(l => ({
    itemName: l.itemName,
    unitCode: l.creditUnitCode,
    qty: l.creditQty,
    unitPrice: l.creditUnitPrice,
    discountPct: l.discountPct,
    taxPct: l.taxPct,
    vatCategory: l.vatCategory,
    vatExemptionCode: l.vatExemptionCode,
    vatExemptionReason: l.vatExemptionReason,
  }));
}

function engineOf(lines: readonly { qty: number; unitPrice: number; discountPct: number; taxPct: number }[], request: IssuanceRequest, companyVat: number, decimals: number): CalcResult {
  return computeInvoiceTotals(
    lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct })),
    { companyVat, decimals, invoiceDiscountPct: request.discountPct ?? 0, pricesIncludeTax: request.pricesIncludeTax },
  );
}

function prepareNoteCommon(input: PrepareNoteBase & { kind: NoteKind; lines: LineSource[]; engine: CalcResult; reasonText: string }): PreparedIssuance {
  const prepared = prepareIssuance({
    settings: input.settings,
    customer: input.customer,
    products: [],
    request: noteRequest(input.original, input.kind),
    lines: input.lines,
    companyVat: input.companyVat,
    engine: input.engine,
    now: input.now,
    kind: input.kind,
    note: noteContext(input.eligibility, input.reasonText),
    ...(input.qrMaxLength !== undefined ? { qrMaxLength: input.qrMaxLength } : {}),
    ...(input.newUuid ? { newUuid: input.newUuid } : {}),
  });
  if (prepared.subtype !== input.eligibility.subtype) {
    // النوع الفرعي مجمَّد على الأصل — انحرافه يعني خللاً في التركيب لا خطأ مستخدم
    throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'NOTE', code: 'SUBTYPE_DRIFT' } });
  }
  const drift = buyerIdentityDrift(input.originalBuyer, mapBuyerParty(prepared.src.buyer, prepared.subtype));
  if (drift.length) throw preflightHttpError(drift) as ZatcaHttpError;
  return prepared;
}

/**
 * الإشعار الدائن: بنود الأصل المطلوبة ⇒ حارس الكمية ⇒ المحرّك ⇒ حارس القيمة ⇒ نواة الإصدار نفسها (D2، D9، الفحص المسبق،
 * مبالغ D6). كل رفض هنا **قبل** أيّ قفل أو ICV. يرمي ZatcaHttpError فقط.
 */
export function prepareCreditNote(input: PrepareCreditNoteInput): PreparedNote {
  const reason = assertReason(input.reason);
  const creditable = creditableLines(input.original, input.priorNotes, input.legacyReturns ?? []);
  if (!hasCreditableQty(creditable)) throw noteRefusalError('NOTHING_TO_CREDIT') as ZatcaHttpError;
  const lines = resolveCreditLines(creditable, input.request);
  const request = noteRequest(input.original, 'CREDIT_NOTE');
  const engine = engineOf(lines.map(l => ({ qty: l.creditQty, unitPrice: l.creditUnitPrice, discountPct: l.discountPct, taxPct: l.taxPct })), request, input.companyVat, input.decimals ?? 2);
  assertCreditAmount({ original: input.original, priorNotes: input.priorNotes, noteTotal: engine.total, bucketCount: taxBucketCount(lines) });
  const prepared = prepareNoteCommon({ ...input, kind: 'CREDIT_NOTE', lines: lineSourcesOf(lines), engine, reasonText: reason });
  return {
    kind: 'CREDIT_NOTE',
    prepared,
    engine,
    lines,
    creditable,
    link: { originalInvoiceId: input.original.id, billingReference: input.eligibility.billingReference, noteReason: reason },
    creditedBefore: creditedTotalOf(input.priorNotes),
  };
}

/** بند الإشعار المدين: وصفٌ حرّ لا يخصم من مخزون ولا يرتبط ببند أصل (productId يبقى null في الصفّ). */
export interface DebitNoteLineInput {
  description: string;
  qty: number;
  unitPrice: number;
  taxPct: number;
  vatCategory?: string | null;
  vatExemptionCode?: string | null;
  vatExemptionReason?: string | null;
}

export interface PrepareDebitNoteInput extends PrepareNoteBase {
  lines: readonly DebitNoteLineInput[];
}

/**
 * الإشعار المدين (383): زيادةٌ على فاتورةٍ صدرت (فرق سعر، بند سقط). بنوده حرّة ولا كميّة تُحرس، ولا يمسّ المخزون
 * (productId = null) — فقيوده قيود فاتورة آجلة (postInvoiceEntries) كما في الخطة.
 */
export function prepareDebitNote(input: PrepareDebitNoteInput): PreparedNote {
  const reason = assertReason(input.reason);
  const issues: ZatcaIssue[] = [];
  if (!Array.isArray(input.lines) || input.lines.length === 0) issues.push(lineIssue('lines', 'لم تُحدَّد بنود الإشعار'));
  const lines: LineSource[] = (input.lines ?? []).map((l, i) => {
    const name = typeof l?.description === 'string' ? l.description.trim() : '';
    if (name === '') issues.push(lineIssue(`lines[${i}].description`, `وصف البند ${i + 1} مطلوب`));
    if (!Number.isFinite(Number(l?.qty)) || Number(l.qty) <= 0) issues.push(lineIssue(`lines[${i}].qty`, `كمية البند ${i + 1} يجب أن تكون أكبر من صفر`));
    if (!Number.isFinite(Number(l?.unitPrice)) || Number(l.unitPrice) <= 0) issues.push(lineIssue(`lines[${i}].unitPrice`, `سعر البند ${i + 1} يجب أن يكون أكبر من صفر`));
    return {
      itemName: name,
      unitCode: PHASE2_UNIT_CODE,
      qty: Number(l?.qty),
      unitPrice: Number(l?.unitPrice),
      discountPct: 0,
      taxPct: Number(l?.taxPct ?? input.companyVat),
      vatCategory: l?.vatCategory ?? null,
      vatExemptionCode: l?.vatExemptionCode ?? null,
      vatExemptionReason: l?.vatExemptionReason ?? null,
    };
  });
  if (issues.length) throw noteLinesError(issues);
  const request = noteRequest(input.original, 'DEBIT_NOTE');
  const engine = engineOf(lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: 0, taxPct: l.taxPct })), request, input.companyVat, input.decimals ?? 2);
  const prepared = prepareNoteCommon({ ...input, kind: 'DEBIT_NOTE', lines, engine, reasonText: reason });
  return {
    kind: 'DEBIT_NOTE',
    prepared,
    engine,
    lines: [],
    creditable: [],
    link: { originalInvoiceId: input.original.id, billingReference: input.eligibility.billingReference, noteReason: reason },
    creditedBefore: 0,
  };
}

// ─── الختم على السلسلة نفسها ───

/** بادئة رقم الإشعار: الدائن مرتجع (RET) والمدين فاتورة (INV) — كما يميّزهما عمود `type`. */
export function noteNumberPrefix(kind: NoteKind, issuedAt: Date): string {
  return phase2NumberPrefix(kind === 'CREDIT_NOTE' ? 'RET' : 'INV', issuedAt);
}

export interface StampNoteInput<Tx> {
  tenantId: string;
  prepared: PreparedIssuance;
  signing: IssuanceSigning;
  sellerVat?: string | null;
  attemptNo?: number;
  hooks: StampInTxHooks<Tx>;
}

/**
 * يختم الإشعار داخل معاملة قائمة بنفس طريق الفاتورة (stampInTx): قفل الوحدة ⇒ الرقم داخل القفل ⇒ اللحظة ⇒ التحويل والفحص
 * ⇒ الختم ⇒ صفّ الإشعار ⇒ المستند SIGNED ⇒ تقدّم السلسلة (CAS) ⇒ قيود الدفتر. فالإشعار حلقةٌ في سلسلة الوحدة نفسها
 * (ICV/PIH متّصلان) لا سلسلةً ثانية. ويحرس ما لا يجوز أن يصل الختم أصلاً: نوعٌ ليس إشعاراً، أو مرجعٌ أو سببٌ مفقود.
 */
export async function stampNoteInTx<Tx>(tx: Tx, deps: StampInTxDeps<Tx>, input: StampNoteInput<Tx>): Promise<StampInTxResult> {
  const p = input.prepared;
  if (!isNoteKind(p.kind)) throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'NOTE', code: 'NOT_A_NOTE' } });
  const refs = (p.src.billingReferences ?? []).filter(r => typeof r === 'string' && r.trim() !== '');
  if (!refs.length) throw noteRefusalError('NO_REFERENCE') as ZatcaHttpError;
  if (normalizeNoteReason(p.src.noteReason) === '') throw noteLinesError([lineIssue('reason', 'سبب الإشعار مطلوب')]);
  return stampInTx(tx, deps, {
    tenantId: input.tenantId,
    prepared: p,
    signing: input.signing,
    ...(input.sellerVat !== undefined ? { sellerVat: input.sellerVat } : {}),
    ...(input.attemptNo !== undefined ? { attemptNo: input.attemptNo } : {}),
    hooks: input.hooks,
  });
}

// ─── أعمدة صفّ الإشعار ───

/** أعمدة المرحلة الثانية للفاتورة + رابط الأصل (BT-25 وKSA-10 كما كُتبا في المستند). */
export function noteInvoiceColumns(record: IssuedInvoiceRecord, link: NoteLink) {
  return {
    ...phase2InvoiceColumns(record),
    originalInvoiceId: link.originalInvoiceId,
    billingReference: link.billingReference,
    noteReason: link.noteReason,
  };
}

/** أعمدة بند الإشعار: لقطة المرحلة الثانية + ربط البند بأصله (InvoiceItem.creditedItemId). */
export function noteItemColumns(item: IssuanceItemSnapshot, creditedItemId: string | null) {
  return { ...phase2ItemColumns(item), creditedItemId };
}

/**
 * الأعمدة القديمة لصفّ الإشعار الدائن — صفُّ مرتجعٍ كما يكتبه المسار القديم حرفاً بحرف (type/returnReason/returnToStock
 * وpaidAmt/remainingAmt صفران)، فمخزون السيارة والتقارير تقرؤه كما تقرأ أيّ مرتجع بلا تغيير.
 */
export function creditNoteLegacyColumns(o: { reasonCode?: string | null; returnToStock: boolean }) {
  return {
    type: 'RETURN' as const,
    returnReason: o.reasonCode && o.reasonCode !== '' ? o.reasonCode : 'NORMAL',
    returnToStock: o.returnToStock,
    paidAmt: 0,
    remainingAmt: 0,
  };
}

/** الأعمدة القديمة لصفّ الإشعار المدين: فاتورة آجلة بلا تحصيل (قيودها postInvoiceEntries). */
export function debitNoteLegacyColumns(total: number) {
  return { type: 'CREDIT' as const, paidAmt: 0, remainingAmt: roundDecimal(Number(total || 0), 2) };
}

/**
 * عودة كميّات الإشعار لمخزون السيارة — قاعدة المسار القديم نفسها (invoices.ts): الصريح يغلب، والتالف يعود فقط إن سمحت
 * **كلّ** أصناف الإشعار، وغير التالف يعود افتراضاً.
 */
export function resolveReturnToStock(
  requested: boolean | null | undefined, reasonCode: string | null | undefined, lines: readonly { damagedReturnToStock: boolean | null }[],
): boolean {
  if (typeof requested === 'boolean') return requested;
  if (reasonCode !== 'DAMAGED') return true;
  return lines.length > 0 && lines.every(l => l.damagedReturnToStock === true);
}

// ─── أثر الإشعار على متبقّي الأصل (F1) ───

export interface RemainingAdjustment {
  /** ما يُنقص من `remainingAmt` — يُكتب **فرقاً نسبياً** (decrement) لا قيمةً مطلقة (نقد 13). */
  decrement: number;
  /** ما فاض عن المتبقّي فصار رصيداً دائناً للعميل (قيده postReturnEntries). */
  customerCredit: number;
  /** المتبقّي المتوقَّع بعد الإشعار (للعرض والتحقق — لا يُكتب مطلقاً). */
  remainingAfter: number;
}

/**
 * F1 (المرحلة الثانية وحدها): إشعارٌ دائن يُطفئ من متبقّي الأصل بقدره ولا ينزل به تحت الصفر، وما فاض يبقى رصيداً دائناً
 * للعميل. والفاتورة النقدية متبقّيها صفر أصلاً ⇒ كلّ الإشعار رصيدٌ دائن مرّةً واحدة (وQ1 محروسٌ بمنع الإشعار على فاتورةٍ
 * أُبطلت فتركت رصيداً من قبل).
 */
export function remainingAfterCreditNote(original: Pick<NoteOriginalInvoice, 'remainingAmt'>, noteTotal: number): RemainingAdjustment {
  const remaining = roundDecimal(Math.max(0, Number(original.remainingAmt || 0)), 2);
  const total = roundDecimal(Math.max(0, Number(noteTotal || 0)), 2);
  const decrement = roundDecimal(Math.min(total, remaining), 2);
  return { decrement, customerCredit: roundDecimal(total - decrement, 2), remainingAfter: roundDecimal(remaining - decrement, 2) };
}
