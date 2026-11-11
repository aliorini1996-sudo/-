/**
 * «تصميم النموذج» — مصمّم «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦: كل شركة ترفع قالبها الجاهز وتضع الحقول على
 * فراغاته فتُطبع البيانات وحدها). نافذةٌ كاملة ببوابة إلى document.body على نمط المصمّم الحرّ: role=dialog، وTab محصور، وEsc يغلق
 * بتأكيدٍ إن وُجد ما لم يُطبَّق، وbeforeunload، وقفل تمرير الصفحة، وعودة التركيز إلى زرّ الفتح.
 *
 * ثلاث خطوات: ١ رفع صورة النموذج الفارغ (FormUploadStep — تصحيح المنظور والقصّ إلى مقاس الورقة، ثم الرفع) ٢ وضع الحقول (FormCanvas
 * بالسحب + FormInspector) ٣ المعايرة (إزاحة الطابعة dx/dy مع المواضع المطبوعة متقطّعةً). يعدّل نسخةً من القالب المفتوح ويعيدها
 * بـonApply عند «تطبيق» — فالحفظ إلى الخادم يبقى زرّ «حفظ إعدادات الطباعة». تراجعٌ وإعادة 50 خطوة، و«إلغاء» يتجاهل كل شيء،
 * و«تطبيق» معطّلٌ ما دامت قواعد النموذج (formIssues) غير مستوفاة.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, Maximize2, Redo2, Undo2, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import { formIssues, formOf, withForm, withFormProps, type FormImageRef, type PrintForm } from '../../../lib/print/formModel';
import type { PrintProfile } from '../../../lib/print/printSettings';
import { pushHistory, redoHistory, undoHistory, type History } from '../designer/designerMath';
import { useTaxOffPrint } from '../taxOffPrint';
import FormCanvas from './FormCanvas';
import FormInspector from './FormInspector';
import FormUploadStep from './FormUploadStep';
import { liveSel, type FormSel } from './formCanvasMath';

export interface FormDesignerProps {
  profile: PrintProfile;
  phase2: boolean;
  company: unknown;
  companyName: string;
  brandColor?: string;
  onApply(next: PrintProfile): void;
  onClose(): void;
}

export type FormStep = 1 | 2 | 3;
export const FORM_STEPS: ReadonlyArray<{ n: FormStep; label: string }> = Object.freeze([
  { n: 1, label: 'رفع صورة النموذج' }, { n: 2, label: 'وضع الحقول' }, { n: 3, label: 'المعايرة' },
] as Array<{ n: FormStep; label: string }>);
/** النصّ نفسه في المصمّم الحرّ (مترجم) */
export const FORM_DISCARD_CONFIRM = 'لديك تغييرات في المصمم لم تطبق — إغلاق دون تطبيق؟';

/** الخطوة الأولى عند الفتح: الرفع ما لم تُرفع صورةٌ بعد، وإلا وضع الحقول */
export const initialFormStep = (p: PrintProfile): FormStep => (formOf(p)?.image ? 2 : 1);

const sameProfile = (a: PrintProfile, b: PrintProfile): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** سجلّ التراجع بلا صورٍ حُذفت من الخادم: القالب الذي يشير إليها يعود بلا صورة — فلا مرجعَ يتيمٌ يُطبَّق ثم يُرفض حفظه */
export function scrubFormImages(h: History<PrintProfile>, gone: ReadonlySet<string>): History<PrintProfile> {
  if (!gone.size) return h;
  const fix = (q: PrintProfile): PrintProfile => {
    const f = formOf(q);
    return f?.image && gone.has(f.image.id) ? withForm(q, withFormProps(f, { image: null })) : q;
  };
  return { past: h.past.map(fix), cur: fix(h.cur), future: h.future.map(fix) };
}

