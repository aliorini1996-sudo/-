/**
 * «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦) — المصمّم بالسحب لقوالب الصفحة (A4/A5/Letter والنقطية، التصميم القياسي):
 * ورقةٌ = لوحة «رأس الورقة» الحرّة، ثم سريان الأقسام المعتاد (الأصناف والملاحظة والأقساط دائماً تسري)، ثم لوحة «التذييل».
 *
 * · المكوّن يُرسم داخل جذر الورقة (RepDocuments.tsx يملكه ويضع عليه data-print-canvas) فأصل الإحداثيات حافة صندوق المحتوى
 *   **اليسرى المادية** داخل حشوة الورقة. left/top بالبكسل من resolveCanvas (lib/print/layout.ts) — و«left» فيزيائية في CSS
 *   مهما كان الاتجاه، فالإحداثي المخزّن يبقى مادياً وواجهة RTL وحدها تعكس الأزرار.
 * · كل لوحة position:relative بارتفاعٍ صريح ومربعاتها absolute داخلها — لا بالنسبة للورقة: شريط ورقة التجربة يُدرج أوّل
 *   الورقة (printPage.ts) فيُزيح اللوحة كلها معاً. وتحمل data-section="canvas-…" فلا تُقطع في الـPDF/الطباعة/النقطية.
 * · مربعات النصّ overflow:hidden (يقصّ المتصفح وhtml2canvas سواء، والمصمّم ينبّه). مربع QR لا يُقصّ أبداً، وخلفيته بيضاء
 *   ويُرسم آخر لوحته فوق كل نصٍّ متداخل، وكتلته (InvoiceQrBlock) تبقى بسماتها data-qr-value/data-qr-ec فتعيد النقطية رسمه.
 * · أنماطٌ مضمّنة فقط، بلا zoom ولا filter ولا object-fit (html2canvas 1.4.1). حجم خطّ المربع (fontPct) يطبّقه باني الكتلة
 *   بـfontPx(px, canvasBoxLook(box)) — لا هنا: قوالب الورقة أحجامها px مضمّنة لا ترث.
 * · data-pd (للمصمّم) لا يظهر إلا داخل PrintDesignPreviewContext.
 */
import { Fragment, createElement, type CSSProperties, type ReactNode } from 'react';
import type { Align, CanvasBand, CanvasBoxId } from '../lib/print/printSettingsCore';
import type { CanvasBandR, CanvasBoxR, ResolvedCanvas, SectionLook } from '../lib/print/layout';
import { pdProps, usePrintDesignPreview, type PrintDesignPreview } from './printDesignContext';

export interface PrintCanvasSheetProps {
  canvas: ResolvedCanvas;
  /** كتلة كل مربع (يبنيها RepDocuments.tsx). مربعٌ بلا كتلة لا يُرسم في الطباعة (وفي المصمّم إطارٌ فارغ قابل للتحديد) */
  blocks: Partial<Record<CanvasBoxId, ReactNode>>;
  /** الأقسام السارية بين اللوحتين (الأصناف وما لم يوضع في لوحة) */
  flow: ReactNode;
  /** اتجاه الورقة لترجمة المحاذاة إلى جهة مادية — start = يمين الورقة في RTL */
  dir?: 'rtl' | 'ltr';
}

const fin = (n: number): number => (Number.isFinite(n) ? n : 0);

/** المحاذاة المنطقية → جهة مادية (start = يمين في RTL) */
export function physicalAlign(a: Align | null | undefined, dir: 'rtl' | 'ltr' = 'rtl'): 'left' | 'center' | 'right' {
  if (a === 'center') return 'center';
  if (a === 'end') return dir === 'rtl' ? 'left' : 'right';
  return dir === 'rtl' ? 'right' : 'left';
}

/** مظهر قسمٍ مكافئ لمربعٍ (لِـfontPx في باني الكتلة): محاذاته وخطّه، بلا مسافات */
export function canvasBoxLook(b: Pick<CanvasBoxR, 'align' | 'fontPct'>): SectionLook {
  return { visible: true, align: b.align ?? null, fontPct: Number.isFinite(b.fontPct) ? b.fontPct : 100, spaceBeforeMm: 0, spaceAfterMm: 0 };
}

/** ضلع رمز QR المربّع داخل مربعه = min(w,h) بالبكسل — null إن لم يوضع مربع QR في لوحة (فيسري مع الإجماليات) */
export function canvasQrSidePx(c: ResolvedCanvas | null): number | null {
  if (!c) return null;
  for (const band of [c.header, c.footer]) {
    const b = band?.boxes.find((x) => x.id === 'qr');
    if (b) return Math.min(fin(b.px.width), fin(b.px.height));
  }
  return null;
}

