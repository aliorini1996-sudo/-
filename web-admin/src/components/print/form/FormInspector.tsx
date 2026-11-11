/**
 * «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — مفتّش مصمّم النموذج: أدوات العنصر المحدَّد في اللوحة
 *
 * - حقل: الموضع والمقاس بالمم، والمحاذاة، وحجم الخط بالنسبة، والعريض، والحذف.
 * - جدول الأصناف: أعلاه وارتفاع الصف وعدد الصفوف لكل ورقة وحجم الخط، وأعمدته (إضافة وحذف وترتيب)، وحذف الجدول.
 * - عمود: موضعه وعرضه ومحاذاته وترتيبه وحذفه.
 * - بلا تحديد: لوحة الحقول بمجموعاتها (إضافة وحذف)، وصورة النموذج، و«طباعة الخلفية» والأرقام ولغة القيم، و«اقتراح مواضع افتراضية»،
 *   و«حذف رمز QR من المطبوعة»، والتنبيهات (formWarnings).
 * - المعايرة: إزاحة الطابعة الأفقية والرأسية (−20..+20 مم بعُشر مم) وطريقة قياسها.
 *
 * رمز QR لازمٌ ما لم تحذفه الشركة صراحةً (قاعدة النواة): متى غاب حقله ظهر المساعد «أضف حقل QR» / «لا أحتاج رمز QR» — والثاني
 * دالة الحذف الصريح نفسها (withQrRemoved) بتأكيدها. كل كتابةٍ تمرّ بمحرّرات formModel.
 */
