/**
 * الرسم النقطيّ للطباعة المباشرة بالبلوتوث — «إعدادات الطباعة» M3 (التصميم §3.3 الخطوات 1–4، §3.5).
 *
 * لماذا صورةٌ لا نصّ: العربية لا تُرسل للطابعة نصّاً أبداً — CP864 صفحة ترميز بصرية الترتيب ناقصة الأشكال. فالقالب نفسه
 * يُرسم بمحرّك Chrome (التشكيل والاتجاه صحيحان، المحرّك نفسه الذي يصنع ملف PDF اليوم) ثم يصير أبيض وأسود بنقاط الطابعة.
 *
 * الخطوات:
 *  1. الهندسة مرّة: العنصر بعرضه الفعليّ، ومقياس الالتقاط = نقاط الحزمة ÷ عرضه بالبكسل — فعمود الصورة = إبرة/نقطة رأس.
 *  2. الالتقاط بـhtml2canvas بعد جهوزية الخطوط، على قطعٍ بارتفاعٍ محدود (حدود canvas في أندرويد)، كلّ قطعةٍ بعدد صفوفٍ صحيح.
 *  3. عتبة ثابتة (160) بلا تنقيط عشوائي (dithering): القوالب أحادية اللون أصلاً، والتنقيط يجعل الحرف رذاذاً على الإبرية.
 *  4. رمز QR **يُعاد رسمه** لا يُلتقط: الصورة المكبّرة أو المصغّرة تكسر حدود خلاياه. كل خانة `data-qr-value` تُمسح ثم يُرسم
 *     الرمز من `QRCode.create` بعددٍ صحيح من النقاط لكل خلية (الحد الأدنى لكل دقة من qrPlan لا ينزل) وفي منتصف خانته
 *     بمنطقة صامتة خليتين على الأقل. والقيمة من الخانة كما وضعها القالب من القرار الضريبي — هنا رسمٌ فقط، لا بناء رمز.
 *
 * حارس (e) في printGuards.test.ts: هذا الملف لا يستدعي `QRCode.toDataURL` أبداً، ولا يرسم رمزاً إلا من `QRCode.create`.
 *
 * والتقسيم إلى صفحات (§3.5): الصفوف القابلة للطباعة في الصفحة = (الطول − الهامشين) × النقاط/مم، والقطع عند آخر صفٍّ أبيض
 * كاملٍ في الـ12 مم التي فوق الحدّ — فلا ينقسم سطرٌ نصفين، ولا يُقطع رمز QR أبداً — وسطر «صفحة n من m» يُرسم على الصورة.
 */
import QRCode from 'qrcode';
import html2canvas from 'html2canvas';
import { PRINT_WARNINGS, QR_DOTS_PER_CELL, dotsPerMm, qrDotsPerCell, type PrinterDpi, type QrSize } from './printSettings';
import { PrintRefusedError } from './printErrors';

// ─── الصورة أحادية اللون ───

/** صورة نقطة/بت: 1 = أسود، والبت الأعلى أوّلاً (يسار) — هي صيغة GS v 0 نفسها، وصفّها ceil(العرض÷8) بايتاً */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly rowBytes: number;
  readonly data: Uint8Array;
}

/** عتبة السطوع (0–255): أغمق منها أسود. ثابتة لا تتكيّف — النتيجة نفسها على كل جهاز وكل مرة */
export const MONO_THRESHOLD = 160;
/** أقصى صفوف القطعة الواحدة في الالتقاط — دون حدود canvas في جوالات أندرويد (المساحة لا البعد وحده) */
export const MAX_CHUNK_ROWS = 2048;
/** نافذة البحث عن صفٍّ أبيض فوق حدّ الصفحة (§3.5) */
export const PAGE_CUT_SEARCH_MM = 12;

export function createBitmap(width: number, height: number): Bitmap {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const rowBytes = Math.ceil(w / 8);
  return { width: w, height: h, rowBytes, data: new Uint8Array(rowBytes * h) };
}

