// رفع بصمات الحضور من Excel (طلب المالك، ٢١ أكتوبر ٢٠٢٦) — قراءة الورقة صرفاً بلا DOM: الأعمدة بالعربية أو الإنجليزية،
// والمندوب باسم المستخدم (فريدٌ على المنصّة)، والتاريخ والوقتان بأيّ صيغةٍ يكتبها Excel أو الإنسان، والأوقات بتوقيت
// المتصفّح. الخادم يحكم بعدها على كل صفّ (backend/src/routes/attendanceAdmin.ts): الحدود والتداخل والنطاق.

import type * as XLSXNS from 'xlsx';

export interface ImportRep { id: string; name: string; username: string }

/**
 * الملف ⇒ مصفوفة صفوفٍ وإزاحة سطر العناوين. CSV يُفكّ نصّاً UTF-8 ويُقرأ بـraw: بلا ذلك تقلب SheetJS «05/10/2026»
 * إلى ١٠ مايو (mm/dd) وتترك «21/10/2026» نصّاً — نصف الملف بشهرٍ مقلوب — وتقرأ CSV بلا BOM (تصدير Google Sheets)
 * بترميزٍ لاتينيّ فتفسد العناوين العربية. والورقة التي تبدأ من صفٍّ متأخر (!ref = A3:…) تُبلَّغ بأسطر ملفها.
 */
/**
 * نصّ ملفٍّ نصّي بترميزه: UTF-16 بعلامته (‎«Unicode Text» من Excel وتصدير بعض أجهزة البصمة)، ثم UTF-8 إن صحّ،
 * وإلّا Windows-1256 (CSV من Excel العربي القديم) — لا عناوين عربية تالفة فـ«أعمدة ناقصة»
 */
export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let text: string;
  if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder('utf-16le').decode(b.subarray(2));
  else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder('utf-16be').decode(b.subarray(2));
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { text = new TextDecoder('windows-1256').decode(b); }
  }
  return text.replace(/^\uFEFF/, '');
}

export function sheetFromFile(XLSX: typeof XLSXNS, buf: ArrayBuffer, fileName: string): { matrix: unknown[][]; lineOffset: number } {
  const wb = /\.(csv|txt)$/i.test(fileName)
    ? XLSX.read(decodeText(buf), { type: 'string', raw: true })
    : XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { matrix: [], lineOffset: 0 };
  return {
    matrix: XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' }),
    lineOffset: XLSX.utils.decode_range(ws['!ref'] ?? 'A1').s.r,
  };
}
export interface ParsedRow {
  /** رقم السطر في الملف (١ = العناوين) */
  line: number;
  username: string;
  repName?: string;
  salesRepId?: string;
  checkInAt?: string;
  checkOutAt?: string | null;
  error?: string;
}
export type DateCode = { y: number; m: number; d: number; H: number; M: number } | null;

/** عناوين الأعمدة المقبولة — تُطابق بعد التطبيع */
const HEADERS: Record<'username' | 'date' | 'in' | 'out', string[]> = {
  username: ['اسم المستخدم', 'المستخدم', 'username', 'user name', 'user'],
  date: ['التاريخ', 'اليوم', 'date', 'day'],
  in: ['وقت الحضور', 'الحضور', 'حضور', 'check in', 'checkin', 'time in', 'in'],
  out: ['وقت الانصراف', 'الانصراف', 'انصراف', 'check out', 'checkout', 'time out', 'out'],
};

/** أقصى صفوف الرفع الواحد — كحدّ الخادم (IMPORT_MAX_ROWS في backend/src/routes/attendanceAdmin.ts) */
export const IMPORT_MAX_ROWS = 2000;

/** القالب الذي يُنزَّل للمستخدم — بالعناوين نفسها */
export const TEMPLATE_HEADERS = ['اسم المستخدم', 'التاريخ', 'وقت الحضور', 'وقت الانصراف'] as const;

