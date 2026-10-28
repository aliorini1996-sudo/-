/**
 * مزامنة «الربط البرمجي API» — ما تغيّر منذ لحظة، صفحةً صفحة، لكل مورد من بيانات الشركة.
 *
 * المفتاح يعمل على كل مسارات اللوحة (services/apiKeys.ts)، لكنها مسارات عرضٍ لا مزامنة: لا تعرف
 * «ما تغيّر منذ». فهنا لكل مورد قاعدة واحدة: `since` + مؤشّر صفحات (keyset على الطابع ثم المعرّف)،
 * فيعكس نظام الشركة التغييرات أولاً بأول بسحبٍ كل دقيقة دون إعادة قراءة كل شيء.
 *
 * الحقول **قائمة سماح صريحة لكل مورد** لا «كل الأعمدة ناقص»: عمودٌ سرّيّ يُضاف للمخطط غداً لا
 * يخرج تلقائياً. واختبار التغطية (api-sync.test.ts) يُفشل البناء حين يظهر عمودٌ في هذه الجداول لم
 * يُصنَّف سماحاً أو منعاً — فالإضافة تفرض قراراً لا تسرّباً صامتاً.
 *
 * دلالة `since` (تُكتب في المستند): خزّن `serverTime` من أول صفحة، واطلب التالية بـ since = serverTime − 3
 * دقائق. التداخل يغطّي المعاملات الطويلة (الطابع يُكتب عند تنفيذ الجملة لا عند الالتزام — حتى ١٢٠ ثانية
 * في حذف المندوب)، والتكرار يُعالَج بالمعرّف (upsert).
 */
import type { AdminPermission } from '../middleware/auth';

export type SyncMode =
  /** بطابع التعديل updatedAt — يلتقط الإنشاء والتعديل */
  | 'updated'
  /** بطابع الإنشاء createdAt — جداول تُنشأ ولا تُعدَّل */
  | 'created'
  /** الحضور: يُنشأ بالبصمة ويُكمَل بالانصراف (بلا updatedAt) — يُلتقط بأيّ الطابعين */
  | 'attendance'
  /** قائمة كاملة بالمعرّف — جداول صغيرة بلا طابع تعديل (since يُتجاهل) */
  | 'snapshot';

export interface SyncResource {
  /** اسمه في الرابط /api/v1/sync/<name> */
  name: string;
  /** مفوَّض Prisma */
  model: string;
  mode: SyncMode;
  /** صلاحية صاحب المفتاح المطلوبة — كما في صفحة المورد في اللوحة */
  permission: AdminPermission;
  /** يُحجب حين يُطفأ «النظام المحاسبي» للشركة (كاللوحة) */
  accounting?: boolean;
  /** يتطلّب ميزة مخزون الشركة */
  warehouse?: boolean;
  /** يتطلّب ميزة «لوكيشن» للشركة (Tenant.locationsEnabled) — كصفحتها في اللوحة (requireLocations) */
  locations?: boolean;
  /** عزل الشركة — مباشرة بعمود tenantId، أو عبر العميل والصنف معاً (أسعار العملاء بلا عمود شركة) */
  tenantPath: 'direct' | 'customerAndProduct';
  /** عمود الطابع إن خالف افتراض النمط — الزيارات بطابع الاستلام لا بطابع الجهاز */
  tsColumn?: string;
  select: Record<string, unknown>;
  /** أعمدة مقصودة بالمنع (سرّ أو ثقيل أو سباكة داخلية) — لاختبار التغطية وللمستند */
  denied: Readonly<Record<string, string>>;
  /** يُحذف حذفاً فعلياً في بعض المسارات — فيُذكر في المستند أن يُطابَق بـ /ids */
  hardDeletes: boolean;
}

const pick = (...cols: string[]) => Object.fromEntries(cols.map(c => [c, true]));

/* ——— قوائم الأعمدة (سماح) ——— */

