/**
 * «سجلّ العميل» الثابت (طلب المالك ٢٦ نوفمبر ٢٠٢٦): «السجل الزمني يستعرض كل إجراء أو عمل يتمّ مع هذا العميل… من قبل أي شخص
 * كان سواء مندوب أو إداري… ولا يمكن لأحد تغيير أي شيء فيه نهائياً».
 *
 * منطق العرض الصرف بلا React (فيُختبر وحده): أسماء الإجراءات وأقسامها وأدوار المنفّذين وأسماء حقول التعديل وتجميع الأيام.
 * الواجهة: components/customerActivity/ActivityTimeline.tsx (أرشيف العميل في اللوحة، وأيقونة السجلّ في تطبيق المندوب)،
 * والبيانات من GET /customers/:id/activity (backend/src/routes/customerActivity.ts) — قراءةٌ وحدها: لا مسار لتعديله أو حذفه.
 * كل نصٍّ عربيٍّ هنا مفتاحٌ يمرّ بـtr في الواجهة.
 */
import { OBJECTIONS, OUTCOME_LABEL, OUTLET_TYPE_OPTIONS } from '../rep/aiRepLogic';
import { activeLocale, formatCurrency } from '../utils/format';
import { formatCustomerNumber } from './customerNumber';
import { BUYER_ID_SCHEME_LABELS_AR, BUYER_TYPE_LABELS_AR } from './zatca/buyerForm';

// ═══ العقد مع الخادم (مرآة backend/src/services/customerActivity.ts) ═══

export type ActivityActorKind = 'ADMIN' | 'REP' | 'OWNER' | 'STAFF' | 'API' | 'CUSTOMER' | 'SYSTEM';

/*
 * إجراءات جولة الإصلاح (٢٦ نوفمبر ٢٠٢٦): عكس دفع البطاقة وتعليقها للمراجعة واسترداد رابط الدفع (مالٌ تحرّك فعلاً لا «محاولة لم
 * تكتمل» ولا «إلغاء رابط»)، والحذف النهائي للفاتورة والسند، وترحيل قيد اليومية وعكسه على حساب العميل، ونتيجة زيارة المندوب الذكي
 */
export const CUSTOMER_ACTIONS = [
  'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_DELETED', 'CUSTOMER_IMPORTED', 'CUSTOMER_STATUS_CHANGED', 'CUSTOMER_LOCATION_SET',
  'CUSTOMER_ASSIGNED', 'CUSTOMER_UNASSIGNED', 'CUSTOMER_PRICE_SET', 'CUSTOMER_PRICE_REMOVED', 'CUSTOMER_PRICE_LIST_CHANGED', 'CUSTOMER_TAX_DATA_UPDATED',
  'INVOICE_ISSUED', 'RETURN_ISSUED', 'CREDIT_NOTE_ISSUED', 'DEBIT_NOTE_ISSUED', 'INVOICE_CANCELLED', 'INVOICE_VOIDED', 'INVOICE_EXPIRED',
  'INVOICE_REISSUED', 'INVOICE_REASSIGNED', 'INVOICE_PAID', 'INVOICE_UPDATED', 'INVOICE_DELETED',
  'RECEIPT_ISSUED', 'RECEIPT_CANCELLED', 'RECEIPT_REASSIGNED', 'RECEIPT_DELETED', 'ADJUSTMENT_CREATED', 'ADJUSTMENT_UPDATED', 'OPENING_BALANCE_SET',
  'LEDGER_JOURNAL_POSTED', 'LEDGER_JOURNAL_REVERSED',
  'PAYLINK_CREATED', 'PAYLINK_PAID', 'PAYLINK_CANCELLED', 'PAYLINK_EXPIRED', 'PAYLINK_REFUNDED',
  'CARD_PAYMENT_COMPLETED', 'CARD_PAYMENT_FAILED', 'CARD_PAYMENT_REVERSED', 'CARD_PAYMENT_HELD',
  'VISIT_RECORDED', 'VISIT_DELETED', 'VISIT_REASSIGNED', 'DOCUMENT_ADDED', 'DOCUMENT_REMOVED', 'ROUTE_STOP_ADDED', 'ROUTE_STOP_REMOVED',
  'CALL_LOGGED', 'SMART_REP_OUTCOME', 'CATALOG_ORDER_PLACED', 'CATALOG_ORDER_UPDATED', 'OTHER',
] as const;
export type CustomerActivityAction = typeof CUSTOMER_ACTIONS[number];

/** أقسام الفرز — بالترتيب الذي تظهر به أزرارها ('all' = الكل) */
export const ACTIVITY_CATEGORIES = ['visits', 'sales', 'returns', 'money', 'docs', 'edits', 'other'] as const;
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number];
export const ACTIVITY_FILTERS = ['all', ...ACTIVITY_CATEGORIES] as const;
export type ActivityFilter = typeof ACTIVITY_FILTERS[number];

/**
 * بندٌ من السجلّ كما يصل من الخادم — historical: مشتقٌّ من الجداول القائمة لِما سبق بدء السجلّ الثابت.
 * actor.id حاضرٌ متى أرسله الخادم (المندوب والإداري) — به يُرشَّح «من نفّذ» بلا خلطٍ بين اسمين متطابقين
 */
export interface ActivityItem {
  id: string;
  at: string;
  action: string;
  category: ActivityCategory;
  actor: { kind: string; name: string | null; id?: string | null };
  refType: string | null;
  refId: string | null;
  refNo: string | null;
  amount: number | null;
  data: Record<string, unknown> | null;
  historical: boolean;
}
export interface ActivityPage { items: ActivityItem[]; nextBefore: string | null }

// ═══ أسماء الإجراءات ═══

export const ACTION_LABELS: Record<CustomerActivityAction, string> = {
  CUSTOMER_CREATED: 'إنشاء العميل',
  CUSTOMER_UPDATED: 'تعديل بيانات العميل',
  CUSTOMER_DELETED: 'حذف العميل',
  CUSTOMER_IMPORTED: 'استيراد العميل من ملف',
  CUSTOMER_STATUS_CHANGED: 'تغيير حالة العميل',
  CUSTOMER_LOCATION_SET: 'تحديد موقع العميل',
  CUSTOMER_ASSIGNED: 'إسناد العميل إلى مندوب',
  CUSTOMER_UNASSIGNED: 'إلغاء إسناد العميل من مندوب',
  CUSTOMER_PRICE_SET: 'تحديد سعر خاص للعميل',
  CUSTOMER_PRICE_REMOVED: 'إلغاء سعر خاص للعميل',
  CUSTOMER_PRICE_LIST_CHANGED: 'تغيير قائمة أسعار العميل',
  CUSTOMER_TAX_DATA_UPDATED: 'تحديث البيانات الضريبية للعميل',
  INVOICE_ISSUED: 'إصدار فاتورة بيع',
  RETURN_ISSUED: 'إصدار فاتورة مرتجع',
  CREDIT_NOTE_ISSUED: 'إصدار إشعار دائن',
  DEBIT_NOTE_ISSUED: 'إصدار إشعار مدين',
  INVOICE_CANCELLED: 'إلغاء فاتورة',
  INVOICE_VOIDED: 'إبطال فاتورة',
  INVOICE_EXPIRED: 'انتهاء صلاحية فاتورة',
  INVOICE_REISSUED: 'إعادة إصدار فاتورة',
  // النقل حدثٌ مجمَّع لكل عميل (عدده في data.count): حذف المندوب يُبقي مستنداته بلا مندوب، وحذف الفريق يفكّ وسمه
  INVOICE_REASSIGNED: 'تغيير مندوب أو فريق فواتير العميل',
  INVOICE_PAID: 'سداد فاتورة',
  INVOICE_UPDATED: 'تعديل فاتورة',
  // الحذف النهائي لمالك المنصة (لا حذف للفاتورة أو السند غيره — الإلغاء والإبطال إجراءاتٌ أخرى)
  INVOICE_DELETED: 'حذف فاتورة نهائيا',
  RECEIPT_ISSUED: 'إصدار سند قبض',
  RECEIPT_CANCELLED: 'إلغاء سند قبض',
  RECEIPT_REASSIGNED: 'تغيير مندوب أو فريق سندات العميل',
  RECEIPT_DELETED: 'حذف سند قبض نهائيا',
  ADJUSTMENT_CREATED: 'تسوية على حساب العميل',
  ADJUSTMENT_UPDATED: 'تعديل تسوية على حساب العميل',
  OPENING_BALANCE_SET: 'تحديد الرصيد الافتتاحي',
  LEDGER_JOURNAL_POSTED: 'ترحيل قيد يومية على حساب العميل',
  LEDGER_JOURNAL_REVERSED: 'عكس قيد يومية على حساب العميل',
  PAYLINK_CREATED: 'إنشاء رابط دفع',
  PAYLINK_PAID: 'سداد عبر رابط دفع',
  PAYLINK_CANCELLED: 'إلغاء رابط دفع',
  PAYLINK_EXPIRED: 'انتهاء صلاحية رابط دفع',
  // ردّ مبلغٍ دُفع فعلاً عبر الرابط — لا «إلغاء رابط»
  PAYLINK_REFUNDED: 'استرداد رابط دفع',
  CARD_PAYMENT_COMPLETED: 'دفع بالبطاقة',
  CARD_PAYMENT_FAILED: 'محاولة دفع بالبطاقة لم تكتمل',
  // عكس دفعٍ مقبول (المال عاد للعميل)، وتعليقه للمراجعة (قد يكون المال خُصم ولم يُطابَق) — لا «محاولة لم تكتمل»
  CARD_PAYMENT_REVERSED: 'عكس دفع بالبطاقة',
  CARD_PAYMENT_HELD: 'دفع بالبطاقة قيد المراجعة',
  VISIT_RECORDED: 'زيارة ميدانية',
  VISIT_DELETED: 'حذف زيارة',
  VISIT_REASSIGNED: 'تغيير فريق زيارات العميل',
  DOCUMENT_ADDED: 'رفع وثيقة',
  DOCUMENT_REMOVED: 'حذف وثيقة',
  ROUTE_STOP_ADDED: 'إضافة العميل إلى خط سير',
  ROUTE_STOP_REMOVED: 'إزالة العميل من خط سير',
  CALL_LOGGED: 'مكالمة',
  SMART_REP_OUTCOME: 'نتيجة زيارة المندوب الذكي',
  CATALOG_ORDER_PLACED: 'طلب من منيو المنتجات',
  CATALOG_ORDER_UPDATED: 'تحديث طلب من منيو المنتجات',
  OTHER: 'إجراء آخر',
};

