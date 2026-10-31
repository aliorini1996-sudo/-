import { Component, Suspense, lazy, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Languages, Pencil, RefreshCw } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { SECOND_LANG_NAMES, normalizePrintTexts, printTextsSummary } from '../../lib/print/printTexts';
import type { Company } from '../../rep/RepDocuments';

/**
 * «نصوص المطبوعات» داخل بطاقة «هوية الشركة في المطبوعات» (طلب المالك ٣١ أكتوبر ٢٠٢٦): سطر الحال المحفوظة (اللغات وعدد ما
 * أُعيدت صياغته وما أُخفي) وزرّ يفتح المحرّر.
 *
 * البطاقة داخل نموذج الإعدادات العامة (<form>) — فكل أزرارها type="button"، والمحرّر يُرسم ببوابة إلى document.body (createPortal
 * في PrintTextsEditor) فلا يُرسل Enter في خاناته النموذجَ العام. والمحرّر حزمةٌ كسولة (المعاينة بالقوالب الحقيقية والحرارية) لا
 * تُحمَّل إلا عند فتحه، وفشل تحميلها لافتةٌ وإعادة محاولة هنا لا صفحةٌ بيضاء تُسقط النموذج العام وتعديلاته.
 * ويُحفظ بمساره المستقل (companyApi.printTexts) — لا حقلٌ في النموذج العام ولا في companyApi.update.
 */
export type PrintTextsCompany = Partial<Company> | null | undefined;

const loadEditor = () => import('./PrintTextsEditor');

export default function PrintTextsCard({ company }: { company: PrintTextsCompany }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  // «إعادة المحاولة» بعد فشل تحميل الحزمة: مكوّن كسول جديد لكل محاولة (React.lazy يحفظ الوعد المرفوض)
  const [attempt, setAttempt] = useState(0);
  const Editor = useMemo(() => lazy(loadEditor), [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // الحال المحفوظة من ردّ /company (لا المسودة) — null = نصوص اليوم
  const saved = useMemo(() => normalizePrintTexts(company?.printTexts), [company?.printTexts]);
  const sum = printTextsSummary(saved);
  const langs = saved?.secondLang ? `${tr('العربية')} + ${SECOND_LANG_NAMES[saved.secondLang]}` : tr('العربية');
  const counts = [
    sum.reworded > 0 ? `${tr('نصوص معدلة')}: ${sum.reworded}` : null,
    sum.hidden > 0 ? `${tr('نصوص مخفية')}: ${sum.hidden}` : null,
  ].filter(Boolean).join(' · ') || tr('النصوص الافتراضية');

  return (
    <div className="mt-5 pt-4 border-t border-gray-100" data-print-texts-card="">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="label flex items-center gap-1.5"><Languages size={14} className="text-[#E15A30]" /> {tr('نصوص الفاتورة وسند القبض')}</p>
          <p className="text-[11px] text-[#6E6557] leading-relaxed">{langs} · {counts}</p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={() => setOpen(true)}
          onPointerEnter={() => { loadEditor().catch(() => undefined); }}>
          <Pencil size={14} /> {tr('تحرير النصوص على الفاتورة')}
        </button>
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5">{tr('غير صياغة أي نص أو أخفه واطبع النصوص بلغتين — تحفظ من المحرر نفسه لا بزر حفظ الإعدادات')}</p>

      {open && (
        <EditorBoundary onRetry={() => setAttempt(n => n + 1)} onClose={() => setOpen(false)}>
          <Suspense fallback={(
            <div className="mt-2 flex items-center gap-2 text-xs text-[#6E6557]">
              <span className="w-4 h-4 border-2 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
              {tr('جار التحميل')}
            </div>
          )}>
            <Editor company={company} onClose={() => setOpen(false)} />
          </Suspense>
        </EditorBoundary>
      )}
    </div>
  );
}

/** حاجز أخطاء المحرّر الكسول (كحاجز تبويب «إعدادات الطباعة»): فشل تحميل حزمته أو خطأٌ داخله لا يُسقط صفحة الإعدادات */
class EditorBoundary extends Component<{ children: ReactNode; onRetry: () => void; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  retry = () => { this.setState({ failed: false }); this.props.onRetry(); };
  render(): ReactNode {
    return this.state.failed ? <EditorLoadError onRetry={this.retry} onClose={this.props.onClose} /> : this.props.children;
  }
}

function EditorLoadError({ onRetry, onClose }: { onRetry: () => void; onClose: () => void }) {
  const tr = useTr();
  return (
    <div className="mt-3" role="alert">
      <div className="flex items-start gap-2 border rounded-xl px-3 py-2 text-xs bg-[#FBE3DF] border-[#F2C4BC] text-[#8E2A1F]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <p className="font-semibold">{tr('تعذر تحميل محرر النصوص')}</p>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button type="button" className="btn-secondary text-xs" onClick={onRetry}><RefreshCw size={13} /> {tr('إعادة المحاولة')}</button>
        <button type="button" className="btn-secondary text-xs" onClick={onClose}>{tr('إغلاق')}</button>
      </div>
    </div>
  );
}