const CUSTOMER_COLS = [
  'id', 'code', 'name', 'businessName', 'commercialReg', 'taxNumber', 'phone', 'altPhone', 'email', 'city', 'district',
  'address', 'lat', 'lng', 'channel', 'outletType', 'aiPlaceId', 'status', 'creditLimit', 'paymentDays', 'balance',
  'totalSales', 'totalCollected', 'createdBySalesRepId', 'createdAt', 'updatedAt', 'buyerType', 'buyerIdScheme',
  'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'countryCode',
];
const PRODUCT_COLS = [
  'id', 'code', 'name', 'barcode', 'unit', 'basePrice', 'taxPct', 'itemCode', 'itemCodeType', 'unitCode', 'status',
  'damagedReturnToStock', 'shelfLifeEnabled', 'shelfLifeValue', 'shelfLifeUnit', 'shelfLifeBasis', 'shelfLifeFromDate',
  'returnRuleEnabled', 'returnRuleMode', 'returnRuleMetric', 'returnRuleValue', 'deletedAt', 'categoryId', 'createdAt',
  'updatedAt', 'vatCategory', 'vatExemptionCode', 'vatExemptionReason',
];
const SALES_REP_COLS = [
  'id', 'name', 'phone', 'email', 'username', 'isActive', 'canCreateInvoice', 'canSellOnCredit', 'canSellOnInstallment',
  'canSellInCash', 'canEditInvoice', 'canDeleteInvoice', 'canCancelInvoice', 'canChangePrice', 'maxDiscountPct',
  'canSellBelowPrice', 'canCreateReceipt', 'canEditReceipt', 'canCancelReceipt', 'canAddCustomer', 'canEditCustomer',
  'canViewStatement', 'requireCustomerProximity', 'requireLocationOn', 'requirePunchAtCustomer', 'showCollectionBalance', 'createdAt', 'updatedAt',
  'canManageVanStock', 'canSellWithoutStock', 'canBeTracked', 'proximityRadiusM', 'punchRadiusM',
  'punchOutsideAction', 'requireBoundDevice', 'boundDeviceName', 'boundDeviceAt', 'shiftStart', 'shiftEnd', 'shiftDays',
  'requirePresenceCheck', 'showRouteOnMap',
  // «لوكيشن»: موقع المندوب الحاليّ (معرّف SalesLocation — null = بلا موقع)
  'locationId',
  // «التحصيل بالبطاقة»: نقطة بيع NearPay المسندة (TID — null = لا تحصيل بالبطاقة)
  'nearpayTid',
];
const INVOICE_COLS = [
  'id', 'number', 'customerId', 'salesRepId', 'type', 'status', 'returnReason', 'returnToStock', 'invoiceDate',
  'deliveryDate', 'dueDate', 'paymentPlan', 'notes', 'pricesIncludeTax', 'subtotal', 'discountPct', 'discountAmt',
  'taxAmt', 'total', 'paidAmt', 'remainingAmt', 'einvoiceProvider', 'einvoiceStatus', 'einvoiceUuid', 'einvoiceQr',
  'einvoiceSubmittedAt', 'einvoiceHash', 'einvoicePih', 'einvoiceIcv', 'einvoiceWarnings', 'createdAt', 'updatedAt',
  'zatcaPhase', 'documentKind', 'invoiceSubtype', 'issuedAt', 'originalInvoiceId', 'billingReference', 'noteReason',
  'teamId',
  // «لوكيشن»: ختم موقع المندوب وقت الإصدار (لقطة لا تتحرّك بنقله)
  'locationId',
];
const INVOICE_ITEM_COLS = [
  'id', 'productId', 'unitCost', 'qty', 'unitPrice', 'discountPct', 'discountAmt', 'taxPct', 'taxAmt', 'lineTotal', 'seq',
  'itemName', 'unitCode', 'vatCategory', 'vatExemptionCode', 'vatExemptionReason', 'creditedItemId', 'expiresAt',
  'returnExpired', 'expirySaleInvoiceId', 'returnOfItemId',
];
const RECEIPT_COLS = [
  'id', 'number', 'customerId', 'salesRepId', 'receiptDate', 'amount', 'paymentMethod', 'chequeNumber', 'bankName',
  'notes', 'status', 'createdAt', 'updatedAt', 'teamId',
  // «إدارة طرق الدفع»: مفتاح الطريقة المخصّصة (c_…) أو null — paymentMethod يبقى الأساس المحاسبي
  'paymentMethodKey',
];