const isAction = (a: unknown): a is CustomerActivityAction => typeof a === 'string' && (CUSTOMER_ACTIONS as readonly string[]).includes(a);

/** الحذف النهائي لمالك المنصة (data.kind = OWNER_PURGE): عنوانه بنوع السجلّ المحذوف (data.model) */
const OWNER_PURGE_LABELS: Record<string, string> = {
  Invoice: 'حذف فاتورة نهائيا',
  Receipt: 'حذف سند قبض نهائيا',
  CustomerPaymentLink: 'حذف رابط دفع نهائيا',
  CardPayment: 'حذف عملية دفع بالبطاقة نهائيا',
  CallLog: 'حذف مكالمة نهائيا',
  AccountEntry: 'حذف قيد من حساب العميل نهائيا',
  // مستندٌ رُفع دون اتصال ينتظر قرار الانتقال للفوترة الإلكترونية (routes/ownerPurge.ts) — بلا ذكرٍ للضريبة
  ZatcaCutoverReview: 'حذف مستند معلق نهائيا',
};

/**
 * عنوان البند (مفتاحٌ لـtr) — إجراءٌ لا تعرفه هذه النسخة من الواجهة «إجراء آخر» لا رمزٌ لاتيني؛ و«إزالة الضريبة» لا ذكر للضريبة فيه.
 * data تميّز ما يشترك في الإجراء نفسه: نطاق مستخدم الشركة (ADMIN_SCOPE) لا إسناد مندوب، والحذف النهائي بنوع ما حُذف
 */
export function actionLabel(action: string, opts: { taxOff?: boolean; data?: Record<string, unknown> | null } = {}): string {
  if (opts.taxOff && action === 'CUSTOMER_TAX_DATA_UPDATED') return 'تحديث بيانات الفوترة للعميل';
  const kind = opts.data?.kind;
  if (kind === 'ADMIN_SCOPE' && action === 'CUSTOMER_ASSIGNED') return 'إضافة العميل إلى نطاق مستخدم';
  if (kind === 'ADMIN_SCOPE' && action === 'CUSTOMER_UNASSIGNED') return 'إخراج العميل من نطاق مستخدم';
  if (kind === 'OWNER_PURGE' && action === 'OTHER') {
    const model = opts.data?.model;
    return (typeof model === 'string' && OWNER_PURGE_LABELS[model]) || 'حذف نهائي بواسطة مالك المنصة';
  }
  // «إعادة القيد إلى مسودة» يُسجَّل عكساً (أثره يُطرح) بوضعه — لا «عكس قيد»؛ وإغلاق دفعٍ موقوف بعد مراجعته لا «قيد المراجعة»
  if (action === 'LEDGER_JOURNAL_REVERSED' && opts.data?.mode === 'RESET_DRAFT') return 'إعادة قيد يومية إلى مسودة';
  if (action === 'CARD_PAYMENT_HELD' && opts.data?.closedAfterReview === true) return 'إغلاق دفع بالبطاقة بعد المراجعة';
  return isAction(action) ? ACTION_LABELS[action] : ACTION_LABELS.OTHER;
}

// ═══ الأقسام ═══

const CATEGORY_OF: Record<CustomerActivityAction, ActivityCategory> = {
  CUSTOMER_CREATED: 'edits', CUSTOMER_UPDATED: 'edits', CUSTOMER_DELETED: 'edits', CUSTOMER_IMPORTED: 'edits',
  CUSTOMER_STATUS_CHANGED: 'edits', CUSTOMER_LOCATION_SET: 'edits', CUSTOMER_ASSIGNED: 'edits', CUSTOMER_UNASSIGNED: 'edits',
  CUSTOMER_PRICE_SET: 'edits', CUSTOMER_PRICE_REMOVED: 'edits', CUSTOMER_PRICE_LIST_CHANGED: 'edits', CUSTOMER_TAX_DATA_UPDATED: 'edits',
  INVOICE_ISSUED: 'sales', DEBIT_NOTE_ISSUED: 'sales', INVOICE_CANCELLED: 'sales', INVOICE_VOIDED: 'sales', INVOICE_EXPIRED: 'sales',
  INVOICE_REISSUED: 'sales', INVOICE_REASSIGNED: 'sales', INVOICE_PAID: 'sales', INVOICE_UPDATED: 'sales', INVOICE_DELETED: 'sales',
  CATALOG_ORDER_PLACED: 'sales', CATALOG_ORDER_UPDATED: 'sales',
  RETURN_ISSUED: 'returns', CREDIT_NOTE_ISSUED: 'returns',
  RECEIPT_ISSUED: 'money', RECEIPT_CANCELLED: 'money', RECEIPT_REASSIGNED: 'money', RECEIPT_DELETED: 'money',
  ADJUSTMENT_CREATED: 'money', ADJUSTMENT_UPDATED: 'money', OPENING_BALANCE_SET: 'money',
  LEDGER_JOURNAL_POSTED: 'money', LEDGER_JOURNAL_REVERSED: 'money',
  PAYLINK_CREATED: 'money', PAYLINK_PAID: 'money', PAYLINK_CANCELLED: 'money', PAYLINK_EXPIRED: 'money', PAYLINK_REFUNDED: 'money',
  CARD_PAYMENT_COMPLETED: 'money', CARD_PAYMENT_FAILED: 'money', CARD_PAYMENT_REVERSED: 'money', CARD_PAYMENT_HELD: 'money',
  VISIT_RECORDED: 'visits', VISIT_DELETED: 'visits', VISIT_REASSIGNED: 'visits', ROUTE_STOP_ADDED: 'visits', ROUTE_STOP_REMOVED: 'visits',
  CALL_LOGGED: 'visits', SMART_REP_OUTCOME: 'visits',
  DOCUMENT_ADDED: 'docs', DOCUMENT_REMOVED: 'docs',
  OTHER: 'other',
};

const isCategory = (c: unknown): c is ActivityCategory => typeof c === 'string' && (ACTIVITY_CATEGORIES as readonly string[]).includes(c);

/** قسم الإجراء — ما لا تعرفه هذه النسخة «أخرى» */
export function categoryOf(action: string): ActivityCategory {
  return isAction(action) ? CATEGORY_OF[action] : 'other';
}

export const CATEGORY_LABELS: Record<ActivityFilter, string> = {
  all: 'الكل',
  visits: 'الزيارات',
  sales: 'المبيعات',
  returns: 'المرتجعات',
  money: 'التحصيل والمدفوعات',
  docs: 'الوثائق',
  edits: 'بيانات العميل',
  other: 'أخرى',
};

// ═══ المنفّذ ═══

/**
 * مالك المنصة وموظفها «الدعم الفني» للشركة — كقاعدة المنصّة في كل موضع (services/customerDocs.ts docUploader، تعديل الحضور،
 * التعميمات…): الشركة لا ترى من دخل حسابها من المنصّة إلا بهذا الوصف، والخادم يحجب الاسم عن قارئها
 */
export const ACTOR_KIND_LABELS: Record<ActivityActorKind, string> = {
  REP: 'مندوب',
  ADMIN: 'إداري',
  OWNER: 'الدعم الفني',
  STAFF: 'الدعم الفني',
  API: 'الربط البرمجي',
  CUSTOMER: 'العميل',
  SYSTEM: 'النظام',
};

