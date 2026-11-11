/**
 * «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — هندسة السحب الخالصة لمصمّم النموذج: التحديد، والقيد الحيّ لصناديق
 * الحقول وأعمدة الجدول وكتلته أثناء السحب (قبل الالتزام). بلا DOM ولا React فتُختبر في node.
 *
 * الإحداثيات ملّيمترات من الركن الأيسر الأعلى الفعلي للورقة (x يميناً مهما كان اتجاه الواجهة). الالتزام النهائي يمرّ دائماً بمحرّرات
 * formModel (withFormField/withFormColumn/withFormTable… تلصق بالشبكة وتقصّ داخل الورقة) — ما هنا هو ما يُرسم بين pointermove
 * وpointerup كي لا يخرج الإطار عن الورقة، بهندسة المصمّم الحرّ نفسها (designerMath).
 */
import { SNAP_TOL_MM, constrainRect, moveRect, resizeRect, snapGrid, snapRect, type Guide, type Handle, type Rect } from '../designer/designerMath';
import {
  FORM_BOUNDS, formFieldMinMm, formTableBox,
  type FormColumnId, type FormFieldId, type FormSheetSize, type PrintForm,
} from '../../../lib/print/formModel';

// ─── التحديد ───

/** العنصر المحدَّد في المصمّم: حقل، أو كتلة الجدول، أو عمودٌ منه (null = لا شيء: خصائص النموذج ولوحة الحقول) */
export type FormSel = `field:${FormFieldId}` | 'table' | `col:${FormColumnId}`;

export const fieldSel = (id: FormFieldId): FormSel => `field:${id}`;
export const columnSel = (id: FormColumnId): FormSel => `col:${id}`;
export const selField = (s: FormSel | null | undefined): FormFieldId | null => (typeof s === 'string' && s.startsWith('field:') ? (s.slice(6) as FormFieldId) : null);
export const selColumn = (s: FormSel | null | undefined): FormColumnId | null => (typeof s === 'string' && s.startsWith('col:') ? (s.slice(4) as FormColumnId) : null);

/**
 * التحديد ما دام عنصره موجوداً في النموذج (بعد تراجعٍ أو حذفٍ أو «اقتراح مواضع افتراضية») — وإلا null فلا يبقى المفتّش على عنصرٍ غائب
 */
export function liveSel(form: Pick<PrintForm, 'fields' | 'table'> | null, s: FormSel | null): FormSel | null {
  if (!form || !s) return null;
  const f = selField(s);
  if (f) return form.fields.some((x) => x.id === f) ? s : null;
  const c = selColumn(s);
  if (c) return form.table?.columns.some((x) => x.id === c) ? s : null;
  return s === 'table' && form.table ? s : null;
}

// ─── الحقول ───

const tidy = (v: number): number => Math.round(v * 1000) / 1000;
const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** خطوط الالتقاط لحقلٍ مسحوب: الحقول الأخرى ومستطيل الجدول (يلتصق الحقل بحوافّها ومنتصفاتها) */
export function fieldSnapOthers(form: Pick<PrintForm, 'fields' | 'table'>, id: FormFieldId): Rect[] {
  const out: Rect[] = form.fields.filter((f) => f.id !== id).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
  const tb = formTableBox(form.table);
  if (tb) out.push(tb);
  return out;
}

/**
 * مستطيل الحقل الحيّ أثناء السحب: النقل أو تغيير الحجم من المقبض، ثم الالتقاط (الشبكة 0.5 وحواف الحقول الأخرى والجدول وحافّتا
 * الورقة ومنتصفها ضمن 1.5 مم)، ثم القيد داخل الورقة بحدّ الحقل الأدنى (3 مم، ورمز QR ‏18).
 */
export function fieldDragRect(start: Rect, h: Handle | null, dxMm: number, dyMm: number, others: readonly Rect[], sheet: FormSheetSize, id: FormFieldId): { rect: Rect; guides: Guide[] } {
  const raw = h ? resizeRect(start, h, fin(dxMm), fin(dyMm)) : moveRect(start, fin(dxMm), fin(dyMm));
  const s = snapRect(raw, h, others, sheet.widthMm, sheet.lengthMm);
  const min = formFieldMinMm(id);
  return { rect: constrainRect(s.rect, { bandH: sheet.lengthMm, contentW: sheet.widthMm, minW: min, minH: min }, h), guides: s.guides };
}

// ─── أعمدة الجدول (شرائط رأسية: x وw وحدهما) ───

export type ColumnEdge = 'move' | 'w' | 'e';
export interface Span { x: number; w: number }

