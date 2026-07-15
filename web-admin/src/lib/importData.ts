// استيراد بيانات الشركات السابقة من Excel — قراءة مرنة (تطابق عناوين عربية/إنجليزية/مرادفات) + قوالب.
import { exportExcel } from '../utils/excel';
import { SALES_CHANNELS } from './channels';

// قراءة أول ورقة من ملف Excel/CSV → صفوف ككائنات (المفاتيح = عناوين الأعمدة)
export async function parseExcelFile(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[];
}

// تطبيع عنوان العمود للمطابقة (إزالة تشكيل/مسافات/فواصل + حالة الأحرف)
const norm = (s: string) => String(s).trim().toLowerCase().replace(/[ً-ٰٟ]/g, '').replace(/[\s_\-.]/g, '');

// يلتقط قيمة حقل من صفّ حسب قائمة أسماء أعمدة مقبولة (أول تطابق)
function pick(row: Record<string, unknown>, aliases: string[]): string {
  const keys = Object.keys(row);
  for (const a of aliases) {
    const na = norm(a);
    const k = keys.find((kk) => norm(kk) === na);
    if (k != null && row[k] !== '' && row[k] != null) return String(row[k]).trim();
  }
  return '';
}
const numOr = (v: string, d: number | undefined): number | undefined => {
  if (!v) return d;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? d : n;
};
// نص قناة عربي/إنجليزي → كود
const channelCode = (v: string): string => {
  if (!v) return '';
  const n = norm(v);
  const hit = SALES_CHANNELS.find((c) => norm(c.ar) === n || norm(c.en) === n || c.code.toLowerCase() === n);
  return hit ? hit.code : '';
};

export interface TransformOut { valid: Record<string, unknown>[]; errors: { row: number; message: string }[] }

// ============ العملاء ============
const A_CUST = {
  name: ['الاسم', 'اسم العميل', 'العميل', 'name', 'customer', 'customer name', 'client'],
  phone: ['الجوال', 'رقم الجوال', 'الهاتف', 'التلفون', 'phone', 'mobile', 'tel'],
  code: ['الكود', 'كود العميل', 'رقم العميل', 'code', 'customer code', 'account', 'account no', 'id'],
  businessName: ['المنشأة', 'اسم المنشأة', 'النشاط', 'business', 'business name', 'company'],
  commercialReg: ['السجل التجاري', 'commercial reg', 'cr'],
  taxNumber: ['الرقم الضريبي', 'الرقم الضريبى', 'tax number', 'vat', 'vat number'],
  city: ['المدينة', 'city'],
  district: ['الحي', 'المنطقة', 'district', 'area'],
  address: ['العنوان', 'address'],
  channel: ['القناة', 'قناة البيع', 'channel'],
  creditLimit: ['حد الائتمان', 'الحد الائتماني', 'credit limit', 'credit'],
  paymentDays: ['فترة السداد', 'أيام السداد', 'payment days', 'terms'],
};
function toCustomers(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const name = pick(row, A_CUST.name);
    if (!name) { errors.push({ row: i + 2, message: 'اسم العميل مفقود' }); return; }
    valid.push({
      name, phone: pick(row, A_CUST.phone), code: pick(row, A_CUST.code) || undefined,
      businessName: pick(row, A_CUST.businessName) || undefined,
      commercialReg: pick(row, A_CUST.commercialReg) || undefined,
      taxNumber: pick(row, A_CUST.taxNumber) || undefined,
      city: pick(row, A_CUST.city) || undefined, district: pick(row, A_CUST.district) || undefined,
      address: pick(row, A_CUST.address) || undefined,
      channel: channelCode(pick(row, A_CUST.channel)) || undefined,
      creditLimit: numOr(pick(row, A_CUST.creditLimit), undefined),
      paymentDays: numOr(pick(row, A_CUST.paymentDays), undefined),
    });
  });
  return { valid, errors };
}

// ============ المنتجات ============
const A_PROD = {
  code: ['الكود', 'كود الصنف', 'رقم الصنف', 'code', 'sku', 'item code', 'item no'],
  name: ['الاسم', 'اسم الصنف', 'الصنف', 'name', 'item', 'product', 'description'],
  unit: ['الوحدة', 'وحدة القياس', 'unit', 'uom'],
  basePrice: ['السعر', 'السعر الأساسي', 'سعر البيع', 'price', 'base price', 'unit price'],
  taxPct: ['الضريبة', 'نسبة الضريبة', 'tax', 'vat', 'tax %'],
  barcode: ['الباركود', 'barcode', 'ean'],
  category: ['الفئة', 'التصنيف', 'المجموعة', 'category', 'group'],
};
function toProducts(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const code = pick(row, A_PROD.code); const name = pick(row, A_PROD.name);
    if (!code || !name) { errors.push({ row: i + 2, message: !code ? 'كود الصنف مفقود' : 'اسم الصنف مفقود' }); return; }
    valid.push({
      code, name, unit: pick(row, A_PROD.unit) || undefined,
      basePrice: numOr(pick(row, A_PROD.basePrice), undefined),
      taxPct: numOr(pick(row, A_PROD.taxPct), undefined),
      barcode: pick(row, A_PROD.barcode) || undefined,
      category: pick(row, A_PROD.category) || undefined,
    });
  });
  return { valid, errors };
}

