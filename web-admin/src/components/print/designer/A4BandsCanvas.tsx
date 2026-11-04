/**
 * «المصمّم الحرّ» — ورقة A4/النقطية بلوحتين حرّتين (رأس الورقة وتذييلها) على نمط مصمّمات التقارير:
 *
 * - الورقة هي القالب الحقيقي نفسه (PrintableInvoice/PrintableReceipt بمظهر lookFor(p)) بعرض 794 بكسل مصغّراً، داخل
 *   PrintDesignPreviewContext — فكل قسمٍ ومربعٍ ولوحة قابلٌ للنقر (data-pd) ويُبرَز المحدَّد. ما يُرى هو ما يُطبع.
 * - فوقها طبقة تحرير: إطار كل مربع (يُسحب بالفأرة أو الإصبع)، وثمانية مقابض لتغيير الحجم، ومقبض ارتفاع لكل لوحة،
 *   وخطوط التقاط زرقاء، وشارة «النص أكبر من المربع». الأسهم تحرّك 0.5 ملم (Shift ‏5 ملم، Alt تغيّر الحجم)، وDelete يعيد المربع
 *   إلى مكانه في الورقة.
 * - السحب حيٌّ في الطبقة وحدها، والالتزام عند الإفلات (upsertBox) فتتحدّث الورقة الحقيقية مرّةً ويُكتب سجلّ تراجعٍ واحد.
 * - الإحداثيات ملّيمترات مادية من الحافة اليسرى لصندوق المحتوى (كما يخزّنها الخادم)؛ موضع اللوحة يُقاس من الورقة نفسها.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, LayoutTemplate, Plus } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import {
  CANVAS_BAND_LABELS, CANVAS_BOX_IDS, CANVAS_BOX_LABELS, CANVAS_FOOTER_ONLY, LAYOUT_BOUNDS, PRINT_SAMPLE_WATERMARK, QR_FLOW_NOTE, QR_REMOVE_WARNING,
  isQrRemoved, layoutOf,
  type CanvasBand, type CanvasBox, type CanvasBoxId, type PrintCanvas, type PrintProfile,
} from '../../../lib/print/printSettings';
import { resolveCanvas, resolveLayout, type CanvasBandR, type CanvasBoxR, type ResolvedCanvas } from '../../../lib/print/layout';
import { removeBox, starterCanvas, upsertBox, withCanvas, type DesignSel } from '../../../lib/print/designModel';
import { PrintableInvoice, PrintableReceipt, canvasQrMinMm, type Company } from '../../../rep/RepDocuments';
import { PrintLookContext, SHEET_WIDTH_PX, lookFor } from '../../../rep/printLook';
import { PrintDesignPreviewContext } from '../../../rep/printDesignContext';
import { canvasOverflowIds } from '../../../rep/printCanvas';
import { previewInvoiceDoc, previewReceiptDoc } from '../PrintPreview';
import { stressInvoiceDocs, stressReceiptDoc } from './stressDocs';
import {
  HANDLES, PX_PER_MM, bandHeightFromDrag, handleHitPx, isCoarsePointer, bandLimits, boxMinMm, constrainRect, keyDelta, moveRect, resizeRect, screenToMm, snapRect,
  type Guide, type Handle, type Rect,
} from './designerMath';
import { usePointerDrag } from './usePointerDrag';
import { withBandHeight } from './DesignInspector';

export interface A4BandsCanvasProps {
  p: PrintProfile;
  update(next: PrintProfile): void;
  doc: 'invoice' | 'receipt';
  selected: DesignSel | null;
  onSelect(s: DesignSel | null): void;
  /** 0 = ملء العرض، وغيره مقياسٌ ثابت (1 = 100٪) */
  zoom: number;
  phase2: boolean;
  company: unknown;
}

/** أقلّ ما يبقى لسريان الأصناف (حدود الخادم: مجموع اللوحتين ≤ 200 ملم) */
const HANDLE_PX = 12;
const HANDLE_POS: Readonly<Record<Handle, { left: string; top: string; cursor: string }>> = Object.freeze({
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' }, n: { left: '50%', top: '0%', cursor: 'ns-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' }, e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' }, s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' }, w: { left: '0%', top: '50%', cursor: 'ew-resize' },
});
const HANDLE_LABELS: Readonly<Record<Handle, string>> = Object.freeze({
  nw: 'تغيير الحجم من الزاوية العليا اليسرى', n: 'تغيير الحجم من الأعلى', ne: 'تغيير الحجم من الزاوية العليا اليمنى',
  e: 'تغيير الحجم من اليمين', se: 'تغيير الحجم من الزاوية السفلى اليمنى', s: 'تغيير الحجم من الأسفل',
  sw: 'تغيير الحجم من الزاوية السفلى اليسرى', w: 'تغيير الحجم من اليسار',
});

