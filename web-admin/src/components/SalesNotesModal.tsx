import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StickyNote, Trash2, X, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';
import { gregorianLocale } from '../utils/format';
import type { SalesRow } from '../lib/salesCrm';

/**
 * ملاحظات «إدارة المبيعات» لكل جهة تواصل — مثل ملاحظات الشركات في لوحة المالك (TenantCrm): أيقونة بعدّادها تفتح سجلاً
 * بالكاتب والوقت، الأحدث أولاً، وتغييرات الحالة فيه سطوراً آلية (طلب المالك ١٦ نوفمبر ٢٠٢٦). الملاحظة القديمة المفردة
 * (حقل note قبل السجلّ) تُعرض في أوله «ملاحظة سابقة» ويمكن حذفها.
 */

type Note = { id: string; kind: string; body: string; authorKind: string; authorName: string; createdAt: string };
type NotesData = { notes: Note[]; legacyNote: string | null };

const errMsg = (e: unknown, fallback: string): string =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

const fmtDateTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(gregorianLocale('ar-SA-u-nu-latn'), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};

/** أيقونة الملاحظات بعددها — كأيقونة الشركات في الصفحة الرئيسية للوحة المالك */
export function SalesNotesButton({ row, onClick }: { row: SalesRow; onClick: () => void }) {
  const tr = useTr();
  const n = row.notesCount ?? (row.note ? 1 : 0);
  return (
    <button onClick={onClick} className="relative p-1.5 rounded text-[#8A6D1F] hover:bg-amber-50" title={tr('ملاحظات العميل ومجريات المتابعة')} aria-label={tr('الملاحظات')}>
      <StickyNote size={16} />
      {n > 0 && (
        <span className="absolute -top-1 -left-1 min-w-[16px] h-4 px-1 rounded-full bg-[#E15A30] text-white text-[10px] leading-4 text-center font-bold">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </button>
  );
}

export function SalesNotesModal({ row, onClose }: { row: SalesRow; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sales-notes', row.id],
    queryFn: async () => (await salesApi.notes(row.id)).data.data as NotesData,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sales-notes', row.id] });
    qc.invalidateQueries({ queryKey: ['sales-inbox'] });
  };
  const add = useMutation({
    mutationFn: (text: string) => salesApi.addNote(row.id, text),
    onSuccess: () => { setBody(''); refresh(); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر حفظ الملاحظة'))),
  });
  const del = useMutation({
    mutationFn: (noteId: string) => salesApi.removeNote(row.id, noteId),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e, tr('تعذر حذف الملاحظة'))),
  });
  const delLegacy = useMutation({
    mutationFn: () => salesApi.update(row.id, { note: null }),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e, tr('تعذر حذف الملاحظة'))),
  });
  const submit = () => { const t = body.trim(); if (t && !add.isPending) add.mutate(t); };
  const title = row.name || row.company || row.phone || row.email || '';
  const empty = !!data && data.notes.length === 0 && !data.legacyNote;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
              <StickyNote size={22} className="text-[#8A6D1F]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('الملاحظات')}</h2>
              {title && <p className="text-sm text-[#6E6557] truncate">{title}</p>}
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="p-5 border-b border-[#E9E1D3]">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
            rows={3}
            maxLength={5000}
            placeholder={tr('اكتب ملاحظة عن العميل أو مجريات الصفقة')}
            className="input w-full resize-y"
            autoFocus
          />
          <div className="flex justify-end mt-2">
            <button onClick={submit} disabled={!body.trim() || add.isPending}
              className="flex items-center gap-1.5 text-sm text-white rounded-lg px-3 py-1.5 font-semibold bg-[#E15A30] disabled:opacity-50">
              <Send size={14} /> {add.isPending ? tr('جاري الحفظ') : tr('إضافة الملاحظة')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {isLoading ? (
            <p className="text-center text-gray-400 py-8">{tr('جاري التحميل')}</p>
          ) : isError || !data ? (
            <p className="text-center text-red-500 py-8">{tr('تعذر تحميل الملاحظات')}</p>
          ) : empty ? (
            <p className="text-center text-gray-400 py-8">{tr('لا توجد ملاحظات بعد')}</p>
          ) : (
            <>
              {data.notes.map((n) => (
                <div key={n.id} className={`rounded-xl border p-3 ${n.kind === 'STAGE' ? 'bg-[#FBF7EF] border-[#EDE3CF]' : 'bg-white border-[#E9E1D3]'}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs text-[#6E6557]">
                      <b className="text-[#1F1A13]">{n.authorName}</b>
                      {n.authorKind === 'STAFF' ? ` · ${tr('موظف')}` : ` · ${tr('المالك')}`}
                      {' · '}<span dir="ltr">{fmtDateTime(n.createdAt)}</span>
                    </span>
                    <button
                      onClick={() => { if (window.confirm(tr('حذف هذه الملاحظة نهائيا؟'))) del.mutate(n.id); }}
                      disabled={del.isPending}
                      className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" title={tr('حذف')} aria-label={tr('حذف')}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <p className={`text-sm whitespace-pre-wrap break-words ${n.kind === 'STAGE' ? 'text-[#8A5A1F] font-medium' : 'text-[#1F1A13]'}`}>{n.body}</p>
                </div>
              ))}
              {data.legacyNote && (
                <div className="rounded-xl border p-3 bg-white border-[#E9E1D3]">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs text-[#6E6557]">{tr('ملاحظة سابقة')}</span>
                    <button
                      onClick={() => { if (window.confirm(tr('حذف هذه الملاحظة نهائيا؟'))) delLegacy.mutate(); }}
                      disabled={delLegacy.isPending}
                      className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" title={tr('حذف')} aria-label={tr('حذف')}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words text-[#1F1A13]">{data.legacyNote}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