/** أقرب خطٍّ ضمن المسافة (أو null) */
function nearest(v: number, lines: readonly number[], tol: number): number | null {
  let best: number | null = null;
  for (const c of lines) if (Math.abs(c - v) <= tol && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
  return best;
}

/**
 * شريط العمود الحيّ أثناء السحب: النقل (العرض ثابت) أو تحريك الحافة اليسرى (w) أو اليمنى (e) والحافة المقابلة ثابتة. الحافة
 * المسحوبة تلتصق بحواف الأعمدة الأخرى وحافّتي الورقة ضمن 1.5 مم (فتبقى الأعمدة متلاصقة)، وإلا بالشبكة 0.5. داخل عرض الورقة
 * ولا يضيق عن 4 مم. guide: الخطّ الذي التصق به (للرسم) أو null.
 */
export function columnDragSpan(start: Span, edge: ColumnEdge, dxMm: number, others: readonly Span[], widthMm: number, tol = SNAP_TOL_MM): Span & { guide: number | null } {
  const W = Math.max(0, fin(widthMm));
  const min = Math.min(FORM_BOUNDS.columnMinMm, W);
  const dx = fin(dxMm);
  const lines = [0, W];
  for (const o of others) lines.push(o.x, o.x + o.w);
  const snapEdge = (v: number): { v: number; g: number | null } => {
    const c = nearest(v, lines, tol);
    return c !== null ? { v: c, g: c } : { v: snapGrid(v), g: null };
  };
  if (edge === 'move') {
    const w = clamp(fin(start.w, min), min, W);
    const x0 = start.x + dx;
    const l = nearest(x0, lines, tol);
    const r = nearest(x0 + w, lines, tol);
    let x: number;
    let guide: number | null = null;
    if (l !== null && (r === null || Math.abs(l - x0) <= Math.abs(r - (x0 + w)))) { x = l; guide = l; }
    else if (r !== null) { x = r - w; guide = r; }
    else x = snapGrid(x0);
    const cx = clamp(x, 0, W - w);
    return { x: tidy(cx), w: tidy(w), guide: cx === x ? guide : null };
  }
  const left0 = fin(start.x);
  const right0 = left0 + fin(start.w, min);
  if (edge === 'e') {
    const left = clamp(left0, 0, W - min);
    const s = snapEdge(right0 + dx);
    const right = clamp(s.v, left + min, W);
    return { x: tidy(left), w: tidy(right - left), guide: right === s.v ? s.g : null };
  }
  const right = clamp(right0, min, W);
  const s = snapEdge(left0 + dx);
  const left = clamp(s.v, 0, right - min);
  return { x: tidy(left), w: tidy(right - left), guide: left === s.v ? s.g : null };
}

// ─── كتلة الجدول ───

/** أعلى الجدول الحيّ أثناء سحبه رأسياً: ملتقطٌ إلى 0.5 مم، وصفوفه كلها داخل الورقة */
export function tableDragY(y0: number, dyMm: number, rows: number, rowMm: number, lengthMm: number): number {
  const hi = Math.max(0, Math.floor((fin(lengthMm) - rows * rowMm) / 0.5 + 1e-9) * 0.5);
  return clamp(snapGrid(fin(y0) + fin(dyMm)), 0, hi);
}

/**
 * ارتفاع الصف من سحب مقبض أسفل الجدول: حافة آخر صفٍّ تتبع المؤشّر فيُقسم الارتفاع الكلّي على الصفوف (دقّة 0.01 مم — يطابق آخر
 * سطرٍ في النموذج بعد مطابقة أوله)، بين 3 و25 مم ولا يتجاوز آخر صفٍّ طول الورقة.
 */
export function rowMmFromDrag(rowMm0: number, rows: number, y: number, dyMm: number, lengthMm: number): number {
  const n = Math.max(1, Math.round(fin(rows, 1)));
  const [lo, hi0] = FORM_BOUNDS.rowMm;
  const fit = Math.floor(((fin(lengthMm) - fin(y)) / n) * 100 + 1e-9) / 100;
  const hi = Math.max(lo, Math.min(hi0, fit));
  const v = (n * fin(rowMm0, lo) + fin(dyMm)) / n;
  return clamp(Math.round(v * 100) / 100, lo, hi);
}

/** الأسهم على مقبض ارتفاع الصف: ↑↓ ‏0.1 مم، وShift ‏1 مم (null لغيرهما) */
export function rowMmKeyDelta(key: string, shift: boolean): number | null {
  const step = shift ? 1 : 0.1;
  return key === 'ArrowDown' ? step : key === 'ArrowUp' ? -step : null;
}

/**
 * touch-action لصندوق حقلٍ أو شريط عمود (كشرائح المصمّم الحرّ — RollStrip.stripTouchAction): الصناديق والجدول يغطّون معظم الورقة، فلو
 * حبست كلها اللمس لما مُرِّرت اللوحة بالإصبع — pan-y قبل التحديد (الإصبع يمرّر، والنقرة تحدّد)، وnone بعده (السحب). والعمود يُسحب
 * أفقياً وحده فيبقى pan-y دائماً (التمرير الرأسي فوقه لا يمنع سحبه الأفقي)
 */
export const formTouchAction = (selected: boolean, horizontalOnly = false): 'none' | 'pan-y' => (selected && !horizontalOnly ? 'none' : 'pan-y');

/** إصبعٌ على عنصرٍ غير محدَّد: تمريرٌ أو نقرة تحديد — لا سحب (الفأرة والقلم يسحبان دائماً) */
export const touchMayDrag = (pointerType: string | undefined, selected: boolean): boolean => pointerType !== 'touch' || selected;

/** ارتفاع الصف بالأسهم أو من حقل المفتّش: مقيّدٌ بما يُبقي عدد الصفوف كما هو (كالسحب — rowMmFromDrag) لا يُنقصه بصمت */
export const rowMmCapped = (rowMm: number, rows: number, y: number, lengthMm: number): number => rowMmFromDrag(rowMm, rows, y, 0, lengthMm);

/** حجم خط القيمة على الشاشة بالبكسل: نقاط الطباعة (11 × النسبة) ← بكسل CSS × مقياس المعاينة */
export const ptToScreenPx = (pt: number, scale: number): number => fin(pt) * (96 / 72) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