// ============ الأرصدة الافتتاحية ============
const A_BAL = {
  customerCode: ['كود العميل', 'رقم العميل', 'الكود', 'customer code', 'account', 'account no', 'code'],
  phone: ['الجوال', 'رقم الجوال', 'phone', 'mobile'],
  balance: ['الرصيد', 'الرصيد الافتتاحي', 'رصيد افتتاحي', 'الرصيد المدين', 'opening balance', 'balance'],
  date: ['التاريخ', 'date'],
};
function toBalances(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const cc = pick(row, A_BAL.customerCode); const ph = pick(row, A_BAL.phone);
    const bal = numOr(pick(row, A_BAL.balance), undefined);
    if (!cc && !ph) { errors.push({ row: i + 2, message: 'معرّف العميل مفقود (الكود أو الجوال)' }); return; }
    if (bal === undefined) { errors.push({ row: i + 2, message: 'الرصيد مفقود' }); return; }
    valid.push({ customerCode: cc || undefined, phone: ph || undefined, balance: bal, date: pick(row, A_BAL.date) || undefined });
  });
  return { valid, errors };
}

// ============ كشوف الحسابات / دفتر الأستاذ ============
const A_LED = {
  customerCode: ['كود العميل', 'رقم العميل', 'الكود', 'customer code', 'account', 'code'],
  phone: ['الجوال', 'رقم الجوال', 'phone', 'mobile'],
  date: ['التاريخ', 'date'],
  description: ['البيان', 'الوصف', 'التفاصيل', 'description', 'details', 'memo'],
  debit: ['مدين', 'عليه', 'debit', 'dr'],
  credit: ['دائن', 'له', 'credit', 'cr'],
};
function toLedger(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const cc = pick(row, A_LED.customerCode); const ph = pick(row, A_LED.phone);
    const debit = numOr(pick(row, A_LED.debit), 0) || 0; const credit = numOr(pick(row, A_LED.credit), 0) || 0;
    if (!cc && !ph) { errors.push({ row: i + 2, message: 'معرّف العميل مفقود' }); return; }
    if (!debit && !credit) { errors.push({ row: i + 2, message: 'لا يوجد مبلغ مدين ولا دائن' }); return; }
    valid.push({ customerCode: cc || undefined, phone: ph || undefined, date: pick(row, A_LED.date) || undefined, description: pick(row, A_LED.description) || undefined, debit, credit });
  });
  return { valid, errors };
}

// ============ قوائم الأسعار (سعر خاص لكل عميل/صنف) ============
const A_PRC = {
  customerCode: ['كود العميل', 'رقم العميل', 'customer code', 'account'],
  phone: ['الجوال', 'رقم الجوال', 'phone', 'mobile'],
  productCode: ['كود الصنف', 'رقم الصنف', 'product code', 'item code', 'sku'],
  price: ['السعر', 'السعر الخاص', 'price', 'special price'],
};
function toPrices(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const cc = pick(row, A_PRC.customerCode); const ph = pick(row, A_PRC.phone);
    const pc = pick(row, A_PRC.productCode); const price = numOr(pick(row, A_PRC.price), undefined);
    if (!cc && !ph) { errors.push({ row: i + 2, message: 'معرّف العميل مفقود' }); return; }
    if (!pc) { errors.push({ row: i + 2, message: 'كود الصنف مفقود' }); return; }
    if (price === undefined) { errors.push({ row: i + 2, message: 'السعر مفقود' }); return; }
    valid.push({ customerCode: cc || undefined, phone: ph || undefined, productCode: pc, price });
  });
  return { valid, errors };
}

// ============ سجلّ الأنواع ============
export type ImportKind = 'customers' | 'products' | 'balances' | 'ledger' | 'prices';
export interface ImportTypeDef {
  id: ImportKind; label: string; endpoint: string;
  transform: (rows: Record<string, unknown>[]) => TransformOut;
  template: Record<string, string>;   // عنوان العمود → مثال
}
export const IMPORT_TYPES: Record<ImportKind, ImportTypeDef> = {
  customers: {
    id: 'customers', label: 'العملاء', endpoint: '/import/customers', transform: toCustomers,
    template: { 'الكود': 'C-001', 'الاسم': 'مؤسسة الأمل التجارية', 'المنشأة': 'الأمل', 'الجوال': '0500000000', 'الرقم الضريبي': '300000000000003', 'السجل التجاري': '1010000000', 'المدينة': 'الرياض', 'الحي': 'العليا', 'العنوان': 'شارع الملك فهد', 'القناة': 'جملة', 'حد الائتمان': '5000', 'فترة السداد': '30' },
  },
  products: {
    id: 'products', label: 'المنتجات', endpoint: '/import/products', transform: toProducts,
    template: { 'الكود': 'P-001', 'الاسم': 'عسل سدر 1كجم', 'الوحدة': 'حبة', 'السعر': '85', 'الضريبة': '15', 'الباركود': '6291000000001', 'الفئة': 'عسل' },
  },
  balances: {
    id: 'balances', label: 'الأرصدة الافتتاحية', endpoint: '/import/balances', transform: toBalances,
    template: { 'كود العميل': 'C-001', 'الجوال': '0500000000', 'الرصيد الافتتاحي': '1500', 'التاريخ': '2026-01-01' },
  },
  ledger: {
    id: 'ledger', label: 'كشوف الحسابات / دفتر الأستاذ', endpoint: '/import/ledger', transform: toLedger,
    template: { 'كود العميل': 'C-001', 'التاريخ': '2026-01-05', 'البيان': 'فاتورة رقم 1001', 'مدين': '500', 'دائن': '0' },
  },
  prices: {
    id: 'prices', label: 'قوائم الأسعار', endpoint: '/import/prices', transform: toPrices,
    template: { 'كود العميل': 'C-001', 'كود الصنف': 'P-001', 'السعر': '80' },
  },
};

// تنزيل قالب Excel لنوع معيّن (صف مثال واحد)
export async function downloadTemplate(kind: ImportKind): Promise<void> {
  const t = IMPORT_TYPES[kind];
  await exportExcel([{ name: t.label, rows: [t.template], colWidths: Object.keys(t.template).map(() => 18) }], `قالب-${t.label}`);
}
