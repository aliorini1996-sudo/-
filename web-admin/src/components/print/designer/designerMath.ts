/**
 * «المصمّم الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦) — هندسة السحب الخالصة: بلا DOM ولا React ولا استيراد تشغيلي (أنواع فقط)،
 * فتُختبر في node مباشرة. منقولة من النموذج الأولي pd_designer_proto.html (§2 GEOMETRY) بوحدات الملّيمتر وإحداثيات مادية
 * (x من الحافة اليسرى لصندوق المحتوى) — واجهة RTL تعكس الأزرار فقط ولا تقلب المخزَّن.
 *
 * الحفظ النهائي يمرّ دائماً بمساعدات designModel (upsertBox/nudgeBox… تقصّ وتلتقط وتفرض حدود الخادم)؛ ما هنا هو القيد الحيّ
 * أثناء السحب كي لا يخرج الإطار عن لوحته بين pointermove وpointerup.
 */
import type { Align, CanvasBand, CanvasBoxId, SectionId } from '../../../lib/print/printSettingsCore';

/** بكسل CSS لكل ملّيمتر (96 نقطة في البوصة) — ثابتٌ فيزيائي كـMM_PX في layout.ts */
export const PX_PER_MM = 96 / 25.4;
/** خطوة الشبكة ومسافة الالتقاط بالملّيمتر */
export const GRID_MM = 0.5;
export const SNAP_TOL_MM = 1.5;
/** حركةٌ أقلّ من هذا (بكسل شاشة) نقرةٌ لا سحب */
export const DRAG_THRESHOLD_PX = 3;
/** مساحة اللمس لكل مقبض (بكسل شاشة): 24 للإصبع (حدّ WCAG 2.5.8)، و12 للفأرة — والمربّع المرئي يبقى صغيراً */
export const handleHitPx = (coarse: boolean): number => (coarse ? 24 : 12);
/** هل المؤشّر الأساسي إصبع (pointer: coarse) — false خارج المتصفح أو عند تعذّر السؤال */
export function isCoarsePointer(): boolean {
  try { return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches; } catch { return false; }
}
/** الشريط الحراري: سحبٌ أفقيّ بهذا القدر يغيّر المحاذاة، وعموديّ بهذا يغيّر الترتيب */
export const ALIGN_THRESHOLD_PX = 24;
export const REORDER_THRESHOLD_PX = 6;

export interface Rect { x: number; y: number; w: number; h: number }
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Handle[]);
export interface Guide { axis: 'x' | 'y'; at: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);
/** تقريبٌ يمحو ذيول الفاصلة العائمة (0.30000000000000004) */
const tidy = (v: number): number => Math.round(v * 1000) / 1000;

/** إزاحة شاشةٍ بالبكسل → ملّيمتر الورقة (المعاينة مصغّرة بـscale) */
export function screenToMm(dPx: number, scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return tidy(fin(dPx) / s / PX_PER_MM);
}
export const mmToScreen = (mm: number, scale: number): number => fin(mm) * PX_PER_MM * (Number.isFinite(scale) && scale > 0 ? scale : 1);

/** الالتقاط إلى الشبكة (0.5 ملم افتراضاً) */
export function snapGrid(v: number, step = GRID_MM): number {
  const s = step > 0 ? step : GRID_MM;
  return tidy(Math.round(fin(v) / s) * s);
}

/** المستطيل بعد سحب مقبضٍ بمقدار dx,dy (ملم) من مستطيل البداية */
export function resizeRect(s: Rect, h: Handle, dx: number, dy: number): Rect {
  let { x, y, w, h: hh } = s;
  if (h.includes('e')) w = s.w + dx;
  if (h.includes('w')) { w = s.w - dx; x = s.x + dx; }
  if (h.includes('s')) hh = s.h + dy;
  if (h.includes('n')) { hh = s.h - dy; y = s.y + dy; }
  return { x: tidy(x), y: tidy(y), w: tidy(w), h: tidy(hh) };
}

export const moveRect = (s: Rect, dx: number, dy: number): Rect => ({ ...s, x: tidy(s.x + dx), y: tidy(s.y + dy) });

/** خطوط الالتقاط: حافتا اللوحة ومنتصفها، وحواف المربعات الأخرى ومنتصفاتها */
export function snapLines(others: readonly Rect[], bandW: number, bandH: number): { xs: number[]; ys: number[] } {
  const xs = [0, bandW / 2, bandW];
  const ys = [0, bandH / 2, bandH];
  for (const o of others) { xs.push(o.x, o.x + o.w / 2, o.x + o.w); ys.push(o.y, o.y + o.h / 2, o.y + o.h); }
  return { xs, ys };
}

