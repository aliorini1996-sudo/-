// استيراد بيانات الشركات السابقة من Excel — بلا قالب: كشف آلي لصف العناوين + مطابقة أعمدة على مستوى الملف
// (تطابق تام ثم احتواء باستثناءات) تشمل مرادفات أنظمة مثل أودو، وتطبيع عربي، وتواريخ حقيقية، ومحلّل مبالغ صريح.
import { SALES_CHANNELS } from './channels';
import { parseAmount, parsePercent, hasPercentSign, toAsciiDigits, columnDecimalStyle, currencyDecimalFallback, type DecimalStyle } from './importAmount';
import { classifyPaymentStatus, type PaymentStatusClass } from './importStatus';

export { toAsciiDigits } from './importAmount';

const pad2 = (n: number) => String(n).padStart(2, '0');
const val = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) {
    // خلية تاريخ Excel: SheetJS يبنيها بالتوقيت المحلي وتنزاح ملّي ثانية (23:59:59 ⇒ 23:59:58.999) ⇒ تصحيح تلك الملّي ثانية
    // وحدها ثم **الأرضية** للثانية ثم المكوّنات المحلية. أي تقريب لأعلى (دقيقة أو ثانية) ينقل 23:59:59.5 فما بعد إلى اليوم التالي.
    if (isNaN(v.getTime())) return '';
    const d = new Date(Math.floor((v.getTime() + 1) / 1000) * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return String(v).trim();
};

// ============ التواريخ (العقد مع الخادم: YYYY-MM-DD فقط) ============
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

// ============ قراءة الملف ============
/** تنبيه غير مانع في المعاينة: key مفتاح tr، وcount/values تُعرض بعده */
export interface ImportNotice { key: string; count?: number; values?: string[] }
export interface ParsedImportFile {
  rows: Record<string, unknown>[];
  headers: string[];
  notices: ImportNotice[];
  /** binary لملفات xlsx/xls الحقيقية؛ النص بترميزه المكتشف */
  encoding: 'utf-8' | 'windows-1256' | 'utf-16' | 'binary';
  format: 'xlsx' | 'xls' | 'text' | 'html';
}
export const IMPORT_ENCODING_ERROR = 'تعذر قراءة ترميز الملف: احفظه من Excel بصيغة CSV UTF-8 أو xlsx';
export const IMPORT_WIN1256_NOTICE = 'قُرئ الملف بترميز Windows-1256 (Excel العربي)';
export const IMPORT_DUP_HEADERS_NOTICE = 'أعمدة مكررة الاسم أُعيدت تسميتها';
/** ملف لا يُقرأ: key مفتاح tr */
export class ImportFileError extends Error {
  key: string;
  constructor(key: string) { super(key); this.name = 'ImportFileError'; this.key = key; }
}

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

/**
 * عناوين الأعمدة بلا تكرار: العنوان المكرر (كلا موضعيه) يُدمج مع أقرب خلية غير فارغة يساره في الصف الأعلى
 * (ملء أمامي للخلايا المدمجة: «الحركة | الرصيد» فوق «مدين | دائن» ⇒ «الحركة مدين»). ما بقي مكرراً يُلحق به « (2)» بتنبيه.
 */
function uniqueHeaders(matrix: unknown[][], h: number, notices: ImportNotice[]): string[] {
  const heads = (matrix[h] || []).map((x) => val(x));
  const count = new Map<string, number>();
  for (const hd of heads) if (hd) count.set(hd, (count.get(hd) ?? 0) + 1);
  const upper = h > 0 ? (matrix[h - 1] || []) : [];
  const merged = heads.map((hd, j) => {
    if (!hd || (count.get(hd) ?? 0) < 2) return hd;
    for (let k = Math.min(j, upper.length - 1); k >= 0; k--) { const p = val(upper[k]); if (p) return `${p} ${hd}`; }
    return hd;
  });
  const seen = new Map<string, number>();
  let renamed = 0;
  const out = merged.map((hd) => {
    if (!hd) return hd;
    const n = (seen.get(hd) ?? 0) + 1;
    seen.set(hd, n);
    if (n === 1) return hd;
    renamed++;
    return `${hd} (${n})`;
  });
  if (renamed) notices.push({ key: IMPORT_DUP_HEADERS_NOTICE, count: renamed });
  return out;
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const READABLE = /[A-Za-z؀-ۿ]/;
const LATIN1 = /[À-ÿ]/;
const LATIN1_G = /[À-ÿ]/g;
const LETTERS_G = /[A-Za-zÀ-ÿ]/g;
// تشويه UTF-8 المقروء Latin-1/Windows-1252: بايت البداية (Ã للاتيني المشكّل، Ø Ù Ú Û للعربي) يتبعه بايت استمرار 0x80-0xBF،
// وهو في Latin-1 رمز تحكّم أو علامة (¡-¿) وفي 1252 علامة ترقيم (‚ „ … ‘ ’ “ ” – — ‹ › …) أو Œ Š Ž œ š ž Ÿ ƒ ˆ ˜ ™ €.
// حرف عادي بعدها (DESCRIÇÃO، Øre) ليس تشويهاً.
const MOJIBAKE = /[ÃØÙÚÛ][-¿ŒœŠšŸŽžƒˆ˜–-›€™]|�/;
/** رأس مشوّه بعد فك UTF-8 ناجح: أنماط UTF-8 المقروء Latin-1 أو U+FFFD، أو أغلب حروفه من Latin-1 (1256 المقروء Latin-1) */
const isMojibakeHeader = (h: string): boolean => {
  if (MOJIBAKE.test(h)) return true;
  const letters = (h.match(LETTERS_G) || []).length;
  return letters > 0 && (h.match(LATIN1_G) || []).length / letters > 0.5;
};

/**
 * قراءة أول ورقة من البايتات ⇒ صفوف ككائنات. النوع من البايتات لا من الامتداد:
 * - ZIP (xlsx) وOLE (xls ثنائي) ⇒ SheetJS بتواريخ حقيقية.
 * - غير ذلك نص: UTF-8 (بلا BOM) ثم Windows-1256 بتنبيه؛ HTML أو CSV/TSV بـraw:true فتبقى التواريخ نصاً
 *   تمر على normDate اليوم أولاً (SheetJS يقرؤها أمريكية فينقلب 05/01 إلى 1 مايو).
 * - رؤوس نصية غير مقروءة ⇒ ImportFileError برسالة ترميز صريحة.
 */
export async function parseImportBuffer(buf: ArrayBuffer, fileName = ''): Promise<ParsedImportFile> {
  void fileName; // الامتداد لا يحسم النوع (ملفات .xls كثيرة هي CSV/TSV/HTML)
  const XLSX = await import('xlsx');
  const bytes = new Uint8Array(buf);
  const notices: ImportNotice[] = [];
  let wb: import('xlsx').WorkBook;
  let encoding: ParsedImportFile['encoding'] = 'binary';
  let format: ParsedImportFile['format'];
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    format = 'xlsx';
    wb = XLSX.read(buf, { type: 'array', cellDates: true });
  } else if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    format = 'xls';
    wb = XLSX.read(buf, { type: 'array', cellDates: true });
  } else {
    let text: string;
    if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
      // «نص Unicode» من Excel: UTF-16 بـBOM
      text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(buf);
      encoding = 'utf-16';
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        encoding = 'utf-8';
      } catch {
        text = new TextDecoder('windows-1256').decode(buf);
        encoding = 'windows-1256';
        notices.push({ key: IMPORT_WIN1256_NOTICE });
      }
    }
    text = text.replace(/^\uFEFF/, '');
    if (/^\s*</.test(text) || /<table/i.test(text)) {
      format = 'html';
      wb = XLSX.read(text, { type: 'string', raw: true });
    } else {
      format = 'text';
      wb = XLSX.read(text, { type: 'string', raw: true });
    }
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], headers: [], notices, encoding, format };
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
  const h = detectHeaderRow(matrix);
  if (format === 'text' || format === 'html') {
    const raw = (matrix[h] || []).map((x) => val(x)).filter(Boolean);
    // UTF-8 فُكّ بلا خطأ ⇒ الحروف اللاتينية المشكّلة (Société، Crédit) مشروعة؛ يُرفض التشويه الحقيقي فقط
    const garbled = encoding === 'utf-8' ? raw.filter(isMojibakeHeader).length : raw.filter((x) => LATIN1.test(x)).length;
    if (raw.length && (!raw.some((x) => READABLE.test(x)) || garbled > raw.length / 2)) throw new ImportFileError(IMPORT_ENCODING_ERROR);
  }
  const heads = uniqueHeaders(matrix, h, notices);
  const rows: Record<string, unknown>[] = [];
  for (let r = h + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || row.every((c) => val(c) === '')) continue;
    const o: Record<string, unknown> = {};
    heads.forEach((hd, j) => { if (hd) o[hd] = row[j] ?? ''; });
    rows.push(o);
  }
  return { rows, headers: heads.filter(Boolean), notices, encoding, format };
}

