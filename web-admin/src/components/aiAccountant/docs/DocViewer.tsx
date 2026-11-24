import { createContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Loader2, RotateCcw, X } from 'lucide-react';
import { aiAccountantApi } from '../../../api/client';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import { BLOB_REVOKE_DELAY_MS, sniffDocMime } from '../../../lib/aiAccountantDocs';
import { humanSize } from '../../../lib/purchaseAttachments';
import { useBackClose } from '../../../lib/useBackClose';
import { viewKindOf, type ViewKind } from './docCardLogic';

/** ما يحتاجه العارض من المستند — AcctDocView يحقّقه بنيوياً، وMDocViewerDoc في /m بالشكل نفسه */
export interface ViewerDoc {
  id: string;
  fileName: string;
  /** المعلن من الخادم — فارغٌ (من بطاقة قيدٍ لا تعرفه) ⇒ يُحكم بتوقيع البايتات */
  mimeType: string;
  sizeBytes?: number;
}

type Shown = { url: string; kind: ViewKind };

/** عارضٌ بديل يمرّره المستدعي (طبقة الجوال MDocViewer عبر renderViewer) — src رابط معاينةٍ محلي يملكه المستدعي إن وُجد */
export type RenderDocViewer = (doc: ViewerDoc, onClose: () => void, src?: string | null) => ReactNode;

/**
 * العارض البديل لكل ما تحت المحادثة (بطاقة القيد «المستند» في الردود وفي تبويب «قيود المحاسب الذكي») — تملؤه المحادثة من
 * renderViewer، فيفتح الجوال (/m) طبقته بملء الشاشة أينما فُتح المستند؛ وبغيابه DocViewer لسطح المكتب.
 */
export const DocViewerRenderContext = createContext<RenderDocViewer | null>(null);

/**
 * عارض مستند «المحاسب الذكي AI» على سطح المكتب — نافذةٌ فوق الصفحة: الصورة داخلها، وPDF في `<object>` مع «فتح الملف» في
 * لسانٍ جديد (برابطٍ بلمسة المستخدم — نافذةٌ تُفتح برمجياً بعد الشبكة يحجبها المتصفّح). الجوال يمرّر عارضه (MDocViewer)
 * عبر renderViewer في المحادثة.
 *
 * - البايتات من GET /ai-accountant/documents/:id/content (الخادم يحرس الشركة والرافع وصلاحية رؤية الدفاتر).
 * - لا يُعرض إلا ما يطابق توقيعُ بايتاته القائمةَ البيضاء (PDF وJPEG وPNG)، والـBlob بالنوع المفحوص.
 * - رابط الـBlob الذي أنشأه العارض يُبطَل عند الإغلاق (الصورة فوراً وPDF بعد دقيقة)، وجلبٌ وصل بعد الإغلاق لا يُنشئ رابطاً.
 * - `src`: رابطٌ محلّي يملكه المستدعي (معاينة الملف المختار قبل الإرسال) — يُعرض كما هو ولا يُبطَل هنا ولا يُجلب شيء.
 * - Escape وزرّ الرجوع (useBackClose) يُغلقانه.
 */