const OFFLINE = 'سباكة العمل دون اتصال (مفتاح منع التكرار من الجهاز)';

export const SYNC_RESOURCES: readonly SyncResource[] = Object.freeze([
  {
    name: 'customers', model: 'customer', mode: 'updated', permission: 'canManageCustomers', tenantPath: 'direct', hardDeletes: true,
    select: pick(...CUSTOMER_COLS),
    denied: { tenantId: 'معروف من المفتاح', clientRef: OFFLINE, clientCreatedAt: OFFLINE },
  },
  {
    name: 'customer-assignments', model: 'customerAssignment', mode: 'snapshot', permission: 'canManageCustomers', tenantPath: 'direct', hardDeletes: true,
    select: pick('id', 'customerId', 'salesRepId', 'source', 'createdAt'),
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    // العزل بالعميل **والصنف**: مسار حفظ الأسعار لا يتحقّق أن الصنف من الشركة، فالعميل وحده لا يكفي
    name: 'customer-prices', model: 'customerPrice', mode: 'updated', permission: 'canManageCustomers', accounting: true, tenantPath: 'customerAndProduct', hardDeletes: true,
    select: pick('id', 'customerId', 'productId', 'price', 'createdAt', 'updatedAt'),
    denied: {},
  },
  {
    name: 'products', model: 'product', mode: 'updated', permission: 'canManageProducts', accounting: true, tenantPath: 'direct', hardDeletes: true,
    select: { ...pick(...PRODUCT_COLS), priceTiers: { select: pick('minQty', 'maxQty', 'price'), orderBy: { minQty: 'asc' } } },
    denied: { tenantId: 'معروف من المفتاح', image: 'صورة base64 ثقيلة — تُقرأ من GET /api/products/:id' },
  },
  {
    name: 'categories', model: 'productCategory', mode: 'snapshot', permission: 'canManageProducts', accounting: true, tenantPath: 'direct', hardDeletes: true,
    select: pick('id', 'name', 'createdAt'),
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    name: 'sales-reps', model: 'salesRep', mode: 'updated', permission: 'canManageSalesReps', tenantPath: 'direct', hardDeletes: true,
    select: pick(...SALES_REP_COLS),
    denied: {
      tenantId: 'معروف من المفتاح', passwordHash: 'بصمة كلمة مرور المندوب', fcmToken: 'رمز إشعارات جهاز المندوب',
      clientBundle: 'قياس داخلي لجاهزية الأجهزة', outboxPending: 'قياس داخلي', outboxTaxPending: 'قياس داخلي', outboxReportedAt: 'قياس داخلي',
      // الموقع اللحظي تحرسه صلاحية التتبّع (canManageTracking) في اللوحة لا صلاحية المناديب — فيُقرأ من /api/tracking/live
      lastLat: 'الموقع اللحظي — من مسار التتبّع بصلاحيته', lastLng: 'الموقع اللحظي — من مسار التتبّع بصلاحيته', lastSeenAt: 'الموقع اللحظي — من مسار التتبّع بصلاحيته',
      lastLocAt: 'الموقع اللحظي — من مسار التتبّع بصلاحيته',
      // معرّف جهاز البصمة المربوط سرٌّ يمنع البصمة بالنيابة — من يعرفه يستطيع انتحال الجهاز
      boundDeviceId: 'معرّف جهاز البصمة المربوط — كشفه يتيح انتحال الجهاز',
      tzOffsetMin: 'قياس داخلي لتوقيت جوال المندوب (التنبيهات)',
    },
  },
  {
    // «لوكيشن»: أسماء مواقع الشركة ونقاطها وأرشفتها — بها يُترجَم locationId في المناديب والفواتير والتحميلات. إعادة التسمية
    // والأرشفة لا تمسّان المستندات المختومة (الختم معرّفٌ لا اسم) فلا تصلان إلا من هنا، وكلتاهما update تحرّك updatedAt.
    // الحذف الفعلي لموقعٍ بلا مناديب ولا مستندات وحده (ما عليه مستندات يُؤرشف) ⇒ يُطابَق بـ/ids.
    // الصلاحية صلاحية المناديب (المورد الذي يحمل موقع المندوب)، والبوّابة بوّابة الصفحة: المحاسبة ثم عَلَم الميزة
    name: 'locations', model: 'salesLocation', mode: 'updated', permission: 'canManageSalesReps', accounting: true, locations: true, tenantPath: 'direct', hardDeletes: true,
    select: pick('id', 'name', 'lat', 'lng', 'isActive', 'createdAt', 'updatedAt'),
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    // «الفرق»: أسماء الفرق وأرشفتها وأعضاؤها وأصنافها — بها يُترجَم teamId في الفواتير والسندات والزيارات والاستلامات.
    // قائمة كاملة (snapshot) لا «منذ»: تعديل أصناف الفريق صفوفٌ في جدول الربط تحرّك updatedAt الأصناف لا الفريق، فكان
    // «منذ» سيُفوّتها — والجدول صغير (فرق الشركة). بلا مشرفي الفرق: هم مستخدمو الشركة، وإدارتهم ممنوعة على المفتاح (/company-users).
    // بلا بوّابة عَلَم كصفحتها في اللوحة (GET /api/company/teams لأي مستخدم شركة) — والإطفاء يُبقي الفرق محفوظة
    name: 'teams', model: 'team', mode: 'snapshot', permission: 'canManageSalesReps', tenantPath: 'direct', hardDeletes: true,
    select: {
      ...pick('id', 'name', 'isActive', 'createdAt', 'updatedAt'),
      members: { select: pick('salesRepId'), orderBy: { salesRepId: 'asc' } },
      products: { select: pick('productId'), orderBy: { productId: 'asc' } },
    },
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    name: 'invoices', model: 'invoice', mode: 'updated', permission: 'canManageInvoices', accounting: true, tenantPath: 'direct', hardDeletes: false,
    select: {
      ...pick(...INVOICE_COLS),
      items: { select: pick(...INVOICE_ITEM_COLS), orderBy: [{ seq: 'asc' }, { id: 'asc' }] },
      installments: { select: pick('seq', 'dueDate', 'amount'), orderBy: { seq: 'asc' } },
    },
    denied: {
      tenantId: 'معروف من المفتاح', clientRef: OFFLINE, clientCreatedAt: OFFLINE,
      orderType: 'بقايا وحدة المطاعم المحذوفة', serviceChargeAmt: 'بقايا وحدة المطاعم المحذوفة', tipAmt: 'بقايا وحدة المطاعم المحذوفة', shiftId: 'بقايا وحدة المطاعم المحذوفة',
      einvoiceSnapshot: 'لقطة XML الفاتورة الإلكترونية — ثقيلة؛ المستند الضريبي من مسارات الفوترة الإلكترونية',
    },
  },
  {
    name: 'receipts', model: 'receipt', mode: 'updated', permission: 'canManageReceipts', accounting: true, tenantPath: 'direct', hardDeletes: false,
    select: { ...pick(...RECEIPT_COLS), invoiceItems: { select: pick('invoiceId', 'amount') } },
    denied: { tenantId: 'معروف من المفتاح', clientRef: OFFLINE, clientCreatedAt: OFFLINE },
  },
  {
    // بطابع التعديل: الرصيد المتحرّك يُعاد حسابه (تراجع الاستيراد) وentryDate يُزاح (تغيير منطقة الدفاتر) بعد الإنشاء
    name: 'account-entries', model: 'accountEntry', mode: 'updated', permission: 'canManageCustomers', accounting: true, tenantPath: 'direct', hardDeletes: true,
    select: pick('id', 'customerId', 'invoiceId', 'receiptId', 'type', 'debit', 'credit', 'balance', 'description', 'entryDate', 'createdAt', 'updatedAt'),
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    // بطابع التعديل: حذف المندوب يفرّغ salesRepId ويملأ deletedSalesRepId بعد الإنشاء
    name: 'van-loads', model: 'vanLoad', mode: 'updated', permission: 'canManageVanStock', accounting: true, tenantPath: 'direct', hardDeletes: false,
    select: { ...pick('id', 'salesRepId', 'deletedSalesRepId', 'locationId', 'type', 'note', 'createdBy', 'createdAt', 'updatedAt'), items: { select: pick('productId', 'qty', 'suggestedQty', 'expectedQty') } },
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    name: 'warehouse-entries', model: 'warehouseEntry', mode: 'created', permission: 'canManageVanStock', accounting: true, warehouse: true, tenantPath: 'direct', hardDeletes: true,
    select: { ...pick('id', 'type', 'note', 'supplier', 'createdBy', 'createdAt'), items: { select: pick('productId', 'qty', 'unitCost') } },
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    // بطابع الاستلام: createdAt من الجهاز للملتقط دون اتصال فقد يسبق رفعه بساعات فيقع خلف المؤشّر
    name: 'visits', model: 'repVisit', mode: 'created', tsColumn: 'receivedAt', permission: 'canManageTracking', tenantPath: 'direct', hardDeletes: true,
    select: { ...pick('id', 'salesRepId', 'customerId', 'note', 'lat', 'lng', 'createdAt', 'receivedAt', 'startedAt', 'endedAt', 'durationSec', 'teamId'), _count: { select: { photos: true } } },
    denied: { tenantId: 'معروف من المفتاح', clientRef: OFFLINE },
  },
  {
    name: 'attendance', model: 'repAttendance', mode: 'attendance', permission: 'canManageTracking', tenantPath: 'direct', hardDeletes: true,
    select: pick('id', 'salesRepId', 'checkInAt', 'checkInLat', 'checkInLng', 'checkOutAt', 'checkOutLat', 'checkOutLng', 'createdAt',
      'checkInDevice', 'checkOutDevice', 'checkInOutside', 'checkInDistanceM', 'checkOutOutside', 'checkOutDistanceM', 'source', 'editedAt', 'editedBy'),
    denied: {
      tenantId: 'معروف من المفتاح',
      checkInDeviceId: 'معرّف جهاز البصمة — كشفه يتيح انتحال الجهاز', checkOutDeviceId: 'معرّف جهاز البصمة — كشفه يتيح انتحال الجهاز',
    },
  },
  {
    name: 'settlements', model: 'repSettlement', mode: 'created', permission: 'canManageSalesReps', tenantPath: 'direct', hardDeletes: true,
    select: pick('id', 'salesRepId', 'amount', 'method', 'note', 'createdBy', 'receivedByUserId', 'settledAt', 'createdAt', 'teamId'),
    denied: { tenantId: 'معروف من المفتاح' },
  },
  {
    name: 'routes', model: 'repRoute', mode: 'updated', permission: 'canManageTracking', tenantPath: 'direct', hardDeletes: true,
    select: { ...pick('id', 'salesRepId', 'name', 'isPermanent', 'routeDate', 'isActive', 'createdAt', 'updatedAt'), stops: { select: pick('customerId', 'seq', 'note'), orderBy: { seq: 'asc' } } },
    denied: { tenantId: 'معروف من المفتاح' },
  },
] as SyncResource[]);

