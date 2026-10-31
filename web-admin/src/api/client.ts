import axios from 'axios';
import { sessionSpace, expiredDestination, useAuthStore } from '../store/authStore';
import { FS_CAPS_HEADER, FS_CAPS_VALUE } from './caps';
import { removeUnitParams } from './unitParams';
import type { PrintSettingsV1 } from '../lib/print/printSettingsCore';
import type { PrintTextsV1 } from '../lib/print/printTextsCore';
import type { PaymentMethodsConfigInput } from '../lib/paymentMethodsCore';
import type {
  LotCreateRequest, LotListParams, LotRef, LotRelabelRequest, LotStatusRequest, LotTrackingRequest, LotUpdateRequest,
} from '../lib/lots';

/** مساران واحدٌ بعد تطبيع الشرطة الأخيرة — الخادم يخدم `/m` و`/m/` معاً */
const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
/** أساس الواجهة البرمجية — مُصدَّر لقناة البثّ اللحظيّ (fetch لا axios) كي لا يُكرَّر */
export const API_BASE = BASE;

const api = axios.create({
  baseURL: BASE,
  // قدرات الحزمة (ZATCA المرحلة الثانية): لوحة الإدارة و`/m` تمرّان من حارس الخادم كما يمرّ تطبيق المندوب — انظر api/caps.ts
  headers: { 'Content-Type': 'application/json', [FS_CAPS_HEADER]: FS_CAPS_VALUE },
});

// مفاتيح الجلسة حسب المساحة الحالية — **مستوردة لا مكرَّرة**: تعريفان
// منفصلان يفترقان يوماً ما فيُرسَل توكن مساحةٍ أخرى.
const spaceKeys = () => sessionSpace();

