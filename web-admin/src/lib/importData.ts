// استيراد بيانات الشركات السابقة من Excel — بلا قالب: كشف آلي لصف العناوين + مطابقة أعمدة ذكية
// (تطابق تام ثم احتواء) تشمل مرادفات أنظمة مثل أودو، وتطبيع عربي، وتواريخ حقيقية.
import { SALES_CHANNELS } from './channels';

const val = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).trim();
};
// تطبيع عنوان/قيمة للمطابقة: إزالة تشكيل/تطويل، توحيد الهمزات والتاء المربوطة والياء، وإزالة الفواصل
const norm = (s: string): string => String(s).trim().toLowerCase()
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىي]/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .replace(/[\s_\-.()/]/g, '');

// كشف صف العناوين (يفضّل الصف ذا النصوص الأكثر) — يتجاوز عناوين التقارير الفوقية
function detectHeaderRow(matrix: unknown[][]): number {
  let best = 0, bs = -1;
  for (let i = 0; i < Math.min(15, matrix.length); i++) {
    const r = matrix[i] || [];
    const ne = r.filter((c) => val(c) !== '').length;
    const str = r.filter((c) => typeof c === 'string' && val(c) !== '' && isNaN(Number(c))).length;
    const sc = ne + str * 3;
    if (ne >= 2 && sc > bs) { bs = sc; best = i; }
  }
  return best;
}

// قراءة أول ورقة → صفوف ككائنات (كشف صف العناوين آلياً + تواريخ حقيقية)
export async function parseExcelFile(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
  const h = detectHeaderRow(matrix);
  const heads = (matrix[h] || []).map((x) => val(x));
  const out: Record<string, unknown>[] = [];
  for (let r = h + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || row.every((c) => val(c) === '')) continue;
    const o: Record<string, unknown> = {};
    heads.forEach((hd, j) => { if (hd) o[hd] = row[j] ?? ''; });
    out.push(o);
  }
  return out;
}

// التقاط قيمة حقل: تطابق تام (بعد التطبيع) ثم احتواء العنوان للمرادف
function pick(row: Record<string, unknown>, aliases: string[]): string {
  const keys = Object.keys(row).map((k) => ({ k, n: norm(k) }));
  for (const a of aliases) { const na = norm(a); const hit = keys.find((x) => x.n === na); if (hit) { const v = val(row[hit.k]); if (v) return v; } }
  for (const a of aliases) { const na = norm(a); if (na.length < 3) continue; const hit = keys.find((x) => x.n.includes(na)); if (hit) { const v = val(row[hit.k]); if (v) return v; } }
  return '';
}
const numOr = (v: string, d: number | undefined): number | undefined => {
  if (!v) return d;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? d : n;
};
const channelCode = (v: string): string => {
  if (!v) return '';
  const n = norm(v);
  const hit = SALES_CHANNELS.find((c) => norm(c.ar) === n || norm(c.en) === n || c.code.toLowerCase() === n);
  return hit ? hit.code : '';
};

export interface TransformOut { valid: Record<string, unknown>[]; errors: { row: number; message: string }[] }

// أسماء أعمدة مقبولة (تشمل مرادفات أودو والعربية والإنجليزية)
const CUST_ID = {
  name: ['اسم العرض', 'الاسم', 'اسم العميل', 'العميل', 'اسم الشريك', 'الشريك', 'partner', 'display name', 'name', 'customer', 'client'],
  code: ['كود العميل', 'رقم العميل', 'customer code', 'account no', 'account number'],
  phone: ['رقم الهاتف', 'الجوال', 'رقم الجوال', 'الهاتف', 'هاتف', 'التلفون', 'phone', 'mobile', 'tel', 'telephone'],
};

// ============ العملاء ============
const A_CUST = {
  ...CUST_ID,
  email: ['البريد الإلكتروني', 'البريد', 'الايميل', 'email', 'e-mail', 'mail'],
  businessName: ['اسم المنشأة', 'المنشأة', 'النشاط التجاري', 'business name', 'company'],
  commercialReg: ['السجل التجاري', 'رقم السجل', 'commercial reg', 'cr'],
  taxNumber: ['الرقم الضريبي', 'الرقم الضريبى', 'tax number', 'vat', 'vat number'],
  city: ['المدينة', 'city'],
  district: ['الحي', 'المنطقة', 'district', 'area'],
  address: ['العنوان', 'address'],
  channel: ['قناة البيع', 'القناة', 'channel'],
  creditLimit: ['حد الائتمان', 'الحد الائتماني', 'credit limit'],
  paymentDays: ['فترة السداد', 'أيام السداد', 'payment days'],
};
function toCustomers(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const name = pick(row, A_CUST.name);
    if (!name) { errors.push({ row: i + 2, message: 'اسم العميل مفقود' }); return; }
    valid.push({
      name, phone: pick(row, A_CUST.phone), code: pick(row, A_CUST.code) || undefined,
      email: pick(row, A_CUST.email) || undefined, businessName: pick(row, A_CUST.businessName) || undefined,
      commercialReg: pick(row, A_CUST.commercialReg) || undefined, taxNumber: pick(row, A_CUST.taxNumber) || undefined,
      city: pick(row, A_CUST.city) || undefined, district: pick(row, A_CUST.district) || undefined,
      address: pick(row, A_CUST.address) || undefined, channel: channelCode(pick(row, A_CUST.channel)) || undefined,
      creditLimit: numOr(pick(row, A_CUST.creditLimit), undefined), paymentDays: numOr(pick(row, A_CUST.paymentDays), undefined),
    });
  });
  return { valid, errors };
}