export function dotAt(bm: Bitmap, x: number, y: number): 0 | 1 {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return 0;
  return ((bm.data[y * bm.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) as 0 | 1;
}

/** مستطيل أسود أو أبيض — يُقصّ على حدود الصورة (لا يكتب بتّاً خارج العرض: الحشوة تبقى صفراً) */
export function fillRect(bm: Bitmap, x: number, y: number, w: number, h: number, on: boolean): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(bm.width, Math.round(x + w));
  const y1 = Math.min(bm.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * bm.rowBytes;
    for (let xx = x0; xx < x1; xx++) {
      const i = row + (xx >> 3);
      const m = 0x80 >> (xx & 7);
      if (on) bm.data[i] |= m; else bm.data[i] &= ~m & 0xff;
    }
  }
}

/** RGBA ⇒ نقاط: السطوع (0.299/0.587/0.114) على خلفية بيضاء (الشفاف أبيض)، وما دون العتبة أسود */
export function monoFromRgba(rgba: ArrayLike<number>, width: number, height: number, threshold = MONO_THRESHOLD): Bitmap {
  const bm = createBitmap(width, height);
  const t = threshold * 1000;
  for (let y = 0; y < bm.height; y++) {
    const row = y * bm.rowBytes;
    for (let x = 0; x < bm.width; x++) {
      const i = (y * width + x) * 4;
      const lum = 299 * rgba[i] + 587 * rgba[i + 1] + 114 * rgba[i + 2];
      const a = rgba[i + 3];
      // over white: 255 − a/255 × (255 − lum)
      const onWhite = 255000 - (a * (255000 - lum)) / 255;
      if (onWhite < t) bm.data[row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bm;
}

export function rowBlank(bm: Bitmap, y: number): boolean {
  const at = y * bm.rowBytes;
  for (let i = 0; i < bm.rowBytes; i++) if (bm.data[at + i] !== 0) return false;
  return true;
}

/** أوّل عمود وآخر عمود فيهما حبرٌ في الصفوف [y0, y1) — null للشريط الأبيض */
export function inkColumns(bm: Bitmap, y0: number, y1: number): [number, number] | null {
  const acc = new Uint8Array(bm.rowBytes);
  for (let y = Math.max(0, y0); y < Math.min(bm.height, y1); y++) {
    const at = y * bm.rowBytes;
    for (let i = 0; i < bm.rowBytes; i++) acc[i] |= bm.data[at + i];
  }
  let first = -1;
  let last = -1;
  for (let i = 0; i < acc.length; i++) {
    if (!acc[i]) continue;
    if (first < 0) first = i * 8 + Math.clz32(acc[i]) - 24;
    last = i * 8 + 7 - (31 - Math.clz32(acc[i] & -acc[i]));
  }
  return first < 0 ? null : [first, Math.min(last, bm.width - 1)];
}

export function sliceRows(bm: Bitmap, y0: number, y1: number): Bitmap {
  const a = Math.max(0, Math.min(bm.height, y0));
  const b = Math.max(a, Math.min(bm.height, y1));
  return { width: bm.width, height: b - a, rowBytes: bm.rowBytes, data: bm.data.slice(a * bm.rowBytes, b * bm.rowBytes) };
}

/** صورٌ بعرضٍ واحد فوق بعضها (صفحةٌ وتحتها سطر ترقيمها) — والأقصر طولاً تُكمَّل بصفوف بيضاء بلا إزاحة */
export function stackRows(...parts: Bitmap[]): Bitmap {
  const width = Math.max(0, ...parts.map((p) => p.width));
  const out = createBitmap(width, parts.reduce((s, p) => s + p.height, 0));
  let y = 0;
  for (const p of parts) {
    for (let r = 0; r < p.height; r++) out.data.set(p.data.subarray(r * p.rowBytes, r * p.rowBytes + Math.min(p.rowBytes, out.rowBytes)), (y + r) * out.rowBytes);
    y += p.height;
  }
  return out;
}

/** تكملة الصورة بصفوف بيضاء حتى طولٍ معلوم */
export function padRows(bm: Bitmap, height: number): Bitmap {
  if (bm.height >= height) return bm;
  return stackRows(bm, createBitmap(bm.width, height - bm.height));
}

/**
 * إزاحة الحزمة يميناً بأعمدة بيضاء (إزاحة المعايرة على الحرارية) — والعرض بعدها لا يتجاوز maxWidth: ما زاد يُنقص من الإزاحة
 * لا من المحتوى. للحرارية يُقرّب العرض لمضاعف 8 (بايت كامل لكل صفّ في GS v 0).
 */
export function shiftRight(bm: Bitmap, cols: number, maxWidth = Infinity, multipleOf = 1): Bitmap {
  const room = Math.max(0, Math.floor(maxWidth) - bm.width);
  const pad = Math.max(0, Math.min(Math.floor(cols), room));
  if (pad === 0) return bm;
  let width = bm.width + pad;
  if (multipleOf > 1) width = Math.min(Math.max(bm.width, Math.floor(maxWidth)), Math.ceil(width / multipleOf) * multipleOf);
  const out = createBitmap(width, bm.height);
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      if (!dotAt(bm, x, y)) continue;
      const xx = x + pad;
      if (xx < width) out.data[y * out.rowBytes + (xx >> 3)] |= 0x80 >> (xx & 7);
    }
  }
  return out;
}

// ─── التقسيم إلى صفحات (§3.5) ───

/**
 * حدود الصفحات [بداية، نهاية) — كلٌّ بحدّ rowsPerPage صفّاً. القطع عند آخر صفٍّ أبيض كامل في نافذة searchRows فوق الحدّ
 * (يبقى الصفّ الأبيض آخرَ الصفحة)، ولا يقع داخل مدى محفوظ (رمز QR بمنطقته الصامتة). وبلا صفٍّ أبيض: فوق الرمز إن عبر الحدّ،
 * وإلا عند الحدّ نفسه. وأوّل الصفحة التالية يتخطّى الصفوف البيضاء — فيبدأ المحتوى عند هامشها العلوي.
 */
export function splitPages(bm: Bitmap, rowsPerPage: number, searchRows: number, keep: ReadonlyArray<readonly [number, number]> = []): Array<[number, number]> {
  const per = Math.max(1, Math.floor(rowsPerPage));
  const splits = (c: number) => keep.some(([a, b]) => a < c && c < b);
  const pages: Array<[number, number]> = [];
  let start = 0;
  while (start < bm.height) {
    if (bm.height - start <= per) { pages.push([start, bm.height]); break; }
    const limit = start + per;
    let cut = -1;
    for (let y = limit - 1; y >= Math.max(start + 1, limit - Math.max(0, Math.floor(searchRows))); y--) {
      if (rowBlank(bm, y) && !splits(y + 1)) { cut = y + 1; break; }
    }
    if (cut < 0) {
      const crossing = keep.find(([a, b]) => a < limit && b > limit);
      cut = crossing && crossing[0] > start ? crossing[0] : limit;
    }
    pages.push([start, cut]);
    start = cut;
    while (start < bm.height && rowBlank(bm, start)) start++;
  }
  return pages;
}

export interface RasterPage {
  bitmap: Bitmap;
  /** صفوف رموز QR في هذه الصفحة (بمنطقتها الصامتة) — النقطية تطبعها في اتجاهٍ واحد (ESC U 1) */
  qrRows: Array<[number, number]>;
}

/**
 * صفحات المستند: rowsPerPage = null (رول) ⇒ صفحة واحدة بطول المحتوى. وإن تعدّدت الصفحات فلكلٍّ سطر ترقيمٍ في أسفل مساحتها
 * (الصفحة تُكمَّل بالأبيض حتى موضعه) — `label(n, m)` يرسمه (canvas في المتصفح)، وnull بلا ترقيم.
 */
export function paginate(
  bm: Bitmap, qrRows: ReadonlyArray<readonly [number, number]>, rowsPerPage: number | null, searchRows: number,
  label?: (n: number, m: number) => Bitmap | null,
): RasterPage[] {
  const all = qrRows.map(([a, b]) => [a, b] as [number, number]);
  if (rowsPerPage === null) return [{ bitmap: bm, qrRows: all }];
  // الورق: البياض في ذيل القالب (حشوته وحدّه الأدنى للطول) لا يفتح صفحةً ثانية — المُرمِّز يكمل الورقة أو يخرجها بنفسه
  let ink = bm.height;
  while (ink > 0 && rowBlank(bm, ink - 1)) ink--;
  if (ink <= rowsPerPage) return [{ bitmap: ink < bm.height ? sliceRows(bm, 0, ink) : bm, qrRows: all }];
  const probe = label?.(1, 1) ?? null;
  const labelRows = probe ? probe.height : 0;
  const contentRows = Math.max(1, rowsPerPage - labelRows);
  const ranges = splitPages(sliceRows(bm, 0, ink), contentRows, searchRows, all);
  return ranges.map(([a, b], i) => {
    const content = sliceRows(bm, a, b);
    const strip = labelRows ? label?.(i + 1, ranges.length) ?? null : null;
    const bitmap = strip ? stackRows(padRows(content, contentRows), strip) : content;
    const rows = all.filter(([qa, qb]) => qb > a && qa < b).map(([qa, qb]) => [Math.max(0, qa - a), Math.min(b, qb) - a] as [number, number]);
    return { bitmap, qrRows: rows };
  });
}

// ─── رمز QR بنقاط صحيحة ───

export type QrEc = 'L' | 'M' | 'Q' | 'H';
export interface QrMatrix { size: number; get(row: number, col: number): number | boolean }
export interface DotRect { x: number; y: number; w: number; h: number }
/** خانة رمز في الصورة: القيمة كما وضعها القالب (من القرار الضريبي) ومستوى التصحيح وموضعها بالنقاط */
export interface QrSlotRef { value: string; ec: QrEc; rect: DotRect }

/** المنطقة الصامتة داخل الحزمة: خليتان على كل جانب (§3.4 «(الخلايا + 4) × النقاط ≤ الحزمة») */
export const QR_QUIET_CELLS = 2;
/** سماحٌ لتقريب مقاس الخانة (مم ⇒ بكسل ⇒ نقاط) — خانةٌ بُنيت للمقاس تماماً لا تنزل بسببه درجة */
export const SLOT_SLACK_DOTS = 2;

/** نقاط الخلية في خانة: المطلوب ثم نزولاً حتى الحدّ الأدنى — null إن لم يتسع حتى بالأدنى (الطباعة تُرفض) */
export function slotDotsPerCell(cells: number, rect: DotRect, bandDots: number, want: number, min: number): number | null {
  const room = Math.min(Math.min(rect.w, rect.h) + SLOT_SLACK_DOTS, bandDots);
  for (let d = want; d >= min; d--) if ((cells + 2 * QR_QUIET_CELLS) * d <= room) return d;
  return null;
}

/**
 * يمسح الخانة (ومربّع الرمز بمنطقته الصامتة إن جاوزها) ثم يرسم الخلايا d×d نقطة في منتصفها — لا تحجيم بعد الرسم.
 * يعيد موضع الرمز (بلا المنطقة الصامتة).
 */
export function drawQr(bm: Bitmap, m: QrMatrix, rect: DotRect, d: number): { x: number; y: number; side: number } {
  const side = m.size * d;
  const quiet = QR_QUIET_CELLS * d;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x = clamp(Math.round(rect.x + (rect.w - side) / 2), quiet, Math.max(quiet, bm.width - side - quiet));
  const y = clamp(Math.round(rect.y + (rect.h - side) / 2), 0, Math.max(0, bm.height - side));
  fillRect(bm, rect.x, rect.y, rect.w, rect.h, false);
  fillRect(bm, x - quiet, y - quiet, side + 2 * quiet, side + 2 * quiet, false);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) if (m.get(r, c)) fillRect(bm, x + c * d, y + r * d, d, d, true);
  }
  return { x, y, side };
}

