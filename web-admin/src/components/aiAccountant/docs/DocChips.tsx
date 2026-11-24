import { CircleAlert, FileText, Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { humanSize } from '../../../lib/purchaseAttachments';
import type { PendingDoc } from './docCardLogic';
import type { ViewerDoc } from './DocViewer';

const isPdfMime = (m: string) => m === 'application/pdf';

/**
 * شرائح المستندات في خانة الكتابة قبل الإرسال: الاسم والحجم وحالة التجهيز (ضغط الصورة وقراءة QR على الجهاز) ثم الرفع بنسبته،
 * وحذفٌ لكلٍّ. الإرسال ينتظر آخر رفع؛ والشريحة الجاهزة تُفتح للمعاينة من رابطها المحلي.
 */
export default function DocChips({ items, onRemove, onOpen, compact = false }: {
  items: readonly PendingDoc[];
  onRemove: (key: string) => void;
  onOpen: (p: PendingDoc) => void;
  compact?: boolean;
}) {
  const tr = useTr();
  if (!items.length) return null;
  return (
    <ul className={`flex gap-2 overflow-x-auto ${compact ? 'px-3 pt-2' : 'px-4 pt-2 flex-wrap'}`} aria-label={tr('المستندات المرفقة')}>
      {items.map((p) => {
        const pdf = isPdfMime(p.mimeType);
        const err = p.phase === 'error';
        const working = p.phase === 'preparing' || p.phase === 'uploading';
        const status = p.phase === 'preparing' ? tr('جاري التجهيز…')
          : p.phase === 'uploading' ? tr('جاري الرفع {n}%').replace('{n}', String(Math.max(0, Math.min(100, Math.round(p.progress)))))
          : err ? (p.error || tr('تعذر رفع المستند'))
          : humanSize(p.sizeBytes);
        return (
          <li key={p.key}
            className={`relative shrink-0 w-56 max-w-[80vw] flex items-center gap-2 rounded-xl border bg-white p-1.5 pe-1 overflow-hidden ${err ? 'border-[#F3C9BF]' : 'border-[#E9E1D3]'}`}>
            <button type="button" onClick={() => onOpen(p)} disabled={p.phase !== 'ready'}
              className="min-w-0 flex-1 flex items-center gap-2 text-start disabled:cursor-default">
              <span className={`w-9 h-9 shrink-0 rounded-lg overflow-hidden flex items-center justify-center ${pdf ? 'bg-[#FDF2F0] text-[#C0392B]' : 'bg-[#FDF0EB] text-[#E15A30]'}`}>
                {working ? <Loader2 size={16} className="animate-spin" />
                  : err ? <CircleAlert size={16} className="text-[#C0392B]" />
                  : !pdf && p.localUrl ? <img src={p.localUrl} alt="" className="w-full h-full object-cover" />
                  : pdf ? <FileText size={17} /> : <ImageIcon size={17} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-[#1F1A13] truncate" dir="auto"><bdi>{p.fileName}</bdi></span>
                <span className={`block text-[10px] truncate ${err ? 'text-[#C0392B]' : 'text-[#9A8F7E]'}`} dir="auto">{status}</span>
              </span>
            </button>
            <button type="button" onClick={() => onRemove(p.key)} aria-label={tr('حذف')} title={tr('حذف')}
              className="w-7 h-7 shrink-0 rounded-full text-[#6E6557] hover:bg-red-50 hover:text-red-600 flex items-center justify-center">
              <X size={14} />
            </button>
            {p.phase === 'uploading' && (
              <span className="absolute bottom-0 start-0 h-0.5 bg-[#E15A30] transition-[width]" style={{ width: `${Math.max(4, Math.min(100, p.progress))}%` }} aria-hidden />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** شرائح المستندات المرفقة برسالةٍ أُرسلت (فقاعة المستخدم) — تُفتح في العارض */
export function SentDocChips({ docs, onOpen, compact = false }: {
  docs: readonly ViewerDoc[];
  onOpen?: (d: ViewerDoc) => void;
  compact?: boolean;
}) {
  const tr = useTr();
  if (!docs.length) return null;
  return (
    <div className="mt-1 flex flex-wrap justify-end gap-1.5" aria-label={tr('المستندات المرفقة')}>
      {docs.map((d) => {
        const pdf = isPdfMime(d.mimeType);
        return (
          <button key={d.id} type="button" onClick={() => onOpen?.(d)} disabled={!onOpen}
            className={`max-w-full inline-flex items-center gap-1.5 rounded-lg border border-[#F6CDBE] bg-[#FDF0EB] text-[#B8461F] hover:bg-[#FBE3D9] ${compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-xs'}`}>
            {pdf ? <FileText size={12} className="shrink-0" /> : d.mimeType ? <ImageIcon size={12} className="shrink-0" /> : <Paperclip size={12} className="shrink-0" />}
            <span className="truncate max-w-[12rem]" dir="auto"><bdi>{d.fileName || tr('المستند')}</bdi></span>
          </button>
        );
      })}
    </div>
  );
}
