import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
});

// مفاتيح الجلسة حسب المساحة الحالية: لوحة المالك (sa_) أو لوحة الشركة (token)
// يطابق العزل في store/authStore.ts ويمنع تداخل جلستي المالك والأدمن.
function spaceKeys() {
  const p = window.location.pathname;
  const platform = p.startsWith('/platform') || p.startsWith('/owner');
  return platform
    ? { tokenKey: 'sa_token', userKey: 'sa_user', loginPath: '/owner' }
    : { tokenKey: 'token', userKey: 'user', loginPath: '/login' };
}

api.interceptors.request.use(config => {
  const token = localStorage.getItem(spaceKeys().tokenKey);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  r => r,
  err => {
    // لا نتعامل مع 401 لطلب تسجيل الدخول نفسه (لتظهر رسالة «بيانات غير صحيحة» في مكانها بلا إعادة توجيه)
    const isLogin = (err.config?.url as string | undefined)?.includes('/auth/login');
    if (err.response?.status === 401 && !isLogin) {
      const { tokenKey, userKey, loginPath } = spaceKeys();
      [tokenKey, userKey, 'impersonating'].forEach(k => localStorage.removeItem(k));
      window.location.href = loginPath; // المالك→/owner ، الأدمن→/login (كلٌّ لمدخله الصحيح)
    }
    return Promise.reject(err);
  }
);

export default api;

export const customerApi = {
  list: (params?: Record<string, string | number>) => api.get('/customers', { params }),
  get: (id: string) => api.get(`/customers/${id}`),
  create: (data: unknown) => api.post('/customers', data),
  update: (id: string, data: unknown) => api.put(`/customers/${id}`, data),
  statement: (id: string, params?: Record<string, string>) => api.get(`/customers/${id}/statement`, { params }),
  invoices: (id: string) => api.get(`/customers/${id}/invoices`),
  updatePrices: (id: string, prices: unknown) => api.put(`/customers/${id}/prices`, { prices }),
  remove: (id: string) => api.delete(`/customers/${id}`),
};

export const productApi = {
  list: (params?: Record<string, string | number>) => api.get('/products', { params }),
  get: (id: string) => api.get(`/products/${id}`),
  create: (data: unknown) => api.post('/products', data),
  update: (id: string, data: unknown) => api.put(`/products/${id}`, data),
  categories: () => api.get('/products/categories'),
  createCategory: (data: unknown) => api.post('/products/categories', data),
  updatePriceTiers: (id: string, tiers: unknown) => api.put(`/products/${id}/price-tiers`, { tiers }),
};

export const salesRepApi = {
  list: (params?: Record<string, string | number>) => api.get('/sales-reps', { params }),
  get: (id: string) => api.get(`/sales-reps/${id}`),
  create: (data: unknown) => api.post('/sales-reps', data),
  update: (id: string, data: unknown) => api.put(`/sales-reps/${id}`, data),
  stats: (id: string, params?: Record<string, string>) => api.get(`/sales-reps/${id}/stats`, { params }),
  remove: (id: string) => api.delete(`/sales-reps/${id}`),
  collection: (id: string) => api.get(`/sales-reps/${id}/collection`),
  settle: (id: string, data: { amount: number; note?: string }) => api.post(`/sales-reps/${id}/settlements`, data),
  settlements: (id: string) => api.get(`/sales-reps/${id}/settlements`),
};

export const invoiceApi = {
  list: (params?: Record<string, string | number>) => api.get('/invoices', { params }),
  get: (id: string) => api.get(`/invoices/${id}`),
  create: (data: unknown) => api.post('/invoices', data),
  cancel: (id: string) => api.patch(`/invoices/${id}/cancel`),
  // تحكّم الأدمن: هل يعود المرتجع لمخزون السيارة؟
  setRestock: (id: string, returnToStock: boolean) => api.patch(`/invoices/${id}/restock`, { returnToStock }),
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
  collections: (params?: Record<string, string>) => api.get('/reports/collections', { params }),
  balances: (params?: Record<string, string>) => api.get('/reports/balances', { params }),
  repPerformance: (params?: Record<string, string>) => api.get('/reports/rep-performance', { params }),
};

export const notificationApi = {
  list: () => api.get('/notifications'),
  markRead: (id: string) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),
};

export const authApi = {
  login: (data: { username: string; password: string; role: string }) => api.post('/auth/login', data),
  signup: (data: { companyName: string; adminName: string; email: string; password: string; phone?: string; countryCode?: string; vertical?: 'distribution' | 'restaurant' }) => api.post('/auth/signup', data),
  me: () => api.get('/auth/me'),
  changePassword: (data: { currentPassword: string; newPassword: string }) => api.post('/auth/change-password', data),
  verifyEmail: (token: string) => api.post('/auth/verify-email', { token }),
  resendVerification: () => api.post('/auth/resend-verification'),
};

export const companyApi = {
  get: () => api.get('/company'),
  update: (data: unknown) => api.put('/company', data),
};

