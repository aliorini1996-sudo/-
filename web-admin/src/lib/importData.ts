// استيراد بيانات الشركات السابقة من Excel — بلا قالب: كشف آلي لصف العناوين + مطابقة أعمدة ذكية
// (تطابق تام ثم احتواء) تشمل مرادفات أنظمة مثل أودو، وتطبيع عربي، وتواريخ حقيقية.
import { SALES_CHANNELS } from './channels';

const pad2 = (n: number) => String(n).padStart(2, '0');
const val = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) {
    // خلية تاريخ Excel: SheetJS يبنيها بالتوقيت المحلي (وقد تنزاح ثوانيَ) ⇒ التقريب لأقرب دقيقة ثم المكوّنات المحلية.
    // toISOString (UTC) كانت تُرجع اليوم السابق بتوقيت الرياض فتنقلب حركة يوم البدء إلى ما قبله.
    if (isNaN(v.getTime())) return '';
    const d = new Date(Math.round(v.getTime() / 60_000) * 60_000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return String(v).trim();
};

// ============ التواريخ (العقد مع الخادم: YYYY-MM-DD فقط) ============
const toAsciiDigits = (s: string) => s
  .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
const validYmd = (y: number, m: number, d: number): string | null => {
  if (!(y >= 1900 && y <= 2100) || !(m >= 1 && m <= 12) || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > dim ? null : `${y}-${pad2(m)}-${pad2(d)}`;
};
// أسماء الأشهر (إنجليزية مختصرة/كاملة وعربية ميلادية) لتواريخ نصية مثل 15-Jan-2025 و«15 يناير 2025»
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
  'يناير': 1, 'فبراير': 2, 'مارس': 3, 'ابريل': 4, 'مايو': 5, 'يونيو': 6, 'يوليو': 7,
  'اغسطس': 8, 'سبتمبر': 9, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
};
const monthOf = (name: string): number | undefined => MONTHS[name.toLowerCase().replace(/[أإآ]/g, 'ا')];
/**
 * تطبيع تاريخ من الملف إلى YYYY-MM-DD: يقبل yyyy-mm-dd (وyyyy/mm/dd)، وd/m/yyyy وd-m-yyyy وd.m.yyyy **اليوم أولاً**
 * (لا الصيغة الأمريكية)، وأسماء الأشهر (15-Jan-2025، Jan 15, 2025، «15 يناير 2025»)، مع جزء وقت اختياري يُهمل. الفارغ ⇒ ''، وغير المفهوم أو غير الحقيقي (31/02) ⇒ null.
 */
export function normDate(input: string): string | null {
  const s = toAsciiDigits(String(input ?? '').trim());
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/);
  if (m) return validYmd(+m[3], +m[2], +m[1]);
  // اسم الشهر: اليوم أولاً (15-Jan-2025، «15 يناير 2025») ثم الشهر أولاً (Jan 15, 2025)
  m = s.match(/^(\d{1,2})[-\s/.,]+([A-Za-z؀-ۿ]+)\.?[-\s/.,]+(\d{4})(?:[ T,].*)?$/i);
  if (m) { const mon = monthOf(m[2]); return mon ? validYmd(+m[3], mon, +m[1]) : null; }
  m = s.match(/^([A-Za-z؀-ۿ]+)\.?[-\s/.]+(\d{1,2}),?[-\s/.]+(\d{4})(?:[ T,].*)?$/i);
  if (m) { const mon = monthOf(m[1]); return mon ? validYmd(+m[3], mon, +m[2]) : null; }
  return null;
}
/** إزاحة تاريخ تقويمي YYYY-MM-DD بعدد أيام (صرف، بلا منطقة زمنية) — لاقتراح «اليوم السابق لتاريخ البدء». */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
/** اليوم التقويمي للحظة بتوقيت منطقة (Intl) */
function ymdInZone(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export type ImportCutoverClass = 'before' | 'onOrAfter' | 'undated';
export interface ImportCutoverSplit { classes: ImportCutoverClass[]; before: number; onOrAfter: number; undated: number }
/**
 * تصنيف صفوف الأرصدة/الكشوف حول تاريخ البدء بالتقويم المحلي للشركة (صرف):
 * قبل البدء، أو في يوم البدء وبعده، أو بلا تاريخ. التاريخ نص YYYY-MM-DD يُقارن تقويمياً،
 * واللحظة (Date أو نص ISO بوقت) تُحوَّل إلى يومها في `tz` أولاً — فالحد عند منتصف الليل المحلي.
 */
export function classifyImportRowsByCutover(rows: Record<string, unknown>[], cutover: string, tz: string): ImportCutoverSplit {
  const out: ImportCutoverSplit = { classes: [], before: 0, onOrAfter: 0, undated: 0 };
  for (const r of rows) {
    const raw = r?.date;
    let ymd = '';
    if (raw instanceof Date) ymd = isNaN(raw.getTime()) ? '' : ymdInZone(raw, tz);
    else if (typeof raw === 'string' && raw.trim()) {
      const s = raw.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ymd = s;
      else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); ymd = isNaN(d.getTime()) ? (normDate(s) || '') : ymdInZone(d, tz); }
      else ymd = normDate(s) || '';
    }
    const c: ImportCutoverClass = !ymd ? 'undated' : ymd < cutover ? 'before' : 'onOrAfter';
    out.classes.push(c); out[c]++;
  }
  return out;
}
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
  const buf = await file.arrayBuffer();
  // CSV/نص: SheetJS يحلّل التواريخ النصية بالصيغة الأمريكية (m/d) فينقلب 05/01 إلى 1 مايو بصمت ⇒ raw يُبقيها نصاً
  // لتمرّ على normDate اليوم أولاً (والأرقام تبقى نصاً يعالجه numOr). Excel الحقيقي لا يتغيّر.
  const isText = /\.(csv|txt)$/i.test(file.name);
  // نص UTF-8 بلا BOM يقرؤه SheetJS كبايتات فتتشوّه العناوين العربية ⇒ فك الترميز أولاً، وغير UTF-8 يعود لقراءة البايتات
  let utf8: string | null = null;
  if (isText) { try { utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { utf8 = null; } }
  let wb = utf8 != null ? XLSX.read(utf8, { type: 'string', raw: true })
    : XLSX.read(buf, isText ? { type: 'array', raw: true } : { type: 'array', cellDates: true });
  if (!isText && wb.bookType === 'csv') wb = XLSX.read(buf, { type: 'array', raw: true });
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

// التقاط قيمة حقل: تطابق تام (بعد التطبيع) ثم احتواء العنوان للمرادف.
// exclude: عناوين تحوي أحد هذه المقاطع (مطبّعة) لا تُلتقط — «إجمالي التكلفة» ليس «تكلفة الوحدة»
function pick(row: Record<string, unknown>, aliases: string[], exclude: readonly string[] = []): string {
  const ex = exclude.map(norm);
  const keys = Object.keys(row).map((k) => ({ k, n: norm(k) })).filter((x) => !ex.some((e) => x.n.includes(e)));
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

export interface ImportRowError { row: number; message: string; /** القيمة المرفوضة (تُعرض بعد الرسالة المترجمة) */ value?: string }
export interface TransformOut {
  valid: Record<string, unknown>[];
  /** رقم صف الملف لكل عنصر في valid (بالموضع نفسه): الخادم يرقّم بموضع الصف المرسل (i + 2) لا بصف الملف */
  fileRows: number[];
  errors: ImportRowError[];
  /** تنبيهات غير مانعة (نص عربي يُمرَّر عبر tr) */
  warnings?: string[];
  /** الأرصدة/الكشوف: عدد الصفوف الصالحة التي بلا تاريخ في الملف (مُلئت أم لا) */
  undated?: number;
  /** المخزون الافتتاحي: Σ الكمية × تكلفة الوحدة كما في الملف (قبل خصم الضريبة إن كانت شاملة) */
  totalCost?: number;
}
export interface TransformOpts {
  /** YYYY-MM-DD يُطبَّق على الصفوف بلا تاريخ فقط (يختاره المالك صراحةً) */
  undatedDate?: string | null;
}
/** رقم صف الخادم (موضع الصف المرسل + 2) ⇒ رقم صف الملف؛ خارج النطاق (ومنه 0) يبقى كما هو */
export function fileRowOf(fileRows: readonly number[] | undefined, serverRow: number): number {
  if (!fileRows || !Number.isInteger(serverRow) || serverRow < 2) return serverRow;
  return fileRows[serverRow - 2] ?? serverRow;
}

/** منطقة الشركة للاستيراد، كما importTimezone في الخادم: بعد التفعيل إعدادات الدفاتر؛ قبله مسودة المعالج (effective) ثم الإعدادات ثم الرياض */
export function importContextTimezone(activated: boolean, statusTimezone: string | null | undefined, setupTimezone: string | null | undefined): string {
  return (activated ? statusTimezone : setupTimezone || statusTimezone) || 'Asia/Riyadh';
}

/** رسالة خادم عربية: تُعرض بالعربية أو مترجمةً إن وُجدت ترجمتها، وإلا null (نص عام بديل) */
export function localizedServerMessage(message: string | null | undefined, lang: string, tr: (s: string) => string): string | null {
  if (!message) return null;
  return lang === 'ar' || tr(message) !== message ? tr(message) : null;
}

/** فاصل قائمة الأسماء بحسب اللغة */
export const listSeparator = (lang: string): string => (lang === 'ar' ? '، ' : ', ');

export const DATE_ERROR_MESSAGE = 'تاريخ غير مفهوم';
export const CUSTOMER_BALANCE_WARNING = 'عمود الرصيد لا يُستورد مع العملاء؛ استخدم بطاقة الأرصدة الافتتاحية بالملف نفسه';

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
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const errors: ImportRowError[] = [];
  let balanceIgnored = false;
  rows.forEach((row, i) => {
    // عمود «الرصيد» (مرادفات A_BAL) لا يُستورد مع العملاء — تنبيه غير مانع حين يحمل قيمة غير صفرية
    if (!balanceIgnored) { const b = numOr(pick(row, A_BAL.balance), undefined); if (b !== undefined && b !== 0) balanceIgnored = true; }
    const name = pick(row, A_CUST.name);
    if (!name) { errors.push({ row: i + 2, message: 'اسم العميل مفقود' }); return; }
    fileRows.push(i + 2);
    valid.push({
      name, phone: pick(row, A_CUST.phone), code: pick(row, A_CUST.code) || undefined,
      email: pick(row, A_CUST.email) || undefined, businessName: pick(row, A_CUST.businessName) || undefined,
      commercialReg: pick(row, A_CUST.commercialReg) || undefined, taxNumber: pick(row, A_CUST.taxNumber) || undefined,
      city: pick(row, A_CUST.city) || undefined, district: pick(row, A_CUST.district) || undefined,
      address: pick(row, A_CUST.address) || undefined, channel: channelCode(pick(row, A_CUST.channel)) || undefined,
      creditLimit: numOr(pick(row, A_CUST.creditLimit), undefined), paymentDays: numOr(pick(row, A_CUST.paymentDays), undefined),
    });
  });
  return { valid, fileRows, errors, warnings: balanceIgnored ? [CUSTOMER_BALANCE_WARNING] : [] };
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
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const errors: ImportRowError[] = [];
  rows.forEach((row, i) => {
    const name = pick(row, A_PROD.name);
    if (!name) { errors.push({ row: i + 2, message: 'اسم الصنف مفقود' }); return; }
    const code = pick(row, A_PROD.code) || name; // توليد الكود من الاسم عند غيابه (أنظمة كثيرة لا تُصدّر كوداً)
    fileRows.push(i + 2);
    valid.push({
      code, name, unit: pick(row, A_PROD.unit) || undefined,
      basePrice: numOr(pick(row, A_PROD.basePrice), undefined), taxPct: numOr(pick(row, A_PROD.taxPct), undefined),
      barcode: pick(row, A_PROD.barcode) || undefined, category: pick(row, A_PROD.category) || undefined,
    });
  });
  return { valid, fileRows, errors };
}

// ============ الأرصدة الافتتاحية ============
const A_BAL = {
  ...CUST_ID,
  balance: ['الرصيد الافتتاحي', 'رصيد افتتاحي', 'الرصيد', 'opening balance', 'balance'],
  date: ['التاريخ', 'date'],
};
// تاريخ الصف: '' بلا تاريخ، وnull غير مفهوم (يُسجَّل خطأً ويُستبعد الصف من valid)
function rowDate(raw: string, i: number, errors: ImportRowError[]): string | null {
  const d = normDate(raw);
  if (d === null) errors.push({ row: i + 2, message: DATE_ERROR_MESSAGE, value: raw });
  return d;
}
function toBalances(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const errors: ImportRowError[] = [];
  let undated = 0;
  rows.forEach((row, i) => {
    const cn = pick(row, A_BAL.name); const cc = pick(row, A_BAL.code); const ph = pick(row, A_BAL.phone);
    const bal = numOr(pick(row, A_BAL.balance), undefined);
    if (!cn && !cc && !ph) { errors.push({ row: i + 2, message: 'معرف العميل مفقود الاسم/الكود/الجوال' }); return; }
    if (bal === undefined || bal === 0) return; // بلا رصيد — يُتجاهَل بلا خطأ
    const date = rowDate(pick(row, A_BAL.date), i, errors);
    if (date === null) return;
    if (!date) undated++;
    fileRows.push(i + 2);
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, balance: bal, date: date || opts?.undatedDate || undefined });
  });
  return { valid, fileRows, errors, undated };
}

