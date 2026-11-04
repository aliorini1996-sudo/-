/**
 * «المصمّم الحرّ» — سحبٌ بأحداث المؤشّر الأصلية (فأرة وإصبع وقلم) بلا مكتبة، على نمط SignaturePad وDailyReportCanvas:
 * pointerdown ← setPointerCapture (داخل try/catch) ← pointermove مخنوقٌ بـrequestAnimationFrame ← الالتزام عند pointerup
 * وحده وفقط إن تحرّك المؤشّر فوق العتبة (3 بكسل) — فالنقرة تختار ولا تكتب سجلّ تراجع؛ وpointercancel أو Esc يُرجع ما كان.
 *
 * المنطق في createDragTracker (أحداثٌ اصطناعية {pointerId, clientX, clientY}) فيُختبر في node بلا DOM؛ والخطّاف غلافٌ رقيق.
 */
import { useCallback, useEffect, useRef } from 'react';
import { DRAG_THRESHOLD_PX } from './designerMath';

export interface DragPoint { pointerId: number; clientX: number; clientY: number }

export interface DragSpec {
  /** حركةٌ تجاوزت العتبة: الإزاحة من نقطة البدء بالبكسل (حيّة، بلا كتابة) */
  onMove?(dx: number, dy: number): void;
  /** الإفلات بعد حركة: الالتزام (update مرّة واحدة) */
  onCommit?(dx: number, dy: number): void;
  /** إلغاء (pointercancel أو Esc) بعد حركة: يُرجع الحالة الحيّة */
  onCancel?(): void;
  /** إفلاتٌ بلا حركة: نقرة (تحديد) */
  onClick?(): void;
  /** العتبة بالبكسل (الافتراضي 3) */
  threshold?: number;
}

export interface DragTracker {
  down(p: DragPoint): void;
  move(p: DragPoint): void;
  up(p: DragPoint): void;
  cancel(p?: DragPoint): void;
  /** يُفرغ الحركة المؤجّلة (rAF) فوراً */
  flush(): void;
  readonly active: boolean;
  readonly moved: boolean;
}

/**
 * آلة حالة السحب. schedule يؤجّل onMove (rAF في المتصفح، فوريٌّ في الاختبار) فتُدمج حركاتٌ كثيرة في إطارٍ واحد.
 * مؤشّرٌ آخر (إصبعٌ ثانٍ) يُتجاهل حتى ينتهي الأول.
 */
export function createDragTracker(spec: DragSpec, schedule: (f: () => void) => void = (f) => f()): DragTracker {
  const threshold = spec.threshold ?? DRAG_THRESHOLD_PX;
  let id: number | null = null;
  let x0 = 0; let y0 = 0; let dx = 0; let dy = 0;
  let moved = false;
  let pending = false;
  const emit = (): void => {
    if (!pending) return;
    pending = false;
    if (id !== null && moved) spec.onMove?.(dx, dy);
  };
  const reset = (): void => { id = null; moved = false; pending = false; dx = 0; dy = 0; };
  return {
    down(p) {
      if (id !== null) return;
      id = p.pointerId; x0 = p.clientX; y0 = p.clientY; dx = 0; dy = 0; moved = false; pending = false;
    },
    move(p) {
      if (id === null || p.pointerId !== id) return;
      dx = p.clientX - x0; dy = p.clientY - y0;
      if (!moved && Math.hypot(dx, dy) > threshold) moved = true;
      if (!moved || pending) return;
      pending = true;
      schedule(emit);
    },
    up(p) {
      if (id === null || p.pointerId !== id) return;
      dx = p.clientX - x0; dy = p.clientY - y0;
      if (!moved && Math.hypot(dx, dy) > threshold) moved = true;
      const wasMoved = moved; const fdx = dx; const fdy = dy;
      reset();
      if (wasMoved) spec.onCommit?.(fdx, fdy);
      else spec.onClick?.();
    },
    cancel(p) {
      if (id === null || (p && p.pointerId !== id)) return;
      const wasMoved = moved;
      reset();
      if (wasMoved) spec.onCancel?.();
    },
    flush: emit,
    get active() { return id !== null; },
    get moved() { return moved; },
  };
}

interface PointerLike extends DragPoint {
  button?: number;
  pointerType?: string;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * الخطّاف: begin(e, spec) في onPointerDown لأي مقبض. المستمعون على window (يعملون ولو فشل الالتقاط)، وEsc يلغي السحب
 * ويوقف انتشاره فلا يُغلق المصمّم نفسه. يُنظَّف كل شيء عند الإفلات أو إزالة المكوّن.
 */
export function usePointerDrag(): (e: PointerLike, spec: DragSpec) => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanupRef.current?.(); cleanupRef.current = null; }, []);
  return useCallback((e: PointerLike, spec: DragSpec) => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    cleanupRef.current?.();
    let raf = 0;
    const schedule = (f: () => void): void => {
      if (typeof requestAnimationFrame === 'undefined') { f(); return; }
      raf = requestAnimationFrame(() => { raf = 0; f(); });
    };
    const t = createDragTracker(spec, schedule);
    const el = e.currentTarget as (Element & { setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void }) | null;
    try { el?.setPointerCapture?.(e.pointerId); } catch { /* المؤشّر انتهى أو المتصفح لا يدعم — المستمعون على window يكفون */ }
    e.preventDefault();
    e.stopPropagation();
    // منع السلوك الافتراضي يمنع تركيز الزرّ بالنقر — والأسهم بعده تحتاجه
    (el as HTMLElement | null)?.focus?.({ preventScroll: true });
    t.down(e);
    const pid = e.pointerId;
    const onMove = (ev: PointerEvent): void => t.move(ev);
    const done = (): void => {
      if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      try { el?.releasePointerCapture?.(pid); } catch { /* أُفلت مسبقاً */ }
      if (cleanupRef.current === done) cleanupRef.current = null;
    };
    const onUp = (ev: PointerEvent): void => { if (ev.pointerId !== pid) return; done(); t.up(ev); };
    const onCancel = (ev: PointerEvent): void => { if (ev.pointerId !== pid) return; done(); t.cancel(ev); };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      done();
      t.cancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    cleanupRef.current = done;
  }, []);
}
