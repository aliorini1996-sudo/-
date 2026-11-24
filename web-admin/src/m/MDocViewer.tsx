import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { useDir } from '../i18n/lang';
import { useBackClose } from '../lib/useBackClose';
import { humanSize } from '../lib/purchaseAttachments';
import { BLOB_REVOKE_DELAY_MS, isDocMime, sniffDocMime, type DocMime } from '../lib/aiAccountantDocs';

/**
 * عارض مستندات «المحاسب الذكي AI» على الجوال (/m) — طبقةٌ بملء الشاشة فوق المحادثة ومدخلها معاً، كمعاينة مرفقات المشتريات
 * (MPurchaseAttachments): الصورة داخل الشاشة (لمسةٌ تكبّرها لقراءة رقم الفاتورة — التكبير بالأصابع مقفلٌ في /m)، وPDF ببطاقة
 * «فتح الملف» في لسانٍ جديد بلمسة المستخدم نفسها: أندرويد لا يعرض PDF داخل الصفحة، ونافذةٌ تُفتح برمجياً بعد انتظار الشبكة
 * يحجبها المتصفّح. عارض سطح المكتب (components/aiAccountant/docs/DocViewer) نافذةٌ بـ`<object>` لا تصلح هنا.
 *
 * - زرّ الرجوع في أندرويد وسحبة الحافة في آيفون يُغلقانه (useBackClose) ولا يُخرجان من التطبيق؛ والطبقة تُركَّب مفتوحةً فقط.
 * - البايتات من GET /ai-accountant/documents/:id/content (الخادم يحرس الشركة والرافع والصلاحية) عبر `load` يمرّره المستدعي
 *   (MAiAccountant) — فالعارض بلا شبكةٍ مباشرة ويُرسَم في الاختبار بلا متصفّح.
 * - القائمة البيضاء والتوقيع ومهلة الإبطال من lib/aiAccountantDocs.ts (مرآة عقد الخادم) — المصدر الذي يقرؤه سطح المكتب
 *   أيضاً: لا يُعرض إلا PDF وJPEG وPNG بتوقيع بايتاتها، والـBlob يُبنى بالنوع المفحوص — ردٌّ غير متوقَّع (صفحة HTML) لا يُفتح
 *   في لسانٍ بأصل التطبيق. نوعٌ معلنٌ خارج القائمة لا يُجلب أصلاً، والفارغ (بطاقة قيدٍ لا تعرفه) يحكم فيه التوقيع.
 * - رابط الـBlob يُبطَل عند الإغلاق: الصورة فوراً، وPDF بعد دقيقة (لسانٌ فُتح للتوّ قد يكون ما زال يقرؤه). وجلبٌ وصل بعد
 *   الإغلاق لا يُنشئ رابطاً أصلاً.
 * - `src`: رابطٌ محلّي يملكه المستدعي (معاينة ملفٍّ قبل الإرسال) — يُعرض كما هو ولا يُبطَل هنا ولا يُجلب شيء.
 * - الطبقة تُنقل إلى body (portal): تغطّي الشاشة أيّاً كان موضع المستدعي في الشجرة، ولا يقصّها تحويلٌ أو تمريرٌ في أسلافه.
 */

/** ما يحتاجه العارض من المستند — AcctDocView (lib/aiAccountantDocs) وViewerDoc (عارض سطح المكتب) يحقّقانه بنيوياً */
export interface MDocViewerDoc {
  id: string;
  fileName: string;
  /** المعلن من الخادم — فارغٌ ⇒ يُحكم بتوقيع البايتات */
  mimeType: string;
  sizeBytes?: number;
}

export type DocViewKind = 'image' | 'pdf';

const viewKindOfMime = (m: DocMime): DocViewKind => (m === 'application/pdf' ? 'pdf' : 'image');

/** النوع المعلن ⇒ طريقة العرض، للقائمة البيضاء وحدها (بلا معاملات النوع ولا حالة الأحرف) — وغيرها null */
export function docViewKind(mime: unknown): DocViewKind | null {
  const m = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  return isDocMime(m) ? viewKindOfMime(m) : null;
}

/** مهلة إبطال رابط الـBlob بعد الإغلاق — PDF دقيقة (لسانٌ فُتح للتوّ يقرؤه)، والصورة فوراً (عنصرها زال) */
export const revokeDelayMs = (kind: DocViewKind): number => (kind === 'pdf' ? BLOB_REVOKE_DELAY_MS : 0);

type Shown = { url: string; kind: DocViewKind };

const revokeLater = (url: string, kind: DocViewKind) => { setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs(kind)); };