// ============ المنتجات ============
const A_PROD = {
  code: ['مرجع داخلي', 'المرجع الداخلي', 'مرجع', 'كود الصنف', 'رقم الصنف', 'code', 'sku', 'internal reference', 'reference', 'ref'],
  name: ['اسم الصنف', 'الصنف', 'اسم المنتج', 'الاسم', 'name', 'product', 'item'],
  unit: ['الوحدة', 'وحدة القياس', 'unit', 'uom'],
  basePrice: ['سعر البيع', 'السعر', 'السعر الأساسي', 'price', 'sales price', 'list price', 'unit price'],
  taxPct: ['الضريبة', 'نسبة الضريبة', 'tax', 'vat'],
  barcode: ['الباركود', 'barcode', 'ean'],
  category: ['فئة المنتج', 'الفئة', 'التصنيف', 'المجموعة', 'category', 'group'],
};
function toProducts(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const name = pick(row, A_PROD.name);
    if (!name) { errors.push({ row: i + 2, message: 'اسم الصنف مفقود' }); return; }
    const code = pick(row, A_PROD.code) || name; // توليد الكود من الاسم عند غيابه (أنظمة كثيرة لا تُصدّر كوداً)
    valid.push({
      code, name, unit: pick(row, A_PROD.unit) || undefined,
      basePrice: numOr(pick(row, A_PROD.basePrice), undefined), taxPct: numOr(pick(row, A_PROD.taxPct), undefined),
      barcode: pick(row, A_PROD.barcode) || undefined, category: pick(row, A_PROD.category) || undefined,
    });
  });
  return { valid, errors };
}

// ============ الأرصدة الافتتاحية ============
const A_BAL = {
  ...CUST_ID,
  balance: ['الرصيد الافتتاحي', 'رصيد افتتاحي', 'الرصيد', 'opening balance', 'balance'],
  date: ['التاريخ', 'date'],
};
function toBalances(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const cn = pick(row, A_BAL.name); const cc = pick(row, A_BAL.code); const ph = pick(row, A_BAL.phone);
    const bal = numOr(pick(row, A_BAL.balance), undefined);
    if (!cn && !cc && !ph) { errors.push({ row: i + 2, message: 'معرّف العميل مفقود (الاسم/الكود/الجوال)' }); return; }
    if (bal === undefined || bal === 0) return; // بلا رصيد — يُتجاهَل بلا خطأ
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, balance: bal, date: pick(row, A_BAL.date) || undefined });
  });
  return { valid, errors };
}

// ============ كشوف الحسابات / دفتر الأستاذ ============
const A_LED = {
  ...CUST_ID,
  date: ['التاريخ', 'date'],
  description: ['البيان', 'الوصف', 'التفاصيل', 'اسم الحساب', 'description', 'details', 'memo', 'label'],
  debit: ['المدين', 'مدين', 'debit', 'dr'],
  credit: ['الدائن', 'دائن', 'credit', 'cr'],
};
function toLedger(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row) => {
    const cn = pick(row, A_LED.name); const cc = pick(row, A_LED.code); const ph = pick(row, A_LED.phone);
    if (!cn && !cc && !ph) return;                       // صف بلا عميل (حسابات عامة) — يُتجاهَل بلا خطأ
    const debit = numOr(pick(row, A_LED.debit), 0) || 0; const credit = numOr(pick(row, A_LED.credit), 0) || 0;
    if (!debit && !credit) return;                        // بلا مبلغ — يُتجاهَل
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, date: pick(row, A_LED.date) || undefined, description: pick(row, A_LED.description) || undefined, debit, credit });
  });
  return { valid, errors };
}

// ============ قوائم الأسعار ============
const A_PRC = {
  ...CUST_ID,
  productCode: ['كود الصنف', 'مرجع داخلي', 'رقم الصنف', 'product code', 'item code', 'sku'],
  price: ['السعر الخاص', 'السعر', 'سعر البيع', 'price', 'special price'],
};
function toPrices(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const errors: { row: number; message: string }[] = [];
  rows.forEach((row, i) => {
    const cn = pick(row, A_PRC.name); const cc = pick(row, A_PRC.code); const ph = pick(row, A_PRC.phone);
    const pc = pick(row, A_PRC.productCode); const price = numOr(pick(row, A_PRC.price), undefined);
    if (!cn && !cc && !ph) { errors.push({ row: i + 2, message: 'معرّف العميل مفقود' }); return; }
    if (!pc) { errors.push({ row: i + 2, message: 'كود الصنف مفقود' }); return; }
    if (price === undefined) { errors.push({ row: i + 2, message: 'السعر مفقود' }); return; }
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, productCode: pc, price });
  });
  return { valid, errors };
}

// ============ سجلّ الأنواع ============
export type ImportKind = 'customers' | 'products' | 'balances' | 'ledger' | 'prices';
export interface ImportTypeDef { id: ImportKind; label: string; endpoint: string; transform: (rows: Record<string, unknown>[]) => TransformOut }
export const IMPORT_TYPES: Record<ImportKind, ImportTypeDef> = {
  customers: { id: 'customers', label: 'العملاء', endpoint: '/import/customers', transform: toCustomers },
  products: { id: 'products', label: 'المنتجات', endpoint: '/import/products', transform: toProducts },
  balances: { id: 'balances', label: 'الأرصدة الافتتاحية', endpoint: '/import/balances', transform: toBalances },
  ledger: { id: 'ledger', label: 'كشوف الحسابات / دفتر الأستاذ', endpoint: '/import/ledger', transform: toLedger },
  prices: { id: 'prices', label: 'قوائم الأسعار', endpoint: '/import/prices', transform: toPrices },
};