api.interceptors.request.use(config => {
  const token = localStorage.getItem(spaceKeys().tokenKey);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  r => r,
  err => {
    // لا نتعامل مع 401 لطلب تسجيل الدخول نفسه (لتظهر رسالة «بيانات غير صحيحة» في مكانها بلا إعادة توجيه)
    // — ومنه دخول موظف المنصة: كلمة مرورٍ خاطئة ليست انتهاء جلسة (وكانت تمحو علامة الانتحال)
    const url = err.config?.url as string | undefined;
    const isLogin = !!url && (url.includes('/auth/login') || url.includes('/staff-auth/login'));
    if (err.response?.status === 401 && !isLogin) {
      // الوجهة قبل المحو: «دخولٌ» إلى شركة أسقطه الخادم (IMPERSONATION_ENDED) يعود إلى لوحة من دخل (/staff أو /platform)
      // لا إلى /login — وعلامة من دخل يمحوها sessionExpired
      const dest = expiredDestination((err.response?.data as { code?: unknown } | undefined)?.code);
      // المحو ووسمُ التوكن المرفوض في المتجر — مصدرٌ واحد لمنطق المساحات
      useAuthStore.getState().sessionExpired();
      /* والانتقال **فقط إن كانت الوجهة صفحةً أخرى**.
       *
       * وجهة التطبيق هي `/m` وهو المسار الذي يقف عليه أصلاً، فكان الانتقال
       * إعادةَ تحميلٍ كاملة تُعيد إقلاعه — وهي الحركة التي ركبتها الحلقة.
       * وبمسحِ المتجر في الذاكرة تُرسَم شاشة الدخول في اللحظة نفسها بلا
       * تحميل، فلا سبيل للدوران أصلاً. أمّا لوحة الأدمن والمالك فوجهتهما
       * صفحةٌ أخرى حقيقةً (`/login` و`/owner`) فتنتقل كما كانت. */
      if (!samePath(window.location.pathname, dest)) window.location.href = dest;
    }
    return Promise.reject(err);
  }
);

export default api;

/** «تتبّع اللوط» (D11): صفوف التوزيع تُضمّ بـwithLots=1 وحده — والشاشة ترسله حين تكون الميزة مفعّلة، وبدونه الطلب كما كان */
export interface WithLots { withLots?: boolean }
const lotsParam = (opts?: WithLots) => (opts?.withLots ? { withLots: 1 } : {});

export const customerApi = {
  list: (params?: Record<string, string | number>) => api.get('/customers', { params }),
  get: (id: string) => api.get(`/customers/${id}`),
  create: (data: unknown) => api.post('/customers', data),
  update: (id: string, data: unknown) => api.put(`/customers/${id}`, data),
  statement: (id: string, params?: Record<string, string>) => api.get(`/customers/${id}/statement`, { params }),
  invoices: (id: string) => api.get(`/customers/${id}/invoices`),
  locations: () => api.get('/customers/locations'),
  updatePrices: (id: string, prices: unknown) => api.put(`/customers/${id}/prices`, { prices }),
  remove: (id: string) => api.delete(`/customers/${id}`),
  // فوترة ZATCA (Z5.1a، D2) — للشركة التي تجمع بيانات الفوترة وحدها (غيرها 404): القائمة، اعتماد التصنيف المقترح، حقول الفوترة وحدها
  buyerData: (params?: Record<string, string | number>) => api.get('/customers/zatca-buyer-data', { params }),
  applySuggestedType: (ids: string[]) => api.post('/customers/zatca-buyer-data/apply-suggested', { ids }),
  updateBuyerData: (id: string, data: unknown) => api.patch(`/customers/${id}/buyer-data`, data),
};

export const productApi = {
  list: (params?: Record<string, string | number>) => api.get('/products', { params }),
  get: (id: string) => api.get(`/products/${id}`),
  // «الوحدة الرئيسية»: الجسم يقبل units[] وprimaryUnitName للإنشاء العكسي الذرّي (الصنف ووحداته ورئيسيّه في معاملة واحدة)،
  // وbasePrice اختيارياً حينها (يُشتقّ من سعر الرئيسية: derivedBasePrice). وunits بلا primaryUnitName يُتجاهل كما قبل الميزة
  create: (data: unknown) => api.post('/products', data),
  // ومعه expectedBaseName (409 BASE_UNIT_CHANGED) وprimaryUnit (رقعة الرئيسية ذرّياً)؛ primaryUnitId في الجسم يُتجاهل
  update: (id: string, data: unknown) => api.put(`/products/${id}`, data),
  categories: () => api.get('/products/categories'),
  createCategory: (data: unknown) => api.post('/products/categories', data),
  // expectedBaseName: الأساس كما رآه النموذج (409 BASE_UNIT_CHANGED)؛ expectedPrimary: الرئيسية ومعاملها حين أُدخلت الحدود بها
  // (409 PRIMARY_UNIT_CHANGED) — والحدود تُخزَّن بالأساس دائماً
  updatePriceTiers: (id: string, tiers: unknown, expectedBaseName?: string, expectedPrimary?: { id: string; factor: number }) =>
    api.put(`/products/${id}/price-tiers`, { tiers, ...(expectedBaseName && { expectedBaseName }), ...(expectedPrimary && { expectedPrimary }) }),
  remove: (id: string) => api.delete(`/products/${id}`),
  // «الوحدة الرئيسية» (D11): مجرّد علم — unitId: null يعيد الصنف إلى الافتراضي. expectedPrimaryUnitId (حين يُرسل) ما رآه
  // النموذج، فيُردّ 409 PRIMARY_UNIT_CHANGED إن تغيّرت منذ فُتح الصنف، و400 PRIMARY_UNIT_INVALID لوحدة موقوفة أو لصنف آخر
  setPrimaryUnit: (id: string, data: { unitId: string | null; expectedPrimaryUnitId?: string | null }) =>
    api.put(`/products/${id}/primary-unit`, data),
  // الوحدات المتعددة: وحدات البيع الأكبر من وحدة الأساس (كرتون = ٢٤ حبة). makePrimary يجعل المضافة رئيسية في المعاملة نفسها؛
  // وإيقاف الرئيسية أو حذفها يُردّ 409 PRIMARY_UNIT_IN_USE إلا مع clearPrimary صريح (في الجسم للتعديل، وفي الاستعلام للحذف)
  addUnit: (id: string, data: { name: string; factor: number; price?: number | null; unitCode?: string | null; makePrimary?: boolean; expectedBaseName?: string }) =>
    api.post(`/products/${id}/units`, data),
  updateUnit: (id: string, unitId: string, data: { name?: string; factor?: number; price?: number | null; unitCode?: string | null; isActive?: boolean; sortOrder?: number; clearPrimary?: boolean; expectedBaseName?: string }) =>
    api.put(`/products/${id}/units/${unitId}`, data),
  // الحذف بلا جسم: clearPrimary وexpectedBaseName (الأساس كما رآه النموذج ⇒ 409 BASE_UNIT_CHANGED لنموذجٍ قديم) في الاستعلام
  removeUnit: (id: string, unitId: string, opts?: { clearPrimary?: boolean; expectedBaseName?: string }) =>
    api.delete(`/products/${id}/units/${unitId}`, { params: removeUnitParams(opts) }),
  /**
   * «إضافة وحدة فرعية أصغر» (convert-base): وحدته الحالية تصير وحدةً بمعامل `factor`
   * (بسعرها نفسه)، و`newBaseName` الوحدة الصغرى الجديدة. التاريخ لا تُعاد كتابة أرقامه —
   * تُوسَم صفوفه بمعاملها فقط. `expectedBaseName` يمنع تحويلاً مزدوجاً بنقرتين.
   * keepOldBaseAsPrimary (افتراضه true في الخادم) يُبقي الوحدة الحالية «الوحدة الرئيسية»؛ dryRun معاينةٌ بلا كتابة
   * (عدّاداتٌ وerpLinked وapiKeys وprimaryAfter)؛ acknowledgeErp وacknowledgeApi إقرارا 409 CONVERT_BASE_ERP_ACK / CONVERT_BASE_API_ACK.
   */
  convertBase: (id: string, data: {
    newBaseName: string; factor: number; expectedBaseName: string; basePrice?: number; baseUnitCode?: string | null;
    keepOldBaseAsPrimary?: boolean; dryRun?: boolean; acknowledgeErp?: boolean; acknowledgeApi?: boolean;
  }) =>
    api.post(`/products/${id}/convert-base`, data),
};

// «الفرق» داخل الشركة — /api/company/teams (مطفأة افتراضياً، يفعّلها مدير الشركة من إعدادات الشركة)
export const teamsApi = {
  settings: () => api.get('/company/teams/settings'),
  setEnabled: (enabled: boolean) => api.patch('/company/teams/settings', { enabled }),
  list: () => api.get('/company/teams'),
  create: (name: string) => api.post('/company/teams', { name }),
  update: (id: string, data: { name?: string; isActive?: boolean }) => api.put(`/company/teams/${id}`, data),
  remove: (id: string) => api.delete(`/company/teams/${id}`),
  setMembers: (id: string, salesRepIds: string[]) => api.put(`/company/teams/${id}/members`, { salesRepIds }),
  setProducts: (id: string, productIds: string[]) => api.put(`/company/teams/${id}/products`, { productIds }),
  // المشرفون: المضاف يُقيَّد بفرقه (نطاق «فرق») — يحتاج صلاحية مستخدمي الشركة
  setSupervisors: (id: string, adminIds: string[]) => api.put(`/company/teams/${id}/supervisors`, { adminIds }),
};

// «لوكيشن» — /api/locations (ميزة يفعّلها المالك لكل شركة؛ ٤٠٣ LOCATIONS_NOT_ALLOWED دونها): مواقع الشركة (اسم ونقطة
// على الخريطة)، وإسناد كل مندوبٍ لموقعٍ واحد، وملخّص الفواتير والتحميلات لكل موقع في فترة (from/to بأيام الشركة)
export const locationsApi = {
  list: () => api.get('/locations'),
  create: (data: { name: string; lat?: number | null; lng?: number | null }) => api.post('/locations', data),
  update: (id: string, data: { name?: string; lat?: number | null; lng?: number | null; isActive?: boolean }) => api.put(`/locations/${id}`, data),
  remove: (id: string) => api.delete(`/locations/${id}`),
  reps: () => api.get('/locations/reps'),
  // locationId: null = «بلا موقع» — يسري على ما يُصدره المندوب بعد الإسناد وحده
  assignRep: (salesRepId: string, locationId: string | null) => api.put(`/locations/reps/${salesRepId}`, { locationId }),
  summary: (params?: Record<string, string>) => api.get('/locations/summary', { params }),
};

// «التحصيل بالبطاقة» عبر NearPay — /api/card-payments (ميزة يفعّلها المالك؛ ٤٠٣ CARD_PAY_NOT_ALLOWED دونها): نقاط بيع تاجر
// الشركة وإسنادها للمناديب (tid: null = بلا نقطة)، وتجّار NearPay للمالك يربط بهم كل شركة
export const cardPayApi = {
  terminals: () => api.get('/card-payments/terminals'),
  assignRep: (salesRepId: string, tid: string | null) => api.put(`/card-payments/reps/${salesRepId}`, { tid }),
  ownerMerchants: () => api.get('/card-payments/owner/merchants'),
  review: () => api.get('/card-payments', { params: { status: 'review' } }),
  closeReview: (id: string, note: string) => api.post(`/card-payments/${id}/close`, { note }),
};

export const salesRepApi = {
  list: (params?: Record<string, string | number>) => api.get('/sales-reps', { params }),
  get: (id: string) => api.get(`/sales-reps/${id}`),
  create: (data: unknown) => api.post('/sales-reps', data),
  update: (id: string, data: unknown) => api.put(`/sales-reps/${id}`, data),
  stats: (id: string, params?: Record<string, string>) => api.get(`/sales-reps/${id}/stats`, { params }),
  remove: (id: string) => api.delete(`/sales-reps/${id}`),
  // فكّ ربط جهاز البصمة — أول بصمةٍ بعده تربط جهازها الجديد (يُدوَّن في سجلّ تدقيق الحضور)
  unbindDevice: (id: string) => api.post(`/sales-reps/${id}/unbind-device`),
  // teamId («الفرق»): عهدة فريقٍ واحد من فرق المندوب — ومشرف الفريق يُقيَّد بفرقه على الخادم مهما طلب
  collection: (id: string, teamId?: string) => api.get(`/sales-reps/${id}/collection`, { params: teamId ? { teamId } : undefined }),
  // method: قاموس مغلق مطابق لسند القبض (CASH · BANK_TRANSFER · POS · CHEQUE) — والخادم
  // يردّ أيّ قيمة خارجه إلى CASH. photos: حتى ٤ صور data URL مضغوطة بوحدة imageCompress
  settle: (id: string, data: { amount: number; method?: string; note?: string; photos?: string[]; teamId?: string }) =>
    api.post(`/sales-reps/${id}/settlements`, data),
  settlements: (id: string, params?: { from?: string; to?: string; teamId?: string }) =>
    api.get(`/sales-reps/${id}/settlements`, { params }),
  deleteSettlement: (id: string, settlementId: string) =>
    api.delete(`/sales-reps/${id}/settlements/${settlementId}`),
  // عزل العملاء: إسناد عملاء لكل مندوب + مفتاح تفعيل العزل للشركة
  assignedCustomers: (id: string) => api.get(`/sales-reps/${id}/customers`),
  // فروقات فقط — لا نرسل قائمة كاملة كي لا يُحذف صامتاً إسنادُ عميل لم تعرضه النافذة
  changeAssignedCustomers: (id: string, diff: { add?: string[]; remove?: string[] }) =>
    api.put(`/sales-reps/${id}/customers`, diff),
  isolation: () => api.get('/sales-reps/settings/isolation'),
  setIsolation: (enabled: boolean) => api.patch('/sales-reps/settings/isolation', { enabled }),
};

// شرائح البروفايل — قراءة عامّة وكتابة لمالك المنصّة
export const profileDeckApi = {
  get: () => api.get('/profile-deck'),
  putDeck: (slides: unknown[]) => api.put('/profile-deck', { slides }),
  putFile: (dataBase64: string, name: string) => api.put('/profile-deck/file', { dataBase64, name }),
  clear: () => api.delete('/profile-deck'),
};

export const invoiceApi = {
  list: (params?: Record<string, string | number>) => api.get('/invoices', { params }),
  // فواتير العميل المفتوحة لتوزيع سند القبض — كل فواتيره لا فواتير مندوب بعينه
  open: (customerId: string) => api.get('/invoices/open', { params: { customerId } }),
  // withLots: items[].lots بتشغيلاتها (InvoiceItemLotDto في lib/lots.ts)
  get: (id: string, opts?: WithLots) => (opts?.withLots ? api.get(`/invoices/${id}`, { params: lotsParam(opts) }) : api.get(`/invoices/${id}`)),
  create: (data: unknown) => api.post('/invoices', data),
  /* فاتورة الإرجاع من اللوحة (lib/returnInvoice.ts): فواتير بيع العميل التي بقي فيها ما يُرجَع، ثم بنود واحدةٍ منها بمبيعها
   * ومُرجَعها ومتاحها وسعر استردادها — المساران نفسهما اللذان يخدمان تطبيق المندوب، بنطاق مستخدم الشركة على الخادم.
   * withLots: لكل سطر lots [{lotId, lotNumber, expiryDate, sold, returned, returnable, certainty}] */
  returnableSales: (customerId: string) => api.get('/invoices/returnable-sales', { params: { customerId } }),
  returnable: (id: string, opts?: WithLots) =>
    (opts?.withLots ? api.get(`/invoices/${id}/returnable`, { params: lotsParam(opts) }) : api.get(`/invoices/${id}/returnable`)),
  cancel: (id: string) => api.patch(`/invoices/${id}/cancel`),
  // تحكّم الأدمن: هل يعود المرتجع لمخزون السيارة؟
  setRestock: (id: string, returnToStock: boolean) => api.patch(`/invoices/${id}/restock`, { returnToStock }),
  /* فوترة ZATCA المرحلة الثانية (Z5.4) — الإجراءات الثلاثة التي يفتحها الخادم لمستخدمي الشركة (requireAdmin):
   * إعادة إرسال مستند محجوب، وسحب قياسية عالقة قبل وصولها الهيئة، وإعادة إصدار مبسّطة مرفوضة. */
  einvoiceRetry: (id: string) => api.post(`/invoices/${id}/einvoice/retry`),
  einvoiceWithdraw: (id: string) => api.post(`/invoices/${id}/einvoice/withdraw`),
  einvoiceReissue: (id: string) => api.post(`/invoices/${id}/einvoice/reissue`),
  /* فوترة ZATCA المرحلة الثانية (Z5.7) — رابط المشتري لمستندٍ نهائيّ: الخادم يشتقّ الرمز ولا يخزّنه،
   * فنداءان لنفس الفاتورة يعطيان الرابط نفسه، ومستندٌ لم تحسمه الهيئة يعود `available:false` بسببه. */
  einvoiceShare: (id: string) => api.get(`/invoices/${id}/einvoice/share`),
};

export const receiptApi = {
  list: (params?: Record<string, string | number>) => api.get('/receipts', { params }),
  get: (id: string) => api.get(`/receipts/${id}`),
  create: (data: unknown) => api.post('/receipts', data),
  cancel: (id: string) => api.patch(`/receipts/${id}/cancel`),
};

export const dashboardApi = {
  stats: () => api.get('/dashboard'),
  salesTrend: (days?: number) => api.get('/dashboard/sales-trend', { params: { days } }),
};

export const reportApi = {
  sales: (params?: Record<string, string>) => api.get('/reports/sales', { params }),
  // تقرير الطلبات: الفواتير ذات تاريخ التسليم (المدى على تاريخ التسليم)
  orders: (params?: Record<string, string>) => api.get('/reports/orders', { params }),
  // تقرير المرتجع: مستندات الإرجاع المؤكَّدة في المدى بفواتير بيعها وبنودها، ونسبة المرتجع من المبيعات
  returns: (params?: Record<string, string>) => api.get('/reports/returns', { params }),
  collections: (params?: Record<string, string>) => api.get('/reports/collections', { params }),
  balances: (params?: Record<string, string>) => api.get('/reports/balances', { params }),
  repPerformance: (params?: Record<string, string>) => api.get('/reports/rep-performance', { params }),
  repReceivables: (params?: Record<string, string>) => api.get('/reports/rep-receivables', { params }), // لحظيّ — لا معاملات تاريخ (الفريق وحده)
  workHours: (params?: Record<string, string>) => api.get('/reports/work-hours', { params }),
  // تقييم الأداء: ترتيب المناديب حسب معيار (visits | product | sales | distance | appTime)
  repRanking: (params?: Record<string, string>) => api.get('/reports/rep-ranking', { params }),
  customerVisits: (params?: Record<string, string>) => api.get('/reports/customer-visits', { params }),
  // «طرق الدفع»: تحصيل كل مندوب لكل طريقة دفع في الفترة (from/to بأيام الشركة، teamId اختياري) — ميزة يفعّلها المالك
  paymentMethods: (params?: Record<string, string>) => api.get('/reports/payment-methods', { params }),
};

export const notificationApi = {
  list: () => api.get('/notifications'),
  markRead: (id: string) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),
};