/** دور المنفّذ (مفتاحٌ لـtr) — نوعٌ مجهول يُعرض «النظام» */
export function actorKindLabel(kind: string | null | undefined): string {
  return kind && kind in ACTOR_KIND_LABELS ? ACTOR_KIND_LABELS[kind as ActivityActorKind] : ACTOR_KIND_LABELS.SYSTEM;
}

/**
 * اسم المنفّذ للعرض: الاسم المحفوظ لحظة الإجراء (لقطة لا تتغيّر بتغيّر اسمه لاحقاً)، وإلا دوره نفسه
 * («العميل» عبر منيو المنتجات أو رابط الدفع، و«النظام» للمهامّ الآلية). translate: الدور مفتاحٌ لـtr والاسم لا
 */
export function actorDisplay(actor: { kind?: string | null; name?: string | null } | null | undefined): { text: string; translate: boolean } {
  const name = (actor?.name ?? '').trim();
  if (name) return { text: name, translate: false };
  return { text: actorKindLabel(actor?.kind), translate: true };
}

// ═══ تعديل بيانات العميل: الحقل وقيمتاه ═══

/** أسماء حقول العميل في customerDiff بالخادم — ومرادفاتٌ قد يرسلها مسارٌ آخر */
export const FIELD_LABELS: Record<string, string> = {
  name: 'اسم العميل',
  businessName: 'الاسم التجاري',
  commercialReg: 'السجل التجاري',
  crNumber: 'السجل التجاري',
  taxNumber: 'الرقم الضريبي',
  phone: 'الجوال',
  altPhone: 'جوال إضافي',
  email: 'البريد الإلكتروني',
  city: 'المدينة',
  district: 'الحي',
  address: 'العنوان',
  location: 'الموقع على الخريطة',
  lat: 'الموقع على الخريطة',
  lng: 'الموقع على الخريطة',
  channel: 'قناة البيع',
  outletType: 'نوع المنفذ',
  status: 'الحالة',
  creditLimit: 'الحد الائتماني',
  paymentDays: 'مدة السداد بالأيام',
  paymentTermDays: 'مدة السداد بالأيام',
  priceListId: 'قائمة الأسعار',
  priceList: 'قائمة الأسعار',
  notes: 'ملاحظات',
  note: 'ملاحظات',
  buyerType: 'نوع المشتري',
  buyerIdScheme: 'نوع هوية المشتري',
  buyerIdValue: 'رقم هوية المشتري',
  addrStreet: 'الشارع',
  addrBuildingNo: 'رقم المبنى',
  addrAdditionalNo: 'الرقم الإضافي',
  addrPostalCode: 'الرمز البريدي',
  countryCode: 'الدولة',
  salesRepId: 'المندوب',
  salesRep: 'المندوب',
  createdBySalesRepId: 'المندوب الذي أضاف العميل',
  rep: 'المندوب',
  reps: 'المناديب',
  assignedReps: 'المناديب',
  number: 'رقم العميل',
  code: 'الكود',
  // حقول المستند في «تعديل فاتورة»: إعادة المرتجع للمخزون، وموقع البيع («لوكيشن») الذي فُكّ عن الفاتورة بحذفه
  returnToStock: 'أعيد إلى المخزون',
  locationId: 'لوكيشن',
};

/** اسم الحقل (مفتاحٌ لـtr) — حقلٌ لا تعرفه هذه النسخة «حقل آخر» لا اسمٌ برمجي */
export function describeChange(field: string): string {
  return FIELD_LABELS[field] ?? 'حقل آخر';
}

/** حقولٌ مالية: تُخفى قيمها وسطرها كله حين يُطفأ النظام المحاسبي */
const MONEY_FIELDS = new Set(['creditLimit', 'paymentDays', 'paymentTermDays', 'priceListId', 'priceList', 'openingBalance', 'balance']);
/** حقولٌ قيمتها مبلغ: تُعرض بعملة الشركة وترقيمها كسائر مبالغ البطاقة (لا رقماً خاماً) */
const AMOUNT_FIELDS = new Set(['creditLimit', 'openingBalance', 'balance']);

/** اسم الدولة من رمزها (ISO) بلغة الواجهة — Intl يعرفها بكل اللغات؛ رمزٌ لا يُعرف يبقى كما هو */
function countryName(code: string): string {
  const c = code.toUpperCase();
  // ZZ «منطقة غير معروفة» في CLDR — يبقى رمزاً كسائر ما لا يُعرف (XX «دولة أخرى» في المنصّة)
  if (c === 'ZZ') return c;
  try {
    const n = new Intl.DisplayNames([activeLocale()], { type: 'region', fallback: 'none' }).of(c);
    return n && n.toUpperCase() !== c ? n : c;
  } catch { return c; }
}
/** حقولٌ ضريبية: لا ذكر لها تحت «إزالة الضريبة» */
const TAX_FIELDS = new Set(['taxNumber']);

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'نشط', INACTIVE: 'غير نشط', BLOCKED: 'محظور', DELETED: 'محذوف',
  CONFIRMED: 'معتمد', CANCELLED: 'ملغى', DRAFT: 'مسودة', VOIDED: 'مبطل', EXPIRED: 'منتهي', PAID: 'مدفوع', PENDING: 'قيد الانتظار',
  // طلب منيو المنتجات (services/catalogOrders.ts)
  NEW: 'جديد', SEEN: 'تمت المشاهدة', DONE: 'تم',
};
const CHANNEL_LABELS: Record<string, string> = {
  MT: 'التجارة الحديثة', WHOLESALE: 'الجملة', TT: 'التجارة التقليدية', DISCOUNTER: 'متاجر التخفيضات',
  CASH_VAN: 'البيع النقدي المتنقل', ECOMMERCE: 'التجارة الإلكترونية',
};
/** نوع المنفذ بأسمائه في تصنيف المندوب الذكي (rep/aiRepLogic.ts، مرآة backend/src/ai-rep/taxonomy.ts) */
const OUTLET_LABELS: Record<string, string> = Object.fromEntries(OUTLET_TYPE_OPTIONS.map((o) => [o.code, o.label]));

/** معرّفٌ آلي (uuid أو cuid) لا معنى له للقارئ — يُكتفى بأن الحقل تغيّر */
const looksLikeId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^c[a-z0-9]{20,}$/.test(s);
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * قيمة حقلٍ في التعديل للعرض: text والترجمة (translate = مفتاحٌ لـtr كـ«نشط»)، وltr للأرقام والرموز.
 * null = لا تُعرض القيمة (معرّفٌ آلي أو بنيةٌ لا تُقرأ) ويبقى «تغيّر الحقل» وحده
 */