// ============ كشوف الحسابات / دفتر الأستاذ ============
const A_LED = {
  ...CUST_ID,
  date: ['التاريخ', 'date'],
  description: ['البيان', 'الوصف', 'التفاصيل', 'مرجع الطلب', 'رقم الإيصال', 'رقم الطلب', 'اسم الحساب', 'description', 'details', 'memo', 'reference'],
  debit: ['المدين', 'مدين', 'debit', 'dr'],
  credit: ['الدائن', 'دائن', 'credit', 'cr'],
  amount: ['الإجمالي', 'المبلغ', 'الصافي', 'القيمة', 'total', 'amount', 'net'],
  status: ['الحالة', 'status', 'state'],
};
function toLedger(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const errors: ImportRowError[] = [];
  let undated = 0;
  rows.forEach((row, i) => {
    const cn = pick(row, A_LED.name); const cc = pick(row, A_LED.code); const ph = pick(row, A_LED.phone);
    if (!cn && !cc && !ph) return;                       // صف بلا عميل (حسابات عامة) — يُتجاهَل بلا خطأ
    let debit = numOr(pick(row, A_LED.debit), 0) || 0; let credit = numOr(pick(row, A_LED.credit), 0) || 0;
    if (!debit && !credit) {
      // لا أعمدة مدين/دائن → عامل الملف كمبيعات: الإجمالي = مدين (على الحساب)، والمدفوع = دائن مقابل
      const amt = numOr(pick(row, A_LED.amount), undefined);
      if (amt === undefined) return;                      // بلا مبلغ — يُتجاهَل
      const st = norm(pick(row, A_LED.status));
      if (st && (st.includes('لغ') || st.includes('cancel') || st.includes('void'))) return; // ملغى — يُتجاهَل
      const paid = !!st && (st.includes('مدفوع') || st.includes('paid') || st.includes('سداد'));
      debit = amt; credit = paid ? amt : 0;
    }
    if (!debit && !credit) return;
    const date = rowDate(pick(row, A_LED.date), i, errors);
    if (date === null) return;
    if (!date) undated++;
    fileRows.push(i + 2);
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, date: date || opts?.undatedDate || undefined, description: pick(row, A_LED.description) || undefined, debit, credit });
  });
  return { valid, fileRows, errors, undated };
}

