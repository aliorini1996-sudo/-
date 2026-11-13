// ============================================================================
// نموذج «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — كل شركة ترفع صورة نموذجها الفارغ وتضع الحقول على
// فراغاته، فتطبع القيم وحدها في مواضعها. دوالّ خالصة بلا React ولا DOM: البداية المقترحة (starterForm)، والتقسيم إلى أوراق
// (formSheets)، ومحرّرات المصمّم (كلها تعيد نموذجاً جديداً مقصوصاً داخل الورقة على شبكة 0.5 مم — أو النموذج نفسه إن لم يتغيّر
// شيء، فلا يُسجَّل في التراجع تعديلٌ بلا أثر)، والتسميات العربية، والتنبيهات.
//
// الأبعاد بالمم من الركن الأيسر الأعلى الفعلي للورقة (x يميناً مهما كان اتجاه الواجهة) — والقواعد في النواة (printSettingsCore
// formFaults) والخادم يتحقّق منها ثانيةً. لا يستورد هذا الملف إلا النواة (لا دورة مع printSettings.ts الذي يستعمل starterForm).
//
// والطابعة النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦، MIP480): الإبرة لا تبلغ إلا حزمةً في وسط الورقة (formReachX) ولا تطبع فوق أول سطرٍ
// لها — فورق النموذج النقطي يحمل reach (formPaperOf)، وكل محرّرٍ يقصّ المواضع داخل ما تبلغه الإبرة **بعد المعايرة** (formReachBox)
// ورمز QR لا يصغر عن 55 مم، والبداية والمقاس الجديد يُزاحان أفقياً لا يُقاسان (الحزمة بعرضٍ ثابت). وبلا reach كل شيءٍ كما كان حرفياً.
// ============================================================================

import {
  ALIGNS, FORM_BOUNDS, FORM_COLUMN_IDS, FORM_FIELD_IDS, FORM_IMAGE_ID_RE, FORM_IMAGE_V_RE, FORM_LAST_SHEET_IDS, FORM_VALUE_LANGS, LAYOUT_BOUNDS,
  formQrMinMm, formReachX, isQrRemoved, layoutIssues,
  type FormColumn, type FormColumnId, type FormField, type FormFieldId, type FormImageRef, type FormTable, type FormValueLang, type Paper,
  type PrintForm, type PrintProfile,
} from './printSettingsCore';

export {
  FORM_BOUNDS, FORM_COLUMN_IDS, FORM_FIELD_IDS, FORM_IMAGE_ID_RE, FORM_IMAGE_V_RE, FORM_LAST_SHEET_IDS, FORM_VALUE_LANGS,
} from './printSettingsCore';
export type { FormColumn, FormColumnId, FormField, FormFieldId, FormImageRef, FormTable, FormValueLang, PrintForm } from './printSettingsCore';

// ─── أدوات داخلية ───

const F = FORM_BOUNDS;
const STEP = LAYOUT_BOUNDS.stepMm;
const EPS = 1e-9;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** أقرب مضاعفٍ لخطوة الشبكة — بلا -0 ولا كسور عائمة */
const snap = (v: number): number => {
  const r = Math.round(Math.round(v / STEP) * STEP * 1000) / 1000;
  return r === 0 ? 0 : r;
};
/** أكبر مضاعفٍ للخطوة لا يتجاوز الحدّ (ولا يقلّ عن 0) */
const floorStep = (v: number): number => Math.max(0, Math.floor(v / STEP + 1e-9) * STEP);
/** أصغر مضاعفٍ للخطوة لا ينقص عن الحدّ */
const ceilStep = (v: number): number => Math.ceil(v / STEP - 1e-9) * STEP;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const isFieldId = (v: unknown): v is FormFieldId => typeof v === 'string' && (FORM_FIELD_IDS as readonly string[]).includes(v);
const isColumnId = (v: unknown): v is FormColumnId => typeof v === 'string' && (FORM_COLUMN_IDS as readonly string[]).includes(v);
const isAlign = (v: unknown): v is FormField['align'] => typeof v === 'string' && (ALIGNS as readonly string[]).includes(v);

/** نصّ JSON بمفاتيح مرتّبة — «هل تغيّر شيء» بلا اعتبارٍ لترتيب المفاتيح */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** التالي إن تغيّر شيء، وإلا السابق نفسه */
const commitForm = (prev: PrintForm, next: PrintForm): PrintForm => (stable(prev) === stable(next) ? prev : next);

const sortFields = (list: FormField[]): FormField[] => list.sort((a, b) => FORM_FIELD_IDS.indexOf(a.id) - FORM_FIELD_IDS.indexOf(b.id));
const sortColumns = (list: FormColumn[]): FormColumn[] => list.sort((a, b) => (a.x - b.x) || (FORM_COLUMN_IDS.indexOf(a.id) - FORM_COLUMN_IDS.indexOf(b.id)));

// ─── الورقة ───

/**
 * ما تبلغه إبرة النقطية من عرض الورقة [x0, x1] بالمم من حافتها اليسرى (formReachX: في الوسط، بلا offsetXmm ولا هوامش) وأصغر
 * مربعٍ لرمز QR عليها (formQrMinMm: 55 مم)
 */
export interface FormReach { x0: number; x1: number; qrMinMm: number }
/**
 * ما يلزم من الورق: عرضه وطوله (null = بلا طول — لا يقبله النموذج، ويُحسب كـA4)، وما تبلغه النقطية منه (reach — الغياب أو null =
 * الورقة كلها كاليوم حرفياً: الطابعة العادية وكل مستدعٍ قديم)
 */
export type FormPaper = Pick<Paper, 'widthMm' | 'lengthMm'> & { reach?: FormReach | null };
export interface FormSheetSize { widthMm: number; lengthMm: number }
/** مرجع المواضع المقترحة: A4 عمودياً — وغيره يُقاس عليه */
export const FORM_REF_SHEET: Readonly<FormSheetSize> = Object.freeze({ widthMm: 210, lengthMm: 297 });

/** مقاس الورقة بالمم — العطب أو غياب الطول ⇒ مقاس A4 */
export function formSheetSize(paper: FormPaper | null | undefined): FormSheetSize {
  const w = paper && fin(paper.widthMm) && paper.widthMm > 0 ? paper.widthMm : FORM_REF_SHEET.widthMm;
  const l = paper && fin(paper.lengthMm) && paper.lengthMm > 0 ? paper.lengthMm : FORM_REF_SHEET.lengthMm;
  return { widthMm: w, lengthMm: l };
}

/** ما تبلغه النقطية من ورق هذا القالب وحدّ رمز QR عليها (formReachX + formQrMinMm من النواة) — null لغير النقطية أو لورقٍ بلا نقاط صالحة */
export function formReachOf(p: Pick<PrintProfile, 'printer' | 'paper'>): FormReach | null {
  const r = p?.paper ? formReachX(p) : null;
  return r ? { x0: r[0], x1: r[1], qrMinMm: formQrMinMm(p.printer) } : null;
}