export const authApi = {
  login: (data: { username: string; password: string; role: string }) => api.post('/auth/login', data),
  // ref/refVia: رمز «سفير فيلد سيلز» — يُرسل فقط إن وُجد، والخادم يُهمل الخاطئ بصمت ولا يُفشل التسجيل.
  // refAt: لحظة التقاط رمز الرابط (epoch ms) — الخادم يفرض بها نافذة الإسناد
  signup: (data: { companyName: string; adminName: string; email: string; password: string; phone?: string; countryCode?: string; ref?: string; refVia?: 'link' | 'typed'; refAt?: number }) => api.post('/auth/signup', data),
  me: () => api.get('/auth/me'),
  changePassword: (data: { currentPassword: string; newPassword: string }) => api.post('/auth/change-password', data),
  verifyEmail: (token: string) => api.post('/auth/verify-email', { token }),
  resendVerification: () => api.post('/auth/resend-verification'),
  // تفعيل حساب شركةٍ فتحه «سفير فيلد سيلز» (/activate): الرمز من رابط بريد المسؤول، يُرسل في الجسم
  // لا في الرابط. preview يقرأ حالته وبيانات العرض، وactivate يضبط كلمة المرور ويُعيد جلسة الدخول.
  activationPreview: (token: string) => api.post('/auth/activation/preview', { token }),
  activate: (data: { token: string; password: string; acceptTerms: true; phone: string }) => api.post('/auth/activate', data),
};