export async function parseImportFile(file: File): Promise<ParsedImportFile> {
  return parseImportBuffer(await file.arrayBuffer(), file.name);
}

/** قراءة أول ورقة → صفوف ككائنات (للاستعمالات القائمة التي لا تحتاج التنبيهات) */
export async function parseExcelFile(file: File): Promise<Record<string, unknown>[]> {
  return (await parseImportFile(file)).rows;
}

// ============ مطابقة الأعمدة على مستوى الملف ============
export interface ImportFieldSpec {
  aliases: readonly string[];
  /** مقاطع (تُطبَّع) تستبعد العنوان في مطابقة **الاحتواء** فقط — «إجمالي التكلفة» ليس «تكلفة الوحدة» */
  exclude?: readonly string[];
  /** حقل رقمي: تعدد الأعمدة المطابقة (تماماً أو احتواءً) أو تكرار رأسه بلا تمييز مانع للاستيراد */
  numeric?: boolean;
  /** مطابقة تامة فقط (مرادفات قصيرة مثل dr/cr) */
  exactOnly?: boolean;
  /** مرادفات مفضّلة: عمود واحد يطابق أحدها تماماً يُختار وحده بلا التباس («الإجمالي شامل الضريبة» على «الإجمالي») */
  preferred?: readonly string[];
}
export type ImportSpec = Record<string, ImportFieldSpec>;
export interface ResolvedColumns {
  /** مرشحو كل حقل بالترتيب: قيمة الصف = أول مرشح غير فارغ */
  candidates: Record<string, string[]>;
  exact: Record<string, boolean>;
  columns: { field: string; header: string | null }[];
  blockers: string[];
  notices: ImportNotice[];
}
export const AMBIGUOUS_COLUMN_BLOCKER = 'أكثر من عمود يطابق الحقل نفسه، أعد تسمية العمود المقصود';

/** رؤوس الملف = اتحاد مفاتيح أول 50 صفاً بترتيب الظهور */
export function headersOf(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r || {})) seen.add(k);
  return [...seen];
}

/**
 * لكل حقل: الأعمدة المطابقة تماماً بعد التطبيع (بترتيب المرادفات) هي المرشحون وحدهم — ولو كانت خاناتها فارغة؛
 * وإلا أعمدة الاحتواء (مرادف ≥ 3 أحرف) بعد الاستثناء.
 */
export function resolveColumns(headers: readonly string[], spec: ImportSpec): ResolvedColumns {
  const hs = headers.map((k) => ({ k, n: norm(k) }));
  const hset = new Set(headers);
  const out: ResolvedColumns = { candidates: {}, exact: {}, columns: [], blockers: [], notices: [] };
  const block = (values: string[]) => {
    if (!out.blockers.includes(AMBIGUOUS_COLUMN_BLOCKER)) out.blockers.push(AMBIGUOUS_COLUMN_BLOCKER);
    out.notices.push({ key: AMBIGUOUS_COLUMN_BLOCKER, values });
  };
  for (const [field, fs] of Object.entries(spec)) {
    let exact: string[] = [];
    for (const a of fs.aliases) { const na = norm(a); for (const x of hs) if (x.n === na && !exact.includes(x.k)) exact.push(x.k); }
    if (exact.length > 1 && fs.preferred?.length) {
      const pref = new Set(fs.preferred.map(norm));
      const hits = exact.filter((k) => pref.has(norm(k)));
      if (hits.length === 1) exact = hits;
    }
    let cands = exact;
    // حقل رقمي بأكثر من عمود مطابق تماماً («الرصيد الحالي» و«الرصيد الافتتاحي»): الخلية الفارغة كانت تسقط إلى العمود التالي
    if (fs.numeric && exact.length > 1) block(exact);
    if (!exact.length && !fs.exactOnly) {
      const ex = (fs.exclude ?? []).map(norm);
      const contains: string[] = [];
      for (const a of fs.aliases) {
        const na = norm(a);
        if (na.length < 3) continue;
        for (const x of hs) if (x.n.includes(na) && !ex.some((e) => x.n.includes(e)) && !contains.includes(x.k)) contains.push(x.k);
      }
      cands = contains;
      if (fs.numeric && contains.length > 1) block(contains);
    }
    // رأس رقمي مكرر بلا تمييز: uniqueHeaders سمّى الثاني «X (2)» والأصل X موجود ⇒ لا يُعرف أيهما المقصود
    // (يُفحص على الرأس قبل التطبيع لأن norm يحذف الأقواس؛ ورأس حقيقي «مدين (2)» بلا «مدين» لا يُمنع)
    if (fs.numeric && cands.length) {
      const dup = headers.filter((h) => {
        const m = h.match(/^(.*) \((\d+)\)$/);
        return !!m && hset.has(m[1]) && (cands.includes(h) || cands.includes(m[1]));
      });
      if (dup.length) {
        const base = dup.map((h) => h.replace(/ \(\d+\)$/, ''));
        const values = [...new Set([...base, ...dup])];
        if (!out.notices.some((n) => n.key === AMBIGUOUS_COLUMN_BLOCKER && n.values?.join('|') === values.join('|'))) block(values);
      }
    }
    out.candidates[field] = cands;
    out.exact[field] = exact.length > 0;
    out.columns.push({ field, header: cands[0] ?? null });
  }
  return out;
}

/** القيمة الخام لأول مرشح غير فارغ ('' إن لم يوجد) */
function rawOf(row: Record<string, unknown>, cands: readonly string[] | undefined): unknown {
  for (const k of cands ?? []) { const v = row[k]; if (val(v) !== '') return v; }
  return '';
}

const channelCode = (v: string): string => {
  if (!v) return '';
  const n = norm(v);
  const hit = SALES_CHANNELS.find((c) => norm(c.ar) === n || norm(c.en) === n || c.code.toLowerCase() === n);
  return hit ? hit.code : '';
};

