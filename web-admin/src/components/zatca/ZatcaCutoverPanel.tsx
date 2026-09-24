import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { zatcaApi } from '../../api/client';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { apiErrorOf } from './zatcaLogic';
import { cutoverItemsFrom, cutoverReasonLabel, isCutoverStoreAbsent, type CutoverItem } from './goLiveLogic';
import { useGoLiveTr } from './goLivePhrases';
import { backdropClose } from '../../lib/backdropClose';

/**
 * مراجعة مستندات الانتقال (D11، Z5.8) — مستندٌ أُصدر دون اتصال قبل التفعيل ووصل الخادمَ بعده خارج قاعدة القبول التلقائيّ
 * يُحال هنا: يقبله المدير مرحلةً أولى (كما أُصدر)، أو يعيد إصداره مرحلةً ثانية، أو يرفضه — لا رفض صامت أبداً.
 *
 * يُحمَّل كسولاً ويحرس نفسه: يقرأ المعلّق فقط، ويختفي تماماً حين لا معلّق أو حين يردّ الخادم 404 (شركة غير مربوطة
 * بالإطلاق) — فلا يرى شيئاً جديداً إلا من عنده مستند بحاجة إلى قرار. الخادم يعزل القائمة بالمستأجر ويحرس القرار.
 */

const CHIP: Record<string, string> = {
  pending: 'bg-[#FDF3D8] text-[#8A6100]',
};

type Pending = { item: CutoverItem; mode: 'PHASE1' | 'PHASE2' | 'REJECT' };

