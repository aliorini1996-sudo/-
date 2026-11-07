/**
 * «المصمّم الحرّ» للحراري (58/80 مم) — شريطٌ عموديّ لا مواضع ثنائية الأبعاد فيه بطبيعته (pd_spec B.5):
 *
 * - الرول الحقيقي نفسه (thermalPreviewHtml بوسوم المصمّم markers) في iframe بعرض الورق — الوثيقة التي تُحوَّل نقاطاً للطابعة.
 * - فوق كل كتلةٍ موسومة (data-pd) مقبضٌ شفاف: السحب عمودياً يغيّر الترتيب عبر canMoveSection/moveSection (فتبقى القواعد:
 *   الترويسة أولاً، والإجماليات وQR بعد الأصناف، والتواقيع/QR/التذييل آخراً)، والسحب أفقياً 24 بكسل فأكثر يلتقط المحاذاة
 *   يمين/وسط/يسار. كتلة الشعار تُسحب خارج الترويسة فتصير كتلةً مستقلة (logoAfter) وتعود إليها بإفلاتها فوقها، ومقبضها الدائري
 *   يغيّر حجمها بالملّيمتر.
 * - لوحة المفاتيح: ↑/↓ ترتيب، ←/→ محاذاة، +/− الشعار ملّيمتراً، وEsc يلغي السحب.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Eye } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import {
  PRINT_SAMPLE_WATERMARK, QR_REMOVE_WARNING, SECTION_LABELS, canMoveSection, isQrRemoved, layoutOf, moveSection, normalizeSectionOrder, sectionsFor,
  type Align, type PrintProfile, type SectionId,
} from '../../../lib/print/printSettings';
import { logoMmOf, logoMmRange, withLogo, type DesignSel } from '../../../lib/print/designModel';
import { type Company } from '../../../rep/RepDocuments';
import { thermalPreviewHtml } from '../../../rep/thermal';
import { previewInvoiceDoc, previewReceiptDoc } from '../PrintPreview';
import {
  PX_PER_MM, REORDER_THRESHOLD_PX, handleHitPx, isCoarsePointer, alignFromDrag, logoAfterFromDrop, logoMmFromDrag, logoMmStep, stepAlign,
  type StripBlock,
} from './designerMath';
import { logoPlacements, rollAlignOf, sectionDrop, withSectionBefore } from './stripModel';
import { usePointerDrag } from './usePointerDrag';
import { withStyleKey } from './SectionStyleFields';
import { sampleWatermark, useTaxOffPrint } from '../taxOffPrint';

export interface RollStripProps {
  p: PrintProfile;
  update(next: PrintProfile): void;
  doc: 'invoice' | 'receipt';
  selected: DesignSel | null;
  onSelect(s: DesignSel | null): void;
  /** بيانات الشركة للمستند النموذجي (اختياري) */
  company?: unknown;
}

interface Box { left: number; top: number; width: number; height: number }
interface Block extends StripBlock { left: number; width: number; img: Box | null }

/** تطبيق محاذاةٍ على كتلة: الشعار ⇒ logo، والقسم ⇒ sections[id].align */
export function withRollAlign(p: PrintProfile, sel: string, a: Align): PrintProfile {
  if (sel === 'logo') return withLogo(p, { logo: a });
  return withStyleKey(p, sel as SectionId, 'align', a);
}

/**
 * touch-action لكتلة الشريط: الكتل تغطّي الشريط كله، فلو حبست كلها اللمس لما مُرِّر الشريط الطويل بالإصبع على الجوال إلا من
 * الحاشيتين. غير المحدّدة تترك التمرير العمودي للصفحة (لمسةٌ تحدّدها)، والمحدّدة تُسحب (none). الفأرة لا تتأثّر.
 */
export const stripTouchAction = (selected: boolean): 'none' | 'pan-y' => (selected ? 'none' : 'pan-y');

/** أقسام الشريط المخفية بقرار الشركة (شرائح «مخفي» للإعادة) — بلا استثناء: الأصناف وQR منها */
export const hiddenRollSections = (p: PrintProfile): SectionId[] => {
  const l = layoutOf(p);
  return sectionsFor(p.printer, l.design).filter((s) => l.sections?.[s]?.visible === false);
};

