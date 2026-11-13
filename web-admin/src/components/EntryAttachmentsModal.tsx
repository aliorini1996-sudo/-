import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X, FileText, Image as ImageIcon, Trash2, Download, ExternalLink, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { warehouseApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatDate, formatDateTime } from '../utils/format';
import { backdropClose } from '../lib/backdropClose';
import ConfirmDialog from './ConfirmDialog';
import PurchaseAttachmentsPicker from './PurchaseAttachmentsPicker';
import {
  PURCHASE_ATT_MAX_PER_ENTRY, attachmentBytesOf, attachmentInvalidOf, attachmentsPayload, humanSize, isPdf, pdfBytesOf, safeImageSrc,
  type AttachmentMeta, type PickedAttachment,
} from '../lib/purchaseAttachments';

/** حركة السجلّ كما تحتاجها النافذة */
export interface AttachmentsEntry { id: string; type: string; supplier?: string | null; createdAt: string; attachmentsCount?: number }

type ApiErr = { response?: { data?: { message?: string } } };

/**
 * Blob URL من بايتاتٍ مفحوصة — لا يوضع نصّ data: في رابطٍ أبداً. `revokeAfter` يلغيه بعد مهلةٍ تكفي التبويب أو التنزيل ليقرأه،
 * وبلا مهلة يلغيه صاحبه (رابط «فتح الملف» حين يُستبدل أو تُغلق النافذة)
 */
function blobUrlOf(bytes: Uint8Array, mime: string, revokeAfter: number | null = 120_000): string {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  if (revokeAfter != null) setTimeout(() => URL.revokeObjectURL(url), revokeAfter);
  return url;
}