// مستخدمو الشركة الذين يدخلون لوحة الإدارة
export const companyUserApi = {
  list: () => api.get('/company-users'),
  create: (data: unknown) => api.post('/company-users', data),
  update: (id: string, data: unknown) => api.put(`/company-users/${id}`, data),
};

export const erpApi = {
  settings: () => api.get('/erp/settings'),
  saveSettings: (data: unknown) => api.put('/erp/settings', data),
  test: () => api.post('/erp/test'),
  sync: (resource: 'all' | 'customers' | 'products' | 'invoices' | 'receipts') => api.post('/erp/sync', { resource }),
  logs: () => api.get('/erp/logs'),
};

// إدارة الشركات — لمالك المنصّة (السوبر أدمن)
export const tenantApi = {
  list: () => api.get('/tenants'),
  get: (id: string) => api.get(`/tenants/${id}`),
  performance: (id: string) => api.get(`/tenants/${id}/performance`),
  create: (data: unknown) => api.post('/tenants', data),
  update: (id: string, data: unknown) => api.put(`/tenants/${id}`, data),
  resetAdmin: (id: string, data: { adminId?: string; newPassword: string }) => api.post(`/tenants/${id}/reset-admin`, data),
  impersonate: (id: string) => api.post(`/tenants/${id}/impersonate`),
  remove: (id: string) => api.delete(`/tenants/${id}`),
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
  live: () => api.get('/tracking/live'),
  route: (salesRepId: string, date?: string) => api.get('/tracking/route', { params: { salesRepId, ...(date ? { date } : {}) } }),
};

// مخزون سيارة المندوب — ملخّص ومخزون وحركة لكل مندوب
export const vanStockApi = {
  summary: () => api.get('/van-stock/summary'),
  current: (salesRepId: string) => api.get('/van-stock/current', { params: { salesRepId } }),
  loads: (salesRepId?: string) => api.get('/van-stock/loads', { params: salesRepId ? { salesRepId } : {} }),
  movements: (salesRepId: string) => api.get('/van-stock/movements', { params: { salesRepId } }),
  createLoad: (data: { salesRepId?: string; type?: string; note?: string; items: { productId: string; qty: number }[] }) =>
    api.post('/van-stock/loads', data),
};

// محتوى الصفحة التعريفية التسويقية (CMS) — القراءة عامة، التحرير للمالك
export const siteContentApi = {
  get: () => api.get('/site-content'),
  update: (data: unknown) => api.put('/site-content', data),
};

// تحليلات زيارات الموقع — تسجيل عام (بلا مصادقة) + إحصاءات للمالك
export const analyticsApi = {
  track: (data: { path: string; referrer?: string; lang?: string }) => api.post('/analytics/track', data),
  stats: (days = 30) => api.get('/analytics/stats', { params: { days } }),
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
  subscription: (data: { companyName: string; contactName: string; email: string; phone: string; country: string; city?: string; repsCount?: string; notes?: string }) =>
    api.post('/contact/subscription', data),
};

// طلبات الدعم الفني من لوحة الأدمن — تصل إلى help@fieldsa.net
export const supportApi = {
  send: (data: { subject?: string; category?: string; message: string }) => api.post('/support', data),
};

// ── عمودية المطاعم (Field Restaurant) — القوائم والصالات والطاولات (M2) ──
export const restaurantApi = {
  // القائمة
  menu: () => api.get('/restaurant/menu'),
  createCategory: (data: unknown) => api.post('/restaurant/menu/categories', data),
  updateCategory: (id: string, data: unknown) => api.put(`/restaurant/menu/categories/${id}`, data),
  deleteCategory: (id: string) => api.delete(`/restaurant/menu/categories/${id}`),
  createItem: (data: unknown) => api.post('/restaurant/menu/items', data),
  updateItem: (id: string, data: unknown) => api.put(`/restaurant/menu/items/${id}`, data),
  deleteItem: (id: string) => api.delete(`/restaurant/menu/items/${id}`),
  groups: () => api.get('/restaurant/menu/groups'),
  createGroup: (data: unknown) => api.post('/restaurant/menu/groups', data),
  updateGroup: (id: string, data: unknown) => api.put(`/restaurant/menu/groups/${id}`, data),
  deleteGroup: (id: string) => api.delete(`/restaurant/menu/groups/${id}`),
  // الصالات والطاولات
  tables: () => api.get('/restaurant/tables'),
  createArea: (data: unknown) => api.post('/restaurant/tables/areas', data),
  updateArea: (id: string, data: unknown) => api.put(`/restaurant/tables/areas/${id}`, data),
  deleteArea: (id: string) => api.delete(`/restaurant/tables/areas/${id}`),
  createTable: (data: unknown) => api.post('/restaurant/tables', data),
  updateTable: (id: string, data: unknown) => api.put(`/restaurant/tables/${id}`, data),
  deleteTable: (id: string) => api.delete(`/restaurant/tables/${id}`),
};
