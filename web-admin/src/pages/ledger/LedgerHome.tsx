import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Hourglass, BookOpen, Settings2, FileSpreadsheet } from 'lucide-react';
import { formatDateTime, formatDayOnly } from '../../utils/format';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { canLedger } from '../../lib/ledgerPerms';
import { useLedgerOn } from '../../components/LedgerGate';
import { ledgerConfigApi, ledgerKeys, isLedgerAccessError } from '../../api/ledgerConfig';
import { findLedgerRoute, ledgerHref } from './routes';
import SetupWizard from './setup/SetupWizard';
import { BackfillStatusCard, useCommitResult, useSetupState } from './setup/setupUi';
import { CommitResultPanel } from './setup/SetupReview';

/**
 * فهرس الدفاتر `/app/ledger` (§8.2): قبل التفعيل (`activatedAt` فارغ) `SetupWizard` لمن يملك canConfigureLedger
 * (M3، §5.6)، وإلا شاشة «بانتظار الإعداد». بعد التفعيل حالة الترحيل الآلي والتاريخي حتى تصل بطاقات اللوحة في M4،
 * مع روابط التهيئة والقيود (القيود اليدوية مسودات حتى التفعيل، §6.1).
 */
export default function LedgerHome() {
  const tr = useTr();
  const { user } = useAuthStore();
  const { on, ready } = useLedgerOn();
  const q = useQuery({
    queryKey: ledgerKeys.status,
    queryFn: async () => (await ledgerConfigApi.status()).data.data,
    enabled: ready && on,
  });
  const canConfigure = canLedger(user, 'canConfigureLedger');
  // بعد التفعيل: تقدم الترحيل التاريخي من GET /setup (canConfigureLedger)، ولغيره الحالة من /status وحدها
  const setupQ = useSetupState(ready && on && !!q.data?.activatedAt && canConfigure);
  const [commitResult, setCommitResult] = useCommitResult();

  if (!ready || q.isLoading) return null;
  if (q.isError) {
    return (
      <div className="card max-w-xl mx-auto text-center py-8 text-sm text-[#8E2A1F]">
        {isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل حالة الدفاتر')}
      </div>
    );
  }

  const activated = !!q.data?.activatedAt;
  const links = [
    { path: 'entries', icon: BookOpen, label: tr('قيود اليومية'), hint: activated ? tr('إنشاء القيود اليدوية وترحيلها') : tr('المسودات متاحة، والترحيل بعد اكتمال الإعداد') },
    { path: 'config/accounts', icon: FileSpreadsheet, label: tr('شجرة الحسابات'), hint: tr('الحسابات وأنواعها ووسومها') },
    { path: 'config/settings', icon: Settings2, label: tr('الإعدادات'), hint: tr('الضرائب والحسابات الافتراضية والتقارير') },
  ].filter(l => { const r = findLedgerRoute(l.path); return r && canLedger(user, r.view); });

  return (
    <div className="space-y-4">
      {!activated && canConfigure ? (
        <SetupWizard />
      ) : !activated ? (
        <div className="card max-w-2xl mx-auto text-center py-10">
          <div className="w-12 h-12 rounded-2xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center mx-auto mb-3">
            <Hourglass size={22} />
          </div>
          <h1 className="text-lg font-bold text-[#1F1A13]">{tr('الدفاتر بانتظار الإعداد')}</h1>
          <p className="text-sm text-gray-500 mt-1.5 max-w-md mx-auto leading-relaxed">
            {tr('يُكمل مسؤول الدفاتر في شركتك الإعداد المبدئي قبل الترحيل')}
          </p>
        </div>
      ) : (
        <>
        {commitResult && (
          <div className="card max-w-5xl mx-auto space-y-3">
            <CommitResultPanel result={commitResult} decimals={commitResult.status.currencyDecimals ?? 2} />
            <div className="flex justify-end"><button type="button" className="btn-secondary" onClick={() => setCommitResult(null)}>{tr('إغلاق')}</button></div>
          </div>
        )}
        <div className="card max-w-2xl mx-auto py-6 space-y-4">
          <div className="text-center">
            <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#1F1A13] flex items-center justify-center mx-auto mb-3"><Landmark size={22} /></div>
            <h1 className="text-lg font-bold text-[#1F1A13]">{tr('النظام المحاسبي المتكامل')}</h1>
            <p className="text-sm text-gray-500 mt-1.5">
              {tr('الدفاتر مفعّلة')}
              {q.data?.cutoverDate && <> · {tr('تاريخ البدء')}: <bdi className="tabular-nums">{formatDayOnly(q.data.cutoverDate)}</bdi></>}
            </p>
            <p className="text-xs text-[#9A8F7E] mt-1">{tr('بطاقات الدفاتر تصل قريبا')}</p>
          </div>
          <div className="border-t border-[#F1EBDF] pt-4 space-y-2">
            <h2 className="text-sm font-bold text-[#1F1A13]">{tr('الترحيل التاريخي')}</h2>
            <BackfillStatusCard
              state={(setupQ.data?.activated ? setupQ.data.status.backfillState : q.data?.backfillState) ?? 'NONE'}
              progress={setupQ.data?.activated ? setupQ.data.progress : null}
              canWrite={canConfigure} compact />
            {q.data?.lastSyncAt && <p className="text-[11px] text-[#9A8F7E]">{tr('آخر مزامنة')}: {formatDateTime(q.data.lastSyncAt)}</p>}
          </div>
        </div>
        </>
      )}

      {links.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3 max-w-3xl mx-auto">
          {links.map(l => (
            <Link key={l.path} to={ledgerHref(l.path)} className="card hover:border-[#E15A30] transition-colors">
              <l.icon size={18} className="text-[#E15A30]" />
              <p className="font-semibold text-[#1F1A13] mt-2">{l.label}</p>
              <p className="text-xs text-[#9A8F7E] mt-1 leading-relaxed">{l.hint}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