export const companyApi = {
  get: () => api.get('/company'),
  update: (data: unknown) => api.put('/company', data),
  // «إعدادات الطباعة» — /api/company/print-settings: القراءة لكل مسجّل (data خام تُقرأ عبر normalizePrintSettings)، والحفظ
  // بصلاحية إعدادات الشركة (409 COMPANY_SETTINGS_MISSING بلا صفّ إعدادات) — مسارٌ مستقلّ لا حقلٌ في update أعلاه.
  // null = «استعادة الافتراضي»: يُرسل { reset: true } (express.json الصارم يرفض null الخام) فيُكتب العمود null حرفياً
  printSettings: {
    get: () => api.get('/company/print-settings'),
    put: (data: PrintSettingsV1 | null) => api.put('/company/print-settings', data ?? { reset: true }),
  },
  // «نصوص المطبوعات» — /api/company/print-texts: صياغة نصوص الفاتورة وسند القبض وإخفاؤها ولغتها الثانية. القراءة لكل مسجّل
  // (data خام تُقرأ عبر normalizePrintTexts)، والحفظ بصلاحية إعدادات الشركة (400 PRINT_TEXTS_INVALID بأسباب issues، 413، 409).
  // مسارٌ مستقلّ كالطباعة لا حقلٌ في update. null = «استعادة النصوص الافتراضية»: { reset: true } فيُكتب العمود null
  printTexts: {
    get: () => api.get('/company/print-texts'),
    put: (data: PrintTextsV1 | null) => api.put('/company/print-texts', data ?? { reset: true }),
  },
  // «إدارة طرق الدفع» — /api/company/payment-methods: القراءة لكل مسجّل ({ data, methods, choices })، والحفظ بصلاحية إعدادات
  // الشركة وعَلَم صفحة «طرق الدفع» (400 بأسباب issues، 409 PAYMENT_METHODS_CONFLICT من تبويبٍ قديم). مسارٌ مستقلّ كالطباعة.
  // null = «استعادة الافتراضي»: { reset: true } — المضافة تبقى معطّلة بأسمائها (سنداتها القديمة تحتاجها)
  paymentMethods: {
    get: () => api.get('/company/payment-methods'),
    put: (data: PaymentMethodsConfigInput | null) => api.put('/company/payment-methods', data ?? { reset: true }),
  },
  // «فك قيد الرقم الضريبي والعنوان الوطني» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — /api/company/buyer-relax: القراءة لكل مستخدم شركة
  // ({ enabled })، والتبديل لمدير الشركة غير المقيّد وحده (403 BUYER_RELAX_ADMIN_ONLY / BUYER_RELAX_SCOPED، والمفتاح 403 دائماً،
  // و409 COMPANY_SETTINGS_MISSING بلا صفّ إعدادات). والقيمة نفسها تصل في GET /company باسم buyerVatAddressRelaxed
  buyerRelax: {
    get: () => api.get('/company/buyer-relax'),
    set: (enabled: boolean) => api.patch('/company/buyer-relax', { enabled }),
  },
};

// ربط فوترة ZATCA المرحلة الثانية (تبويب إعدادات الشركة) — OTP يُرسل في جسم الربط/التجديد وحدهما ولا يُحفظ في الواجهة
export const zatcaApi = {
  overview: () => api.get('/zatca/overview'),
  unit: (id: string) => api.get(`/zatca/units/${encodeURIComponent(id)}`),
  saveSeller: (data: Record<string, string | null>) => api.put('/zatca/seller', data),
  createUnit: (data: { environment: string; locationAddress?: string; industry?: string; branchName?: string }) => api.post('/zatca/units', data),
  // csrFields: العنوان المختصر في الشهادة — الخدمة تعيد اشتقاق العنوان من عنوان المنشأة عند إعادة الربط بعد رفض وعند التجديد
  onboard: (id: string, data: { otp?: string; csrFields?: { locationAddress?: string } }) => api.post(`/zatca/units/${encodeURIComponent(id)}/onboard`, data),
  renew: (id: string, data: { otp: string; csrFields?: { locationAddress?: string } }) => api.post(`/zatca/units/${encodeURIComponent(id)}/renew`, data),
  abortRenewal: (id: string) => api.post(`/zatca/units/${encodeURIComponent(id)}/abort-renewal`, {}),
  retire: (id: string, data: { confirmation: string; reason: 'revoked-in-portal' | 'abandoned' }) =>
    api.post(`/zatca/units/${encodeURIComponent(id)}/retire`, data),
  // Z5.8: تفعيل المرحلة الثانية (go-live) — جاهزية تُستطلع، تسليح، ثم تفعيل بتأكيد «تفعيل» + repsSynced
  goLiveReadiness: () => api.get('/zatca/go-live/readiness'),
  armGoLive: () => api.post('/zatca/go-live/arm', {}),
  // Z5.8 (نقد 2/4): نزع التسليح — تعافٍ من تسليحٍ خاطئ يعيد الإصدار دون اتصال (ما لم تكن الشركة قد فُعّلت حيّاً)
  disarmGoLive: () => api.post('/zatca/go-live/disarm', {}),
  goLive: (data: { typedConfirmation: string; repsSynced: boolean }) => api.post('/zatca/go-live', data),
  // Z5.8: طابور مراجعة الانتقال (D11) — قائمة + قبول (مرحلة أولى/ثانية) / رفض
  cutoverList: (status?: string) => api.get('/zatca/cutover', status ? { params: { status } } : undefined),
  cutoverAccept: (id: string, data: { mode: 'PHASE1' | 'PHASE2'; note?: string }) =>
    api.post(`/zatca/cutover/${encodeURIComponent(id)}/accept`, data),
  cutoverReject: (id: string, data: { note?: string }) =>
    api.post(`/zatca/cutover/${encodeURIComponent(id)}/reject`, data),
};

// مستخدمو الشركة الذين يدخلون لوحة الإدارة
export const companyUserApi = {
  list: () => api.get('/company-users'),
  create: (data: unknown) => api.post('/company-users', data),
  update: (id: string, data: unknown) => api.put(`/company-users/${id}`, data),
  remove: (id: string) => api.delete(`/company-users/${id}`),
  // نطاق المستخدم: العملاء والمناديب الذين يراهم (عزل على مستوى المستخدم)
  scope: (id: string) => api.get(`/company-users/${id}/scope`),
  // null لقائمة = «لا تلمسها» (تحديث إحداهما وحدها)
  setScope: (id: string, data: { customerIds?: string[] | null; salesRepIds?: string[] | null; scopeEnabled?: boolean; scopeMode?: 'LISTS' | 'TEAMS' }) =>
    api.put(`/company-users/${id}/scope`, data),
  // عهدة التحصيل: ما استلمه المستخدم من المناديب ناقص ما ورّده (توريدٌ نهائيّ)
  custody: (id: string) => api.get(`/company-users/${id}/custody`),
  settlements: (id: string, params?: Record<string, string>) => api.get(`/company-users/${id}/settlements`, { params }),
  settle: (id: string, data: { amount: number; method?: string; note?: string; photos?: string[] }) =>
    api.post(`/company-users/${id}/settlements`, data),
  // صور إثبات توريدٍ واحد — السجلّ يحمل معرّفاتها فقط (الردّ كان عشرات الميجابايتات)
  settlementPhotos: (id: string, settlementId: string) =>
    api.get(`/company-users/${id}/settlements/${settlementId}/photos`),
  deleteSettlement: (id: string, settlementId: string) =>
    api.delete(`/company-users/${id}/settlements/${settlementId}`),
};

// الربط البرمجي API — مفاتيح الشركة (إصدار/قائمة/إلغاء)؛ المفتاح الكامل يعود في ردّ الإصدار وحده
export const apiKeysApi = {
  list: () => api.get('/api-keys'),
  create: (data: { name: string; readOnly?: boolean }) => api.post('/api-keys', data),
  revoke: (id: string) => api.post(`/api-keys/${id}/revoke`),
};

export const erpApi = {
  settings: () => api.get('/erp/settings'),
  saveSettings: (data: unknown) => api.put('/erp/settings', data),
  test: () => api.post('/erp/test'),
  sync: (resource: 'all' | 'customers' | 'products' | 'invoices' | 'receipts') => api.post('/erp/sync', { resource }),
  logs: () => api.get('/erp/logs'),
};

// المندوب الذكي AI — إعدادات الشركة وتصنيف أنواع العملاء (خامل حتى يفعّله المالك)
export const aiRepApi = {
  settings: () => api.get('/ai-rep/admin/settings'),
  saveSettings: (data: unknown) => api.put('/ai-rep/admin/settings', data),
  classifyList: (params: Record<string, string | number>) => api.get('/ai-rep/admin/classify', { params }),
  classify: (items: { customerId: string; outletType: string | null }[]) => api.post('/ai-rep/admin/classify', { items }),
  // حلقة التعلّم: «ما تعلّمه العقل» وإجراءات الإدارة عليه
  learning: () => api.get('/ai-rep/admin/learning'),
  lessonAction: (id: string, action: 'approve' | 'reject' | 'disable' | 'enable' | 'restore') =>
    api.post(`/ai-rep/admin/learning/lessons/${encodeURIComponent(id)}`, { action }),
  rollbackModel: (kind: 'POLICY' | 'CALIBRATION' | 'GSIG', version: number) => api.post(`/ai-rep/admin/learning/models/${kind}/rollback`, { version }),
  resetLearning: () => api.post('/ai-rep/admin/learning/reset', { confirm: true }),
  // المحلات المخفية عن المسح («أُغلق نهائياً / لم أجده» مؤكَّداً) و«أعد إظهاره»
  hiddenOutlets: () => api.get('/ai-rep/admin/hidden-outlets'),
  unhideOutlet: (id: string) => api.post(`/ai-rep/admin/hidden-outlets/${encodeURIComponent(id)}/unhide`),
};