/** ورق النموذج لقالب: عرضه وطوله وما تبلغه النقطية منه — ما يُمرَّر لكل محرّرٍ هنا (والعادية reach: null فكل شيءٍ كاليوم) */
export function formPaperOf(p: Pick<PrintProfile, 'printer' | 'paper'>): FormPaper {
  return { widthMm: p.paper.widthMm, lengthMm: p.paper.lengthMm, reach: formReachOf(p) };
}

/** دقة صورة النموذج بعد التصحيح والقصّ (A4 = 1240 × 1754 بكسل) */
export const FORM_IMAGE_DPI = 150;
export function formRasterPx(paper: FormPaper | null | undefined): { wPx: number; hPx: number } {
  const s = formSheetSize(paper);
  return { wPx: Math.round((s.widthMm / 25.4) * FORM_IMAGE_DPI), hPx: Math.round((s.lengthMm / 25.4) * FORM_IMAGE_DPI) };
}

/** حجم الخط الأساسي للقيم بالنقطة — يُضرب في fontPct/100 */
export const FORM_BASE_FONT_PT = 11;
export function formFontPt(fontPct?: number | null): number {
  const p = fin(fontPct) ? clamp(fontPct, LAYOUT_BOUNDS.fontPct[0], LAYOUT_BOUNDS.fontPct[1]) : 100;
  return Math.round(FORM_BASE_FONT_PT * p) / 100;
}

export interface FormBox { x: number; y: number; w: number; h: number }

/** الموضع المطبوع: المحفوظ + معايرة الطابعة (dx/dy) — بالمم من ركن الورقة (بجزءٍ من مئة) */
export function printedBox(form: Pick<PrintForm, 'dxMm' | 'dyMm'>, b: FormBox): FormBox {
  const dx = fin(form.dxMm) ? form.dxMm : 0;
  const dy = fin(form.dyMm) ? form.dyMm : 0;
  return { x: round2(b.x + dx), y: round2(b.y + dy), w: b.w, h: b.h };
}

/**
 * ما تبلغه النقطية من المواضع **المحفوظة** (قبل المعايرة): [x0 − dx, x1 − dx] × [−dy, L − dy] مقطوعاً بالورقة — فالموضع المطبوع
 * (printedBox) داخل [x0, x1] × [0, L] كما تفحصه النواة (layoutFormReach). بلا تقريب (حدوده قد تقع بين خطوتي الشبكة؛ المحرّرات تلصق
 * داخلها). null بلا reach (الطابعة العادية: الورقة كلها).
 */