/**
 * كل خانات الصورة: رمزٌ من QRCode.create على القيمة كما هي، بنقاط «تلقائي/كبير» للدقة ونزولاً حتى حدّها الأدنى إن ضاقت
 * الخانة — وإن لم يتسع حتى بالأدنى تُرفض الطباعة (PDF يبقى). يعيد صفوف كل رمز بمنطقته الصامتة.
 */
export function applyQrSlots(bm: Bitmap, slots: readonly QrSlotRef[], q: { dpi: PrinterDpi; size: QrSize }): Array<[number, number]> {
  const min = QR_DOTS_PER_CELL[q.dpi].min;
  const want = qrDotsPerCell(q.dpi, q.size);
  return slots.map((s) => {
    const m = QRCode.create(s.value, { errorCorrectionLevel: s.ec }).modules;
    const d = slotDotsPerCell(m.size, s.rect, bm.width, want, min);
    if (d === null) throw new PrintRefusedError(PRINT_WARNINGS.qrNoFit);
    const at = drawQr(bm, m, s.rect, d);
    const quiet = QR_QUIET_CELLS * d;
    return [Math.max(0, at.y - quiet), Math.min(bm.height, at.y + at.side + quiet)] as [number, number];
  });
}

// ─── الالتقاط في المتصفح ───

