/**
 * تموضع القائمة المنسدلة المبوَّبة إلى `document.body` — دوالّ صرفة بلا React ولا DOM،
 * تأخذ مستطيل الحقل (`getBoundingClientRect`) ومقاس النافذة وتعيد إحداثيات `position: fixed`.
 *
 * العلّة (قياس المتشكّك على الدفعة أ): قائمة منتقي الحساب كانت `absolute` داخل
 * `div.table-wrapper.overflow-x-auto` في شبكة سطور القيد. و`overflow-x: auto` مع
 * `overflow-y: visible` يحسبه المتصفّح `overflow-y: auto` (مواصفة CSS Overflow: قيمة
 * `visible` تصير `auto` إن كان المحور الآخر غير `visible`)، فصار الحاضن قاصّاً على
 * المحورين: قائمةٌ ارتفاعها ٣٦٦px تُقصّ إلى ١٣٥px على جوال ٤٠٠px وإلى ٢١٥px على ١٢٨٠px،
 * فلا يرى المحاسب إلا رأس «الأصول» وحساباً واحداً ويختفي رأس «المصروفات التشغيلية» خلف
 * القصّ — فتسقط فائدة الدفعة أ («المصروفات من أول نظرة»).
 *
 * ولا يعالجه رفع `overflow` عن الحاضن: يذهب معه التمرير الأفقي لشبكةٍ أعمدتها تبلغ
 * ثمانية على جوال ٤٠٠px. فالعلاج بوّابة (`createPortal`) إلى `document.body` — خارج كل
 * حاضنٍ قاصّ — بإحداثياتٍ تُحسب هنا وتُعاد عند كل تمرير أو تحجيم.
 *
 * الإحداثيات كلّها بإحداثيات **النافذة** لا الصفحة (وهو ما يعيده `getBoundingClientRect`)،
 * فتُستعمل كما هي مع `position: fixed` بلا جمع إزاحات التمرير.
 */

/** ما يلزم من `DOMRect` (يقبل `DOMRect` نفسه بنيوياً). */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

/** مقاس النافذة المرئية (`innerWidth` × `innerHeight`). */
export interface AnchorViewport {
  width: number;
  height: number;
}

export interface AnchorOptions {
  /** اتجاه الكتابة: في RTL تُحاذى القائمة حافة الحقل اليمنى، وفي LTR اليسرى */
  dir?: 'rtl' | 'ltr';
  /** أدنى عرض للقائمة بالبكسل (نظير `min-w-[18rem]`) */
  minWidth?: number;
  /** الارتفاع المرغوب حين تتّسع النافذة: شريط الأنواع + القائمة + شريط العدّاد */
  preferredHeight?: number;
  /** أدنى ارتفاع مقبول في نافذة قصيرة — دونه تصير القائمة سطراً واحداً فتعود العلّة */
  minHeight?: number;
  /** الفراغ بين الحقل والقائمة (نظير `mt-1`) */
  gap?: number;
  /** الهامش المحفوظ من حواف النافذة */
  edge?: number;
}

/**
 * موضع القائمة: عند الفتح تحت الحقل يُضبط `top`، وعند الانقلاب فوقه يُضبط `bottom`
 * — لتبقى ملتصقة بالحقل مهما قصر محتواها الفعليّ عن `maxHeight`. المهمَل منهما `null`.
 */
export interface AnchorPosition {
  placement: 'below' | 'above';
  top: number | null;
  bottom: number | null;
  left: number;
  width: number;
  maxHeight: number;
}

/** 18rem — نفس `min-w-[18rem]` الذي كان على القائمة. */
export const MIN_DROPDOWN_WIDTH = 288;
/** ≈ شريط الأنواع (٣٤) + قائمة `max-h-72` (٢٨٨) + شريط العدّاد (٣٤) + الحدود. */
export const PREFERRED_DROPDOWN_HEIGHT = 384;
/** ثلاثة صفوف على الأقل مع الشريطين — تحت هذا يعود «حسابٌ واحد مرئي». */
export const MIN_DROPDOWN_HEIGHT = 160;
export const DROPDOWN_GAP = 4;
export const DROPDOWN_EDGE = 8;