import { ArrowLeft, ArrowRight, Bold, ImageUp, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import {
  FORM_BOUNDS, FORM_COLUMN_IDS, FORM_COLUMN_LABELS, FORM_FIELD_GROUPS, FORM_FIELD_LABELS, FORM_NOTES, FORM_TAX_COLUMN_IDS, FORM_TAX_FIELD_IDS,
  FORM_VALUE_LANGS, FORM_VALUE_LANG_LABELS, formFieldMinMm, formOf, formQrMissing, formSheetSize, formWarnings, isLastSheetField, reorderFormColumn,
  resetFormPositions, withForm, withFormColumn, withFormField, withFormProps, withFormTable, withoutFormColumn, withoutFormField,
  type FormColumnId, type FormFieldId, type PrintForm,
} from '../../../lib/print/formModel';
import { LAYOUT_BOUNDS, QR_REMOVE_ACTION, QR_REMOVE_WARNING, isQrRemoved, layoutOf, type PrintProfile } from '../../../lib/print/printSettings';
import { withQrRemoved } from '../../../lib/print/designModel';
import { AlignChips, NumInput, QrRemoveField, chipCls, clampFontPct } from '../designer/SectionStyleFields';
import { snapGrid } from '../designer/designerMath';
import { useTaxOffPrint } from '../taxOffPrint';
import { columnSel, fieldSel, rowMmCapped, selColumn, selField, type FormSel } from './formCanvasMath';

export interface FormInspectorProps {
  p: PrintProfile;
  update(next: PrintProfile): void;
  selected: FormSel | null;
  onSelect(s: FormSel | null): void;
  /** fields: وضع الحقول · calibrate: المعايرة */
  mode: 'fields' | 'calibrate';
  /** الانتقال إلى خطوة رفع صورة النموذج */
  onUpload?(): void;
}

export const FORM_RESET_CONFIRM = 'تستبدل مواضع كل الحقول والجدول بالمواضع المقترحة — متابعة؟';
export const FORM_QR_MISSING_NOTE = 'النموذج بلا حقل لرمز QR';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
/** معايرة الطابعة: −20..+20 مم بعُشر مم */
export const clampOffsetMm = (v: number): number => round1(clamp(v, FORM_BOUNDS.offsetMm[0], FORM_BOUNDS.offsetMm[1]));

const head = 'text-sm font-bold text-[#1F1A13] mb-2 flex items-center gap-2';
const row = 'flex flex-wrap items-center gap-2 py-1';
const lab = 'text-[11px] text-[#6E6557] min-w-[72px]';
const linkBtn = 'inline-flex items-center gap-1 text-[11px] text-[#6E6557] hover:text-[#C94E28] disabled:opacity-40';
const iconBtn = 'inline-flex items-center justify-center rounded-md border border-[#E9E1D3] bg-white w-6 h-6 text-[#44403a] hover:border-[#E15A30] disabled:opacity-40';
const NOTE_RED = 'text-[11px] text-[#8E2A1F] bg-[#FBEBE2] rounded px-2 py-1';

export default function FormInspector({ p, update, selected, onSelect, mode, onUpload }: FormInspectorProps) {
  const tr = useTr();
  const taxOff = useTaxOffPrint();
  const form = formOf(p);
  if (!form) return null;
  const setForm = (next: PrintForm): void => update(withForm(p, next));
  if (mode === 'calibrate') return <CalibrationPanel form={form} setForm={setForm} />;

  const fid = selField(selected);
  const field = fid ? form.fields.find((f) => f.id === fid) : undefined;
  const cid = selColumn(selected);
  const column = cid ? form.table?.columns.find((c) => c.id === cid) : undefined;
  return (
    <div className="space-y-3">
      <QrHelper p={p} update={update} form={form} taxOff={taxOff} onSelect={onSelect} />
      {selected !== null && (
        <button type="button" onClick={() => onSelect(null)} className={linkBtn}>{tr('كل العناصر')}</button>
      )}
      {field ? <FieldPanel p={p} form={form} setForm={setForm} id={field.id} onSelect={onSelect} />
        : column ? <ColumnPanel p={p} form={form} setForm={setForm} id={column.id} onSelect={onSelect} />
          : selected === 'table' && form.table ? <TablePanel p={p} form={form} setForm={setForm} onSelect={onSelect} taxOff={taxOff} />
            : <FormPanel p={p} update={update} form={form} setForm={setForm} onSelect={onSelect} onUpload={onUpload} taxOff={taxOff} />}
    </div>
  );
}

/** رمز QR لازمٌ وغاب حقله: «أضف حقل QR» أو الحذف الصريح بتأكيده (وبلا تأكيدٍ ولا إضافةٍ لشركةٍ بلا ضريبة — لا رمز على مستنداتها) */
function QrHelper({ p, update, form, taxOff, onSelect }: { p: PrintProfile; update(next: PrintProfile): void; form: PrintForm; taxOff: boolean; onSelect(s: FormSel | null): void }) {
  const tr = useTr();
  if (!formQrMissing(p)) return null;
  const addQr = (): void => {
    update(withForm(p, withFormField(form, p.paper, { id: 'qr' })));
    onSelect(fieldSel('qr'));
  };
  const noQr = (): void => {
    if (!taxOff && !window.confirm(`${tr(QR_REMOVE_ACTION)}\n${tr(QR_REMOVE_WARNING)}`)) return;
    update(withQrRemoved(p, true));
  };
  return (
    <div role="alert" data-form-qr-missing="" className="rounded-lg border border-[#E15A30]/50 bg-[#FBEBE2] px-2.5 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-[#8E2A1F]">{tr(FORM_QR_MISSING_NOTE)}</p>
      <div className="flex flex-wrap gap-1.5">
        {!taxOff && (
          <button type="button" onClick={addQr} className="btn-primary !py-1 !px-2.5 text-[11px] inline-flex items-center gap-1">
            <Plus className="w-3 h-3" aria-hidden="true" />{tr('أضف حقل QR')}
          </button>
        )}
        <button type="button" onClick={noQr} className="btn-secondary !py-1 !px-2.5 text-[11px]">{tr('لا أحتاج رمز QR')}</button>
      </div>
    </div>
  );
}

/** حجم الخط: منزلقة وخانة (70–160٪) — undefined يعيد 100 */
function FontRow({ value, onCommit }: { value: number | undefined; onCommit(v: number): void }) {
  const tr = useTr();
  const v = typeof value === 'number' && Number.isFinite(value) ? value : 100;
  return (
    <div className={row}>
      <span className={lab}>{tr('حجم الخط')}</span>
      <input type="range" min={LAYOUT_BOUNDS.fontPct[0]} max={LAYOUT_BOUNDS.fontPct[1]} step={5} value={v}
        aria-label={tr('حجم الخط')} className="w-24 accent-[#E15A30]" style={{ touchAction: 'pan-y' }}
        onChange={(e) => onCommit(clampFontPct(Number(e.target.value)))} />
      <NumInput value={v} clampFn={clampFontPct} label={tr('حجم الخط')} suffix="%" width={56} onCommit={onCommit} />
    </div>
  );
}

function FieldPanel({ p, form, setForm, id, onSelect }: { p: PrintProfile; form: PrintForm; setForm(f: PrintForm): void; id: FormFieldId; onSelect(s: FormSel | null): void }) {
  const tr = useTr();
  const f = form.fields.find((x) => x.id === id);
  if (!f) return null;
  const S = formSheetSize(p.paper);
  const min = formFieldMinMm(id);
  const set = (patch: Parameters<typeof withFormField>[2]): void => setForm(withFormField(form, p.paper, patch));
  return (
    <div data-form-inspector={`field:${id}`}>
      <h3 className={head}>{tr(FORM_FIELD_LABELS[id])}</h3>
      <div className={row}>
        <span className={lab}>{tr('الموضع')}</span>
        <NumInput value={f.x} label={tr('من اليسار')} suffix="x" clampFn={(v) => snapGrid(clamp(v, 0, S.widthMm - f.w))} onCommit={(x) => set({ id, x })} />
        <NumInput value={f.y} label={tr('من الأعلى')} suffix="y" clampFn={(v) => snapGrid(clamp(v, 0, S.lengthMm - f.h))} onCommit={(y) => set({ id, y })} />
      </div>
      <div className={row}>
        <span className={lab}>{tr('المقاس')}</span>
        <NumInput value={f.w} label={tr('العرض')} suffix="w" clampFn={(v) => snapGrid(clamp(v, min, S.widthMm))} onCommit={(w) => set({ id, w })} />
        <NumInput value={f.h} label={tr('الارتفاع')} suffix="h" clampFn={(v) => snapGrid(clamp(v, min, S.lengthMm))} onCommit={(h) => set({ id, h })} />
        <span className="text-[11px] text-[#9A8F7E]" dir="ltr">mm</span>
      </div>
      <div className={row}>
        <span className={lab}>{tr('المحاذاة')}</span>
        <AlignChips value={f.align ?? null} allowAuto label={tr('المحاذاة')} onChange={(a) => set({ id, align: a ?? undefined })} />
      </div>
      <FontRow value={f.fontPct} onCommit={(v) => set({ id, fontPct: v === 100 ? undefined : v })} />
      <div className={row}>
        <span className={lab}>{tr('خط عريض')}</span>
        <button type="button" aria-pressed={f.bold === true} onClick={() => set({ id, bold: f.bold ? undefined : true })} className={`${chipCls(f.bold === true)} inline-flex items-center gap-1`}>
          <Bold className="w-3 h-3" aria-hidden="true" />{f.bold ? tr('عريض') : tr('عادي')}
        </button>
      </div>
      <ul className="mt-1 space-y-0.5 text-[11px] text-[#9A8F7E] list-none">
        <li>{isLastSheetField(id) ? tr('يطبع في الورقة الأخيرة وحدها') : tr('يتكرر في كل ورقة')}</li>
        {id === 'qr' && <li>{tr('لا يصغر مربع رمز QR عن 18 ملم')}</li>}
        {FORM_TAX_FIELD_IDS.includes(id) && <li>{tr(FORM_NOTES.taxFree)}</li>}
      </ul>
      <div className="mt-2 pt-2 border-t border-[#F1EBDF]">
        <button type="button" onClick={() => { setForm(withoutFormField(form, id)); onSelect(null); }} className="inline-flex items-center gap-1 text-[11px] text-[#B42318] hover:underline">
          <Trash2 className="w-3 h-3" aria-hidden="true" />{tr('حذف الحقل')}
        </button>
      </div>
    </div>
  );
}

/** أعمدة الجدول من اليسار مع أزرار الترتيب (← يسار، → يمين) والحذف — والعمود الأخير لا يُحذف */
function ColumnsList({ p, form, setForm, onSelect, taxOff }: { p: PrintProfile; form: PrintForm; setForm(f: PrintForm): void; onSelect(s: FormSel | null): void; taxOff: boolean }) {
  const tr = useTr();
  const t = form.table;
  if (!t) return null;
  const cols = [...t.columns].sort((a, b) => a.x - b.x);
  const placed = new Set(cols.map((c) => c.id));
  const addable = FORM_COLUMN_IDS.filter((id) => !placed.has(id) && !(taxOff && FORM_TAX_COLUMN_IDS.includes(id)));
  const full = cols.length >= FORM_BOUNDS.columns[1];
  return (
    <div className="space-y-1.5" data-form-columns="">
      <span className="block text-xs font-bold text-[#1F1A13]">{tr('أعمدة الجدول')} <span className="font-normal text-[#9A8F7E]">({tr('من اليسار إلى اليمين')})</span></span>
      <ol className="space-y-1 list-none">
        {cols.map((c, i) => (
          <li key={c.id} className="flex items-center gap-1">
            <button type="button" onClick={() => onSelect(columnSel(c.id))} className={`${chipCls(false)} flex-1 text-start truncate`}>
              {tr(FORM_COLUMN_LABELS[c.id])} <span dir="ltr" className="font-normal text-[#9A8F7E]">{c.w} mm</span>
            </button>
            <button type="button" aria-label={tr('انقل العمود يسارا')} title={tr('انقل العمود يسارا')} disabled={i === 0}
              onClick={() => setForm(reorderFormColumn(form, p.paper, c.id, i - 1))} className={iconBtn}>
              <ArrowLeft className="w-3 h-3" aria-hidden="true" />
            </button>
            <button type="button" aria-label={tr('انقل العمود يمينا')} title={tr('انقل العمود يمينا')} disabled={i === cols.length - 1}
              onClick={() => setForm(reorderFormColumn(form, p.paper, c.id, i + 1))} className={iconBtn}>
              <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </button>
            <button type="button" aria-label={tr('حذف العمود')} title={tr('حذف العمود')} disabled={cols.length <= 1}
              onClick={() => setForm(withoutFormColumn(form, c.id))} className={iconBtn}>
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-[#9A8F7E]">{tr('تغيير الترتيب يرص الأعمدة متلاصقة — اضبطها بعده بالسحب')}</p>
      {addable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={tr('أضف عمودا')}>
          <span className="text-[11px] text-[#6E6557]">{tr('أضف عمودا')}:</span>
          {addable.map((id) => (
            <button type="button" key={id} disabled={full} onClick={() => { setForm(withFormColumn(form, p.paper, { id })); onSelect(columnSel(id)); }}
              className="inline-flex items-center gap-0.5 rounded-full border border-[#E9E1D3] bg-white px-2 py-0.5 text-[11px] text-[#44403a] hover:border-[#E15A30] disabled:opacity-40">
              <Plus className="w-3 h-3" aria-hidden="true" />{tr(FORM_COLUMN_LABELS[id])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TablePanel({ p, form, setForm, onSelect, taxOff }: { p: PrintProfile; form: PrintForm; setForm(f: PrintForm): void; onSelect(s: FormSel | null): void; taxOff: boolean }) {
  const tr = useTr();
  const t = form.table;
  if (!t) return null;
  const S = formSheetSize(p.paper);
  const [r0, r1] = FORM_BOUNDS.rows;
  const [h0, h1] = FORM_BOUNDS.rowMm;
  const rowsFit = Math.max(r0, Math.floor((S.lengthMm - t.y) / t.rowMm + 1e-9));
  const set = (patch: Parameters<typeof withFormTable>[2]): void => setForm(withFormTable(form, p.paper, patch));
  return (
    <div data-form-inspector="table" className="space-y-1">
      <h3 className={head}>{tr('جدول الأصناف')}</h3>
      <div className={row}>
        <span className={lab}>{tr('أول صف من الأعلى')}</span>
        <NumInput value={t.y} label={tr('أول صف من الأعلى')} suffix="mm" clampFn={(v) => snapGrid(clamp(v, 0, Math.max(0, S.lengthMm - t.rows * t.rowMm)))} onCommit={(y) => set({ y })} />
      </div>
      <div className={row}>
        <span className={lab}>{tr('ارتفاع الصف')}</span>
        {/* بحدّ ما يُبقي «صفوف كل ورقة» كما هي (كسحب المقبض) — لا يُنقصها withFormTable بصمت عند أسفل الورقة */}
        <NumInput value={t.rowMm} label={tr('ارتفاع الصف')} suffix="mm" clampFn={(v) => rowMmCapped(round2(clamp(v, h0, h1)), t.rows, t.y, S.lengthMm)} onCommit={(rowMm) => set({ rowMm })} />
      </div>
      <div className={row}>
        <span className={lab}>{tr('صفوف كل ورقة')}</span>
        <NumInput value={t.rows} label={tr('صفوف كل ورقة')} clampFn={(v) => clamp(Math.round(v), r0, Math.min(r1, rowsFit))} onCommit={(rows) => set({ rows })} />
      </div>
      <p className="text-[11px] text-[#9A8F7E]">{tr('الأصناف الزائدة عن صفوف الجدول تكمل في ورقة تالية برأسها')}</p>
      <FontRow value={t.fontPct} onCommit={(v) => set({ fontPct: v === 100 ? undefined : v })} />
      <div className="pt-2 border-t border-[#F1EBDF]">
        <ColumnsList p={p} form={form} setForm={setForm} onSelect={onSelect} taxOff={taxOff} />
      </div>
      <div className="mt-2 pt-2 border-t border-[#F1EBDF]">
        <button type="button" onClick={() => { setForm(withFormTable(form, p.paper, null)); onSelect(null); }} className="inline-flex items-center gap-1 text-[11px] text-[#B42318] hover:underline">
          <Trash2 className="w-3 h-3" aria-hidden="true" />{tr('حذف جدول الأصناف')}
        </button>
      </div>
    </div>
  );
}

function ColumnPanel({ p, form, setForm, id, onSelect }: { p: PrintProfile; form: PrintForm; setForm(f: PrintForm): void; id: FormColumnId; onSelect(s: FormSel | null): void }) {
  const tr = useTr();
  const t = form.table;
  const c = t?.columns.find((x) => x.id === id);
  if (!t || !c) return null;
  const S = formSheetSize(p.paper);
  const cols = [...t.columns].sort((a, b) => a.x - b.x);
  const i = cols.findIndex((x) => x.id === id);
  const set = (patch: Parameters<typeof withFormColumn>[2]): void => setForm(withFormColumn(form, p.paper, patch));
  return (
    <div data-form-inspector={`col:${id}`}>
      <h3 className={head}>{tr(FORM_COLUMN_LABELS[id])} <span className="text-[11px] font-normal text-[#9A8F7E]">· {tr('عمود في جدول الأصناف')}</span></h3>
      <div className={row}>
        <span className={lab}>{tr('الموضع')}</span>
        <NumInput value={c.x} label={tr('من اليسار')} suffix="x" clampFn={(v) => snapGrid(clamp(v, 0, S.widthMm - c.w))} onCommit={(x) => set({ id, x })} />
        <NumInput value={c.w} label={tr('العرض')} suffix="w" clampFn={(v) => snapGrid(clamp(v, FORM_BOUNDS.columnMinMm, S.widthMm))} onCommit={(w) => set({ id, w })} />
        <span className="text-[11px] text-[#9A8F7E]" dir="ltr">mm</span>
      </div>
      <div className={row}>
        <span className={lab}>{tr('المحاذاة')}</span>
        <AlignChips value={c.align ?? null} allowAuto label={tr('المحاذاة')} onChange={(a) => set({ id, align: a ?? undefined })} />
      </div>
      <div className={row}>
        <span className={lab}>{tr('الترتيب')}</span>
        <button type="button" aria-label={tr('انقل العمود يسارا')} title={tr('انقل العمود يسارا')} disabled={i <= 0}
          onClick={() => setForm(reorderFormColumn(form, p.paper, id, i - 1))} className={iconBtn}>
          <ArrowLeft className="w-3 h-3" aria-hidden="true" />
        </button>
        <button type="button" aria-label={tr('انقل العمود يمينا')} title={tr('انقل العمود يمينا')} disabled={i >= cols.length - 1}
          onClick={() => setForm(reorderFormColumn(form, p.paper, id, i + 1))} className={iconBtn}>
          <ArrowRight className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>
      {FORM_TAX_COLUMN_IDS.includes(id) && <p className="text-[11px] text-[#9A8F7E]">{tr(FORM_NOTES.taxFree)}</p>}
      <div className="mt-2 pt-2 border-t border-[#F1EBDF] flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => onSelect('table')} className={linkBtn}>{tr('جدول الأصناف')}</button>
        <button type="button" disabled={t.columns.length <= 1} onClick={() => { setForm(withoutFormColumn(form, id)); onSelect('table'); }}
          className="inline-flex items-center gap-1 text-[11px] text-[#B42318] hover:underline disabled:opacity-40 disabled:no-underline">
          <Trash2 className="w-3 h-3" aria-hidden="true" />{tr('حذف العمود')}
        </button>
      </div>
    </div>
  );
}

function FormPanel({ p, update, form, setForm, onSelect, onUpload, taxOff }: {
  p: PrintProfile; update(next: PrintProfile): void; form: PrintForm; setForm(f: PrintForm): void; onSelect(s: FormSel | null): void; onUpload?(): void; taxOff: boolean;
}) {
  const tr = useTr();
  const qrRemoved = isQrRemoved(layoutOf(p));
  const placed = new Set(form.fields.map((f) => f.id));
  // لا رمز QR بعد حذفه الصريح (يُعاد أولاً)، ولا حقول ضريبة ولا رمز لشركةٍ بلا ضريبة (إلا ما وُضع فيُحذف)
  const offered = (id: FormFieldId): boolean => placed.has(id)
    || !((id === 'qr' && (qrRemoved || taxOff)) || (taxOff && FORM_TAX_FIELD_IDS.includes(id)));
  const { warnings, notes } = formWarnings(p, { taxFree: taxOff });
  const reset = (): void => {
    if (!window.confirm(tr(FORM_RESET_CONFIRM))) return;
    setForm(resetFormPositions(form, p.paper, { withQr: !qrRemoved }));
    onSelect(null);
  };
  return (
    <div className="space-y-3" data-form-inspector="form">
      <div>
        <h3 className={head}>{tr('الحقول')}</h3>
        <p className="text-[11px] text-[#9A8F7E] mb-2">{tr('أضف الحقل ثم اسحبه إلى فراغه في النموذج — والحقل المضاف ينقر لتحديده')}</p>
        <div className="space-y-2">
          {FORM_FIELD_GROUPS.map((g) => {
            const ids = g.ids.filter((id) => offered(id) && !(taxOff && id === 'qr'));
            if (!ids.length) return null;
            return (
              <div key={g.title} role="group" aria-label={tr(g.title)}>
                <span className="block text-[11px] font-semibold text-[#44403a] mb-1">{tr(g.title)}</span>
                <div className="flex flex-wrap gap-1">
                  {ids.map((id) => (placed.has(id) ? (
                    <span key={id} className="inline-flex items-center rounded-full border border-[#E15A30] bg-[#FBEBE2]">
                      <button type="button" aria-pressed="true" onClick={() => onSelect(fieldSel(id))} className="ps-2.5 pe-1 py-0.5 text-[11px] font-semibold text-[#C94E28]">
                        {tr(FORM_FIELD_LABELS[id])}
                      </button>
                      <button type="button" aria-label={`${tr('حذف الحقل')}: ${tr(FORM_FIELD_LABELS[id])}`} title={tr('حذف الحقل')}
                        onClick={() => setForm(withoutFormField(form, id))} className="pe-1.5 py-0.5 text-[#C94E28] hover:text-[#8E2A1F]">
                        <X className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </span>
                  ) : (
                    <button type="button" key={id} aria-pressed="false"
                      onClick={() => { setForm(withFormField(form, p.paper, { id })); onSelect(fieldSel(id)); }}
                      className="inline-flex items-center gap-0.5 rounded-full border border-[#E9E1D3] bg-white px-2 py-0.5 text-[11px] text-[#44403a] hover:border-[#E15A30]">
                      <Plus className="w-3 h-3" aria-hidden="true" />{tr(FORM_FIELD_LABELS[id])}
                    </button>
                  )))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pt-2 border-t border-[#F1EBDF]">
        <h3 className={head}>{tr('جدول الأصناف')}</h3>
        {form.table ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#44403a]">
            <span>
              {tr('أعمدة الجدول')} <b dir="ltr">{form.table.columns.length}</b> · {tr('صفوف كل ورقة')} <b dir="ltr">{form.table.rows}</b>
            </span>
            <button type="button" onClick={() => onSelect('table')} className={chipCls(false)}>{tr('تعديل الجدول')}</button>
          </div>
        ) : (
          <button type="button" onClick={() => { setForm(withFormTable(form, p.paper, {})); onSelect('table'); }}
            className="inline-flex items-center gap-1 rounded-full border border-[#E9E1D3] bg-white px-2.5 py-0.5 text-[11px] text-[#44403a] hover:border-[#E15A30]">
            <Plus className="w-3 h-3" aria-hidden="true" />{tr('أضف جدول الأصناف')}
          </button>
        )}
      </div>

      <div className="pt-2 border-t border-[#F1EBDF] space-y-1.5">
        <h3 className={head}>{tr('صورة النموذج')}</h3>
        <p className="text-[11px] text-[#44403a]">
          {form.image
            ? <>{tr('صورة النموذج مرفوعة')} · <span dir="ltr">{form.image.wPx} × {form.image.hPx} px</span></>
            : tr('لم ترفع صورة النموذج بعد')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {onUpload && (
            <button type="button" onClick={onUpload} className="btn-secondary !py-1 !px-2.5 text-[11px] inline-flex items-center gap-1">
              <ImageUp className="w-3.5 h-3.5" aria-hidden="true" />{form.image ? tr('استبدال الصورة') : tr('رفع صورة النموذج')}
            </button>
          )}
          {form.image && (
            <button type="button" onClick={() => setForm(withFormProps(form, { image: null, background: false }))} className={linkBtn}>
              <X className="w-3 h-3" aria-hidden="true" />{tr('إزالة الصورة')}
            </button>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-[#F1EBDF] space-y-1">
        <h3 className={head}>{tr('خيارات الطباعة')}</h3>
        <label className={`flex items-start gap-2 ${form.image ? 'cursor-pointer' : 'opacity-50'}`}>
          <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={form.background && !!form.image} disabled={!form.image}
            onChange={(e) => setForm(withFormProps(form, { background: e.target.checked }))} />
          <span>
            <span className="block text-xs text-[#1F1A13]">{tr('طباعة الخلفية')}</span>
            <span className="block text-[11px] text-[#9A8F7E]">{tr('ترسم صورة النموذج تحت البيانات — للورق الأبيض والتجربة')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={form.latinDigits}
            onChange={(e) => setForm(withFormProps(form, { latinDigits: e.target.checked }))} />
          <span>
            <span className="block text-xs text-[#1F1A13]">{tr('أرقام لاتينية')} <span dir="ltr">0-9</span></span>
            <span className="block text-[11px] text-[#9A8F7E]">{tr('بدونها تطبع الأرقام بأرقام الشركة')}</span>
          </span>
        </label>
        <div className={row}>
          <span className={lab}>{tr('لغة القيم')}</span>
          <span className="inline-flex flex-wrap gap-1" role="group" aria-label={tr('لغة القيم')}>
            {FORM_VALUE_LANGS.map((v) => (
              <button type="button" key={v} aria-pressed={form.valueLang === v} onClick={() => setForm(withFormProps(form, { valueLang: v }))} className={chipCls(form.valueLang === v)}>
                {tr(FORM_VALUE_LANG_LABELS[v])}
              </button>
            ))}
          </span>
        </div>
        <p className="text-[11px] text-[#9A8F7E]">{tr('لغة طريقة الدفع وعنوان المستند على الورقة')}</p>
      </div>

      <div className="pt-2 border-t border-[#F1EBDF] space-y-2" data-profile-removals="">
        {/* إعادة الرمز (withQrRemoved(p,false)) تعيد حقله في أول موضعٍ فارغ فيُحفظ القالب — فلا تنبيه هنا */}
        <QrRemoveField p={p} update={update} />
      </div>

      <div className="pt-2 border-t border-[#F1EBDF]">
        <button type="button" onClick={reset} className={linkBtn}>
          <RotateCcw className="w-3 h-3" aria-hidden="true" />{tr('اقتراح مواضع افتراضية')}
        </button>
      </div>

      {(warnings.length > 0 || notes.length > 0) && (
        <div className="pt-2 border-t border-[#F1EBDF] space-y-1" data-form-warnings="">
          {warnings.map((w) => <p key={w} className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">{tr(w)}</p>)}
          {notes.map((n) => <p key={n} className="text-[11px] text-[#6E6557]">{tr(n)}</p>)}
        </div>
      )}
    </div>
  );
}

/** المعايرة: إزاحة كل المواضع على هذه الطابعة — تُقاس من «صفحة معايرة النموذج» مطبوعةً على الورق المطبوع مسبقاً */
function CalibrationPanel({ form, setForm }: { form: PrintForm; setForm(f: PrintForm): void }) {
  const tr = useTr();
  const zero = form.dxMm === 0 && form.dyMm === 0;
  return (
    <div className="space-y-3" data-form-inspector="calibrate">
      <h3 className={head}>{tr('المعايرة')}</h3>
      <ol className="list-decimal ps-4 space-y-1 text-[11px] text-[#44403a] leading-relaxed">
        <li>{tr('طبق التصميم ثم اطبع «صفحة معايرة» من «الطباعة على هذا الجهاز» على ورقك المطبوع مسبقا')}</li>
        <li>{tr('اطبع بالحجم الفعلي 100% دون ملاءمة الصفحة')}</li>
        <li>{tr('قس بالمسطرة كم تبعد الإطارات المتقطعة عن فراغات النموذج ثم أدخل الإزاحة هنا')}</li>
      </ol>
      <div className={row}>
        <span className={lab}>{tr('إزاحة أفقية')}</span>
        <NumInput value={form.dxMm} label={tr('إزاحة أفقية')} suffix="mm" clampFn={clampOffsetMm} onCommit={(dxMm) => setForm(withFormProps(form, { dxMm }))} />
        <span className="text-[11px] text-[#9A8F7E]">{tr('الموجب يمينا')}</span>
      </div>
      <div className={row}>
        <span className={lab}>{tr('إزاحة رأسية')}</span>
        <NumInput value={form.dyMm} label={tr('إزاحة رأسية')} suffix="mm" clampFn={clampOffsetMm} onCommit={(dyMm) => setForm(withFormProps(form, { dyMm }))} />
        <span className="text-[11px] text-[#9A8F7E]">{tr('الموجب لأسفل')}</span>
      </div>
      <p className="text-[11px] text-[#9A8F7E]" dir="auto">{tr('من سالب 20 إلى موجب 20 ملم بعشر ملم')}</p>
      <button type="button" disabled={zero} onClick={() => setForm(withFormProps(form, { dxMm: 0, dyMm: 0 }))} className={linkBtn}>
        <RotateCcw className="w-3 h-3" aria-hidden="true" />{tr('تصفير المعايرة')}
      </button>
      <p className="text-[11px] text-[#9A8F7E]">{tr('الإطارات المتقطعة في الورقة هي المواضع المطبوعة بعد الإزاحة')}</p>
    </div>
  );
}