const digits = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
const norm = (v: unknown) => digits(String(v ?? '')).replace(/[ـً-ْ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** مواضع الأعمدة الأربعة في سطر العناوين — أو أسماء الناقص منها */
export function findColumns(header: readonly unknown[]): { cols: Record<'username' | 'date' | 'in' | 'out', number> } | { missing: string[] } {
  const h = header.map(norm);
  const cols = {} as Record<'username' | 'date' | 'in' | 'out', number>;
  const missing: string[] = [];
  for (const key of ['username', 'date', 'in', 'out'] as const) {
    const i = h.findIndex((x) => HEADERS[key].includes(x));
    if (i < 0) missing.push(HEADERS[key][0]); else cols[key] = i;
  }
  return missing.length ? { missing } : { cols };
}

/** يومٌ موجودٌ فعلاً في شهره: 31/02 لا ينزلق بصمتٍ إلى ٣ مارس */
const validYMD = (y: number, m: number, d: number) => {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** رقمٌ في خلية نصّية (CSV يُقرأ نصّاً): «46316» تاريخٌ تسلسلي و«0.3333» كسر يوم كما في الخلية الرقمية */
const numericText = (v: unknown): unknown => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : v);

export type DateOrder = 'DMY' | 'MDY';

/**
 * ترتيب التواريخ المكتوبة بشرطة مائلة في الملف كله لا سطراً سطراً: جزءٌ أوّل فوق ١٢ ⇒ يوم/شهر، وثانٍ فوق ١٢ ⇒ شهر/يوم
 * (‎CSV‎ من Excel بإعداداتٍ أمريكية). ملفٌّ كلّ أيامه ≤ ١٢ ملتبس: يُقرأ يوم/شهر ويُنبَّه عليه في المعاينة.
 */
export function dateOrderOf(values: readonly unknown[]): { order: DateOrder; ambiguous: boolean } {
  let dmy = false; let mdy = false; let slashed = false;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(norm(v));
    if (!m) continue;
    slashed = true;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (mdy && !dmy) return { order: 'MDY', ambiguous: false };
  return { order: 'DMY', ambiguous: slashed && !dmy && !mdy };
}

/** تاريخ الخلية: رقم Excel تسلسلي، أو نص 2026-10-21، أو 21/10/2026 و21-10-2026 (أو 10/21/2026 بترتيب الملف) */
export function cellDate(raw: unknown, code: (n: number) => DateCode, order: DateOrder = 'DMY'): { y: number; m: number; d: number } | null {
  const v = numericText(raw);
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) {
    const c = code(v);
    return c && validYMD(c.y, c.m, c.d) ? { y: c.y, m: c.m, d: c.d } : null;
  }
  const s = norm(v);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) { const r = { y: +m[1], m: +m[2], d: +m[3] }; return validYMD(r.y, r.m, r.d) ? r : null; }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (m) {
    const r = order === 'MDY' ? { y: +m[3], m: +m[1], d: +m[2] } : { y: +m[3], m: +m[2], d: +m[1] };
    return validYMD(r.y, r.m, r.d) ? r : null;
  }
  return null;
}

/** وقت الخلية: كسر يومٍ من Excel (أو تاريخٌ بوقت)، أو نص 08:30 / 8:30 م / 8:30 PM / ‎2026-10-21 08:30‎ */
export function cellTime(raw: unknown, code: (n: number) => DateCode): { h: number; min: number } | null {
  const v = numericText(raw);
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    const c = code(v);
    return c ? { h: c.H, min: c.M } : null;
  }
  // تاريخٌ قبل الوقت في الخلية نفسها: يُؤخذ الوقت
  const s = norm(v).replace(/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:t|\s)+/, '');
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(ص|م|am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) return null;
    const pm = ap === 'م' || ap.startsWith('p');
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return h <= 23 && min <= 59 ? { h, min } : null;
}

