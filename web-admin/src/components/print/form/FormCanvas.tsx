/**
 * «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — لوحة مصمّم النموذج: الورقة كاملةً بمقاسها (A4 = 210 × 297 مم)
 * على الشاشة، وصورة النموذج الفارغ خلفها (للشاشة وحدها — بمُحمِّل صور النموذج useFormImage)، وفوقها:
 *
 * - صندوق كل حقل: يُسحب بالفأرة أو الإصبع، وبثمانية مقابض لتغيير الحجم، والنصّ داخله بحجم خطّ الطباعة ومحاذاتها. الأسهم 0.5 مم
 *   (Shift ‏5 مم، Alt تغيّر الحجم)، وDelete يحذف الحقل.
 * - جدول الأصناف كتلةً: لسانٌ أعلاه يسحبها رأسياً، ومقبضٌ أسفلها يضبط ارتفاع الصف (حافة آخر صفٍّ تتبع المؤشّر)، وأعمدته شرائط
 *   رأسية تُسحب أفقياً وتُعرَّض من حافتيها.
 * - وضع المعايرة: المواضع المطبوعة فعلاً (+ إزاحة dx/dy) متقطّعةً بلا تحرير، ليُرى أثر المعايرة على صورة النموذج.
 *
 * السحب حيٌّ في الطبقة وحدها، والالتزام عند الإفلات بمحرّرات formModel (تلصق بالشبكة وتقصّ داخل الورقة) فيُكتب سجلّ تراجعٍ واحد.
 * الإحداثيات ملّيمترات من الركن الأيسر الأعلى الفعلي للورقة (x يميناً مهما كان اتجاه الواجهة) — الأسهم مادّية.
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, GripHorizontal, ImageOff } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import {
  FORM_COLUMN_LABELS, FORM_FIELD_LABELS, FORM_WARNINGS, formFontPt, formOverlaps, formSheetSize, formTableBox, moveFormColumn, moveFormField,
  moveFormTable, printedBox, withFormColumn, withFormField, withFormTable, withoutFormColumn, withoutFormField,
  type FormColumn, type FormField, type FormFieldId, type FormPaper, type PrintForm,
} from '../../../lib/print/formModel';
import { useFormImage } from '../../../lib/print/formImage';
import { HANDLES, PX_PER_MM, handleHitPx, isCoarsePointer, keyDelta, type Guide, type Handle, type Rect } from '../designer/designerMath';
import { usePointerDrag } from '../designer/usePointerDrag';
import {
  columnDragSpan, columnSel, fieldDragRect, fieldSel, fieldSnapOthers, formTouchAction, ptToScreenPx, rowMmCapped, rowMmFromDrag, rowMmKeyDelta, selColumn,
  selField, tableDragY, touchMayDrag, type ColumnEdge, type FormSel,
} from './formCanvasMath';

export interface FormCanvasProps {
  form: PrintForm;
  paper: FormPaper;
  /** النموذج بعد تعديلٍ واحد (سحبٌ أُفلت، أو سهم، أو حذف) — سجلّ تراجعٍ واحد */
  onChange(next: PrintForm): void;
  selected: FormSel | null;
  onSelect(s: FormSel | null): void;
  /** 0 = ملء العرض، وغيره مقياسٌ ثابت (1 = 100٪) */
  zoom: number;
  /** edit: التحرير بالسحب · calibrate: المواضع المطبوعة (+ dx/dy) متقطّعةً بلا تحرير */
  mode?: 'edit' | 'calibrate';
  /** «إزالة الضريبة» (شركةٌ بلا ضريبة): لا يُرسم حقل رمز QR — لا رمز على مستنداتها */
  hideQr?: boolean;
}

/**
 * طبقات اللوحة: الجدول (2) < الحقل وشريط العمود (3) < لسان الجدول ومقبضه (4) < المحدَّد ومقابضه (6) < خطوط الالتقاط (9). غلاف الجدول
 * بلا z-index (لا سياق تكديسٍ له) فتتنافس أبناؤه — اللسان والمقبض والعمود المحدَّد — مع الحقول في سياق الورقة نفسه.
 */
export const FORM_TABLE_Z = 2;
export const FORM_FIELD_Z = 3;
export const FORM_GRIP_Z = 4;
export const FORM_SEL_Z = 6;