// ============ قوائم الأسعار ============
const A_PRC = {
  ...CUST_ID,
  productCode: ['كود الصنف', 'مرجع داخلي', 'رقم الصنف', 'product code', 'item code', 'sku'],
  price: ['السعر الخاص', 'السعر', 'سعر البيع', 'price', 'special price'],
};
function toPrices(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const errors: ImportRowError[] = [];
  rows.forEach((row, i) => {
    const cn = pick(row, A_PRC.name); const cc = pick(row, A_PRC.code); const ph = pick(row, A_PRC.phone);
    const pc = pick(row, A_PRC.productCode); const price = numOr(pick(row, A_PRC.price), undefined);
    if (!cn && !cc && !ph) { errors.push({ row: i + 2, message: 'معرف العميل مفقود' }); return; }
    if (!pc) { errors.push({ row: i + 2, message: 'كود الصنف مفقود' }); return; }
    if (price === undefined) { errors.push({ row: i + 2, message: 'السعر مفقود' }); return; }
    fileRows.push(i + 2);
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, productCode: pc, price });
  });
  return { valid, fileRows, errors };
}

// ============ المخزون الافتتاحي (opening_stock) ============
// عقد الخادم POST /import/opening-stock: { rows: {productCode?, barcode?, productName?, qty?, unitCost?}[], pricesIncludeTax?, force? }
// المطابقة على الخادم: الكود ثم الباركود ثم الاسم المطبَّع. هنا التقاط الأعمدة ورفض ما يرفضه الخادم مسبقاً.
export const OPENING_STOCK_MAX_UNIT_COST = 1e9;
export const STOCK_ID_MISSING = 'معرف الصنف مفقود الكود/الباركود/الاسم';
/** نصوص الخادم حرفياً (backend/src/services/importLedger.ts resolveOpeningStockRows) */
export const STOCK_QTY_INVALID = 'الكمية يجب أن تكون أكبر من صفر';
export const STOCK_COST_INVALID = 'تكلفة الوحدة يجب أن تكون أكبر من صفر';
export const STOCK_ZERO_QTY_WARNING = 'الصفوف ذات الكمية الصفرية أو الفارغة تُتجاهل';
const A_STOCK = {
  code: ['كود الصنف', 'رقم الصنف', 'كود المنتج', 'مرجع داخلي', 'المرجع الداخلي', 'product code', 'item code', 'internal reference', 'sku', 'code'],
  barcode: ['الباركود', 'باركود', 'barcode', 'ean'],
  name: ['اسم الصنف', 'اسم المنتج', 'الصنف', 'المنتج', 'الاسم', 'product name', 'item name', 'product', 'item', 'name'],
  qty: ['الكمية المتاحة', 'الكمية الفعلية', 'الكمية', 'كمية', 'الرصيد', 'on hand quantity', 'on hand', 'quantity', 'qty', 'stock'],
  unitCost: ['تكلفة الوحدة', 'سعر التكلفة', 'متوسط التكلفة', 'التكلفة', 'unit cost', 'cost price', 'average cost', 'standard price', 'cost'],
};
// «كود الصنف» يحوي «الصنف» و«product code» يحوي «product» ⇒ الاسم يستثني عناوين المعرّفات
const STOCK_NAME_EXCLUDE = ['كود', 'رقم', 'مرجع', 'باركود', 'code', 'ref', 'barcode', 'sku'];
const STOCK_QTY_EXCLUDE = ['محجوز', 'reserved', 'قيمه', 'value', 'تكلف', 'cost', 'سعر', 'price'];
const STOCK_COST_EXCLUDE = ['اجمالي', 'مجموع', 'total', 'قيمه', 'value'];
const round2 = (n: number) => Math.round(n * 100) / 100;
function toOpeningStock(rows: Record<string, unknown>[]): TransformOut {
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const errors: ImportRowError[] = [];
  let zeroQty = false; let total = 0;
  rows.forEach((row, i) => {
    const productCode = pick(row, A_STOCK.code); const barcode = pick(row, A_STOCK.barcode);
    const productName = pick(row, A_STOCK.name, STOCK_NAME_EXCLUDE);
    const qtyRaw = pick(row, A_STOCK.qty, STOCK_QTY_EXCLUDE); const costRaw = pick(row, A_STOCK.unitCost, STOCK_COST_EXCLUDE);
    if (!productCode && !barcode && !productName) { errors.push({ row: i + 2, message: STOCK_ID_MISSING }); return; }
    const qty = numOr(qtyRaw, undefined);
    if (qty === undefined || qty === 0) { zeroQty = true; return; } // صنف بلا رصيد في تقرير المخزون — يُتجاهل بلا خطأ
    if (!(qty > 0) || !Number.isFinite(qty)) { errors.push({ row: i + 2, message: STOCK_QTY_INVALID, value: qtyRaw }); return; }
    const unitCost = numOr(costRaw, undefined);
    if (unitCost === undefined || !(unitCost > 0) || unitCost > OPENING_STOCK_MAX_UNIT_COST) {
      errors.push({ row: i + 2, message: STOCK_COST_INVALID, ...(costRaw ? { value: costRaw } : {}) }); return;
    }
    total += qty * unitCost;
    fileRows.push(i + 2);
    valid.push({
      ...(productCode ? { productCode } : {}), ...(barcode ? { barcode } : {}), ...(productName ? { productName } : {}), qty, unitCost,
    });
  });
  return { valid, fileRows, errors, warnings: zeroQty ? [STOCK_ZERO_QTY_WARNING] : [], totalCost: round2(total) };
}