/** أطول ما تبقى فيه فترةٌ مفتوحة (بلا انصراف) — كحدّ الخادم: الأقدم تبتلع ما بعدها وتصير نوبة المندوب الحالية */
const OPEN_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * يقرأ الورقة (مصفوفة صفوف، الأول عناوين) إلى بصماتٍ جاهزة للرفع. السطر الفارغ يُترك، والخاطئ يبقى بسببه ليُرى
 * قبل الرفع. انصرافٌ قبل الحضور ⇒ دوامٌ ليليّ ينتهي في اليوم التالي، ومساويه خطأ (كشف جهاز البصمة يصدّر يوم البصمة
 * الواحدة هكذا — لا نوبة ٢٤ ساعة)، وانصرافٌ فارغ ⇒ فترةٌ مفتوحة لليوم الجاري وحده.
 * `lineOffset`: صفّ العناوين في الملف ناقص واحد — الورقة التي تبدأ من صفٍّ متأخر (!ref = A3:…) تُبلَّغ بأسطر ملفها.
 */
export function parseAttendanceSheet(matrix: readonly (readonly unknown[])[], reps: readonly ImportRep[], code: (n: number) => DateCode,
  opts: { lineOffset?: number; now?: number } = {}): { rows: ParsedRow[]; ambiguousDates: boolean } | { missing: string[] } {
  if (!matrix.length) return { missing: TEMPLATE_HEADERS.slice() };
  const found = findColumns(matrix[0]);
  if ('missing' in found) return found;
  const { cols } = found;
  const now = opts.now ?? Date.now();
  const { order, ambiguous } = dateOrderOf(matrix.slice(1).map((cells) => cells[cols.date]));
  // اسم المستخدم فريدٌ بحروفه كما كُتب (الدخول حسّاسٌ لحالتها): المطابقة الحرفية أولاً، ثمّ دون حالة الحروف إن دلّت
  // على مندوبٍ واحد — «Ali» و«ali» معاً لا يُنسب سطرهما لأحدهما بصمت
  const exact = new Map(reps.map((r) => [r.username.trim(), r]));
  const folded = new Map<string, ImportRep[]>();
  for (const r of reps) { const k = r.username.trim().toLowerCase(); folded.set(k, [...(folded.get(k) ?? []), r]); }
  const rows: ParsedRow[] = [];
  matrix.slice(1).forEach((cells, i) => {
    const line = i + 2 + (opts.lineOffset ?? 0);
    const user = String(cells[cols.username] ?? '').trim();
    const rawIn = cells[cols.in];
    const rawOut = cells[cols.out];
    if (!user && (cells[cols.date] == null || cells[cols.date] === '') && (rawIn == null || rawIn === '')) return; // سطرٌ فارغ
    const row: ParsedRow = { line, username: user };
    const candidates = folded.get(user.toLowerCase()) ?? [];
    const rep = exact.get(user) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!rep) { rows.push({ ...row, error: candidates.length > 1 ? 'اسم المستخدم يطابق أكثر من مندوب' : 'اسم المستخدم غير معروف' }); return; }
    row.repName = rep.name; row.salesRepId = rep.id;
    const day = cellDate(cells[cols.date], code, order);
    if (!day) { rows.push({ ...row, error: 'تاريخ غير صالح' }); return; }
    const tin = cellTime(rawIn, code);
    if (!tin) { rows.push({ ...row, error: 'وقت الحضور غير صالح' }); return; }
    const inAt = new Date(day.y, day.m - 1, day.d, tin.h, tin.min);
    let outAt: Date | null = null;
    if (rawOut != null && String(rawOut).trim() !== '') {
      const tout = cellTime(rawOut, code);
      if (!tout) { rows.push({ ...row, error: 'وقت الانصراف غير صالح' }); return; }
      if (tout.h === tin.h && tout.min === tin.min) { rows.push({ ...row, error: 'وقت الانصراف يساوي وقت الحضور' }); return; }
      outAt = new Date(day.y, day.m - 1, day.d, tout.h, tout.min);
      if (outAt < inAt) outAt = new Date(day.y, day.m - 1, day.d + 1, tout.h, tout.min);
    } else if (now - inAt.getTime() >= OPEN_MAX_MS) {
      rows.push({ ...row, error: 'أدخل وقت الانصراف' }); return;
    }
    rows.push({ ...row, checkInAt: inAt.toISOString(), checkOutAt: outAt ? outAt.toISOString() : null });
  });
  return { rows, ambiguousDates: ambiguous };
}