export const petroappApi = {
  settings: () => api.get('/petroapp/settings'),
  saveSettings: (data: unknown) => api.put('/petroapp/settings', data),
  test: () => api.post('/petroapp/test'),
  sync: () => api.post('/petroapp/sync'),
  vehicles: () => api.get('/petroapp/vehicles'),
  delegates: () => api.get('/petroapp/delegates'),
  linkVehicle: (id: string, salesRepId: string | null) => api.put(`/petroapp/vehicles/${id}/link`, { salesRepId }),
  linkDelegate: (id: string, salesRepId: string | null) => api.put(`/petroapp/delegates/${id}/link`, { salesRepId }),
  report: (from?: string, to?: string) => api.get('/petroapp/report', { params: { from, to } }),
};

export const workNumbersApi = {
  settings: () => api.get('/work-numbers/settings'),
  saveSettings: (data: unknown) => api.put('/work-numbers/settings', data),
  test: () => api.post('/work-numbers/test'),
  sync: () => api.post('/work-numbers/sync'),
  list: () => api.get('/work-numbers'),
  add: (e164: string, label?: string) => api.post('/work-numbers', { e164, label }),
  assign: (id: string, salesRepId: string) => api.post(`/work-numbers/${id}/assign`, { salesRepId }),
  release: (id: string) => api.post(`/work-numbers/${id}/release`),
  remove: (id: string) => api.delete(`/work-numbers/${id}`),
  calls: (from?: string, to?: string) => api.get('/work-numbers/calls', { params: { from, to } }),
};

// إدارة الشركات — لمالك المنصّة (السوبر أدمن)
// «موظفو المنصة» — دخول الموظف وحسابه (مساحة /staff)
export const staffAuthApi = {
  login: (data: { email: string; password: string }) => api.post('/staff-auth/login', data),
  me: () => api.get('/staff-auth/me'),
  changePassword: (data: { currentPassword: string; newPassword: string }) => api.post('/staff-auth/change-password', data),
};

// إدارة موظفي المنصة وسجل النشاط — للمالك وحده (الخادم يردّ الموظف ٤٠٣)
export const platformStaffApi = {
  list: () => api.get('/platform-staff'),
  catalog: () => api.get('/platform-staff/catalog'),
  create: (data: { name: string; email: string; permissions: string[] }) => api.post('/platform-staff', data),
  update: (id: string, data: { name?: string; email?: string; permissions?: string[]; isActive?: boolean }) => api.put(`/platform-staff/${id}`, data),
  resetPassword: (id: string) => api.post(`/platform-staff/${id}/reset-password`),
  revokeSessions: (id: string) => api.post(`/platform-staff/${id}/revoke-sessions`),
  remove: (id: string) => api.delete(`/platform-staff/${id}`),
  audit: (params?: { actorId?: string; actorType?: 'OWNER' | 'STAFF'; from?: string; to?: string; tz?: number; before?: string; beforeId?: string }) =>
    api.get('/platform-staff/audit', { params }),
};

export const tenantApi = {
  list: () => api.get('/tenants'),
  get: (id: string) => api.get(`/tenants/${id}`),
  performance: (id: string) => api.get(`/tenants/${id}/performance`),
  // ما مرّ عبر المنصة: عدد الفواتير وإجمالي المبيعات لكل عملة
  platformTotals: () => api.get('/tenants/platform-totals'),
  create: (data: unknown) => api.post('/tenants', data),
  update: (id: string, data: unknown) => api.put(`/tenants/${id}`, data),
  // المالك يختار الكلمة (newPassword)؛ وموظف المنصة لا يرسلها: الخادم يرسل مؤقتة إلى بريد المدير ويردّ data: { sent, email مقنّعاً }
  resetAdmin: (id: string, data: { adminId?: string; newPassword?: string }) => api.post(`/tenants/${id}/reset-admin`, data),
  impersonate: (id: string) => api.post(`/tenants/${id}/impersonate`),
  // confirmLotRecords («تتبّع اللوط»، D31): شركةٌ لها سجلات تشغيلات حديثة تُردّ 409 LOT_RECORDS_RETAINED حتى يُؤكَّد بعد التصدير
  remove: (id: string, confirmLedgerDestroy?: boolean, confirmLotRecords?: boolean) => api.delete(`/tenants/${id}`, { params: { confirmLedgerDestroy: confirmLedgerDestroy ? 1 : undefined, confirmLotRecords: confirmLotRecords ? 1 : undefined } }),
  // الدفاتر (M3، §5.7، §8.1): إعادة الضبط بتأكيد الاسم، وتاريخ فوترة عمولة الدفع (D2) — preview لا يكتب
  ledgerReset: (id: string, data: { confirmName: string; force?: boolean }) => api.post(`/tenants/${id}/ledger-reset`, data),
  setPaylinkFeeTaxInvoiceFrom: (id: string, data: { from: string | null }, preview?: boolean) =>
    api.put(`/tenants/${id}/ledger-paylink-fee-invoice-from`, data, { params: preview ? { preview: 1 } : undefined }),
  // نظام تشغيل المالك (خطة فجوة التنفيذ)
  opsMetrics: () => api.get('/tenants/ops/metrics'),
  opsCards: () => api.get('/tenants/ops/cards'),
  sendWeeklyReport: () => api.post('/tenants/ops/weekly-report'),
};

// العملاء المحتملون (Leads) — لوحة المالك
export const leadApi = {
  list: (params?: Record<string, string | number | boolean>) => api.get('/leads', { params }),
  stats: () => api.get('/leads/stats'),
  get: (id: string) => api.get(`/leads/${id}`),
  create: (data: unknown) => api.post('/leads', data),
  update: (id: string, data: unknown) => api.put(`/leads/${id}`, data),
  remove: (id: string) => api.delete(`/leads/${id}`),
  addActivity: (id: string, data: unknown) => api.post(`/leads/${id}/activities`, data),
  convert: (id: string, data?: unknown) => api.post(`/leads/${id}/convert`, data || {}),
  search: (data: unknown) => api.post('/leads/search', data),
  sourcesStatus: () => api.get('/leads/sources-status'),
  apifyBudget: () => api.get('/leads/apify-budget'),
  apifyCapUpdate: (monthlyCap: number) => api.put('/leads/apify-budget', { monthlyCap }),
  sendEmail: (data: unknown) => api.post('/leads/email', data),
  emailTest: (data: unknown) => api.post('/leads/email-test', data),
  emailStatus: () => api.get('/leads/email-status'),
  whatsappStatus: () => api.get('/leads/whatsapp-status'),
  whatsappSend: (data: unknown) => api.post('/leads/whatsapp-send', data),
  whatsappConfig: () => api.get('/leads/whatsapp-config'),
  // جسر واتساب ويب (جلسة QR على جهاز المالك)
  waBridgeSession: () => api.get('/wa-bridge/session'),
  waBridgeDraft: () => api.get('/wa-bridge/draft'),
  waBridgeDraftSave: (data: unknown) => api.put('/wa-bridge/draft', data),
  waBridgePreview: (leadId: string) => api.get(`/wa-bridge/preview/${leadId}`),
  waBridgeSend: (data: unknown) => api.post('/wa-bridge/send', data),
  waBridgeThread: (leadId: string) => api.get(`/wa-bridge/thread/${leadId}`),
  waBridgeLogout: () => api.post('/wa-bridge/logout'),
  waBridgeBulk: (data: unknown) => api.post('/wa-bridge/bulk', data),
  waBridgeBulkCount: (params?: Record<string, string>) => api.get('/wa-bridge/bulk-count', { params }),
  waBridgeQueueClear: () => api.post('/wa-bridge/queue/clear'),
  phoneAudit: () => api.get('/leads/phone-audit'),
  phoneClassify: () => api.post('/leads/phone-classify'),
  whatsappConfigUpdate: (data: unknown) => api.put('/leads/whatsapp-config', data),
  whatsappPreview: (params?: Record<string, string>) => api.get('/leads/whatsapp-preview', { params }),
  enrichStatus: () => api.get('/leads/enrich-status'),
  enrich: (data: unknown) => api.post('/leads/enrich', data),
  huntConfig: () => api.get('/leads/auto-hunt'),
  huntUpdate: (data: unknown) => api.put('/leads/auto-hunt', data),
  huntRun: () => api.post('/leads/auto-hunt/run'),
  autoEmailConfig: () => api.get('/leads/auto-email'),
  autoEmailUpdate: (data: unknown) => api.put('/leads/auto-email', data),
  autoEmailRun: () => api.post('/leads/auto-email/run'),
  communityConfig: () => api.get('/leads/community-hunt'),
  communityUpdate: (data: unknown) => api.put('/leads/community-hunt', data),
  communityRun: () => api.post('/leads/community-hunt/run'),
  import: (leads: unknown[]) => api.post('/leads/import', { leads }),
  exportUrl: () => `${BASE}/leads/export/csv`,
  marketingStats: () => api.get('/leads/marketing-stats'),
  arabCountries: () => api.get('/leads/arab-countries'),
  invoiceToolUsers: () => api.get('/leads/invoice-tool'),
};