export const syncResource = (name: string): SyncResource | undefined => SYNC_RESOURCES.find(r => r.name === name);

/** عمود الطابع الذي تُرتَّب به صفحات المورد */
export function cursorColumn(def: Pick<SyncResource, 'mode' | 'tsColumn'>): string {
  if (def.tsColumn) return def.tsColumn;
  return def.mode === 'updated' ? 'updatedAt' : def.mode === 'snapshot' ? 'id' : 'createdAt';
}

export const SYNC_DEFAULT_LIMIT = 100;
export const SYNC_MAX_LIMIT = 500;
export const IDS_MAX_LIMIT = 5000;

export function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  // ١ على الأقل: limit=0.5 كان يصير صفراً فتردّ الصفحة hasMore بلا صفوف ولا مؤشّر — حلقةٌ لا تنتهي عند العميل
  return Math.min(Math.max(1, Math.floor(n)), max);
}

/** تاريخٌ ضمن مدى معقول — سنةٌ موسّعة (+010000) يقبلها Date.parse وترفضها القاعدة فتصير 500 بدل 400 */
const saneDate = (t: number): boolean => {
  const y = new Date(t).getUTCFullYear();
  return y >= 1970 && y <= 2200;
};

export interface SyncCursor { r: string; t: string | null; i: string }