export default function ZatcaCutoverPanel() {
  const tr = useGoLiveTr();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ask, setAsk] = useState<Pending | null>(null);

  const q = useQuery({
    queryKey: ['zatca', 'cutover', 'PENDING'],
    queryFn: async () => cutoverItemsFrom((await zatcaApi.cutoverList('PENDING')).data),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    // شركة غير مربوطة بالإطلاق تردّ 404 — لا إعادة محاولة أبدية
    retry: (count, err) => {
      const e = apiErrorOf(err);
      if (isCutoverStoreAbsent(e.status, e.code) || e.status === 403) return false;
      return count < 1;
    },
  });

  const items = useMemo(() => q.data ?? [], [q.data]);

  // يختفي تماماً ما لم يكن ثمّة مستند معلّق (لا كارت فارغ لكل شركة مفعّلة)
  if (q.isLoading || items.length === 0) return null;

  const run = async (p: Pending, note: string) => {
    setBusyId(p.item.id);
    try {
      if (p.mode === 'REJECT') await zatcaApi.cutoverReject(p.item.id, note ? { note } : {});
      else await zatcaApi.cutoverAccept(p.item.id, { mode: p.mode, ...(note ? { note } : {}) });
      setAsk(null);
      await q.refetch();
      toast.success(tr('حُسم المستند'));
    } catch (err) {
      const e = apiErrorOf(err);
      toast.error(e.message ?? tr('تعذر تنفيذ الإجراء'));
      if (e.status === 409 || e.status === 404) await q.refetch();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card" dir="rtl">
      <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[#F1EBDF]">
        <div className="w-10 h-10 bg-[#FDF3D8] rounded-xl flex items-center justify-center shrink-0 text-[#8A6100]"><AlertTriangle size={20} /></div>
        <div className="min-w-0">
          <p className="font-semibold text-[#1F1A13]">{tr('مراجعة مستندات الانتقال')} <span dir="ltr">({items.length})</span></p>
          <p className="text-xs text-[#6E6557] mt-0.5 leading-relaxed">{tr('مستندات أصدرت دون اتصال قبل التفعيل ووصلت بعده — راجع كلا منها')}</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-[#6E6557] text-right">
              <th className="py-2 px-2 font-semibold">{tr('المرجع')}</th>
              <th className="py-2 px-2 font-semibold">{tr('وقت الإنشاء على الجهاز')}</th>
              <th className="py-2 px-2 font-semibold">{tr('المبلغ')}</th>
              <th className="py-2 px-2 font-semibold">{tr('السبب')}</th>
              <th className="py-2 px-2 font-semibold">{tr('إجراءات')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} className="border-t border-[#F1EBDF] align-top">
                <td className="py-2 px-2 font-mono text-[12px] text-[#E15A30] whitespace-nowrap" dir="ltr">{it.clientRef || it.id}</td>
                <td className="py-2 px-2 text-[11px] text-[#6E6557] whitespace-nowrap">{it.clientCreatedAt ? formatDateTime(it.clientCreatedAt) : '—'}</td>
                <td className="py-2 px-2 text-[12px] text-[#1F1A13] whitespace-nowrap">{it.amount !== null ? formatCurrency(it.amount) : '—'}</td>
                <td className="py-2 px-2 text-[11px] max-w-[16rem]">
                  <span className={`inline-block text-[11px] font-semibold rounded-full px-2 py-0.5 ${CHIP.pending}`}>{tr(cutoverReasonLabel(String(it.reason)))}</span>
                </td>
                <td className="py-2 px-2">
                  <div className="flex flex-col gap-1 items-stretch">
                    <button type="button" disabled={busyId === it.id} onClick={() => setAsk({ item: it, mode: 'PHASE1' })}
                      className="px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap bg-[#F1EBDF] text-[#4A4239] disabled:opacity-50">
                      {tr('قبول مرحلة أولى')}
                    </button>
                    <button type="button" disabled={busyId === it.id} onClick={() => setAsk({ item: it, mode: 'PHASE2' })}
                      className="px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap bg-[#E4F1EA] text-[#1E7A52] disabled:opacity-50">
                      {tr('إعادة إصدار مرحلة ثانية')}
                    </button>
                    <button type="button" disabled={busyId === it.id} onClick={() => setAsk({ item: it, mode: 'REJECT' })}
                      className="px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap bg-[#FBE3DF] text-[#C0392B] disabled:opacity-50">
                      {tr('رفض')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ask && <CutoverDialog pending={ask} busy={busyId === ask.item.id} tr={tr} onConfirm={note => { void run(ask, note); }} onClose={() => setAsk(null)} />}
    </div>
  );
}

const DIALOG: Record<Pending['mode'], { title: string; body: string; danger: boolean; icon: ReactNode }> = {
  PHASE1: { title: 'قبول المستند مرحلةً أولى', body: 'يسجّل المستند فاتورة من المرحلة الأولى كما أصدر على الجهاز', danger: false, icon: <CheckCircle2 size={26} className="text-[#1E7A52]" /> },
  PHASE2: { title: 'إعادة إصدار المستند مرحلةً ثانية', body: 'يعاد إصدار المستند فاتورة من المرحلة الثانية توقّع وترسل للهيئة', danger: false, icon: <RotateCcw size={26} className="text-[#1E7A52]" /> },
  REJECT: { title: 'رفض المستند', body: 'يرفض المستند ولا يصدر — أبلغ المندوب لإلغاء الورقة إن سلّمها للعميل', danger: true, icon: <XCircle size={26} className="text-[#C0392B]" /> },
};

function CutoverDialog({ pending, busy, tr, onConfirm, onClose }: {
  pending: Pending; busy: boolean; tr: (s: string) => string; onConfirm: (note: string) => void; onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const d = DIALOG[pending.mode];
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3 ${d.danger ? 'bg-[#FBE3DF]' : 'bg-[#E4F1EA]'}`}>{d.icon}</div>
          <h2 className="text-lg font-bold text-[#1F1A13]">{tr(d.title)}</h2>
          <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">{tr(d.body)}</p>
          <p className="text-[11px] text-[#9A8F7E] mt-1 font-mono" dir="ltr">{pending.item.clientRef || pending.item.id}</p>
          <div className="mt-3 text-right">
            <label className="label" htmlFor="cutover-note">{tr('ملاحظة')}</label>
            <textarea id="cutover-note" className="input min-h-[64px]" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-3 p-5 pt-0">
          <button onClick={onClose} className="flex-1 justify-center py-2.5 rounded-xl font-semibold bg-[#F1EBDF] text-[#4A4239]">{tr('إلغاء')}</button>
          <button onClick={() => onConfirm(note.trim())} disabled={busy}
            className={`flex-1 justify-center py-2.5 rounded-xl text-white font-semibold flex items-center gap-2 ${d.danger ? 'bg-[#C0392B] hover:bg-[#a8311f]' : 'bg-[#1E7A52] hover:bg-[#186643]'} disabled:opacity-60`}>
            {busy && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {tr('تأكيد')}
          </button>
        </div>
      </div>
    </div>
  );
}