/** عقدةٌ دنيا تكفي لقياس الفيض (DOM حقيقي في المصمّم، ومزيّف في الاختبار) */
interface MeasurableBox { getAttribute(name: string): string | null; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number }
interface BoxQueryRoot { querySelectorAll(sel: string): ArrayLike<MeasurableBox> | Iterable<MeasurableBox> }

/** مربعات النصّ التي فاض نصّها عن إطارها (المصمّم يضع عليها شارة تنبيه، لا خطأ) — QR لا يُقصّ فلا يُعدّ */
export function canvasOverflowIds(root: BoxQueryRoot): CanvasBoxId[] {
  const out: CanvasBoxId[] = [];
  for (const el of Array.from(root.querySelectorAll('[data-canvas-box]') as ArrayLike<MeasurableBox>)) {
    const id = el.getAttribute('data-canvas-box') as CanvasBoxId | null;
    if (!id || id === 'qr') continue;
    if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(id);
  }
  return out;
}

function boxStyle(b: CanvasBoxR, dir: 'rtl' | 'ltr'): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute', left: fin(b.px.left), top: fin(b.px.top), width: fin(b.px.width), height: fin(b.px.height),
    boxSizing: 'border-box', margin: 0,
  };
  if (b.id === 'qr') {
    // يتوسّطه رمزٌ مربّع، لا قصّ، وخلفية بيضاء فوق أي نصٍّ متداخل
    return { ...base, overflow: 'visible', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', zIndex: 1 };
  }
  const ta = physicalAlign(b.align, dir);
  if (b.id === 'logo') {
    // الصورة max-width/max-height 100% (باني الكتلة) — تُحاذى أفقياً وتتوسّط عمودياً، بلا object-fit
    return { ...base, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: ta === 'center' ? 'center' : ta === 'left' ? 'flex-start' : 'flex-end', direction: 'ltr' };
  }
  return { ...base, overflow: 'hidden', textAlign: ta };
}

/** QR آخر لوحته (يُرسم فوق ما يتداخل معه)، والباقي الأكبر مساحةً أولاً فيعلو الأصغر (كالشعار على بيانات المستند) كما في
 * المصمّم — ومتساوي المساحة بترتيبه المعياري (الفرز ثابت) */
const area = (b: CanvasBoxR): number => b.w * b.h;
const paintOrder = (boxes: readonly CanvasBoxR[]): CanvasBoxR[] =>
  [...boxes.filter((b) => b.id !== 'qr').sort((a, b) => area(b) - area(a)), ...boxes.filter((b) => b.id === 'qr')];

function Band({ band, blocks, dir, ctx }: { band: CanvasBandR; blocks: PrintCanvasSheetProps['blocks']; dir: 'rtl' | 'ltr'; ctx: PrintDesignPreview | null }): JSX.Element {
  const which: CanvasBand = band.band;
  const style: CSSProperties = { position: 'relative', height: fin(band.hPx), breakInside: 'avoid', pageBreakInside: 'avoid' };
  const boxes = paintOrder(band.boxes)
    .filter((b) => blocks[b.id] != null || ctx)
    .map((b) => createElement('div', { key: b.id, 'data-canvas-box': b.id, style: boxStyle(b, dir), ...pdProps(ctx, `box:${b.id}`) }, blocks[b.id] ?? null));
  return createElement('div', {
    'data-section': `canvas-${which}`,
    ...(which === 'header' ? { 'data-copy-anchor': '' } : {}),
    style,
    ...pdProps(ctx, `band:${which}`),
  }, ...boxes);
}

/**
 * لوحة الرأس (data-section="canvas-header" + data-copy-anchor فيُدرج وسم النسخة بعدها) ← السريان ← لوحة التذييل
 * (data-section="canvas-footer"، بعد آخر صنف، كاملةً لا تُقطع). لوحةٌ ارتفاعها 0 غائبة (null في resolveCanvas).
 */
export function PrintCanvasSheet({ canvas, blocks, flow, dir = 'rtl' }: PrintCanvasSheetProps): JSX.Element {
  const ctx = usePrintDesignPreview();
  return createElement(Fragment, null,
    canvas.header ? createElement(Band, { band: canvas.header, blocks, dir, ctx }) : null,
    flow,
    canvas.footer ? createElement(Band, { band: canvas.footer, blocks, dir, ctx }) : null,
  );
}
