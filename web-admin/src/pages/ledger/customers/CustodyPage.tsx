import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import { formatDateTime } from '../../../utils/format';
import { LedgerLoadingToast } from '../../../components/ledger/LedgerListView';
import { Badge, MilliAmount } from '../../../components/ledger/SyncBadges';
import { ledgerErrorOf } from '../../../api/ledgerConfig';
import { ledgerReviewApi, ledgerReviewKeys, type CustodyRepRow } from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { ledgerHref } from '../routes';
import { NotActivatedNotice } from './postingFilters';

/**
 * «العملاء ← عهدة المناديب» (M3، §5.5 custodyComponents، §5.9 C4/C4b، D3 الخيار ب، D9): لكل مندوب رصيد 111003 في الأستاذ
 * مقابل ledgerCustody (C4)، ورصيد الشاشة التشغيلية مفصّلاً بمكوّناته (C4b): العهدة + إلكتروني غير مصفّى + مصروفات العهدة
 * + العجز المفتوح + العجز المحمّل على المصروف. التوسيع يعرض الاستلامات بتقسيمها (covered/recovered/r/suspense).
 * زر «تسجيل عجز» (canPostJournals) يصل في M4 مع مساره.
 */

const isZero = (m: string | null | undefined) => !m || /^-?0+$/.test(m);