export function changeValue(field: string, v: unknown): { text: string; translate: boolean; ltr: boolean } | null {
  if (v === null || v === undefined || v === '') return { text: '—', translate: false, ltr: false };
  if (typeof v === 'boolean') return { text: v ? 'نعم' : 'لا', translate: true, ltr: false };
  if (field === 'location' && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { lat?: unknown; lng?: unknown };
    const lat = Number(o.lat), lng = Number(o.lng);
    if (o.lat == null || o.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return { text: '—', translate: false, ltr: false };
    return { text: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, translate: false, ltr: true };
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return { text: AMOUNT_FIELDS.has(field) ? formatCurrency(v) : String(v), translate: false, ltr: true };
  }
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String).filter((s) => !looksLikeId(s));
    return parts.length ? { text: clip(parts.join('، ')), translate: false, ltr: false } : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return { text: '—', translate: false, ltr: false };
  if (looksLikeId(s)) return null;
  if (field === 'status' && STATUS_LABELS[s]) return { text: STATUS_LABELS[s], translate: true, ltr: false };
  if (field === 'channel' && CHANNEL_LABELS[s]) return { text: CHANNEL_LABELS[s], translate: true, ltr: false };
  if (field === 'outletType' && OUTLET_LABELS[s]) return { text: OUTLET_LABELS[s], translate: true, ltr: false };
  if (field === 'buyerType' && (BUYER_TYPE_LABELS_AR as Record<string, string>)[s]) {
    return { text: (BUYER_TYPE_LABELS_AR as Record<string, string>)[s], translate: true, ltr: false };
  }
  // نوع هوية المشتري بأسمائه في نموذج الفوترة (CRN «السجل التجاري»…) لا رمزه
  if (field === 'buyerIdScheme' && (BUYER_ID_SCHEME_LABELS_AR as Record<string, string>)[s]) {
    return { text: (BUYER_ID_SCHEME_LABELS_AR as Record<string, string>)[s], translate: true, ltr: false };
  }
  // الدولة باسمها بلغة الواجهة لا رمز ISO
  if (field === 'countryCode' && /^[A-Za-z]{2}$/.test(s)) return { text: countryName(s), translate: false, ltr: false };
  // مبلغٌ وصل نصّاً (عمودٌ عشري) — بعملة الشركة كالرقم
  if (AMOUNT_FIELDS.has(field) && Number.isFinite(Number(s))) return { text: formatCurrency(Number(s)), translate: false, ltr: true };
  const ltr = /^[\d\s+\-().:/#]+$/.test(s) || /^[\w.+-]+@[\w.-]+$/.test(s);
  return { text: clip(s), translate: false, ltr };
}

export interface ActivityChange {
  field: string;
  label: string;
  from: ReturnType<typeof changeValue>;
  to: ReturnType<typeof changeValue>;
}

/**
 * تغييرات بيانات العميل في البند (data.changes) للعرض — مرتّبةٌ كما سجّلها الخادم، بلا مالٍ حين يُطفأ النظام المحاسبي
 * ولا ضريبة تحت «إزالة الضريبة»، وlat/lng يُدمجان سطراً واحداً «الموقع على الخريطة»
 */
export function changesOf(item: Pick<ActivityItem, 'data'> & { action?: string }, opts: { accountingOn: boolean; taxOff?: boolean }): ActivityChange[] {
  const raw = item.data?.changes;
  // «تحديد موقع العميل» يحمل النقطتين في data.from/data.to ({lat, lng} أو null) لا في changes
  if (!Array.isArray(raw) && item.action === 'CUSTOMER_LOCATION_SET' && item.data && ('from' in item.data || 'to' in item.data)) {
    return [{ field: 'location', label: describeChange('location'), from: changeValue('location', item.data.from), to: changeValue('location', item.data.to) }];
  }
  if (!Array.isArray(raw)) return [];
  const out: ActivityChange[] = [];
  let sawLatLng = false;
  for (const c of raw.slice(0, 40)) {
    if (!c || typeof c !== 'object') continue;
    const { field, from, to } = c as { field?: unknown; from?: unknown; to?: unknown };
    if (typeof field !== 'string' || !field) continue;
    if (!opts.accountingOn && MONEY_FIELDS.has(field)) continue;
    if (opts.taxOff && TAX_FIELDS.has(field)) continue;
    if (field === 'lat' || field === 'lng') {
      if (sawLatLng) continue;
      sawLatLng = true;
      out.push({ field: 'location', label: describeChange('location'), from: null, to: null });
      continue;
    }
    out.push({ field, label: describeChange(field), from: changeValue(field, from), to: changeValue(field, to) });
  }
  return out;
}

// ═══ تفاصيل البند ═══

/** نوع العرض: text كما هو، label مفتاحٌ لـtr، money بعملة الشركة، number رقم، duration مدّة، code رمزٌ لاتيني باتجاهه، date لحظة */
export type DetailKind = 'text' | 'label' | 'money' | 'number' | 'duration' | 'code' | 'date';
export interface ActivityDetail { label: string; value: string | number; kind: DetailKind }

const PAYMENT_TYPE_LABELS: Record<string, string> = { CASH: 'نقدي', CREDIT: 'آجل', INSTALLMENT: 'تقسيط', INSTALLMENTS: 'تقسيط' };
const INVOICE_TYPE_LABELS: Record<string, string> = { ...PAYMENT_TYPE_LABELS, RETURN: 'مرتجع' };
const RETURN_REASON_LABELS: Record<string, string> = { NORMAL: 'مرتجع عادي', DAMAGED: 'بضاعة تالفة', EXCHANGE: 'استبدال' };
/** إجراءات بطاقة العميل نفسها: إنشاؤه واستيراده وحذفه — تفاصيلها لقطة بياناته لحظتها */
const CUSTOMER_CARD_ACTIONS = new Set(['CUSTOMER_CREATED', 'CUSTOMER_IMPORTED', 'CUSTOMER_DELETED']);
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'نقدي', BANK_TRANSFER: 'تحويل بنكي', POS: 'شبكة', CHEQUE: 'شيك', ONLINE: 'دفع الكتروني', CARD: 'بطاقة',
};
const CALL_DIRECTION_LABELS: Record<string, string> = { IN: 'واردة', INBOUND: 'واردة', OUT: 'صادرة', OUTBOUND: 'صادرة', MISSED: 'فائتة' };
/** نوع التسوية (CustomerAdjustment.kind) أو القيد المستورد، والاتجاه (side) في البند التاريخي */
const ADJUSTMENT_KIND_LABELS: Record<string, string> = {
  DEBIT: 'مدين', CREDIT: 'دائن', BAD_DEBT_WRITEOFF: 'شطب دين معدوم', CREDIT_REFUND: 'ردّ رصيد دائن للعميل', LEDGER_IMPORT: 'قيد مستورد',
  IMPORT_REVERTED: 'التراجع عن الاستيراد',
};

/**
 * أسباب الإجراء كما يكتبها الخادم رموزاً (data.reason) — والسبب الذي كتبه المستخدم نصّاً حرّاً يُعرض كما هو، ورمزٌ لا تعرفه هذه
 * النسخة لا يُعرض (لا رمز لاتيني أمام القارئ)
 */
const REASON_LABELS: Record<string, string> = {
  // روابط الدفع (services/paylink.ts)
  REPLACED: 'استبدل برابط جديد', INVOICE_CHANGED: 'تغيرت الفاتورة', COLLECTED: 'سددت الفاتورة', INVOICE_CANCELLED: 'ألغيت الفاتورة',
  MANUAL: 'إلغاء يدوي', PROVIDER: 'من مزود الدفع', TTL: 'انتهت المدة',
  // إبطال الفاتورة (services/invoiceVoid.ts)
  REJECTED: 'رفض هيئة الزكاة والضريبة', WITHDRAWN: 'سحب الفاتورة',
  // ما يصيب العميل من إجراءٍ على غيره
  PRODUCT_DELETED: 'حذف الصنف', PRODUCT_MERGED: 'دمج الصنف في صنف آخر', OWNER_PURGE: 'حذف نهائي بواسطة مالك المنصة',
  IMPORT_REVERTED: 'التراجع عن الاستيراد', BASE_UNIT_CONVERTED: 'تحويل وحدة الأساس للصنف', REP_DELETED: 'حذف المندوب',
  TEAM_DELETED: 'حذف الفريق', ROUTE_SAVED: 'تعديل خط السير', ROUTE_DELETED: 'حذف خط السير', PRICE_LIST_DELETED: 'حذف قائمة الأسعار',
  LOCATION_DELETED: 'حذف الموقع', APPLY_SUGGESTED: 'اعتماد التصنيف المقترح',
};
const isCode = (s: string) => /^[A-Z][A-Z0-9_]*$/.test(s);

/** نوع قيد حساب العميل (AccountEntry.type) في الحذف النهائي */
const ENTRY_TYPE_LABELS: Record<string, string> = {
  INVOICE_DEBIT: 'قيد فاتورة مدين', INVOICE_CREDIT: 'قيد فاتورة دائن', RECEIPT_CREDIT: 'قيد سند دائن', RECEIPT_DEBIT: 'قيد سند مدين',
  ADJUSTMENT_DEBIT: 'تسوية مدينة', ADJUSTMENT_CREDIT: 'تسوية دائنة',
};

/** حالة عملية البطاقة ورابط الدفع (أحرف صغيرة في جدوليهما) */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  approved: 'مقبولة', declined: 'مرفوضة', expired: 'منتهية', review: 'قيد المراجعة', failed: 'فشلت', reversed: 'معكوسة',
  refunded: 'مستردة', paid: 'مدفوع', initiated: 'بانتظار الدفع', pending: 'قيد الانتظار', canceled: 'ملغى', cancelled: 'ملغى',
};

/** طريق الإجراء (data.via) — ما لا يُعرف لا يُعرض */
const VIA_LABELS: Record<string, string> = {
  CARD: 'الدفع بالبطاقة', PAYLINK: 'رابط دفع', CARD_REVERSAL: 'عكس دفع بالبطاقة', PAYLINK_REFUND: 'استرداد رابط دفع',
  import: 'استيراد من ملف', AI_CLASSIFY: 'المندوب الذكي', AI_REP: 'المندوب الذكي', ref: 'مزامنة بالرقم المرجعي', put: 'مزامنة نظام خارجي',
};

/** إجراءات المرتجع: رمز سبب الإرجاع (NORMAL/DAMAGED/EXCHANGE) فيها «سبب الإرجاع» ولو وصل في data.reason (البند التاريخي القديم) */
const RETURN_ACTIONS = new Set(['RETURN_ISSUED', 'CREDIT_NOTE_ISSUED']);
/** اعتراض المحل في نتيجة المندوب الذكي (نسخة الواجهة من OBJECTION_CODES في الخادم) */
const OBJECTION_LABELS: Record<string, string> = Object.fromEntries(OBJECTIONS.map((o) => [o.code, o.label]));

