import { Request } from 'express';

export interface AuthPayload {
  id: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'SALES_REP';
  name: string;
  tenantId?: string; // معرّف الشركة — غير موجود للسوبر أدمن
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
  canManageCompanyUsers?: boolean;
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