// الأدوات المجانية العامة — التقاط استخدام مولّد الفواتير كعميل محتمل (نقطة عامة بلا مصادقة)
export const toolsApi = {
  invgenCapture: (data: Record<string, unknown>) => api.post('/leads-cron/invgen', data),
};

// تتبّع المناديب عبر GPS
export const trackingApi = {
  settings: () => api.get('/tracking/settings'),
  setEnabled: (enabled: boolean) => api.patch('/tracking/settings', { enabled }),
  // lite: المواقع وحدها بلا عدّاد زيارات اليوم (lib/trackingLive.ts)
  live: (lite = false) => api.get('/tracking/live', lite ? { params: { lite: 1 } } : undefined),
  route: (salesRepId: string, date?: string) => api.get('/tracking/route', { params: { salesRepId, ...(date ? { date } : {}) } }),
};

// الزيارات الميدانية — يسجّلها المندوب عند العميل (ملاحظة + صور + موقع)، تراها الإدارة
export const visitsApi = {
  byRep: (salesRepId: string, date?: string) => api.get('/visits', { params: { salesRepId, ...(date ? { date } : {}) } }),
  detail: (id: string) => api.get(`/visits/${id}`),
};

// مخزون سيارة المندوب — ملخّص ومخزون وحركة لكل مندوب
// التقرير اليومي — الإقرار وسلسلة اعتماده
export const repRouteApi = {
  list: () => api.get('/rep-routes', { params: { tzOffsetMin: -new Date().getTimezoneOffset() } }),
  get: (id: string) => api.get(`/rep-routes/${id}`),
  save: (body: unknown) => api.post('/rep-routes', body),
  remove: (id: string) => api.delete(`/rep-routes/${id}`),
  /** خط سير المندوب اليوم — بيوم جهازه لا يوم الخادم */
  /** خط سير مندوبٍ بعينه ليومٍ بعينه — للوحة الإدارة (خلف صلاحية التتبّع) */
  mineFor: (salesRepId: string, date: string) => api.get('/rep-routes/mine', {
    params: { salesRepId, date, tzOffsetMin: -new Date().getTimezoneOffset() },
  }),
  mine: () => api.get('/rep-routes/mine', {
    params: { date: dayKeyLocal(), tzOffsetMin: -new Date().getTimezoneOffset() },
  }),
};

/** مفتاح يوم الجهاز 'YYYY-MM-DD' بلا انزلاق منطقة زمنية */
function dayKeyLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const dailyReportApi = {
  // المندوب
  form: (date: string, salesRepId?: string) => api.get('/daily-reports/form', { params: { date, ...(salesRepId && { salesRepId }) } }),
  submit: (body: unknown) => api.post('/daily-reports', body),
  // التقرير الشامل — أرشيفٌ دائم لمن أُسند إليه
  digests: () => api.get('/daily-reports/digests'),
  digest: (date: string) => api.get(`/daily-reports/digests/${date}`),
  setDigestViewers: (adminIds: string[]) => api.put('/daily-reports/config/digest-viewers', { adminIds }),
  mine: () => api.get('/daily-reports/mine'),
  // المراجعة والاعتماد
  inbox: () => api.get('/daily-reports/admin/inbox'),
  get: (id: string) => api.get(`/daily-reports/admin/${id}`),
  comment: (id: string, body: { fieldId?: string | null; body: string }) => api.post(`/daily-reports/admin/${id}/comment`, body),
  saveValues: (id: string, values: unknown[]) => api.post(`/daily-reports/admin/${id}/values`, { values }),
  approve: (id: string) => api.post(`/daily-reports/admin/${id}/approve`),
  sendBack: (id: string, reason: string) => api.post(`/daily-reports/admin/${id}/return`, { reason }),
  // التهيئة
  config: () => api.get('/daily-reports/config'),
  addField: (body: unknown) => api.post('/daily-reports/config/fields', body),
  updateField: (id: string, body: unknown) => api.patch(`/daily-reports/config/fields/${id}`, body),
  archiveField: (id: string, restore = false) => api.post(`/daily-reports/config/fields/${id}/archive`, { restore }),
  deleteField: (id: string) => api.delete(`/daily-reports/config/fields/${id}`),
  reorderFields: (ids: string[]) => api.post('/daily-reports/config/fields/reorder', { ids }),
  addLevel: (body: unknown) => api.post('/daily-reports/config/levels', body),
  updateLevel: (id: string, body: unknown) => api.patch(`/daily-reports/config/levels/${id}`, body),
  deleteLevel: (id: string) => api.delete(`/daily-reports/config/levels/${id}`),
  setOwners: (id: string, owners: unknown[]) => api.put(`/daily-reports/config/levels/${id}/owners`, { owners }),
  preview: (salesRepId: string) => api.post('/daily-reports/config/preview', { salesRepId }),
  // التقرير الشامل
  team: (from: string, to: string) => api.get('/daily-reports/team', { params: { from, to } }),
  // سجلّ مندوبٍ واحد يوماً بيوم — بلا مدّة يعيد آخر ٣٠ يوماً
  repHistory: (salesRepId: string, params?: { from?: string; to?: string }) =>
    api.get(`/daily-reports/rep/${salesRepId}`, { params: { ...(params?.from && { from: params.from }), ...(params?.to && { to: params.to }) } }),
};