export default function DocViewer({ doc, onClose, src }: { doc: ViewerDoc; onClose: () => void; src?: string | null }) {
  const tr = useTr();
  // اتجاه الواجهة (الطبقة تُرسم في body خارج شجرة الصفحة): العربية RTL وغيرها LTR
  const dir = useDir();
  const declared = viewKindOf(doc.mimeType);
  const [fetched, setFetched] = useState<Shown | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const owned = useRef<Shown | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useBackClose(true, onClose);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFn.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (src) return;
    let alive = true;
    setFailed(false);
    (async () => {
      try {
        const res = await aiAccountantApi.documents.content(doc.id);
        const data: unknown = res.data;
        const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
        const mime = sniffDocMime(new Uint8Array(await blob.slice(0, 8).arrayBuffer()));
        const kind = viewKindOf(mime);
        // توقيعٌ مجهول، أو يخالف النوع المعلن — لا يُعرض
        if (!mime || !kind || (declared && declared !== kind)) throw new Error('DOC_SIGNATURE');
        if (!alive) return;
        const shown = { url: URL.createObjectURL(new Blob([blob], { type: mime })), kind };
        owned.current = shown;
        setFetched(shown);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [doc.id, src, declared, tries]);

  useEffect(() => () => {
    const o = owned.current;
    owned.current = null;
    // الصورة فوراً (عنصرها زال)، وPDF بعد دقيقة (لسانٌ فُتح للتوّ قد يكون يقرؤه)
    if (o) setTimeout(() => URL.revokeObjectURL(o.url), o.kind === 'pdf' ? BLOB_REVOKE_DELAY_MS : 0);
  }, []);

  const shown: Shown | null = src && declared ? { url: src, kind: declared } : fetched;
  const size = typeof doc.sizeBytes === 'number' && doc.sizeBytes > 0 ? humanSize(doc.sizeBytes) : '';

  let body: ReactNode;
  if ((failed && !shown) || (src && !declared)) {
    body = (
      <div className="py-16 flex flex-col items-center gap-3 text-center px-6">
        <span className="w-12 h-12 rounded-2xl bg-[#FDF2F0] text-[#C0392B] flex items-center justify-center"><FileText size={22} /></span>
        <p className="text-sm font-semibold text-[#1F1A13]">{tr('تعذر فتح المرفق')}</p>
        {!src && (
          <button type="button" onClick={() => setTries(n => n + 1)} className="btn-secondary !py-1.5 !px-3 !text-xs">
            <RotateCcw size={13} /> {tr('إعادة المحاولة')}
          </button>
        )}
      </div>
    );
  } else if (!shown) {
    body = (
      <div className="py-16 flex flex-col items-center gap-3 text-[#9A8F7E]">
        <Loader2 size={26} className="animate-spin" />
        <p className="text-xs">{tr('جاري التحميل')}</p>
      </div>
    );
  } else if (shown.kind === 'image') {
    body = (
      <div className="flex-1 min-h-0 overflow-auto bg-[#F1EBDF] flex items-center justify-center p-2">
        <img src={shown.url} alt={doc.fileName} className="max-w-full max-h-[75vh] object-contain" />
      </div>
    );
  } else {
    body = (
      <object data={shown.url} type="application/pdf" className="w-full h-[75vh] bg-[#F1EBDF]">
        <div className="py-16 flex flex-col items-center gap-3 text-center px-6">
          <p className="text-sm text-[#6E6557]">{tr('المتصفح لا يعرض PDF داخل الصفحة')}</p>
          <a href={shown.url} target="_blank" rel="noopener noreferrer" className="btn-primary !py-1.5 !px-3 !text-xs">
            <ExternalLink size={13} /> {tr('فتح الملف')}
          </a>
        </div>
      </object>
    );
  }

  const overlay = (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true"
      aria-label={doc.fileName} dir={dir} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-3xl max-h-full bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-[#F1EBDF] bg-[#FAF7F0]">
          <FileText size={16} className="text-[#E15A30] shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-[#1F1A13] truncate" dir="auto"><bdi>{doc.fileName}</bdi></span>
            {size && <span className="block text-[11px] text-[#9A8F7E] tabular-nums" dir="ltr">{size}</span>}
          </span>
          {shown?.kind === 'pdf' && (
            <a href={shown.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-[#6E6557] hover:text-[#E15A30]">
              <ExternalLink size={13} /> {tr('فتح الملف')}
            </a>
          )}
          <button ref={closeRef} type="button" onClick={onClose} aria-label={tr('إغلاق')} title={tr('إغلاق')}
            className="w-8 h-8 rounded-full text-[#6E6557] hover:bg-[#F1EBDF] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