/** تنزيل المرفق باسمه — من Blob URL */
function downloadAttachment(data: string, name: string): boolean {
  const b = attachmentBytesOf(data);
  if (!b) return false;
  const a = document.createElement('a');
  a.href = blobUrlOf(b.bytes, b.mime);
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

/**
 * مرفقات حركة المستودع (طلب المالك ١٣ نوفمبر ٢٠٢٦): فاتورة المشتريات صوراً أو PDF — القائمة تصل بلا البيانات، وكل ملفٍّ يُطلب حين
 * يُفتح: الصورة تُعرض هنا (data URL صورةٍ مفحوصة وحدها)، وPDF في تبويبٍ جديد من Blob URL. ولمن يسجّل حركات المستودع (`canEdit`):
 * إضافة مرفقاتٍ لاحقاً حتى سقف الحركة، وحذفُ مرفقٍ بتأكيد. القيود (الصلاحية، الشركة، الفحص بالبايتات) في الخادم.
 */
export default function EntryAttachmentsModal({ entry, canEdit, onClose }: { entry: AttachmentsEntry; canEdit: boolean; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const listKey = ['warehouse-entry-attachments', entry.id];
  const listQ = useQuery({
    queryKey: listKey,
    queryFn: async () => ((await warehouseApi.attachments(entry.id)).data?.data ?? []) as AttachmentMeta[],
  });
  const list = listQ.data ?? [];
  // الملف ببياناته — لا يتغيّر بعد رفعه، فيُحفظ ما بقيت النافذة
  const fetchData = (attId: string) => qc.fetchQuery({
    queryKey: ['warehouse-entry-attachment', entry.id, attId],
    queryFn: async () => String((await warehouseApi.attachment(entry.id, attId)).data?.data?.data ?? ''),
    staleTime: Infinity, gcTime: 5 * 60_000,
  });

  const [viewer, setViewer] = useState<{ att: AttachmentMeta; src: string; data: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // تبويبٌ منعه المتصفّح: رابطٌ ظاهر يفتحه المستخدم بنقرته (Blob URL)
  const [pdfLink, setPdfLink] = useState<{ name: string; url: string } | null>(null);
  useEffect(() => () => { if (pdfLink) URL.revokeObjectURL(pdfLink.url); }, [pdfLink]);
  const [confirmDel, setConfirmDel] = useState<AttachmentMeta | null>(null);
  const [pending, setPending] = useState<PickedAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [addErr, setAddErr] = useState('');

  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || confirmDel) return;
      if (viewer) setViewer(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, confirmDel, onClose]);

  const open = async (att: AttachmentMeta) => {
    if (opening) return;
    setPdfLink(null);
    // PDF: التبويب يُفتح داخل النقرة نفسها (قبل أي انتظار) وإلا منعه المتصفّح — ويُوجَّه إلى الملف حين يصل
    const tab = isPdf(att) ? window.open('', '_blank') : null;
    setOpening(att.id);
    try {
      const data = await fetchData(att.id);
      const bytes = pdfBytesOf(data);
      if (bytes) {
        if (tab && !tab.closed) {
          tab.location.href = blobUrlOf(bytes, 'application/pdf');
          try { tab.opener = null; } catch { /* لا شيء */ }
        } else setPdfLink({ name: att.name, url: blobUrlOf(bytes, 'application/pdf', null) });
        return;
      }
      tab?.close();
      const src = safeImageSrc(data);
      if (!src) throw new Error('invalid');
      setViewer({ att, src, data });
    } catch {
      tab?.close();
      toast.error(tr('تعذر فتح المرفق'));
    } finally { setOpening(null); }
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: listKey });
    qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
  };

  const del = useMutation({
    mutationFn: (att: AttachmentMeta) => warehouseApi.removeAttachment(entry.id, att.id),
    onSuccess: (_r, att) => {
      setConfirmDel(null);
      if (viewer?.att.id === att.id) setViewer(null);
      qc.removeQueries({ queryKey: ['warehouse-entry-attachment', entry.id, att.id] });
      refresh();
      toast.success(tr('تم الحذف'));
    },
    onError: (e: unknown) => toast.error((e as ApiErr)?.response?.data?.message ? tr((e as ApiErr).response!.data!.message!) : tr('تعذر الحذف')),
  });

  const add = useMutation({
    mutationFn: () => warehouseApi.addAttachments(entry.id, attachmentsPayload(pending).attachments ?? []),
    onSuccess: () => { setPending([]); setAddErr(''); refresh(); toast.success(tr('تم رفع المرفق')); },
    onError: (e: unknown) => {
      const invalid = attachmentInvalidOf(e);
      const m = invalid ? tr(invalid) : (e as ApiErr)?.response?.data?.message ? tr((e as ApiErr).response!.data!.message!) : tr('تعذر رفع المرفق');
      setAddErr(m);
      toast.error(m);
    },
  });

  const room = PURCHASE_ATT_MAX_PER_ENTRY - list.length;
  const title = entry.type === 'RECEIVE' ? tr('فاتورة المشتريات') : tr('مرفقات');

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-5 border-b border-[#E9E1D3]">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Paperclip size={20} className="text-[#E15A30]" /> {title}</h2>
            <p className="text-xs text-[#9A8F7E] mt-0.5 truncate">
              {entry.type === 'RECEIVE' ? tr('وارد') : tr('تسوية')} · <span dir="ltr">{formatDate(entry.createdAt)}</span>{entry.supplier ? ` · ${entry.supplier}` : ''}
            </p>
          </div>
          <button ref={closeRef} onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {listQ.isLoading ? (
            <p className="text-sm text-center text-[#9A8F7E] py-4">{tr('جار التحميل')}</p>
          ) : listQ.isError ? (
            <p className="text-sm text-center text-red-500 py-4">{tr('تعذر تحميل المرفقات')}</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-center text-[#9A8F7E] py-4">{tr('لا توجد مرفقات')}</p>
          ) : (
            <ul className="space-y-1.5">
              {list.map((a) => (
                <li key={a.id} className="flex items-center gap-2 rounded-xl border border-[#E9E1D3] p-2">
                  <button type="button" onClick={() => open(a)} disabled={!!opening}
                    className="min-w-0 flex-1 flex items-center gap-2 text-start rounded-lg hover:bg-[#FAF7F0] p-1 disabled:opacity-60">
                    <span className="w-9 h-9 flex-shrink-0 rounded-lg bg-[#FAF7F0] flex items-center justify-center">
                      {opening === a.id ? <span className="w-4 h-4 border-2 border-[#E15A30]/30 border-t-[#E15A30] rounded-full animate-spin" />
                        : isPdf(a) ? <FileText size={18} className="text-[#C0392B]" /> : <ImageIcon size={18} className="text-[#E15A30]" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#1F1A13] truncate"><bdi>{a.name}</bdi></span>
                      <span className="block text-[10px] text-[#9A8F7E] truncate">
                        <span dir="ltr">{humanSize(a.size)}</span> · <span dir="ltr">{formatDateTime(a.createdAt)}</span>{a.createdBy ? ` · ${a.createdBy}` : ''}
                      </span>
                    </span>
                    {isPdf(a) && <ExternalLink size={14} className="text-[#9A8F7E] flex-shrink-0" />}
                  </button>
                  {canEdit && (
                    <button type="button" onClick={() => setConfirmDel(a)} disabled={del.isPending} title={tr('حذف المرفق')} aria-label={tr('حذف المرفق')}
                      className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-50">
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {pdfLink && (
            <a href={pdfLink.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-xl bg-[#FBEBE2] text-[#C94E28] text-sm font-semibold py-2.5 hover:bg-[#F8DCCD]">
              <ExternalLink size={15} /> {tr('فتح الملف')} · <bdi className="truncate max-w-[60%]">{pdfLink.name}</bdi>
            </a>
          )}

          {/* الإضافة اللاحقة: لمن يسجّل حركات المستودع، حتى سقف الحركة */}
          {canEdit && listQ.isSuccess && room > 0 && (
            <div className="border-t border-[#F1EBDF] pt-4">
              <p className="label flex items-center gap-1.5"><Paperclip size={14} className="text-[#E15A30]" /> {tr('إضافة مرفقات')}</p>
              <PurchaseAttachmentsPicker items={pending} onChange={(v) => { setPending(v); setAddErr(''); }} existing={list.length} onBusy={setBusy} disabled={add.isPending} />
              {addErr && <p className="text-[11px] text-red-600 mt-1">{addErr}</p>}
              {pending.length > 0 && (
                <button type="button" onClick={() => add.mutate()} disabled={add.isPending || busy}
                  className="btn-primary w-full justify-center py-2 mt-2 disabled:opacity-60">
                  {add.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Upload size={15} />}
                  {tr('رفع')} ({pending.length})
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* الصورة بحجمها — data URL صورةٍ مفحوصة وحدها */}
      {viewer && (
        <div className="fixed inset-0 z-[70] bg-black/90 flex flex-col" dir="rtl" {...backdropClose(() => setViewer(null))}>
          <div className="flex items-center justify-between gap-3 p-3 text-white" onClick={(e) => e.stopPropagation()}>
            <p className="min-w-0 font-bold text-sm truncate"><bdi>{viewer.att.name}</bdi></p>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button type="button" onClick={() => { if (!downloadAttachment(viewer.data, viewer.att.name)) toast.error(tr('تعذر فتح المرفق')); }}
                className="p-2 rounded-lg hover:bg-white/10" title={tr('تنزيل')} aria-label={tr('تنزيل')}>
                <Download size={18} />
              </button>
              <button type="button" onClick={() => setViewer(null)} className="p-2 rounded-lg hover:bg-white/10" aria-label={tr('إغلاق')}><X size={20} /></button>
            </div>
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center px-3 pb-4" onClick={(e) => e.stopPropagation()}>
            <img src={viewer.src} alt={viewer.att.name} className="max-w-full max-h-full object-contain rounded-lg" />
          </div>
        </div>
      )}

      {confirmDel && (
        <ConfirmDialog danger title={tr('حذف المرفق')} message={confirmDel.name} confirmLabel={tr('حذف')} loading={del.isPending}
          onConfirm={() => del.mutate(confirmDel)} onClose={() => setConfirmDel(null)} />
      )}
    </div>
  );
}
