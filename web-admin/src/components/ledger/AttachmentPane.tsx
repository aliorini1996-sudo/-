import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, FileText, Image as ImageIcon, Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../i18n/strings';
import { ledgerErrorMessage } from '../../lib/ledger/errors';
import { useAuthStore } from '../../store/authStore';
import { canLedger, type LedgerKey } from '../../lib/ledgerPerms';
import { formatDateTime } from '../../utils/format';
import { ledgerMovesApi, ledgerMoveKeys, fileToBase64, type GlAttachment } from '../../api/ledgerMoves';
import { ledgerErrorOf } from '../../api/ledgerConfig';
import { ATTACHMENT_PDF_MAX, ATTACHMENT_IMAGE_MAX, imageNeedsReencode } from '../../lib/ledger/attachments';

/**
 * مرفقات مستند دفاتر (§8.3): قائمة بالبيانات الوصفية ومعاينة PDF بـ`<object>` من blob
 * (والصور بـ`<img>`). السقوف (§3.9): PDF حتى 1MB والصورة حتى 400KB بعد الضغط على الجهاز،
 * والخادم يفرض الحصة الشهرية والإجمالية بـ413 `LEDGER_ATTACHMENT_QUOTA`.
 */

export { ATTACHMENT_PDF_MAX, ATTACHMENT_IMAGE_MAX } from '../../lib/ledger/attachments';

/** يضغط صورة على الجهاز إلى JPEG أقل من السقف (نمط ReceiptPhoto). */
async function compressImage(file: File, maxBytes = ATTACHMENT_IMAGE_MAX): Promise<Blob> {
  if (!imageNeedsReencode(file.type, file.size, maxBytes)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    let quality = 0.82;
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= maxBytes) return blob;
      scale *= 0.8; quality = Math.max(0.5, quality - 0.08);
    }
    throw new Error('too-large');
  } finally { URL.revokeObjectURL(url); }
}

export function AttachmentPane({ entityType, entityId, writePerm = 'canPostJournals', readOnly = false }: {
  entityType: string;
  entityId: string;
  /** صلاحية الرفع (القراءة canViewLedger) */
  writePerm?: LedgerKey;
  readOnly?: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ att: GlAttachment; url: string } | null>(null);
  const canWrite = !readOnly && canLedger(user, writePerm);

  const q = useQuery({
    queryKey: ledgerMoveKeys.attachments(entityType, entityId),
    queryFn: async () => (await ledgerMovesApi.attachments.list(entityType, entityId)).data.data,
    enabled: !!entityId,
  });

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const isPdf = file.type === 'application/pdf';
      const isImage = file.type.startsWith('image/');
      if (!isPdf && !isImage) throw new Error(tr('نوع الملف غير مدعوم — PDF أو صورة فقط'));
      if (isPdf && file.size > ATTACHMENT_PDF_MAX) throw new Error(tr('ملف PDF أكبر من 1 ميغابايت'));
      let blob: Blob = file;
      if (isImage) {
        try { blob = await compressImage(file); } catch { throw new Error(tr('تعذر ضغط الصورة إلى الحجم المسموح')); }
      }
      return ledgerMovesApi.attachments.upload({
        entityType, entityId,
        fileName: isImage && blob !== file ? file.name.replace(/\.[^.]+$/, '') + '.jpg' : file.name,
        mimeType: isImage && blob !== file ? 'image/jpeg' : file.type,
        dataBase64: await fileToBase64(blob),
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ledgerMoveKeys.attachments(entityType, entityId) }); toast.success(tr('تم رفع المرفق')); },
    onError: (err: unknown) => {
      const body = ledgerErrorOf(err);
      // جسم الخادم: السبب (FILE_TOO_LARGE/MONTHLY_QUOTA/TOTAL_QUOTA/EMPTY_FILE…) لا الرمز وحده ولا رسالته العربية؛
      // بلا جسم: خطأ الفحص المحلي المترجم أعلاه
      if (body) return toast.error(ledgerErrorMessage(tr, body));
      toast.error((err as Error)?.message || tr('تعذر رفع المرفق'));
    },
  });

  const openPreview = async (att: GlAttachment) => {
    try {
      const res = await ledgerMovesApi.attachments.content(att.id, att.entityId || entityId);
      const blob = res.data instanceof Blob ? res.data : new Blob([res.data as BlobPart], { type: att.mimeType });
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ att, url: URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: att.mimeType })) });
    } catch { toast.error(tr('تعذر فتح المرفق')); }
  };

  const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-[#1F1A13]"><Paperclip size={14} />{tr('المرفقات')}
          {q.data && <span className="text-[#9A8F7E] font-normal tabular-nums">({q.data.length})</span>}
        </p>
        {canWrite && (
          <>
            <button type="button" className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1 disabled:opacity-50" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
              <Upload size={13} />{upload.isPending ? tr('جاري الرفع...') : tr('إرفاق')}
            </button>
            <input ref={inputRef} type="file" accept="application/pdf,image/*" hidden
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f); }} />
          </>
        )}
      </div>

      {q.isLoading && <p className="text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
      {q.data?.length === 0 && <p className="text-xs text-[#9A8F7E]">{tr('لا توجد مرفقات')}</p>}
      <ul className="space-y-1">
        {q.data?.map(a => (
          <li key={a.id}>
            <button type="button" className={`w-full flex items-center gap-2 text-start rounded-lg px-2 py-1.5 text-sm hover:bg-[#FBF7F0] ${preview?.att.id === a.id ? 'bg-[#FBEBE2]' : ''}`} onClick={() => openPreview(a)}>
              {a.mimeType === 'application/pdf' ? <FileText size={15} className="text-[#C0392B] shrink-0" /> : <ImageIcon size={15} className="text-[#E15A30] shrink-0" />}
              <span className="truncate flex-1"><bdi>{a.fileName}</bdi></span>
              <span className="text-[11px] text-[#9A8F7E] whitespace-nowrap">{size(a.sizeBytes)} · {formatDateTime(a.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>

      {preview && (
        <div className="rounded-xl border border-[#E8E0D2] overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 bg-[#F7F2EA] text-xs">
            <bdi className="truncate">{preview.att.fileName}</bdi>
            <button type="button" aria-label={tr('إغلاق')} onClick={() => setPreview(null)}><X size={14} /></button>
          </div>
          {preview.att.mimeType === 'application/pdf'
            ? <object data={preview.url} type="application/pdf" className="w-full h-[32rem]"><p className="p-3 text-sm">{tr('المتصفح لا يعرض PDF داخل الصفحة')}</p></object>
            : <img src={preview.url} alt={preview.att.fileName} className="w-full object-contain max-h-[32rem]" />}
        </div>
      )}
    </div>
  );
}

export default AttachmentPane;
