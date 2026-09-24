import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { invoiceApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { ZATCA_ACTION_LABELS } from '../../lib/zatca/docStatus';
import {
  ZATCA_QUEUE_FILTERS, ZATCA_QUEUE_FILTER_LABELS, zatcaQueueAlerts, zatcaQueueCounts,
  zatcaQueueFilterRows, zatcaQueueRows, type ZatcaActionKind, type ZatcaQueueFilter, type ZatcaQueueRow,
} from '../../lib/zatca/docQueue';
import ZatcaActionDialog from './ZatcaActionDialog';
import ZatcaShareDialog from './ZatcaShareDialog';
import { isShareableMirror } from '../../lib/zatca/shareView';
import { useZatcaTr as useTr } from './zatcaPhrases';

/**
 * فوترة ZATCA المرحلة الثانية (Z5.6c) — شاشة متابعة المستندات الضريبية لمدير الشركة.
 *
 * المستند الضريبيّ يُرسَل إلى الهيئة **بعد** الإصدار، وتوقّف الإرسال لا يظهر في أيّ شاشة اليوم: تمرّ مهلة الإبلاغ
 * (٢٤ ساعة للمبسّطة) على مستندٍ لم تستلمه الهيئة فتقع مخالفة نظامية بلا أن يشعر أحد. فهذه الشاشة تعرض الطابور
 * وحالته وآخر ما قالته الهيئة لكلّ مستند، وتفتح الإجراءات الثلاثة التي يقبلها الخادم (إعادة إرسال، سحب، إعادة إصدار).
 *
 * تُحمَّل **كسولاً** من داخل تبويب الفوترة الإلكترونية (وهو نفسه كسول): لا تدخل حزمة أيّ شركة لم تفتحها. ومنطقها
 * كلّه في `lib/zatca/docQueue.ts` النقيّ — هنا الرسم والنداء وحدهما.
 *
 * وحدّ البيانات مُعلَن في الشاشة نفسها: لا مسار طابور في الخادم (لا مرشِّح `einvoiceStatus` ولا عدّاد)، فتُقرأ نافذة
 * زمنية من `GET /invoices` وتُصنَّف في العميل — والعدد عن النافذة المعروضة لا عن الشركة كلّها، وهذا مكتوبٌ للمستخدم.
 */

/** أقصى ما يُطلب من صفوف لنافذةٍ واحدة — القاعدة هي عنق الزجاجة، ولا يُطلب ما لا يُقرأ. */
const WINDOW_LIMIT = 200;
const WINDOWS: ReadonlyArray<{ days: number; label: string }> = Object.freeze([
  { days: 7, label: 'آخر سبعة أيام' },
  { days: 30, label: 'آخر ثلاثين يوما' },
]);

const CHIP_TONE: Record<string, string> = {
  pending: 'bg-[#E8EFFA] text-[#1F4E8C]',
  ok: 'bg-[#E4F1EA] text-[#1E7A52]',
  warn: 'bg-[#FDF3D8] text-[#8A6100]',
  danger: 'bg-[#FBE3DF] text-[#C0392B]',
  muted: 'bg-[#F1EBDF] text-[#6E6557]',
};

const fromDate = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const serverMessage = (err: unknown): string | null => {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof m === 'string' && m !== '' ? m : null;
};

export default function ZatcaDocsPanel() {
  const tr = useTr();
  const [days, setDays] = useState(WINDOWS[0].days);
  const [filter, setFilter] = useState<ZatcaQueueFilter>('all');
  const [ask, setAsk] = useState<{ row: ZatcaQueueRow; kind: ZatcaActionKind } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Z5.7 — رابط المشتري: صفٌّ واحد في كلّ مرّة، والخادم هو من يحكم بتوفّر الرابط لا هذه الشاشة
  const [share, setShare] = useState<ZatcaQueueRow | null>(null);
  // الإجراءات خلف `requireAdmin` في الخادم — لا يُعرض زرٌّ يُردّ عليه 403
  const allowed = useAuthStore(s => s.isAdmin)();

  const q = useQuery({
    queryKey: ['zatca', 'documents', days],
    /* الصفحة الأولى وحدها من النافذة، و`total` معها: الخادم يرتّب بالأحدث، فشركةٌ تجاوزت فواتيرُها السقف يسقط
     * أقدمُ مستنداتها من القراءة — وهي بعينها الأقرب لتجاوز مهلة الإبلاغ. فيُقرأ العدد الكلّي ويُقال القصُّ صراحةً. */
    queryFn: async () => {
      const body = (await invoiceApi.list({ from: fromDate(days), limit: WINDOW_LIMIT })).data as {
        data: unknown[]; pagination?: { total?: number };
      };
      return { rows: body.data ?? [], total: Number(body.pagination?.total ?? 0) };
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
    // طابورٌ فيه معلّق يتحرّك وحده: تحديث كل دقيقة ما دامت الشاشة مفتوحة، ولا استطلاع حين استقرّ كلّ شيء
    refetchInterval: query => {
      const rows = (query.state.data as { rows?: unknown[] } | undefined)?.rows ?? [];
      return zatcaQueueRows(rows, { allowed: false }).some(r => r.bucket === 'pending') ? 60_000 : false;
    },
  });

  const truncated = (q.data?.total ?? 0) > WINDOW_LIMIT;
  const rows = useMemo(() => zatcaQueueRows(q.data?.rows, { allowed }), [q.data, allowed]);
  const counts = useMemo(() => zatcaQueueCounts(rows), [rows]);
  const alerts = useMemo(() => zatcaQueueAlerts(rows), [rows]);
  const shown = useMemo(() => zatcaQueueFilterRows(rows, filter), [rows, filter]);

  const run = async () => {
    if (!ask) return;
    const { row, kind } = ask;
    setBusyId(row.id);
    try {
      const call = kind === 'retry' ? invoiceApi.einvoiceRetry : kind === 'withdraw' ? invoiceApi.einvoiceWithdraw : invoiceApi.einvoiceReissue;
      await call(row.id);
      setAsk(null);
      await q.refetch();
      toast.success(tr(ZATCA_ACTION_LABELS[kind]));
    } catch (err) {
      // رسالة الخادم أوّلاً: هي التي تحمل سبب الرفض (قيد الإرسال الآن، حسمته الهيئة، الإرسال موقوف…)
      toast.error(serverMessage(err) ?? tr('تعذر تنفيذ الإجراء'));
    }
    setBusyId(null);
  };

  return (
    <div className="space-y-4" dir="rtl">
      {alerts.map(a => (
        <div key={a.key} className={`flex items-start gap-2.5 border rounded-xl px-4 py-3 text-sm leading-relaxed ${
          a.tone === 'danger' ? 'bg-[#FBE3DF] border-[#F2C4BC] text-[#8E2A1F]' : 'bg-[#FDF3D8] border-[#F0DDA6] text-[#6B4B00]'}`}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">{tr(a.title)} ({a.count})</p>
            <p className="text-[13px] mt-0.5">{tr(a.body)}</p>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 flex-wrap">
        {WINDOWS.map(w => (
          <button key={w.days} type="button" onClick={() => setDays(w.days)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${days === w.days ? 'bg-[#1F1A13] text-white' : 'bg-[#F1EBDF] text-[#6E6557]'}`}>
            {tr(w.label)}
          </button>
        ))}
        <button type="button" className="btn-secondary mr-auto" disabled={q.isFetching} onClick={() => { void q.refetch(); }}>
          {q.isFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {tr('تحديث')}
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {ZATCA_QUEUE_FILTERS.map(f => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${filter === f ? 'bg-[#E15A30] text-white' : 'bg-[#F1EBDF] text-[#6E6557]'}`}>
            {tr(ZATCA_QUEUE_FILTER_LABELS[f])} ({f === 'all' ? counts.all : counts[f]})
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[#6E6557]">{tr('العدد عن النافذة المعروضة وحدها لا عن كل مستندات الشركة')}</p>
      {/* والنافذة نفسها مقصوصة عند السقف: صمتٌ عنه يُظهر «تجاوزت المهلة (0)» على شركةٍ لها متأخّرات فعلاً */}
      {truncated && (
        <div className="flex items-start gap-2.5 border rounded-xl px-4 py-3 text-sm leading-relaxed bg-[#FDF3D8] border-[#F0DDA6] text-[#6B4B00]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold" dir="ltr">{WINDOW_LIMIT} / {q.data?.total}</p>
            <p className="text-[13px] mt-0.5">{tr('عرضت أحدث المستندات وحدها وبقي أقدمها خارج النافذة قلص المدة أو راجع الطابور على دفعات')}</p>
          </div>
        </div>
      )}

      {q.isError && (
        <div className="border rounded-xl px-4 py-3 text-sm bg-[#FBE3DF] border-[#F2C4BC] text-[#8E2A1F]">
          <p className="font-semibold">{tr('تعذر تحميل مستندات الفوترة الإلكترونية')}</p>
          <p className="text-[13px] mt-0.5">{serverMessage(q.error) ?? tr('حاول مجددا بعد قليل')}</p>
        </div>
      )}

      {q.isLoading ? (
        <p className="text-center text-[#6E6557] text-sm py-8">{tr('جاري التحميل')}</p>
      ) : shown.length === 0 ? (
        <p className="text-center text-[#6E6557] text-sm py-8">{tr('لا مستندات ضريبية في هذه النافذة')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[#6E6557] text-right">
                <th className="py-2 px-2 font-semibold">{tr('الرقم')}</th>
                <th className="py-2 px-2 font-semibold">{tr('العميل')}</th>
                <th className="py-2 px-2 font-semibold">{tr('وقت الإصدار')}</th>
                <th className="py-2 px-2 font-semibold">{tr('الحالة')}</th>
                <th className="py-2 px-2 font-semibold">{tr('آخر رسالة من الهيئة')}</th>
                <th className="py-2 px-2 font-semibold">{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.id} className={`border-t border-[#F1EBDF] align-top ${r.bucket === 'overdue' ? 'bg-[#FBE3DF]/40' : ''}`}>
                  <td className="py-2 px-2 font-mono text-[12px] text-[#E15A30] whitespace-nowrap">
                    {r.number}
                    {r.total !== null && <div className="text-[11px] text-[#6E6557] font-sans">{formatCurrency(r.total)}</div>}
                  </td>
                  <td className="py-2 px-2 text-[12px] text-[#1F1A13]">
                    {r.customerName || '—'}
                    {r.repName && <div className="text-[11px] text-[#6E6557]">{r.repName}</div>}
                  </td>
                  <td className="py-2 px-2 text-[11px] text-[#6E6557] whitespace-nowrap">
                    {r.at ? formatDateTime(r.at) : '—'}
                    {r.stalled && <div className="text-[#8A6100] font-semibold">{tr('تأخر الإرسال')}</div>}
                  </td>
                  <td className="py-2 px-2">
                    <span className={`inline-block text-[11px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${CHIP_TONE[r.chip.tone]}`}>
                      {tr(r.chip.label)}
                    </span>
                    <div className="text-[11px] text-[#6E6557] mt-1 max-w-[16rem] leading-relaxed">{tr(r.chip.hint)}</div>
                  </td>
                  <td className="py-2 px-2 text-[11px] max-w-[18rem]">
                    {r.message ? (
                      <span className={r.message.kind === 'error' ? 'text-[#C0392B]' : 'text-[#8A6100]'}>
                        {r.message.code && <b className="font-mono ml-1" dir="ltr">{r.message.code}</b>}
                        {r.message.text}
                      </span>
                    ) : <span className="text-[#B9B0A1]">{tr('لا رسالة')}</span>}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex flex-col gap-1 items-stretch">
                      {/* الرابط يُعرض لما حسمته الهيئة وتجوز طباعته وحده — وما عداه يردّه الخادم بسببه */}
                      {isShareableMirror(r.view.mirror) && (
                        <button type="button" onClick={() => setShare(r)}
                          className="px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap bg-[#F1EBDF] text-[#4A4239]">
                          {tr('رابط المشتري')}
                        </button>
                      )}
                      {(['retry', 'withdraw', 'reissue'] as const).filter(k => r.actions[k]).map(k => (
                        <button key={k} type="button" disabled={busyId === r.id} onClick={() => setAsk({ row: r, kind: k })}
                          className={`px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap disabled:opacity-50 ${
                            k === 'withdraw' ? 'bg-[#FBE3DF] text-[#C0392B]' : k === 'reissue' ? 'bg-[#E4F1EA] text-[#1E7A52]' : 'bg-[#E8EFFA] text-[#1F4E8C]'}`}>
                          {tr(ZATCA_ACTION_LABELS[k])}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {share && (
        <ZatcaShareDialog invoiceId={share.id} number={share.number} tr={tr} onClose={() => setShare(null)} />
      )}

      {ask && (
        <ZatcaActionDialog kind={ask.kind} subject={ask.row.number} busy={busyId === ask.row.id} tr={tr}
          onConfirm={() => { void run(); }} onClose={() => setAsk(null)} />
      )}
    </div>
  );
}
