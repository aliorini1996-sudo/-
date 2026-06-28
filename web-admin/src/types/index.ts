export interface User {
  id: string;
  name: string;
  email?: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'SALES_REP';
  tenantId?: string;
  companyName?: string;
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

export interface Tenant {
  id: string;
  name: string;
  isActive: boolean;
  maxSalesReps?: number | null; // null = عدد مناديب غير محدود
  maxAdminUsers?: number | null; // null = عدد مستخدمي شركة غير محدود
  subscriptionEndsAt?: string | null;
  notes?: string | null;
  createdAt: string;
  admins?: { id?: string; name: string; email: string; isActive?: boolean }[];
  _count?: { admins?: number; salesReps?: number; customers?: number; invoices?: number; receipts?: number; products?: number };
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
  canManageCompanyUsers: boolean;
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
}

export interface ErpSyncLog {
  id: string;
  resource: string;
  direction: string;
  status: 'SUCCESS' | 'FAILED';
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
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  creditLimit: number;
  paymentDays: number;
  balance: number;
  totalSales: number;
  totalCollected: number;
  createdAt: string;
}

export interface Product {
  id: string;
  code: string;
  name: string;
  barcode?: string;
  unit: string;
  basePrice: number;
  taxPct: number;
  image?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  categoryId?: string;
  category?: { id: string; name: string };
  priceTiers?: PriceTier[];
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
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  productId: string;
  product: { id: string; name: string; code: string; unit: string };
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  taxPct: number;
  taxAmt: number;
  lineTotal: number;
}

export interface Invoice {
  id: string;
  number: string;
  customer: { id: string; name: string; phone: string };
  salesRep: { id: string; name: string };
  type: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  invoiceDate: string;
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
}

export interface Receipt {
  id: string;
  number: string;
  customer: { id: string; name: string };
  salesRep: { id: string; name: string };
  receiptDate: string;
  amount: number;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE';
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
  invoice?: { number: string };
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
  month: { salesTotal: number; invoicesCount: number; collectionsTotal: number; receiptsCount: number };
  customers: { total: number; withBalance: number; creditExceeded: number };
  topReps: { id: string; name: string; invoicesCount: number; salesTotal: number; collectionsTotal: number }[];
  topCustomers: { id: string; name: string; totalSales: number; balance: number }[];
  recentInvoices: Invoice[];
}