export interface ImportRowError {
  row: number; message: string;
  /** القيمة المرفوضة (تُعرض بعد الرسالة المترجمة) */
  value?: string;
  /** رمز الخادم (CUSTOMER_NOT_FOUND…) */
  code?: string;
  /** الحقل الذي رُفضت قيمته (مثل balance) */
  field?: string;
}
export interface TransformOut {
  valid: Record<string, unknown>[];
  /** رقم صف الملف لكل عنصر في valid (بالموضع نفسه): الخادم يرقّم بموضع الصف المرسل (i + 2) لا بصف الملف */
  fileRows: number[];
  errors: ImportRowError[];
  /** تنبيهات غير مانعة (نص عربي يُمرَّر عبر tr) — للتوافق */
  warnings?: string[];
  /** تنبيهات غير مانعة بعدد/قيم */
  notices?: ImportNotice[];
  /** خريطة «حقل ⇐ عمود الملف» */
  columns?: { field: string; header: string | null }[];
  /** مفاتيح tr — غير الفارغة تمنع زر الاستيراد */
  blockers?: string[];
  /** الأسعار: صفوف السعر الخاص الصفري (تحتاج إقراراً صريحاً) */
  zeroPriceRows?: number;
  /** الأرصدة/الكشوف: عدد الصفوف الصالحة التي بلا تاريخ في الملف (مُلئت أم لا) */
  undated?: number;
  /** المخزون الافتتاحي: Σ الكمية × تكلفة الوحدة كما في الملف (قبل خصم الضريبة إن كانت شاملة) */
  totalCost?: number;
}
export interface TransformOpts {
  /** YYYY-MM-DD يُطبَّق على الصفوف بلا تاريخ فقط (يختاره المالك صراحةً) */
  undatedDate?: string | null;
  /** منازل عملة الشركة: 3 (KWD/BHD/OMR/JOD) تحسم «12.500» عشرياً في عمود بلا دليل آخر */
  currencyDecimals?: number | null;
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
// مفاتيح الأخطاء والتنبيهات الجديدة (نصوص tr)
export const NUMERIC_ERROR = 'قيمة رقمية غير مفهومة';
export const NEGATIVE_CREDIT_LIMIT = 'حد الائتمان لا يكون سالباً';
export const PAYMENT_DAYS_INVALID = 'فترة السداد عدد صحيح من الأيام لا يقل عن صفر';
export const NEGATIVE_PRICE = 'السعر لا يكون سالباً';
export const TAX_PCT_INVALID = 'نسبة الضريبة بين 0 و100';
export const TAX_FRACTION_NOTICE = 'نسب ضريبة مكتوبة كسراً (0.15) حُوّلت إلى نسبة مئوية (15)';
export const ZERO_BALANCE_NOTICE = 'صفوف رصيدها صفر تُجوهلت';
export const DUPLICATE_CUSTOMERS_NOTICE = 'عملاء مكررون في الملف: تُجمع أسطر كل عميل في رصيد واحد بتاريخ أحدث سطر';
export const TOTALS_ROWS_NOTICE = 'صفوف مجاميع استُبعدت (الإجمالي/Total)';
/** لم يعد مانعاً (الدفعة 2): الرصيد المملوء يُستورد والفارغ يُحسب مدين − دائن؛ يبقى مفتاحاً مترجماً للتوافق */
export const BALANCE_DC_CONFLICT_BLOCKER = 'الملف يحوي عمود رصيد وعمودي مدين/دائن معاً، احذف أحدهما أو أعد تسميته';
export const BALANCE_FROM_DC_NOTICE = 'صفوف خانة رصيدها فارغة حُسب رصيدها من المدين ناقص الدائن';
export const PARTIAL_NO_PAID_COLUMN = 'دفع جزئي بلا عمود «المدفوع» أو «المتبقي»';
export const PAID_OUT_OF_RANGE = 'المدفوع أو المتبقي خارج حدود مبلغ الفاتورة';
export const CANCELLED_ROWS_NOTICE = 'فواتير ملغاة استُبعدت';
export const DRAFT_ROWS_NOTICE = 'مسودات استُبعدت';
export const UNKNOWN_STATUS_NOTICE = 'حالات دفع غير معروفة عوملت غير مدفوعة';
export const NO_CUSTOMER_ROWS_NOTICE = 'صفوف بلا عميل تُجوهلت (حسابات عامة)';
export const AMBIGUOUS_AMOUNT_ERROR = 'فاصل ملتبس في المبلغ (1.500 ألف وخمسمئة أم واحد ونصف؟)، اكتبه بلا فاصل آلاف';
export const BALANCE_SIDE_INVALID = 'نوع الرصيد غير مفهوم (مدين أو دائن)';
export const BALANCE_SIDE_UNRESOLVED_BLOCKER = 'عمود نوع الرصيد (مدين/دائن) لم يُتعرّف عليه، سمّه «نوع الرصيد» أو «Dr/Cr»';
export const BALANCE_DC_IGNORED_NOTICE = 'عمودا المدين والدائن تُجوهلا، والمستورد هو عمود الرصيد';
export const BALANCE_DC_MISMATCH_NOTICE = 'عملاء رصيدهم لا يساوي المدين ناقص الدائن في الملف، راجعهم قبل الاستيراد';
export const LEDGER_NO_AMOUNT_COLUMN_BLOCKER = 'لا يوجد عمود مدين/دائن أو مبلغ في الملف';
export const CUSTOMER_OPTIONAL_IGNORED_NOTICE = 'قيم حد ائتمان أو فترة سداد غير رقمية تُركت للقيمة الافتراضية';

// صف مجاميع التقرير: اسم يبدأ بكلمة «إجمالي/مجموع/Total» (مع «ال» أو بعدها كلمات مثل «الأرصدة»، ولو خُتم بنقطتين) بلا كود ولا جوال.
// المطابقة بالكلمة الأولى كاملةً: «مجموعة النور» ليست «مجموع».
const TOTALS_FIRST_WORDS = new Set(['اجمالي', 'الاجمالي', 'اجماليات', 'مجموع', 'المجموع', 'المجاميع', 'مجاميع',
  'total', 'totals', 'subtotal', 'grandtotal', 'soustotal', 'toplam', '合计', '总计', '小计']);
const TOTALS_TWO_WORDS = new Set(['grandtotal', 'subtotal', 'grandtotals', 'subtotals', 'soustotal', 'soustotaux']);
// كلمة وصف قبل كلمة المجموع: «Net Total» و«صافي الإجمالي» و«Genel Toplam» و«Ara Toplam»
const TOTALS_MODIFIERS = new Set(['net', 'report', 'balance', 'balances', 'overall', 'final', 'grand', 'sub', 'genel', 'ara', 'صافي', 'مجمل']);
// كلمات لا تُعدّ مجاميع إلا اسماً كاملاً وحدها: «جملة» اسم نشاط شائع («جملة الخير»)، و«Sum» بادئة أسماء
const TOTALS_ALONE = new Set(['جمله', 'الجمله', 'sum', 'somme']);
// الأطراف: مسافات وترقيم وأقواس وعلامات تنصيص («(الإجمالي)»، «"Total"»، «[Total]»، ««الإجمالي»»)
const EDGE_PUNCT = /^[\s:،,.؛;\-*=_()[\]{}«»"'“”‘’<>#|]+|[\s:،,.؛;\-*=_()[\]{}«»"'“”‘’<>#|]+$/g;
const totalsWords = (name: string): string[] => String(name).toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(EDGE_PUNCT, '')
  // «إجمالي/Total» و«Total | الإجمالي»: الفاصل بين لغتين كلمة مستقلة
  .split(/[\s/\\|]+/).map((w) => w.replace(/[:،,.؛;\-*=_()[\]{}«»"'“”‘’<>#]/g, '')).filter(Boolean);
export function isTotalsName(name: string): boolean {
  const w = totalsWords(name);
  if (!w.length) return false;
  if (w.length === 1 && TOTALS_ALONE.has(w[0])) return true;
  if (TOTALS_FIRST_WORDS.has(w[0]) || (w.length > 1 && TOTALS_TWO_WORDS.has(w[0] + w[1]))) return true;
  return w.length > 1 && TOTALS_MODIFIERS.has(w[0]) && (TOTALS_FIRST_WORDS.has(w[1]) || (w.length > 2 && TOTALS_TWO_WORDS.has(w[1] + w[2])));
}
/** خانة معرّف تافهة في صف مجاميع: شرطة أو ترقيم بلا حرف ولا رقم («—»، «-»، «N/A» لا) أو أصفار فقط («0») */
const blankId = (v: string): boolean => {
  const t = toAsciiDigits(v).trim();
  return !/[\p{L}\p{N}]/u.test(t) || /^[0\s.\-]+$/.test(t);
};
/** جوال تافه كما في normImportPhone بالخادم: أقل من 8 أرقام أو الرقم نفسه مكرراً */
const blankPhone = (v: string): boolean => {
  const d = toAsciiDigits(v).replace(/\D/g, '');
  return d.length < 8 || /^(\d)\1*$/.test(d);
};
/**
 * صف مجاميع: اسم مجاميع (أو الكود حين الاسم فارغ) بلا معرّف حقيقي آخر. الخانات المملوءة بشرطة أو صفر («—»، «0»)
 * تُعدّ فارغة، فلا يُستورد «الإجمالي» عميلاً جواله «—» برصيد كل العملاء.
 */
const isTotalsRow = (name: string, code: string, phone: string): boolean => {
  const phoneBlank = !phone || blankPhone(phone);
  if (name && isTotalsName(name)) return (!code || blankId(code)) && phoneBlank;
  if ((!name || blankId(name)) && code && isTotalsName(code)) return phoneBlank;
  return false;
};

/** أداة تحويل مشتركة: أعمدة الملف المحلولة، وقراءة الحقول، وأخطاء الأرقام، وعدّادات التنبيهات */
function makeCtx(rows: Record<string, unknown>[], spec: ImportSpec, opts?: TransformOpts) {
  const res = resolveColumns(headersOf(rows), spec);
  const errors: ImportRowError[] = [];
  const counts = new Map<string, number>();
  const totals: string[] = [];
  // نمط الفاصل العشري لكل حقل رقمي من خلايا عموده كلها («1.500» مع «1.500.000» ⇒ 1500)، وبلا دليل نمط عملة الشركة
  const fallback = currencyDecimalFallback(opts?.currencyDecimals);
  const styles = new Map<string, DecimalStyle>();
  const styleOf = (f: string): DecimalStyle => {
    if (!styles.has(f)) styles.set(f, columnDecimalStyle(rows.map((r) => rawOf(r, res.candidates[f])), fallback));
    return styles.get(f);
  };
  return {
    res, errors, styleOf,
    raw: (row: Record<string, unknown>, f: string) => rawOf(row, res.candidates[f]),
    s: (row: Record<string, unknown>, f: string) => val(rawOf(row, res.candidates[f])),
    has: (f: string) => (res.candidates[f]?.length ?? 0) > 0,
    bump: (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1),
    /** صف مجاميع مستبعد: يُعدّ ويُعرض اسمه */
    totalsRow(name: string) { counts.set(TOTALS_ROWS_NOTICE, (counts.get(TOTALS_ROWS_NOTICE) ?? 0) + 1); if (totals.length < 10) totals.push(name); },
    /** رقم الحقل: undefined فارغ، null غير مفهوم (خطأ صف مسجَّل) */
    num(row: Record<string, unknown>, i: number, f: string, percent = false): number | undefined | null {
      const r = rawOf(row, res.candidates[f]);
      const st = styleOf(f);
      const p = percent ? parsePercent(r, st) : parseAmount(r === '' ? undefined : r, st);
      if (p.ok) return p.value;
      errors.push({ row: i + 2, message: p.reason === 'ambiguous' ? AMBIGUOUS_AMOUNT_ERROR : NUMERIC_ERROR, value: p.raw, field: f });
      return null;
    },
    notices(extra: ImportNotice[] = []): ImportNotice[] {
      return [...res.notices, ...[...counts].map(([key, count]) => (key === TOTALS_ROWS_NOTICE ? { key, count, values: totals } : { key, count })), ...extra];
    },
  };
}

// أسماء أعمدة مقبولة (تشمل مرادفات أودو والعربية والإنجليزية)
const NAME_EXCLUDE = ['كود', 'رقم', 'رصيد', 'نوع', 'مجموعه', 'مندوب', 'بائع', 'sales', 'rep', 'code', 'number', 'balance', 'type', 'group',
  // أعمدة معرّفات أخرى للعميل نفسه (Customer Phone/Email) لا تُلتقط اسماً
  'جوال', 'هاتف', 'بريد', 'phone', 'mobile', 'email'];
const PHONE_EXCLUDE = ['مندوب', 'بائع', 'sales', 'rep', 'فاكس', 'fax'];
const CODE_EXCLUDE = ['باركود', 'barcode'];
const CUST_ID: ImportSpec = {
  name: {
    aliases: ['اسم العرض', 'الاسم', 'اسم العميل', 'العميل', 'اسم الزبون', 'الزبون', 'اسم المحل', 'المحل', 'اسم المتجر', 'المتجر',
      'اسم الشريك', 'الشريك', 'partner', 'display name', 'customer name', 'name', 'customer', 'client'],
    exclude: NAME_EXCLUDE,
  },
  code: { aliases: ['كود العميل', 'رقم العميل', 'customer code', 'account no', 'account number'], exclude: CODE_EXCLUDE },
  phone: { aliases: ['رقم الهاتف', 'الجوال', 'رقم الجوال', 'الهاتف', 'هاتف', 'التلفون', 'phone', 'mobile', 'tel', 'telephone'], exclude: PHONE_EXCLUDE },
};

// ============ العملاء ============
const BALANCE_ALIASES = ['الرصيد الحالي', 'الرصيد الختامي', 'closing balance', 'current balance', 'الرصيد الافتتاحي', 'رصيد افتتاحي', 'الرصيد', 'رصيد', 'opening balance', 'balance'];
const BALANCE_EXCLUDE = ['مدين', 'دائن', 'debit', 'credit', 'سابق', 'previous', 'نوع', 'طبيعه', 'side', 'type', 'nature', 'drcr', 'crdr'];
const A_CUST: ImportSpec = {
  ...CUST_ID,
  email: { aliases: ['البريد الإلكتروني', 'البريد', 'الايميل', 'email', 'e-mail', 'mail'] },
  businessName: { aliases: ['اسم المنشأة', 'المنشأة', 'النشاط التجاري', 'business name', 'company'] },
  commercialReg: { aliases: ['السجل التجاري', 'رقم السجل', 'commercial reg', 'cr'] },
  taxNumber: { aliases: ['الرقم الضريبي', 'الرقم الضريبى', 'tax number', 'vat', 'vat number'] },
  city: { aliases: ['المدينة', 'city'] },
  district: { aliases: ['الحي', 'المنطقة', 'district', 'area'] },
  address: { aliases: ['العنوان', 'address'] },
  channel: { aliases: ['قناة البيع', 'القناة', 'channel'] },
  creditLimit: { aliases: ['حد الائتمان', 'الحد الائتماني', 'credit limit'], numeric: true },
  paymentDays: { aliases: ['فترة السداد', 'أيام السداد', 'payment days'], numeric: true },
  // للتنبيه فقط (لا يُستورد مع العملاء)
  balance: { aliases: BALANCE_ALIASES, exclude: BALANCE_EXCLUDE },
};
const UNLIMITED = new Set(['غير محدود', 'غير محدد', 'بدون', 'بلا حد', 'مفتوح', 'unlimited', 'no limit', 'none', 'n/a'].map(norm));
/**
 * رقم حقل عميل ثانوي بهدوء: الرقم المفهوم كما هو (السالب وكسر الأيام يُرفضان بعده)؛ وللأيام عدد صحيح واحد داخل النص
 * («30 يوم»، «Net 30»، «٣٠ يوماً»). «غير محدود» وما لا يُفهم ⇒ undefined (افتراضي الخادم) ويُسجَّل في ignored.
 */
function optionalCustomerNumber(raw: unknown, days: boolean, ignored: string[]): number | undefined {
  const p = parseAmount(raw === '' ? undefined : raw);
  if (p.ok) return p.value;
  const text = val(raw);
  if (days && !UNLIMITED.has(norm(text))) {
    const nums = toAsciiDigits(text).match(/\d+(?:[.,]\d+)?/g) || [];
    if (nums.length === 1 && /^\d+$/.test(nums[0])) return Number(nums[0]);
  }
  ignored.push(text);
  return undefined;
}
function toCustomers(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const c = makeCtx(rows, A_CUST, opts);
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const { errors } = c;
  let balanceIgnored = false;
  const ignored: string[] = [];
  rows.forEach((row, i) => {
    const name = c.s(row, 'name'); const code = c.s(row, 'code'); const phone = c.s(row, 'phone');
    if (isTotalsRow(name, code, phone)) { c.totalsRow(name || code); return; }
    // عمود «الرصيد» لا يُستورد مع العملاء — تنبيه غير مانع حين يحمل قيمة غير صفرية
    if (!balanceIgnored) { const b = parseAmount(c.raw(row, 'balance')); if (!b.ok || (b.value !== undefined && b.value !== 0)) balanceIgnored = true; }
    if (!name) { errors.push({ row: i + 2, message: 'اسم العميل مفقود' }); return; }
    // حقلان ثانويان: النص غير الرقمي («غير محدود»، «30 يوم») لا يُسقط العميل؛ يُترك للافتراضي بتنبيه معدود
    const creditLimit = optionalCustomerNumber(c.raw(row, 'creditLimit'), false, ignored);
    if (creditLimit !== undefined && creditLimit < 0) { errors.push({ row: i + 2, message: NEGATIVE_CREDIT_LIMIT, value: c.s(row, 'creditLimit'), field: 'creditLimit' }); return; }
    const paymentDays = optionalCustomerNumber(c.raw(row, 'paymentDays'), true, ignored);
    if (paymentDays !== undefined && (!Number.isInteger(paymentDays) || paymentDays < 0)) {
      errors.push({ row: i + 2, message: PAYMENT_DAYS_INVALID, value: c.s(row, 'paymentDays'), field: 'paymentDays' }); return;
    }
    fileRows.push(i + 2);
    // الجوال يُرسل كما هو: الخادم يطبّعه (normImportPhone) ويعامل التافه «—»
    valid.push({
      name, phone, code: code || undefined,
      email: c.s(row, 'email') || undefined, businessName: c.s(row, 'businessName') || undefined,
      commercialReg: c.s(row, 'commercialReg') || undefined, taxNumber: c.s(row, 'taxNumber') || undefined,
      city: c.s(row, 'city') || undefined, district: c.s(row, 'district') || undefined,
      address: c.s(row, 'address') || undefined, channel: channelCode(c.s(row, 'channel')) || undefined,
      creditLimit, paymentDays,
    });
  });
  const extra: ImportNotice[] = ignored.length ? [{ key: CUSTOMER_OPTIONAL_IGNORED_NOTICE, count: ignored.length, values: [...new Set(ignored)].slice(0, 10) }] : [];
  return { valid, fileRows, errors, warnings: balanceIgnored ? [CUSTOMER_BALANCE_WARNING] : [], notices: c.notices(extra), columns: c.res.columns, blockers: c.res.blockers };
}

// ============ المنتجات ============
const ID_NAME_EXCLUDE = ['كود', 'رقم', 'مرجع', 'باركود', 'code', 'ref', 'barcode', 'sku'];
const A_PROD: ImportSpec = {
  code: { aliases: ['مرجع داخلي', 'المرجع الداخلي', 'مرجع', 'كود الصنف', 'رقم الصنف', 'code', 'sku', 'internal reference', 'reference', 'ref'], exclude: CODE_EXCLUDE },
  name: { aliases: ['اسم الصنف', 'الصنف', 'اسم المنتج', 'الاسم', 'name', 'product', 'item'], exclude: ID_NAME_EXCLUDE },
  unit: { aliases: ['الوحدة', 'وحدة القياس', 'unit', 'uom'] },
  basePrice: {
    aliases: ['سعر البيع', 'السعر', 'السعر الأساسي', 'price', 'sales price', 'sale price', 'list price', 'unit price'],
    preferred: ['سعر البيع', 'sales price', 'sale price'],
    exclude: ['تكلفه', 'cost', 'شراء', 'purchase'], numeric: true,
  },
  taxPct: {
    aliases: ['الضريبة', 'نسبة الضريبة', 'tax', 'vat'],
    // «Vendor Taxes» (ضرائب المشتريات) ليست نسبة ضريبة البيع
    exclude: ['شامل', 'incl', 'مبلغ', 'amount', 'قيمه', 'value', 'رقم', 'number', 'purchase', 'vendor', 'supplier', 'مشتريات', 'مورد'], numeric: true,
  },
  barcode: { aliases: ['الباركود', 'barcode', 'ean'] },
  category: { aliases: ['فئة المنتج', 'الفئة', 'التصنيف', 'المجموعة', 'category', 'group'] },
};
function toProducts(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const c = makeCtx(rows, A_PROD, opts);
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const { errors } = c;
  rows.forEach((row, i) => {
    const name = c.s(row, 'name');
    if (!name) { errors.push({ row: i + 2, message: 'اسم الصنف مفقود' }); return; }
    const code = c.s(row, 'code') || name; // توليد الكود من الاسم عند غيابه (أنظمة كثيرة لا تُصدّر كوداً)
    const basePrice = c.num(row, i, 'basePrice');
    if (basePrice === null) return;
    if (basePrice !== undefined && basePrice < 0) { errors.push({ row: i + 2, message: NEGATIVE_PRICE, value: c.s(row, 'basePrice'), field: 'basePrice' }); return; }
    const taxRaw = c.raw(row, 'taxPct');
    let taxPct = c.num(row, i, 'taxPct', true);
    if (taxPct === null) return;
    // خلية Excel منسّقة «15%» قيمتها 0.15، و«0.15» نصاً كسر ⇒ نسبة مئوية بتنبيه؛ «15%» نصاً تبقى 15
    if (taxPct !== undefined && taxPct > 0 && taxPct < 1 && !hasPercentSign(taxRaw)) {
      taxPct = Math.round(taxPct * 100 * 1e6) / 1e6;
      c.bump(TAX_FRACTION_NOTICE);
    }
    if (taxPct !== undefined && (taxPct < 0 || taxPct > 100)) { errors.push({ row: i + 2, message: TAX_PCT_INVALID, value: val(taxRaw), field: 'taxPct' }); return; }
    fileRows.push(i + 2);
    valid.push({
      code, name, unit: c.s(row, 'unit') || undefined,
      basePrice, taxPct,
      barcode: c.s(row, 'barcode') || undefined, category: c.s(row, 'category') || undefined,
    });
  });
  return { valid, fileRows, errors, notices: c.notices(), columns: c.res.columns, blockers: c.res.blockers };
}

// ============ الأرصدة الافتتاحية ============
// «نوع الرصيد»/«مدين/دائن»/«Dr/Cr» (بأي ترتيب) عمود إشارة لا مبلغ: لا يُلتقط مديناً أو دائناً بالاحتواء
const BAL_DC_EXCLUDE = ['نوع', 'طبيعه', 'مديندائن', 'دائنمدين', 'مديناودائن', 'دائناومدين', 'drcr', 'crdr', 'debitcredit', 'creditdebit',
  'debitorcredit', 'creditordebit', 'side', 'type', 'nature'];
const A_BAL: ImportSpec = {
  ...CUST_ID,
  balance: { aliases: BALANCE_ALIASES, exclude: BALANCE_EXCLUDE, numeric: true },
  debit: { aliases: ['الرصيد المدين', 'مدين', 'المدين', 'debit', 'dr'], exclude: BAL_DC_EXCLUDE, numeric: true },
  credit: { aliases: ['الرصيد الدائن', 'دائن', 'الدائن', 'credit', 'cr'], exclude: BAL_DC_EXCLUDE, numeric: true },
  // عمود إشارة الرصيد المنفصل — تطابق تام فقط (dr/cr قصيرة)
  balanceSide: {
    aliases: ['نوع الرصيد', 'طبيعة الرصيد', 'م/د', 'د/م', 'مدين/دائن', 'دائن/مدين', 'مدين أو دائن', 'دائن أو مدين', 'مدين او دائن', 'دائن او مدين',
      'رصيد (مدين/دائن)', 'الرصيد (مدين/دائن)', 'رصيد (دائن/مدين)', 'الرصيد (دائن/مدين)', 'رصيد (م/د)', 'الرصيد (م/د)',
      'dr/cr', 'cr/dr', 'd/c', 'c/d', 'debit/credit', 'credit/debit', 'debit or credit', 'credit or debit',
      'side', 'balance type', 'balance side', 'balance nature', 'balance (dr/cr)', 'balance (cr/dr)', 'balance dr/cr'],
    exactOnly: true,
  },
  date: { aliases: ['التاريخ', 'date'] },
};
// قيم نوع الرصيد بعد التطبيع. «د» وحدها دائن و«م» مدين، كما في صيغة «م/د» (م = مدين، د = دائن)
const SIDE_CREDIT = new Set(['دائن', 'د', 'له', 'دائنة', 'رصيد دائن', 'cr', 'c', 'credit', 'credit balance'].map(norm));
const SIDE_DEBIT = new Set(['مدين', 'م', 'عليه', 'مدينة', 'رصيد مدين', 'dr', 'd', 'debit', 'debit balance'].map(norm));
// رؤوس عامة («النوع»، «Type»، «طبيعة الحساب») تُعدّ عمود إشارة فقط حين تحمل قيمة مدين/دائن فعلاً — لا عمود «نوع العميل»
const GENERIC_SIDE_HEADERS = new Set(['النوع', 'نوع', 'الطبيعة', 'طبيعة', 'طبيعة الحساب', 'نوع الحساب', 'type', 'nature', 'account type', 'account nature'].map(norm));
const sideOf = (raw: string): 'credit' | 'debit' | 'empty' | null => {
  const n = norm(raw).replace(/[.:،,]/g, '');
  if (!n) return 'empty';
  return SIDE_CREDIT.has(n) ? 'credit' : SIDE_DEBIT.has(n) ? 'debit' : null;
};
// تاريخ الصف: '' بلا تاريخ، وnull غير مفهوم (يُسجَّل خطأً ويُستبعد الصف من valid)
function rowDate(raw: string, i: number, errors: ImportRowError[]): string | null {
  const d = normDate(raw);
  if (d === null) errors.push({ row: i + 2, message: DATE_ERROR_MESSAGE, value: raw });
  return d;
}
/** مفتاح العميل داخل الملف: الكود، وإلا أرقام الجوال، وإلا الاسم المطبَّع */
const customerKey = (name: string, code: string, phone: string): string => {
  if (code) return `c:${code.trim()}`;
  const digits = toAsciiDigits(phone).replace(/\D/g, '');
  if (digits) return `p:${digits}`;
  return `n:${norm(name)}`;
};
function toBalances(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const c = makeCtx(rows, A_BAL, opts);
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const { errors } = c;
  const hasBal = c.has('balance'); const hasDC = c.has('debit') || c.has('credit');
  if (!c.has('balanceSide')) {
    const generic = headersOf(rows).find((h) => GENERIC_SIDE_HEADERS.has(norm(h))
      && rows.some((r) => { const sd = sideOf(val(r[h])); return sd === 'credit' || sd === 'debit'; }));
    if (generic) {
      c.res.candidates.balanceSide = [generic];
      c.res.columns = c.res.columns.map((x) => (x.field === 'balanceSide' ? { field: x.field, header: generic } : x));
    }
  }
  const hasSide = c.has('balanceSide');
  const blockers = [...c.res.blockers];
  const extra: ImportNotice[] = [];
  // رصيد ومدين/دائن معاً: خانة الرصيد المملوءة هي المستورد (بتنبيه، والتعارض يُعدّ)، والفارغة يُحسب رصيدها مدين − دائن
  let fromDC = 0;
  if (hasBal && hasDC && rows.some((r) => val(c.raw(r, 'balance')) !== '')) extra.push({ key: BALANCE_DC_IGNORED_NOTICE });
  // رأس إشارة لم يُحل عمود إشارة: «نوع/طبيعة الرصيد» بصيغة غير معروفة، أو مدين ودائن معاً في رأس واحد ⇒ الإشارة مجهولة
  const sideCols = c.res.candidates.balanceSide ?? [];
  const amountCols = new Set([...(c.res.candidates.balance ?? []), ...(c.res.candidates.debit ?? []), ...(c.res.candidates.credit ?? [])]);
  const unresolvedSide = headersOf(rows).filter((h) => {
    const n = norm(h);
    if (sideCols.includes(h) || amountCols.has(h)) return false;
    const kind = ['نوع', 'طبيعه', 'side', 'type', 'nature'].some((x) => n.includes(x));
    const bothSides = (n.includes('مدين') && n.includes(norm('دائن'))) || (n.includes('debit') && n.includes('credit')) || n.includes('drcr') || n.includes('crdr');
    return ((n.includes('رصيد') || n.includes('balance')) && kind) || bothSides;
  });
  if (hasBal && unresolvedSide.length) blockers.push(BALANCE_SIDE_UNRESOLVED_BLOCKER);
  const mismatch: string[] = [];
  const seen = new Map<string, { label: string; n: number }>();
  let undated = 0;
  rows.forEach((row, i) => {
    const cn = c.s(row, 'name'); const cc = c.s(row, 'code'); const ph = c.s(row, 'phone');
    if (isTotalsRow(cn, cc, ph)) { c.totalsRow(cn || cc); return; }
    if (!cn && !cc && !ph) { errors.push({ row: i + 2, message: 'معرف العميل مفقود الاسم/الكود/الجوال' }); return; }
    let bal: number | undefined;
    // خانة رصيد فارغة مع مدين/دائن: تُحسب من المدين والدائن لا صفراً صامتاً
    const balBlank = hasBal && hasDC && val(c.raw(row, 'balance')) === '';
    if ((hasBal || !hasDC) && !balBlank) {
      const b = c.num(row, i, 'balance');
      if (b === null) return;
      bal = b;
      if (hasSide && bal !== undefined && bal !== 0) {
        const sideRaw = c.s(row, 'balanceSide');
        const side = sideOf(sideRaw);
        if (side === null) { errors.push({ row: i + 2, message: BALANCE_SIDE_INVALID, value: sideRaw, field: 'balanceSide' }); return; }
        if (side === 'credit') bal = -Math.abs(bal); else if (side === 'debit') bal = Math.abs(bal);
      }
      if (hasBal && hasDC && bal !== undefined) {
        const d = parseAmount(c.raw(row, 'debit'), c.styleOf('debit')); const cr = parseAmount(c.raw(row, 'credit'), c.styleOf('credit'));
        const dv = d.ok ? d.value : undefined; const cv = cr.ok ? cr.value : undefined;
        if (d.ok && cr.ok && (dv !== undefined || cv !== undefined) && Math.abs(bal - ((dv ?? 0) - (cv ?? 0))) > 0.005) mismatch.push(cn || cc || ph);
      }
    } else {
      // عمودا مدين/دائن بلا عمود رصيد (أو خانة رصيده فارغة) ⇒ الرصيد = مدين − دائن
      const d = c.num(row, i, 'debit'); if (d === null) return;
      const cr = c.num(row, i, 'credit'); if (cr === null) return;
      bal = d === undefined && cr === undefined ? undefined : Math.round(((d ?? 0) - (cr ?? 0)) * 1e6) / 1e6;
      if (balBlank && bal !== undefined && bal !== 0) fromDC++;
    }
    if (bal === undefined || bal === 0) { c.bump(ZERO_BALANCE_NOTICE); return; } // بلا رصيد — يُتجاهَل بتنبيه
    const date = rowDate(c.s(row, 'date'), i, errors);
    if (date === null) return;
    if (!date) undated++;
    const key = customerKey(cn, cc, ph);
    const e = seen.get(key);
    if (e) e.n++; else seen.set(key, { label: cn || cc || ph, n: 1 });
    fileRows.push(i + 2);
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, balance: bal, date: date || opts?.undatedDate || undefined });
  });
  const dups = [...seen.values()].filter((x) => x.n > 1);
  if (dups.length) extra.push({ key: DUPLICATE_CUSTOMERS_NOTICE, count: dups.length, values: dups.slice(0, 10).map((x) => x.label) });
  if (mismatch.length) extra.push({ key: BALANCE_DC_MISMATCH_NOTICE, count: mismatch.length, values: mismatch.slice(0, 10) });
  if (fromDC) extra.push({ key: BALANCE_FROM_DC_NOTICE, count: fromDC });
  return { valid, fileRows, errors, undated, notices: c.notices(extra), columns: c.res.columns, blockers };
}

// ============ كشوف الحسابات / دفتر الأستاذ ============
const LED_DC_EXCLUDE = ['رصيد', 'balance'];
const LED_AMOUNT_INCL = ['الإجمالي شامل الضريبة', 'الإجمالي شامل ضريبة القيمة المضافة', 'المبلغ شامل الضريبة', 'الإجمالي مع الضريبة', 'شامل الضريبة',
  'total incl. tax', 'total incl tax', 'total including tax', 'total incl. vat', 'total incl vat', 'total including vat', 'total with tax', 'amount total'];
const A_LED: ImportSpec = {
  ...CUST_ID,
  date: { aliases: ['التاريخ', 'date'] },
  description: { aliases: ['البيان', 'الوصف', 'التفاصيل', 'مرجع الطلب', 'رقم الإيصال', 'رقم الطلب', 'اسم الحساب', 'description', 'details', 'memo', 'reference'] },
  debit: { aliases: ['المدين', 'مدين', 'debit', 'dr'], exclude: LED_DC_EXCLUDE, numeric: true },
  credit: { aliases: ['الدائن', 'دائن', 'credit', 'cr'], exclude: LED_DC_EXCLUDE, numeric: true },
  amount: {
    // الإجمالي شامل الضريبة أولاً (تصديرات فواتير ZATCA وأودو)، ويُفضَّل على «الإجمالي»/«المبلغ» حين يجتمعان
    aliases: [...LED_AMOUNT_INCL, 'الإجمالي', 'المبلغ', 'الصافي', 'القيمة', 'total', 'amount', 'net'],
    preferred: LED_AMOUNT_INCL,
    // تُستبعد أعمدة ما قبل الضريبة ومبلغ الضريبة نفسه — لا كل عنوان فيه «ضريبة»
    exclude: ['مدفوع', 'paid', 'متبقي', 'مستحق', 'due', 'residual', 'قبل الضريبه', 'بدون ضريبه', 'بدون الضريبه', 'غير شامل',
      'قيمه الضريبه', 'مبلغ الضريبه', 'untaxed', 'excl', 'tax amount', 'vat amount', 'amount tax'], numeric: true,
  },
  paid: { aliases: ['المدفوع', 'المبلغ المدفوع', 'amount paid', 'paid amount'], numeric: true },
  residual: { aliases: ['المتبقي', 'المبلغ المستحق', 'amount due', 'residual', 'balance due'], numeric: true },
  // حالة الدفع أولاً: أودو يصدّر «Status» (posted/cancel) و«Payment Status» (not_paid/paid) معاً
  status: { aliases: ['حالة الدفع', 'حالة السداد', 'payment status', 'payment state', 'الحالة', 'status', 'state'] },
};
const statusOf = (row: Record<string, unknown>, cands: readonly string[] | undefined): { cls: PaymentStatusClass; raw: string } => {
  const all = (cands ?? []).map((k) => ({ raw: val(row[k]), cls: classifyPaymentStatus(val(row[k])) })).filter((x) => x.cls !== 'none');
  const doc = all.find((x) => x.cls === 'cancelled') ?? all.find((x) => x.cls === 'draft');
  return doc ?? all[0] ?? { cls: 'none', raw: '' };
};
function toLedger(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const c = makeCtx(rows, A_LED, opts);
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const { errors } = c;
  const unknownStatuses = new Set<string>();
  const blockers = [...c.res.blockers];
  // بلا عمود مدين/دائن ولا مبلغ ⇒ لا شيء يُستورد: مانع صريح لا صفر صفوف صامت
  if (rows.length && !c.has('debit') && !c.has('credit') && !c.has('amount')) blockers.push(LEDGER_NO_AMOUNT_COLUMN_BLOCKER);
  let undated = 0;
  rows.forEach((row, i) => {
    const cn = c.s(row, 'name'); const cc = c.s(row, 'code'); const ph = c.s(row, 'phone');
    if (isTotalsRow(cn, cc, ph)) { c.totalsRow(cn || cc); return; }
    if (!cn && !cc && !ph) { c.bump(NO_CUSTOMER_ROWS_NOTICE); return; } // صف بلا عميل (حسابات عامة)
    const d = c.num(row, i, 'debit'); if (d === null) return;
    const cr = c.num(row, i, 'credit'); if (cr === null) return;
    let debit = 0; let credit = 0;
    // مدين سالب ينتقل دائناً بقيمته المطلقة والعكس
    for (const [v, side] of [[d, 'd'], [cr, 'c']] as const) {
      if (!v) continue;
      if ((v > 0) === (side === 'd')) debit += Math.abs(v); else credit += Math.abs(v);
    }
    if (!debit && !credit) {
      // لا مدين/دائن ⇒ ملف فواتير: الإجمالي = مدين (على الحساب)، والمدفوع = دائن مقابل
      if (!c.has('amount')) return;
      const amt = c.num(row, i, 'amount'); if (amt === null) return;
      if (amt === undefined || amt === 0) return;
      const st = statusOf(row, c.res.candidates.status);
      if (st.cls === 'cancelled') { c.bump(CANCELLED_ROWS_NOTICE); return; }
      if (st.cls === 'draft') { c.bump(DRAFT_ROWS_NOTICE); return; }
      const abs = Math.abs(amt);
      let paidAmt: number | undefined;
      const p = c.num(row, i, 'paid'); if (p === null) return;
      const r = c.num(row, i, 'residual'); if (r === null) return;
      if (p !== undefined) {
        if (p < 0 || p > abs) { errors.push({ row: i + 2, message: PAID_OUT_OF_RANGE, value: c.s(row, 'paid'), field: 'paid' }); return; }
        paidAmt = p;
      } else if (r !== undefined) {
        if (r < 0 || r > abs) { errors.push({ row: i + 2, message: PAID_OUT_OF_RANGE, value: c.s(row, 'residual'), field: 'residual' }); return; }
        paidAmt = Math.round((abs - r) * 1e6) / 1e6;
      } else if (st.cls === 'partial') {
        errors.push({ row: i + 2, message: PARTIAL_NO_PAID_COLUMN, value: st.raw, field: 'status' }); return;
      } else if (st.cls === 'paid') {
        paidAmt = abs;
      } else {
        if (st.cls === 'unknown') unknownStatuses.add(st.raw);
        paidAmt = 0;
      }
      if (amt > 0) { debit = abs; credit = paidAmt; } else { credit = abs; debit = paidAmt; }
    }
    if (!debit && !credit) return;
    const date = rowDate(c.s(row, 'date'), i, errors);
    if (date === null) return;
    if (!date) undated++;
    fileRows.push(i + 2);
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, date: date || opts?.undatedDate || undefined, description: c.s(row, 'description') || undefined, debit, credit });
  });
  const extra: ImportNotice[] = unknownStatuses.size ? [{ key: UNKNOWN_STATUS_NOTICE, count: unknownStatuses.size, values: [...unknownStatuses].slice(0, 10) }] : [];
  return { valid, fileRows, errors, undated, notices: c.notices(extra), columns: c.res.columns, blockers };
}

// ============ قوائم الأسعار ============
const A_PRC: ImportSpec = {
  ...CUST_ID,
  productCode: { aliases: ['كود الصنف', 'مرجع داخلي', 'رقم الصنف', 'product code', 'item code', 'sku'], exclude: CODE_EXCLUDE },
  // «السعر الخاص» مع «السعر» الأساسي: الخاص وحده (خانته الفارغة خطأ صف لا السعر الأساسي)
  price: { aliases: ['السعر الخاص', 'السعر', 'سعر البيع', 'price', 'special price'], preferred: ['السعر الخاص', 'special price'], exclude: ['تكلفه', 'cost', 'شراء', 'purchase'], numeric: true },
};
function toPrices(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const c = makeCtx(rows, A_PRC, opts);
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const { errors } = c;
  let zeroPriceRows = 0;
  rows.forEach((row, i) => {
    const cn = c.s(row, 'name'); const cc = c.s(row, 'code'); const ph = c.s(row, 'phone');
    if (isTotalsRow(cn, cc, ph)) { c.totalsRow(cn || cc); return; }
    const pc = c.s(row, 'productCode');
    if (!cn && !cc && !ph) { errors.push({ row: i + 2, message: 'معرف العميل مفقود' }); return; }
    if (!pc) { errors.push({ row: i + 2, message: 'كود الصنف مفقود' }); return; }
    const price = c.num(row, i, 'price');
    if (price === null) return;
    if (price === undefined) { errors.push({ row: i + 2, message: 'السعر مفقود' }); return; }
    if (price < 0) { errors.push({ row: i + 2, message: NEGATIVE_PRICE, value: c.s(row, 'price'), field: 'price' }); return; }
    if (price === 0) zeroPriceRows++; // صالح، لكن الإرسال يحتاج إقرار المالك (allowZeroPrice)
    fileRows.push(i + 2);
    valid.push({ customerName: cn || undefined, customerCode: cc || undefined, phone: ph || undefined, productCode: pc, price });
  });
  return { valid, fileRows, errors, notices: c.notices(), columns: c.res.columns, blockers: c.res.blockers, zeroPriceRows };
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
// «كود الصنف» يحوي «الصنف» و«product code» يحوي «product» ⇒ الاسم يستثني عناوين المعرّفات
const A_STOCK: ImportSpec = {
  code: { aliases: ['كود الصنف', 'رقم الصنف', 'كود المنتج', 'مرجع داخلي', 'المرجع الداخلي', 'product code', 'item code', 'internal reference', 'sku', 'code'], exclude: CODE_EXCLUDE },
  barcode: { aliases: ['الباركود', 'باركود', 'barcode', 'ean'] },
  name: { aliases: ['اسم الصنف', 'اسم المنتج', 'الصنف', 'المنتج', 'الاسم', 'product name', 'item name', 'product', 'item', 'name'], exclude: ID_NAME_EXCLUDE },
  qty: {
    aliases: ['الكمية المتاحة', 'الكمية الفعلية', 'الكمية', 'كمية', 'الرصيد', 'on hand quantity', 'on hand', 'quantity', 'qty', 'stock'],
    preferred: ['الكمية المتاحة', 'الكمية الفعلية', 'on hand quantity', 'on hand'],
    exclude: ['محجوز', 'reserved', 'قيمه', 'value', 'تكلف', 'cost', 'سعر', 'price'], numeric: true,
  },
  unitCost: {
    aliases: ['تكلفة الوحدة', 'سعر التكلفة', 'متوسط التكلفة', 'التكلفة', 'unit cost', 'cost price', 'average cost', 'standard price', 'cost'],
    preferred: ['تكلفة الوحدة', 'unit cost'],
    exclude: ['اجمالي', 'مجموع', 'total', 'قيمه', 'value'], numeric: true,
  },
};
const round2 = (n: number) => Math.round(n * 100) / 100;
function toOpeningStock(rows: Record<string, unknown>[], opts?: TransformOpts): TransformOut {
  const c = makeCtx(rows, A_STOCK, opts);
  const valid: Record<string, unknown>[] = []; const fileRows: number[] = []; const { errors } = c;
  let zeroQty = false; let total = 0;
  rows.forEach((row, i) => {
    const productCode = c.s(row, 'code'); const barcode = c.s(row, 'barcode'); const productName = c.s(row, 'name');
    const qtyRaw = c.s(row, 'qty'); const costRaw = c.s(row, 'unitCost');
    if (!productCode && !barcode && !productName) { errors.push({ row: i + 2, message: STOCK_ID_MISSING }); return; }
    const qty = c.num(row, i, 'qty');
    if (qty === null) return;
    if (qty === undefined || qty === 0) { zeroQty = true; return; } // صنف بلا رصيد في تقرير المخزون — يُتجاهل بلا خطأ
    if (!(qty > 0)) { errors.push({ row: i + 2, message: STOCK_QTY_INVALID, value: qtyRaw }); return; }
    const unitCost = c.num(row, i, 'unitCost');
    if (unitCost === null) return;
    if (unitCost === undefined || !(unitCost > 0) || unitCost > OPENING_STOCK_MAX_UNIT_COST) {
      errors.push({ row: i + 2, message: STOCK_COST_INVALID, ...(costRaw ? { value: costRaw } : {}) }); return;
    }
    total += qty * unitCost;
    fileRows.push(i + 2);
    valid.push({
      ...(productCode ? { productCode } : {}), ...(barcode ? { barcode } : {}), ...(productName ? { productName } : {}), qty, unitCost,
    });
  });
  return { valid, fileRows, errors, warnings: zeroQty ? [STOCK_ZERO_QTY_WARNING] : [], totalCost: round2(total), notices: c.notices(), columns: c.res.columns, blockers: c.res.blockers };
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
  /** 403 IMPORT_SCOPED_ADMIN — مستخدم مقيّد بنطاق عملاء: الاستيراد والتراجع على مستوى الشركة */
  | { type: 'scopedAdmin' }
  /** 403 IMPORT_PERMISSION_DENIED — لا يملك صلاحية نوع البيانات */
  | { type: 'permissionDenied'; kind?: string; permission?: string }
  /** 403 ACCOUNTING_NOT_ALLOWED — المحاسبة غير مفعّلة للشركة */
  | { type: 'accountingDisabled' }
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
    case 'IMPORT_SCOPED_ADMIN': return { type: 'scopedAdmin' };
    case 'IMPORT_PERMISSION_DENIED': return { type: 'permissionDenied', kind: str(d('kind')), permission: str(d('permission')) };
    case 'ACCOUNTING_NOT_ALLOWED': return { type: 'accountingDisabled' };
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
