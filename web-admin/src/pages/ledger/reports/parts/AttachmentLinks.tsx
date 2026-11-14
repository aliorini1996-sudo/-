import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { useTr } from '../../../../i18n/strings';
import { formatDateTime } from '../../../../utils/format';
import { ledgerErrorOf } from '../../../../api/ledgerConfig';
import { ledgerErrorMessage } from '../../../../lib/ledger/errors';
import {
  attachmentFileName, attachmentKindLabels, attachmentPreviewKind, decodeDataUrl, formatBytes, isAttachmentSourceType,
  ledgerMoveHref, ledgerPartnersApi, ledgerPartnersKeys, partnerReportReasonLabels,
  type AttachmentSourceType, type SourceAttachmentItem,
} from '../../../../api/ledgerPartners';

/**
 * روابط مرفقات المستند المصدر من سطر قيد أو شريك («ربط الدفاتر» L8، عقد §6.3 و§6.4): صورة السند أو الاستلام أو التوريد،
 * وتوقيعا الفاتورة، ومرفق حركة المستودع، ووثائق العميل، ومرفقات القيد نفسه — **بصلاحية عرض الدفاتر وحدها**، فالمحاسب يرى
 * المرفق بلا صلاحية تشغيلية.
 *
 * - العدد معروف مسبقاً في دفتر الشريك (يُحمَّل دفعةً واحدة لكل صفحة في الخادم)، فلا طلب إلا عند الفتح: القائمة وصفية
 *   (بلا محتوى)، والمحتوى يُجلب للمرفق الذي يُنقر وحده — لا N+1 ولا صور تُنقل بلا حاجة.
 * - العارض: الصور الآمنة في `<img>` وPDF في `<object>` من رابط كائن (لا data URL مباشرة)، وغيرهما تنزيلٌ فقط.
 * - قيدٌ يدوي بلا مستند مصدر: مرفقاته في شاشة القيد نفسها، فالرابط إليها.
 */