export function formReachBox(form: Pick<PrintForm, 'dxMm' | 'dyMm'>, paper: FormPaper | null | undefined): FormBox | null {
  const r = paper?.reach;
  if (!r || !fin(r.x0) || !fin(r.x1)) return null;
  const S = formSheetSize(paper);
  const dx = fin(form?.dxMm) ? form.dxMm : 0;
  const dy = fin(form?.dyMm) ? form.dyMm : 0;
  const x = Math.max(0, r.x0 - dx);
  const y = Math.max(0, -dy);
  const right = Math.min(S.widthMm, r.x1 - dx);
  const bottom = Math.min(S.lengthMm, S.lengthMm - dy);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** أعلى الصفّ i (من 0) في الجدول — بلا المعايرة */
export function tableRowTop(t: Pick<FormTable, 'y' | 'rowMm'>, i: number): number {
  return round2(t.y + i * t.rowMm);
}

/** مستطيل الجدول كله: من أيسر عمود إلى أيمنه، ومن أول صفٍّ إلى آخره — null بلا أعمدة */
export function formTableBox(t: FormTable | null | undefined): FormBox | null {
  if (!t || !t.columns.length) return null;
  const x = Math.min(...t.columns.map((c) => c.x));
  const right = Math.max(...t.columns.map((c) => c.x + c.w));
  return { x, y: t.y, w: round2(right - x), h: round2(t.rows * t.rowMm) };
}

// ─── الأوراق ───

/** حقول الإجماليات (FORM_LAST_SHEET_IDS) على الورقة الأخيرة وحدها، والرأس يتكرّر في كل ورقة */
export function isLastSheetField(id: FormFieldId): boolean {
  return FORM_LAST_SHEET_IDS.includes(id);
}

/** حقول ورقةٍ بعينها: كلها على الأخيرة، والرأس وحده على ما قبلها */
export function sheetFields(form: Pick<PrintForm, 'fields'>, last: boolean): FormField[] {
  return form.fields.filter((f) => last || !isLastSheetField(f.id));
}

export interface FormSheet<T> {
  /** من 0 */
  index: number;
  count: number;
  first: boolean;
  last: boolean;
  /** أصناف هذه الورقة (rows على الأكثر) */
  items: T[];
  /** ترتيب أول صنفٍ فيها بين أصناف المستند (للتسلسل sr = offset + i + 1) */
  offset: number;
}

/**
 * تقسيم الأصناف على أوراق النموذج: rows صنفاً لكل ورقة (table.rows)، وورقةٌ واحدة على الأقل (مستندٌ بلا أصناف ورقةٌ برأسه
 * وإجمالياته). rows غير صالح (بلا جدول) ⇒ ورقةٌ واحدة بكل الأصناف (لا تُطبع بلا جدول).
 */
export function formSheets<T>(items: readonly T[] | null | undefined, rows: number | null | undefined): Array<FormSheet<T>> {
  const list: T[] = Array.isArray(items) ? items.slice() : [];
  const per = fin(rows) && rows >= 1 ? Math.floor(rows) : 0;
  const count = per > 0 ? Math.max(1, Math.ceil(list.length / per)) : 1;
  const out: Array<FormSheet<T>> = [];
  for (let i = 0; i < count; i++) {
    const offset = per > 0 ? i * per : 0;
    out.push({ index: i, count, first: i === 0, last: i === count - 1, items: per > 0 ? list.slice(offset, offset + per) : list, offset });
  }
  return out;
}

// ─── القصّ داخل الورقة (الشبكة 0.5 مم وحدود النواة) ───

/** أصغر ضلعٍ للحقل: رمز QR 18 مم (55 على ورق النقطية — paper.reach)، وغيره 3 */
export const formFieldMinMm = (id: FormFieldId, paper?: FormPaper | null): number => (id === 'qr' ? (paper?.reach?.qrMinMm ?? F.qrMinMm) : F.fieldMinMm);

/**
 * حدود القصّ: الورقة، وما تبلغه النقطية منها بعد معايرة النموذج (box — null = الورقة كلها كاليوم)، وأصغر مربعٍ لرمز QR. ما يمرّ
 * بالمحرّرات كلها، فلا يخرج منها موضعٌ ترفضه النواة.
 */
interface Frame { S: FormSheetSize; box: FormBox | null; qrMin: number }
const frameOf = (paper: FormPaper | null | undefined, form: Pick<PrintForm, 'dxMm' | 'dyMm'> | null): Frame => ({
  S: formSheetSize(paper),
  box: formReachBox(form ?? { dxMm: 0, dyMm: 0 }, paper),
  qrMin: formFieldMinMm('qr', paper),
});

/**
 * المدى على الشبكة: [x0, x1] × [y0, y1] بمضاعفات 0.5 (للداخل)، وbottom آخر ما يبلغه الجدول بلا تقريب (صفوفه لا تلزم الشبكة).
 * بلا box: الورقة من 0 إلى حافتها (floorStep) — وهو حساب اليوم نفسه (floorStep(W − w) = floorStep(W) − w لعرضٍ على الشبكة).
 */
function gridOf(fr: Frame): { x0: number; x1: number; y0: number; y1: number; bottom: number } {
  const b = fr.box;
  if (!b) return { x0: 0, x1: floorStep(fr.S.widthMm), y0: 0, y1: floorStep(fr.S.lengthMm), bottom: fr.S.lengthMm };
  // ceilStep(0) = −0 (Math.ceil(−1e-9)) — والموضع يُكتب 0 لا −0
  const x0 = ceilStep(b.x) || 0;
  const y0 = ceilStep(b.y) || 0;
  return { x0, x1: Math.max(x0, floorStep(b.x + b.w)), y0, y1: Math.max(y0, floorStep(b.y + b.h)), bottom: b.y + b.h };
}

/** خطٌّ نظيف: عدد صحيح في حدوده، و100 لا يُكتب */
function cleanPct(v: unknown): number | undefined {
  if (!fin(v)) return undefined;
  const p = Math.round(clamp(v, LAYOUT_BOUNDS.fontPct[0], LAYOUT_BOUNDS.fontPct[1]));
  return p === 100 ? undefined : p;
}

/** الحقل داخل الورقة (وعلى النقطية داخل ما تبلغه الإبرة) على الشبكة بأبعاد ≥ حدّه — والقيم الافتراضية (100٪، غير عريض) لا تُكتب */
function clampField(f: FormField, fr: Frame): FormField {
  const g = gridOf(fr);
  const W = g.x1 - g.x0;
  const L = g.y1 - g.y0;
  const min = ceilStep(f.id === 'qr' ? fr.qrMin : F.fieldMinMm);
  const w = clamp(snap(fin(f.w) ? f.w : min), Math.min(min, W), W);
  const h = clamp(snap(fin(f.h) ? f.h : min), Math.min(min, L), L);
  const x = clamp(snap(fin(f.x) ? f.x : 0), g.x0, g.x1 - w);
  const y = clamp(snap(fin(f.y) ? f.y : 0), g.y0, g.y1 - h);
  const out: FormField = { id: f.id, x, y, w, h };
  if (isAlign(f.align)) out.align = f.align;
  const pct = cleanPct(f.fontPct);
  if (pct !== undefined) out.fontPct = pct;
  if (f.bold === true) out.bold = true;
  return out;
}

function clampColumn(c: FormColumn, fr: Frame): FormColumn {
  const g = gridOf(fr);
  const W = g.x1 - g.x0;
  const min = ceilStep(F.columnMinMm);
  const w = clamp(snap(fin(c.w) ? c.w : min), Math.min(min, W), W);
  const x = clamp(snap(fin(c.x) ? c.x : 0), g.x0, g.x1 - w);
  const out: FormColumn = { id: c.id, x, w };
  if (isAlign(c.align)) out.align = c.align;
  return out;
}

/** أعمدةٌ معروفة بلا تكرار، 12 على الأكثر، مقصوصة ومرتّبة من اليسار */
function clampColumns(list: readonly FormColumn[] | null | undefined, fr: Frame): FormColumn[] {
  const seen = new Set<FormColumnId>();
  const out: FormColumn[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !isColumnId(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(clampColumn(c, fr));
    if (out.length >= F.columns[1]) break;
  }
  return sortColumns(out);
}

/** أكثر الصفوف التي تتّسع من y إلى آخر الورقة (≥ 1) — وتتحقّق النتيجة بحدّ النواة نفسه */
function rowsThatFit(y: number, rowMm: number, L: number): number {
  let n = Math.max(1, Math.floor((L - y) / rowMm + 1e-9));
  while (n > 1 && y + n * rowMm > L + EPS) n--;
  return n;
}

/**
 * الجدول داخل الورقة: ارتفاع الصف 3–25 مم (بجزءٍ من مئة)، والصفوف 1–60. keepRows: تحريك الكتلة — الصفوف كما هي وأعلاه يُقصّ؛ وإلا
 * (تغيير الصفوف أو ارتفاعها، أو القصّ العام) يبقى أعلاه وتُقصّ الصفوف إلى ما يتّسع. وعلى النقطية: من أول ما تبلغه الإبرة بعد
 * المعايرة (top) إلى آخره (L − dy).
 */
function clampTable(t: FormTable, fr: Frame, keepRows: boolean): FormTable {
  const g = gridOf(fr);
  const top = g.y0;
  const L = g.bottom;
  const rowMm = round2(clamp(fin(t.rowMm) ? t.rowMm : 7, F.rowMm[0], F.rowMm[1]));
  let rows = clamp(Math.round(fin(t.rows) ? t.rows : 1), F.rows[0], F.rows[1]);
  rows = Math.min(rows, rowsThatFit(top, rowMm, L));
  let y: number;
  if (keepRows) {
    y = clamp(snap(fin(t.y) ? t.y : 0), top, floorStep(L - rows * rowMm));
  } else {
    y = clamp(snap(fin(t.y) ? t.y : 0), top, floorStep(L - rowMm));
    rows = Math.min(rows, rowsThatFit(y, rowMm, L));
  }
  const pct = cleanPct(t.fontPct);
  const columns = clampColumns(t.columns, fr);
  // ترتيب المفاتيح كما كان: y ثم rowMm ثم rows ثم fontPct (إن وُجد) ثم columns
  return pct !== undefined ? { y, rowMm, rows, fontPct: pct, columns } : { y, rowMm, rows, columns };
}

const imageOk = (m: unknown): m is FormImageRef => {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return typeof r.id === 'string' && FORM_IMAGE_ID_RE.test(r.id) && typeof r.v === 'string' && FORM_IMAGE_V_RE.test(r.v)
    && [r.wPx, r.hPx].every((n) => Number.isInteger(n) && (n as number) >= F.imagePx[0] && (n as number) <= F.imagePx[1]);
};
const cleanOffset = (v: unknown): number => (fin(v) ? round1(clamp(v, F.offsetMm[0], F.offsetMm[1])) : 0);

/**
 * نموذجٌ صالحٌ بقواعد النواة على هذا الورق من أيّ مدخل: الحقول المعروفة بلا تكرار (40 على الأكثر) مقصوصةً داخل الورقة على الشبكة،
 * والجدول بأعمدته (والجدول بلا عمودٍ صالح يسقط)، والمعايرة ±20 بعُشر مم، ومرجع الصورة الصالح وحده — بترتيب النواة القانوني.
 * لا يضيف حقل QR: لزومه (ما لم تحذفه الشركة) قاعدةٌ يعرضها المصمّم (formQrMissing).
 * وعلى ورق النقطية (paper.reach): المعايرة تُقصّ أولاً، ثم كل موضعٍ داخل ما تبلغه الإبرة بعدها (formReachBox) ورمز QR ≥ 55 مم،
 * والخلفية false (لا تطبعها النقطية — layoutFormBgImpact).
 */
export function fitForm(form: PrintForm, paper: FormPaper | null | undefined): PrintForm {
  const dxMm = cleanOffset(form?.dxMm);
  const dyMm = cleanOffset(form?.dyMm);
  const fr = frameOf(paper, { dxMm, dyMm });
  const seen = new Set<FormFieldId>();
  const fields: FormField[] = [];
  for (const f of Array.isArray(form?.fields) ? form.fields : []) {
    if (!f || !isFieldId(f.id) || seen.has(f.id)) continue;
    seen.add(f.id);
    fields.push(clampField(f, fr));
    if (fields.length >= F.maxFields) break;
  }
  let table: FormTable | null = null;
  if (form?.table && typeof form.table === 'object') {
    const t = clampTable(form.table, fr, false);
    table = t.columns.length ? t : null;
  }
  const image = imageOk(form?.image) ? { id: form.image.id, v: form.image.v, wPx: form.image.wPx, hPx: form.image.hPx } : null;
  return {
    image,
    dxMm,
    dyMm,
    background: fr.box === null && form?.background === true,
    latinDigits: form?.latinDigits !== false,
    valueLang: form?.valueLang === 'en' ? 'en' : 'ar',
    fields: sortFields(fields),
    table,
  };
}

// ─── البداية المقترحة (مثل نموذج «مروج»: بيانات المستند أعلى، والطرفان، وجدول 23 صفاً، والإجماليات أسفل) ───

/** مواضع A4 العمودي — تُقاس على غيره بنسبة العرض والطول */
const STARTER_FIELDS: readonly FormField[] = Object.freeze([
  { id: 'docTitle', x: 65, y: 36, w: 80, h: 6, align: 'center', bold: true },
  { id: 'docNumber', x: 60, y: 44, w: 90, h: 6, align: 'center' },
  { id: 'docDate', x: 60, y: 51, w: 90, h: 6, align: 'center' },
  { id: 'paymentType', x: 60, y: 58, w: 90, h: 6, align: 'center' },
  { id: 'customerName', x: 140, y: 67, w: 36, h: 6 },
  { id: 'customerAddress', x: 140, y: 74, w: 36, h: 6 },
  { id: 'customerCity', x: 140, y: 81, w: 36, h: 6 },
  { id: 'customerPostal', x: 140, y: 88, w: 36, h: 6 },
  { id: 'sellerName', x: 33, y: 67, w: 50, h: 6 },
  { id: 'sellerAddress', x: 33, y: 74, w: 50, h: 6 },
  { id: 'sellerCity', x: 33, y: 81, w: 50, h: 6 },
  { id: 'sellerPostal', x: 33, y: 88, w: 50, h: 6 },
  { id: 'discount', x: 118, y: 268, w: 40, h: 6, align: 'center' },
  { id: 'totalDue', x: 118, y: 276, w: 40, h: 6, align: 'center', bold: true },
  { id: 'qr', x: 12, y: 268, w: 22, h: 22 },
] as FormField[]);
const STARTER_TABLE: Readonly<FormTable> = Object.freeze({
  y: 105, rowMm: 7, rows: 23,
  columns: [
    { id: 'sr', x: 10, w: 7, align: 'center' },
    { id: 'itemCode', x: 17, w: 18, align: 'center' },
    { id: 'barcode', x: 35, w: 36.5, align: 'center' },
    { id: 'description', x: 71.5, w: 50.5, align: 'start' },
    { id: 'qty', x: 122, w: 9, align: 'center' },
    { id: 'unit', x: 131, w: 19.5, align: 'center' },
    { id: 'unitPrice', x: 150.5, w: 20, align: 'center' },
    { id: 'lineTotal', x: 170.5, w: 29.5, align: 'center' },
  ] as FormColumn[],
});

/**
 * النقطية: جدول البداية بستة عشر صفاً (من 105 إلى 217 مم على A4) ومربع QR بحدّه (55 مم) تحته في الركن الأيسر — فرمز المرحلة
 * الثانية المختوم (حتى 93 خلية) يتّسع بأربع نقاطٍ للخلية ولا يقع على الجدول ولا على الخصم والإجمالي.
 */
const STARTER_IMPACT_ROWS = 16;
const STARTER_IMPACT_QR: Readonly<Pick<FormField, 'x' | 'y'>> = Object.freeze({ x: 12, y: 226 });

/** قياس صندوقٍ بحافّتيه (فتبقى الأعمدة المتلاصقة متلاصقة بعد اللصق بالشبكة) — ثم إزاحته t مم (النقطية؛ 0 لغيرها) */
function scaleSpan(at: number, len: number, k: number, t = 0): [number, number] {
  const a = snap(at * k + t);
  return [a, Math.max(0, snap((at + len) * k + t) - a)];
}

/** قياس حقل (وإزاحته أفقياً tx على النقطية) — ومربع QR بضلعٍ واحد لا يصغر عن حدّه (qrMin: 18، و55 على النقطية) */
function scaleField(f: FormField, sx: number, sy: number, tx = 0, qrMin: number = F.qrMinMm): FormField {
  if (f.id === 'qr') {
    const side = Math.max(qrMin, snap(Math.min(f.w * sx, f.h * sy)));
    return { ...f, x: snap(f.x * sx + tx), y: snap(f.y * sy), w: side, h: side };
  }
  const [x, w] = scaleSpan(f.x, f.w, sx, tx);
  const [y, h] = scaleSpan(f.y, f.h, sy);
  return { ...f, x, y, w, h };
}

function scaleTable(t: FormTable, sx: number, sy: number, tx = 0): FormTable {
  const columns = t.columns.map((c): FormColumn => {
    const [x, w] = scaleSpan(c.x, c.w, sx, tx);
    return { ...c, x, w };
  });
  return { ...t, y: snap(t.y * sy), rowMm: round2(t.rowMm * sy), columns };
}

/**
 * القياس من ورقٍ إلى آخر: بنسبة العرض والطول — وعلى ورق النقطية (to.reach) تُزاح المواضع أفقياً بنصف فرق العرض ولا تُقاس عرضاً:
 * الإبرة تبلغ حزمةً بعرضٍ ثابت في وسط الورقة، فقياس العرض (210 ⇒ 241) يدفع الأطراف خارجها. والطول بنسبته في كلٍّ.
 */
function scaleOf(from: FormSheetSize, to: FormPaper | null | undefined): { sx: number; sy: number; tx: number } {
  const b = formSheetSize(to);
  const sy = b.lengthMm / from.lengthMm;
  return to?.reach ? { sx: 1, sy, tx: (b.widthMm - from.widthMm) / 2 } : { sx: b.widthMm / from.widthMm, sy, tx: 0 };
}

/** جدول البداية (قبل القصّ) على هذا الورق: 23 صفاً بنسبة العرض والطول، و16 مُزاحاً على النقطية */
function starterTable(paper: FormPaper | null | undefined): FormTable {
  const { sx, sy, tx } = scaleOf(FORM_REF_SHEET, paper);
  const base = paper?.reach ? { ...STARTER_TABLE, rows: STARTER_IMPACT_ROWS } : STARTER_TABLE;
  return scaleTable(base as FormTable, sx, sy, tx);
}

/** جدول البداية على هذا الورق (أعمدته الثمانية) */
export function defaultFormTable(paper: FormPaper | null | undefined): FormTable {
  return clampTable(starterTable(paper), frameOf(paper, null), false);
}

/**
 * النموذج المقترح لورقٍ جديد: بيانات المستند أعلى الورقة، والعميل يميناً والبائع يساراً، وجدول أصنافٍ بثمانية أعمدة (23 صفاً
 * من 7 مم على A4 من y = 105)، والخصم والإجمالي أسفل، ورمز QR في الركن الأيسر الأسفل (withQr: false بلا حقله — للشركة التي حذفت
 * الرمز صراحةً). بلا صورةٍ بعد، والمعايرة صفر، وأرقام لاتينية، وقيم عربية. مقيسٌ على غير A4 بنسبة العرض والطول.
 * وعلى ورق النقطية (paper.reach): مواضع A4 مُزاحةً أفقياً بنصف فرق العرض (وسط الورقة حيث الإبرة) ومقيسةً طولاً، والجدول 16 صفاً،
 * ومربع QR بحدّه (55 مم) عند (12، 226) تحت الجدول — صالحةٌ بقواعد النواة الصارمة على كل مقاسٍ نقطي جاهز (ونصف الصفحة ff_95x55
 * يُنزل المربع إلى آخر الورقة بجوار الجدول فيظهر تنبيه التداخل ليعدّله المستخدم).
 */
export function starterForm(paper: FormPaper | null | undefined, opts: { withQr?: boolean } = {}): PrintForm {
  const { sx, sy, tx } = scaleOf(FORM_REF_SHEET, paper);
  const qrMin = formFieldMinMm('qr', paper);
  const withQr = opts.withQr !== false;
  const base = (f: FormField): FormField => (paper?.reach && f.id === 'qr' ? { ...f, ...STARTER_IMPACT_QR, w: qrMin, h: qrMin } : f);
  return fitForm({
    image: null,
    dxMm: 0,
    dyMm: 0,
    background: false,
    latinDigits: true,
    valueLang: 'ar',
    fields: STARTER_FIELDS.filter((f) => withQr || f.id !== 'qr').map((f) => scaleField(base(f), sx, sy, tx, qrMin)),
    table: starterTable(paper),
  }, paper);
}

/** «اقتراح مواضع افتراضية»: مواضع البداية، وتبقى الصورة والمعايرة والخلفية والأرقام ولغة القيم */
export function resetFormPositions(form: PrintForm, paper: FormPaper | null | undefined, opts: { withQr?: boolean } = {}): PrintForm {
  const s = starterForm(paper, opts);
  return commitForm(form, fitForm({ ...s, image: form.image, dxMm: form.dxMm, dyMm: form.dyMm, background: form.background, latinDigits: form.latinDigits, valueLang: form.valueLang }, paper));
}

/**
 * نقل النموذج إلى ورقٍ بمقاسٍ آخر: المواضع بنسبة العرض والطول ثم القصّ داخله (تغيير A4 إلى A5 مثلاً). وعلى ورق النقطية
 * (to.reach): إزاحةٌ أفقية بنصف فرق العرض (ff_a4 ⇒ ff_95x11: +15.5) وقياسٌ طولاً، ومربع QR لا يصغر عن حدّه (55 مم)
 */
export function scaleForm(form: PrintForm, from: FormPaper | null | undefined, to: FormPaper | null | undefined): PrintForm {
  const { sx, sy, tx } = scaleOf(formSheetSize(from), to);
  if (Math.abs(sx - 1) < EPS && Math.abs(sy - 1) < EPS && Math.abs(tx) < EPS) return commitForm(form, fitForm(form, to));
  const qrMin = formFieldMinMm('qr', to);
  return fitForm({ ...form, fields: form.fields.map((f) => scaleField(f, sx, sy, tx, qrMin)), table: form.table ? scaleTable(form.table, sx, sy, tx) : null }, to);
}

// ─── القالب ───

/** نموذج القالب — null لغير تصميم النموذج المطبوع مسبقاً */
export function formOf(p: PrintProfile | null | undefined): PrintForm | null {
  const l = p?.options?.layout;
  return l?.design === 'preprinted' && l.form ? l.form : null;
}

/**
 * كتابة النموذج في القالب (مقصوصاً داخل ورقه، وعلى النقطية داخل ما تبلغه الإبرة بعد المعايرة — formPaperOf) — لتصميم النموذج
 * المطبوع مسبقاً وحده؛ والقالب نفسه إن لم يتغيّر شيء
 */
export function withForm(p: PrintProfile, form: PrintForm): PrintProfile {
  const l = p.options.layout;
  if (!l || l.design !== 'preprinted') return p;
  const next = fitForm(form, formPaperOf(p));
  if (l.form && stable(l.form) === stable(next)) return p;
  return { ...p, options: { ...p.options, layout: { ...l, form: next } } };
}

/** يلزم حقل رمز QR: لا حقل له والشركة لم تحذف الرمز صراحةً (قاعدة النواة layoutFormQrMissing) */
export function formQrMissing(p: PrintProfile | null | undefined): boolean {
  const f = formOf(p);
  return !!f && !isQrRemoved(p?.options.layout) && !f.fields.some((x) => x.id === 'qr');
}

/**
 * رسائل قواعد النواة لمواضع النموذج وحدها (المسار options.layout.form — وغيابها مع تصميمه) بلا تكرار — تمنع الحفظ، فيعرضها المصمّم
 * بجوار «تطبيق». [] لغير تصميم النموذج أو للنموذج السليم.
 */
export function formIssues(p: PrintProfile | null | undefined): string[] {
  if (!p || p.options?.layout?.design !== 'preprinted') return [];
  const out: string[] = [];
  for (const i of layoutIssues(p, 'p')) if (/\.options\.layout\.form(\.|\[|$)/.test(i.path) && !out.includes(i.message)) out.push(i.message);
  return out;
}

// ─── محرّرات المصمّم (نموذجٌ جديد مقصوص، أو النموذج نفسه إن لم يتغيّر شيء) ───

/** الحجم المقترح لحقلٍ جديد */
const FIELD_SIZE: Readonly<Partial<Record<FormFieldId, readonly [number, number]>>> = Object.freeze({
  qr: [22, 22], notes: [90, 12], docTitle: [80, 7],
  customerName: [60, 6], customerBusiness: [60, 6], customerAddress: [70, 6], sellerName: [60, 6], sellerAddress: [70, 6],
  pageNo: [20, 6],
});

const overlaps = (a: FormBox, b: FormBox): boolean =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

/**
 * حقلٌ جديد بحجمه المقترح في أول موضعٍ خالٍ وسط الورقة من أعلاها (لا فوق حقلٍ ولا فوق الجدول) — وإلا أعلى الوسط. وعلى ورق النقطية:
 * وسط ما تبلغه الإبرة بعد معايرة النموذج (dxMm/dyMm إن مُرِّرا)، ومربع QR بحدّه [55، 55]
 */
export function defaultFormField(
  form: Pick<PrintForm, 'fields' | 'table'> & Partial<Pick<PrintForm, 'dxMm' | 'dyMm'>>, paper: FormPaper | null | undefined, id: FormFieldId,
): FormField {
  const S = formSheetSize(paper);
  const fr = frameOf(paper, { dxMm: form.dxMm ?? 0, dyMm: form.dyMm ?? 0 });
  const g = gridOf(fr);
  const [w0, h0]: readonly [number, number] = id === 'qr' && fr.box ? [fr.qrMin, fr.qrMin] : (FIELD_SIZE[id] ?? [45, 6]);
  const w = Math.min(w0, g.x1 - g.x0);
  const h = Math.min(h0, g.y1 - g.y0);
  const x = fr.box ? g.x0 + floorStep((g.x1 - g.x0 - w) / 2) : floorStep((S.widthMm - w) / 2);
  const bottom = fr.box ? g.bottom : S.lengthMm;
  const taken: FormBox[] = form.fields.filter((f) => f.id !== id).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
  const tb = formTableBox(form.table);
  if (tb) taken.push(tb);
  for (let y = Math.max(10, g.y0); y + h <= bottom - 5 + EPS; y += 2) {
    if (!taken.some((b) => overlaps({ x, y, w, h }, b))) return clampField({ id, x, y, w, h }, fr);
  }
  return clampField({ id, x, y: Math.max(10, g.y0), w, h }, fr);
}

/**
 * إضافة حقل أو تعديله: patch يُدمج فوق المحفوظ (أو المقترح لحقلٍ جديد)، وقيمة undefined تحذف مفتاحها (المحاذاة والخط والعريض)،
 * ثم يُلصق بالشبكة ويُقصّ داخل الورقة بحدّه (QR 18 مم، و55 داخل ما تبلغه الإبرة على النقطية). الحقل الحادي والأربعون لا يُضاف.
 */
export function withFormField(form: PrintForm, paper: FormPaper | null | undefined, patch: Partial<FormField> & { id: FormFieldId }): PrintForm {
  if (!patch || !isFieldId(patch.id)) return form;
  const cur = form.fields.find((f) => f.id === patch.id);
  if (!cur && form.fields.length >= F.maxFields) return form;
  const merged: Record<string, unknown> = { ...(cur ?? defaultFormField(form, paper, patch.id)) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const next = clampField(merged as unknown as FormField, frameOf(paper, form));
  const fields = cur ? form.fields.map((f) => (f.id === patch.id ? next : f)) : [...form.fields, next];
  return commitForm(form, { ...form, fields: sortFields(fields) });
}

/** حذف حقل (ومنه حقل QR — لزومه قاعدةٌ يعرضها المصمّم ما لم تحذف الشركة الرمز صراحةً) */
export function withoutFormField(form: PrintForm, id: FormFieldId): PrintForm {
  if (!form.fields.some((f) => f.id === id)) return form;
  return { ...form, fields: form.fields.filter((f) => f.id !== id) };
}

/**
 * تحريك حقلٍ بالمم (x فعلي من اليسار — المصمّم يعكس الأسهم في RTL) أو تغيير حجمه من ركنه الأيمن الأسفل (resize) — داخل الورقة دائماً
 * (وعلى النقطية داخل ما تبلغه الإبرة)
 */
export function moveFormField(form: PrintForm, paper: FormPaper | null | undefined, id: FormFieldId, dxMm: number, dyMm: number, resize = false): PrintForm {
  const f = form.fields.find((x) => x.id === id);
  if (!f) return form;
  const dx = fin(dxMm) ? dxMm : 0;
  const dy = fin(dyMm) ? dyMm : 0;
  if (!resize) return withFormField(form, paper, { id, x: f.x + dx, y: f.y + dy });
  const g = gridOf(frameOf(paper, form));
  // التكبير لا يزيح الحقل: يقف عند حافة الورقة (أو آخر ما تبلغه الإبرة) — floorStep(W − x) = floorStep(W) − x لموضعٍ على الشبكة
  return withFormField(form, paper, { id, w: Math.min(f.w + dx, Math.max(0, g.x1 - f.x)), h: Math.min(f.h + dy, Math.max(0, g.y1 - f.y)) });
}

export type FormTablePatch = Partial<Pick<FormTable, 'y' | 'rowMm' | 'rows' | 'fontPct'>>;

/**
 * جدول الأصناف: null يحذفه (فلا تُطبع الأصناف — مع تنبيه)، وغيره يُدمج فوق المحفوظ أو جدول البداية بأعمدته. تحريكه (y وحده) يُبقي
 * صفوفه ويقصّ أعلاه، وتغيير الصفوف أو ارتفاعها يُبقي أعلاه ويقصّ الصفوف إلى ما يتّسع له الورق. fontPct: undefined يحذفه.
 */
export function withFormTable(form: PrintForm, paper: FormPaper | null | undefined, patch: FormTablePatch | null): PrintForm {
  if (patch === null) return form.table ? { ...form, table: null } : form;
  const base: FormTable = form.table ?? defaultFormTable(paper);
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'columns') continue;
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const moveOnly = 'y' in patch && !('rows' in patch) && !('rowMm' in patch);
  const t = clampTable(merged as unknown as FormTable, frameOf(paper, form), moveOnly);
  if (!t.columns.length) return form;
  return commitForm(form, { ...form, table: t });
}

/** تحريك كتلة الجدول رأسياً بالمم */
export function moveFormTable(form: PrintForm, paper: FormPaper | null | undefined, dyMm: number): PrintForm {
  if (!form.table) return form;
  return withFormTable(form, paper, { y: form.table.y + (fin(dyMm) ? dyMm : 0) });
}

/** العرض المقترح لعمودٍ جديد */
const COLUMN_W: Readonly<Record<FormColumnId, number>> = Object.freeze({
  sr: 8, itemCode: 18, barcode: 30, description: 50, qty: 12, unit: 15, unitPrice: 20, discountPct: 12, vatPct: 12, lineTotal: 25,
});

/**
 * عمودٌ جديد بعرضه المقترح بعد آخر عمودٍ إن اتّسع، وإلا في أول فراغٍ يسعه، وإلا من يسار الورقة — وعلى ورق النقطية داخل ما تبلغه
 * الإبرة بعد المعايرة (offsets: dxMm/dyMm النموذج إن مُرِّرا)
 */
export function defaultFormColumn(
  table: Pick<FormTable, 'columns'> | null | undefined, paper: FormPaper | null | undefined, id: FormColumnId,
  offsets: Pick<PrintForm, 'dxMm' | 'dyMm'> | null = null,
): FormColumn {
  const S = formSheetSize(paper);
  const fr = frameOf(paper, offsets);
  const g = gridOf(fr);
  const w = Math.min(COLUMN_W[id] ?? 15, g.x1 - g.x0);
  const cols = [...(table?.columns ?? [])].filter((c) => c.id !== id).sort((a, b) => a.x - b.x);
  const align: FormColumn['align'] = id === 'description' ? 'start' : 'center';
  const end = cols.length ? Math.max(...cols.map((c) => c.x + c.w)) : Math.max(10, g.x0);
  if (end + w <= (fr.box ? g.x1 : S.widthMm) + EPS) return clampColumn({ id, x: end, w, align }, fr);
  let cursor = g.x0;
  for (const c of cols) {
    if (c.x - cursor >= w - EPS) return clampColumn({ id, x: cursor, w, align }, fr);
    cursor = Math.max(cursor, c.x + c.w);
  }
  return clampColumn({ id, x: g.x0, w, align }, fr);
}

/** إضافة عمود أو تعديله (x وw والمحاذاة) — بلا جدولٍ يُنشأ جدول البداية بهذا العمود وحده؛ والعمود الثالث عشر لا يُضاف */
export function withFormColumn(form: PrintForm, paper: FormPaper | null | undefined, patch: Partial<FormColumn> & { id: FormColumnId }): PrintForm {
  if (!patch || !isColumnId(patch.id)) return form;
  const fr = frameOf(paper, form);
  // جدول البداية يُقصّ بمعايرة هذا النموذج (على النقطية: داخل ما تبلغه الإبرة بعدها) — وعلى العادية هو defaultFormTable نفسه
  const table: FormTable = form.table ?? { ...clampTable(starterTable(paper), fr, false), columns: [] };
  const cur = table.columns.find((c) => c.id === patch.id);
  if (!cur && table.columns.length >= F.columns[1]) return form;
  const merged: Record<string, unknown> = { ...(cur ?? defaultFormColumn(table, paper, patch.id, form)) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const next = clampColumn(merged as unknown as FormColumn, fr);
  const columns = cur ? table.columns.map((c) => (c.id === patch.id ? next : c)) : [...table.columns, next];
  return commitForm(form, { ...form, table: { ...table, columns: sortColumns(columns) } });
}

/** حذف عمود — آخر عمودٍ لا يُحذف (الجدول بلا أعمدة يُحذف كله بـwithFormTable(null)) */
export function withoutFormColumn(form: PrintForm, id: FormColumnId): PrintForm {
  const t = form.table;
  if (!t || !t.columns.some((c) => c.id === id) || t.columns.length <= 1) return form;
  return { ...form, table: { ...t, columns: t.columns.filter((c) => c.id !== id) } };
}

/** تحريك عمودٍ أفقياً بالمم أو تغيير عرضه من حافته اليمنى (resize) — داخل عرض الورقة (وعلى النقطية داخل ما تبلغه الإبرة) */
export function moveFormColumn(form: PrintForm, paper: FormPaper | null | undefined, id: FormColumnId, dxMm: number, resize = false): PrintForm {
  const c = form.table?.columns.find((x) => x.id === id);
  if (!c) return form;
  const dx = fin(dxMm) ? dxMm : 0;
  if (!resize) return withFormColumn(form, paper, { id, x: c.x + dx });
  return withFormColumn(form, paper, { id, w: Math.min(c.w + dx, Math.max(0, gridOf(frameOf(paper, form)).x1 - c.x)) });
}

/**
 * إعادة ترتيب الأعمدة: ينقل العمود إلى الموضع toIndex (من اليسار) ويرصّ الأعمدة متلاصقةً بعروضها من أيسر عمود — فتزول الفراغات
 * بينها (يُعاد ضبطها بالسحب).
 */
export function reorderFormColumn(form: PrintForm, paper: FormPaper | null | undefined, id: FormColumnId, toIndex: number): PrintForm {
  const t = form.table;
  if (!t || !Number.isInteger(toIndex)) return form;
  const cols = [...t.columns].sort((a, b) => a.x - b.x);
  const from = cols.findIndex((c) => c.id === id);
  if (from < 0) return form;
  const to = clamp(toIndex, 0, cols.length - 1);
  if (to === from) return form;
  const order = cols.slice();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  let cursor = cols[0].x;
  const packed = order.map((c) => {
    const o: FormColumn = { ...c, x: cursor };
    cursor += c.w;
    return o;
  });
  return commitForm(form, { ...form, table: { ...t, columns: clampColumns(packed, frameOf(paper, form)) } });
}

export type FormPropsPatch = Partial<Pick<PrintForm, 'image' | 'dxMm' | 'dyMm' | 'background' | 'latinDigits' | 'valueLang'>>;

/** خصائص النموذج: الصورة (مرجعٌ صالح أو null)، والمعايرة ±20 بعُشر مم، والخلفية، والأرقام، ولغة القيم */
export function withFormProps(form: PrintForm, patch: FormPropsPatch): PrintForm {
  const next: PrintForm = { ...form };
  if ('image' in patch) next.image = imageOk(patch.image) ? { id: patch.image.id, v: patch.image.v, wPx: patch.image.wPx, hPx: patch.image.hPx } : null;
  if (patch.dxMm !== undefined) next.dxMm = cleanOffset(patch.dxMm);
  if (patch.dyMm !== undefined) next.dyMm = cleanOffset(patch.dyMm);
  if (typeof patch.background === 'boolean') next.background = patch.background;
  if (typeof patch.latinDigits === 'boolean') next.latinDigits = patch.latinDigits;
  if (patch.valueLang !== undefined && (FORM_VALUE_LANGS as readonly string[]).includes(patch.valueLang)) next.valueLang = patch.valueLang;
  return commitForm(form, next);
}

// ─── التسميات (عربية؛ مترجمة في القاموس — حارس في الاختبار) ───

export const FORM_FIELD_LABELS: Readonly<Record<FormFieldId, string>> = Object.freeze({
  docNumber: 'رقم المستند',
  docDate: 'تاريخ المستند',
  docTime: 'وقت المستند',
  paymentType: 'طريقة الدفع',
  dueDate: 'تاريخ الاستحقاق',
  deliveryDate: 'تاريخ التسليم',
  docTitle: 'عنوان المستند',
  originalRef: 'الفاتورة الأصلية',
  noteReason: 'سبب الإرجاع',
  customerName: 'اسم العميل',
  customerBusiness: 'الاسم التجاري للعميل',
  customerAddress: 'عنوان العميل',
  customerCity: 'مدينة العميل',
  customerPostal: 'الرمز البريدي للعميل',
  customerPhone: 'جوال العميل',
  customerVat: 'الرقم الضريبي للعميل',
  customerCr: 'السجل التجاري للعميل',
  sellerName: 'اسم البائع',
  sellerAddress: 'عنوان البائع',
  sellerCity: 'مدينة البائع',
  sellerPostal: 'الرمز البريدي للبائع',
  sellerPhone: 'هاتف البائع',
  sellerVat: 'الرقم الضريبي للبائع',
  sellerCr: 'السجل التجاري للبائع',
  repName: 'اسم المندوب',
  notes: 'الملاحظات',
  subtotal: 'المجموع قبل الخصم',
  discount: 'الخصم',
  vatAmount: 'ضريبة القيمة المضافة',
  totalDue: 'الإجمالي المستحق',
  paidAmt: 'المدفوع',
  remainingAmt: 'المتبقي',
  pageNo: 'رقم الصفحة',
  qr: 'رمز QR',
});

export const FORM_COLUMN_LABELS: Readonly<Record<FormColumnId, string>> = Object.freeze({
  sr: 'التسلسل',
  itemCode: 'رمز الصنف',
  barcode: 'الباركود',
  description: 'اسم الصنف',
  qty: 'الكمية',
  unit: 'الوحدة',
  unitPrice: 'سعر الوحدة',
  discountPct: 'نسبة الخصم',
  vatPct: 'نسبة الضريبة',
  lineTotal: 'الإجمالي',
});

/** لوحة الحقول في المصمّم: مجموعاتٌ تغطّي FORM_FIELD_IDS كلها مرةً واحدة (حارس في الاختبار) */
export const FORM_FIELD_GROUPS: ReadonlyArray<{ readonly title: string; readonly ids: readonly FormFieldId[] }> = Object.freeze([
  { title: 'بيانات المستند', ids: ['docTitle', 'docNumber', 'docDate', 'docTime', 'paymentType', 'dueDate', 'deliveryDate', 'originalRef', 'noteReason', 'pageNo'] as FormFieldId[] },
  { title: 'العميل', ids: ['customerName', 'customerBusiness', 'customerAddress', 'customerCity', 'customerPostal', 'customerPhone', 'customerVat', 'customerCr'] as FormFieldId[] },
  { title: 'البائع', ids: ['sellerName', 'sellerAddress', 'sellerCity', 'sellerPostal', 'sellerPhone', 'sellerVat', 'sellerCr', 'repName'] as FormFieldId[] },
  { title: 'الإجماليات', ids: ['subtotal', 'discount', 'vatAmount', 'totalDue', 'paidAmt', 'remainingAmt', 'notes', 'qr'] as FormFieldId[] },
]);

export const FORM_VALUE_LANG_LABELS: Readonly<Record<FormValueLang, string>> = Object.freeze({ ar: 'العربية', en: 'الإنجليزية' });

/** حقول وأعمدة الضريبة — لا تُطبع على مستندٍ معفى (isTaxFreePrint) ولا بلا تفصيل ضريبةٍ في قرار الطباعة */
export const FORM_TAX_FIELD_IDS: readonly FormFieldId[] = Object.freeze(['customerVat', 'sellerVat', 'vatAmount'] as FormFieldId[]);
export const FORM_TAX_COLUMN_IDS: readonly FormColumnId[] = Object.freeze(['vatPct'] as FormColumnId[]);

// ─── التنبيهات (لا تمنع الحفظ) ───

export const FORM_WARNINGS = Object.freeze({
  imageMissing: 'لم ترفع صورة النموذج بعد — ارفعها لتضع الحقول على فراغاته بدقة',
  background: 'طباعة الخلفية ترسم صورة النموذج تحت البيانات — للورق الأبيض والتجربة لا للورق المطبوع',
  noTable: 'لا جدول أصناف في النموذج فلا تطبع الأصناف',
  noNumber: 'لا حقل لرقم المستند في النموذج',
  noTotal: 'لا حقل للإجمالي المستحق في النموذج',
  noTitle: 'بلا حقل عنوان المستند تطبع المرتجعات والإشعارات على النموذج كأنها فاتورة',
  overlap: 'بعض الحقول متداخلة فتطبع قيمها فوق بعضها',
});
export const FORM_NOTES = Object.freeze({
  pageNo: 'الأصناف الزائدة عن صفوف الجدول تكمل في ورقة تالية — أضف حقل رقم الصفحة ليظهر 1/2',
  taxFree: 'حقول الضريبة لا تطبع على المستند المعفى من الضريبة',
  // النقطية: أول سطرٍ تطبعه الإبرة يختلف بين الطابعات وطريقة تحميل الورق — فالمعايرة (dx/dy) قبل أول فاتورة
  impactCalibrate: 'اطبع «صفحة معايرة» على ورق النموذج قبل أول فاتورة — أول سطر تطبعه النقطية يختلف بين الطابعات وطريقة تحميل الورق',
  // قرار المالك ١٣ نوفمبر ٢٠٢٦ (س٢): الورق المقطع مقبول للفاتورة الطويلة، والطابعة تنتظر إدخال الورقة التالية يدوياً — مع هذه النصيحة
  impactCutSheet: 'على الورق المقطع تنتظر النقطية إدخال كل ورقة تالية يدويا — للفواتير الطويلة اختر الورق المتصل',
});

/** أزواج الحقول المتداخلة (ومع مستطيل الجدول 'table') — للتنبيه وتلوين المصمّم */
export function formOverlaps(form: Pick<PrintForm, 'fields' | 'table'>): Array<[FormFieldId, FormFieldId | 'table']> {
  const out: Array<[FormFieldId, FormFieldId | 'table']> = [];
  const fs = form.fields;
  const tb = formTableBox(form.table);
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) if (overlaps(fs[i], fs[j])) out.push([fs[i].id, fs[j].id]);
    if (tb && overlaps(fs[i], tb)) out.push([fs[i].id, 'table']);
  }
  return out;
}

/**
 * تنبيهات النموذج (لا تمنع الحفظ) — فارغة لغير تصميمه: بلا صورة، والخلفية مطبوعة، وبلا جدول، وبلا رقم المستند أو الإجمالي أو
 * العنوان (المرتجع على ورق الفاتورة)، وحقولٌ متداخلة. والملاحظات: رقم الصفحة للأوراق المتعددة، وحقول الضريبة على المعفى (ctx.taxFree).
 * وحذف رمز QR الصريح تنبيهه في profileWarnings، ولزوم حقله قاعدةٌ في النواة (formQrMissing).
 * وعلى النقطية (formReachOf): ملاحظة «صفحة المعايرة» أولاً، والورق المقطع بجدولٍ ينصح بالمتصل للفواتير الطويلة — ولا تنبيه خلفية
 * (لا تطبعها النقطية أصلاً: النواة ترفضها والقراءة تُطفئها).
 */
export function formWarnings(p: PrintProfile, ctx: { taxFree?: boolean } = {}): { warnings: string[]; notes: string[] } {
  const f = formOf(p);
  const warnings: string[] = [];
  const notes: string[] = [];
  if (!f) return { warnings, notes };
  const reach = formReachOf(p);
  const ids = new Set(f.fields.map((x) => x.id));
  if (reach) notes.push(FORM_NOTES.impactCalibrate);
  if (reach && p.paper.feed === 'sheet' && f.table) notes.push(FORM_NOTES.impactCutSheet);
  if (!f.image) warnings.push(FORM_WARNINGS.imageMissing);
  if (f.background && !reach) warnings.push(FORM_WARNINGS.background);
  if (!f.table) warnings.push(FORM_WARNINGS.noTable);
  if (!ids.has('docNumber')) warnings.push(FORM_WARNINGS.noNumber);
  if (!ids.has('totalDue')) warnings.push(FORM_WARNINGS.noTotal);
  if (!ids.has('docTitle')) warnings.push(FORM_WARNINGS.noTitle);
  // المعفى (ctx.taxFree): مربع QR لا يُطبع ولا يُرسم في المصمّم (hideQr) — فلا تنبيه تداخلٍ بسببٍ لا يراه المستخدم
  if (formOverlaps(ctx.taxFree ? { ...f, fields: f.fields.filter((x) => x.id !== 'qr') } : f).length) warnings.push(FORM_WARNINGS.overlap);
  if (f.table && !ids.has('pageNo')) notes.push(FORM_NOTES.pageNo);
  const taxCols = f.table?.columns.some((c) => FORM_TAX_COLUMN_IDS.includes(c.id)) ?? false;
  if (ctx.taxFree && (f.fields.some((x) => FORM_TAX_FIELD_IDS.includes(x.id)) || taxCols)) notes.push(FORM_NOTES.taxFree);
  return { warnings, notes };
}