/** إجراءات السعر الخاص: from/to فيها سعران (لا قائمتا أسعار كـCUSTOMER_PRICE_LIST_CHANGED) */
const PRICE_ACTIONS = new Set(['CUSTOMER_PRICE_SET', 'CUSTOMER_PRICE_REMOVED']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? clip(v.trim()) : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * المبلغ المعروض للبند: amount، وإلا data.total، وإلا data.amountOutOfRange (مبلغٌ أكبر من عمود السجلّ حُفظ نصّاً في التفاصيل —
 * والخادم يحذفه مع سائر المال حين يُحجب) — null إن لم يكن
 */
export function amountOf(item: Pick<ActivityItem, 'amount' | 'data'>): number | null {
  return num(item.amount) ?? num(item.data?.total) ?? num(item.data?.amountOutOfRange);
}

/**
 * إجراءاتٌ مبلغها **أثرها الموقَّع على رصيد العميل** (مدين − دائن — عُرف الخادم في services/customerActivity.ts): التسويات والرصيد
 * الافتتاحي وقيود اليومية. تُعرض بإشارتها (+ يزيد ما على العميل، − ينقصه) لا قيمةً مطلقة كمبلغ المستند
 */
const BALANCE_EFFECT_ACTIONS = new Set(['ADJUSTMENT_CREATED', 'ADJUSTMENT_UPDATED', 'OPENING_BALANCE_SET', 'LEDGER_JOURNAL_POSTED', 'LEDGER_JOURNAL_REVERSED']);
export function isBalanceEffect(action: string): boolean {
  return BALANCE_EFFECT_ACTIONS.has(action);
}
/** إشارة المبلغ المعروض: «+» للأثر الموجب على الرصيد (والسالب يحمل إشارته من التنسيق) — وغيره بلا إشارة */
export function amountSign(item: Pick<ActivityItem, 'action'>, amount: number | null): '+' | '' {
  return amount !== null && amount > 0 && isBalanceEffect(item.action) ? '+' : '';
}

/**
 * سطور التفاصيل من data بأسمائها المتّفق عليها مع الخادم — وما سواها لا يُعرض (لا JSON خام).
 * المال (الضريبة وسعر الصنف) لا يظهر حين يُطفأ النظام المحاسبي، والضريبة لا تظهر تحت «إزالة الضريبة»
 */
export function detailsOf(
  item: Pick<ActivityItem, 'action' | 'amount' | 'data'> & { refNo?: string | null; actor?: { name?: string | null } | null },
  opts: { accountingOn: boolean; taxOff?: boolean; docKindLabel?: (k: string) => string },
): ActivityDetail[] {
  const d: Record<string, unknown> = item.data ?? {};
  const out: ActivityDetail[] = [];
  const labelled = (label: string, v: string, map: Record<string, string>) =>
    out.push({ label, value: map[v] ?? v, kind: map[v] ? 'label' : 'text' });
  // لقطة بطاقة العميل لحظة إنشائه أو حذفه
  if (CUSTOMER_CARD_ACTIONS.has(item.action)) {
    const name = str(d.name);
    if (name) out.push({ label: 'اسم العميل', value: name, kind: 'text' });
    const no = num(d.number);
    if (no !== null) out.push({ label: 'رقم العميل', value: `#${no}`, kind: 'code' });
    const phone = str(d.phone);
    if (phone) out.push({ label: 'الجوال', value: phone, kind: 'code' });
    const city = str(d.city);
    if (city) out.push({ label: 'المدينة', value: city, kind: 'text' });
    if (d.hasLocation === true) out.push({ label: 'الموقع على الخريطة', value: 'محدد', kind: 'label' });
  }
  const pt = str(d.paymentType);
  if (pt) labelled('طريقة البيع', pt, PAYMENT_TYPE_LABELS);
  const it = str(d.invoiceType);
  if (it) labelled('نوع الفاتورة', it, INVOICE_TYPE_LABELS);
  const pm = str(d.paymentMethod) ?? str(d.method);
  if (pm) labelled('طريقة الدفع', pm, PAYMENT_METHOD_LABELS);
  const cheque = str(d.chequeNumber);
  if (cheque) out.push({ label: 'رقم الشيك', value: cheque, kind: 'code' });
  const bank = str(d.bankName);
  if (bank) out.push({ label: 'البنك', value: bank, kind: 'text' });
  const items = num(d.itemsCount);
  if (items !== null) out.push({ label: 'عدد الأصناف', value: items, kind: 'number' });
  const inst = num(d.installmentsCount);
  if (inst !== null && inst > 0) out.push({ label: 'عدد الأقساط', value: inst, kind: 'number' });
  if (opts.accountingOn) {
    const discount = num(d.discount);
    if (discount !== null && discount !== 0) out.push({ label: 'الخصم', value: discount, kind: 'money' });
  }
  if (opts.accountingOn && !opts.taxOff) {
    const tax = num(d.taxTotal);
    if (tax !== null && tax !== 0) out.push({ label: 'الضريبة', value: tax, kind: 'money' });
  }
  const orig = str(d.originalInvoiceNo) ?? str(d.invoiceNo);
  if (orig && orig !== str(item.refNo)) out.push({ label: 'عن الفاتورة', value: orig, kind: 'code' });
  // سبب الإرجاع رمزاً: الحيّ في returnReason، والتاريخيّ القديم في reason — كلاهما بالعربية، والرمز المجهول لا يظهر لاتينياً
  const reasonRaw = str(d.reason);
  const isReturn = RETURN_ACTIONS.has(item.action) || str(d.invoiceType) === 'RETURN';
  const rr = str(d.returnReason) ?? (isReturn && reasonRaw && RETURN_REASON_LABELS[reasonRaw] ? reasonRaw : null);
  const reasonUsed = !!rr && rr === reasonRaw && !str(d.returnReason);
  if (rr && RETURN_REASON_LABELS[rr]) out.push({ label: 'سبب الإرجاع', value: RETURN_REASON_LABELS[rr], kind: 'label' });
  else if (rr && !isCode(rr)) out.push({ label: 'سبب الإرجاع', value: rr, kind: 'text' });
  if (typeof d.returnToStock === 'boolean') out.push({ label: 'أعيد إلى المخزون', value: d.returnToStock ? 'نعم' : 'لا', kind: 'label' });
  // نتيجة زيارة المندوب الذكي: النتيجة واعتراض المحل بأسمائهما في شاشة المندوب الذكي
  if (item.action === 'SMART_REP_OUTCOME') {
    const oc = str(d.outcome) ?? str(d.kind);
    if (oc && OUTCOME_LABEL[oc]) out.push({ label: 'النتيجة', value: OUTCOME_LABEL[oc], kind: 'label' });
    const obj = str(d.objection);
    if (obj && OBJECTION_LABELS[obj]) out.push({ label: 'الاعتراض', value: OBJECTION_LABELS[obj], kind: 'label' });
  }
  if (item.action === 'CUSTOMER_PRICE_LIST_CHANGED' && opts.accountingOn) {
    // null = «السعر الأساسي»، ومعرّفٌ بلا اسمٍ محفوظ (قائمةٌ حُذفت) لا يُعرض
    const side = (id: unknown, name: unknown) => str(name) ?? (id == null || id === '' ? 'السعر الأساسي' : null);
    const f = side(d.from, d.fromName), t = side(d.to, d.toName);
    if (f) out.push({ label: 'القائمة السابقة', value: f, kind: f === 'السعر الأساسي' ? 'label' : 'text' });
    if (t) out.push({ label: 'القائمة الجديدة', value: t, kind: t === 'السعر الأساسي' ? 'label' : 'text' });
  }
  // سُجّل متأخّراً (data.backdated): زيارةٌ أدخلتها الإدارة أو المفتاح البرمجي بتاريخٍ أقدم من نافذة العمل دون اتصال (visitAt)، أو
  // نتيجة المندوب الذكي من جهازٍ ظلّ بلا اتصال (occurredAt) — السطر بلحظة تسجيله، وتاريخه الفعلي هنا
  const realAt = d.backdated === true ? str(d.visitAt) ?? str(d.occurredAt) : null;
  if (realAt && !isNaN(new Date(realAt).getTime())) out.push({ label: 'التاريخ الفعلي (سجل متأخرا)', value: realAt, kind: 'date' });
  const expires = str(d.expiresAt);
  if (expires && !isNaN(new Date(expires).getTime())) out.push({ label: 'ينتهي في', value: expires, kind: 'date' });
  // حالة عملية البطاقة أو رابط الدفع — وما تقوله شارة «ملغى/منتهي» بجانب العنوان لا يتكرّر هنا
  const payStatus = str(d.status);
  if (payStatus && (item.action.startsWith('CARD_PAYMENT_') || item.action.startsWith('PAYLINK_')) && PAYMENT_STATUS_LABELS[payStatus]
    && !statusBadgeOf(item)) {
    out.push({ label: 'الحالة', value: PAYMENT_STATUS_LABELS[payStatus], kind: 'label' });
  }
  const via = str(d.via);
  if (via && VIA_LABELS[via]) out.push({ label: 'عبر', value: VIA_LABELS[via], kind: 'label' });
  const receiptNo = str(d.receiptNo);
  if (receiptNo && receiptNo !== str(item.refNo)) out.push({ label: 'رقم السند', value: receiptNo, kind: 'code' });
  // قيد اليومية على حساب العميل (LEDGER_JOURNAL_*): رقمه إن خالف رقم البند، ورقم قيد عكسه، ومرجعه وبيانه وحساباته
  const moveNo = str(d.moveNo);
  if (moveNo && moveNo !== str(item.refNo)) out.push({ label: 'رقم القيد', value: moveNo, kind: 'code' });
  const reversalNo = str(d.reversalNo);
  if (reversalNo) out.push({ label: 'رقم قيد العكس', value: reversalNo, kind: 'code' });
  // قيد تصحيح الحساب الرئيسي مرجعه رمز الفحص (C3) — بيانه يقول ما هو
  const reference = d.controlAdjustment === true ? null : str(d.reference);
  if (reference) out.push({ label: 'المرجع', value: reference, kind: 'text' });
  const narration = str(d.narration);
  if (narration) out.push({ label: 'البيان', value: narration, kind: 'text' });
  const codes = Array.isArray(d.accountCodes) ? d.accountCodes.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, 20) : [];
  if (codes.length) out.push({ label: 'الحسابات', value: codes.join(', '), kind: 'code' });
  // الحذف النهائي: ما سُحب مع مستندٍ آخر، وعدد مستندات العميل المحذوفة معه
  if (d.cascade === true) out.push({ label: 'الحذف', value: 'ضمن حذف مستند مرتبط', kind: 'label' });
  const invDel = num(d.invoicesDeleted);
  if (invDel !== null && invDel > 0) out.push({ label: 'الفواتير المحذوفة معه', value: invDel, kind: 'number' });
  const rcDel = num(d.receiptsDeleted);
  if (rcDel !== null && rcDel > 0) out.push({ label: 'السندات المحذوفة معه', value: rcDel, kind: 'number' });
  const entryType = str(d.entryType);
  if (entryType && ENTRY_TYPE_LABELS[entryType]) out.push({ label: 'نوع القيد', value: ENTRY_TYPE_LABELS[entryType], kind: 'label' });
  const product = str(d.productName);
  if (product) out.push({ label: 'الصنف', value: product, kind: 'text' });
  if (opts.accountingOn) {
    const price = num(d.unitPrice) ?? (PRICE_ACTIONS.has(item.action) ? num(d.price) : null);
    if (price !== null) out.push({ label: 'السعر', value: price, kind: 'money' });
    // تحويل وحدة الأساس: السعر قبل القسمة وبعدها
    if (PRICE_ACTIONS.has(item.action)) {
      const pf = num(d.from), pt2 = num(d.to);
      if (pf !== null) out.push({ label: 'السعر السابق', value: pf, kind: 'money' });
      if (pt2 !== null) out.push({ label: 'السعر الجديد', value: pt2, kind: 'money' });
    }
  }
  if (PRICE_ACTIONS.has(item.action)) {
    const fu = str(d.fromUnit), tu = str(d.toUnit);
    if (fu) out.push({ label: 'الوحدة السابقة', value: fu, kind: 'text' });
    if (tu) out.push({ label: 'الوحدة الجديدة', value: tu, kind: 'text' });
  }
  // مالٌ أُعيد إلى فاتورةٍ باقية حين حُذف السند الذي سدّدها حذفاً نهائياً
  if (opts.accountingOn) {
    const restored = num(d.restoredAmount);
    if (restored !== null && restored !== 0) out.push({ label: 'المبلغ المعاد إلى الفاتورة', value: restored, kind: 'money' });
  }
  const kind = item.action === 'SMART_REP_OUTCOME' ? null : str(d.kind);
  if (kind) {
    if (item.action.startsWith('DOCUMENT_')) out.push({ label: 'نوع الوثيقة', value: opts.docKindLabel ? opts.docKindLabel(kind) : kind, kind: 'label' });
    else if (ADJUSTMENT_KIND_LABELS[kind]) out.push({ label: 'نوع التسوية', value: ADJUSTMENT_KIND_LABELS[kind], kind: 'label' });
  }
  const side = str(d.side);
  if (side && ADJUSTMENT_KIND_LABELS[side] && !(kind && ADJUSTMENT_KIND_LABELS[kind])) out.push({ label: 'نوع القيد', value: ADJUSTMENT_KIND_LABELS[side], kind: 'label' });
  const entries = num(d.entries);
  if (entries !== null && entries > 0) out.push({ label: 'عدد القيود', value: entries, kind: 'number' });
  const dir = str(d.direction);
  if (dir && CALL_DIRECTION_LABELS[dir]) out.push({ label: 'نوع المكالمة', value: CALL_DIRECTION_LABELS[dir], kind: 'label' });
  const route = str(d.routeName);
  if (route) out.push({ label: 'خط السير', value: route, kind: 'text' });
  // المندوب أو المستخدم المعنيّ بالإجراء (المُسنَد، صاحب الزيارة أو الخط…) — ولا يتكرّر إن كان هو المنفّذ نفسه
  const actorName = str(item.actor?.name);
  const repName = str(d.repName) ?? str(d.salesRepName);
  if (repName && repName !== actorName) out.push({ label: 'المندوب', value: repName, kind: 'text' });
  const adminName = str(d.adminName);
  if (adminName && adminName !== actorName) out.push({ label: 'المستخدم', value: adminName, kind: 'text' });
  const from = str(d.fromRep), to = str(d.toRep);
  if (from) out.push({ label: 'من المندوب', value: from, kind: 'text' });
  if (to) out.push({ label: 'إلى المندوب', value: to, kind: 'text' });
  const fromTeam = str(d.fromTeam);
  if (fromTeam) out.push({ label: 'من الفريق', value: fromTeam, kind: 'text' });
  const oldS = str(d.oldStatus), newS = str(d.newStatus);
  if (oldS) out.push({ label: 'الحالة السابقة', value: STATUS_LABELS[oldS] ?? oldS, kind: STATUS_LABELS[oldS] ? 'label' : 'text' });
  // حالة العملية أو الرابط قبل الإجراء (عكسٌ من «قيد المراجعة»، حذفٌ نهائي لرابطٍ مدفوع) — بأسمائها وحدها، والرمز المجهول لا يظهر
  const prevS = oldS ? null : str(d.previousStatus) ?? str(d.fromStatus);
  const prevLabel = prevS ? PAYMENT_STATUS_LABELS[prevS] ?? STATUS_LABELS[prevS] : null;
  if (prevLabel) out.push({ label: 'الحالة السابقة', value: prevLabel, kind: 'label' });
  if (newS) out.push({ label: 'الحالة الجديدة', value: STATUS_LABELS[newS] ?? newS, kind: STATUS_LABELS[newS] ? 'label' : 'text' });
  const dur = num(d.durationSec);
  if (dur !== null && dur > 0) out.push({ label: item.action === 'CALL_LOGGED' ? 'مدة المكالمة' : 'مدة الزيارة', value: dur, kind: 'duration' });
  const photos = num(d.photosCount);
  if (photos !== null && photos > 0) out.push({ label: 'الصور', value: photos, kind: 'number' });
  const count = num(d.count);
  if (count !== null) out.push({ label: 'العدد', value: count, kind: 'number' });
  const reason = reasonUsed ? null : reasonRaw;
  // «إزالة الضريبة»: رفض هيئة الزكاة والضريبة يُذكر بلا ذكرٍ للضريبة
  if (reason === 'REJECTED' && opts.taxOff) out.push({ label: 'السبب', value: 'رفض الفاتورة الإلكترونية', kind: 'label' });
  else if (reason && REASON_LABELS[reason]) out.push({ label: 'السبب', value: REASON_LABELS[reason], kind: 'label' });
  else if (reason && !isCode(reason)) out.push({ label: 'السبب', value: reason, kind: 'text' });
  return out;
}

