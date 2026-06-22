import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
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
};

export const invoiceApi = {
  list: (params?: Record<string, string | number>) => api.get('/invoices', { params }),
  get: (id: string) => api.get(`/invoices/${id}`),
  create: (data: unknown) => api.post('/invoices', data),
  cancel: (id: string) => api.patch(`/invoices/${id}/cancel`),
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
  me: () => api.get('/auth/me'),
  changePassword: (data: { currentPassword: string; newPassword: string }) => api.post('/auth/change-password', data),
};

export const companyApi = {
  get: () => api.get('/company'),
  update: (data: unknown) => api.put('/company', data),
};

// إدارة الشركات — لمالك المنصّة (السوبر أدمن)
export const tenantApi = {
  list: () => api.get('/tenants'),
  get: (id: string) => api.get(`/tenants/${id}`),
  create: (data: unknown) => api.post('/tenants', data),
  update: (id: string, data: unknown) => api.put(`/tenants/${id}`, data),
  resetAdmin: (id: string, data: { adminId: string; newPassword: string }) => api.post(`/tenants/${id}/reset-admin`, data),
  impersonate: (id: string) => api.post(`/tenants/${id}/impersonate`),
  remove: (id: string) => api.delete(`/tenants/${id}`),
};