/** حصر قيمة بين حدّين، مع تغليب الأدنى إن انعكس الحدّان (نافذة أضيق من القائمة). */
export function clampTo(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/** عرض القائمة: عرض الحقل على الأقل، وبحدّ أدنى `minWidth`، ولا يتجاوز عرض النافذة ناقص الهامشين. */
export function dropdownWidth(rect: AnchorRect, viewport: AnchorViewport, opts: AnchorOptions = {}): number {
  const edge = opts.edge ?? DROPDOWN_EDGE;
  const minWidth = opts.minWidth ?? MIN_DROPDOWN_WIDTH;
  const room = Math.max(viewport.width - 2 * edge, 0);
  return Math.min(Math.max(rect.width, minWidth), room);
}

/** الحافة الأفقية: بداية الحقل (يمينه في RTL ويساره في LTR) محصورةً داخل النافذة. */
export function dropdownLeft(rect: AnchorRect, viewport: AnchorViewport, width: number, opts: AnchorOptions = {}): number {
  const edge = opts.edge ?? DROPDOWN_EDGE;
  const dir = opts.dir ?? 'rtl';
  const start = dir === 'rtl' ? rect.right - width : rect.left;
  return clampTo(start, edge, viewport.width - edge - width);
}

/**
 * المحور الرأسي: تحت الحقل ما دامت تتّسع، وإلا فوقه إن كانت المساحة هناك أوسع.
 * وفي نافذةٍ لا تتّسع لأيّهما يُفرض `minHeight` (ما لم تعجز النافذة نفسها) ويُزحزح
 * الموضع ليبقى كلّه داخل النافذة.
 */
export function dropdownVertical(
  rect: AnchorRect,
  viewport: AnchorViewport,
  opts: AnchorOptions = {},
): { placement: 'below' | 'above'; top: number | null; bottom: number | null; maxHeight: number } {
  const gap = opts.gap ?? DROPDOWN_GAP;
  const edge = opts.edge ?? DROPDOWN_EDGE;
  const preferred = opts.preferredHeight ?? PREFERRED_DROPDOWN_HEIGHT;
  const minHeight = opts.minHeight ?? MIN_DROPDOWN_HEIGHT;

  const roomBelow = viewport.height - rect.bottom - gap - edge;
  const roomAbove = rect.top - gap - edge;
  // تحت الحقل هو الأصل؛ ولا تنقلب إلا حين يكون فوقه **أوسع** فعلاً
  const placement: 'below' | 'above' = roomBelow >= preferred || roomBelow >= roomAbove ? 'below' : 'above';

  const room = placement === 'below' ? roomBelow : roomAbove;
  const windowCap = Math.max(viewport.height - 2 * edge, 0);
  const maxHeight = Math.max(Math.min(preferred, Math.max(room, Math.min(minHeight, windowCap))), 0);

  if (placement === 'below') {
    const top = clampTo(rect.bottom + gap, edge, viewport.height - edge - maxHeight);
    return { placement, top, bottom: null, maxHeight };
  }
  // فوق الحقل: نثبّت أسفل القائمة عند أعلى الحقل، ونرفعه إن لزم كي لا يخرج رأسها
  const bottomEdge = clampTo(rect.top - gap, edge + maxHeight, viewport.height - edge);
  return { placement, top: null, bottom: viewport.height - bottomEdge, maxHeight };
}

/** الموضع كاملاً — ما يستعمله المنتقي مباشرةً في `style` القائمة المبوَّبة. */
export function anchorDropdown(rect: AnchorRect, viewport: AnchorViewport, opts: AnchorOptions = {}): AnchorPosition {
  const width = dropdownWidth(rect, viewport, opts);
  const left = dropdownLeft(rect, viewport, width, opts);
  const vertical = dropdownVertical(rect, viewport, opts);
  return { ...vertical, left, width };
}

/**
 * هل ما زال الحقل مرئياً في النافذة؟ القائمة `fixed` لا تتحرّك مع المحتوى، فلو مرّر
 * المستخدم الحقلَ خارج الشاشة بقيت طافيةً بلا مرساة — فتُخفى حتى يعود.
 */
export function anchorVisible(rect: AnchorRect, viewport: AnchorViewport): boolean {
  return rect.bottom > 0 && rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width;
}

/** تساوي موضعين — يمنع إعادة التصيير على كل نبضة تمرير حين لا يتغيّر شيء. */
export function samePosition(a: AnchorPosition | null, b: AnchorPosition | null): boolean {
  if (!a || !b) return a === b;
  return a.placement === b.placement && a.top === b.top && a.bottom === b.bottom
    && a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight;
}

export default anchorDropdown;
