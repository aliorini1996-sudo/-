/**
 * «المصمّم الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦: «تغيير حجم الشعار وتحديد مكانه حسب الرغبة والتغيير الحر بفاتورة حرارية وA4»)
 * — نافذةٌ كاملة ببوابة إلى document.body على نمط محرّر نصوص المطبوعات: role=dialog، وTab محصور، وEsc يغلق بتأكيدٍ إن وُجد
 * ما لم يُطبَّق، وbeforeunload، وقفل تمرير الصفحة، وعودة التركيز إلى زرّ الفتح.
 *
 * يعدّل نسخةً من القالب المفتوح ويعيدها بـonApply عند «تطبيق» (كزرّ «تم» في محرّر القالب) — فالحفظ إلى الخادم يبقى زرّ
 * «حفظ إعدادات الطباعة». A4/النقطية: لوحتا الرأس والتذييل بالسحب (A4BandsCanvas)؛ الحراري: الشريط (RollStrip). والمفتّش
 * (DesignInspector) أدوات العنصر المحدَّد. تراجعٌ وإعادة 50 خطوة، و«إلغاء» يتجاهل كل شيء.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, Maximize2, Redo2, Undo2, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import { ITEMS_REMOVE_WARNING, isItemsRemoved, layoutOf, type PrintProfile } from '../../../lib/print/printSettings';
import { freeIssues, type DesignSel } from '../../../lib/print/designModel';
import { layoutEditable } from '../PrintPreview';
import A4BandsCanvas from './A4BandsCanvas';
import RollStrip from './RollStrip';
import DesignInspector from './DesignInspector';
import { pushHistory, redoHistory, undoHistory, type History } from './designerMath';
import { useTaxOffPrint } from '../taxOffPrint';

export interface PrintDesignerProps {
  profile: PrintProfile;
  phase2: boolean;
  company: unknown;
  companyName: string;
  brandColor: string;
  onApply(next: PrintProfile): void;
  onClose(): void;
}

const sameProfile = (a: PrintProfile, b: PrintProfile): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
export const DESIGNER_DISCARD_CONFIRM = 'لديك تغييرات في المصمم لم تطبق — إغلاق دون تطبيق؟';
export const MONO_PREVIEW_HINT = 'الطباعة بالأبيض والأسود: الشعار الملون أو الفاتح قد يختفي';

export default function PrintDesigner({ profile, phase2, company, companyName, onApply, onClose }: PrintDesignerProps) {
  const tr = useTr();
  // «إزالة الضريبة» (سياق التبويب): لا تنبيه هيئةٍ على حذف الأصناف لشركةٍ بلا ضريبة
  const taxOff = useTaxOffPrint();
  const dir = useDir();
  const [hist, setHist] = useState<History<PrintProfile>>(() => ({ past: [], cur: profile, future: [] }));
  const [selected, setSelected] = useState<DesignSel | null>(null);
  const [doc, setDoc] = useState<'invoice' | 'receipt'>('invoice');
  const [zoom, setZoom] = useState<0 | 1>(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const p = hist.cur;
  const editable = layoutEditable(profile);
  const thermal = p.printer === 'thermal';

  const update = useCallback((next: PrintProfile) => setHist((h) => pushHistory(h, next, sameProfile)), []);
  const undo = useCallback(() => setHist(undoHistory), []);
  const redo = useCallback(() => setHist(redoHistory), []);
  const dirty = useMemo(() => !sameProfile(p, profile), [p, profile]);
  const issues = useMemo(() => (editable ? freeIssues(p) : []), [p, editable]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm(tr(DESIGNER_DISCARD_CONFIRM))) return;
    onClose();
  }, [dirty, onClose, tr]);
  const apply = (): void => {
    if (issues.length) return;
    if (dirty) onApply(p);
    onClose();
  };

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
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const tab = (on: boolean): string =>
    `shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`;
  const iconBtn = 'inline-flex items-center gap-1 rounded-lg border border-[#E9E1D3] bg-white px-2 py-1 text-xs text-[#44403a] disabled:opacity-40';

  const body = (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={tr('المصمم الحر')} tabIndex={-1} dir={dir}
      className="fixed inset-0 z-[1500] bg-[#FAF7F0] flex flex-col focus:outline-none" data-print-designer="">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#E9E1D3] bg-white px-3 py-2">
        <h2 className="text-sm font-bold text-[#1F1A13] me-auto">
          {tr('المصمم الحر')} <span className="font-normal text-[#6E6557]">· {p.name || companyName}</span>
        </h2>
        {editable && (
          <>
            <span className="flex gap-1" role="group" aria-label={tr('المستند')}>
              {(['invoice', 'receipt'] as const).map((k) => (
                <button type="button" key={k} aria-pressed={doc === k} onClick={() => setDoc(k)} className={tab(doc === k)}>
                  {k === 'invoice' ? tr('فاتورة') : tr('سند قبض')}
                </button>
              ))}
            </span>
            {!thermal && (
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
        {editable && (
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
      {!editable ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="max-w-md text-center text-sm text-[#44403a] flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-[#C94E28]" aria-hidden="true" />
            {tr('هذا القالب الافتراضي لا يعدل مباشرة: انسخه أولا، أو استعمل «تحرير الشريط الكلاسيكي» للرول الكلاسيكي')}
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <main className="flex-1 min-w-0 min-h-0 overflow-auto p-3"
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
            {(thermal || p.printer === 'impact') && (
              <p className="mb-2 text-[11px] text-[#9A8F7E] flex items-center gap-1">
                <Info className="w-3 h-3" aria-hidden="true" />{tr(MONO_PREVIEW_HINT)}
              </p>
            )}
            {/* جدول الأصناف محذوف بخيار الشركة الصريح (قرار المالك ٤ نوفمبر ٢٠٢٦): تنبيهٌ أحمر دائم أيّاً كان العنصر المحدَّد — رمز QR له تنبيهه تحت اللوحة/الشريط */}
            {isItemsRemoved(layoutOf(p)) && !taxOff && (
              <p className="mb-2 text-[11px] text-[#8E2A1F] bg-[#FBEBE2] rounded px-2 py-1" role="note" data-items-removed-note="">{tr(ITEMS_REMOVE_WARNING)}</p>
            )}
            {thermal
              ? <RollStrip p={p} update={update} doc={doc} selected={selected} onSelect={setSelected} company={company} />
              : <A4BandsCanvas p={p} update={update} doc={doc} selected={selected} onSelect={setSelected} zoom={zoom} phase2={phase2} company={company} />}
          </main>
          <aside className="lg:w-[340px] shrink-0 max-h-[45vh] lg:max-h-none overflow-auto border-t lg:border-t-0 lg:border-s border-[#E9E1D3] bg-white p-3">
            {selected !== null && (
              <button type="button" onClick={() => setSelected(null)} className="mb-2 text-[11px] text-[#6E6557] hover:text-[#C94E28]">
                {tr('كل العناصر')}
              </button>
            )}
            <DesignInspector p={p} update={update} selected={selected} onSelect={setSelected} phase2={phase2} />
          </aside>
        </div>
      )}
    </div>
  );
  return typeof document === 'undefined' ? body : createPortal(body, document.body);
}