const HANDLE_PX = 12;
const HANDLE_POS: Readonly<Record<Handle, { left: string; top: string; cursor: string }>> = Object.freeze({
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' }, n: { left: '50%', top: '0%', cursor: 'ns-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' }, e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' }, s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' }, w: { left: '0%', top: '50%', cursor: 'ew-resize' },
});
/** تسميات المقابض — النصوص نفسها في لوحة المصمّم الحرّ (مترجمة) */
const HANDLE_LABELS: Readonly<Record<Handle, string>> = Object.freeze({
  nw: 'تغيير الحجم من الزاوية العليا اليسرى', n: 'تغيير الحجم من الأعلى', ne: 'تغيير الحجم من الزاوية العليا اليمنى',
  e: 'تغيير الحجم من اليمين', se: 'تغيير الحجم من الزاوية السفلى اليمنى', s: 'تغيير الحجم من الأسفل',
  sw: 'تغيير الحجم من الزاوية السفلى اليسرى', w: 'تغيير الحجم من اليسار',
});

/** محاذاة القيمة في صندوقها على الورقة (start = يمين الصندوق كالورقة العربية) */
export const formTextAlign = (a: FormField['align']): 'left' | 'center' | 'right' => (a === 'center' ? 'center' : a === 'end' ? 'left' : 'right');

// ─── اللوحة ───

type LiveField = { id: FormFieldId; rect: Rect; guides: Guide[] };
type LiveCol = { id: FormColumn['id']; x: number; w: number; guide: number | null };
type LiveTable = { y: number; rowMm: number };