/**
 * طبقات اللوحة: المربع (2) < مقبض ارتفاع اللوحة (4) < المربع المحدَّد ومقابضه (5). المقبض على حدّ اللوحة السفلي، والمربعات تلتقط
 * إليه (snapLines) — لو علاها لغطّى مقابض s/se/sw لمربعٍ محدَّدٍ ملاصقٍ للحدّ فصار سحبها تغييراً لارتفاع اللوحة لا للمربع.
 */
export const BOX_Z = 2;
export const GRIP_Z = 4;
export const BOX_SEL_Z = 5;

/** المقاس الافتراضي لمربعٍ يُضاف (ملم) */
const ADD_SIZE: Readonly<Record<CanvasBoxId, [number, number]>> = Object.freeze({
  logo: [30, 20], company: [80, 22], title: [70, 10], docInfo: [80, 22], customer: [90, 26],
  qr: [47, 47], totals: [80, 30], signatures: [120, 20], footer: [188, 10],
});

/**
 * الحدّ الأدنى لمربع QR على هذه الطابعة — الحدّ نفسه الذي ترسم به الورقة (canvasQrMinMm): النقطية بخانة رمزها بنقاط صحيحة،
 * والصفحة بالرمز المختوم بمقاس اليوم وإطاره (50.5 مم). حدٌّ آخر (47) يرسم إطار المصمّم أصغر من مربع الورقة تحته.
 */
export function qrMinMmFor(p: PrintProfile): number {
  return canvasQrMinMm(lookFor(p));
}

/**
 * بداية سحب مقبض لوحة: من ارتفاعها المرسوم (resolveCanvas قد يطيلها لتسع QR بحدّ الورقة) — لا المخزَّن — ولا تقصر عن أطول
 * مربعٍ مرسوم فيها؛ كأسهم المقبض تماماً. وإلا قفزت اللوحة عند أول حركة إلى المخزَّن وبرز QR منها.
 */
export function gripStart(c: PrintCanvas, bandR: CanvasBandR, band: CanvasBand): { h0: number; lim: ReturnType<typeof bandLimits> } {
  const lim = bandLimits(c, band, LAYOUT_BOUNDS);
  const tallest = bandR.boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  return { h0: bandR.hMm, lim: { ...lim, min: Math.max(lim.min, tallest) } };
}

/**
 * الأسهم على مربع (keyDelta): بهندسة السحب نفسها — من المربع المرسوم، داخل اللوحة وعرض المحتوى، وبحدّه الأدنى (QR بحدّ الورقة).
 * Alt + سهم يغيّر الحجم من الحافة اليمنى/السفلى (الأصل ثابت).
 */
export function boxKeyRect(b: Rect, bandHmm: number, contentWmm: number, minMm: number, d: { dx: number; dy: number; resize: boolean }): Rect {
  const lim = { bandH: bandHmm, contentW: contentWmm, minW: minMm, minH: minMm };
  return d.resize
    ? constrainRect(resizeRect(b, 'se', d.dx, d.dy), lim, 'se')
    : constrainRect(moveRect(b, d.dx, d.dy), lim, null);
}

/**
 * التزام مستطيل مربعٍ سُحب أو حُرّك بالأسهم داخل لوحته المرسومة (bandHmm من resolveCanvas). اللوحة المرسومة قد تطول عن المخزَّنة
 * لتسع QR بحدّ الورقة (الصفحة 50.5، والنقطية أكثر من 70 مم) — فتُرفع المخزَّنة إليها أولاً، وإلا قصّ upsertBox المربع إلى المخزَّنة
 * فقفز عن موضع إفلاته، ولم يتحرّك السهم ↓ في الجزء السفلي. الرسم لا يتغيّر بالرفع: اللوحة المرسومة = max(المخزَّنة، حاجة QR).
 */
