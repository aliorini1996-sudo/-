import type { InvoiceItemLotDto } from '../lib/lots';

export interface User {
  id: string;
  name: string;
  email?: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'SALES_REP' | 'PLATFORM_STAFF';
  /** موظف المنصة (PLATFORM_STAFF): مفاتيح ما منحه المالك (lib/platformAccess.ts) */
  permissions?: string[];
  /** موظف المنصة بكلمة مرور مؤقتة — لا يصل أي قسم حتى يغيّرها */
  mustChangePassword?: boolean;
  tenantId?: string;
  companyName?: string;
  emailVerified?: boolean;
  username?: string;
  canCreateReceipt?: boolean;
  canAccessDashboard?: boolean;
  canManageCustomers?: boolean;
  canManageProducts?: boolean;
  canManageSalesReps?: boolean;
  canManageInvoices?: boolean;
  canManageReceipts?: boolean;
  canViewReports?: boolean;
  canManageVanStock?: boolean;
  canManageTracking?: boolean;
  canManageCompanySettings?: boolean;
  canManageDailyReport?: boolean;
  canManageCompanyUsers?: boolean;
  /** استلام عهدة التحصيل من مستخدمي الشركة — تُقرأ من جلسة الدخول لإظهار الأيقونة */
  canReceiveUserCollections?: boolean;
  /** صلاحية الحذف — false تمنع كل حذف (يحرسها الخادم)، والغائب سماح */
  canDelete?: boolean;
  // صلاحيات الدفاتر — تُقرأ بـcanLedger (true الصريحة وحدها، والغائب منع)
  canViewLedger?: boolean;
  canPostJournals?: boolean;
  canManagePayables?: boolean;
  canManageBank?: boolean;
  canCloseLedgerPeriods?: boolean;
  canConfigureLedger?: boolean;
  scopeEnabled?: boolean; // مقيّد النطاق لا يرى الدفاتر (LEDGER_SCOPED_ADMIN)
}