export default function AttachmentLinks({ sourceType, sourceId, moveId, count, label, title }: {
  sourceType: string | null | undefined;
  sourceId: string | null | undefined;
  /** قيد السطر — لمرفقات القيد اليدوي بلا مصدر */
  moveId?: string | null;
  /** عدد معروف مسبقاً (0 ⇒ لا شيء)؛ غائب ⇒ يُعرف عند الفتح */
  count?: number | null;
  /** نصّ الزرّ بجانب الأيقونة («وثائق العميل») */
  label?: string;
  /** تلميح الزرّ (الافتراضي «مرفقات المستند») */
  title?: string;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<SourceAttachmentItem | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const supported = isAttachmentSourceType(sourceType) && !!sourceId;

  const listQ = useQuery({
    queryKey: ledgerPartnersKeys.attachments(String(sourceType), String(sourceId)),
    queryFn: async () => (await ledgerPartnersApi.attachments.list(sourceType as AttachmentSourceType, String(sourceId))).data.data,
    enabled: open && supported,
    staleTime: 60_000,
  });

  // النقر خارج القائمة أو Escape يغلقها
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);

  if (count === 0) return null;
  if (!supported) {
    if (!moveId || !count) return null;
    return (
      <Link to={ledgerMoveHref(moveId)} title={tr('المرفقات في شاشة القيد')} className="inline-flex items-center gap-0.5 text-[#E15A30] hover:underline">
        <Paperclip size={13} /><bdi className="tabular-nums">{count}</bdi>
      </Link>
    );
  }

  const items = listQ.data?.items ?? [];
  const kinds = attachmentKindLabels(tr);
  const errorText = (err: unknown) => {
    const e = ledgerErrorOf(err);
    const reason = typeof e?.reason === 'string' ? e.reason : typeof e?.details?.reason === 'string' ? (e.details.reason as string) : null;
    return (reason && partnerReportReasonLabels(tr)[reason]) || ledgerErrorMessage(tr, e);
  };

  return (
    <span ref={boxRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title ?? tr('مرفقات المستند')}
        className="inline-flex items-center gap-0.5 rounded-md px-1 text-[#E15A30] hover:bg-[#FBEBE2]"
        onClick={() => setOpen(o => !o)}
      >
        <Paperclip size={13} />
        {label ? <span className="text-xs">{label}</span> : null}
        {typeof count === 'number' ? <bdi className="tabular-nums">{count}</bdi> : null}
      </button>
      {open && (
        <div role="menu" className="absolute z-40 top-full mt-1 end-0 w-72 max-w-[85vw] rounded-xl border border-[#E8E0D2] bg-white p-1 shadow-xl">
          {listQ.isLoading && <p className="px-2 py-1.5 text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
          {listQ.isError && <p className="px-2 py-1.5 text-xs text-[#C0392B]">{errorText(listQ.error)}</p>}
          {listQ.isSuccess && items.length === 0 && <p className="px-2 py-1.5 text-xs text-[#9A8F7E]">{tr('لا توجد مرفقات')}</p>}
          {items.map(a => (
            <button
              key={`${a.kind}:${a.id}`}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-[#FBF7F0]"
              onClick={() => { setViewing(a); setOpen(false); }}
            >
              {attachmentPreviewKind(a.mime) === 'pdf' ? <FileText size={14} className="shrink-0 text-[#C0392B]" /> : <ImageIcon size={14} className="shrink-0 text-[#E15A30]" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate"><bdi>{a.name}</bdi></span>
                <span className="block text-[10px] text-[#9A8F7E]">{kinds[a.kind] ?? a.kind} · {formatBytes(a.size)} · {formatDateTime(a.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {viewing && (
        <AttachmentViewer item={viewing} sourceId={String(sourceId)} errorText={errorText} onClose={() => setViewing(null)} />
      )}
    </span>
  );
}

/** عارض مرفق واحد: يجلب المحتوى عند الفتح وحده، ويحوّل data URL إلى رابط كائن يُحرَّر عند الإغلاق. */
function AttachmentViewer({ item, sourceId, errorText, onClose }: {
  item: SourceAttachmentItem;
  sourceId: string;
  errorText: (err: unknown) => string;
  onClose: () => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ledgerPartnersKeys.attachment(item.kind, item.id),
    queryFn: async () => (await ledgerPartnersApi.attachments.content(item.kind, item.id, sourceId)).data.data,
    staleTime: 5 * 60_000,
  });

  const file = useMemo(() => {
    if (!q.data) return null;
    const decoded = decodeDataUrl(q.data.data);
    if (!decoded) return null;
    const mime = q.data.mime || decoded.mime;
    return { mime, name: attachmentFileName(q.data.name || item.name, mime), url: URL.createObjectURL(new Blob([decoded.bytes as BlobPart], { type: mime })) };
  }, [q.data, item.name]);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  const preview = file ? attachmentPreviewKind(file.mime) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" role="dialog" aria-modal="true" aria-label={item.name} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[#E8E0D2] bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-[#F1EBDF] bg-[#F7F2EA] px-3 py-2 text-xs">
          <bdi className="truncate font-semibold">{item.name}</bdi>
          <span className="flex items-center gap-1.5">
            {file && (
              <a href={file.url} download={file.name} className="inline-flex items-center gap-1 rounded-lg border border-[#E8E0D2] bg-white px-2 py-1 hover:bg-[#FBF7F0]">
                <Download size={13} />{tr('تنزيل')}
              </a>
            )}
            <button type="button" aria-label={tr('إغلاق')} className="rounded-lg p-1 hover:bg-white" onClick={onClose}><X size={15} /></button>
          </span>
        </div>
        <div className="min-h-[12rem] flex-1 overflow-auto bg-[#FBF7F0]">
          {q.isLoading && <p className="p-4 text-center text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
          {q.isError && <p className="p-4 text-center text-xs text-[#C0392B]">{errorText(q.error)}</p>}
          {q.isSuccess && !file && <p className="p-4 text-center text-xs text-[#C0392B]">{tr('تعذر فتح المرفق')}</p>}
          {file && preview === 'image' && <img src={file.url} alt={item.name} className="mx-auto max-h-[80vh] w-auto object-contain" />}
          {file && preview === 'pdf' && (
            <object data={file.url} type="application/pdf" className="h-[80vh] w-full">
              <p className="p-3 text-sm">{tr('المتصفح لا يعرض PDF داخل الصفحة')}</p>
            </object>
          )}
          {file && preview === 'download' && <p className="p-4 text-center text-xs text-[#6E6557]">{tr('لا معاينة لهذا النوع من الملفات: نزّله لفتحه')}</p>}
        </div>
      </div>
    </div>
  );
}