export function commitBoxRect(p: PrintProfile, box: CanvasBox, bandHmm: number): PrintProfile {
  const c = layoutOf(p).canvas;
  const band: CanvasBand = CANVAS_FOOTER_ONLY.includes(box.id) ? 'footer' : box.band;
  const key = band === 'header' ? 'headerMm' : 'footerMm';
  const base = c && Number.isFinite(bandHmm) && c[key] < bandHmm ? withCanvas(p, { ...c, [key]: bandHmm }) : p;
  return upsertBox(base, { ...box, band });
}

/**
 * المربعات التي يمكن إضافتها الآن: غير موضوعةٍ في لوحة، ولا QR على السند ولا حين حذفته الشركة من المطبوعة (يُعاد أولاً)، ولا
 * شعار على الورق المطبوع مسبقاً
 */
export function addableBoxes(p: PrintProfile, doc: 'invoice' | 'receipt'): CanvasBoxId[] {
  const l = layoutOf(p);
  const placed = new Set((l.canvas?.boxes ?? []).map((b) => b.id));
  const noQr = doc === 'receipt' || isQrRemoved(l);
  return CANVAS_BOX_IDS.filter((id) => !placed.has(id) && !(id === 'qr' && noQr) && !(id === 'logo' && p.template === 'impact_preprinted'));
}

/** مربعات اللوحة المرسومة في طبقة التحرير — بلا QR متى حذفته الشركة (لا إطار لرمزٍ لا يُطبع) */
export function drawnBoxes<T extends { id: CanvasBoxId }>(p: PrintProfile, boxes: readonly T[]): T[] {
  return isQrRemoved(layoutOf(p)) ? boxes.filter((b) => b.id !== 'qr') : [...boxes];
}

/** إضافة مربع: لوحته (التذييل للإجماليات والتوقيعات)، ويوضع تحت آخر مربعٍ فيها إن اتسعت (upsertBox تطيل اللوحة لارتفاعه) */
export function addBox(p: PrintProfile, id: CanvasBoxId, contentWmm: number, qrMinMm: number): PrintProfile {
  const c = layoutOf(p).canvas;
  if (!c) return p;
  const band: CanvasBand = CANVAS_FOOTER_ONLY.includes(id) ? 'footer' : 'header';
  const [w0, h0] = ADD_SIZE[id];
  const min = boxMinMm(id, LAYOUT_BOUNDS.boxMinMm, qrMinMm);
  const w = Math.min(contentWmm, Math.max(min, w0));
  const h = Math.max(min, h0);
  const bandH = band === 'header' ? c.headerMm : c.footerMm;
  const below = c.boxes.filter((b) => b.band === band).reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const y = below + h <= bandH ? below : 0;
  return upsertBox(p, { id, band, x: Math.max(0, contentWmm - w), y, w, h });
}

interface Pos { left: number; top: number }
interface Measured { header: Pos | null; footer: Pos | null; active: { left: number; top: number; width: number; height: number } | null; overflow: CanvasBoxId[] }
const NO_MEASURE: Measured = { header: null, footer: null, active: null, overflow: [] };