export interface Tenant {
  id: string;
  name: string;
  isActive: boolean;
  maxSalesReps?: number | null; // null = عدد مناديب غير محدود
  maxAdminUsers?: number | null; // null = عدد مستخدمي شركة غير محدود
  erpEnabled?: boolean;          // صلاحية ربط ERP (يتحكّم بها المالك)
  petroappEnabled?: boolean;     // صلاحية ربط بترو آب (يتحكّم بها المالك)
  hatifEnabled?: boolean;        // ميزة أرقام العمل وربط هاتف (يتحكّم بها المالك)
  catalogEnabled?: boolean;      // ميزة منيو المنتجات العام (يتحكّم بها المالك)
  paylinkEnabled?: boolean;      // ميزة الدفع الإلكتروني — روابط دفع ميسر (يتحكّم بها المالك)
  warehouseEnabled?: boolean;    // مخزون الشركة (المستودع) — يُفعّله المالك لكل شركة
  dailyReportEnabled?: boolean;  // التقرير اليومي وسلسلة اعتماده — يُفعّله المالك لكل شركة
  attendanceEnabled?: boolean;   // بصمة الحضور والانصراف للمندوب — يُفعّله المالك لكل شركة
  invoiceSignatureEnabled?: boolean; // توقيع المستلم اليدويّ على فواتير المندوب — يُفعّله المالك لكل شركة
  zatcaPhase2Enabled?: boolean;  // تبويب ربط فوترة ZATCA المرحلة الثانية — مطفأ افتراضياً، يُفعّله المالك لكل شركة سعودية
  aiRepEnabled?: boolean;        // المندوب الذكي AI — مطفأ افتراضياً، يُفعّله المالك لكل شركة
  apiEnabled?: boolean;          // الربط البرمجي API — مطفأ افتراضياً، يُفعّله المالك لكل شركة
  paymentMethodsEnabled?: boolean; // صفحة «طرق الدفع» (تحصيل المناديب لكل طريقة دفع) — مطفأة افتراضياً، يُفعّلها المالك لكل شركة
  cardPayEnabled?: boolean;       // «التحصيل بالبطاقة» عبر NearPay — مطفأ افتراضياً، يُفعّله المالك لكل شركة
  nearpayMerchantId?: string | null; // تاجر الشركة لدى NearPay (المال يذهب إليه مباشرة)
  locationsEnabled?: boolean;     // «لوكيشن» (مواقع الشركة وختم الفواتير والتحميلات بموقع المندوب) — مطفأة افتراضياً، يُفعّلها المالك لكل شركة
  lotTrackingEnabled?: boolean;   // «تتبّع اللوط» (التشغيلات) — مطفأ افتراضياً، يُفعّله المالك لكل شركة (lib/lots.ts)
  lotTrackingSince?: string | null; // بداية الحقبة — مضبوطٌ والعلم مطفأ ⇒ إعادة التفعيل تبدأ حقبة جديدة (D8)
  receivablesSummaryEnabled?: boolean; // سطر «إجمالي مديونية العملاء المُسنَدين» — يُفعّله المالك لكل شركة
  accountingEnabled?: boolean;   // النظام المحاسبي (منتجات · مخزون · فواتير · سندات) — مفعّل افتراضياً، وغيابه يعني مفعّل
  accountingSuiteEnabled?: boolean; // النظام المحاسبي المتكامل (الدفاتر) — مطفأ افتراضياً، وغيابه يعني مطفأ
  ledgerStatus?: 'OFF' | 'PENDING_SETUP' | 'RUNNING' | 'STUCK'; // حالة الدفاتر في بطاقة الشركة (M3، §8.1) — يحسبها الخادم
  ledgerActivatedAt?: string | null; // GlSettings.activatedAt — مضبوط ⇒ للشركة دفاتر مفعّلة ولو أُطفئت الميزة لاحقاً
  subscriptionEndsAt?: string | null;
  notes?: string | null;
  createdAt: string;
  admins?: { id?: string; name: string; email: string; isActive?: boolean }[];
  _count?: { admins?: number; salesReps?: number; customers?: number; invoices?: number; receipts?: number; products?: number };
}

export type LeadStage = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'PROPOSAL' | 'WON' | 'LOST';