// ============ سجلّ الأنواع ============
export type ImportKind = 'customers' | 'products' | 'balances' | 'ledger' | 'prices' | 'opening_stock';
export interface ImportTypeDef { id: ImportKind; label: string; endpoint: string; transform: (rows: Record<string, unknown>[], opts?: TransformOpts) => TransformOut }
/** الأنواع التي تكتب حركات على حساب العميل فتصل إلى الدفاتر */
export const LEDGER_IMPORT_KINDS: readonly ImportKind[] = ['balances', 'ledger'];
export const IMPORT_TYPES: Record<ImportKind, ImportTypeDef> = {
  customers: { id: 'customers', label: 'العملاء', endpoint: '/import/customers', transform: toCustomers },
  products: { id: 'products', label: 'المنتجات', endpoint: '/import/products', transform: toProducts },
  balances: { id: 'balances', label: 'الأرصدة الافتتاحية', endpoint: '/import/balances', transform: toBalances },
  ledger: { id: 'ledger', label: 'كشوف الحسابات / دفتر الأستاذ', endpoint: '/import/ledger', transform: toLedger },
  prices: { id: 'prices', label: 'قوائم الأسعار', endpoint: '/import/prices', transform: toPrices },
  opening_stock: { id: 'opening_stock', label: 'المخزون الافتتاحي', endpoint: '/import/opening-stock', transform: toOpeningStock },
};

