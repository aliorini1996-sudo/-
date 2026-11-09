import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StickyNote, Trash2, X, Send, Handshake } from 'lucide-react';
import toast from 'react-hot-toast';
import { tenantApi } from '../api/client';
import type { Tenant } from '../types';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';

/**
 * «حالة الصفقة» و«الملاحظات» لكل شركة في لوحة المنصة (طلب المالك ٩ نوفمبر ٢٠٢٦).
 * للمالك ولمن يرى قائمة الشركات من الموظفين — والخادم لا يُسمعها للشركة أبداً (routes/tenants.ts).
 * المفاتيح نفسها في الخادم: DEAL_STAGES.
 */
export const DEAL_STAGE_OPTIONS = [
  { value: 'NOT_FIT', label: 'غير مناسب', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
  { value: 'CONTACTED', label: 'تم التواصل', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'MEETING', label: 'تم الاجتماع', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { value: 'NO_REPLY', label: 'لم يتم الرد', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  { value: 'NEGOTIATION', label: 'المفاوضة', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  { value: 'BUYER', label: 'مشتري', cls: 'bg-green-50 text-green-700 border-green-200' },
  { value: 'LOST', label: 'تم خسارة العميل', cls: 'bg-red-50 text-red-700 border-red-200' },
] as const;

type ApiErr = { response?: { data?: { message?: string } } };
const errMsg = (e: unknown, fallback: string) => (e as ApiErr)?.response?.data?.message || fallback;

/** القائمة المنسدلة لحالة الصفقة في صفّ الشركة — الاختيار يُحفظ فوراً ويُسجَّل في الملاحظات */
export function DealStageSelect({ tenant }: { tenant: Tenant }) {
  const tr = useTr();
  const qc = useQueryClient();
  const current = tenant.platformDeal?.stage ?? '';
  const opt = DEAL_STAGE_OPTIONS.find((o) => o.value === current);
  const m = useMutation({
    mutationFn: (stage: string | null) => tenantApi.setDeal(tenant.id, stage),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] });
      qc.invalidateQueries({ queryKey: ['tenant-notes', tenant.id] });
    },
    onError: (e) => toast.error(errMsg(e, tr('تعذر حفظ حالة الصفقة'))),
  });
  return (
    <select
      value={current}
      disabled={m.isPending}
      onChange={(e) => m.mutate(e.target.value || null)}
      title={tenant.platformDeal ? `${tr('حالة الصفقة')} — ${tenant.platformDeal.updatedByName}` : tr('حالة الصفقة')}
      aria-label={tr('حالة الصفقة')}
      className={`text-xs font-medium rounded-full border px-2 py-1 max-w-[9.5rem] cursor-pointer outline-none focus:ring-2 focus:ring-[#E15A30]/30 ${opt ? opt.cls : 'bg-white text-gray-400 border-dashed border-gray-300'}`}
    >
      <option value="">{tr('حالة الصفقة')}</option>
      {DEAL_STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{tr(o.label)}</option>)}
    </select>
  );
}

/** أيقونة الملاحظات بعددها */
export function NotesButton({ tenant, onClick }: { tenant: Tenant; onClick: () => void }) {
  const tr = useTr();
  const n = tenant.notesCount ?? 0;
  return (
    <button onClick={onClick} className="relative p-1.5 rounded text-[#8A6D1F] hover:bg-amber-50" title={tr('ملاحظات الشركة ومجريات الصفقة')} aria-label={tr('الملاحظات')}>
      <StickyNote size={16} />
      {n > 0 && (
        <span className="absolute -top-1 -left-1 min-w-[16px] h-4 px-1 rounded-full bg-[#E15A30] text-white text-[10px] leading-4 text-center font-bold">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </button>
  );
}

type Note = { id: string; kind: string; body: string; authorKind: string; authorName: string; createdAt: string };
type NotesData = { notes: Note[]; deal: { stage: string; updatedAt: string; updatedByName: string } | null };

const fmtDateTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};

/** نافذة الملاحظات: كتابة ملاحظة، وسجلّها الأحدث أولاً بالكاتب والوقت، وتغييرات حالة الصفقة فيه */
export function TenantNotesModal({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['tenant-notes', tenant.id],
    queryFn: async () => (await tenantApi.notes(tenant.id)).data.data as NotesData,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tenant-notes', tenant.id] });
    qc.invalidateQueries({ queryKey: ['tenants'] });
  };
  const add = useMutation({
    mutationFn: (text: string) => tenantApi.addNote(tenant.id, text),
    onSuccess: () => { setBody(''); refresh(); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر حفظ الملاحظة'))),
  });
  const del = useMutation({
    mutationFn: (noteId: string) => tenantApi.removeNote(tenant.id, noteId),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e, tr('تعذر حذف الملاحظة'))),
  });
  const submit = () => { const t = body.trim(); if (t && !add.isPending) add.mutate(t); };
  const live = { ...tenant, platformDeal: data ? data.deal : tenant.platformDeal };

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
              <p className="text-sm text-[#6E6557] truncate">{tenant.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="px-5 pt-4 flex items-center gap-2 text-sm text-[#6E6557]">
          <Handshake size={16} className="text-[#E15A30]" />
          <span>{tr('حالة الصفقة')}</span>
          <DealStageSelect tenant={live} />
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
          ) : data.notes.length === 0 ? (
            <p className="text-center text-gray-400 py-8">{tr('لا توجد ملاحظات بعد')}</p>
          ) : data.notes.map((n) => (
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
        </div>
      </div>
    </div>
  );
}