/** رقم المستند على البند — «رقم العميل» بصيغته «#7» في بنود العميل (التاريخيّ يحمله في refNo رقماً خاماً) */
export function refNoOf(item: Pick<ActivityItem, 'refType' | 'refNo'>): string | null {
  const r = (item.refNo ?? '').trim();
  if (!r) return null;
  return item.refType === 'CUSTOMER' && /^\d+$/.test(r) ? formatCustomerNumber(Number(r)) : r;
}

/**
 * علامة «غير موثّق» (data.unverified): ما كتبه طرفٌ بلا دخول — طلب منيو المنتجات العلني يُنسب للعميل بمطابقة الجوال، فيُعلَّم
 * كي لا يُقرأ اسمه وملاحظته كأنهما من العميل يقيناً. null = بندٌ موثّق
 */
export function unverifiedBadgeOf(item: Pick<ActivityItem, 'action' | 'data'>): string | null {
  if (item.data?.unverified !== true) return null;
  return item.action.startsWith('CATALOG_ORDER_') ? 'طلب من المنيو — غير موثّق' : 'غير موثّق';
}

/**
 * أصناف البند (data.items): أسعار العميل الخاصة التي تغيّرت دفعةً (الصنف والسعر قبل وبعد) أو أُلغيت، وأصناف طلب المنيو
 * (الكمية والوحدة) — بسقف ٣٠ سطراً. السعر لا يُعاد حين يُطفأ النظام المحاسبي
 */
