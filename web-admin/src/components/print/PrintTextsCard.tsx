import { Component, Suspense, lazy, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Languages, Pencil, RefreshCw } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import {
  PRINT_TEXT_CATALOG, PRINT_TEXT_LINE, PRINT_TEXT_WARNINGS, SECOND_LANG_NAMES, normalizePrintTexts, printTextEditOnPhase2, printTextEntry, printTextWarning, printTextsSummary,
  type PrintTextEdit, type PrintTextEntry, type PrintTextWarning, type PrintTextsV1,
} from '../../lib/print/printTexts';
import type { Company } from '../../rep/RepDocuments';

/**
 * «نصوص المطبوعات» داخل بطاقة «هوية الشركة في المطبوعات» (طلب المالك ٣١ أكتوبر ٢٠٢٦): سطر الحال المحفوظة (اللغات وعدد ما
 * أُعيدت صياغته وما حُذف سطره) وزرّ يفتح المحرّر.
 *
 * البطاقة داخل نموذج الإعدادات العامة (<form>) — فكل أزرارها type="button"، والمحرّر يُرسم ببوابة إلى document.body (createPortal
 * في PrintTextsEditor) فلا يُرسل Enter في خاناته النموذجَ العام. والمحرّر حزمةٌ كسولة (المعاينة بالقوالب الحقيقية والحرارية) لا
 * تُحمَّل إلا عند فتحه، وفشل تحميلها لافتةٌ وإعادة محاولة هنا لا صفحةٌ بيضاء تُسقط النموذج العام وتعديلاته.
 * ويُحفظ بمساره المستقل (companyApi.printTexts) — لا حقلٌ في النموذج العام ولا في companyApi.update.
 */
export type PrintTextsCompany = Partial<Company> | null | undefined;

// ─── منطق المحرّر الخالص (طلب المالك ٣ نوفمبر ٢٠٢٦: كل عبارةٍ تُحرَّر وتُحذف بسطرها كاملاً) — هنا لا في المحرّر الكسول كي
//     تختبره الاختبارات بلا متصفح (المحرّر يستورد عميل الـAPI). لا قفل يمنع شيئاً: التنبيه وتأكيد الحذف وحدهما ───

const NO_EDIT: PrintTextEdit = Object.freeze({ text: null, alt: null, hidden: false });
const isBlank = (s: string | null): boolean => s === null || s === '';

/**
 * تعديل نصٍّ واحد في المسودة: patch يُدمج فوق تعديله (hidden:true = «حذف السطر»، false = «استعادة»)، وnull يعيده افتراضياً.
 * التعديل الفارغ (بلا صياغة ولا ترجمة ولا حذف) يُزال — الصورة القانونية نفسها التي يحفظها الخادم.
 * ولمسُ عنوان الفاتورة/الإشعار هنا يوسمه phase2 فيسري على المرحلتين؛ وتعديل عنوانٍ محفوظٌ قبل ٣ نوفمبر ٢٠٢٦ يبقى بلا وسم (للمرحلة
 * الأولى وحدها كما حُفظ) ما لم تلمسه الشركة.
 */
export function withTextEdit(d: PrintTextsV1, key: string, patch: Partial<PrintTextEdit> | null): PrintTextsV1 {
  const edits = { ...d.edits };
  const next = patch === null ? NO_EDIT : { ...(edits[key] ?? NO_EDIT), ...patch };
  if (isBlank(next.text) && isBlank(next.alt) && !next.hidden) delete edits[key];
  else {
    const shaped: PrintTextEdit = { text: isBlank(next.text) ? null : next.text, alt: isBlank(next.alt) ? null : next.alt, hidden: next.hidden };
    if (printTextEntry(key)?.lock === 'title') shaped.phase2 = true;
    edits[key] = shaped;
  }
  return { ...d, edits };
}

/** تعديل عنوانٍ محفوظٌ قبل ٣ نوفمبر ٢٠٢٦ (بلا phase2): لا يسري على مستند المرحلة الثانية — تنبيهٌ في صفّه حتى تلمسه الشركة */
export function titleEditPhase1Only(key: string, edit: PrintTextEdit | undefined): boolean {
  const entry = printTextEntry(key);
  return !!entry && !!edit && !printTextEditOnPhase2(entry, edit) && (edit.text !== null || edit.alt !== null || edit.hidden);
}