/** يصبّ صفوف قطعةٍ ملتقطة في الصورة الكاملة عند صفّها */
function pasteRows(into: Bitmap, part: Bitmap, atRow: number): void {
  const n = Math.min(into.rowBytes, part.rowBytes);
  for (let r = 0; r < part.height; r++) {
    const y = atRow + r;
    if (y < 0 || y >= into.height) continue;
    into.data.set(part.data.subarray(r * part.rowBytes, r * part.rowBytes + n), y * into.rowBytes);
  }
}

const EC_LEVELS: readonly QrEc[] = ['L', 'M', 'Q', 'H'];

/**
 * يلتقط عنصراً بعرض `widthDots` نقطة بالضبط: المقياس = النقاط ÷ عرضه بالبكسل، فكل مم في القالب = نقاط الدقة لكل مم.
 * القطع بحدود صفوفٍ صحيحة (القطعة k تبدأ من الصفّ k×R) فلا سطرٌ مكرّر ولا فجوة بيضاء بين قطعتين. ويعيد خانات QR بمواضعها.
 */
export async function captureElement(el: HTMLElement, widthDots: number): Promise<{ bitmap: Bitmap; slots: QrSlotRef[] }> {
  try { await el.ownerDocument.fonts?.ready; } catch { /* خطّ النظام */ }
  const box = el.getBoundingClientRect();
  const cssW = box.width;
  const cssH = Math.max(el.scrollHeight, box.height);
  if (!(cssW > 0) || !(cssH > 0)) throw new Error('raster: empty element');
  const scale = widthDots / cssW;
  const rows = Math.ceil(cssH * scale - 1e-6);
  const bitmap = createBitmap(widthDots, rows);
  for (let r0 = 0; r0 < rows; r0 += MAX_CHUNK_ROWS) {
    const n = Math.min(MAX_CHUNK_ROWS, rows - r0);
    const canvas = await html2canvas(el, {
      scale, backgroundColor: '#ffffff', logging: false, useCORS: true,
      // +ε: floor(البعد × المقياس) في html2canvas لا يخسر صفّاً أو عموداً بخطأ الفاصلة العائمة
      x: 0, y: r0 / scale, width: cssW + 1e-6, height: n / scale + 1e-6,
    });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!ctx || canvas.width === 0 || canvas.height === 0) throw new Error('raster: canvas');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pasteRows(bitmap, monoFromRgba(img.data, canvas.width, canvas.height), r0);
  }
  const slots: QrSlotRef[] = Array.from(el.querySelectorAll<HTMLElement>('[data-qr-value]')).flatMap((s) => {
    const value = s.getAttribute('data-qr-value') ?? '';
    if (!value) return [];
    const ecRaw = (s.getAttribute('data-qr-ec') || 'M').toUpperCase() as QrEc;
    const r = s.getBoundingClientRect();
    return [{
      value,
      ec: EC_LEVELS.includes(ecRaw) ? ecRaw : 'M',
      rect: { x: (r.left - box.left) * scale, y: (r.top - box.top) * scale, w: r.width * scale, h: r.height * scale },
    }];
  });
  return { bitmap, slots };
}

/** سطر نصّ قصير مرسوماً بـcanvas (تشكيل Chrome للعربية) — لترقيم الصفحات */
export function textStrip(text: string, widthDots: number, heightDots: number): Bitmap {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(widthDots));
  c.height = Math.max(1, Math.floor(heightDots));
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  ctx.font = `700 ${Math.round(c.height * 0.72)}px Tahoma, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.fillText(text, c.width / 2, c.height / 2);
  return monoFromRgba(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
}

/** ارتفاع سطر الترقيم: 3 مم نصّاً ومثلها فاصلاً فوقه */
export function pageLabelRows(dpi: PrinterDpi): { gap: number; text: number } {
  const dpm = dotsPerMm(dpi);
  return { gap: Math.round(3 * dpm), text: Math.round(3 * dpm) };
}