export function itemsOf(item: Pick<ActivityItem, 'data'>, opts: { accountingOn: boolean }): {
  name: string | null; from: number | null; to: number | null; price: number | null; qty: number | null; unit: string | null;
}[] {
  const raw = item.data?.items;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)).slice(0, 30).map((x) => ({
    name: str(x.productName),
    from: opts.accountingOn ? num(x.from) : null,
    to: opts.accountingOn ? num(x.to) : null,
    price: opts.accountingOn ? num(x.price) : null,
    qty: num(x.qty),
    unit: str(x.unitName) ?? str(x.unit),
  }));
}

/**
 * توزيع سند القبض على الفواتير (data.allocations): رقم الفاتورة ومبلغها وهل سُدّدت كاملة، وهل عاد مبلغها إلى الفاتورة (restored:
 * حُذف السند نهائياً وبقيت الفاتورة) — بسقف ١٠ أسطر
 */
export function allocationsOf(item: Pick<ActivityItem, 'data'>): { invoiceNo: string | null; amount: number | null; settled: boolean; restored: boolean }[] {
  const raw = item.data?.allocations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a)).slice(0, 10)
    .map((a) => ({ invoiceNo: str(a.invoiceNo), amount: num(a.amount), settled: a.settled === true, restored: a.restored === true }));
}

/** ملاحظة البند (ملاحظة الزيارة أو المكالمة أو الإجراء) — نصٌّ حرّ يُعرض كتلةً مستقلّة */
export function noteOf(item: Pick<ActivityItem, 'data'>): string | null {
  const n = item.data?.note;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 2000) : null;
}

/** حالة المستند في البند التاريخي (فاتورةٌ أُلغيت بعد إصدارها) — شارة «ملغى» أو «منتهي» بجانب العنوان */
export function statusBadgeOf(item: Pick<ActivityItem, 'action' | 'data'>): string | null {
  if (item.action.endsWith('_CANCELLED') || item.action.endsWith('_VOIDED') || item.action.endsWith('_EXPIRED')) return null;
  const d: Record<string, unknown> = item.data ?? {};
  // حالات الفاتورة بأحرف كبيرة، وحالات رابط الدفع بصغيرة (canceled بلامٍ واحدة)
  const s = typeof d.status === 'string' ? d.status.toUpperCase() : null;
  if (d.cancelled === true || s === 'CANCELLED' || s === 'CANCELED' || s === 'VOIDED' || d.voided === true) return 'ملغى';
  if (s === 'EXPIRED' || d.expired === true) return 'منتهي';
  return null;
}

/** مدّة الزيارة كما في خريطة التتبّع وأرشيف العميل: س:دد:ثث أو دد:ثث */
export function formatDuration(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

// ═══ الصفحات والأيام ═══

/** بندٌ من الخادم بشكلٍ مضمون — قيمٌ غائبة أو بأنواعٍ غير متوقّعة لا تُسقط الشاشة */
export function normalizeItem(raw: unknown): ActivityItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id ? r.id : null;
  const at = typeof r.at === 'string' && !isNaN(new Date(r.at).getTime()) ? r.at : null;
  if (!id || !at) return null;
  const action = typeof r.action === 'string' && r.action ? r.action : 'OTHER';
  const actorRaw = (r.actor && typeof r.actor === 'object' ? r.actor : {}) as { kind?: unknown; name?: unknown };
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const actorId = s((actorRaw as { id?: unknown }).id);
  return {
    id, at, action,
    category: isCategory(r.category) ? r.category : categoryOf(action),
    actor: { kind: s(actorRaw.kind) ?? 'SYSTEM', name: s(actorRaw.name), ...(actorId ? { id: actorId } : {}) },
    refType: s(r.refType), refId: s(r.refId), refNo: s(r.refNo),
    amount: num(r.amount),
    data: r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : null,
    historical: r.historical === true,
  };
}

export function normalizePage(raw: unknown): ActivityPage {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { items?: unknown; nextBefore?: unknown };
  const items = Array.isArray(r.items) ? r.items.map(normalizeItem).filter((x): x is ActivityItem => x !== null) : [];
  return { items, nextBefore: typeof r.nextBefore === 'string' && r.nextBefore ? r.nextBefore : null };
}

const ms = (at: string) => new Date(at).getTime();

/**
 * دمج صفحةٍ تالية بما عُرض: بلا تكرار (حدّ الصفحة قد يعيد بنداً، والنسخة المعروضة أولاً تبقى) والأحدث أولاً.
 * ترتيب الخادم هو الحَكَم: الأحداث في اللحظة نفسها (معاملةٌ واحدة) بترتيب كتابتها كما أرسلها، وبند الصفحة التالية يأتي بعد ما
 * عُرض — فالفرز باللحظة وحدها وفرز المصفوفة ثابت (stable): لا يقلب ترتيب الخادم ولا يرفع بنداً جديداً فوق ما رآه القارئ
 */
export function mergeItems(prev: ActivityItem[], next: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const it of [...prev, ...next]) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
  return out.sort((a, b) => ms(b.at) - ms(a.at));
}

/** يوم اللحظة على جهاز القارئ — مفتاح التجميع */
export function dayKeyOf(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** تجميع البنود بأيامها بترتيبها كما هي (الأحدث أولاً) */
export function groupByDay(items: ActivityItem[]): { key: string; at: string; items: ActivityItem[] }[] {
  const out: { key: string; at: string; items: ActivityItem[] }[] = [];
  for (const it of items) {
    const key = dayKeyOf(it.at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(it);
    else out.push({ key, at: it.at, items: [it] });
  }
  return out;
}

/** معاملات الطلب: before وcategory وlimit حين تكون ذات معنى ('all' = بلا قسم) — مرآة GET /customers/:id/activity */
export function activityQuery(p?: { before?: string | null; category?: string | null; limit?: number | null }): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  if (p?.before) q.before = p.before;
  if (p?.category && p.category !== 'all') q.category = p.category;
  if (p?.limit != null && Number.isFinite(p.limit) && p.limit > 0) q.limit = Math.min(300, Math.floor(p.limit));
  return q;
}

// ═══ عرض الأرشيف: البحث و«من نفّذ» والأقدم أولاً (طلب المالك ٢١ نوفمبر ٢٠٢٦، أُعيد فوق السجلّ الثابت) ═══

/**
 * البحث والترشيح والترتيب في الواجهة وحدها فوق ما حُمّل من السجلّ — والسجلّ نفسه لا يتغيّر. ما دام أحدها فعّالاً تُحمَّل بقية
 * الصفحات تلقائياً حتى هذا السقف (فلا يغيب عن البحث ما لم يُحمَّل)، وما بعده يُذكر للقارئ صراحةً
 */
export const VIEW_LOAD_CAP = 2000;
/** حجم الصفحة في التحميل التلقائي (سقف الخادم ACTIVITY_MAX_LIMIT) */
export const VIEW_PAGE_LIMIT = 300;

/** «من نفّذ»: منفّذٌ بمعرّفه أو باسمه المحفوظ ودوره، أو مندوبٌ من «من خدم العميل» (repId) يشمل ما نُسب إليه في data.salesRepId */
export interface ActivityWho { key: string; kind: string; name: string | null; id?: string | null; repId?: string | null }
export interface ActivityView { q?: string; who?: ActivityWho | null; order?: 'desc' | 'asc' }

const trimName = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t && t !== '—' ? t : null;
};

/** منفّذ البند خياراً للترشيح — المفتاح بالمعرّف متى أرسله الخادم، وإلا بالدور والاسم المحفوظ */
export function whoOf(actor: ActivityItem['actor']): ActivityWho {
  const name = trimName(actor.name);
  const id = actor.id ?? null;
  return { key: id ? `${actor.kind}#${id}` : name ? `${actor.kind}:${name}` : actor.kind, kind: actor.kind, name, id };
}

/** مندوبٌ من «من خدم العميل» في الأرشيف (repsOf) خياراً للترشيح */
export function repWho(repId: string, name: string | null | undefined): ActivityWho {
  return { key: `REP@${repId}`, kind: 'REP', name: trimName(name), repId };
}