export default function FormCanvas({ form, paper, onChange, selected, onSelect, zoom, mode = 'edit', hideQr = false }: FormCanvasProps) {
  const tr = useTr();
  const begin = usePointerDrag();
  const [coarse] = useState(isCoarsePointer);
  const hit = handleHitPx(coarse);
  const sheet = useMemo(() => formSheetSize(paper), [paper]);
  // صورة النموذج للشاشة وحدها: مُحمِّل صور النموذج المشترك (ذاكرةٌ بالبصمة مع المعاينة والطباعة) — والفشل لا يمنع التصميم
  const img = useFormImage(form.image);
  const edit = mode === 'edit';

  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [liveField, setLiveField] = useState<LiveField | null>(null);
  const [liveCol, setLiveCol] = useState<LiveCol | null>(null);
  const [liveTable, setLiveTable] = useState<LiveTable | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = (): void => setBoxW(box.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const sheetPxW = sheet.widthMm * PX_PER_MM;
  const scale = zoom > 0 ? zoom : boxW > 0 ? Math.min(1, Math.max(0.2, (boxW - 8) / sheetPxW)) : 0.5;
  const mm = (v: number): number => v * PX_PER_MM * scale;
  // المعفى (hideQr): مربع QR لا يُرسم — فلا يُحسب في التداخل ولا يلتقط الحقول بحوافّ لا تُرى (كـformWarnings)
  const shown = useMemo(() => (hideQr ? { ...form, fields: form.fields.filter((f) => f.id !== 'qr') } : form), [form, hideQr]);
  const overlapIds = useMemo(() => {
    const s = new Set<string>();
    for (const [a, b] of formOverlaps(shown)) { s.add(a); s.add(b); }
    return s;
  }, [shown]);
  const fields = shown.fields;
  const selF = selField(selected);
  const selC = selColumn(selected);

  // ─── السحب ───

  const fieldDrag = (e: ReactPointerEvent, f: FormField, h: Handle | null): void => {
    // إصبعٌ على حقلٍ غير محدَّد: تمريرٌ (pan-y) أو نقرةٌ تحدّده (onClick) — لا سحب
    if (h === null && !touchMayDrag(e.pointerType, selF === f.id)) return;
    const start: Rect = { x: f.x, y: f.y, w: f.w, h: f.h };
    const others = fieldSnapOthers(shown, f.id);
    const at = (dx: number, dy: number) => fieldDragRect(start, h, dx / PX_PER_MM / scale, dy / PX_PER_MM / scale, others, sheet, f.id);
    onSelect(fieldSel(f.id));
    begin(e, {
      onMove: (dx, dy) => { const r = at(dx, dy); setLiveField({ id: f.id, rect: r.rect, guides: r.guides }); },
      onCommit: (dx, dy) => { const r = at(dx, dy); setLiveField(null); onChange(withFormField(form, paper, { id: f.id, ...r.rect })); },
      onCancel: () => setLiveField(null),
    });
  };

  const onFieldKey = (e: ReactKeyboardEvent, id: FormFieldId): void => {
    const d = keyDelta(e.key, e);
    if (d) { e.preventDefault(); onChange(moveFormField(form, paper, id, d.dx, d.dy, d.resize)); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onChange(withoutFormField(form, id)); onSelect(null); }
  };

  const colDrag = (e: ReactPointerEvent, c: FormColumn, edge: ColumnEdge): void => {
    const t = form.table;
    if (!t) return;
    if (edge === 'move' && !touchMayDrag(e.pointerType, selC === c.id)) return;
    const others = t.columns.filter((o) => o.id !== c.id).map((o) => ({ x: o.x, w: o.w }));
    const at = (dx: number) => columnDragSpan({ x: c.x, w: c.w }, edge, dx / PX_PER_MM / scale, others, sheet.widthMm);
    onSelect(columnSel(c.id));
    begin(e, {
      onMove: (dx) => { const s = at(dx); setLiveCol({ id: c.id, x: s.x, w: s.w, guide: s.guide }); },
      onCommit: (dx) => { const s = at(dx); setLiveCol(null); onChange(withFormColumn(form, paper, { id: c.id, x: s.x, w: s.w })); },
      onCancel: () => setLiveCol(null),
    });
  };

  const onColKey = (e: ReactKeyboardEvent, id: FormColumn['id']): void => {
    const d = keyDelta(e.key, e);
    if (d && d.dx !== 0) { e.preventDefault(); onChange(moveFormColumn(form, paper, id, d.dx, d.resize)); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = withoutFormColumn(form, id);
      if (next !== form) { onChange(next); onSelect('table'); }
    }
  };

  const tableDrag = (e: ReactPointerEvent): void => {
    const t = form.table;
    if (!t) return;
    onSelect('table');
    const yAt = (dy: number): number => tableDragY(t.y, dy / PX_PER_MM / scale, t.rows, t.rowMm, sheet.lengthMm);
    begin(e, {
      onMove: (_dx, dy) => setLiveTable({ y: yAt(dy), rowMm: t.rowMm }),
      onCommit: (_dx, dy) => { const y = yAt(dy); setLiveTable(null); onChange(withFormTable(form, paper, { y })); },
      onCancel: () => setLiveTable(null),
    });
  };

  const rowGripDrag = (e: ReactPointerEvent): void => {
    const t = form.table;
    if (!t) return;
    onSelect('table');
    const rAt = (dy: number): number => rowMmFromDrag(t.rowMm, t.rows, t.y, dy / PX_PER_MM / scale, sheet.lengthMm);
    begin(e, {
      onMove: (_dx, dy) => setLiveTable({ y: t.y, rowMm: rAt(dy) }),
      onCommit: (_dx, dy) => { const rowMm = rAt(dy); setLiveTable(null); onChange(withFormTable(form, paper, { rowMm })); },
      onCancel: () => setLiveTable(null),
    });
  };

  const onTableKey = (e: ReactKeyboardEvent): void => {
    const d = keyDelta(e.key, e);
    if (d && d.dy !== 0 && !d.resize) { e.preventDefault(); onChange(moveFormTable(form, paper, d.dy)); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onChange(withFormTable(form, paper, null)); onSelect(null); }
  };

  const onRowGripKey = (e: ReactKeyboardEvent): void => {
    const t = form.table;
    const d = rowMmKeyDelta(e.key, e.shiftKey);
    if (!t || d === null) return;
    e.preventDefault();
    // بحدّ ما يُبقي الصفوف كما هي (كالسحب) — لا يُنقص withFormTable عددها بصمت عند أسفل الورقة
    onChange(withFormTable(form, paper, { rowMm: rowMmCapped(t.rowMm + d, t.rows, t.y, sheet.lengthMm) }));
  };

  // ─── الرسم ───

  const valueText = (label: string, fontPct: number | undefined, align: FormField['align'], bold?: boolean) => (
    <span className="block w-full overflow-hidden px-0.5 text-[#1F1A13]/70" style={{
      fontSize: ptToScreenPx(formFontPt(fontPct), scale), fontWeight: bold ? 700 : 400, textAlign: formTextAlign(align),
      whiteSpace: 'nowrap', textOverflow: 'ellipsis', lineHeight: 1.15,
    }}>{label}</span>
  );

  const renderField = (f: FormField) => {
    const isLive = liveField?.id === f.id;
    const r = isLive ? liveField.rect : { x: f.x, y: f.y, w: f.w, h: f.h };
    const isSel = selF === f.id;
    const over = overlapIds.has(f.id);
    const label = tr(FORM_FIELD_LABELS[f.id]);
    return (
      <div key={f.id} data-form-field={f.id} className="absolute" style={{
        left: mm(r.x), top: mm(r.y), width: mm(r.w), height: mm(r.h), zIndex: isSel ? FORM_SEL_Z : FORM_FIELD_Z,
      }}>
        <button type="button" aria-label={`${label} — ${tr('اسحب للنقل والأسهم للتحريك')}`} aria-pressed={isSel}
          onPointerDown={(e) => fieldDrag(e, f, null)}
          onClick={() => { if (!isSel) onSelect(fieldSel(f.id)); }}
          onKeyDown={(e) => onFieldKey(e, f.id)}
          onFocus={() => { if (!isSel) onSelect(fieldSel(f.id)); }}
          className="absolute inset-0 w-full h-full flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E88E5]"
          style={{
            touchAction: formTouchAction(isSel), cursor: 'move', borderRadius: 2,
            background: isSel ? 'rgba(225,90,48,0.12)' : over ? 'rgba(245,158,11,0.14)' : 'rgba(30,136,229,0.08)',
            border: isSel ? '2px solid #E15A30' : over ? '1px solid #D97706' : '1px solid rgba(30,136,229,0.65)',
          }}>
          {valueText(label, f.fontPct, f.align, f.bold)}
        </button>
        {isSel && HANDLES.map((h) => (
          <button type="button" key={h} aria-label={tr(HANDLE_LABELS[h])} tabIndex={-1}
            onPointerDown={(e) => fieldDrag(e, f, h)}
            onKeyDown={(e) => onFieldKey(e, f.id)}
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
  };

  const renderTable = () => {
    const t = form.table;
    if (!t) return null;
    const y = liveTable?.y ?? t.y;
    const rowMm = liveTable?.rowMm ?? t.rowMm;
    const cols = t.columns.map((c) => (liveCol?.id === c.id ? { ...c, x: liveCol.x, w: liveCol.w } : c));
    const tb = formTableBox({ ...t, columns: cols });
    if (!tb) return null;
    const hMm = t.rows * rowMm;
    const tableSel = selected === 'table';
    const rowPx = mm(rowMm);
    const tabTop = mm(y) >= 22 ? -20 : 0;
    return (
      <div key="table" data-form-table="" className="absolute" style={{ left: 0, top: mm(y), width: mm(sheet.widthMm), height: mm(hMm), pointerEvents: 'none' }}>
        {/* مستطيل الجدول وخطوط صفوفه */}
        <div aria-hidden="true" className="absolute" style={{
          left: mm(tb.x), top: 0, width: mm(tb.w), height: mm(hMm), zIndex: FORM_TABLE_Z,
          outline: `${tableSel ? 2 : 1}px dashed ${tableSel ? '#E15A30' : 'rgba(30,136,229,0.75)'}`,
          backgroundImage: 'linear-gradient(to bottom, rgba(30,136,229,0.35) 1px, transparent 1px)', backgroundSize: `100% ${rowPx}px`,
        }} />
        {cols.map((c) => {
          const isSel = selC === c.id;
          const label = tr(FORM_COLUMN_LABELS[c.id]);
          return (
            <div key={c.id} data-form-column={c.id} className="absolute" style={{ left: mm(c.x), top: 0, width: mm(c.w), height: mm(hMm), zIndex: isSel ? FORM_SEL_Z : FORM_FIELD_Z, pointerEvents: 'auto' }}>
              <button type="button" aria-label={`${label} — ${tr('اسحب العمود أفقيا والأسهم للتحريك')}`} aria-pressed={isSel}
                onPointerDown={(e) => colDrag(e, c, 'move')}
                onClick={() => { if (!isSel) onSelect(columnSel(c.id)); }}
                onKeyDown={(e) => onColKey(e, c.id)}
                onFocus={() => { if (!isSel) onSelect(columnSel(c.id)); }}
                className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E88E5]"
                style={{
                  touchAction: formTouchAction(isSel, true), cursor: 'ew-resize',
                  background: isSel ? 'rgba(225,90,48,0.10)' : 'transparent',
                  borderInlineStart: '1px solid rgba(30,136,229,0.55)', borderInlineEnd: '1px solid rgba(30,136,229,0.55)',
                  outline: isSel ? '2px solid #E15A30' : 'none',
                }}>
                <span className="absolute top-0 inset-x-0 block overflow-hidden text-[#1E5FA8]" style={{
                  height: rowPx, fontSize: ptToScreenPx(formFontPt(t.fontPct), scale) * 0.85, lineHeight: `${rowPx}px`,
                  textAlign: formTextAlign(c.align), whiteSpace: 'nowrap', textOverflow: 'ellipsis', padding: '0 1px',
                }}>{label}</span>
              </button>
              {isSel && (['w', 'e'] as const).map((edge) => (
                <button type="button" key={edge} aria-label={edge === 'w' ? tr('عرض العمود من اليسار') : tr('عرض العمود من اليمين')} tabIndex={-1}
                  onPointerDown={(e) => colDrag(e, c, edge)}
                  onKeyDown={(e) => onColKey(e, c.id)}
                  className="absolute top-0 bottom-0 flex items-center justify-center"
                  style={{ left: edge === 'w' ? 0 : '100%', width: hit, transform: 'translateX(-50%)', cursor: 'ew-resize', touchAction: 'none', zIndex: 7 }}>
                  <span aria-hidden="true" className="block bg-white border-2 border-[#E15A30] rounded-[3px]" style={{ width: 6, height: Math.min(28, Math.max(12, mm(hMm) / 6)) }} />
                </button>
              ))}
            </div>
          );
        })}
        {liveCol && liveCol.guide !== null && (
          <div aria-hidden="true" className="absolute bg-[#1E88E5]" style={{ left: mm(liveCol.guide), top: 0, bottom: 0, width: 1, zIndex: 9 }} />
        )}
        {/* لسان الجدول: يسحب الكتلة رأسياً ويحدّدها */}
        <button type="button" aria-label={`${tr('جدول الأصناف')} — ${tr('اسحب الجدول رأسيا والأسهم للتحريك')}`} aria-pressed={tableSel}
          onPointerDown={tableDrag}
          onKeyDown={onTableKey}
          onFocus={() => { if (!tableSel) onSelect('table'); }}
          className={`absolute inline-flex items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E88E5] ${tableSel ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#1E88E5]/60 bg-white/90 text-[#1E5FA8]'}`}
          style={{ left: mm(tb.x), top: tabTop, height: 18, cursor: 'ns-resize', touchAction: 'none', pointerEvents: 'auto', zIndex: FORM_GRIP_Z }}>
          <GripHorizontal className="w-3 h-3" aria-hidden="true" />{tr('جدول الأصناف')}
          <span dir="ltr" className="font-normal">{t.rows} × {rowMm} mm</span>
        </button>
        {/* مقبض ارتفاع الصف: أسفل آخر صف */}
        <button type="button" aria-label={`${tr('ارتفاع الصف')} — ${tr('اسحب حتى يطابق آخر صف في النموذج')}`}
          onPointerDown={rowGripDrag}
          onKeyDown={onRowGripKey}
          className="absolute flex items-center justify-center"
          style={{ left: mm(tb.x + tb.w / 2) - 24, top: mm(hMm) - hit / 2, width: 48, height: hit, cursor: 'ns-resize', touchAction: 'none', pointerEvents: 'auto', zIndex: FORM_GRIP_Z }}>
          <span aria-hidden="true" className="block w-10 h-1.5 rounded-full bg-[#E15A30]/80" />
        </button>
      </div>
    );
  };

  /** وضع المعايرة: ما يُطبع فعلاً (+ dx/dy) متقطّعاً بلا تحرير */
  const renderPrinted = () => {
    const t = form.table;
    const tb = formTableBox(t);
    return (
      <div aria-hidden="true" className="absolute inset-0" style={{ pointerEvents: 'none' }} data-form-printed="">
        {fields.map((f) => {
          const b = printedBox(form, f);
          return (
            <div key={f.id} className="absolute flex items-center" style={{
              left: mm(b.x), top: mm(b.y), width: mm(b.w), height: mm(b.h), border: '1px dashed #E15A30', background: 'rgba(225,90,48,0.06)', zIndex: FORM_FIELD_Z,
            }}>
              {valueText(tr(FORM_FIELD_LABELS[f.id]), f.fontPct, f.align, f.bold)}
            </div>
          );
        })}
        {t && tb && (() => {
          const at = printedBox(form, tb);
          return (
            <div className="absolute" style={{
              left: mm(at.x), top: mm(at.y), width: mm(tb.w), height: mm(tb.h), border: '1px dashed #E15A30', zIndex: FORM_TABLE_Z,
              backgroundImage: 'linear-gradient(to bottom, rgba(225,90,48,0.35) 1px, transparent 1px)', backgroundSize: `100% ${mm(t.rowMm)}px`,
            }}>
              {t.columns.map((c) => (
                <div key={c.id} className="absolute top-0 bottom-0" style={{ left: mm(c.x - tb.x), width: mm(c.w), borderInlineStart: '1px dashed rgba(225,90,48,0.6)', borderInlineEnd: '1px dashed rgba(225,90,48,0.6)' }} />
              ))}
            </div>
          );
        })()}
      </div>
    );
  };

  const fiveMm = mm(5);
  return (
    <div className="w-full">
      <div ref={boxRef} className="w-full overflow-auto" data-designer="form">
        <div className="relative mx-auto bg-white" data-form-sheet=""
          style={{ width: mm(sheet.widthMm), height: mm(sheet.lengthMm), boxShadow: '0 1px 6px rgba(31,26,19,0.18)', border: '1px solid #E9E1D3' }}
          onPointerDown={(e) => { if (e.target === e.currentTarget && edit) onSelect(null); }}>
          {img.src ? (
            <img src={img.src} alt="" aria-hidden="true" data-form-image="" className="absolute inset-0 w-full h-full select-none"
              style={{ pointerEvents: 'none', objectFit: 'fill', opacity: 0.9 }} />
          ) : (
            <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
              <span className="max-w-[70%] text-center text-[11px] leading-relaxed text-[#B5A897] flex flex-col items-center gap-1">
                {img.status === 'failed' && <ImageOff className="w-5 h-5" aria-hidden="true" />}
                {img.status === 'loading' ? tr('جار تحميل صورة النموذج') : img.status === 'failed' ? tr('تعذر تحميل صورة النموذج — ارفعها من جديد') : tr(FORM_WARNINGS.imageMissing)}
              </span>
            </div>
          )}
          {/* شبكة 5 مم للشاشة وحدها */}
          <div aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{
            backgroundImage: 'linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)',
            backgroundSize: `${fiveMm}px ${fiveMm}px`,
          }} />
          {edit ? (
            <>
              {renderTable()}
              {/* الأصغر مساحةً يُرسم آخراً فيعلو: حقلٌ فوق أكبر منه يبقى قابلاً للنقر والسحب */}
              {[...fields].sort((a, b) => b.w * b.h - a.w * a.h).map(renderField)}
              {liveField && liveField.guides.map((g, i) => (
                <div key={i} aria-hidden="true" className="absolute bg-[#1E88E5]" style={g.axis === 'x'
                  ? { left: mm(g.at), top: 0, bottom: 0, width: 1, zIndex: 9 }
                  : { top: mm(g.at), left: 0, right: 0, height: 1, zIndex: 9 }} />
              ))}
            </>
          ) : renderPrinted()}
        </div>
      </div>
      {edit && overlapIds.size > 0 && (
        <p className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-center gap-1" role="note">
          <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />{tr(FORM_WARNINGS.overlap)}
        </p>
      )}
      {edit && (
        <p className="mt-2 text-[11px] text-[#9A8F7E]">{tr('اسحب الحقول إلى فراغات النموذج — الأسهم تحرك نصف ملم وShift خمسة وAlt يغير الحجم وDelete يحذف')}</p>
      )}
    </div>
  );
}