export default function A4BandsCanvas({ p, update, doc, selected, onSelect, zoom, phase2, company }: A4BandsCanvasProps) {
  const tr = useTr();
  const begin = usePointerDrag();
  const [coarse] = useState(isCoarsePointer);
  const hit = handleHitPx(coarse);
  const look = useMemo(() => lookFor(p), [p]);
  const sample = useMemo(() => (doc === 'invoice'
    ? previewInvoiceDoc(company as Company | null, tr)
    : previewReceiptDoc(company as Company | null, tr)), [doc, company, tr]);
  // مستنداتٌ مخفيّة بأطول ما يحمله كل مربع (آجلة بخصم، إشعار دائن، سندٌ لعدّة فواتير) — فيضها يُضمّ إلى الشارة (stressDocs.ts)
  const stress = useMemo(() => (sample.kind === 'invoice' ? stressInvoiceDocs(sample) : [stressReceiptDoc(sample)]), [sample]);
  const stressRef = useRef<HTMLDivElement>(null);
  const l = layoutOf(p);
  const printer: 'page' | 'impact' = p.printer === 'impact' ? 'impact' : 'page';
  const canvasAllowed = p.printer !== 'thermal' && l.design === 'standard';
  const qrRemoved = isQrRemoved(l);
  const qrMinMm = qrMinMmFor(p);
  const resolved: ResolvedCanvas | null = useMemo(
    () => (canvasAllowed ? resolveCanvas(resolveLayout(p), { printer, qrMinMm, kind: doc }) : null),
    [p, canvasAllowed, printer, qrMinMm, doc],
  );

  const boxRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [sheetH, setSheetH] = useState(1123);
  const [m, setM] = useState<Measured>(NO_MEASURE);
  const [live, setLive] = useState<{ id: CanvasBoxId; rect: Rect; guides: Guide[] } | null>(null);
  const [liveBand, setLiveBand] = useState<{ band: CanvasBand; h: number } | null>(null);
  const scale = zoom > 0 ? zoom : boxW > 0 ? Math.min(1, (boxW - 8) / SHEET_WIDTH_PX) : 0.5;
  const pad = look.pagePadding;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const sheet = sheetRef.current;
    if (!box || !sheet) return;
    const measure = (): void => { setBoxW(box.clientWidth); setSheetH(sheet.offsetHeight); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(sheet);
    return () => ro.disconnect();
  }, []);

  // مواضع اللوحتين والمحدَّد والفيض — من الورقة الحقيقية بعد رسمها (بكسل القالب قبل التصغير)
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const sr = sheet.getBoundingClientRect();
    const k = scale > 0 ? scale : 1;
    const posOf = (el: Element | null): Pos | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: (r.left - sr.left) / k, top: (r.top - sr.top) / k };
    };
    const activeEl = selected && !selected.startsWith('box:') ? sheet.querySelector(`[data-pd="${selected}"]`) : null;
    let active: Measured['active'] = null;
    if (activeEl) {
      const r = activeEl.getBoundingClientRect();
      active = { left: (r.left - sr.left) / k, top: (r.top - sr.top) / k, width: r.width / k, height: r.height / k };
    }
    setM({
      header: posOf(sheet.querySelector('[data-section="canvas-header"]')),
      footer: posOf(sheet.querySelector('[data-section="canvas-footer"]')),
      active,
      overflow: [...new Set([...canvasOverflowIds(sheet), ...(stressRef.current ? canvasOverflowIds(stressRef.current) : [])])],
    });
  }, [p, doc, scale, sheetH, selected, stress]);

  const bandOrigin = (band: CanvasBand): Pos => {
    const at = band === 'header' ? m.header : m.footer;
    if (at) return at;
    // لم تُرسم اللوحة بعد (أو القالب لا يرسمها): رأسٌ عند حافة المحتوى، وتذييلٌ أسفل الورقة
    const hPx = (resolved?.footer?.hPx ?? 0);
    return band === 'header' ? { left: pad, top: pad } : { left: pad, top: Math.max(pad, sheetH - pad - hPx) };
  };

  const startCanvas = useCallback(() => {
    update(withCanvas(p, starterCanvas(p)));
    onSelect('band:header');
  }, [p, update, onSelect]);

  const boxDrag = (e: ReactPointerEvent, b: CanvasBoxR, h: Handle | null): void => {
    const band = b.band;
    const bandR = band === 'header' ? resolved?.header : resolved?.footer;
    if (!resolved || !bandR) return;
    const start: Rect = { x: b.x, y: b.y, w: b.w, h: b.h };
    const others: Rect[] = bandR.boxes.filter((o) => o.id !== b.id).map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
    const min = boxMinMm(b.id, LAYOUT_BOUNDS.boxMinMm, qrMinMm);
    const lim = { bandH: bandR.hMm, contentW: resolved.contentWmm, minW: min, minH: min };
    const at = (dx: number, dy: number): { rect: Rect; guides: Guide[] } => {
      const dxm = screenToMm(dx, scale); const dym = screenToMm(dy, scale);
      const raw = h ? resizeRect(start, h, dxm, dym) : moveRect(start, dxm, dym);
      const s = snapRect(raw, h, others, resolved.contentWmm, bandR.hMm);
      return { rect: constrainRect(s.rect, lim, h), guides: s.guides };
    };
    onSelect(`box:${b.id}`);
    begin(e, {
      onMove: (dx, dy) => { const r = at(dx, dy); setLive({ id: b.id, rect: r.rect, guides: r.guides }); },
      onCommit: (dx, dy) => {
        const r = at(dx, dy);
        setLive(null);
        const stored = l.canvas?.boxes.find((x) => x.id === b.id);
        update(commitBoxRect(p, { ...(stored ?? { id: b.id, band }), ...r.rect }, bandR.hMm));
      },
      onCancel: () => setLive(null),
    });
  };

  const gripDrag = (e: ReactPointerEvent, band: CanvasBand): void => {
    const c = l.canvas;
    const bandR = band === 'header' ? resolved?.header : resolved?.footer;
    if (!c || !bandR) return;
    const { h0, lim } = gripStart(c, bandR, band);
    onSelect(`band:${band}`);
    begin(e, {
      onMove: (_dx, dy) => setLiveBand({ band, h: bandHeightFromDrag(h0, screenToMm(dy, scale), lim) }),
      onCommit: (_dx, dy) => { setLiveBand(null); update(withBandHeight(p, band, bandHeightFromDrag(h0, screenToMm(dy, scale), lim))); },
      onCancel: () => setLiveBand(null),
    });
  };

  const onBoxKey = (e: ReactKeyboardEvent, id: CanvasBoxId): void => {
    const d = keyDelta(e.key, e);
    if (d) {
      e.preventDefault();
      const rb = resolved?.header?.boxes.find((x) => x.id === id) ?? resolved?.footer?.boxes.find((x) => x.id === id);
      const bandR = rb ? (rb.band === 'header' ? resolved?.header : resolved?.footer) : null;
      const stored = l.canvas?.boxes.find((x) => x.id === id);
      if (!rb || !bandR || !stored || !resolved) return;
      const r = boxKeyRect(rb, bandR.hMm, resolved.contentWmm, boxMinMm(id, LAYOUT_BOUNDS.boxMinMm, qrMinMm), d);
      update(commitBoxRect(p, { ...stored, ...r }, bandR.hMm));
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      update(removeBox(p, id));
      onSelect(null);
    }
  };

  const ctx = useMemo(() => ({ active: selected, onPick: (s: DesignSel) => onSelect(s) }), [selected, onSelect]);
  const addable = canvasAllowed && l.canvas ? addableBoxes(p, doc) : [];
  const px = (v: number): number => v * scale;

  const renderBand = (band: CanvasBand) => {
    const bandR = band === 'header' ? resolved?.header : resolved?.footer;
    if (!bandR) return null;
    const o = bandOrigin(band);
    const hMm = liveBand?.band === band ? liveBand.h : bandR.hMm;
    const wPx = (resolved?.contentWmm ?? 0) * PX_PER_MM;
    const hPx = hMm * PX_PER_MM;
    const sel = selected === `band:${band}`;
    return (
      <div key={band} data-designer-band={band} className="absolute" style={{ left: px(o.left), top: px(o.top), width: px(wPx), height: px(hPx), pointerEvents: 'none' }}>
        <div aria-hidden="true" className="absolute inset-0" style={{
          outline: `1px dashed ${sel ? '#E15A30' : '#C9B9A8'}`,
          backgroundImage: 'linear-gradient(rgba(0,0,0,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.05) 1px, transparent 1px)',
          backgroundSize: `${px(5 * PX_PER_MM)}px ${px(5 * PX_PER_MM)}px`,
        }} />
        <span aria-hidden="true" className="absolute text-[10px] text-[#A08B78] bg-white/80 px-1 rounded" style={{ top: -16, insetInlineStart: 0 }}>
          {tr(CANVAS_BAND_LABELS[band])} · <span dir="ltr">{hMm} mm</span>
        </span>
        {/* الأصغر مساحةً يُرسم آخراً فيعلو: مربّعٌ وُضع فوق أكبر منه (كالشعار على بيانات المستند) يبقى قابلاً للنقر والسحب */}
        {drawnBoxes(p, bandR.boxes).sort((a, b) => b.w * b.h - a.w * a.h).map((b) => {
          const isLive = live?.id === b.id;
          const r = isLive ? live.rect : { x: b.x, y: b.y, w: b.w, h: b.h };
          const isSel = selected === `box:${b.id}`;
          const over = m.overflow.includes(b.id);
          return (
            <div key={b.id} data-designer-box={b.id} className="absolute" style={{
              left: px(r.x * PX_PER_MM), top: px(r.y * PX_PER_MM), width: px(r.w * PX_PER_MM), height: px(r.h * PX_PER_MM),
              pointerEvents: 'auto', zIndex: isSel ? BOX_SEL_Z : BOX_Z,
            }}>
              <button type="button" aria-label={`${tr(CANVAS_BOX_LABELS[b.id])} — ${tr('اسحب للنقل والأسهم للتحريك')}`}
                aria-pressed={isSel}
                onPointerDown={(e) => boxDrag(e, b, null)}
                onKeyDown={(e) => onBoxKey(e, b.id)}
                onFocus={() => { if (!isSel) onSelect(`box:${b.id}`); }}
                className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E88E5]"
                style={{
                  touchAction: 'none', cursor: 'move', background: isSel ? 'rgba(225,90,48,0.06)' : 'transparent',
                  border: isSel ? '2px solid #E15A30' : '1px solid rgba(160,139,120,0.7)', borderRadius: 2,
                }}>
                <span className="absolute top-0 text-[9px] leading-tight px-1 bg-white/85 text-[#6E6557] rounded-b" style={{ insetInlineStart: 0 }}>
                  {tr(CANVAS_BOX_LABELS[b.id])}
                </span>
              </button>
              {over && (
                <span role="note" title={tr('النص أكبر من المربع')} className="absolute -top-2 -end-2 rounded-full bg-[#FBEBE2] text-[#8E2A1F] border border-[#E15A30] p-0.5" style={{ zIndex: 6 }}>
                  <AlertTriangle className="w-3 h-3" aria-label={tr('النص أكبر من المربع')} />
                </span>
              )}
              {isSel && HANDLES.map((h) => (
                <button type="button" key={h} aria-label={tr(HANDLE_LABELS[h])} tabIndex={-1}
                  onPointerDown={(e) => boxDrag(e, b, h)}
                  onKeyDown={(e) => onBoxKey(e, b.id)}
                  className="absolute flex items-center justify-center"
                  style={{
                    left: HANDLE_POS[h].left, top: HANDLE_POS[h].top, width: hit, height: hit,
                    transform: 'translate(-50%, -50%)', cursor: HANDLE_POS[h].cursor, touchAction: 'none', zIndex: 7,
                  }}>
                  <span aria-hidden="true" className="block bg-white border-2 border-[#E15A30] rounded-[3px]" style={{ width: HANDLE_PX, height: HANDLE_PX }} />
                </button>
              ))}
            </div>
          );
        })}
        {live && bandR.boxes.some((b) => b.id === live.id) && live.guides.map((g, i) => (
          <div key={i} aria-hidden="true" className="absolute bg-[#1E88E5]" style={g.axis === 'x'
            ? { left: px(g.at * PX_PER_MM), top: 0, bottom: 0, width: 1, zIndex: 9 }
            : { top: px(g.at * PX_PER_MM), left: 0, right: 0, height: 1, zIndex: 9 }} />
        ))}
        <button type="button" aria-label={`${tr('ارتفاع اللوحة')}: ${tr(CANVAS_BAND_LABELS[band])}`}
          onPointerDown={(e) => gripDrag(e, band)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const step = e.shiftKey ? 5 : LAYOUT_BOUNDS.stepMm;
            const c = l.canvas;
            if (!c) return;
            update(withBandHeight(p, band, Math.max(gripStart(c, bandR, band).lim.min, bandR.hMm + (e.key === 'ArrowDown' ? step : -step))));
          }}
          className="absolute left-0 right-0 flex items-center justify-center"
          style={{ top: px(hPx) - hit / 2, height: hit, cursor: 'ns-resize', touchAction: 'none', pointerEvents: 'auto', zIndex: GRIP_Z }}>
          <span aria-hidden="true" className="block w-10 h-1.5 rounded-full bg-[#E15A30]/70" />
        </button>
      </div>
    );
  };

  return (
    <div className="w-full">
      {canvasAllowed && !l.canvas && (
        <div className="mb-3 rounded-lg border border-dashed border-[#E15A30] bg-[#FBEBE2]/50 p-3 flex flex-wrap items-center gap-2 text-xs">
          <LayoutTemplate className="w-4 h-4 text-[#C94E28]" aria-hidden="true" />
          <span className="text-[#44403a]">{tr('صمم رأس الورقة وتذييلها بالسحب: الأصناف تبقى تجري بينهما على أي عدد من الصفحات')}</span>
          <button type="button" onClick={startCanvas} className="btn-primary !py-1 !px-3 text-xs ms-auto">{tr('ابدأ التصميم بالسحب')}</button>
        </div>
      )}
      {!canvasAllowed && p.printer !== 'thermal' && (
        <p className="mb-3 text-[11px] text-[#9A8F7E]">{tr('التصميم الحر بالسحب للتصميم القياسي فقط — انقر أي قسم لتنسيقه')}</p>
      )}
      {addable.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]" role="group" aria-label={tr('أضف إلى اللوحة')}>
          <span className="text-[#6E6557]">{tr('أضف إلى اللوحة')}:</span>
          {addable.map((id) => (
            <button type="button" key={id}
              onClick={() => { update(addBox(p, id, resolved?.contentWmm ?? 188, qrMinMm)); onSelect(`box:${id}`); }}
              className="inline-flex items-center gap-0.5 rounded-full border border-[#E9E1D3] bg-white px-2 py-0.5 text-[#44403a] hover:border-[#E15A30]">
              <Plus className="w-3 h-3" aria-hidden="true" />{tr(CANVAS_BOX_LABELS[id])}
            </button>
          ))}
        </div>
      )}
      <div ref={boxRef} className="w-full overflow-auto" data-designer="a4">
        <div className="relative mx-auto bg-white" style={{ width: SHEET_WIDTH_PX * scale, height: sheetH * scale, boxShadow: '0 1px 6px rgba(31,26,19,0.18)', border: '1px solid #E9E1D3' }}>
          <div className="absolute inset-0 overflow-hidden">
            <div ref={sheetRef} style={{ position: 'absolute', top: 0, left: 0, width: SHEET_WIDTH_PX, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              <PrintDesignPreviewContext.Provider value={ctx}>
                <PrintLookContext.Provider value={look}>
                  {sample.kind === 'invoice' ? <PrintableInvoice doc={sample} /> : <PrintableReceipt doc={sample} />}
                </PrintLookContext.Provider>
              </PrintDesignPreviewContext.Provider>
            </div>
            {/* للقياس وحده: الورقة نفسها بلا سياق المصمّم، مخفيّةً بعرضها الحقيقي (visibility تُبقي التخطيط فيُقاس الفيض) */}
            <div ref={stressRef} aria-hidden="true" data-designer-stress="" style={{ position: 'absolute', top: 0, left: 0, width: SHEET_WIDTH_PX, visibility: 'hidden', pointerEvents: 'none' }}>
              <PrintLookContext.Provider value={look}>
                {stress.map((d, i) => (d.kind === 'invoice' ? <PrintableInvoice key={i} doc={d} /> : <PrintableReceipt key={i} doc={d} />))}
              </PrintLookContext.Provider>
            </div>
            <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span style={{ transform: 'rotate(-28deg)', color: 'rgba(225,90,48,0.22)', fontWeight: 800, fontSize: Math.max(13, (SHEET_WIDTH_PX * scale) / 13), whiteSpace: 'nowrap' }}>
                {tr(PRINT_SAMPLE_WATERMARK)}
              </span>
            </div>
          </div>
          {m.active && (
            <div aria-hidden="true" className="absolute pointer-events-none" style={{
              left: px(m.active.left) - 2, top: px(m.active.top) - 2, width: px(m.active.width) + 4, height: px(m.active.height) + 4,
              outline: '2px solid #E15A30', borderRadius: 3, zIndex: 3,
            }} />
          )}
          {resolved && (
            <div className="absolute inset-0" style={{ pointerEvents: 'none' }}>
              {renderBand('header')}
              {renderBand('footer')}
            </div>
          )}
        </div>
      </div>
      {doc === 'invoice' && qrRemoved && (
        <p className="mt-2 text-[11px] text-[#8E2A1F] bg-[#FBEBE2] rounded px-2 py-1" role="note" data-qr-removed-note="">{tr(QR_REMOVE_WARNING)}</p>
      )}
      {phase2 && doc === 'invoice' && !qrRemoved && (
        <p className="mt-2 text-[11px] text-[#9A8F7E]">{tr(QR_FLOW_NOTE)}</p>
      )}
    </div>
  );
}