/**
 * صفوف الصندوق الذي يعنونه مفتاحٌ وحدته «block» — حذف العنوان يحذفها معه (RepDocuments/printGrid): بيانات الفاتورة (رقمها وتاريخها)،
 * وصندوق العميل (رقمه الضريبي)، وصندوق البائع، وصندوق عميل السند. صندوق «مقابل الفواتير» صفوفه بلا تنبيه.
 */
const BLOCK_ROWS: Readonly<Record<string, (e: PrintTextEntry) => boolean>> = Object.freeze({
  'inv.infoHeading': (e: PrintTextEntry) => e.group === 'info' && e.doc !== 'receipt',
  'inv.returnInfoHeading': (e: PrintTextEntry) => e.group === 'info' && e.doc !== 'receipt',
  'cust.heading': (e: PrintTextEntry) => e.group === 'customer' && e.doc !== 'receipt',
  'sel.heading': (e: PrintTextEntry) => e.group === 'seller',
  'rcp.customerHeading': (e: PrintTextEntry) => e.group === 'customer' && e.doc === 'receipt',
  'rcp.forInvoices': (e: PrintTextEntry) => e.key === 'rcp.invoiceNo' || e.key === 'rcp.credit',
});

/**
 * تنبيه «حذف السطر» لمفتاح: تنبيهه في القائمة (printTextWarning)، وعنوان الصندوق (block) يأخذ أشدّ تنبيهٍ في صفوفه التي تسقط معه —
 * فلا يُحذف رقم الفاتورة أو رقم المشتري الضريبي بحذف عنوانٍ لم يكن مقفلاً بلا تنبيهٍ ولا تأكيد.
 */
export function lineWarning(key: string): PrintTextWarning | null {
  const entry = printTextEntry(key);
  if (!entry) return null;
  const own = printTextWarning(entry);
  const rows = PRINT_TEXT_LINE[key] === 'block' ? BLOCK_ROWS[key] : undefined;
  if (own === 'tax' || !rows) return own;
  const inner = PRINT_TEXT_CATALOG.filter((e) => e.key !== key && rows(e)).map((e) => printTextWarning(e));
  if (inner.includes('tax')) return 'tax';
  if (inner.includes('standard')) return 'standard';
  return own;
}

/** صنف التنبيه الذي يطلب تأكيد الحذف مرّةً واحدة ('tax' و'standard' — ما كان إلزامياً للفاتورة الضريبية، أو صندوقٌ يحويه) أو null */
export function deleteConfirmClass(key: string): PrintTextWarning | null {
  const w = lineWarning(key);
  return w === 'tax' || w === 'standard' ? w : null;
}

/** نصّ سؤال تأكيد الحذف (عربيٌّ عبر tr) أو null حين لا يلزم تأكيد */
export function deleteConfirmText(key: string, tr: (ar: string) => string): string | null {
  const w = deleteConfirmClass(key);
  const entry = printTextEntry(key);
  if (!w || !entry) return null;
  return `${tr('تأكيد الحذف')}: ${tr(entry.ar)}\n${tr(PRINT_TEXT_WARNINGS[w])}`;
}

/** السطور المحذوفة بترتيب القائمة — لتبويب مستند (ومعه المشتركة) أو كلّها */
export function deletedLines(t: PrintTextsV1 | null, doc?: 'invoice' | 'receipt'): PrintTextEntry[] {
  if (!t) return [];
  return PRINT_TEXT_CATALOG.filter((e) => (!doc || e.doc === doc || e.doc === 'shared') && t.edits[e.key]?.hidden === true);
}

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
    sum.hidden > 0 ? `${tr('سطور محذوفة')}: ${sum.hidden}` : null,
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
      <p className="text-[10px] text-gray-400 mt-1.5">{tr('غير صياغة أي نص أو احذف سطره واطبع النصوص بلغتين — تحفظ من المحرر نفسه لا بزر حفظ الإعدادات')}</p>

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