export default function RollStrip({ p, update, doc, selected, onSelect, company }: RollStripProps) {
  const tr = useTr();
  const begin = usePointerDrag();
  const [coarse] = useState(isCoarsePointer);
  const knob = Math.max(16, handleHitPx(coarse));
  const l = layoutOf(p);
  const sample = useMemo(() => (doc === 'invoice'
    ? previewInvoiceDoc(company as Company | null, tr)
    : previewReceiptDoc(company as Company | null, tr)), [doc, company, tr]);
  const paperMm: 58 | 80 = p.paper.widthMm < 70 ? 58 : 80;
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(480);
  const [stripW, setStripW] = useState(0);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [live, setLive] = useState<{ sel: string; dx: number; dy: number; lineY: number | null; ok: boolean; align: Align | null } | null>(null);
  const [liveLogo, setLiveLogo] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const focusRef = useRef<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      // markers: وسوم data-pd للمقابض (المعاينة وحدها — الطباعة الحقيقية لا تمرّرها)
      const opts = { tr, paperMm, profile: p, markers: true };
      thermalPreviewHtml(sample, opts).then(
        (h) => { if (alive) { setHtml(h); setFailed(false); } },
        () => { if (alive) setFailed(true); },
      );
    }, 120);
    return () => { alive = false; window.clearTimeout(t); };
  }, [sample, paperMm, p, tr]);

  const measure = (): void => {
    const f = frameRef.current;
    const d = f?.contentDocument;
    if (!f || !d) return;
    setHeight(Math.max(240, d.documentElement.scrollHeight + 4));
    setStripW(f.clientWidth);
    const out: Block[] = [];
    for (const el of Array.from(d.querySelectorAll('[data-pd]'))) {
      const sel = el.getAttribute('data-pd');
      if (!sel) continue;
      const r = el.getBoundingClientRect();
      const im = sel === 'logo' ? el.querySelector('img') : null;
      const ir = im?.getBoundingClientRect() ?? null;
      out.push({ sel, top: r.top, left: r.left, width: r.width, height: r.height, img: ir ? { left: ir.left, top: ir.top, width: ir.width, height: ir.height } : null });
    }
    setBlocks(out);
  };
  // بعد إعادة بناء الوثيقة يعود التركيز إلى المقبض الذي كان عليه (الأسهم المتتابعة)
  useLayoutEffect(() => {
    const want = focusRef.current;
    if (!want) return;
    const btn = overlayRef.current?.querySelector<HTMLButtonElement>(`[data-strip-sel="${want}"]`);
    if (btn && document.activeElement !== btn) btn.focus({ preventScroll: true });
  }, [blocks]);

  const secBlocks = blocks.filter((b) => b.sel !== 'logo');
  const lineOf = (beforeId: string | null): number | null => {
    if (!secBlocks.length) return null;
    const b = beforeId ? secBlocks.find((x) => x.sel === beforeId) : null;
    if (b) return b.top;
    const last = secBlocks[secBlocks.length - 1];
    return last.top + last.height;
  };

  const blockDrag = (e: ReactPointerEvent, b: Block): void => {
    const sel = b.sel;
    // إصبعٌ على كتلةٍ غير محدّدة: قد يكون تمريراً (pan-y) — لا التقاط ولا تحديد هنا؛ النقرة (onClick) تحدّدها
    const canDrag = e.pointerType !== 'touch' || selected === sel;
    if (!canDrag) return;
    focusRef.current = sel;
    onSelect(sel as DesignSel);
    const mid = b.top + b.height / 2;
    const horizontal = sel !== 'items';
    const cur = rollAlignOf(p, sel);
    const plan = (dx: number, dy: number) => {
      const y = mid + dy;
      const align = horizontal ? alignFromDrag(cur, dx, stripW) : null;
      if (Math.abs(dy) <= REORDER_THRESHOLD_PX) return { align, apply: (q: PrintProfile) => q, lineY: null as number | null, ok: true };
      if (sel === 'logo') {
        const after = logoAfterFromDrop(blocks, y);
        const line = after === null ? null : after === 'top' ? (secBlocks[0]?.top ?? 0) : (() => { const s = secBlocks.find((x) => x.sel === after); return s ? s.top + s.height : null; })();
        return { align, apply: (q: PrintProfile) => ((layoutOf(q).logoAfter ?? null) === after ? q : withLogo(q, { logoAfter: after })), lineY: line, ok: true };
      }
      const d = sectionDrop(p, blocks, sel as SectionId, y);
      return { align, apply: (q: PrintProfile) => withSectionBefore(q, sel as SectionId, d.beforeId), lineY: lineOf(d.beforeId), ok: d.ok };
    };
    begin(e, {
      onMove: (dx, dy) => { const r = plan(dx, dy); setLive({ sel, dx: horizontal ? dx : 0, dy, lineY: r.lineY, ok: r.ok, align: r.align }); },
      onCommit: (dx, dy) => {
        const r = plan(dx, dy);
        setLive(null);
        let next = r.apply(p);
        if (r.align) next = withRollAlign(next, sel, r.align);
        if (next !== p) update(next);
      },
      onCancel: () => setLive(null),
    });
  };

  const [lo, hi] = logoMmRange(p);
  const logoDrag = (e: ReactPointerEvent, b: Block): void => {
    if (!b.img) return;
    focusRef.current = 'logo';
    onSelect('logo');
    const align = rollAlignOf(p, 'logo');
    const mm0 = logoMmOf(p);
    begin(e, {
      onMove: (dx) => setLiveLogo(logoMmFromDrag(mm0, align, dx, PX_PER_MM, [lo, hi])),
      onCommit: (dx) => { setLiveLogo(null); update(withLogo(p, { logoMm: logoMmFromDrag(mm0, align, dx, PX_PER_MM, [lo, hi]) })); },
      onCancel: () => setLiveLogo(null),
    });
  };

  const onKey = (e: ReactKeyboardEvent, b: Block): void => {
    const sel = b.sel;
    focusRef.current = sel;
    let next: PrintProfile = p;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (sel === 'logo') {
        const places = logoPlacements(p);
        const at = places.indexOf(l.logoAfter ?? null);
        const to = places[Math.max(0, Math.min(places.length - 1, at + dir))];
        if (to !== (l.logoAfter ?? null)) next = withLogo(p, { logoAfter: to });
      } else {
        const order = normalizeSectionOrder(l.order, p.printer, l.design);
        const to = order.indexOf(sel as SectionId) + dir;
        if (canMoveSection(p, sel as SectionId, to)) next = moveSection(p, sel as SectionId, to);
      }
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel !== 'items') {
      const a = stepAlign(rollAlignOf(p, sel), e.key);
      if (a !== rollAlignOf(p, sel)) next = withRollAlign(p, sel, a);
    } else if (sel === 'logo' && (e.key === '+' || e.key === '=' || e.key === '-')) {
      next = withLogo(p, { logoMm: logoMmStep(logoMmOf(p), e.key === '-' ? -1 : 1, [lo, hi]) });
    } else return;
    e.preventDefault();
    if (next !== p) update(next);
  };

  // كل قسمٍ مخفي — ومنه الأصناف ورمز QR (قرار المالك ٤ نوفمبر ٢٠٢٦: يُخفيان بقرار الشركة الصريح) — ويُعاد بنقرة بلا تأكيد
  // «إزالة الضريبة» (سياق التبويب): لا رمز QR لشركةٍ بلا ضريبة — لا شريحة له ولا تنبيه هيئة، والعلامة «نموذج اختبار»
  const taxOff = useTaxOffPrint();
  const hidden = taxOff ? hiddenRollSections(p).filter((s) => s !== 'qr') : hiddenRollSections(p);
  const qrRemoved = isQrRemoved(l) && !taxOff;

  if (failed) return <p className="text-sm text-[#8E2A1F] text-center py-10">{tr('تعذر عرض المعاينة الحرارية')}</p>;
  if (html === null) return <div className="flex justify-center py-10"><span className="w-6 h-6 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>;
  return (
    <div className="flex flex-col items-center" data-designer="roll">
      <div className="relative" style={{ touchAction: 'pan-y' }}>
        <iframe ref={frameRef} title={tr('المعاينة الحرارية')} srcDoc={html} sandbox="allow-same-origin" onLoad={measure}
          className="bg-white shadow-sm border border-[#E9E1D3] block"
          style={{ width: `calc(${p.paper.widthMm}mm + 2px)`, maxWidth: '100%', height }} />
        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span style={{ transform: 'rotate(-28deg)', color: 'rgba(225,90,48,0.22)', fontWeight: 800, fontSize: 13, whiteSpace: 'nowrap' }}>{tr(sampleWatermark(taxOff))}</span>
        </div>
        <div ref={overlayRef} className="absolute inset-0" style={{ pointerEvents: 'none', margin: 1 }}>
          {live?.align && (
            <div aria-hidden="true" className="absolute inset-0 grid grid-cols-3" style={{ direction: 'ltr' }}>
              {(['end', 'center', 'start'] as const).map((a) => (
                <div key={a} style={{ borderInline: '1px dashed rgba(30,136,229,0.4)', background: live.align === a ? 'rgba(30,136,229,0.08)' : undefined }} />
              ))}
            </div>
          )}
          {blocks.map((b) => {
            const isSel = selected === b.sel;
            const moving = live?.sel === b.sel;
            const label = b.sel === 'logo' ? tr('الشعار') : tr(SECTION_LABELS[b.sel as SectionId] ?? b.sel);
            return (
              <button type="button" key={b.sel} data-strip-sel={b.sel}
                aria-label={`${label} — ${tr('اسحب للأعلى أو الأسفل للترتيب وأفقيا للمحاذاة')}`} aria-pressed={isSel}
                onPointerDown={(e) => blockDrag(e, b)} onKeyDown={(e) => onKey(e, b)}
                onClick={() => { if (!isSel) onSelect(b.sel as DesignSel); }}
                onFocus={() => { if (!isSel) onSelect(b.sel as DesignSel); }}
                className="absolute focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E88E5]"
                style={{
                  left: 0, right: 0, top: b.top, height: Math.max(8, b.height), pointerEvents: 'auto', touchAction: stripTouchAction(isSel),
                  cursor: moving ? 'grabbing' : 'grab', zIndex: b.sel === 'logo' ? 4 : isSel ? 3 : 2,
                  border: isSel ? '2px solid #E15A30' : '1px dashed transparent', borderRadius: 3,
                  background: moving ? 'rgba(255,248,243,0.55)' : isSel ? 'rgba(225,90,48,0.05)' : 'transparent',
                  transform: moving ? `translate(${live.dx}px, ${live.dy}px)` : undefined,
                  boxShadow: moving ? '0 4px 12px rgba(0,0,0,0.2)' : undefined,
                }}>
                {isSel && <span className="absolute top-0 text-[9px] px-1 bg-[#E15A30] text-white rounded-b" style={{ insetInlineStart: 0 }}>{label}</span>}
              </button>
            );
          })}
          {blocks.filter((b) => b.sel === 'logo' && b.img && selected === 'logo').map((b) => {
            const img = b.img as Box;
            const align = rollAlignOf(p, 'logo');
            const x = align === 'start' ? img.left : img.left + img.width;
            return (
              <button type="button" key="logo-size" aria-label={tr('اسحب لتغيير حجم الشعار')}
                onPointerDown={(e) => logoDrag(e, b)}
                className="absolute rounded-full bg-white border-2 border-[#E15A30]"
                style={{ left: x - knob / 2, top: img.top + img.height / 2 - knob / 2, width: knob, height: knob, cursor: 'ew-resize', touchAction: 'none', pointerEvents: 'auto', zIndex: 6 }} />
            );
          })}
          {live && live.lineY !== null && (
            <div aria-hidden="true" className="absolute left-0 right-0" style={{ top: live.lineY - 1.5, height: 3, background: live.ok ? '#1E88E5' : '#C62828', zIndex: 8 }} />
          )}
          {liveLogo !== null && (
            <span className="absolute top-1 left-1 text-[10px] bg-[#1F1A13] text-white rounded px-1.5 py-0.5" dir="ltr" style={{ zIndex: 9 }}>{liveLogo} mm</span>
          )}
        </div>
      </div>
      {hidden.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-[#6E6557]">{tr('مخفي')}:</span>
          {hidden.map((s) => (
            <button type="button" key={s} onClick={() => update(withStyleKey(p, s, 'visible', undefined))}
              className="inline-flex items-center gap-1 rounded-full border border-[#E9E1D3] bg-white px-2 py-0.5 text-[#44403a] hover:border-[#E15A30]">
              <Eye className="w-3 h-3" aria-hidden="true" />{tr(SECTION_LABELS[s])}
            </button>
          ))}
        </div>
      )}
      {qrRemoved && (
        <p className="mt-2 max-w-xs text-[11px] text-[#8E2A1F] bg-[#FBEBE2] rounded px-2 py-1" role="note" data-qr-removed-note="">{tr(QR_REMOVE_WARNING)}</p>
      )}
      <p className="mt-2 text-[11px] text-[#9A8F7E] text-center max-w-xs">
        {tr('اسحب الكتلة للأعلى أو الأسفل للترتيب وأفقيا للمحاذاة، ومقبض الشعار لحجمه. الأسهم وعلامتا + و − من لوحة المفاتيح')}
      </p>
    </div>
  );
}