/** المؤشّر غير شفّاف للعميل: base64url لـ {المورد، الطابع، المعرّف} — ومورده يُفحص فلا يُستعمل لمورد آخر */
export const encodeCursor = (c: SyncCursor): string => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

export function decodeCursor(raw: unknown, resource: string): SyncCursor | null | 'invalid' {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 400) return 'invalid';
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SyncCursor;
    if (!c || c.r !== resource || typeof c.i !== 'string' || !c.i) return 'invalid';
    if (c.t !== null && (typeof c.t !== 'string' || Number.isNaN(Date.parse(c.t)) || !saneDate(Date.parse(c.t)))) return 'invalid';
    if (c.i.length > 64) return 'invalid';
    return c;
  } catch { return 'invalid'; }
}

/** `since` بصيغة ISO-8601 — أو null بلا قيد، أو 'invalid' (ومنها قيمةٌ ليست نصّاً: since[gt]=… أو مصفوفة) */
export function parseSince(raw: unknown): Date | null | 'invalid' {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return 'invalid';
  const t = Date.parse(raw);
  return Number.isNaN(t) || !saneDate(t) ? 'invalid' : new Date(t);
}

/**
 * عزل الشركة لاستعلام المورد. والمعرّف الفارغ **يرمي** لا يُمرَّر: في Prisma `{ tenantId: undefined }`
 * يعني «بلا قيد» فيعيد صفوف كل الشركات — والفارغ هنا خللٌ في السياق لا طلبُ «لا شيء».
 */
