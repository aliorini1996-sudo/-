import api from './client';

// ═══ «ربط الدفاتر» L1 (طلب المالك ١٣ نوفمبر ٢٠٢٦): سجلّ الموردين وكشف حسابهم وسندات الصرف — مرآة عقد
// routes/suppliers.ts وroutes/supplierPayments.ts في الخادم. المبالغ أرقامٌ بوحدة العملة (الخادم يحوّل الملّي)،
// والتواريخ اليومية نصوص YYYY-MM-DD بتوقيت الشركة. كل دالة تعيد AxiosResponse كبقية api/client.ts.

/** المورّد — balance موجبٌ = مستحقٌّ للمورّد علينا، وسالبٌ = دفعةٌ مقدَّمة له */
export interface Supplier {
  id: string;
  name: string;
  nameEn: string | null;
  code: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  countryCode: string;
  iban: string | null;
  bankName: string | null;
  /** مدة السداد بالأيام (0..365) — null ⇒ الآجل بلا تاريخ استحقاق محسوب */
  paymentDays: number | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  balance: number;
  openBillsCount: number;
}

/** جسم إنشاء/تعديل المورّد — الاسم وحده مطلوب في الإنشاء؛ isActive للتعديل (الأرشفة والاستعادة) */
export interface SupplierInput {
  name: string;
  nameEn?: string | null;
  code?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  iban?: string | null;
  bankName?: string | null;
  paymentDays?: number | null;
  notes?: string | null;
}
export type SupplierUpdateInput = Partial<SupplierInput> & { isActive?: boolean };

export type SupplierStatusFilter = 'active' | 'archived' | 'all';

/** سطر كشف حساب المورّد: مدين يُنقص المستحقّ (دفعة/مرتجع)، ودائن يزيده (فاتورة/إلغاء دفعة) — balance الرصيد الجاري بعد السطر */
export interface SupplierStatementLine {
  id: string;
  date: string;
  kind: string;
  ref: string | null;
  description: string | null;
  debit: number;
  credit: number;
  balance: number;
  dueDate: string | null;
  warehouseEntryId: string | null;
  supplierPaymentId: string | null;
  attachmentsCount: number;
}

export interface SupplierStatement {
  supplier: Supplier;
  currency: string;
  from: string | null;
  to: string | null;
  opening: number;
  closing: number;
  totalDebit: number;
  totalCredit: number;
  lines: SupplierStatementLine[];
}

/** فاتورة مورّد آجلة غير ملغاة بقي منها شيء — daysOverdue صفرٌ قبل الاستحقاق */
export interface OpenBill {
  warehouseEntryId: string;
  supplierRef: string | null;
  billDate: string | null;
  dueDate: string | null;
  total: number;
  paid: number;
  returned: number;
  outstanding: number;
  daysOverdue: number;
}

/**
 * صفّ أعمار الذمم الدائنة لمورّدٍ واحد (الشرائح بأيام التأخّر عن الاستحقاق؛ total = Σ متبقّي فواتيره المفتوحة).
 * الاختيارية يرسلها الخادم إضافةً (agingJson): balance رصيد الكشف حتى asOf، وunapplied = balance − total (سالبٌ لدفعةٍ مقدّمة
 * غير مخصَّصة أو مرتجعٍ زاد على المتبقّي، وموجبٌ لافتتاحيٍّ دائن) — فيطابق التقريرُ الكشفَ بفرق صفر
 */
export interface SupplierAgingRow {
  supplierId: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  balance?: number;
  unapplied?: number;
  openBillsCount?: number;
}
export type SupplierAgingTotals = Omit<SupplierAgingRow, 'supplierId' | 'name' | 'code' | 'isActive' | 'openBillsCount'>;
export interface SupplierAging { asOf: string; rows: SupplierAgingRow[]; totals: SupplierAgingTotals }

export type SupplierPaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'REP_CUSTODY';
export type SupplierPaymentStatus = 'POSTED' | 'CANCELLED';

export interface SupplierPaymentAllocationView { warehouseEntryId: string; supplierRef: string | null; amount: number }

/** سند صرف المورّد (SP-000123) — autoForEntryId للسند الآلي لشراءٍ نقدي (يُلغى بإلغاء الحركة لا من هنا) */
export interface SupplierPaymentView {
  id: string;
  number: number;
  displayNumber: string;
  supplierId: string;
  supplierName: string;
  amount: number;
  method: SupplierPaymentMethod;
  salesRepId: string | null;
  salesRepName: string | null;
  paidAt: string;
  reference: string | null;
  note: string | null;
  status: SupplierPaymentStatus;
  cancelledAt: string | null;
  cancelReason: string | null;
  autoForEntryId: string | null;
  allocations: SupplierPaymentAllocationView[];
  createdBy: string | null;
  createdAt: string;
}

/**
 * جسم سند صرفٍ جديد — allocations يدويّ (لكل فاتورة ≤ متبقّيها، وΣ ≤ المبلغ) أو autoAllocate على الأقدم استحقاقاً؛
 * الزائد يبقى دفعةً مقدَّمة. clientRef يجعل إعادة الإرسال بعد انقطاعٍ تعيد السند نفسه لا سنداً ثانياً
 */
export interface SupplierPaymentInput {
  supplierId: string;
  amount: number;
  method: SupplierPaymentMethod;
  salesRepId?: string | null;
  paidAt: string;
  reference?: string | null;
  note?: string | null;
  clientRef?: string | null;
  allocations?: { warehouseEntryId: string; amount: number }[];
  autoAllocate?: boolean;
}

/** يُسقط المفاتيح الفارغة من معاملات الاستعلام — فلا يُرسَل `search=` ولا `status=undefined` */
function cleanParams<T extends Record<string, unknown>>(p: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export const suppliersApi = {
  list: (p: { search?: string; status?: SupplierStatusFilter; page?: number; limit?: number } = {}) =>
    api.get('/suppliers', { params: cleanParams(p) }),
  get: (id: string) => api.get(`/suppliers/${id}`),
  create: (body: SupplierInput) => api.post('/suppliers', body),
  update: (id: string, body: SupplierUpdateInput) => api.put(`/suppliers/${id}`, body),
  remove: (id: string) => api.delete(`/suppliers/${id}`),
  statement: (id: string, p: { from?: string; to?: string } = {}) =>
    api.get(`/suppliers/${id}/statement`, { params: cleanParams(p) }),
  openBills: (id: string) => api.get(`/suppliers/${id}/open-bills`),
  aging: (asOf?: string) => api.get('/suppliers/aging', { params: cleanParams({ asOf }) }),
};

export const supplierPaymentsApi = {
  list: (p: { supplierId?: string; from?: string; to?: string; status?: string; page?: number; limit?: number } = {}) =>
    api.get('/supplier-payments', { params: cleanParams(p) }),
  get: (id: string) => api.get(`/supplier-payments/${id}`),
  create: (body: SupplierPaymentInput) => api.post('/supplier-payments', body),
  cancel: (id: string, reason?: string) =>
    api.post(`/supplier-payments/${id}/cancel`, reason && reason.trim() ? { reason: reason.trim() } : {}),
};