export interface Lead {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  countryCode?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  mapsUrl?: string | null;
  source: string; // manual | csv | osm | google | social | api
  stage: LeadStage;
  score?: number | null;
  scoreNote?: string | null;
  assignedTo?: string | null;
  convertedTenantId?: string | null;
  notes?: string | null;
  lastContactedAt?: string | null;
  nextFollowUpAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  activities?: LeadActivity[];
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: string; // NOTE | CALL | EMAIL | MEETING | STAGE_CHANGE | SCORE | IMPORT
  content?: string | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface LeadStats {
  total: number;
  won: number;
  due: number;
  conversion: number;
  stages: Record<LeadStage, number>;
  sources: { source: string; count: number }[];
  countries: { countryCode: string; count: number }[];
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'ACCOUNTANT';
  isActive: boolean;
  canAccessDashboard: boolean;
  canManageCustomers: boolean;
  canManageProducts: boolean;
  canManageSalesReps: boolean;
  canManageInvoices: boolean;
  canManageReceipts: boolean;
  canViewReports: boolean;
  canManageVanStock: boolean;
  canManageTracking: boolean;
  canManageCompanySettings: boolean;
  canManageDailyReport: boolean;
  canManageCompanyUsers: boolean;
  /** استلام (توريد) عهدة التحصيل من مستخدمي الشركة — مطفأة افتراضياً */
  canReceiveUserCollections?: boolean;
  /** صلاحية الحذف — true افتراضاً */
  canDelete?: boolean;
  /** رصيد عهدة التحصيل لدى المستخدم — يحسبه الخادم في قائمة المستخدمين */
  custody?: number;
  canViewLedger?: boolean;
  canPostJournals?: boolean;
  canManagePayables?: boolean;
  canManageBank?: boolean;
  canCloseLedgerPeriods?: boolean;
  canConfigureLedger?: boolean;
  createdAt: string;
}

export interface ErpIntegration {
  id?: string;
  enabled: boolean;
  provider: 'CUSTOM' | 'ODOO' | 'SAP' | 'ZOHO' | 'OTHER';
  baseUrl?: string | null;
  authType: 'NONE' | 'API_KEY' | 'BEARER' | 'BASIC';
  basicUsername?: string | null;
  customersEndpoint?: string | null;
  productsEndpoint?: string | null;
  invoicesEndpoint?: string | null;
  receiptsEndpoint?: string | null;
  syncCustomers: boolean;
  syncProducts: boolean;
  syncInvoices: boolean;
  syncReceipts: boolean;
  lastSyncAt?: string | null;
  hasApiKey?: boolean;
  hasBearerToken?: boolean;
  hasBasicPassword?: boolean;
  /** مزامنة تعمل الآن في الخلفية لهذه الشركة */
  syncRunning?: boolean;
}

export interface ErpSyncLog {
  id: string;
  resource: string;
  direction: string;
  /** PARTIAL: وصلت الدفعات وتعذّرت صفوف بعينها (تفاصيلها في الرسالة) */
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  count: number;
  message?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  businessName?: string;
  commercialReg?: string;
  taxNumber?: string;
  phone: string;
  altPhone?: string;
  email?: string;
  city?: string;
  district?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  channel?: 'MT' | 'WHOLESALE' | 'TT' | 'DISCOUNTER' | 'CASH_VAN' | 'ECOMMERCE' | null;
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  creditLimit: number;
  paymentDays: number;
  balance: number;
  totalSales: number;
  totalCollected: number;
  createdAt: string;
  // فوترة ZATCA المرحلة الثانية — بيانات المشتري (D2؛ أعمدة قائمة، تُعرض وتُحرَّر لشركة تجمعها فقط — lib/zatcaRegime.ts)
  buyerType?: 'BUSINESS' | 'INDIVIDUAL' | 'GOVERNMENT' | null;
  buyerIdScheme?: string | null;
  buyerIdValue?: string | null;
  addrStreet?: string | null;
  addrBuildingNo?: string | null;
  addrAdditionalNo?: string | null;
  addrPostalCode?: string | null;
  countryCode?: string | null;
}

/** وحدة بيعٍ للصنف أكبر من وحدة الأساس (كرتون = ٢٤ حبة). الصفوف تحمل لقطتها لا مرجعاً إليها. */
export interface ProductUnit {
  id: string;
  productId?: string;
  name: string;
  /** عدد وحدات الأساس فيها — صحيحٌ موجب */
  factor: number;
  /** سعرها؛ null ⇒ سعر الأساس × المعامل */
  price?: number | null;
  unitCode?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface Product {
  id: string;
  code: string;
  name: string;
  barcode?: string;
  /** وحدة الأساس — أصغر ما يُباع منه */
  unit: string;
  /** سعر وحدة الأساس */
  basePrice: number;
  /** وحدات البيع الأكبر (الوحدات المتعددة) — فارغةٌ ⇒ صنفٌ بوحدةٍ واحدة */
  units?: ProductUnit[];
  taxPct: number;
  image?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  damagedReturnToStock?: boolean; // سياسة: هل يعود مرتجع الصنف التالف للمخزون؟
  // صلاحية الصنف من تاريخ البيع — اختيارية (للمرتجع: هل عاد منتهي الصلاحية)
  shelfLifeEnabled?: boolean;
  shelfLifeValue?: number | null;
  shelfLifeUnit?: 'DAY' | 'MONTH' | 'YEAR' | null;
  // أساس الحساب: البيع | الشراء بتاريخٍ يُكتب في الصنف | تحميل سيارة المندوب (الأقدم يُصرف أولاً)
  shelfLifeBasis?: 'SALE' | 'PURCHASE' | 'VAN_LOAD';
  shelfLifeFromDate?: string | null;
  // قيد المرتجع لصنف الصلاحية: لا يقبل مرتجعه إلا قرب الانتهاء أو وهو ما زال صالحاً، بالأيام أو بالنسبة
  returnRuleEnabled?: boolean;
  returnRuleMode?: 'NEAR_EXPIRY' | 'STILL_VALID' | null;
  returnRuleMetric?: 'DAYS' | 'PERCENT' | null;
  returnRuleValue?: number | null;
  // «تتبّع باللوط» — لا أثر إلا مع Tenant.lotTrackingEnabled؛ lotTrackedSince بداية حقبة الصنف (D25)
  lotTracked?: boolean;
  // «قيود المندوب» (backend/src/services/repProductRules.ts): ما يفعله المندوب وحده بالصنف — الغياب بلا قيد
  repSaleAllowed?: boolean;
  repReturnAllowed?: boolean;
  repSaleUnit?: 'ANY' | 'BASE' | 'LARGE';
  repReturnUnit?: 'ANY' | 'BASE' | 'LARGE';
  lotTrackedSince?: string | null;
  categoryId?: string;
  category?: { id: string; name: string };
  priceTiers?: PriceTier[];
  itemCode?: string | null;     // كود الصنف للفوترة الإلكترونية (EGS/GS1)
  itemCodeType?: 'EGS' | 'GS1' | null;
  unitCode?: string | null;     // كود الوحدة حسب جدول المزوّد
  // فوترة ZATCA المرحلة الثانية — الفئة الضريبية (Z5.1a؛ تُحرَّر لشركة تجمع بيانات الفوترة فقط — lib/zatcaRegime.ts)
  vatCategory?: 'S' | 'Z' | 'E' | 'O' | null;
  vatExemptionCode?: string | null;
  vatExemptionReason?: string | null;
}

export interface PriceTier {
  id: string;
  minQty: number;
  maxQty?: number;
  price: number;
}

export interface SalesRep {
  id: string;
  name: string;
  phone: string;
  email?: string;
  username: string;
  isActive: boolean;
  canCreateInvoice: boolean;
  canSellOnCredit: boolean;
  canSellOnInstallment?: boolean; // البيع بالتقسيط — إذن مستقل فوق الآجل
  canSellInCash: boolean;
  canEditInvoice: boolean;
  canDeleteInvoice: boolean;
  canCancelInvoice: boolean;
  canChangePrice: boolean;
  maxDiscountPct: number;
  canSellBelowPrice: boolean;
  canCreateReceipt: boolean;
  canEditReceipt: boolean;
  canCancelReceipt: boolean;
  canManageVanStock: boolean;
  canAddCustomer: boolean;
  canEditCustomer: boolean;
  canViewStatement: boolean;
  showCollectionBalance?: boolean;
  requireCustomerProximity?: boolean; // «البيع داخل نطاق العميل» — تقييديّ: true يعني مقيَّد
  requireLocationOn?: boolean; // «اشتراط تفعيل الموقع» — تقييديّ: والموقع مطفأ لا يعمل المندوب شيئاً
  requirePunchAtCustomer?: boolean; // «بصمة الحضور بموقع عميل» — تقييديّ: لا بصمة إلا داخل مسافته من عميل
  proximityRadiusM?: number; // مسافة «البيع داخل نطاق العميل» بالأمتار (١٠–٥٠٠٠، ٥٠ افتراضاً)
  punchRadiusM?: number;     // مسافة «بصمة الحضور بموقع عميل» بالأمتار (١٠–٥٠٠٠، ٥٠ افتراضاً)
  punchOutsideAction?: 'REJECT' | 'FLAG'; // البصمة خارج النطاق: تُردّ، أو تُقبل بوسم «خارج النطاق»
  requireBoundDevice?: boolean; // «ربط البصمة بجهاز واحد» — تقييديّ ضد البصمة بالنيابة
  requirePresenceCheck?: boolean; // «التحقق العشوائي من التواجد» — «أثبت تواجدك» مرّتين إلى ثلاث يومياً
  showRouteOnMap?: boolean; // «عرض خط السير على الخريطة» — مطفأٌ ⇒ لا يُرسم أثره على خريطة التتبّع (الغائب = مفعّل)
  boundDeviceName?: string | null; boundDeviceAt?: string | null; // الجهاز المربوط (يربطه أول بصمة)
  shiftStart?: string | null; shiftEnd?: string | null; // موعد الدوام "HH:MM" — للتنبيهات وحدها
  shiftDays?: number; // أيام العمل بتات: الأحد=1 … السبت=64 (الأحد–الخميس=31)
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  productId: string;
  product: { id: string; name: string; code: string; unit: string };
  qty: number;
  /** لقطة وحدة البند: null ⇒ وحدة الأساس (product.unit) */
  unitName?: string | null;
  /** عدد وحدات الأساس في وحدة البند — ١ لوحدة الأساس */
  unitFactor?: number | null;
  /** الكمية بوحدة الأساس = qty × unitFactor */
  baseQty?: number | null;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  taxPct: number;
  taxAmt: number;
  lineTotal: number;
  // صلاحية الصنف من تاريخ البيع: لبند البيع تاريخ انتهاء ما بيع، ولبند المرتجع انتهاء البيع الذي قيس عليه
  // و«هل عاد بعد انتهائه» (null = غير معروف: صنفٌ بلا صلاحية أو بلا بيعٍ سابق)
  expiresAt?: string | null;
  returnExpired?: boolean | null;
  // «تتبّع اللوط»: توزيع البند على التشغيلات بالكمية الأساسية — مع withLots=1 أو ردّ الإصدار، وغيابه = بلا تشغيلات
  lots?: InvoiceItemLotDto[];
}

export interface Invoice {
  id: string;
  number: string;
  customer: { id: string; name: string; phone: string };
  // null حين يُحذف المندوب (onDelete: SetNull) — والقراءة بلا ?. كانت تُسقط الصفحة بيضاء
  salesRep: { id: string; name: string } | null;
  type: 'CASH' | 'CREDIT' | 'RETURN';
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  returnReason?: 'NORMAL' | 'DAMAGED' | 'EXCHANGE' | null;
  returnToStock?: boolean;
  invoiceDate: string;
  /** موعد تسليم اختياريّ يحدّده مُصدِر الفاتورة — غيابه يعني «لا موعد» */
  deliveryDate?: string | null;
  dueDate?: string;
  notes?: string;
  subtotal: number;
  discountPct: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
  paidAmt: number;
  remainingAmt: number;
  items?: InvoiceItem[];
  createdAt: string;
  // لحظة إصدار الفاتورة على جهاز المندوب (تسبق الرفع بساعات في العمل دون اتصال)
  clientCreatedAt?: string | null;
  einvoiceProvider?: string | null;
  einvoiceStatus?: string | null;
  einvoiceUuid?: string | null;
  // فوترة ZATCA المرحلة الثانية (Z5.0 أنواع فقط — null لكل فاتورة قديمة أو مرحلة أولى؛ المرجع zatcaPhase لا einvoiceStatus)
  einvoiceQr?: string | null;
  einvoiceHash?: string | null;
  einvoiceIcv?: number | null;
  einvoiceWarnings?: string | null;
  zatcaPhase?: number | null;
  documentKind?: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | null;
  invoiceSubtype?: '01' | '02' | null;
  issuedAt?: string | null;
  originalInvoiceId?: string | null;
  billingReference?: string | null;
  noteReason?: string | null;
  // «لوكيشن»: ختم موقع المندوب وقت الإصدار — null لمندوبٍ بلا موقع ولكل فاتورة قبل تفعيل الميزة
  locationId?: string | null;
  location?: { id: string; name: string } | null;
  einvoiceSnapshot?: unknown;
}

export interface Receipt {
  id: string;
  number: string;
  customer: { id: string; name: string };
  // null حين يُحذف المندوب (onDelete: SetNull) — والقراءة بلا ?. كانت تُسقط الصفحة بيضاء
  salesRep: { id: string; name: string } | null;
  receiptDate: string;
  // لحظة إصدار السند على جهاز المندوب (تسبق الرفع بساعات في العمل دون اتصال)
  clientCreatedAt?: string | null;
  amount: number;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE' | 'ONLINE';
  // «إدارة طرق الدفع»: مفتاح الطريقة المخصّصة (c_…) أو null لمدمجة — paymentMethod يبقى الأساس الذي تُبنى عليه القيود،
  // والمفتاح للاسم وحده (methodLabelFor في lib/paymentMethodsConfig.ts)
  paymentMethodKey?: string | null;
  chequeNumber?: string;
  bankName?: string;
  notes?: string;
  status: 'ACTIVE' | 'CANCELLED';
  createdAt: string;
}

export interface AccountEntry {
  id: string;
  type: string;
  debit: number;
  credit: number;
  balance: number;
  description: string;
  entryDate: string;
  invoice?: { number: string; items?: { qty: number; product: { name: string; unit?: string } }[] };
  receipt?: { number: string };
}

export interface Pagination {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  pagination?: Pagination;
}

export interface DashboardStats {
  today: { salesTotal: number; invoicesCount: number; collectionsTotal: number; receiptsCount: number };
  month: { salesTotal: number; invoicesCount: number; collectionsTotal: number; receiptsCount: number; purchasesTotal?: number; purchaseEntriesCount?: number };
  /** ميزة مخزون الشركة مفعّلة؟ — عندها تظهر بطاقة المشتريات الشهرية */
  warehouseEnabled?: boolean;
  customers: { total: number; withBalance: number; creditExceeded: number };
  topReps: { id: string; name: string; invoicesCount: number; salesTotal: number; collectionsTotal: number }[];
  topCustomers: { id: string; name: string; totalSales: number; balance: number }[];
  recentInvoices: Invoice[];
}

// ─── ربط فوترة ZATCA المرحلة الثانية (/api/zatca) — أشكال الردود كما يرسلها الخادم (routes/zatca.ts) ───

export type ZatcaEnv = 'sandbox' | 'simulation' | 'production';

export type ZatcaUnitStatus =
  | 'DRAFT' | 'CSR_READY' | 'CCSID_ISSUED' | 'CHECKS_RUNNING' | 'CHECKS_PASSED' | 'ERROR_NEEDS_OTP'
  | 'ACTIVE' | 'RENEWING' | 'AUTH_FAILED' | 'EXPIRED' | 'REVOKED';

export interface ZatcaStepMessage { type: 'ERROR' | 'WARNING'; code: string | null; message: string | null }

export interface ZatcaIssue { rule: string; field: string; messageAr: string; severity: 'error' | 'warning' }

export interface ZatcaReadinessIssue extends ZatcaIssue { settingsField: string | null }

/** عرض الوحدة الآمن (toEgsUnitView): بلا مفتاح خاص ولا أسرار ولا رموز ولا CSR. التواريخ نصوص ISO. */
export interface ZatcaUnitView {
  id: string;
  tenantId: string;
  environment: ZatcaEnv;
  status: ZatcaUnitStatus;
  commonName: string;
  serialNumber: string;
  functionMap: string;
  orgName: string;
  orgUnit: string;
  vatNumber: string;
  locationAddress: string;
  industry: string;
  keyVersion: number;
  publicKeyPem: string | null;
  complianceRequestId: string | null;
  complianceProgress: {
    v: 1;
    phase: 'onboarding' | 'renewal';
    keyVersion: number;
    requestId: string | null;
    steps: Record<string, { status: string; at: string; warnings: ZatcaStepMessage[]; errors: ZatcaStepMessage[]; detail: string | null }>;
    inFlight?: { op: 'compliance' | 'production-csid'; at: string };
    renewal?: { origin: string; stage: string; uncertain: boolean; at: string };
  } | null;
  certSerial: string | null;
  certNotBefore: string | null;
  certNotAfter: string | null;
  lastIcv: number;
  activatedAt: string | null;
  revokedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZatcaChecklistItem {
  key: string;
  kind: 'setup' | 'check';
  status: 'done' | 'warning' | 'running' | 'failed' | 'pending';
  warnings: ZatcaStepMessage[];
  errors: ZatcaStepMessage[];
  detail: string | null;
}

export interface ZatcaUnitChecklist {
  phase: 'onboarding' | 'renewal';
  items: ZatcaChecklistItem[];
  checksPassed: number;
  checksTotal: number;
  renewal: { stage: string; uncertain: boolean; origin: string } | null;
}

export interface ZatcaJobOutcome {
  ok: boolean;
  code: string;
  messageAr: string;
  retryable: boolean;
  needsNewOtp: boolean;
  zatcaMessages: ZatcaStepMessage[];
  detail: string | null;
  step: string | null;
  field: string | null;
  issues: ZatcaIssue[];
}

export interface ZatcaJobView {
  id: string;
  kind: 'onboard' | 'renew';
  state: 'running' | 'finished';
  startedAt: string;
  finishedAt: string | null;
  outcome: ZatcaJobOutcome | null;
}

export interface ZatcaUnitPayload {
  unit: ZatcaUnitView;
  job: ZatcaJobView | null;
  activity: { busy: boolean; reason: 'job' | 'checks' | 'renewal' | 'csid-request' | null };
  checklist: ZatcaUnitChecklist;
}

export type ZatcaSellerField =
  | 'legalName' | 'taxNumber' | 'commercialReg' | 'sellerIdScheme' | 'sellerIdValue' | 'addrStreet' | 'addrBuildingNo'
  | 'addrAdditionalNo' | 'addrDistrict' | 'addrCity' | 'addrPostalCode' | 'vatGroupTin';

export type ZatcaSellerData = Record<ZatcaSellerField, string | null>;

export interface ZatcaSellerWarning { code: string; messageAr: string; unitId?: string }

// ── Z5.8: تفعيل المرحلة الثانية (go-live) — جاهزية التفعيل وقائمة المناديب غير المزامنين (backend GoLiveGate) ──
export type ZatcaGoLiveCheckKey = 'unitActive' | 'sellerReady' | 'currencySar' | 'repsSynced';
export type ZatcaRepUnsyncedReason = 'NO_REPORT' | 'STALE_REPORT' | 'OUTBOX_PENDING';
export interface ZatcaGoLiveReadiness {
  available: boolean;
  envAllows: boolean;
  armed: boolean;
  armedAt: string | null;
  checks: Record<ZatcaGoLiveCheckKey, boolean>;
  reps: { ready: boolean; total: number; synced: number; unsynced: Array<{ id: string; name: string; reason: ZatcaRepUnsyncedReason }> };
}

export interface ZatcaOverview {
  gate: { zatcaPhase2Enabled: boolean; countryCode: string };
  regime: 'PHASE1' | 'PHASE2';
  phase2StartedAt: string | null;
  goLiveAvailable: boolean;
  goLiveUnavailableMessage: string;
  /** Z5.8: بوابة التفعيل الكاملة — تُرجَع فقط لشركةٍ غير مفعّلة والمخزن مهيّأ (غيابها ⇒ كما اليوم). */
  goLiveReadiness?: ZatcaGoLiveReadiness | null;
  allowedEnvs: ZatcaEnv[];
  envConfigIssues: string[];
  productionBackend: boolean;
  secretsReady: boolean;
  seller: ZatcaSellerData;
  sellerIssues: ZatcaReadinessIssue[];
  /** عنوان الوحدة المشتقّ من عنوان المنشأة لطلب الشهادة (حين لا يُدخل المدير «العنوان المختصر»). */
  csrDefaultLocation?: string;
  currency: { currency: string; currencyOverride: string | null; isSar: boolean };
  units: ZatcaUnitPayload[];
  constants: { retireConfirmationText: string; otpLength: number; otpValidityMinutes: number; pollIntervalMs: number };
}