// ============ تصنيف ردود الخادم الفاشلة (صرف) ============
export interface InvalidDateRow { row: number; date: string }
export type ImportFailure =
  /** لا رد (انقطاع أو مهلة): قد يكون الاستيراد تم على الخادم ⇒ تحقق من سجل الاستيرادات قبل الإعادة */
  | { type: 'network' }
  /** 409 IMPORT_DUPLICATE_BATCH — running: دفعة الملف نفسه ما زالت تُكتب (لا «استيراد رغم التكرار») */
  | { type: 'duplicate'; batchId?: string; createdAt?: string; running: boolean }
  | { type: 'overlap'; overlap: Record<string, unknown>[] }
  /** 409 IMPORT_IN_PROGRESS — استيراد أرصدة/كشوف آخر جارٍ للشركة */
  | { type: 'inProgress'; batchId?: string; kind?: string; createdAt?: string }
  | { type: 'undated' }
  /** 400 IMPORT_INVALID_DATE — بأسطر الملف (row=0 للتاريخ المفرد)، أو تاريخ الصفوف بلا تاريخ نفسه */
  | { type: 'invalidDate'; rows: InvalidDateRow[]; undatedDate?: string }
  /** 409 OPENING_STOCK_LEDGER_ACTIVE (الاستيراد) أو OPENING_STOCK_REVERT_LEDGER_ACTIVE (التراجع) — الدفاتر مفعّلة */
  | { type: 'openingStockActive' }
  /**
   * 409 OPENING_STOCK_AFTER_CUTOVER — تاريخ البدء المحفوظ ≤ اليوم: يُعاد الإرسال بـacknowledgeCutoverChange:true بعد إقرار صريح
   * بأن تاريخ البدء يُعدَّل في يوم لاحق إلى minCutoverDate فصاعداً
   */
  | { type: 'openingStockAfterCutover'; cutoverDate?: string; today?: string; minCutoverDate?: string; timezone?: string }
  /** 409 OPENING_STOCK_FULL_HISTORY — طريقة التاريخ الكامل في مسودة المعالج */
  | { type: 'openingStockFullHistory' }
  /** 409 OPENING_STOCK_LEDGER_BUSY / IMPORT_LEDGER_BUSY / IMPORT_REVERT_LEDGER_BUSY — قفل الدفاتر مشغول (اعتماد التفعيل) */
  | { type: 'ledgerBusy' }
  /** 409 IMPORT_LEDGER_STATE_CHANGED — فُعّلت الدفاتر بين حساب التواريخ والحجز: لا شيء كُتب، تُراجع المعاينة وتُعاد */
  | { type: 'ledgerStateChanged' }
  /** 409 IMPORT_BATCH_RUNNING — الدفعة ما زالت تُكتب */
  | { type: 'batchRunning'; batchId?: string }
  | { type: 'warehouseDisabled' }
  | { type: 'other'; status?: number; message?: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const NETWORK_CODES = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** جسم الخطأ وحالته من خطأ axios (أو ما يشبهه)؛ response غائب ⇒ network ما لم يكن إلغاءً أو خطأً برمجياً */
export function errorResponseOf(e: unknown): { status?: number; body: Json; network: boolean } {
  const err = obj(e);
  const r = err.response as { status?: number; data?: unknown } | undefined;
  if (r) return { status: r.status, body: obj(r.data), network: false };
  const code = str(err.code);
  const network = code !== 'ERR_CANCELED' && (NETWORK_CODES.has(code ?? '') || err.isAxiosError === true || 'request' in err);
  return { body: {}, network };
}

/** حقل تفصيل الخطأ أينما وضعه الخادم: أعلى الجسم (importErrorBody) أو details أو data */
export function errorDetail(b: Json, k: string): unknown {
  return b[k] ?? obj(b.details)[k] ?? obj(b.data)[k];
}

export function classifyImportFailure(e: unknown): ImportFailure {
  const { status, body: b, network } = errorResponseOf(e);
  if (network) return { type: 'network' };
  const d = (k: string) => errorDetail(b, k);
  switch (b.code) {
    case 'IMPORT_DUPLICATE_BATCH':
      return { type: 'duplicate', batchId: str(d('batchId')), createdAt: str(d('createdAt')), running: d('running') === true };
    case 'IMPORT_OVERLAP_CONFIRM': {
      const w = obj(b.warnings ?? d('warnings'));
      return { type: 'overlap', overlap: Array.isArray(w.overlap) ? (w.overlap as Json[]) : [] };
    }
    case 'IMPORT_IN_PROGRESS':
      return { type: 'inProgress', batchId: str(d('batchId')), kind: str(d('kind')), createdAt: str(d('createdAt')) };
    case 'UNDATED_ROWS_LEDGER_ACTIVE':
      return { type: 'undated' };
    case 'IMPORT_INVALID_DATE': {
      const raw = d('rows');
      const rows: InvalidDateRow[] = Array.isArray(raw)
        ? raw.map(obj).filter((r) => typeof r.row === 'number').map((r) => ({ row: r.row as number, date: String(r.date ?? '') }))
        : [];
      const single = str(d('date'));
      if (!rows.length && single) rows.push({ row: 0, date: single });
      return { type: 'invalidDate', rows, undatedDate: str(d('undatedDate')) };
    }
    case 'OPENING_STOCK_LEDGER_ACTIVE':
    case 'OPENING_STOCK_REVERT_LEDGER_ACTIVE':
      return { type: 'openingStockActive' };
    case 'OPENING_STOCK_AFTER_CUTOVER': {
      const today = str(d('today'));
      const min = str(d('minCutoverDate'));
      return {
        type: 'openingStockAfterCutover', cutoverDate: str(d('cutoverDate')), today,
        // خادم لا يرسل minCutoverDate: اليوم التالي ليوم الاستيراد
        minCutoverDate: min && YMD.test(min) ? min : today && YMD.test(today) ? addDaysYmd(today, 1) : undefined,
        timezone: str(d('timezone')),
      };
    }
    case 'OPENING_STOCK_FULL_HISTORY': return { type: 'openingStockFullHistory' };
    case 'OPENING_STOCK_LEDGER_BUSY':
    case 'IMPORT_LEDGER_BUSY':
    case 'IMPORT_REVERT_LEDGER_BUSY':
      return { type: 'ledgerBusy' };
    case 'IMPORT_LEDGER_STATE_CHANGED': return { type: 'ledgerStateChanged' };
    case 'IMPORT_BATCH_RUNNING': return { type: 'batchRunning', batchId: str(d('batchId')) };
    case 'WAREHOUSE_NOT_ENABLED': return { type: 'warehouseDisabled' };
    default: return { type: 'other', status, message: str(b.message) };
  }
}

// ============ إتاحة بطاقة المخزون الافتتاحي (صرف) ============
/** اليوم التقويمي YYYY-MM-DD بتوقيت منطقة (منطقة غير صالحة ⇒ الرياض) */
export function todayInZone(now: Date, tz: string): string {
  try { return ymdInZone(now, tz); } catch { return ymdInZone(now, 'Asia/Riyadh'); }
}
/** نصوص البطاقة (مفاتيح tr) — الشرط الفعلي في الخادم: الحركة تدخل القيد الافتتاحي فقط حين يسبق يومُ استيرادها تاريخَ البدء */
export const OPENING_STOCK_ACTIVE_NOTE = 'الدفاتر مفعّلة: المخزون الافتتاحي يدخل القيد الافتتاحي وحده — سجّل الكميات من شاشة المستودع كوارد عادي';
export const OPENING_STOCK_FULL_HISTORY_NOTE = 'طريقة ترحيل التاريخ الكامل مختارة في معالج الدفاتر، والمخزون الافتتاحي المستورد لا يدخل الدفاتر فيها. اختر طريقة الأرصدة الافتتاحية في الخطوة 2 ثم استورد المخزون';
export const OPENING_STOCK_AFTER_CUTOVER_NOTE = 'تاريخ البدء المحفوظ في المعالج اليوم أو قبله، فالمخزون المستورد الآن لا يدخل القيد الافتتاحي به. يدخله فقط إذا عدّلت تاريخ البدء في يوم لاحق إلى تاريخ لا يسبق أقرب تاريخ بدء يشمله، ثم اعتمدت الدفاتر';
export const OPENING_STOCK_OPEN_NOTE = 'تُسجَّل الكميات حركة وارد واحدة بتكلفة صافية من الضريبة، ولا تدخل قيمتها القيد الافتتاحي إلا إذا كان تاريخ البدء بعد يوم الاستيراد، أي باعتماد الدفاتر في يوم لاحق. التراجع متاح قبل التفعيل فقط';

export type OpeningStockBlock = 'active' | 'fullHistory';
/** آخر رفض من الخادم: بعد التفعيل، أو التاريخ الكامل، أو تاريخ بدء ≤ اليوم (يُقبل بإقرار) */
export type OpeningStockServerBlock =
  | { reason: OpeningStockBlock; cutoverDate?: string | null }
  | { reason: 'afterCutover'; cutoverDate?: string | null; minCutoverDate?: string | null };
export type OpeningStockGate =
  | { state: 'hidden' }
  | { state: 'blocked'; reason: OpeningStockBlock; cutoverDate: string | null }
  /** تاريخ البدء المحفوظ ≤ اليوم: الاستيراد متاح بإقرار صريح (acknowledgeCutoverChange) بأن تاريخ البدء يصير ≥ minCutoverDate في يوم لاحق */
  | { state: 'ack'; cutoverDate: string | null; minCutoverDate: string }
  | { state: 'open' };
/**
 * انعكاس assertOpeningStockAllowed قبل الرفع: سياق الدفاتر (null بلا صلاحية ⇒ الخادم يحسم) ثم آخر رفض من الخادم.
 * - بعد التفعيل ⇒ محجوبة. التاريخ الكامل في المسودة ⇒ محجوبة (الخادم 409 OPENING_STOCK_FULL_HISTORY).
 * - تاريخ بدء ≤ اليوم بتوقيت الشركة ⇒ إقرار: أقرب تاريخ بدء يشمل حركة اليوم هو الغد (minCutoverDate).
 */
export function openingStockGate(i: {
  warehouseEnabled: boolean;
  ctx: { activated: boolean; cutoverDate: string | null; timezone: string; method: string | null } | null;
  serverBlock: OpeningStockServerBlock | null;
  now: Date;
}): OpeningStockGate {
  if (!i.warehouseEnabled) return { state: 'hidden' };
  const c = i.ctx;
  const sb = i.serverBlock;
  if (c?.activated || sb?.reason === 'active') return { state: 'blocked', reason: 'active', cutoverDate: c?.cutoverDate ?? null };
  if (sb?.reason === 'fullHistory' || (c && c.method === 'FULL_HISTORY')) {
    return { state: 'blocked', reason: 'fullHistory', cutoverDate: c?.cutoverDate ?? null };
  }
  const today = todayInZone(i.now, c?.timezone || 'Asia/Riyadh');
  if (sb?.reason === 'afterCutover') {
    const min = sb.minCutoverDate && YMD.test(sb.minCutoverDate) ? sb.minCutoverDate : addDaysYmd(today, 1);
    return { state: 'ack', cutoverDate: sb.cutoverDate ?? c?.cutoverDate ?? null, minCutoverDate: min };
  }
  if (c && c.cutoverDate && YMD.test(c.cutoverDate) && c.cutoverDate <= today) {
    return { state: 'ack', cutoverDate: c.cutoverDate, minCutoverDate: addDaysYmd(today, 1) };
  }
  return { state: 'open' };
}

/** نص البطاقة (مفتاح tr) لحالة البوابة */
export function openingStockNoteKey(gate: OpeningStockGate): string | null {
  switch (gate.state) {
    case 'hidden': return null;
    case 'open': return OPENING_STOCK_OPEN_NOTE;
    case 'ack': return OPENING_STOCK_AFTER_CUTOVER_NOTE;
    default: return gate.reason === 'active' ? OPENING_STOCK_ACTIVE_NOTE : OPENING_STOCK_FULL_HISTORY_NOTE;
  }
}

/** حقول الطلب الإضافية: الإقرار يُرسل فقط حين تطلبه البوابة ويُقَرّ صراحةً؛ والزر ينتظر الإقرار */
export function openingStockAckState(gate: OpeningStockGate, acknowledged: boolean): { required: boolean; blocksImport: boolean; body: { acknowledgeCutoverChange?: true } } {
  const required = gate.state === 'ack';
  return { required, blocksImport: required && !acknowledged, body: required && acknowledged ? { acknowledgeCutoverChange: true } : {} };
}
