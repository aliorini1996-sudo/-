/**
 * مفتّش «المصمّم الحرّ»: أدوات العنصر المحدَّد — قسم (SectionStyleFields)، أو الشعار (منزلقة الحجم بالملّيمتر ومحاذاته
 * ومكانه)، أو مربعٌ في لوحة (x/y/w/h بالملّيمتر واللوحة والمحاذاة والخط)، أو لوحة (ارتفاعها). وبلا تحديد: قائمة الأقسام
 * للاختيار وأزرار «العودة» الجزئية. كل كتابةٍ تمرّ بمساعدات designModel فيبقى للمصمّم والأدوات نموذج بيانات واحد.
 */
import { RotateCcw, Trash2 } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import {
  CANVAS_BAND_LABELS, CANVAS_BOX_LABELS, CANVAS_CONTENT_MM, CANVAS_FOOTER_ONLY, LAYOUT_BOUNDS, LOGO_POSITIONS, LOGO_POSITION_LABELS,
  SECTION_LABELS, layoutOf, sectionsFor,
  type CanvasBand, type CanvasBox, type CanvasBoxId, type LogoPosition, type PrintProfile, type SectionId,
} from '../../../lib/print/printSettings';
import { logoMmOf, logoMmRange, removeBox, resetCanvas, resetLogo, resetSections, upsertBox, withCanvas, withLogo, type DesignSel } from '../../../lib/print/designModel';
import { AlignChips, NumInput, SectionStyleFields, chipCls, clampFontPct } from './SectionStyleFields';
import { bandAllows, bandLimits, fitBoxesToBand, snapGrid } from './designerMath';
import { canvasQrMinMm } from '../../../rep/RepDocuments';
import { lookFor } from '../../../rep/printLook';

/** أصغر ضلعٍ لمربع QR كما ترسمه الورقة (الصفحة 50.5 مم، والنقطية بخانتها) — لا حدّ الخادم 47 وحده */
export const qrBoxMinFor = (p: PrintProfile): number => canvasQrMinMm(lookFor(p));