export function tenantWhere(def: SyncResource, tenantId: string): Record<string, unknown> {
  if (typeof tenantId !== 'string' || !tenantId) throw new Error('لا توجد شركة مرتبطة بالمفتاح');
  if (def.tenantPath === 'customerAndProduct') return { customer: { tenantId }, product: { tenantId } };
  return { tenantId };
}

/** شرط «منذ» لكل نمط — الحضور يُلتقط بالبصمة أو بالانصراف */
export function sinceWhere(def: SyncResource, since: Date | null): Record<string, unknown> | null {
  if (!since || def.mode === 'snapshot') return null;
  // والتعديل الإداري (editedAt) يغيّر بصمةً قديمة — فيُعاد إرسالها مع ما تغيّر منذ آخر مزامنة
  if (def.mode === 'attendance') return { OR: [{ checkInAt: { gte: since } }, { checkOutAt: { gte: since } }, { createdAt: { gte: since } }, { editedAt: { gte: since } }] };
  return { [cursorColumn(def)]: { gte: since } };
}

/** ما بعد المؤشّر في ترتيب (الطابع، المعرّف) — الطابع وحده يُسقط صفوفاً تتشارك طابعاً واحداً (تحديثٌ جماعيّ) */
export function afterCursorWhere(def: SyncResource, c: SyncCursor | null): Record<string, unknown> | null {
  if (!c) return null;
  const col = cursorColumn(def);
  if (col === 'id') return { id: { gt: c.i } };
  const t = new Date(c.t as string);
  return { OR: [{ [col]: { gt: t } }, { [col]: t, id: { gt: c.i } }] };
}

export function orderByFor(def: SyncResource): Record<string, 'asc'>[] {
  const col = cursorColumn(def);
  return col === 'id' ? [{ id: 'asc' }] : [{ [col]: 'asc' }, { id: 'asc' }];
}

/** الصفّ يُرسل كما هو — عدا `_count` الداخلي يُسمّى باسمه في المستند */
export function shapeRow(def: SyncResource, row: Record<string, unknown>): Record<string, unknown> {
  if (def.name === 'visits' && row._count && typeof row._count === 'object') {
    const { _count, ...rest } = row;
    return { ...rest, photoCount: (_count as { photos?: number }).photos ?? 0 };
  }
  return row;
}