function nearest(v: number, arr: readonly number[], tol: number): number | null {
  let best: number | null = null;
  for (const c of arr) if (Math.abs(c - v) <= tol && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
  return best;
}

/**
 * الالتقاط: الشبكة أولاً، ثم خطوط الإرشاد تتقدّم عليها ضمن SNAP_TOL_MM. النقل يحاذي (يسار/وسط/يمين) و(أعلى/وسط/أسفل)؛
 * تغيير الحجم يلتقط الحواف المسحوبة وحدها. يعيد المستطيل وخطوط الإرشاد الظاهرة.
 */
export function snapRect(b: Rect, h: Handle | null, others: readonly Rect[], bandW: number, bandH: number, tol = SNAP_TOL_MM): { rect: Rect; guides: Guide[] } {
  const L = snapLines(others, bandW, bandH);
  const guides: Guide[] = [];
  let { x, y, w, h: hh } = b;
  if (!h) {
    x = snapGrid(x); y = snapGrid(y);
    let best: { d: number; v: number; g: number } | null = null;
    for (const off of [0, w / 2, w]) {
      const c = nearest(b.x + off, L.xs, tol);
      if (c !== null && (!best || Math.abs(c - b.x - off) < best.d)) best = { d: Math.abs(c - b.x - off), v: c - off, g: c };
    }
    if (best) { x = best.v; guides.push({ axis: 'x', at: best.g }); }
    best = null;
    for (const off of [0, hh / 2, hh]) {
      const c = nearest(b.y + off, L.ys, tol);
      if (c !== null && (!best || Math.abs(c - b.y - off) < best.d)) best = { d: Math.abs(c - b.y - off), v: c - off, g: c };
    }
    if (best) { y = best.v; guides.push({ axis: 'y', at: best.g }); }
  } else {
    const edge = (val: number, arr: readonly number[], axis: 'x' | 'y'): number => {
      const c = nearest(val, arr, tol);
      if (c !== null) { guides.push({ axis, at: c }); return c; }
      return snapGrid(val);
    };
    if (h.includes('e')) w = edge(x + w, L.xs, 'x') - x;
    if (h.includes('w')) { const nx = edge(x, L.xs, 'x'); w += x - nx; x = nx; }
    if (h.includes('s')) hh = edge(y + hh, L.ys, 'y') - y;
    if (h.includes('n')) { const ny = edge(y, L.ys, 'y'); hh += y - ny; y = ny; }
  }
  return { rect: { x: tidy(x), y: tidy(y), w: tidy(w), h: tidy(hh) }, guides };
}

export interface RectLimits { bandH: number; contentW: number; minW: number; minH: number }

/**
 * القيد الحيّ: المستطيل داخل اللوحة (0 ≤ x، x+w ≤ عرض المحتوى، 0 ≤ y، y+h ≤ ارتفاع اللوحة) ولا يصغر عن الحدّ الأدنى.
 * مع مقبض تبقى الحافة المقابلة ثابتة (السحب من اليسار لا يزحزح الحافة اليمنى)؛ ومع النقل يبقى المقاس ويُزاح الموضع.
 */
export function constrainRect(r: Rect, lim: RectLimits, h: Handle | null = null): Rect {
  const W = Math.max(0, fin(lim.contentW));
  const H = Math.max(0, fin(lim.bandH));
  const minW = Math.min(Math.max(0, fin(lim.minW)), W);
  const minH = Math.min(Math.max(0, fin(lim.minH)), H);
  let x = fin(r.x); let y = fin(r.y); let w = fin(r.w, minW); let hh = fin(r.h, minH);
  if (!h) {
    w = clamp(w, minW, W); hh = clamp(hh, minH, H);
    x = clamp(x, 0, W - w); y = clamp(y, 0, H - hh);
  } else {
    let left = x; let right = x + w; let top = y; let bottom = y + hh;
    if (h.includes('w')) { right = clamp(right, minW, W); left = clamp(left, 0, right - minW); }
    else if (h.includes('e')) { left = clamp(left, 0, W - minW); right = clamp(right, left + minW, W); }
    else { w = clamp(w, minW, W); left = clamp(left, 0, W - w); right = left + w; }
    if (h.includes('n')) { bottom = clamp(bottom, minH, H); top = clamp(top, 0, bottom - minH); }
    else if (h.includes('s')) { top = clamp(top, 0, H - minH); bottom = clamp(bottom, top + minH, H); }
    else { hh = clamp(hh, minH, H); top = clamp(top, 0, H - hh); bottom = top + hh; }
    x = left; w = right - left; y = top; hh = bottom - top;
  }
  return { x: tidy(x), y: tidy(y), w: tidy(w), h: tidy(hh) };
}

/** أصغر مقاسٍ لمربع: QR لا يصغر تحت حدّ القراءة، وغيره تحت boxMinMm */
export const boxMinMm = (id: CanvasBoxId, boxMin: number, qrMin: number): number => (id === 'qr' ? Math.max(boxMin, qrMin) : boxMin);

/** هل يُسمح بالمربع في اللوحة — الإجماليات والتوقيعات بعد الأصناف (التذييل وحده) */
export const bandAllows = (id: CanvasBoxId, band: CanvasBand, footerOnly: readonly CanvasBoxId[]): boolean =>
  band === 'footer' || !footerOnly.includes(id);

/** لوحة المفاتيح على مربع: الأسهم 0.5 ملم، Shift ×10 (5 ملم)، Alt = تغيير الحجم بدل النقل. الاتجاه ماديّ دائماً */
export function keyDelta(key: string, mods: { shiftKey?: boolean; altKey?: boolean }): { dx: number; dy: number; resize: boolean } | null {
  const step = mods.shiftKey ? 5 : GRID_MM;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const v = d[key];
  if (!v) return null;
  return { dx: v[0], dy: v[1], resize: mods.altKey === true };
}

/** ارتفاع لوحةٍ بعد سحب مقبضها: ملتقط إلى الشبكة، بين أدنى ما تتسعه مربعاتها وحدّها، ومجموع اللوحتين ضمن السقف */
export function bandHeightFromDrag(h0: number, dyMm: number, lim: { min: number; max: number; other: number; total: number }): number {
  const hi = Math.max(0, Math.min(lim.max, lim.total - Math.max(0, fin(lim.other))));
  const lo = Math.min(Math.max(0, lim.min), hi);
  return snapGrid(clamp(fin(h0) + fin(dyMm), lo, hi));
}

interface BandBoxLike { band: CanvasBand; y: number; h: number }
interface CanvasLike { headerMm: number; footerMm: number; boxes: readonly BandBoxLike[] }

/**
 * حدود ارتفاع لوحة: لا تقصر عن أطول مربعاتها، ولا تتجاوز حدّها ولا سقف المجموع، ومجموع اللوحتين ضمن السقف. bounds بسقف ورق
 * القالب (canvasBoundsFor في designModel: A5 150، ونصف الصفحة المتصلة 89.5، وA4 200) فيقف المقبض عند ما يقبله الخادم.
 */
export function bandLimits(c: CanvasLike, band: CanvasBand, bounds: { headerMm: readonly [number, number]; footerMm: readonly [number, number]; bandsTotalMm: number }):
  { min: number; max: number; other: number; total: number } {
  const tallest = c.boxes.filter((b) => b.band === band).reduce((m, b) => Math.max(m, fin(b.h)), 0);
  const range = band === 'header' ? bounds.headerMm : bounds.footerMm;
  return { min: Math.max(range[0], tallest), max: Math.min(range[1], bounds.bandsTotalMm), other: band === 'header' ? fin(c.footerMm) : fin(c.headerMm), total: bounds.bandsTotalMm };
}

/** بعد تقصير لوحة: مربعاتها تُرفع حتى تبقى داخلها (y + h ≤ الارتفاع) */
export function fitBoxesToBand<T extends BandBoxLike>(boxes: readonly T[], band: CanvasBand, hMm: number): T[] {
  return boxes.map((b) => (b.band === band && b.y + b.h > hMm ? { ...b, y: tidy(Math.max(0, hMm - b.h)) } : b));
}

// ─── الشريط الحراري (بُعدٌ واحد) ───

/** موضع الإدراج من y المؤشّر ومنتصفات الكتل (من الأعلى) */
export function indexFromY(mids: readonly number[], y: number): number {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}

/**
 * الفهرس الذي يُمرَّر لـmoveSection(p, id, toIndex) ليقع القسم قبل beforeId (null = آخر الترتيب) —
 * moveSection يحذف القسم ثم يدرجه بفهرسٍ في الترتيب بعد الحذف.
 */
export function moveIndexBefore(order: readonly SectionId[], id: SectionId, beforeId: SectionId | null): number | null {
  if (!order.includes(id)) return null;
  const rest = order.filter((s) => s !== id);
  if (beforeId === null) return rest.length;
  const at = rest.indexOf(beforeId);
  return at < 0 ? null : at;
}

/** المحاذاة المنطقية ← نسبة مركز الكتلة من الحافة اليسرى (RTL: البداية يمين) */
const ALIGN_RATIO: Readonly<Record<Align, number>> = Object.freeze({ start: 0.8, center: 0.5, end: 0.2 });
export function alignFromRatio(r: number): Align {
  return r > 0.62 ? 'start' : r < 0.38 ? 'end' : 'center';
}

/** محاذاةٌ جديدة من سحبٍ أفقيّ — null ما لم يبلغ السحب العتبة أو لم تتغيّر */
export function alignFromDrag(cur: Align, dxPx: number, stripPx: number, threshold = ALIGN_THRESHOLD_PX): Align | null {
  if (!(stripPx > 0) || Math.abs(fin(dxPx)) < threshold) return null;
  const next = alignFromRatio(ALIGN_RATIO[cur] + dxPx / stripPx);
  return next === cur ? null : next;
}

/** الأسهم الأفقية تنقل المحاذاة مادّياً: يسار ← وسط ← يمين (البداية في RTL) */
export function stepAlign(cur: Align, key: 'ArrowLeft' | 'ArrowRight'): Align {
  const physical: readonly Align[] = ['end', 'center', 'start'];
  const i = physical.indexOf(cur) + (key === 'ArrowRight' ? 1 : -1);
  return physical[clamp(i, 0, 2)];
}

/**
 * حجم الشعار من سحب مقبضه: المقبض على الجهة الحرّة (شعارٌ يميناً ⇒ مقبضه يساراً فالسحب يساراً يكبّره)، والموسَّط يكبر من
 * جهتيه (×2). ملتقط إلى 0.5 ملم وضمن الحدود.
 */
export function logoMmFromDrag(mm0: number, align: Align, dxPx: number, pxPerMm: number, bounds: readonly [number, number]): number {
  const k = align === 'center' ? 2 : 1;
  const sign = align === 'start' ? -1 : 1;
  const ppm = pxPerMm > 0 ? pxPerMm : PX_PER_MM;
  return snapGrid(clamp(fin(mm0, bounds[0]) + (sign * k * fin(dxPx)) / ppm, bounds[0], bounds[1]));
}

/** «−/+» على الشعار: 1 ملم ضمن الحدود */
export const logoMmStep = (mm: number, dir: 1 | -1, bounds: readonly [number, number]): number => snapGrid(clamp(fin(mm, bounds[0]) + dir, bounds[0], bounds[1]));

/** كتلةٌ في الشريط كما قيست من iframe المعاينة (بكسل داخل الوثيقة) */
export interface StripBlock { sel: string; top: number; height: number }

/**
 * مكان كتلة الشعار المستقلة بعد إفلاتها عند y: داخل الترويسة ⇒ null (الشعار داخل الرأس كاليوم)، قبل أول قسم ⇒ 'top'،
 * وإلا بعد القسم الذي فوق نقطة الإفلات. blocks = الأقسام المرسومة بترتيبها (بلا كتلة الشعار).
 */
export function logoAfterFromDrop(blocks: readonly StripBlock[], y: number, headerId: SectionId = 'header'): SectionId | 'top' | null {
  const secs = blocks.filter((b) => b.sel !== 'logo');
  if (!secs.length) return 'top';
  const head = secs.find((b) => b.sel === headerId);
  if (head && y >= head.top && y <= head.top + head.height) return null;
  const i = indexFromY(secs.map((b) => b.top + b.height / 2), y);
  if (i === 0) return 'top';
  return secs[i - 1].sel as SectionId;
}

// ─── سجلّ التراجع والإعادة (50 خطوة) ───

export const HISTORY_MAX = 50;
export interface History<T> { past: T[]; cur: T; future: T[] }

/** خطوةٌ جديدة: الحالية إلى الماضي (بسقف max) والمستقبل يُمحى — والمساوية للحالية (same) لا تُكتب */
export function pushHistory<T>(h: History<T>, next: T, same: (a: T, b: T) => boolean = Object.is, max = HISTORY_MAX): History<T> {
  if (same(next, h.cur)) return h;
  const past = [...h.past, h.cur];
  return { past: past.length > max ? past.slice(past.length - max) : past, cur: next, future: [] };
}
export function undoHistory<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), cur: h.past[h.past.length - 1], future: [h.cur, ...h.future] };
}
export function redoHistory<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.cur], cur: h.future[0], future: h.future.slice(1) };
}