export interface DesignInspectorProps {
  p: PrintProfile;
  update(next: PrintProfile): void;
  selected: DesignSel | null;
  onSelect(s: DesignSel | null): void;
  phase2: boolean;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ارتفاع لوحة بعد تعديله: ضمن حدوده، والمربعات تُرفع لتبقى داخلها */
export function withBandHeight(p: PrintProfile, band: CanvasBand, hMm: number): PrintProfile {
  const c = layoutOf(p).canvas;
  if (!c) return p;
  const lim = bandLimits(c, band, LAYOUT_BOUNDS);
  const hi = Math.max(0, Math.min(lim.max, lim.total - lim.other));
  const h = snapGrid(Math.min(hi, Math.max(Math.min(lim.min, hi), hMm)));
  const key = band === 'header' ? 'headerMm' : 'footerMm';
  if (c[key] === h) return p;
  return withCanvas(p, { ...c, [key]: h, boxes: fitBoxesToBand(c.boxes, band, h) });
}

export const isBoxSel = (s: DesignSel | null): s is `box:${CanvasBoxId}` => typeof s === 'string' && s.startsWith('box:');
export const isBandSel = (s: DesignSel | null): s is 'band:header' | 'band:footer' => s === 'band:header' || s === 'band:footer';

export default function DesignInspector({ p, update, selected, onSelect, phase2 }: DesignInspectorProps) {
  const tr = useTr();
  const l = layoutOf(p);
  const sections = sectionsFor(p.printer, l.design);
  const head = 'text-sm font-bold text-[#1F1A13] mb-2 flex items-center gap-2';

  if (selected === 'logo') return <LogoInspector p={p} update={update} />;
  if (isBoxSel(selected)) {
    const id = selected.slice(4) as CanvasBoxId;
    const box = l.canvas?.boxes.find((b) => b.id === id);
    if (box) return <BoxInspector p={p} update={update} box={box} onSelect={onSelect} />;
  }
  if (isBandSel(selected) && l.canvas) {
    const band: CanvasBand = selected === 'band:header' ? 'header' : 'footer';
    const h = band === 'header' ? l.canvas.headerMm : l.canvas.footerMm;
    return (
      <div>
        <h3 className={head}>{tr(CANVAS_BAND_LABELS[band])}</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[#6E6557]">{tr('الارتفاع')}</span>
          <NumInput value={h} label={tr('الارتفاع')} suffix="mm" clampFn={(v) => snapGrid(v)} onCommit={(v) => update(withBandHeight(p, band, v))} />
        </div>
        <p className="text-[11px] text-[#9A8F7E] mt-2">{tr('اسحب الحد السفلي للوحة لتغيير ارتفاعها، والارتفاع 0 يلغي اللوحة')}</p>
      </div>
    );
  }
  if (selected && (sections as readonly string[]).includes(selected)) {
    const id = selected as SectionId;
    return (
      <div>
        <h3 className={head}>{tr(SECTION_LABELS[id])}</h3>
        <SectionStyleFields p={p} update={update} id={id} phase2={phase2} />
      </div>
    );
  }
  // بلا تحديد: اختيار قسم أو الشعار، وأزرار العودة الجزئية
  const hasSections = !!l.sections && Object.keys(l.sections).length > 0;
  const hasLogo = fin(l.logoMm) || l.logoAfter !== undefined;
  return (
    <div>
      <h3 className={head}>{tr('اختر عنصرا لتعديله')}</h3>
      <p className="text-[11px] text-[#9A8F7E] mb-2">{tr('انقر عنصرا في الورقة أو اختره من القائمة')}</p>
      <div className="flex flex-wrap gap-1 mb-3">
        {p.template !== 'impact_preprinted' && (
          <button type="button" onClick={() => onSelect('logo')} className={chipCls(false)}>{tr('الشعار')}</button>
        )}
        {sections.map((s) => (
          <button type="button" key={s} onClick={() => onSelect(s)} className={chipCls(false)}>{tr(SECTION_LABELS[s])}</button>
        ))}
      </div>
      <div className="flex flex-col items-start gap-1 border-t border-[#F1EBDF] pt-2">
        <button type="button" disabled={!hasLogo} onClick={() => update(resetLogo(p))} className="inline-flex items-center gap-1 text-[11px] text-[#6E6557] hover:text-[#C94E28] disabled:opacity-40">
          <RotateCcw className="w-3 h-3" aria-hidden="true" />{tr('إعادة الشعار كاليوم')}
        </button>
        <button type="button" disabled={!hasSections} onClick={() => update(resetSections(p))} className="inline-flex items-center gap-1 text-[11px] text-[#6E6557] hover:text-[#C94E28] disabled:opacity-40">
          <RotateCcw className="w-3 h-3" aria-hidden="true" />{tr('إعادة تنسيق الأقسام')}
        </button>
        {p.printer !== 'thermal' && (
          <button type="button" disabled={!l.canvas} onClick={() => update(resetCanvas(p))} className="inline-flex items-center gap-1 text-[11px] text-[#6E6557] hover:text-[#C94E28] disabled:opacity-40">
            <RotateCcw className="w-3 h-3" aria-hidden="true" />{tr('إلغاء التصميم بالسحب')}
          </button>
        )}
      </div>
    </div>
  );
}

function LogoInspector({ p, update }: { p: PrintProfile; update(next: PrintProfile): void }) {
  const tr = useTr();
  const l = layoutOf(p);
  const [lo, hi] = logoMmRange(p);
  const mm = logoMmOf(p);
  const custom = fin(l.logoMm);
  const sections = sectionsFor(p.printer, l.design);
  const inCanvas = !!l.canvas?.boxes.some((b) => b.id === 'logo');
  const clampMm = (v: number): number => snapGrid(Math.min(hi, Math.max(lo, v)));
  const placement = l.logoAfter ?? '';
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold text-[#1F1A13]">{tr('الشعار')}</h3>
      {p.template === 'impact_preprinted' && <p className="text-[11px] text-[#9A8F7E]">{tr('الورق المطبوع مسبقا بلا شعار')}</p>}
      {/* الحراري يبدأ بالشعار مطفأً: يُفعَّل من هنا مباشرةً بدل الخروج إلى «المحتوى» */}
      {!p.options.showLogo && (
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-[#8E2A1F]">
          {tr('إظهار الشعار مطفأ في المحتوى')}
          {p.template !== 'impact_preprinted' && (
            <button type="button" data-logo-enable="" onClick={() => update({ ...p, options: { ...p.options, showLogo: true } })}
              className="rounded-full border border-[#E15A30] px-2 py-0.5 font-semibold text-[#C94E28] hover:bg-[#FBEBE2]">{tr('تفعيل')}</button>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[#6E6557] min-w-[84px]">{tr('حجم الشعار')}</span>
        <input type="range" min={lo} max={hi} step={LAYOUT_BOUNDS.stepMm} value={mm} aria-label={tr('حجم الشعار')}
          className="w-36 accent-[#E15A30]" style={{ touchAction: 'pan-y' }}
          onChange={(e) => update(withLogo(p, { logoMm: clampMm(Number(e.target.value)) }))} />
        <NumInput value={mm} clampFn={clampMm} label={tr('حجم الشعار')} suffix="mm" onCommit={(v) => update(withLogo(p, { logoMm: v }))} />
        {custom && (
          <button type="button" onClick={() => update(withLogo(p, { logoMm: null }))} className="text-[11px] text-[#6E6557] hover:text-[#C94E28]">{tr('الحجم التلقائي')}</button>
        )}
      </div>
      <p className="text-[11px] text-[#9A8F7E]" dir="auto">{tr('أقصى عرض وارتفاع للشعار')} · <span dir="ltr">{lo}–{hi} mm</span></p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[#6E6557] min-w-[84px]">{tr('المحاذاة')}</span>
        <span className="inline-flex flex-wrap gap-1" role="group" aria-label={tr('مكان الشعار')}>
          {LOGO_POSITIONS.map((v: LogoPosition) => (
            <button type="button" key={v} aria-pressed={l.logo === v} onClick={() => update(withLogo(p, { logo: v }))} className={chipCls(l.logo === v)}>
              {tr(LOGO_POSITION_LABELS[v])}
            </button>
          ))}
        </span>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[#6E6557] min-w-[84px]">{tr('موضع الشعار')}</span>
        <select className="input !py-1 text-xs w-auto" value={placement}
          onChange={(e) => update(withLogo(p, { logoAfter: e.target.value === '' ? null : (e.target.value as SectionId | 'top') }))}>
          <option value="">{tr('داخل الترويسة كاليوم')}</option>
          <option value="top">{tr('أعلى الورقة')}</option>
          {sections.map((s) => <option key={s} value={s}>{tr('بعد')}: {tr(SECTION_LABELS[s])}</option>)}
        </select>
      </label>
      {inCanvas && <p className="text-[11px] text-[#9A8F7E]">{tr('مربع الشعار في لوحة الرأس أو التذييل يتقدم على هذا الموضع')}</p>}
    </div>
  );
}

function BoxInspector({ p, update, box, onSelect }: { p: PrintProfile; update(next: PrintProfile): void; box: CanvasBox; onSelect(s: DesignSel | null): void }) {
  const tr = useTr();
  const contentW = p.printer === 'impact' ? CANVAS_CONTENT_MM.impact : CANVAS_CONTENT_MM.page;
  const set = (patch: Partial<CanvasBox>): void => update(upsertBox(p, { ...box, ...patch }));
  const isQr = box.id === 'qr';
  const qrMin = isQr ? qrBoxMinFor(p) : 0;
  // ضلعا QR لا يُكتبان تحت ما ترسمه الورقة (وإلا عرض الحقل 47 والمطبوع 50.5)
  const lo = (k: 'x' | 'y' | 'w' | 'h'): number => (isQr && (k === 'w' || k === 'h') ? qrMin : 0);
  const mmField = (k: 'x' | 'y' | 'w' | 'h', label: string) => (
    <label className="inline-flex items-center gap-1 text-[11px] text-[#6E6557]">
      <span className="w-4 text-center" dir="ltr">{k.toUpperCase()}</span>
      <NumInput value={box[k]} label={label} suffix="mm" width={60} clampFn={(v) => snapGrid(Math.max(lo(k), Math.min(contentW, v)))} onCommit={(v) => set({ [k]: v })} />
    </label>
  );
  const fontPct = fin(box.fontPct) ? box.fontPct : 100;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold text-[#1F1A13]">{tr(CANVAS_BOX_LABELS[box.id])}</h3>
      <div className="grid grid-cols-2 gap-2">
        {mmField('x', tr('البعد عن يسار الورقة'))}
        {mmField('y', tr('البعد عن أعلى اللوحة'))}
        {mmField('w', tr('العرض'))}
        {mmField('h', tr('الارتفاع'))}
      </div>
      {isQr && <p className="text-[11px] text-[#9A8F7E]">{tr('رمز QR لا يصغر عن حد القراءة')} · <span dir="ltr">≥ {qrMin} mm</span></p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[#6E6557] min-w-[84px]">{tr('اللوحة')}</span>
        {(['header', 'footer'] as const).map((b) => (
          <button type="button" key={b} aria-pressed={box.band === b} disabled={!bandAllows(box.id, b, CANVAS_FOOTER_ONLY)}
            onClick={() => set({ band: b })} className={chipCls(box.band === b)}>{tr(CANVAS_BAND_LABELS[b])}</button>
        ))}
      </div>
      {!isQr && box.id !== 'logo' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[#6E6557] min-w-[84px]">{tr('المحاذاة')}</span>
            <AlignChips value={box.align ?? null} allowAuto label={tr('المحاذاة')} onChange={(a) => {
              const next: CanvasBox = { ...box };
              if (a === null) delete next.align; else next.align = a;
              update(upsertBox(p, next));
            }} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[#6E6557] min-w-[84px]">{tr('حجم الخط')}</span>
            <NumInput value={fontPct} clampFn={clampFontPct} label={tr('حجم الخط')} suffix="%" width={56} onCommit={(v) => {
              const next: CanvasBox = { ...box };
              if (v === 100) delete next.fontPct; else next.fontPct = v;
              update(upsertBox(p, next));
            }} />
          </div>
        </>
      )}
      {box.id === 'logo' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[#6E6557] min-w-[84px]">{tr('المحاذاة')}</span>
          <AlignChips value={box.align ?? null} allowAuto label={tr('المحاذاة')} onChange={(a) => {
            const next: CanvasBox = { ...box };
            if (a === null) delete next.align; else next.align = a;
            update(upsertBox(p, next));
          }} />
        </div>
      )}
      <button type="button" onClick={() => { update(removeBox(p, box.id)); onSelect(null); }}
        className="inline-flex items-center gap-1 text-[11px] text-[#8E2A1F] hover:underline">
        <Trash2 className="w-3 h-3" aria-hidden="true" />{isQr ? tr('إعادة رمز QR إلى مكانه التلقائي') : tr('إخراج من اللوحة (يعود إلى مكانه في الورقة)')}
      </button>
    </div>
  );
}
