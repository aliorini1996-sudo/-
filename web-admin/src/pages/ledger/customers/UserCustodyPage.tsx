import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDateTime } from '../../../utils/format';
import { LedgerLoadingToast } from '../../../components/ledger/LedgerListView';
import { Badge, MilliAmount } from '../../../components/ledger/SyncBadges';
import { ledgerErrorOf } from '../../../api/ledgerConfig';
import { ledgerOpsApi, ledgerOpsKeys } from '../../../api/ledgerOps';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { eventsHrefFor } from '../../../lib/ledger/sync';
import { ledgerHref } from '../routes';
import { ManualLedgerNotice, NotActivatedNotice } from './postingFilters';

/**
 * «العملاء ← عهدة مستخدمي الشركة» (L5، OD5، C4u): لكل مستخدم رصيد 111004 في الأستاذ (بُعد adminUserId) مقابل عهدته
 * التشغيلية (foldUserCustody: النقد والشيكات التي استلمها من المناديب − ما ورّده منها − ما رُدّ من عهدته عند إلغاء سند).
 * التحويل ونقطة البيع لا يدخلان العهدة (يمرّان إلى البنك). الفرق C4u أحمر حين لا أحداث معلّقة، وأصفر حين يُنتظر ترحيلها.
 * للقراءة وحدها: الاستلام والتوريد يبقيان في شاشتي المناديب ومستخدمي الشركة.
 */

const isZero = (m: string | null | undefined) => !m || /^-?0+$/.test(m);

export default function UserCustodyPage() {
  const tr = useTr();
  const [showInactive, setShowInactive] = useState(false);
  const q = useQuery({ queryKey: ledgerOpsKeys.userCustody, queryFn: async () => (await ledgerOpsApi.custody.users()).data.data });
  const d = q.data;
  const decimals = d?.currencyDecimals ?? 2;
  const pending = (d?.pendingEvents ?? 0) > 0;
  const users = (d?.users ?? []).filter(u => showInactive || u.isActive || !isZero(u.ledgerMilli) || !isZero(u.opsOutstandingMilli));

  return (
    <div className="space-y-3">
      <LedgerLoadingToast show={q.isFetching} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('عهدة مستخدمي الشركة')}</h1>
        {d?.lastSyncAt && <span className="text-xs text-[#6E6557]">{tr('آخر مزامنة')}: <bdi>{formatDateTime(d.lastSyncAt)}</bdi></span>}
        <label className="ms-auto inline-flex items-center gap-1.5 text-sm text-[#6E6557]">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />{tr('إظهار المستخدمين المعطّلين بلا رصيد')}
        </label>
      </div>
      <p className="text-xs text-[#6E6557] flex items-start gap-1">
        <Info size={13} className="shrink-0 mt-0.5" />
        {tr('عهدة المستخدم = النقد والشيكات التي استلمها من المناديب − ما ورّده منها − ما رُدّ من عهدته عند إلغاء سند. التحويل البنكي ونقطة البيع لا يدخلان العهدة')}
      </p>

      {d?.manualLedger ? <ManualLedgerNotice /> : d && !d.activated ? <NotActivatedNotice /> : d && !d.linked && (
        <p className="rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] px-3 py-2 text-sm text-[#1F1A13]" role="status">
          {tr('عهدة مستخدمي الشركة في الدفاتر للدفاتر المربوطة بالنظام وحدها')}
        </p>
      )}
      {q.isError && <p className="text-sm text-[#C0392B]">{ledgerErrorMessage(tr, ledgerErrorOf(q.error))}</p>}
      {pending && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          {tr('أحداث استلام أو توريد بانتظار الترحيل: الفرق قد يكون مؤقتاً حتى تُرحَّل')} (<bdi className="tabular-nums">{d!.pendingEvents}</bdi>) ·{' '}
          <Link to={eventsHrefFor('SETTLEMENT')} className="text-[#E15A30] hover:underline">{tr('أحداث الاستلامات')}</Link>
        </p>
      )}

      {d?.linked && (
        <div className="card !p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-[#9A8F7E]">
              <tr className="border-b border-[#F1EBDF]">
                <th className="text-start px-3 py-2">{tr('المستخدم')}</th>
                <th className="text-end px-3 py-2">{tr('رصيد الأستاذ')}</th>
                <th className="text-end px-3 py-2">{tr('العهدة التشغيلية')}</th>
                <th className="text-center px-3 py-2">C4u</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-[#6E6557]">{tr('لا عهدة لدى مستخدمي الشركة')}</td></tr>}
              {users.map(u => (
                <tr key={u.userId} className="border-b border-[#F1EBDF]">
                  <td className="px-3 py-2">
                    <span className="font-semibold">{u.name ?? u.userId.slice(0, 8)}</span>
                    {!u.isActive && <span className="ms-1"><Badge tone="gray">{tr('معطّل')}</Badge></span>}
                  </td>
                  <td className="text-end px-3"><MilliAmount value={u.ledgerMilli} decimals={decimals} /></td>
                  <td className="text-end px-3"><MilliAmount value={u.opsOutstandingMilli} decimals={decimals} /></td>
                  <td className="text-center px-3">
                    {isZero(u.c4uGapMilli) ? <Badge tone="green">✓</Badge> : <Badge tone={pending ? 'amber' : 'red'}><MilliAmount value={u.c4uGapMilli} decimals={decimals} colored={false} /></Badge>}
                  </td>
                  <td className="px-3 text-xs whitespace-nowrap">
                    {/* رابط التعمّق بصيغة عنوان دفتر أستاذ الشركاء (readPartnerLedgerState في api/ledgerPartners.ts) */}
                    <Link to={`${ledgerHref('reports/partner-ledger')}?${new URLSearchParams({ type: 'user', partner: u.userId, ...(u.name ? { pname: u.name } : {}) }).toString()}`} className="text-[#E15A30] hover:underline">{tr('دفتر الأستاذ')}</Link>
                    {' · '}
                    <Link to={eventsHrefFor('USER_SETTLEMENT')} className="text-[#E15A30] hover:underline">{tr('أحداث التوريد')}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
            {d.totals && (
              <tfoot className="font-semibold border-t border-[#E8E0D2]">
                <tr>
                  <td className="px-3 py-2">{tr('الإجمالي')}</td>
                  <td className="text-end px-3"><MilliAmount value={d.totals.ledgerMilli} decimals={decimals} /></td>
                  <td className="text-end px-3"><MilliAmount value={d.totals.opsOutstandingMilli} decimals={decimals} /></td>
                  <td className="text-center px-3">{isZero(d.totals.c4uGapMilli) ? '' : <MilliAmount value={d.totals.c4uGapMilli} decimals={decimals} />}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