export default function FormDesigner({ profile, onApply, onClose }: FormDesignerProps) {
  const tr = useTr();
  const dir = useDir();
  const taxOff = useTaxOffPrint();
  const [hist, setHist] = useState<History<PrintProfile>>(() => ({ past: [], cur: profile, future: [] }));
  const [step, setStep] = useState<FormStep>(() => initialFormStep(profile));
  const [selected, setSelected] = useState<FormSel | null>(null);
  const [zoom, setZoom] = useState<0 | 1>(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const p = hist.cur;
  const form = formOf(p);
  const sel = liveSel(form, selected);

  const update = useCallback((next: PrintProfile) => setHist((h) => pushHistory(h, next, sameProfile)), []);
  /** النموذج بعد تعديلٍ واحد من اللوحة — على القالب الحالي في السجلّ */
  const setForm = useCallback((next: PrintForm) => setHist((h) => pushHistory(h, withForm(h.cur, next), sameProfile)), []);
  const undo = useCallback(() => setHist(undoHistory), []);
  const redo = useCallback(() => setHist(redoHistory), []);
  const dirty = useMemo(() => !sameProfile(p, profile), [p, profile]);
  /** خطوة الرفع: صورةٌ اختيرت (وأركانٌ وُضعت) ولم تُرفع — يحتاج الإغلاق تأكيداً كأيّ تعديلٍ لم يُطبَّق */
  const [uploadPending, setUploadPending] = useState(false);
  const issues = useMemo(() => formIssues(p), [p]);

  /* صورٌ رفعها هذا المصمّم جديدةً (201): ما لا يحمله الناتج عند الإغلاق يُحذف من الخادم (أفضل جهد) — فلا تملأ تجارب «تصحيح وقص»
   * سقف الشركة (٨). والقائمة بالبصمة نفسها (200) لا تُحذف: قد يحملها قالبٌ آخر. والمحفوظة يحميها الخادم (409) */
  const createdUploads = useRef<Set<string>>(new Set());
  const dropUploads = useCallback((keep: string | null | undefined) => {
    const ids = [...createdUploads.current].filter((id) => id !== keep);
    createdUploads.current.clear();
    if (!ids.length) return;
    void import('../../../api/client')
      .then(({ printFormsApi }) => Promise.all(ids.map((id) => printFormsApi.remove(id).catch(() => undefined))))
      .catch(() => undefined);
  }, []);
  const requestClose = useCallback(() => {
    if ((dirty || (step === 1 && uploadPending)) && !window.confirm(tr(FORM_DISCARD_CONFIRM))) return;
    dropUploads(formOf(profile)?.image?.id);
    onClose();
  }, [dirty, step, uploadPending, onClose, tr, dropUploads, profile]);
  /* سقف الشركة (٨) أثناء الرفع: صور هذه الجلسة التي لا يحملها القالب الحالي (ولا المحفوظ) تُحذف من الخادم وتُمحى من سجلّ التراجع
   * (يعود ما يشير إليها بلا صورة) — ثم تعيد خطوة الرفع المحاولة مرّة. تجارب «تصحيح وقص» المتكرّرة لا تسدّ الرفع إذن */
  const histRef = useRef(hist);
  histRef.current = hist;
  const freeUploads = useCallback(async (): Promise<boolean> => {
    const keep = new Set([formOf(histRef.current.cur)?.image?.id, formOf(profile)?.image?.id].filter((x): x is string => !!x));
    const ids = [...createdUploads.current].filter((id) => !keep.has(id));
    if (!ids.length) return false;
    try {
      const { printFormsApi } = await import('../../../api/client');
      const gone = (await Promise.all(ids.map((id) => printFormsApi.remove(id).then(() => id, () => null)))).filter((x): x is string => !!x);
      if (!gone.length) return false;
      for (const id of gone) createdUploads.current.delete(id);
      const drop = new Set(gone);
      setHist((h) => scrubFormImages(h, drop));
      return true;
    } catch {
      return false;
    }
  }, [profile]);
  const apply = (): void => {
    if (issues.length || !form) return;
    dropUploads(form.image?.id);
    if (dirty) onApply(p);
    onClose();
  };
  const uploaded = useCallback((ref: FormImageRef, created: boolean) => {
    if (created) createdUploads.current.add(ref.id);
    setHist((h) => {
      const f = formOf(h.cur);
      return f ? pushHistory(h, withForm(h.cur, withFormProps(f, { image: ref })), sameProfile) : h;
    });
    setStep(2);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
      if ((e.ctrlKey || e.metaKey) && !typing) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
      }
      const box = dialogRef.current;
      if (e.key !== 'Tab' || !box) return;
      const focusable = Array.from(box.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href],[tabindex]:not([tabindex="-1"])'))
        .filter((el) => el.offsetParent !== null);
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const cur = document.activeElement;
      const outside = !box.contains(cur);
      if (e.shiftKey && (cur === first || cur === box || outside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || outside)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, undo, redo]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; opener?.focus?.({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const tab = (on: boolean): string =>
    `shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`;
  const iconBtn = 'inline-flex items-center gap-1 rounded-lg border border-[#E9E1D3] bg-white px-2 py-1 text-xs text-[#44403a] disabled:opacity-40';

  const body = (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={tr('تصميم النموذج')} tabIndex={-1} dir={dir}
      className="fixed inset-0 z-[1500] bg-[#FAF7F0] flex flex-col focus:outline-none" data-print-designer="" data-form-designer="">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#E9E1D3] bg-white px-3 py-2">
        <h2 className="text-sm font-bold text-[#1F1A13] me-auto">
          {tr('تصميم النموذج')} <span className="font-normal text-[#6E6557]">· {p.name}</span>
        </h2>
        {form && (
          <>
            <span className="flex gap-1 overflow-x-auto" role="group" aria-label={tr('الخطوات')}>
              {FORM_STEPS.map((s) => (
                <button type="button" key={s.n} aria-pressed={step === s.n} onClick={() => setStep(s.n)} className={tab(step === s.n)}>
                  <span dir="ltr">{s.n}</span> · {tr(s.label)}
                </button>
              ))}
            </span>
            {step !== 1 && (
              <button type="button" onClick={() => setZoom((z) => (z === 0 ? 1 : 0))} aria-pressed={zoom === 1} className={iconBtn}>
                <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />{zoom === 0 ? tr('حجم فعلي 100%') : tr('ملء العرض')}
              </button>
            )}
            <button type="button" onClick={undo} disabled={!hist.past.length} aria-label={tr('تراجع')} title={tr('تراجع')} className={iconBtn}>
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button type="button" onClick={redo} disabled={!hist.future.length} aria-label={tr('إعادة')} title={tr('إعادة')} className={iconBtn}>
              <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </>
        )}
        <button type="button" onClick={requestClose} className="btn-secondary !py-1 !px-3 text-xs inline-flex items-center gap-1">
          <X className="w-3.5 h-3.5" aria-hidden="true" />{tr('إلغاء')}
        </button>
        {form && (
          <button type="button" onClick={apply} disabled={issues.length > 0} className="btn-primary !py-1 !px-3 text-xs inline-flex items-center gap-1">
            <Check className="w-3.5 h-3.5" aria-hidden="true" />{tr('تطبيق')}
          </button>
        )}
      </header>
      {issues.length > 0 && (
        <div role="alert" className="border-b border-[#E15A30]/40 bg-[#FBEBE2] px-3 py-1.5 text-[11px] text-[#8E2A1F]">
          {issues.map((m, i) => <div key={i} className="flex items-center gap-1"><AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />{tr(m)}</div>)}
        </div>
      )}
      {!form ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="max-w-md text-center text-sm text-[#44403a] flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-[#C94E28]" aria-hidden="true" />
            {tr('اختر تصميم «نموذج الشركة المطبوع مسبقاً» للقالب أولا')}
          </p>
        </div>
      ) : step === 1 ? (
        <main className="flex-1 min-h-0 overflow-auto p-3" data-form-step="1">
          <div className="mx-auto max-w-3xl">
            <FormUploadStep paper={p.paper} current={form.image} onDone={uploaded} onCancel={() => setStep(2)} onPendingChange={setUploadPending} onLimit={freeUploads} />
          </div>
        </main>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row" data-form-step={step}>
          <main className="flex-1 min-w-0 min-h-0 overflow-auto p-3"
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
            <FormCanvas form={form} paper={p.paper} onChange={setForm} selected={step === 2 ? sel : null} onSelect={setSelected}
              zoom={zoom} mode={step === 3 ? 'calibrate' : 'edit'} hideQr={taxOff} />
          </main>
          <aside className="lg:w-[340px] shrink-0 max-h-[45vh] lg:max-h-none overflow-auto border-t lg:border-t-0 lg:border-s border-[#E9E1D3] bg-white p-3">
            <FormInspector p={p} update={update} selected={sel} onSelect={setSelected} mode={step === 3 ? 'calibrate' : 'fields'} onUpload={() => setStep(1)} />
          </aside>
        </div>
      )}
    </div>
  );
  return typeof document === 'undefined' ? body : createPortal(body, document.body);
}