export default function CustodyPage() {
  const tr = useTr();
  const dir = useDir();
  const Closed = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const [openRep, setOpenRep] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const q = useQuery({ queryKey: ledgerReviewKeys.custody(), queryFn: async () => (await ledgerReviewApi.customers.custody()).data.data });
  const detailQ = useQuery({
    queryKey: ledgerReviewKeys.custody(openRep ?? ''),
    queryFn: async () => (await ledgerReviewApi.customers.custody(openRep!)).data.data,
    enabled: !!openRep,
  });
  const decimals = q.data?.currencyDecimals ?? 2;
  const reps = (q.data?.reps ?? []).filter(r => showInactive || r.isActive || !isZero(r.ledgerMilli) || !isZero(r.opsOutstandingMilli));
  const detail = detailQ.data?.reps.find(r => r.salesRepId === openRep);

  const comp = (r: CustodyRepRow) => r.components;

  return (
    <div className="space-y-3">
      <LedgerLoadingToast show={q.isFetching || detailQ.isFetching} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('عهدة المناديب')}</h1>
        {q.data?.lastSyncAt && <span className="text-xs text-[#6E6557]">{tr('آخر مزامنة')}: <bdi>{formatDateTime(q.data.lastSyncAt)}</bdi></span>}
        <label className="ms-auto inline-flex items-center gap-1.5 text-sm text-[#6E6557]">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />{tr('إظهار المناديب المعطّلين بلا رصيد')}
        </label>
      </div>
      <p className="text-xs text-[#6E6557] flex items-start gap-1">
        <Info size={13} className="shrink-0 mt-0.5" />
        {tr('رصيد الشاشة التشغيلية = عهدة الأستاذ + الإلكتروني غير المصفّى + مصروفات العهدة + العجز المفتوح + العجز المحمّل على المصروف. الفرق دلالي لا خطأ ترحيل')}
      </p>

      {q.data && !q.data.activated && <NotActivatedNotice />}
      {q.isError && <p className="text-sm text-[#C0392B]">{ledgerErrorMessage(tr, ledgerErrorOf(q.error))}</p>}

      {q.data?.activated && (
        <div className="card !p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-[#9A8F7E]">
              <tr className="border-b border-[#F1EBDF]">
                <th className="w-6" />
                <th className="text-start px-2 py-2">{tr('المندوب')}</th>
                <th className="text-end px-2 py-2">{tr('رصيد الأستاذ')}</th>
                <th className="text-end px-2 py-2">{tr('عهدة الأستاذ')}</th>
                <th className="text-center px-2 py-2">C4</th>
                <th className="text-end px-2 py-2">{tr('رصيد الشاشة التشغيلية')}</th>
                <th className="text-end px-2 py-2">{tr('إلكتروني غير مصفّى')}</th>
                <th className="text-end px-2 py-2">{tr('مصروفات العهدة')}</th>
                <th className="text-end px-2 py-2">{tr('العجز المفتوح')}</th>
                <th className="text-center px-2 py-2">C4b</th>
              </tr>
            </thead>
            <tbody>
              {reps.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-[#6E6557]">{tr('لا مناديب')}</td></tr>}
              {reps.map(r => (
                <Fragment key={r.salesRepId}>
                  <tr className="border-b border-[#F1EBDF] hover:bg-[#FBF7F0] cursor-pointer" onClick={() => setOpenRep(o => (o === r.salesRepId ? null : r.salesRepId))}>
                    <td className="px-1">{openRep === r.salesRepId ? <ChevronDown size={14} /> : <Closed size={14} />}</td>
                    <td className="px-2 py-2">
                      <span className="font-semibold">{r.name ?? r.salesRepId.slice(0, 8)}</span>
                      {!r.isActive && <span className="ms-1"><Badge tone="gray">{tr('معطّل')}</Badge></span>}
                      {r.pending && <span className="ms-1"><Badge tone="blue">{tr('بانتظار الترحيل')}</Badge></span>}
                    </td>
                    <td className="text-end px-2"><MilliAmount value={r.ledgerMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={comp(r).ledgerCustodyMilli} decimals={decimals} /></td>
                    <td className="text-center px-2">
                      {isZero(r.c4GapMilli) ? <Badge tone="green">✓</Badge> : <Badge tone={r.pending ? 'amber' : 'red'}><MilliAmount value={r.c4GapMilli} decimals={decimals} colored={false} /></Badge>}
                    </td>
                    <td className="text-end px-2"><MilliAmount value={r.opsOutstandingMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={comp(r).onlineUnclearedMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={comp(r).custodyExpensesMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={comp(r).openShortageMilli} decimals={decimals} /></td>
                    <td className="text-center px-2">
                      {isZero(r.c4bGapMilli) ? <Badge tone="green">✓</Badge> : <Badge tone="amber"><MilliAmount value={r.c4bGapMilli} decimals={decimals} colored={false} /></Badge>}
                    </td>
                  </tr>
                  {openRep === r.salesRepId && (
                    <tr className="bg-[#FBF7F0]/60">
                      <td />
                      <td colSpan={9} className="px-2 py-3">
                        <RepDetail rep={detail ?? r} decimals={decimals} loading={detailQ.isLoading} error={detailQ.isError ? ledgerErrorMessage(tr, ledgerErrorOf(detailQ.error)) : null} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            {q.data.totals && (
              <tfoot className="font-semibold border-t border-[#E8E0D2]">
                <tr>
                  <td />
                  <td className="px-2 py-2">{tr('الإجمالي')}</td>
                  <td className="text-end px-2"><MilliAmount value={q.data.totals.ledgerMilli} decimals={decimals} /></td>
                  <td />
                  <td className="text-center px-2">{isZero(q.data.totals.c4GapMilli) ? '' : <MilliAmount value={q.data.totals.c4GapMilli} decimals={decimals} />}</td>
                  <td className="text-end px-2"><MilliAmount value={q.data.totals.opsOutstandingMilli} decimals={decimals} /></td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function RepDetail({ rep, decimals, loading, error }: { rep: CustodyRepRow; decimals: number; loading: boolean; error: string | null }) {
  const tr = useTr();
  const c = rep.components;
  const items: [string, string][] = [
    [tr('عهدة الأستاذ'), c.ledgerCustodyMilli],
    [tr('إلكتروني غير مصفّى'), c.onlineUnclearedMilli],
    [tr('نقد فواتير نقدية خارج العهدة'), c.cashSalesOutsideCustodyMilli],
    [tr('مصروفات العهدة'), c.custodyExpensesMilli],
    [tr('العجز المفتوح'), c.openShortageMilli],
    [tr('عجز محمّل على المصروف'), c.shortagesExpensedMilli],
    [tr('المصفّى من خارج العهدة'), c.nonCustodyClearedMilli],
    [tr('المقيّد على الحساب المعلّق'), c.suspenseClearedMilli],
    [tr('المسترد من العجز'), c.shortageRecoveredMilli],
    [tr('حد التصفية من خارج العهدة'), c.nonCustodyAllowanceMilli],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3 text-xs">
        {items.map(([label, v]) => (
          <div key={label} className="flex justify-between gap-2 border-b border-[#F1EBDF] py-0.5"><dt className="text-[#6E6557]">{label}</dt><dd><MilliAmount value={v} decimals={decimals} /></dd></div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-3 text-xs">
        <Link to={`${ledgerHref('items')}?salesRepId=${encodeURIComponent(rep.salesRepId)}`} className="text-[#E15A30] hover:underline">{tr('بنود اليومية')}</Link>
        <Link to={`${ledgerHref('customers/receipts')}?salesRepId=${encodeURIComponent(rep.salesRepId)}`} className="text-[#E15A30] hover:underline">{tr('سندات القبض')}</Link>
        <Link to={`${ledgerHref('review/events')}?q=SETTLEMENT`} className="text-[#E15A30] hover:underline">{tr('أحداث الاستلامات')}</Link>
      </div>
      {loading && <p className="text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
      {error && <p className="text-xs text-[#C0392B]">{error}</p>}
      {rep.settlements && (
        rep.settlements.length === 0 ? <p className="text-xs text-[#6E6557]">{tr('لا استلامات')}</p> : (
          <div className="overflow-x-auto">
            <p className="text-xs font-semibold text-[#1F1A13] mb-1">{tr('الاستلامات وتقسيمها')}</p>
            <table className="w-full text-xs">
              <thead className="text-[#9A8F7E]">
                <tr>
                  <th className="text-start px-2 py-1">#</th>
                  <th className="text-end px-2 py-1">{tr('المبلغ')}</th>
                  <th className="text-end px-2 py-1">{tr('من العهدة')}</th>
                  <th className="text-end px-2 py-1">{tr('المسترد من العجز')}</th>
                  <th className="text-end px-2 py-1">{tr('المصفّى من خارج العهدة')}</th>
                  <th className="text-end px-2 py-1">{tr('على الحساب المعلّق')}</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {rep.settlements.map(s => (
                  <tr key={s.id} className={`border-t border-[#F1EBDF] ${s.reversed ? 'text-[#9A8F7E] line-through' : ''}`}>
                    <td className="px-2 py-1"><bdi className="font-mono">{s.id.slice(0, 8)}</bdi></td>
                    <td className="text-end px-2"><MilliAmount value={s.amountMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={s.coveredMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={s.recoveredMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={s.nonCustodyClearedMilli} decimals={decimals} /></td>
                    <td className="text-end px-2"><MilliAmount value={s.suspenseMilli} decimals={decimals} /></td>
                    <td className="px-2">
                      <Link to={`${ledgerHref('review/events')}?q=${encodeURIComponent(`SETTLEMENT:${s.id}`)}`} className="text-[#E15A30] hover:underline">{tr('الأحداث')}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
