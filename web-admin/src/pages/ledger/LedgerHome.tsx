import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Hourglass, BookOpen, Settings2, FileSpreadsheet } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { canLedger } from '../../lib/ledgerPerms';
import { useLedgerOn } from '../../components/LedgerGate';
import { ledgerConfigApi, ledgerKeys, isLedgerAccessError } from '../../api/ledgerConfig';
import { findLedgerRoute, ledgerHref } from './routes';

/**
 * فهرس الدفاتر `/app/ledger` (§8.2): قبل التفعيل (`activatedAt` فارغ) شاشة «بانتظار الإعداد»
 * — معالج الإعداد يصل في M3 لمن يملك canConfigureLedger، وبطاقات اللوحة في M4.
 * في M2 تُعرض روابط التهيئة والمسودات المتاحة وحدها (القيود اليدوية مسودات حتى التفعيل، §6.1).
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

  if (!ready || q.isLoading) return null;
  if (q.isError) {
    return (
      <div className="card max-w-xl mx-auto text-center py-8 text-sm text-[#8E2A1F]">
        {isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل حالة الدفاتر')}
      </div>
    );
  }

  const activated = !!q.data?.activatedAt;
  const canConfigure = canLedger(user, 'canConfigureLedger');
  const links = [
    { path: 'entries', icon: BookOpen, label: tr('قيود اليومية'), hint: activated ? tr('إنشاء القيود اليدوية وترحيلها') : tr('المسودات متاحة، والترحيل بعد اكتمال الإعداد') },
    { path: 'config/accounts', icon: FileSpreadsheet, label: tr('شجرة الحسابات'), hint: tr('الحسابات وأنواعها ووسومها') },
    { path: 'config/settings', icon: Settings2, label: tr('الإعدادات'), hint: tr('الضرائب والحسابات الافتراضية والتقارير') },
  ].filter(l => { const r = findLedgerRoute(l.path); return r && canLedger(user, r.view); });

  return (
    <div className="space-y-4">
      {!activated ? (
        <div className="card max-w-2xl mx-auto text-center py-10">
          <div className="w-12 h-12 rounded-2xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center mx-auto mb-3">
            <Hourglass size={22} />
          </div>
          <h1 className="text-lg font-bold text-[#1F1A13]">{tr('الدفاتر بانتظار الإعداد')}</h1>
          <p className="text-sm text-gray-500 mt-1.5 max-w-md mx-auto leading-relaxed">
            {canConfigure
              ? tr('معالج الإعداد المبدئي يصل قريبا: تاريخ البدء والأرصدة الافتتاحية والترحيل التاريخي. يمكنك الآن مراجعة شجرة الحسابات والإعدادات')
              : tr('يُكمل مسؤول الدفاتر في شركتك الإعداد المبدئي قبل الترحيل')}
          </p>
          {canConfigure && q.data?.seeded === false && (
            <Link to={ledgerHref('config/settings')} className="btn-primary inline-flex items-center gap-1.5 mt-4">
              <Settings2 size={15} />{tr('تحميل القالب المحاسبي')}
            </Link>
          )}
        </div>
      ) : (
        <div className="card max-w-2xl mx-auto text-center py-8">
          <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#1F1A13] flex items-center justify-center mx-auto mb-3"><Landmark size={22} /></div>
          <h1 className="text-lg font-bold text-[#1F1A13]">{tr('النظام المحاسبي المتكامل')}</h1>
          <p className="text-sm text-gray-500 mt-1.5">{tr('بطاقات الدفاتر تصل قريبا')}</p>
        </div>
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