/** البند من عمل هذا المنفّذ؟ مندوب الأرشيف: بمعرّفه منفّذاً أو صاحبَ المستند (data.salesRepId)، أو باسمه المحفوظ مندوباً */
export function matchesWho(item: Pick<ActivityItem, 'actor' | 'data'>, who: ActivityWho): boolean {
  const a = item.actor;
  const name = trimName(a.name);
  if (who.repId) {
    if (a.id && a.id === who.repId) return true;
    const owner = item.data?.salesRepId;
    if (typeof owner === 'string' && owner === who.repId) return true;
    return a.kind === 'REP' && !!who.name && name === who.name;
  }
  if (who.id) return a.kind === who.kind && a.id === who.id;
  return a.kind === who.kind && name === who.name;
}

/** خيارات «من نفّذ»: مناديب الأرشيف أولاً (known) ثم كل منفّذٍ في البنود المحمّلة بترتيب ظهوره — بلا تكرار */
export function whoOptions(items: ActivityItem[], known: ActivityWho[] = []): ActivityWho[] {
  const out = [...known];
  const keys = new Set(known.map((w) => w.key));
  for (const it of items) {
    const w = whoOf(it.actor);
    if (keys.has(w.key)) continue;
    if (w.kind === 'REP' && known.some((k) => k.repId && ((w.id && k.repId === w.id) || (!!k.name && k.name === w.name)))) continue;
    keys.add(w.key);
    out.push(w);
  }
  return out;
}

/** عرضٌ فعّال (بحثٌ أو منفّذ أو الأقدم أولاً) — به يُحمَّل باقي السجلّ تلقائياً */
export function viewActive(v: ActivityView | null | undefined): boolean {
  return !!v && (normalizeSearch(v.q ?? '').length > 0 || !!v.who || v.order === 'asc');
}

const ch = (c: number) => String.fromCharCode(c);
// حروف التطبيع بأرقامها (لا محارف عربية خام في الكود): التشكيل والألف الخنجرية والتطويل، والهمزات، والألف المقصورة، والتاء المربوطة، والأرقام
const AR_MARKS = new RegExp(`[${ch(0x064B)}-${ch(0x065F)}${ch(0x0670)}${ch(0x0640)}]`, 'g');
const AR_ALEFS = new RegExp(`[${ch(0x0622)}${ch(0x0623)}${ch(0x0625)}${ch(0x0671)}]`, 'g');
const AR_MAQSURA = new RegExp(ch(0x0649), 'g');
const AR_MARBUTA = new RegExp(ch(0x0629), 'g');
const AR_DIGITS = new RegExp(`[${ch(0x0660)}-${ch(0x0669)}]`, 'g');
const FA_DIGITS = new RegExp(`[${ch(0x06F0)}-${ch(0x06F9)}]`, 'g');

/** تطبيعٌ للبحث العربي: بلا تشكيل ولا تطويل، والهمزات ألفاً، والألف المقصورة ياءً، والتاء المربوطة هاءً، والأرقام الهندية لاتينية */
export function normalizeSearch(s: string): string {
  return s.toLowerCase()
    .replace(AR_MARKS, '')
    .replace(AR_ALEFS, ch(0x0627))
    .replace(AR_MAQSURA, ch(0x064A))
    .replace(AR_MARBUTA, ch(0x0647))
    .replace(AR_DIGITS, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(FA_DIGITS, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/\s+/g, ' ')
    .trim();
}

/** حقول data النصّية التي يبحث فيها القارئ: الأسماء والأرقام والجهات */
const SEARCH_FIELDS = ['repName', 'salesRepName', 'adminName', 'productName', 'routeName', 'receiptNo', 'invoiceNo', 'originalInvoiceNo',
  'chequeNumber', 'bankName', 'name', 'phone', 'fromName', 'toName', 'fromRep', 'toRep', 'fromTeam', 'customerName'] as const;

/** نصّ البحث في البند: الملاحظة ورقم المستند والسبب والمنفّذ وأسماء data وأصنافه وعنوانه (labelOf: عنوانه بلغة الواجهة) */
export function searchTextOf(item: ActivityItem, labelOf?: (item: ActivityItem) => string): string {
  const d: Record<string, unknown> = item.data ?? {};
  const parts: string[] = [actionLabel(item.action, { data: item.data })];
  if (labelOf) parts.push(labelOf(item));
  const note = noteOf(item);
  if (note) parts.push(note);
  if (item.refNo) parts.push(item.refNo);
  if (item.actor.name) parts.push(item.actor.name);
  for (const f of SEARCH_FIELDS) { const v = d[f]; if (typeof v === 'string' || typeof v === 'number') parts.push(String(v)); }
  const reason = str(d.reason);
  if (reason) parts.push(REASON_LABELS[reason] ?? reason);
  const rr = str(d.returnReason);
  if (rr) parts.push(RETURN_REASON_LABELS[rr] ?? rr);
  if (Array.isArray(d.items)) for (const x of d.items.slice(0, 30)) if (x && typeof x === 'object') { const n = (x as { productName?: unknown }).productName; if (typeof n === 'string') parts.push(n); }
  if (Array.isArray(d.allocations)) for (const x of d.allocations.slice(0, 10)) if (x && typeof x === 'object') { const n = (x as { invoiceNo?: unknown }).invoiceNo; if (typeof n === 'string') parts.push(n); }
  return parts.join(' | ');
}

/** نصّ البحث المطبَّع لكل بند — محفوظٌ ما بقي البند نفسه وبقيت دالّة العنوان (لغة الواجهة) */
const searchCache = new WeakMap<ActivityItem, { labelOf: unknown; text: string }>();
function cachedSearchText(item: ActivityItem, labelOf?: (item: ActivityItem) => string): string {
  const hit = searchCache.get(item);
  if (hit && hit.labelOf === labelOf) return hit.text;
  const text = normalizeSearch(searchTextOf(item, labelOf));
  searchCache.set(item, { labelOf, text });
  return text;
}

/**
 * العرض فوق البنود المحمّلة: «من نفّذ» ثم البحث (كل كلمةٍ في البند) ثم «الأقدم أولاً» — قلبٌ لترتيب الخادم نفسه لا فرزٌ جديد.
 * بلا عرضٍ فعّال تعود القائمة نفسها (المرجع ذاته)
 */
export function applyView(items: ActivityItem[], view: ActivityView | null | undefined, opts: { labelOf?: (item: ActivityItem) => string } = {}): ActivityItem[] {
  if (!viewActive(view)) return items;
  const v = view as ActivityView;
  const tokens = normalizeSearch(v.q ?? '').split(' ').filter(Boolean);
  let out = items;
  if (v.who) out = out.filter((it) => matchesWho(it, v.who as ActivityWho));
  if (tokens.length) out = out.filter((it) => { const hay = cachedSearchText(it, opts.labelOf); return tokens.every((t) => hay.includes(t)); });
  if (v.order === 'asc') out = [...out].reverse();
  return out;
}

// ═══ صور وقفة الزيارة في أرشيف اللوحة: مرّةً واحدة لكل وقفة ═══

/** سجلّات الزيارة التي يمثّلها البند: رأس الوقفة (refId) وسجلّاتها المدموجة (data.visitIds) — بلا تكرار */
export function visitSourcesOf(item: Pick<ActivityItem, 'refId' | 'data'>): string[] {
  const ids = Array.isArray(item.data?.visitIds) ? (item.data!.visitIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) : [];
  return [...new Set([...(item.refId ? [item.refId] : []), ...ids])];
}

/** فهرس صور الزيارات في الأرشيف: الوقفة المدموجة بمعرّف رأسها ⇒ صورها كلها، والصورة ⇒ سجلّها، والسجلّ ⇒ صوره */
export interface VisitPhotoIndex {
  stops: Map<string, string[]>;
  photoSource: Map<string, string>;
  sourcePhotos: Map<string, string[]>;
}

/**
 * صور بند الزيارة — كل صورةٍ تحت بندٍ واحد: صور سجلّات البند نفسه (المؤقّت والملاحظات المدموجة في data.visitIds)، وصور وقفة
 * الأرشيف التي رأسها أحد سجلّاته إلا ما عُرف أنه لسجلٍّ خارج البند (ملاحظةٌ لها بندها المستقلّ فتُرسم تحته وحده).
 * headId: رأس وقفة الأرشيف (موقعها وتسلّم المندوب) — null إن لم يكن البند رأس وقفة
 */
export function visitPhotoIdsOf(item: Pick<ActivityItem, 'refId' | 'data'>, idx: VisitPhotoIndex): { headId: string | null; photoIds: string[] } {
  const sources = visitSourcesOf(item);
  const mine = new Set(sources);
  const headId = sources.find((s) => idx.stops.has(s)) ?? null;
  const out = new Set<string>();
  if (headId) {
    for (const pid of idx.stops.get(headId) ?? []) {
      const src = idx.photoSource.get(pid);
      if (!src || mine.has(src)) out.add(pid);
    }
  }
  for (const s of sources) for (const pid of idx.sourcePhotos.get(s) ?? []) out.add(pid);
  return { headId, photoIds: [...out] };
}
