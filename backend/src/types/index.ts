import { Request } from 'express';

export interface AuthPayload {
  id: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'SALES_REP';
  name: string;
  tenantId?: string; // معرّف الشركة — غير موجود للسوبر أدمن
  impersonated?: boolean; // جلسة تصفّح المالك لشركة (تُقيّد بعض الإجراءات)
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
  canReceiveUserCollections?: boolean;
  /** الطلب مصادَقٌ بمفتاح API (services/apiKeys.ts) لا بجلسة — معرّف المفتاح */
  apiKeyId?: string;
  /** المفتاح أصدره الدعم الفني في جلسة المالك — يُسجَّل OWNER: في التدقيق (actorOf) بلا تجاوزات الجلسة */
  ownerIssuedKey?: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
  query: Record<string, any>;
  params: Record<string, any>;
  body: any;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  search?: string;
  from?: string;
  to?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: unknown;
  pagination?: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}