export default function MDocViewer({ doc, onClose, load, src }: {
  doc: MDocViewerDoc;
  onClose: () => void;
  /** بايتات المستند من الخادم — لا يُستدعى حين يُمرَّر `src` */
  load: (id: string) => Promise<Blob>;
  src?: string | null;
}) {
  const tr = useTr();
  // اتجاه الواجهة (الطبقة تُرسم في body خارج شجرة الصفحة): العربية RTL وغيرها LTR
  const dir = useDir();
  const declared = docViewKind(doc.mimeType);
  /** نوعٌ معلن خارج القائمة البيضاء (لا الفارغ) — لا يُجلب ولا يُعرض */
  const refused = !declared && String(doc.mimeType ?? '').trim() !== '';
  const [fetched, setFetched] = useState<Shown | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** الرابط الذي أنشأه العارض نفسه — يُبطَل عند الإغلاق وحده (لا رابط المستدعي) */
  const owned = useRef<Shown | null>(null);

  useBackClose(true, onClose);

  // التركيز على «إغلاق» مرّةً عند الفتح: يُغلق لوحة المفاتيح إن كانت مفتوحة على المدخل، وEscape يُغلق في معاينة سطح المكتب.
  // الردّ في مرجع: سهمٌ جديد من المستدعي كل رسم لا يعيد التركيز ولا يعيد ربط المستمع
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFn.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (src || refused) return;
    let alive = true;
    setFailed(false);
    (async () => {
      try {
        const blob = await load(doc.id);
        const mime = sniffDocMime(new Uint8Array(await blob.slice(0, 8).arrayBuffer()));
        if (!mime || (declared && viewKindOfMime(mime) !== declared)) throw new Error('DOC_SIGNATURE');
        if (!alive) return; // أُغلق العارض أثناء الجلب — لا رابط يبقى معلّقاً
        const shown = { url: URL.createObjectURL(new Blob([blob], { type: mime })), kind: viewKindOfMime(mime) };
        owned.current = shown;
        setFetched(shown);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [doc.id, src, refused, declared, load, tries]);

  // الإغلاق (أو مغادرة الشاشة كلّها): رابط العارض يُبطَل بمهلته
  useEffect(() => () => {
    const o = owned.current;
    owned.current = null;
    if (o) revokeLater(o.url, o.kind);
  }, []);

  const shown: Shown | null = src ? (declared ? { url: src, kind: declared } : null) : fetched;
  const size = typeof doc.sizeBytes === 'number' && doc.sizeBytes > 0 ? humanSize(doc.sizeBytes) : '';

  let body: ReactNode;
  if (!shown && (refused || failed || src)) {
    body = (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-xs bg-white rounded-2xl p-5 text-center space-y-4">
          <span className="mx-auto w-14 h-14 rounded-2xl bg-[#FDF2F0] text-[#C0392B] flex items-center justify-center">
            <FileText size={26} />
          </span>
          <p className="text-sm font-semibold text-[#1F1A13]">{tr('تعذر فتح المرفق')}</p>
          {failed && (
            <button type="button" onClick={() => setTries(n => n + 1)}
              className="w-full bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2">
              <RotateCcw size={16} /> {tr('إعادة المحاولة')}
            </button>
          )}
        </div>
      </div>
    );
  } else if (!shown) {
    body = (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-white/70">
        <Loader2 size={28} className="animate-spin" />
        <p className="text-xs">{tr('جاري التحميل')}</p>
      </div>
    );
  } else if (shown.kind === 'image') {
    body = (
      <div className={`flex-1 min-h-0 ${zoomed ? 'overflow-auto overscroll-contain' : 'flex items-center justify-center'} p-2`}
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}>
        <img src={shown.url} alt={doc.fileName} onClick={() => setZoomed(z => !z)}
          className={zoomed ? 'max-w-none w-[200%] cursor-zoom-out' : 'max-w-full max-h-full object-contain cursor-zoom-in'} />
      </div>
    );
  } else {
    body = (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-xs bg-white rounded-2xl p-5 text-center space-y-4">
          <span className="mx-auto w-14 h-14 rounded-2xl bg-[#FDF2F0] text-[#C0392B] flex items-center justify-center">
            <FileText size={26} />
          </span>
          <p className="text-sm font-semibold text-[#1F1A13] break-words" dir="auto"><bdi>{doc.fileName}</bdi></p>
          {/* رابطٌ بلمسة المستخدم نفسها — نافذةٌ تُفتح برمجياً بعد انتظار الشبكة يحجبها المتصفّح */}
          <a href={shown.url} target="_blank" rel="noopener noreferrer"
            className="w-full bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2">
            <ExternalLink size={16} /> {tr('فتح الملف')}
          </a>
        </div>
      </div>
    );
  }

  const overlay = (
    <div className="fixed inset-0 z-[60] bg-black/90 flex flex-col" role="dialog" aria-modal="true" aria-label={doc.fileName} dir={dir}>
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-3 text-white"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold truncate" dir="auto"><bdi>{doc.fileName}</bdi></span>
          {size && <span className="block text-[11px] text-white/60 tabular-nums" dir="ltr">{size}</span>}
        </span>
        {shown?.kind === 'image' && (
          <button type="button" onClick={() => setZoomed(z => !z)} aria-label={zoomed ? tr('تصغير الصورة') : tr('تكبير الصورة')}
            className="w-10 h-10 rounded-xl flex items-center justify-center active:bg-white/10">
            {zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}
          </button>
        )}
        <button ref={closeRef} type="button" onClick={onClose} aria-label={tr('إغلاق')}
          className="w-10 h-10 rounded-xl flex items-center justify-center active:bg-white/10">
          <X size={20} />
        </button>
      </div>
      {body}
    </div>
  );

  // الرسم على الخادم (الاختبار) لا يدعم البوّابات — يُرسَم في موضعه هناك
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
