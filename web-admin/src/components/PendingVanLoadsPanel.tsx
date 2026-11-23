import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Clock, Layers, PenLine, Pencil, Printer, RefreshCw, XCircle } from 'lucide-react';
import { pendingLoadsApi, salesRepApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { activeLocale, formatDate, formatTime } from '../utils/format';
import DocumentModal from './DocumentModal';
import ConfirmDialog from './ConfirmDialog';
import { loadNoticeDocFromData, type Company, type LoadNoticeDoc } from '../rep/RepDocuments';
import { usePendingVanLoads } from '../lib/usePendingVanLoads';
import {
  PENDING_LOADS_KEY, PENDING_LOAD_TEXT, PENDING_STATUS_LABELS, PENDING_STATUS_TONES, acceptanceOf, fetchPendingDetail,
  noticeMovementOf, pendingErrorText, type PendingLineView, type PendingVanLoadView,
} from '../lib/pendingLoads';

/**
 * «تحميلات بانتظار القبول» في صفحة مخزون السيارات («قبول المندوب للتحميل وتوقيعه»، طلب المالك ٢٢ نوفمبر ٢٠٢٦) — تُعرض والميزة
 * مفعّلة وحدها (VanStockPage يقرّر)، فالمطفأة لا جلب لها ولا قسم.
 *
 *  - المفتوحة (بانتظار القبول، والمعترض عليها بملاحظة المندوب أولاً) بأسطرها وإجراءي «تعديل» (نافذة التحميل نفسها، PUT بالمراجعة)
 *    و«إلغاء» (تأكيدٌ ثم POST …/cancel). تُعاد كل دقيقة ما دام فيها ما ينتظر — القبول يأتي من جهاز المندوب.
 *  - المقبولة حديثاً بصورة التوقيع ولحظة القبول، و«طباعة» الإشعار بإقرار المندوب وتوقيعه (GET …/:id بالحركة التي كتبها القبول).
 *  - قبولٌ جديد يظهر هنا يعني أن البضاعة دخلت السيارة وخرجت من المستودع ⇒ تُبطَل مفاتيح المخزون فتتحدّث الصفحة.
 */
export default function PendingVanLoadsPanel({ company, onEdit }: {
  /** بيانات الشركة لترويسة الإشعار المطبوع */
  company: Company | null;
  /** فتح نافذة التحميل بأسطر هذا التحميل المرسل */
  onEdit: (view: PendingVanLoadView) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [repFilter, setRepFilter] = useState('');
  const [cancelling, setCancelling] = useState<PendingVanLoadView | null>(null);
  const [notice, setNotice] = useState<LoadNoticeDoc | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);

  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string }[] });
  // المفتوحة (تُعاد كل دقيقة ما دام فيها ما ينتظر) والمقبولة حديثاً بتوقيعاتها — وقبولٌ جديد يُحدّث المخزون (usePendingVanLoads)
  const { openQ, open, accepted, counts, refetch, fetching } = usePendingVanLoads({ scope: 'web', salesRepId: repFilter });

  const cancel = useMutation({
    mutationFn: (v: PendingVanLoadView) => pendingLoadsApi.cancel(v.id),
    onSuccess: () => {
      toast.success(tr(PENDING_LOAD_TEXT.cancelled));
      setCancelling(null);
      qc.invalidateQueries({ queryKey: [PENDING_LOADS_KEY] });
    },
    onError: (e: unknown) => {
      setCancelling(null);
      qc.invalidateQueries({ queryKey: [PENDING_LOADS_KEY] });
      toast.error(pendingErrorText(e, tr, 'تعذر الحفظ'));
    },
  });

  /** إشعار التحميل المقبول: الصفّ بتوقيعه والحركة التي كتبها القبول — ثم الإشعار بإقرار المندوب */
  const print = async (v: PendingVanLoadView) => {
    setPrinting(v.id);
    try {
      const d = await fetchPendingDetail(pendingLoadsApi, v.id);
      if (!d) throw new Error('missing');
      const view = { ...d.view, repName: d.view.repName || v.repName };
      setNotice(loadNoticeDocFromData(view.repName, noticeMovementOf(view, d.vanLoad), company, acceptanceOf(view)));
    } catch (e) {
      toast.error(pendingErrorText(e, tr, 'تعذر تحميل البيانات'));
    } finally {
      setPrinting(null);
    }
  };

  return (
    <div className="card p-0 overflow-hidden" data-pending-van-loads="">
      <div className="px-5 py-3.5 border-b border-[#F1EBDF] flex items-center justify-between gap-3 flex-wrap">
        <p className="font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <PenLine size={17} className="text-[#E15A30]" /> {tr(PENDING_LOAD_TEXT.section)}
          {counts && counts.pending > 0 && (
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${PENDING_STATUS_TONES.PENDING}`}>{tr(PENDING_STATUS_LABELS.PENDING)} {fmtN(counts.pending)}</span>
          )}
          {counts && counts.disputed > 0 && (
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${PENDING_STATUS_TONES.DISPUTED}`}>{tr(PENDING_STATUS_LABELS.DISPUTED)} {fmtN(counts.disputed)}</span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <select className="input w-auto py-1.5 text-xs" value={repFilter} onChange={(e) => setRepFilter(e.target.value)} aria-label={tr('المندوب')}>
            <option value="">{tr('كل المناديب')}</option>
            {(repsQ.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button type="button" onClick={refetch} title={tr('تحديث')}
            className="p-2 rounded-lg border border-[#E9E1D3] text-[#6E6557] hover:bg-gray-50">
            <RefreshCw size={14} className={fetching ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      {openQ.isLoading ? (
        <div className="p-6 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
      ) : openQ.isError ? (
        <div className="p-6 text-center text-red-500 text-sm">{tr('تعذر تحميل البيانات')}</div>
      ) : open.length === 0 ? (
        <div className="p-5 text-center text-gray-400 text-sm">{tr(PENDING_LOAD_TEXT.empty)}</div>
      ) : (
        <div className="divide-y divide-[#F1EBDF]">
          {open.map((v) => (
            <PendingRow key={v.id} v={v}>
              <div className="flex items-center gap-2 mt-2">
                <button type="button" onClick={() => onEdit(v)}
                  className="text-xs font-semibold inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E9E1D3] text-[#1F1A13] hover:bg-gray-50">
                  <Pencil size={12} /> {tr('تعديل')}
                </button>
                <button type="button" onClick={() => setCancelling(v)}
                  className="text-xs font-semibold inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-[#C0392B] hover:bg-red-50">
                  <XCircle size={12} /> {tr('إلغاء')}
                </button>
              </div>
            </PendingRow>
          ))}
        </div>
      )}

      {accepted.length > 0 && (
        <div className="border-t border-[#F1EBDF]">
          <p className="px-5 pt-3 text-[11px] font-bold text-[#9A8F7E]">{tr('قبلها المناديب مؤخرا')}</p>
          <div className="divide-y divide-[#F1EBDF]">
            {accepted.map((v) => (
              <PendingRow key={v.id} v={v}>
                <div className="flex items-center justify-between gap-3 mt-2">
                  {v.signature ? (
                    <img src={v.signature} alt={tr('توقيع المندوب')} className="h-10 max-w-[140px] object-contain rounded border border-[#E9E1D3] bg-white" />
                  ) : <span />}
                  <button type="button" onClick={() => void print(v)} disabled={printing === v.id}
                    className="text-xs font-semibold inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#cfe8db] text-[#1E7A52] hover:bg-[#E4F1EA] disabled:opacity-50">
                    <Printer size={12} /> {tr('طباعة')}
                  </button>
                </div>
              </PendingRow>
            ))}
          </div>
        </div>
      )}

      {cancelling && (
        <ConfirmDialog title={tr('إلغاء التحميل')} danger loading={cancel.isPending}
          message={tr(PENDING_LOAD_TEXT.cancelConfirm)}
          extra={<p className="text-xs text-[#6E6557]">{cancelling.repName} — {linesSummary(cancelling.lines)}</p>}
          confirmLabel={tr('إلغاء التحميل')}
          onConfirm={() => cancel.mutate(cancelling)} onClose={() => { if (!cancel.isPending) setCancelling(null); }} />
      )}
      {notice && <DocumentModal doc={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

const fmtN = (n: number) => n.toLocaleString(activeLocale());
const fmtQ = (n: number) => Number(Number(n).toFixed(4)).toLocaleString(activeLocale());

/** «صنفان: سكر ×٢ كرتون، أرز ×٥ كيس» — لتأكيد الإلغاء */
function linesSummary(lines: readonly PendingLineView[]): string {
  return lines.map((l) => `${l.name} ×${fmtQ(l.qty)} ${l.unitName}`.trim()).join('، ');
}

/** بطاقة تحميلٍ مرسل: المندوب والحالة والوقت ومن أرسله، والأسطر بتشغيلاتها، واعتراض المندوب — والإجراءات تحتها */
function PendingRow({ v, children }: { v: PendingVanLoadView; children?: React.ReactNode }) {
  const tr = useTr();
  const when = v.status === 'ACCEPTED' ? v.acceptedAt : v.status === 'DISPUTED' ? (v.disputedAt ?? v.createdAt) : v.createdAt;
  return (
    <div className="px-5 py-3" data-pending-status={v.status}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="flex items-center gap-2 flex-wrap">
          <b className="text-sm text-[#1F1A13]">{v.repName || '—'}</b>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${PENDING_STATUS_TONES[v.status]}`}>{tr(PENDING_STATUS_LABELS[v.status])}</span>
          {v.revision > 1 && <span className="text-[10px] text-[#9A8F7E]">{tr(PENDING_LOAD_TEXT.revised)} {fmtN(v.revision)}</span>}
        </span>
        <span className="text-[11px] text-[#9A8F7E] flex items-center gap-1">
          <Clock size={11} /> {when ? `${formatDate(when)} ${formatTime(when)}` : '—'}
          {v.createdByName && <> · {v.createdByName}</>}
        </span>
      </div>
      {v.note && <p className="text-xs text-[#6E6557] mt-1">{v.note}</p>}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {v.lines.map((l, i) => (
          <span key={i} className={`text-[11px] border rounded-md px-2 py-0.5 ${l.missing ? 'bg-red-50 border-red-200 text-red-700' : 'bg-[#FAF7F0] border-[#F1EBDF] text-[#1F1A13]'}`}>
            {l.name || tr('صنف محذوف')} <b>{fmtQ(l.qty)}</b> {l.unitName}
            {l.lots.map((x, k) => (
              <span key={k} className="ms-1 inline-flex items-center gap-0.5 rounded bg-white border border-[#E9E1D3] px-1 text-[10px] text-[#6E6557]">
                <Layers size={10} className="text-[#E15A30]" /> {x.lotNumber ?? tr('غير مسمى')} ×{fmtQ(x.qty)}
              </span>
            ))}
          </span>
        ))}
      </div>
      {v.status === 'DISPUTED' && v.disputeNote && (
        <p className="mt-2 text-xs rounded-lg border border-red-200 bg-red-50 text-red-800 px-3 py-2">
          <b>{tr(PENDING_LOAD_TEXT.disputeNote)}:</b> {v.disputeNote}
        </p>
      )}
      {children}
    </div>
  );
}