export const vanStockApi = {
  summary: (params?: { from?: string; to?: string }) => api.get('/van-stock/summary', { params: { ...(params?.from && { from: params.from }), ...(params?.to && { to: params.to }) } }),
  current: (salesRepId: string) => api.get('/van-stock/current', { params: { salesRepId } }),
  // withLots: items[].lots بتشغيلاتها (VanLoadItemLotDto في lib/lots.ts)
  loads: (salesRepId?: string, opts?: WithLots) => api.get('/van-stock/loads', { params: { ...(salesRepId ? { salesRepId } : {}), ...lotsParam(opts) } }),
  // «سجل التحميلات» المرقَّم («لوكيشن»): type=LOAD وfrom/to بأيام الشركة وlocationId (معرّف أو none) وpage/limit — يعيد pagination
  loadsLog: (params: Record<string, string | number>) => api.get('/van-stock/loads', { params }),
  movements: (salesRepId: string, opts?: WithLots) => api.get('/van-stock/movements', { params: { salesRepId, ...lotsParam(opts) } }),
  // suggestedQty يُمرَّر ليُخزَّن مع البند — به وحده تُقاس جودة الاقتراح لاحقاً
  // expectedQty = التنبّؤ اليومي وقت التحميل — مرجعُ قياس الدقّة (لا suggestedQty)
  // «تتبّع اللوط» (§٤.٧، للصنف المتتبَّع وحده): lots صفوف صريحة بالكمية الأساسية (lotId: null = غير مسمّى)؛ lotNumber
  // والتاريخان لإنشاء تشغيلة مع التحميل في شركة بلا مستودع (D4)؛ lotReason لإتلاف منتهٍ لم يُبع بتسوية نقص؛
  // deletedSalesRepId تنزيلٌ إداري من سيارة مندوب محذوف (D30، UNLOAD وحده). والردّ يحمل warnings
  // baseUnitName («الوحدة الرئيسية» §2.7): الأساس كما يعرفه كتالوج الشاشة (product.unit) — يختلف عن أساس الصنف الآن ⇒
  // 400 UNIT_INVALID (أعد جلب الأصناف)، وسباقٌ مع تحويل ⇒ 409 PRODUCT_UNITS_CHANGED أو 503 PRODUCT_UNITS_BUSY
  createLoad: (data: {
    salesRepId?: string; type?: string; note?: string; deletedSalesRepId?: string;
    items: {
      productId: string; qty: number; unitId?: string | null; baseUnitName?: string | null; suggestedQty?: number; expectedQty?: number;
      lots?: LotRef[]; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null; lotReason?: 'EXPIRED_UNSOLD_DESTROY';
    }[];
  }) =>
    api.post('/van-stock/loads', data),
  accuracy: (params: { salesRepId: string; days?: number }) =>
    api.get('/van-stock/accuracy', { params: { ...params, tz: String(-new Date().getTimezoneOffset()) } }),
  suggest: (params: { salesRepId: string; date?: string; windowDays?: number; bufferPct?: number }) =>
    api.get('/van-stock/suggest', { params }),
  setSellPermission: (salesRepId: string, canSellWithoutStock: boolean) =>
    api.patch('/van-stock/sell-permission', { salesRepId, canSellWithoutStock }),
  // عهدة أدوات السيارة: الأرصدة والحركات، والتسليم/الاستلام للإدارة
  tools: (salesRepId: string) => api.get('/van-stock/tools', { params: { salesRepId } }),
  toolMove: (data: { salesRepId: string; type: 'ISSUE' | 'RETURN'; note?: string; items: { toolName: string; qty: number }[] }) =>
    api.post('/van-stock/tools', data),
};

// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات
export const warehouseApi = {
  // asOf (YYYY-MM-DD): الرصيد وقيمته كما كانا في نهاية ذلك اليوم بتوقيت الشركة — وبدونه الآن
  stock: (asOf?: string) => api.get('/warehouse', { params: asOf ? { asOf } : undefined }),
  entries: () => api.get('/warehouse/entries'),
  // ما في مخزون السيارات الآن وقيمته بتكلفة الشراء (سيارات نطاق المستخدم)
  vans: (asOf?: string) => api.get('/warehouse/vans', { params: asOf ? { asOf } : undefined }),
  createEntry: (data: {
    type?: string; note?: string; supplier?: string;
    costsIncludeTax?: boolean;                                  // هل الأسعار المكتوبة شاملة الضريبة
    // unitCost للوارد فقط. «تتبّع اللوط» (§٤.٤): سطرٌ = تشغيلةٌ واحدة — lotId لقائمة، أو lotNumber وتاريخاها لجديدة
    // (الانتهاء إلزامي مع الصلاحية)، وnull صريح لغير المسمّى في التسوية بالزيادة. والردّ 201 يحمل lot وwarnings
    // baseUnitName («الوحدة الرئيسية» §2.8): الأساس كما رآه النموذج — كما في vanStockApi.createLoad
    items: { productId: string; qty: number; unitId?: string | null; baseUnitName?: string | null; unitCost?: number; lotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null }[];
  }) => api.post('/warehouse/entries', data),
};

// «تتبّع اللوط» — /api/lots (ميزة يفعّلها المالك لكل شركة؛ ٤٠٣ LOTS_NOT_ALLOWED دونها، والمسارات بصلاحية مخزون السيارات).
// الكميات كلها بوحدة الأساس، وlotId: null = «غير مسمّى». أشكال الأجسام والردود في lib/lots.ts (مرآة عقود الخادم)
export const lotsApi = {
  // البطاقات مع ملخّص أرصدتها: q بحثٌ بالرقم أو الصنف، وexpiringWithinDays للقريب من الانتهاء
  list: (params?: LotListParams) => api.get('/lots', { params }),
  get: (id: string) => api.get(`/lots/${id}`),
  // LotBalancesDto: المستودع وكل سيارة لصنفٍ أو أصناف (≤ ٥٠، تُرسل مفصولةً بفاصلة)، وasOf يوم YYYY-MM-DD («المخزون في تاريخ»)
  balances: (params: { productId?: string; productIds?: string[]; asOf?: string }) => api.get('/lots/balances', {
    params: { productId: params.productId, productIds: params.productIds?.length ? params.productIds.join(',') : undefined, asOf: params.asOf },
  }),
  // LotFefoDto: اقتراح تحميل qty (أساسية) لسيارة salesRepId بلا قفل — قابلٌ للتعديل، والخادم يعيد التحقق عند الحفظ
  fefo: (params: { productId: string; qty: number; salesRepId?: string }) => api.get('/lots/fefo', { params }),
  // العجوزات (خامٌ أو صالحٌ سالب) لكل الأصناف المتتبَّعة والأماكن — «سلامة الأرصدة»
  health: () => api.get('/lots/health'),
  create: (data: LotCreateRequest) => api.post('/lots', data),
  update: (id: string, data: LotUpdateRequest) => api.patch(`/lots/${id}`, data),
  // الإيقاف (HOLD) والسحب (RECALL) وإعادة التنشيط — لمستخدم غير مقيّد بنطاق، وبسببٍ إلزامي في الاتجاهين
  setStatus: (id: string, data: LotStatusRequest) => api.patch(`/lots/${id}/status`, data),
  remove: (id: string) => api.delete(`/lots/${id}`),
  // LotTraceDto: STRICT ما سُجّل باللوط، وBROAD يضيف بيع الصنف من السيارة في نافذة وجود اللوط فيها
  trace: (id: string, scope: 'STRICT' | 'BROAD' = 'STRICT') => api.get(`/lots/${id}/trace`, { params: { scope } }),
  // LotUnloadPlanDto[]: لكل سيارةٍ فيها اللوط (والمحذوفة) ما يُنزَّل عبر vanStockApi.createLoad
  unloadPlan: (id: string) => api.get(`/lots/${id}/unload-plan`),
  events: (id: string) => api.get(`/lots/${id}/events`),
  // تسمية الرصيد القائم وإعادة التصنيف والتصحيح — بُعد اللوط وحده، لا يغيّر رصيد الصنف ولا تقييمه
  relabel: (data: LotRelabelRequest) => api.post('/lots/relabel', data),
  // التفعيل الجماعي (LotTrackingResultDto) — بصلاحية المنتجات أيضاً؛ الإطفاء مع أرصدة مسمّاة يلزمه confirmLotBalances
  setTracking: (data: LotTrackingRequest) => api.post('/lots/products/tracking', data),
  // «طباعة رقم التشغيلة على فاتورة العميل» — بصلاحية إعدادات الشركة
  setSettings: (data: { lotOnInvoice: boolean }) => api.put('/lots/settings', data),
  // VanLotSnapshotDto لسيارة مندوب (الإداري يمرّر salesRepId) — ومنه تحذير حذف المندوب
  vanLotBalances: (salesRepId?: string) => api.get('/van-stock/lot-balances', { params: salesRepId ? { salesRepId } : {} }),
  // المباع والمرتجع والصافي وعدد العملاء لكل تشغيلة في الفترة (from/to بأيام الشركة) — بصلاحية التقارير وبالنطاق
  lotSales: (params: { from?: string; to?: string; productId?: string; lotId?: string }) => api.get('/reports/lot-sales', { params }),
};

