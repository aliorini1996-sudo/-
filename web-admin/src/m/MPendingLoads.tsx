import { Clock, Layers, Loader2, PenLine, Pencil, Printer, XCircle } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { activeLocale, formatDate, formatTime } from '../utils/format';
import { usePendingVanLoads } from '../lib/usePendingVanLoads';
import { PENDING_LOAD_TEXT, PENDING_STATUS_LABELS, PENDING_STATUS_TONES, type PendingVanLoadView } from '../lib/pendingLoads';

/**
 * «تحميلات بانتظار القبول» لمندوبٍ واحد في شاشة التحميل على الجوال («قبول المندوب للتحميل وتوقيعه»، طلب المالك ٢٢ نوفمبر ٢٠٢٦).
 * MRepLoad يعرضه والميزة مفعّلة وحدها، ولا يُرسم شيءٌ بلا صفوف. المفتوحة بإجراءي «تعديل» (أسطرها في النموذج نفسه، PUT بالمراجعة)
 * و«إلغاء» (تأكيدٌ في MRepLoad)، والمقبولة حديثاً بتوقيعها و«طباعة» الإشعار بإقرار المندوب. القراءة والتحديث في usePendingVanLoads.
 */
export default function MPendingLoads({ repId, editingId, printingId, onEdit, onCancel, onPrint }: {
  repId: string;
  /** التحميل المرسل المفتوح في النموذج الآن — يُوسم ولا يُفتح ثانيةً */
  editingId: string | null;
  printingId: string | null;
  onEdit: (v: PendingVanLoadView) => void;
  onCancel: (v: PendingVanLoadView) => void;
  onPrint: (v: PendingVanLoadView) => void;
}) {
  const tr = useTr();
  const { open, accepted } = usePendingVanLoads({ scope: 'm', salesRepId: repId, acceptedLimit: 5 });
  if (!open.length && !accepted.length) return null;
  return (
    <section className="space-y-2.5" data-m-pending-loads="">
      <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide flex items-center gap-1.5">
        <PenLine size={13} /> {tr(PENDING_LOAD_TEXT.section)}
      </h3>
      <div className="bg-white rounded-2xl border border-[#F1EBDF] overflow-hidden divide-y divide-[#F1EBDF]">
        {open.map((v) => (
          <MPendingRow key={v.id} v={v}>
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={() => onEdit(v)} disabled={editingId === v.id}
                className="flex-1 min-h-[40px] rounded-xl border border-[#E9E1D3] bg-white text-xs font-bold text-[#1F1A13] flex items-center justify-center gap-1 disabled:opacity-50">
                <Pencil size={13} /> {editingId === v.id ? tr('قيد التعديل') : tr('تعديل')}
              </button>
              <button type="button" onClick={() => onCancel(v)}
                className="flex-1 min-h-[40px] rounded-xl border border-red-200 bg-white text-xs font-bold text-[#C0392B] flex items-center justify-center gap-1">
                <XCircle size={13} /> {tr('إلغاء')}
              </button>
            </div>
          </MPendingRow>
        ))}
        {accepted.map((v) => (
          <MPendingRow key={v.id} v={v}>
            <div className="flex items-center justify-between gap-2 mt-2">
              {v.signature
                ? <img src={v.signature} alt={tr('توقيع المندوب')} className="h-10 max-w-[130px] object-contain rounded border border-[#E9E1D3] bg-white" />
                : <span />}
              <button type="button" onClick={() => onPrint(v)} disabled={printingId === v.id}
                className="min-h-[40px] px-3 rounded-xl border border-[#cfe8db] bg-white text-xs font-bold text-[#1E7A52] flex items-center gap-1 disabled:opacity-50">
                {printingId === v.id ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />} {tr('طباعة')}
              </button>
            </div>
          </MPendingRow>
        ))}
      </div>
    </section>
  );
}

const fmtQ = (n: number) => Number(Number(n).toFixed(4)).toLocaleString(activeLocale());

function MPendingRow({ v, children }: { v: PendingVanLoadView; children?: React.ReactNode }) {
  const tr = useTr();
  const when = v.status === 'ACCEPTED' ? v.acceptedAt : v.status === 'DISPUTED' ? (v.disputedAt ?? v.createdAt) : v.createdAt;
  return (
    <div className="px-3.5 py-3" data-pending-status={v.status}>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${PENDING_STATUS_TONES[v.status]}`}>{tr(PENDING_STATUS_LABELS[v.status])}</span>
        <span className="text-[10px] text-[#9A8F7E] flex items-center gap-1">
          <Clock size={10} /> {when ? `${formatDate(when)} · ${formatTime(when)}` : '—'}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {v.lines.map((l, i) => (
          <span key={i} className={`text-[11px] border rounded-md px-1.5 py-0.5 ${l.missing ? 'bg-red-50 border-red-200 text-red-700' : 'bg-[#FAF7F0] border-[#F1EBDF] text-[#1F1A13]'}`}>
            {l.name || tr('صنف محذوف')} <b className="tabular-nums">{fmtQ(l.qty)}</b> {l.unitName}
            {l.lots.map((x, k) => (
              <span key={k} className="ms-1 inline-flex items-center gap-0.5 text-[10px] text-[#6E6557]">
                <Layers size={9} className="text-[#E15A30]" /> {x.lotNumber ?? tr('غير مسمى')} ×{fmtQ(x.qty)}
              </span>
            ))}
          </span>
        ))}
      </div>
      {v.note && <p className="text-[11px] text-[#6E6557] mt-1">{v.note}</p>}
      {v.status === 'DISPUTED' && v.disputeNote && (
        <p className="mt-1.5 text-[11px] rounded-lg border border-red-200 bg-red-50 text-red-800 px-2.5 py-1.5">
          <b>{tr(PENDING_LOAD_TEXT.disputeNote)}:</b> {v.disputeNote}
        </p>
      )}
      {children}
    </div>
  );
}