// تعديل بصمات الحضور إدارياً ورفعها من Excel (backend/src/routes/attendanceAdmin.ts) — كل كتابةٍ بسببٍ مكتوب وفي سجلّ التدقيق
export const attendanceAdminApi = {
  rows: (params: { salesRepId: string; from: string; to: string; tz: number }) => api.get('/attendance-admin/rows', { params }),
  create: (data: { salesRepId: string; checkInAt: string; checkOutAt: string | null; reason: string }) => api.post('/attendance-admin/rows', data),
  update: (id: string, data: { checkInAt: string; checkOutAt: string | null; reason: string }) => api.put(`/attendance-admin/rows/${id}`, data),
  remove: (id: string, reason: string) => api.delete(`/attendance-admin/rows/${id}`, { data: { reason } }),
  import: (data: { reason: string; rows: { salesRepId: string; checkInAt: string; checkOutAt: string | null }[] }) => api.post('/attendance-admin/import', data),
  // نتائج «التحقق العشوائي من التواجد» في مدى أيام (lib/presenceReport.ts)
  presence: (params: { from: string; to: string; tz: number; salesRepId?: string }) => api.get('/attendance-admin/presence', { params }),
  // مناديب النطاق بصلاحية التتبّع وحدها (قائمة /sales-reps تشترط «إدارة المناديب»)
  reps: () => api.get('/attendance-admin/reps'),
};

// «طلب بضاعة» المناديب — المعلّق منها يظهر في نافذة «طلب مخزون»؛ updatedAt نسخةٌ يرفض الخادم ما يخالفها (409)
export const repStockRequestApi = {
  pending: () => api.get('/rep-stock-requests'),
  // unitId حين غيّر الإداري الوحدة (null للأساس)؛ baseUnitName («الوحدة الرئيسية» §2.9) الأساس كما رآه النموذج لسطرٍ بالأساس
  update: (id: string, data: { updatedAt: string; items: { productId: string; qty: number; unitId?: string | null; baseUnitName?: string | null }[] }) => api.put(`/rep-stock-requests/${id}`, data),
  reject: (id: string, updatedAt: string) => api.post(`/rep-stock-requests/${id}/reject`, { updatedAt }),
  send: (data: { ref: string; requests: { id: string; updatedAt: string }[] }) => api.post('/rep-stock-requests/send', data),
};

// محتوى الصفحة التعريفية التسويقية (CMS) — القراءة عامة، التحرير للمالك
export const siteContentApi = {
  get: () => api.get('/site-content'),
  update: (data: unknown) => api.put('/site-content', data),
};


// روابط الدفع الالكتروني (ميسر) — يصدرها مالك المنصة بمبلغ يحدده بنفسه
export const paymentsApi = {
  create: (data: { amountSar: number; description: string; tenantId?: string | null; months?: number }) => api.post('/payments', data),
  list: () => api.get('/payments'),
  refresh: (id: string) => api.post(`/payments/${id}/refresh`),
  publicStatus: (id: string) => api.get(`/payments/public-status/${id}`),
};

// عروض الأسعار — التسجيل بلا دخول من الرابط الخاص /q-fs7k2m، والسجلّ والحذف للمالك وحده.
// الباقة وسعرها وحدّها والصلاحية من كتالوج الخادم بمعرّف الباقة وحده؛ لا يُرسَل سعرٌ ولا إجماليّ.
export interface QuoteIssuePayload {
  clientRef: string;
  company: string;
  unifiedNo: string;
  packageId: string;
  cycle: 'monthly' | 'yearly';
  presenter?: string;
  note?: string;
  /** عرضٌ صدر بلا تسجيل: رقمه المطبوع ولحظته (يتحقّق الخادم من تطابقهما) */
  localNo?: string;
  issuedAt?: string;
}
export const quotesApi = {
  issue: (data: QuoteIssuePayload) => api.post('/quotes', data, { timeout: 10_000 }),
  list: (params: { q?: string; page?: number }) => api.get('/quotes/admin', { params }),
  remove: (id: string) => api.delete(`/quotes/admin/${id}`),
};

// الإدارة المالية — للمالك وحده. كل الأرقام مشتقّة في الخادم؛ الواجهة تعرض فقط.
export const financeApi = {
  snapshot: () => api.get('/finance/snapshot'),
  month: (year: number, month: number) => api.get(`/finance/month/${year}/${month}`),
  listRevenues: () => api.get('/finance/revenues'),
  settlements: () => api.get('/finance/settlements'),
  // التوريد يُكتب من منفذ paylink القائم — بابٌ واحد يكتب في دفتر الأمانات
  recordPayout: (data: { tenantId: string; amount: number; bankReference?: string; note?: string }) =>
    api.post('/paylink/owner/payouts', data),
  quarter: (year: number, q: number) => api.get(`/finance/quarter/${year}/${q}`),
  listInvoices: () => api.get('/finance/invoices'),
  backfillInvoices: () => api.post('/finance/invoices/backfill'),
  markReviewed: (id: string) => api.patch(`/finance/expenses/${id}/reviewed`),
  listExpenses: () => api.get('/finance/expenses'),
  addExpense: (data: {
    label: string; category: string; amountSar: number;
    vatSar?: number; vatIncluded?: boolean;
    vatMode?: 'none' | 'inclusive' | 'exclusive';
    currency?: 'SAR' | 'USD' | 'EUR'; fxRate?: number;
    isRecurring: boolean; startsOn: string; endsOn?: string | null; note?: string | null;
  }) => api.post('/finance/expenses', data),
  updateExpense: (id: string, data: { amountSar?: number; vatSar?: number; label?: string; category?: string }) =>
    api.patch(`/finance/expenses/${id}`, data),
  deleteExpense: (id: string) => api.delete(`/finance/expenses/${id}`),
  stopExpense: (id: string) => api.patch(`/finance/expenses/${id}/stop`),
};

// محادثات بوت واتساب — عبر وسيط الباكند (رمز البوت يبقى في بيئة الخادم)
export const waInboxApi = {
  stats: () => api.get('/wa-inbox/stats'),
  threads: (p: { stage?: string; q?: string; limit?: number }) =>
    api.get('/wa-inbox/threads', { params: p }),
  thread: (phone: string) => api.get(`/wa-inbox/thread/${phone}`),
};

// تحليلات زيارات الموقع — تسجيل عام (بلا مصادقة) + إحصاءات للمالك
export const analyticsApi = {
  track: (data: { path: string; referrer?: string; lang?: string }) => api.post('/analytics/track', data),
  stats: (days = 30) => api.get('/analytics/stats', { params: { days } }),
  // «الزيارات الحية» — المستخدمون المتصلون الآن عبر كل الشركات (للمالك)
  liveUsers: () => api.get('/analytics/live-users'),
  // المؤشّر الزمنيّ لـ«الزيارات الحية» — سلسلة عبر الوقت (24h | 7d | 30d)
  liveHistory: (range = '24h') => api.get('/analytics/live-history', { params: { range } }),
  // «استهلاك الطلبات» — عدد طلبات API لكل مستخدم/شركة (today | 7d | 30d)
  requestStats: (range = 'today') => api.get('/analytics/request-stats', { params: { range } }),
};

// استيراد بيانات الشركة من أنظمتها السابقة (Excel → صفوف)
export const importApi = {
  run: (endpoint: string, rows: Record<string, unknown>[]) => api.post(endpoint, { rows }),
  batches: () => api.get('/import/batches'),
  revert: (id: string) => api.post(`/import/batches/${id}/revert`),
};

// رسائل التواصل من الصفحة التعريفية
export const contactApi = {
  send: (data: { name: string; email: string; phone?: string; message: string }) => api.post('/contact', data),
  // طلب اشتراك جديد (صفحة تسجيل طلب اشتراك) — يصل للإدارة بريدياً
  subscription: (data: { companyName: string; contactName: string; email: string; phone: string; country: string; city?: string; repsCount?: string; notes?: string; kind?: 'quote' }) =>
    api.post('/contact/subscription', data),
};

// طلبات الدعم الفني من لوحة الأدمن — تصل إلى help@fieldsa.net
export const supportApi = {
  send: (data: { subject?: string; category?: string; message: string }) => api.post('/support', data),
};

